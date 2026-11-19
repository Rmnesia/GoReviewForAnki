/* Batch-analyse SGFs with the KataGo engine bundled inside KaTrain.exe.
 *
 *   node tools/extract_engine.py      # one time: unpack katago.exe + config
 *   node tools/analyze.js                 # default 100 visits
 *   node tools/analyze.js --visits 300
 *   node tools/analyze.js --dry-run
 *
 * The same driver is also used by tools/serve.js, so the web UI can start,
 * watch and stop an analysis without any command line.
 *
 * For every move of every game it asks KataGo for the position BEFORE that
 * move, then writes a KaTrain-compatible SGF containing:
 *   - KT[...]  (gzip+base64 analysis JSON: root.scoreLead + best move + PV)
 *   - C[...]   (Chinese review comment: point loss / best move / PV)
 * so the web tool can import the result as-is. No GUI clicking required.
 *
 * Results are cached per ply, so an interrupted run resumes where it stopped.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const vm = require('vm');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const KATRAIN = path.resolve(ROOT, '..');
const ENGINE_DIR = path.join(ROOT, 'engine');
const ENGINE_EXE = path.join(ENGINE_DIR, 'katago.exe');
const ENGINE_CFG = path.join(ENGINE_DIR, 'analysis_config.cfg');
const MODEL = path.join(KATRAIN, 'kata1-zhizi-b40c768nbt-s11472M-d5982M.bin.gz');
const DEFAULT_INPUT = path.join(KATRAIN, 'sgf');
const OUT_DIR = path.join(ROOT, 'sgfout');
const CACHE_DIR = path.join(ROOT, 'cache');

/* ---------- load the browser SGF helpers into a sandbox ---------- */
const sb = {
  console, atob, Blob, DecompressionStream, TextDecoder, TextEncoder,
  devicePixelRatio: 1, setTimeout, clearTimeout, Date, Math, JSON, Promise
};
sb.globalThis = sb;
vm.createContext(sb);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'sgf.js'), 'utf8'), sb, { filename: 'sgf.js' });
const SGF = sb.GoReview.SGF;

/* ---------- CLI ---------- */
const DEFAULTS = {
  input: DEFAULT_INPUT, out: OUT_DIR, cache: CACHE_DIR,
  visits: 100, threads: 6, saveEvery: 10, timeout: 3600,
  model: MODEL, config: ENGINE_CFG, engine: ENGINE_EXE,
  limit: 0, only: '', force: false, dryRun: false, comments: true
};

function parseArgs(argv) {
  const o = Object.assign({}, DEFAULTS);
  const boolMap = { force: 'force', 'dry-run': 'dryRun' };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a.indexOf('--') !== 0) continue;
    let key = a.slice(2), val = null;
    const eq = key.indexOf('=');
    if (eq >= 0) { val = key.slice(eq + 1); key = key.slice(0, eq); }
    if (key === 'no-comments') { o.comments = false; continue; }
    if (boolMap[key]) { o[boolMap[key]] = true; continue; }
    if (val === null) { val = argv[++i]; }
    const map = {
      input: 'input', out: 'out', cache: 'cache', visits: 'visits',
      threads: 'threads', 'save-every': 'saveEvery', timeout: 'timeout',
      model: 'model', config: 'config', engine: 'engine', limit: 'limit',
      only: 'only', komi: 'komiOverride', rules: 'rulesOverride'
    };
    const k = map[key];
    if (!k) { console.error('Unknown option --' + key); process.exit(2); }
    if (['visits', 'threads', 'saveEvery', 'timeout', 'limit'].indexOf(k) >= 0) o[k] = Number(val);
    else o[k] = val;
  }
  return o;
}

/* ---------- SGF reading ---------- */
function firstVal(props, key, dflt) {
  return props[key] && props[key].length ? props[key][0] : dflt;
}

function inferKomi(raw) {
  const k = parseFloat(raw);
  if (!isFinite(k)) return 7.5;
  // Fox/Weiqi exports encode 3.75 stones (Chinese counting) as "375";
  // KataGo expects the same value in points (7.5).
  if (k > 20) return k / 50;
  return k;
}

function inferRules(raw) {
  const r = String(raw || '').toLowerCase();
  if (r.indexOf('japan') >= 0) return 'japanese';
  if (r.indexOf('korean') >= 0) return 'korean';
  if (r.indexOf('aga') >= 0) return 'aga';
  if (r.indexOf('nz') >= 0) return 'nz';
  return 'chinese';
}

