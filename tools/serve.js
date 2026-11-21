/* Static server + built-in KataGo analysis API.
 *
 *   node tools/serve.js [port]   -> http://127.0.0.1:8000
 *
 * The web page can now start / watch / stop an analysis directly, without
 * running `node tools/analyze.js` in a terminal. API:
 *   GET  /api/source-games            list source SGFs + cache progress (input = project sgf/ or KATRAIN_DIR/sgf)
 *   POST /api/analyze                 {files, visits, threads, limit, force, comments}
 *   GET  /api/analyze/status          progress / logs / outputs / error
 *   POST /api/analyze/stop            stop and keep completed plies in cache
 *   GET  /api/generated?names=a|b     SGF text of generated games (optional filter)
 *   GET  /api/analysis-status         light-weight generated file list
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const A = require('./analyze');

const ROOT = path.resolve(__dirname, '..');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.sgf': 'application/x-go-sgf; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png'
};

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    let data = '';
    req.on('data', function (c) {
      data += c;
      if (data.length > 1024 * 1024) { req.destroy(); reject(new Error('请求过大')); }
    });
    req.on('end', function () {
      if (!data.trim()) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('JSON 无效：' + e.message)); }
    });
    req.on('error', reject);
  });
}

function clamp(v, dflt, lo, hi) {
  if (v === null || v === undefined || v === '') return dflt;
  const n = Number(v);
  if (!isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

/* ---------------- source game list ---------------- */
function sourceGames(visits) {
  const opt = Object.assign({}, A.DEFAULTS, { visits: clamp(visits, A.DEFAULTS.visits, 10, 2000) });
  const ready = {
    engine: fs.existsSync(opt.engine) && fs.existsSync(opt.config),
    model: fs.existsSync(opt.model)
  };
  let files = [];
  try { files = A.collectFiles(opt.input, ''); } catch (e) { /* missing input dir */ }
  const list = files.map(function (f) {
    try {
      const g = A.readGame(f, opt);
      const total = g.moves.length + 1;
      return {
        name: g.filename, moves: g.moves.length, komi: g.komi, rules: g.rules,
        cached: Object.keys(A.loadCache(g, opt)).length, total: total,
        generated: fs.existsSync(path.join(opt.out, g.filename))
      };
    } catch (e) { return { name: path.basename(f), error: e.message, moves: 0, total: 0, cached: 0 }; }
  });
  return {
    available: ready.engine && ready.model, ready: ready,
    input: opt.input, visits: opt.visits, threads: opt.threads,
    hint: !ready.engine ? '引擎未解包，请先运行 python tools/extract_engine.py'
      : (!ready.model ? '模型文件未找到：' + opt.model : ''),
    files: list
  };
}

/* ---------------- single in-process analysis task ---------------- */
const task = {
  running: false, startedAt: null, finishedAt: null,
  done: 0, failed: 0, total: 0, rate: 0, eta: 0, seconds: 0,
  outputs: [], logs: [], error: null, cancelled: false,
  options: null, files: []
};
let handle = null;

function pushLog(s) {
  const text = String(s == null ? '' : s).replace(/\s+$/, '');
  if (!text) return;
  task.logs.push(text);
  if (task.logs.length > 240) task.logs.splice(0, task.logs.length - 240);
}

function applyProgress(s) {
  ['running', 'done', 'failed', 'total', 'rate', 'eta', 'seconds', 'error'].forEach(function (k) {
    if (s[k] !== undefined) task[k] = s[k];
  });
  if (s.outputs && s.outputs.length) {
    s.outputs.forEach(function (n) { if (task.outputs.indexOf(n) < 0) task.outputs.push(n); });
  }
}

function status() {
  const s = Object.assign({}, task);
  s.available = fs.existsSync(A.DEFAULTS.engine) && fs.existsSync(A.DEFAULTS.model);
  return s;
}