function readGame(file, opt) {
  const text = fs.readFileSync(file, 'utf8');
  const line = SGF.mainLine(SGF.parseSGF(text));
  if (!line || !line.length) throw new Error('not a valid SGF');
  const rp = line[0].props;
  const size = parseInt(String(firstVal(rp, 'SZ', '19')).split(':')[0], 10) || 19;
  const moves = [];
  for (let j = 1; j < line.length; j++) {
    const p = line[j].props;
    let color = null, coord = '';
    if (p.B) { color = 'B'; coord = p.B[0]; }
    else if (p.W) { color = 'W'; coord = p.W[0]; }
    if (!color) continue;
    const xy = SGF.sgfToXY(coord, size);
    const gtp = xy ? SGF.xyToGtp(xy.x, xy.y, size) : 'pass';
    moves.push({ color: color, coord: coord, gtp: gtp });
  }
  const initialStones = [];
  (rp.AB || []).concat(rp.AW || []).forEach(function (c) {
    const xy = SGF.sgfToXY(c, size);
    if (xy) initialStones.push([rp.AB && rp.AB.indexOf(c) >= 0 ? 'B' : 'W', SGF.xyToGtp(xy.x, xy.y, size)]);
  });
  return {
    filename: path.basename(file), text: text, rootProps: rp, line: line,
    size: size, moves: moves, initialStones: initialStones,
    komi: opt.komiOverride !== undefined ? opt.komiOverride : inferKomi(firstVal(rp, 'KM', '7.5')),
    rules: opt.rulesOverride || inferRules(firstVal(rp, 'RU', 'Chinese'))
  };
}

/* ---------- analysis -> KaTrain KT payload ---------- */
function toAnalysis(resp) {
  const root = Object.assign({}, resp.rootInfo || {});
  const moves = {};
  (resp.moveInfos || []).forEach(function (mi) {
    if (!mi || !mi.move) return;
    moves[mi.move] = Object.assign({}, mi);
  });
  return { moves: moves, root: root, completed: true };
}

function encodeKT(analysis) {
  function zeros(n) { return Buffer.alloc(n * 4); } // 361 ownership / 362 policy floats
  return [
    zlib.gzipSync(zeros(361)),
    zlib.gzipSync(zeros(362)),
    zlib.gzipSync(Buffer.from(JSON.stringify(analysis), 'utf8'))
  ].map(function (b) { return b.toString('base64'); });
}

function sgfEsc(s) {
  return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/\]/g, '\\]');
}

function topCandidate(a) {
  if (!a || !a.moves) return null;
  const list = Object.keys(a.moves).map(function (k) { return a.moves[k]; });
  return list.filter(function (d) { return d.order === 0; })[0] || list[0] || null;
}

function scoreText(v) {
  if (typeof v !== 'number' || !isFinite(v)) return '?';
  return (v >= 0 ? '黑+' : '白+') + Math.abs(v).toFixed(1);
}

function winrateText(v) {
  if (typeof v !== 'number' || !isFinite(v)) return '?';
  const pct = (v * 100).toFixed(1);
  return (v >= 0.5 ? '黑 ' : '白 ') + (v >= 0.5 ? pct : (100 - v * 100).toFixed(1)) + '%';
}

function commentFor(g, ply, analyses) {
  const mv = g.moves[ply - 1];
  const cur = analyses[ply], par = analyses[ply - 1];
  const cs = cur && cur.root ? cur.root.scoreLead : null;
  const ps = par && par.root ? par.root.scoreLead : null;
  const sign = mv.color === 'B' ? 1 : -1;
  const loss = (typeof cs === 'number' && typeof ps === 'number') ? sign * (ps - cs) : null;
  const top = topCandidate(par);
  const best = top ? top.move : null;
  const pv = top && Array.isArray(top.pv) ? top.pv : [];
  const lines = ['手数 ' + ply + ': ' + mv.color + ' ' + mv.gtp];
  lines.push('分数: ' + scoreText(cs));
  lines.push('胜率: ' + winrateText(cur && cur.root ? cur.root.winrate : null));
  if (loss !== null && loss > 0.05) {
    lines.push('目数损失: ' + loss.toFixed(1));
    if (best) lines.push('推荐最佳选点 ' + best + ' (' + scoreText(top.scoreLead) + ').');
  } else {
    lines.push('该手为最佳选点');
  }
  if (pv.length) lines.push('PV: ' + mv.color + pv.join(' '));
  return lines.join('\n');
}

function rootPropsText(rp) {
  const keep = ['GM', 'FF', 'CA', 'SZ', 'PB', 'PW', 'BR', 'WR', 'KM', 'HA',
    'RU', 'DT', 'RE', 'TM', 'TC', 'TT', 'RL', 'GN', 'EV', 'RO', 'PC', 'SO'];
  let s = '';
  keep.forEach(function (k) {
    (rp[k] || []).forEach(function (v) { s += k + '[' + sgfEsc(v) + ']'; });
  });
  return s + 'KTV[1.0]AP[GoReview CLI:1.0]\n';
}

function buildEnhancedSGF(g, analyses, withComments) {
  const n = g.moves.length;
  let out = '(;' + rootPropsText(g.rootProps);
  if (analyses[0]) out += 'KT[' + encodeKT(analyses[0]).join('][') + ']';
  out += 'C[SGF generated by GoReview CLI (KataGo analysis)]\n';
  for (let i = 0; i < n; i++) {
    const mv = g.moves[i];
    out += ';' + mv.color + '[' + sgfEsc(mv.coord) + ']';
    if (analyses[i + 1]) {
      out += 'KT[' + encodeKT(analyses[i + 1]).join('][') + ']';
      if (withComments) out += 'C[' + sgfEsc(commentFor(g, i + 1, analyses)) + ']';
    }
    out += '\n';
  }
  return out + ')\n';
}

/* ---------- per-game cache ---------- */
function cacheKey(g, opt) {
  const movesHash = crypto.createHash('sha1')
    .update(g.moves.map(function (m) { return m.color + m.gtp; }).join('|')).digest('hex').slice(0, 12);
  return crypto.createHash('sha1').update(
    [g.filename, movesHash, opt.visits, g.rules, g.komi].join('|')).digest('hex').slice(0, 16);
}

function cachePath(g, opt) { return path.join(opt.cache, cacheKey(g, opt) + '.json'); }

function loadCache(g, opt) {
  try {
    const j = JSON.parse(fs.readFileSync(cachePath(g, opt), 'utf8'));
    if (j && j.plies && typeof j.plies === 'object') return j.plies;
  } catch (e) { /* no cache yet */ }
  return {};
}

function saveCache(g, opt, plies) {
  const p = cachePath(g, opt);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({
    filename: g.filename, visits: opt.visits, rules: g.rules, komi: g.komi,
    updated: new Date().toISOString(), plies: plies
  }), 'utf8');
  fs.renameSync(tmp, p);
}

/* ---------- engine driver ---------- */
function makeQuery(id, g, ply, opt) {
  return {
    id: id,
    moves: g.moves.slice(0, ply).map(function (m) { return [m.color, m.gtp]; }),
    initialStones: g.initialStones,
    initialPlayer: 'B',
    rules: g.rules,
    komi: g.komi,
    boardXSize: g.size,
    boardYSize: g.size,
    analyzeTurns: [ply],
    maxVisits: opt.visits,
    includeOwnership: false,
    includeMovesOwnership: false,
    includePolicy: false
  };
}

function collectFiles(input, only, names) {
  const st = fs.statSync(input);
  let files = st.isDirectory()
    ? fs.readdirSync(input).filter(function (f) { return /\.sgf$/i.test(f); })
      .map(function (f) { return path.join(input, f); })
    : [input];
  if (names && names.length) {
    const wanted = new Set(names.map(function (n) { return path.basename(String(n)).toLowerCase(); }));
    files = files.filter(function (f) { return wanted.has(path.basename(f).toLowerCase()); });
  }
  if (only) files = files.filter(function (f) { return f.toLowerCase().indexOf(String(only).toLowerCase()) >= 0; });
  return files.sort();
}

// A partial analysis must not overwrite the full game in sgfout/.
function outputName(g, opt) {
  return opt.limit > 0 ? g.filename.replace(/\.sgf$/i, '.part' + opt.limit + '.sgf') : g.filename;
}

/* Returns { promise, cancel() }.
 * hooks: log(text), progress(state), cancelled() -> bool
 * The CLI passes log=console.log; the web server collects logs/progress instead.
 */