function startAnalysis(body) {
  if (task.running) return { code: 409, payload: Object.assign({ error: '已有分析任务正在运行' }, status()) };
  const names = Array.isArray(body.files) ? body.files.map(String).filter(Boolean) : [];
  if (!names.length) return { code: 400, payload: { error: '请至少选择一个棋谱' } };

  const opt = Object.assign({}, A.DEFAULTS, {
    files: names,
    visits: clamp(body.visits, A.DEFAULTS.visits, 10, 2000),
    threads: clamp(body.threads, A.DEFAULTS.threads, 1, 16),
    limit: clamp(body.limit, 0, 0, 1000),
    force: !!body.force,
    comments: body.comments !== false,
    only: ''
  });

  let prep;
  try { prep = A.prepare(opt); }
  catch (e) { return { code: 400, payload: { error: e.message } }; }

  Object.assign(task, {
    running: true, startedAt: new Date().toISOString(), finishedAt: null,
    done: 0, failed: 0, total: prep.jobs.length, rate: 0, eta: 0, seconds: 0,
    outputs: prep.outputs.slice(), logs: [], error: null, cancelled: false,
    options: { visits: opt.visits, threads: opt.threads, limit: opt.limit, force: opt.force },
    files: prep.games.map(function (g) { return g.filename; })
  });
  pushLog('开始分析 ' + prep.games.length + ' 局 / ' + prep.jobs.length + ' 个局面，' +
    opt.visits + ' visits，' + opt.threads + ' 并发' + (opt.limit ? '，仅前 ' + opt.limit + ' 手' : ''));
  prep.errors.forEach(function (e) { pushLog('跳过 ' + e); });

  if (!prep.jobs.length) {
    task.running = false;
    task.finishedAt = new Date().toISOString();
    pushLog('全部已有缓存，直接生成 ' + prep.outputs.length + ' 份棋谱。');
    return { code: 200, payload: status() };
  }

  handle = A.run(opt, prep.games, prep.jobs, {
    log: pushLog,
    progress: applyProgress,
    cancelled: function () { return false; }
  });
  handle.promise.then(function (r) {
    task.running = false;
    task.cancelled = !!r.cancelled;
    task.error = r.error || null;
    task.finishedAt = new Date().toISOString();
    applyProgress(r);
    pushLog((r.cancelled ? '已停止' : '完成') + '：' + r.done + ' 个局面，失败 ' + r.failed +
      ' 个，用时 ' + r.seconds.toFixed(1) + 's，生成 ' + task.outputs.length + ' 份棋谱。');
    handle = null;
  }).catch(function (e) {
    task.running = false;
    task.error = e.message;
    task.finishedAt = new Date().toISOString();
    pushLog('错误：' + e.message);
    handle = null;
  });
  return { code: 202, payload: status() };
}

/* ---------------- generated SGFs ---------------- */
function generated(rel, withText) {
  const dir = path.join(ROOT, 'sgfout');
  const q = new URL('http://localhost' + rel).searchParams;
  const wanted = q.get('names');
  const filter = wanted ? wanted.split('|').map(function (n) { return n.toLowerCase(); }) : null;
  let files = [];
  try {
    files = fs.readdirSync(dir).filter(function (f) {
      return /\.sgf$/i.test(f) && (!filter || filter.indexOf(f.toLowerCase()) >= 0);
    });
  } catch (e) { /* no output yet */ }
  return {
    count: files.length,
    files: files.map(function (f) {
      const st = fs.statSync(path.join(dir, f));
      const item = { name: f, size: st.size, mtime: st.mtime.toISOString() };
      if (withText) item.text = fs.readFileSync(path.join(dir, f), 'utf8');
      return item;
    })
  };
}

/* ---------------- routing ---------------- */
async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const rel = decodeURIComponent(url.pathname);

  if (rel === '/api/source-games') return json(res, 200, sourceGames(url.searchParams.get('visits')));
  if (rel === '/api/analyze/status') return json(res, 200, status());
  if (rel === '/api/analyze/stop') {
    const stopped = handle ? handle.cancel('用户停止') : false;
    if (!stopped) task.running = false;
    return json(res, 200, status());
  }
  if (rel === '/api/analyze') {
    if (req.method !== 'POST') return json(res, 405, { error: 'use POST' });
    const body = await readBody(req);
    const r = startAnalysis(body);
    return json(res, r.code, r.payload);
  }
  if (rel === '/api/generated') return json(res, 200, generated(req.url, true));
  if (rel === '/api/analysis-status') return json(res, 200, generated(req.url, false));

  const fileRel = rel === '/' ? '/index.html' : rel;
  const file = path.normalize(path.join(ROOT, fileRel));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(file, function (err, buf) {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
}

function start(port) {
  const server = http.createServer(function (req, res) {
    handleRequest(req, res).catch(function (e) { json(res, 500, { error: e.message }); });
  });
  return new Promise(function (resolve) { server.listen(port, '127.0.0.1', function () { resolve(server); }); });
}

if (require.main === module) {
  const port = parseInt(process.argv[2] || '8000', 10);
  start(port).then(function () {
    console.log('围棋复盘工具：http://127.0.0.1:' + port);
    console.log('网页端可直接点「AI 分析」启动 KataGo（默认 ' + A.DEFAULTS.visits + ' visits）');
  });
}
module.exports = { start: start, ROOT: ROOT, task: task };