function run(opt, games, jobs, hooks) {
  hooks = Object.assign({
    log: function () {}, progress: function () {}, cancelled: function () { return false; }
  }, hooks || {});
  let cancelFn = null;

  const promise = new Promise(function (resolve, reject) {
    const args = [
      'analysis', '-model', opt.model, '-config', opt.config,
      '-quit-without-waiting',
      '-override-config', [
        'numAnalysisThreads=' + opt.threads,
        'numSearchThreads=2',
        'nnCacheSizePowerOfTwo=18',
        'analysisPVLen=12'
      ].join(',')
    ];
    const proc = spawn(opt.engine, args, { cwd: ENGINE_DIR, stdio: ['pipe', 'pipe', 'pipe'] });
    const windowSize = Math.max(2, opt.threads * 2);
    const pending = new Map();
    const outputs = [];
    let queue = jobs.slice(), inflight = 0, done = 0, failed = 0;
    let outBuf = '', settled = false, t0 = Date.now();
    const total = jobs.length;
    let guardRef = null;

    function state() {
      const secs = Math.max(0.001, (Date.now() - t0) / 1000);
      const rate = done / secs;
      return {
        running: !settled, done: done, failed: failed, total: total,
        rate: rate, seconds: secs,
        eta: rate > 0 ? Math.round((total - done - failed) / rate) : 0,
        outputs: outputs.slice()
      };
    }

    function finish(err, cancelled) {
      if (settled) return;
      settled = true;
      try { proc.stdin.end(); } catch (e) { /* already closed */ }
      if (err || cancelled) { try { proc.kill(); } catch (e) { /* already gone */ } }
      games.forEach(function (g) { saveCache(g, opt, g.plies); });
      clearInterval(guardRef);
      const s = state();
      if (err) { s.error = err.message; reject(err); }
      else resolve(Object.assign(s, { cancelled: !!cancelled, finishedAt: new Date().toISOString() }));
      hooks.progress(s);
    }

    cancelFn = function (reason) {
      if (settled) return false;
      hooks.log('⏹ ' + (reason || '已停止') + '；已完成的局面写入缓存，下次自动续传。');
      finish(null, true);
      return true;
    };

    function pump() {
      while (!settled && inflight < windowSize && queue.length) {
        const job = queue.shift();
        pending.set(job.id, job);
        job.sentAt = Date.now();
        try { proc.stdin.write(JSON.stringify(job.query) + '\n'); }
        catch (e) { finish(e); return; }
        inflight++;
      }
    }

    function onLine(line) {
      let j;
      try { j = JSON.parse(line); } catch (e) { return; }
      if (j && j.type === 'query_version') return;
      if (j && (j.error || j.noResults)) {
        const job0 = pending.get(j.id);
        if (job0) { pending.delete(j.id); inflight--; job0.game.failed.push(job0.ply); failed++; }
        hooks.progress(state());
        pump();
        return;
      }
      if (!j || !j.id || !j.moveInfos) return;
      const job = pending.get(j.id);
      if (!job) return;
      pending.delete(j.id);
      inflight--;
      job.game.plies[job.ply] = toAnalysis(j);
      job.game.remaining--;
      done++;
      if (done % opt.saveEvery === 0) saveCache(job.game, opt, job.game.plies);
      if (job.game.remaining === 0) {
        outputs.push(writeSGF(job.game, opt, hooks.log));
      }
      if (done % 20 === 0 || done === total) {
        const s = state();
        hooks.log('  ' + done + '/' + total + ' 局面  (' + s.rate.toFixed(1) + '/s, 预计剩余 ' + s.eta + 's)');
      }
      hooks.progress(state());
      if (done + failed >= total) { finish(null); return; }
      pump();
    }

    proc.stdout.on('data', function (d) {
      outBuf += d.toString();
      let i;
      while ((i = outBuf.indexOf('\n')) >= 0) {
        const line = outBuf.slice(0, i).trim();
        outBuf = outBuf.slice(i + 1);
        if (line) onLine(line);
      }
    });
    let errBuf = '';
    proc.stderr.on('data', function (d) {
      const s = d.toString();
      if (/exception|error|failed|uncaught/i.test(s)) hooks.log('[katago] ' + s.trim());
      errBuf = (errBuf + s).slice(-4000);
    });
    proc.on('error', function (e) { finish(e); });
    proc.on('exit', function (code) {
      if (settled) return;
      finish(new Error('KataGo 提前退出 (code ' + code + ')：' + errBuf.slice(-800)));
    });
    guardRef = setInterval(function () {
      if (settled) { clearInterval(guardRef); return; }
      if (hooks.cancelled()) { cancelFn('外部取消'); return; }
      const now = Date.now();
      const stuck = [];
      pending.forEach(function (j) { if (now - j.sentAt > opt.timeout * 1000) stuck.push(j.id); });
      if (stuck.length) finish(new Error('查询超时（>' + opt.timeout + 's）：' + stuck.slice(0, 3).join(', ')));
    }, 10000);
    pump();
  });

  return { promise: promise, cancel: function (reason) { return cancelFn ? cancelFn(reason) : false; } };
}

function writeSGF(g, opt, onLog) {
  const name = outputName(g, opt);
  const dest = path.join(opt.out, name);
  const tmp = dest + '.tmp';
  fs.writeFileSync(tmp, buildEnhancedSGF(g, g.plies, opt.comments), 'utf8');
  fs.renameSync(tmp, dest); // atomic, so the web UI never reads a half-written file
  const n = Object.keys(g.plies).length;
  if (onLog) onLog('  ✓ ' + name + ' | ' + g.moves.length + ' 手 | ' + n + ' 个局面已分析 -> ' + path.relative(ROOT, dest));
  return name;
}

/* ---------- shared preparation (CLI + web server) ---------- */
function prepare(opt) {
  if (!fs.existsSync(opt.engine) || !fs.existsSync(opt.config)) {
    throw new Error('引擎未找到，请先运行：python tools/extract_engine.py');
  }
  if (!fs.existsSync(opt.model)) throw new Error('模型未找到：' + opt.model);
  fs.mkdirSync(opt.out, { recursive: true });
  fs.mkdirSync(opt.cache, { recursive: true });

  const files = collectFiles(opt.input, opt.only, opt.files);
  if (!files.length) throw new Error('没有找到 SGF：' + opt.input);
  const games = [], errors = [], outputs = [];
  files.forEach(function (f) {
    try {
      const g = readGame(f, opt);
      if (opt.limit > 0) g.moves = g.moves.slice(0, opt.limit);
      g.plies = opt.force ? {} : loadCache(g, opt);
      g.failed = [];
      g.remaining = g.moves.length + 1 - Object.keys(g.plies).length;
      games.push(g);
      if (g.remaining === 0) outputs.push(writeSGF(g, opt));
    } catch (e) { errors.push(path.basename(f) + ': ' + e.message); }
  });
  if (!games.length) throw new Error('所有棋谱读取失败：' + errors.join('; '));

  const jobs = [];
  games.forEach(function (g, gi) {
    for (let ply = 0; ply <= g.moves.length; ply++) {
      if (g.plies[ply]) continue;
      const id = 'g' + gi + 'p' + ply;
      jobs.push({ id: id, game: g, ply: ply, query: makeQuery(id, g, ply, opt) });
    }
  });
  return { opt: opt, games: games, jobs: jobs, files: files, errors: errors, outputs: outputs };
}

/* ---------- main ---------- */
async function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (opt.komiOverride !== undefined) opt.komiOverride = parseFloat(opt.komiOverride);
  const prep = prepare(opt);
  const games = prep.games;

  console.log('引擎   : KataGo (OpenCL)  ' + opt.threads + ' 并发 / ' + opt.visits + ' visits');
  console.log('输入   : ' + opt.input + '  (' + games.length + ' 局)');
  console.log('输出   : ' + opt.out);
  console.log('缓存   : ' + opt.cache + '（中断后重跑自动续传）');
  prep.errors.forEach(function (e) { console.log('  ! 跳过 ' + e); });
  games.forEach(function (g) {
    const donePly = Object.keys(g.plies).length;
    const totalPly = g.moves.length + 1;
    console.log('  · ' + g.filename + ': ' + g.moves.length + ' 手, ' + g.rules +
      ', komi=' + g.komi + ', 缓存 ' + donePly + '/' + totalPly);
  });

  if (opt.dryRun) {
    console.log('\n[dry-run] 待分析 ' + prep.jobs.length + ' 个局面；未启动引擎。');
    return;
  }
  if (!prep.jobs.length) {
    console.log('\n全部已有缓存，无需重新分析。已生成 ' + prep.outputs.length + ' 份棋谱。');
    return;
  }

  console.log('\n启动引擎（首次会做 OpenCL 调优，约 2-5 分钟）...');
  const handle = run(opt, games, prep.jobs, { log: console.log });
  const r = await handle.promise;
  console.log('\n' + (r.cancelled ? '已停止' : '完成') + '：' + r.done + ' 个局面，失败 ' +
    r.failed + ' 个，用时 ' + r.seconds.toFixed(1) + 's');
  if (r.failed) console.log('失败局面已保留在缓存之外，重跑本命令即可补齐。');
  console.log('现在可在网页点「载入分析结果」，或用「导入棋谱」选择 ' + opt.out + ' 目录。');
}

if (require.main === module) main().catch(function (e) { console.error('\n错误：' + e.message); process.exit(1); });

module.exports = {
  DEFAULTS, ROOT, ENGINE_DIR, OUT_DIR, CACHE_DIR,
  parseArgs, prepare, run, collectFiles, outputName, readGame, loadCache, cachePath,
  writeSGF, makeQuery, buildEnhancedSGF, toAnalysis, encodeKT, commentFor, inferKomi
};
