/* End-to-end selftest: node tools/selftest.js
 * Loads the browser modules in a VM context and exercises the whole pipeline.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const mem = {};
const sandbox = {
  console, atob, btoa, Blob, DecompressionStream, TextDecoder, TextEncoder,
  devicePixelRatio: 1, setTimeout, clearTimeout,
  localStorage: {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
    setItem: function (k, v) { mem[k] = String(v); },
    removeItem: function (k) { delete mem[k]; }
  }
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
['sgf.js', 'board.js', 'review.js', 'srs.js', 'store.js'].forEach(function (f) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), sandbox, { filename: f });
});
const G = sandbox.GoReview;
const SGF = G.SGF, BM = G.Board, Review = G.Review, SRS = G.SRS, Store = G.Store;

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  [' + detail + ']' : '')); }
}
function near(a, b, eps) { return a !== null && Math.abs(a - b) <= (eps || 0.051); }
function head(t) { console.log('\n== ' + t + ' =='); }

async function main() {
  head('1. coordinate round-trip');
  let roundOk = true;
  for (let y = 0; y < 19; y++) for (let x = 0; x < 19; x++) {
    const g = SGF.xyToGtp(x, y, 19), p = SGF.gtpToXY(g, 19), s = SGF.xyToSgf(x, y), q = SGF.sgfToXY(s, 19);
    if (!p || p.x !== x || p.y !== y || !q || q.x !== x || q.y !== y) roundOk = false;
  }
  ok('361 points survive SGF<->GTP conversion', roundOk);
  ok('pass handling', SGF.gtpToXY('pass', 19) === null && SGF.isPassGtp('PASS'));

  head('2. parse KaTrain-style demo SGF + KT decompression');
  const blackFile = path.join(ROOT, 'sample', '[nicomai]vs[里奥0208]1793435850030033060.sgf');
  const whiteFile = path.join(ROOT, 'sample', '[1236548789]vs[nicomai]1793162379030032101.sgf');
  const gB = await SGF.buildGame(fs.readFileSync(blackFile, 'utf8'), path.basename(blackFile), 'nicomai');
  const gW = await SGF.buildGame(fs.readFileSync(whiteFile, 'utf8'), path.basename(whiteFile), 'nicomai');
  ok('black game parsed', gB.moves.length > 200 && gB.hasKT, gB.moves.length + ' moves, KT=' + gB.hasKT);
  ok('white game parsed', gW.moves.length > 150 && gW.hasKT, gW.moves.length + ' moves, KT=' + gW.hasKT);
  ok('learner colour from PB/PW', gB.playerColor === 'B' && gW.playerColor === 'W', gB.playerColor + '/' + gW.playerColor);
  ok('filename id fallback', (function () {
    const i = SGF.idsFromFilename('[AAA]vs[BBB]123.sgf');
    return i && i.black === 'AAA' && i.white === 'BBB';
  })());
  const allLoss = gB.moves.every(function (m) { return m.loss !== null; });
  ok('every move has a point loss from KT', allLoss);
  ok('preset opening mistake (ply 7 = 3.2)', near(gB.moves[6].loss, 3.2), 'got ' + gB.moves[6].loss);
  ok('preset middle mistake (ply 61 = 7.1)', near(gB.moves[60].loss, 7.1), 'got ' + gB.moves[60].loss);
  ok('preset endgame mistake (ply 161 = 4.2)', near(gB.moves[160].loss, 4.2), 'got ' + gB.moves[160].loss);
  ok('white-side mistake (ply 12 = 3.4)', near(gW.moves[11].loss, 3.4), 'got ' + gW.moves[11].loss);
  ok('best move + PV available', !!gB.moves[6].best && gB.moves[6].pv.length >= 5,
    'best=' + gB.moves[6].best + ' pv=' + gB.moves[6].pv.length);

  head('3. comment-only fallback (no KT)');
  const commentSGF = '(;GM[1]FF[4]SZ[19]PB[u]PW[x]\n' +
    ';B[pd]C[手数 1: B Q16\n目差: 黑+3.5\n胜率: 黑 55.0%\n目数损失: 3.5\n' +
    '推荐最佳选点 D4 (黑+7.0).\nPV: B D4 Q4 C3 R3 D16]\n;W[qq])';
  const cOnly = await SGF.buildGame(commentSGF, 'comment-only.sgf', 'u');
  ok('loss parsed from Chinese comment', near(cOnly.moves[0].loss, 3.5), 'got ' + cOnly.moves[0].loss);
  ok('best + PV parsed from comment', cOnly.moves[0].best === 'D4' && cOnly.moves[0].pv.length === 5,
    cOnly.moves[0].best + ' / ' + cOnly.moves[0].pv.join(','));
  ok('no KT flagged', cOnly.hasKT === false);
  const plain = await SGF.buildGame('(;SZ[19]PB[u]PW[x];B[pd];W[qq])', 'plain.sgf', 'u');
  ok('plain SGF reports missing analysis', /未找到/.test(plain.warning), plain.warning);

  head('4. problem filtering, thresholds, stage split');
  const games = [gB, gW];
  const base = JSON.parse(JSON.stringify(Store.DEFAULT_SETTINGS));
  base.learnerId = 'nicomai';
  let r = Review.collectProblems(games, base);
  const sum = Review.summarize(r.problems);
  ok('problems found with 2/5/3 thresholds', r.problems.length >= 10, 'total ' + r.problems.length);
  ok('all three stages present', sum.opening > 0 && sum.middle > 0 && sum.endgame > 0,
    '开' + sum.opening + '/中' + sum.middle + '/官' + sum.endgame);
  ok('only learner moves are selected', r.problems.every(function (p) {
    const g = games.filter(function (x) { return x.filename === p.filename; })[0];
    return p.color === g.playerColor;
  }));
  ok('loss strictly above stage threshold', r.problems.every(function (p) { return p.loss > p.threshold; }));
  const lower = JSON.parse(JSON.stringify(base));
  lower.thresholds = { opening: 0.5, middle: 0.5, endgame: 0.5 };
  const rLower = Review.collectProblems(games, lower);
  ok('lowering thresholds adds problems (auto refresh)', rLower.problems.length > r.problems.length,
    r.problems.length + ' -> ' + rLower.problems.length);
  const higher = JSON.parse(JSON.stringify(base));
  higher.thresholds = { opening: 20, middle: 20, endgame: 20 };
  ok('raising thresholds removes problems', Review.collectProblems(games, higher).problems.length === 0);
  const stageShift = JSON.parse(JSON.stringify(base));
  stageShift.openingEnd = 20; stageShift.middleEnd = 100;
  const s2 = Review.summarize(Review.collectProblems(games, stageShift).problems);
  ok('stage boundaries are configurable', s2.opening !== sum.opening || s2.endgame !== sum.endgame,
    '开' + s2.opening + '/官' + s2.endgame);

  head('5. "continuous same move" merge keeps the first occurrence');
  const mini = {
    filename: 'mini.sgf', size: 19, pb: 'u', pw: 'x', playerColor: 'B',
    moves: [
      { ply: 1, color: 'B', gtp: 'Q16', sgf: 'pd', loss: 5.0, best: 'D4', pv: ['D4', 'Q4', 'C3'], source: 'KT' },
      { ply: 2, color: 'W', gtp: 'R3', sgf: 'qq', loss: 0.2, best: 'D4', pv: ['D4'], source: 'KT' },
      { ply: 3, color: 'B', gtp: 'C3', sgf: 'dq', loss: 6.0, best: 'D4', pv: ['D4'], source: 'KT' },
      { ply: 4, color: 'W', gtp: 'D16', sgf: 'dd', loss: 0.2, best: 'D4', pv: ['D4'], source: 'KT' },
      { ply: 5, color: 'B', gtp: 'K10', sgf: 'jj', loss: 7.0, best: 'D4', pv: ['D4'], source: 'KT' },
      { ply: 6, color: 'W', gtp: 'Q4', sgf: 'cp', loss: 0.2, best: 'D4', pv: ['D4'], source: 'KT' },
      { ply: 7, color: 'B', gtp: 'C3', sgf: 'cc', loss: 0.1, best: 'D4', pv: ['D4'], source: 'KT' },
      { ply: 8, color: 'W', gtp: 'D16', sgf: 'dp', loss: 0.2, best: 'D4', pv: ['D4'], source: 'KT' },
      { ply: 9, color: 'B', gtp: 'Q16', sgf: 'pq', loss: 4.0, best: 'Q10', pv: ['Q10'], source: 'KT' }
    ], warning: '', hasKT: true
  };
  const merged = Review.collectProblems([mini], base).problems;
  ok('three consecutive same-answer mistakes merge into one', merged.length === 2,
    'kept plies ' + merged.map(function (p) { return p.ply; }).join(','));
  ok('first occurrence is kept', merged[0].ply === 1 && merged[0].merged.join(',') === '3,5',
    'merged=' + merged[0].merged.join(','));
  ok('later independent mistake is separate', merged[1].ply === 9);
  const noMerge = JSON.parse(JSON.stringify(base)); noMerge.mergeConsecutive = false;
  ok('merge can be switched off', Review.collectProblems([mini], noMerge).problems.length === 4);
  const byPlayed = JSON.parse(JSON.stringify(base)); byPlayed.mergeBasis = 'best';
  ok('merge basis is configurable', Review.collectProblems([mini], byPlayed).problems.length === 2);

  head('6. three-step practice sequence (legal, AI auto-replies)');
  const sample = r.problems.slice(0, 12);
  let seqOk = 0, seqFull = 0;
  sample.forEach(function (p) {
    const g = games.filter(function (x) { return x.filename === p.filename; })[0];
    const pos = BM.positionBefore(g, p.ply, g.size);
    const seq = Review.buildSequence(pos, p, g.playerColor, 3);
    const sim = pos.clone();
    let legal = true;
    for (let i = 0; i < seq.n; i++) {
      if (!sim.playGtp(g.playerColor, seq.expected[i])) { legal = false; break; }
      if (i < seq.n - 1 && seq.replies[i] && !sim.playGtp(g.playerColor === 'B' ? 'W' : 'B', seq.replies[i])) { legal = false; break; }
    }
    if (legal && seq.expected.length === seq.n && seq.replies.length === seq.n - 1) seqOk++;
    if (seq.n === 3) seqFull++;
  });
  ok('all sampled cards produce a legal 3-step sequence', seqOk === sample.length, seqOk + '/' + sample.length);
  ok('AI PV is long enough for 3 learner moves', seqFull === sample.length, seqFull + '/' + sample.length);
  const badPv = Review.buildSequence(new BM.Position(19), { pv: ['A19'], best: 'A19' }, 'B', 3);
  ok('short PV degrades gracefully', badPv.n === 1 && badPv.truncated, 'n=' + badPv.n);

  head('7. grading by cumulative mistakes (no reset on wrong click)');
  const rate = SRS.rate;
  ok('0 -> 简单', rate(0, base.rating) === 'easy');
  ok('1 -> 良好', rate(1, base.rating) === 'good');
  ok('2 -> 困难', rate(2, base.rating) === 'hard');
  ok('>=3 -> 重来', rate(3, base.rating) === 'again' && rate(9, base.rating) === 'again');
  const custom = { easyMax: 1, goodMax: 3, hardMax: 5 };
  ok('rating thresholds editable', rate(1, custom) === 'easy' && rate(3, custom) === 'good' && rate(6, custom) === 'again');
  const sch = SRS.schedule(null, 'good', 1000000);
  ok('good first review -> 1 day', sch.card.interval === 1 && sch.card.due === 1000000 + SRS.DAY);
  const again = SRS.schedule(null, 'again', 1000000);
  ok('again -> 10 minutes + ease penalty', again.intervalMs === 600000 && near(again.card.ease, 2.3, 1e-6) && again.card.lapses === 1);
  const easy = SRS.schedule(null, 'easy', 1000000);
  ok('easy first review -> 4 days', easy.card.interval === 4 && near(easy.card.ease, 2.65, 1e-6));
  const second = SRS.schedule(sch.card, 'good', 2000000);
  ok('second good grows by ease', near(second.card.interval, 2.5, 1e-6), 'interval=' + second.card.interval);

  head('8. SRS queue + persistence');
  const cards = {};
  cards[sample[0].id] = SRS.schedule(null, 'good', Date.now() - 2 * SRS.DAY).card; // due yesterday
  const q = SRS.buildQueue(sample, cards, [], Date.now());
  ok('due cards come before new cards', q[0].id === sample[0].id);
  const qDel = SRS.buildQueue(sample, cards, [sample[0].id], Date.now());
  ok('deleted cards are excluded', qDel.every(function (p) { return p.id !== sample[0].id; }));
  Store.resetAll();
  Store.setSettings({ learnerId: 'nicomai' });
  ok('settings persist', Store.get().settings.learnerId === 'nicomai');
  Store.setCard('card-1', SRS.schedule(null, 'good', 1).card);
  ok('card state persists', Store.getCard('card-1').reps === 1);
  Store.deleteCard('card-1');
  ok('delete removes card + records id', Store.getCard('card-1') === null && Store.get().deletedIds.indexOf('card-1') >= 0);
  const backup = Store.exportBackup();
  Store.resetAll();
  Store.importBackup(backup);
  ok('backup round-trip keeps deleted ids', Store.get().deletedIds.indexOf('card-1') >= 0);

  head('9. board rules');
  const pos = new BM.Position(19);
  ok('legal moves accepted', pos.playGtp('B', 'D4') && pos.playGtp('W', 'Q16'));
  ok('occupied point rejected', !pos.playGtp('B', 'D4'));
  const cap = new BM.Position(19);
  const d4 = SGF.gtpToXY('D4', 19), d4idx = d4.y * 19 + d4.x;
  // surround a single white stone at D4 (black takes its 4 liberties)
  cap.playGtp('W', 'D4');
  cap.playGtp('B', 'C4'); cap.playGtp('W', 'Q16');
  cap.playGtp('B', 'E4'); cap.playGtp('W', 'Q15');
  cap.playGtp('B', 'D3'); cap.playGtp('W', 'Q14');
  const before = cap.board[d4idx];
  cap.playGtp('B', 'D5');
  const after = cap.board[d4idx];
  ok('captures work', before === -1 && after === 0 && cap.history.length === 8,
    'D4 before=' + before + ' after=' + after + ', moves=' + cap.history.length);

  head('10. command-line analysis pipeline');
  const AN = require('./analyze');
  const realCmt = '手数 15: B E17\n分数: 白+9.9\n胜率: 白 98.7%\n' +
    '目数损失: 7.3\n推荐最佳选点 C14 (白+2.6).\nPV: BC14 D13 B12 E17 F14 F12\n';
  const rc = SGF.parseComment(realCmt);
  ok('real KaTrain PV (colour glued to first coord) parsed',
    rc.loss === 7.3 && rc.best === 'C14' && rc.pv && rc.pv.length === 6 &&
    rc.pv[0] === 'C14' && rc.pv[2] === 'B12', JSON.stringify(rc));
  ok('legacy separated PV still parsed',
    SGF.parseComment('PV: B Q16 D4 R3 C3').pv.join(',') === 'Q16,D4,R3,C3');
  ok('fox komi 375 -> 7.5',
    AN.inferKomi('375') === 7.5 && AN.inferKomi('7.5') === 7.5 && AN.inferKomi('0') === 0);
  ok('web/CLI default visits = 100', AN.DEFAULTS.visits === 100,
    'visits=' + AN.DEFAULTS.visits);
  ok('analysis driver reusable by web server',
    typeof AN.prepare === 'function' && typeof AN.run === 'function' &&
    typeof AN.collectFiles === 'function' && typeof AN.loadCache === 'function');
  ok('partial run never overwrites full SGF',
    AN.outputName({ filename: 'g.sgf' }, { limit: 8 }) === 'g.part8.sgf' &&
    AN.outputName({ filename: 'g.sgf' }, { limit: 0 }) === 'g.sgf');

  const cliGame = {
    filename: 'cli.sgf', size: 19, rules: 'chinese', komi: 7.5,
    rootProps: { GM: ['1'], FF: ['4'], SZ: ['19'], PB: ['nicomai'], PW: ['rival'],
      KM: ['375'], RU: ['Chinese'] },
    moves: [
      { color: 'B', coord: 'pd', gtp: 'Q16' }, { color: 'W', coord: 'qq', gtp: 'R3' },
      { color: 'B', coord: 'cq', gtp: 'C3' }, { color: 'W', coord: 'cc', gtp: 'C17' },
      { color: 'B', coord: 'dd', gtp: 'D16' }, { color: 'W', coord: 'dp', gtp: 'D4' }
    ]
  };
  const plies = {};
  for (let p = 0; p <= cliGame.moves.length; p++) {
    plies[p] = AN.toAnalysis({
      rootInfo: { scoreLead: 6.5 - p * 0.8, winrate: 0.55, visits: 200 },
      moveInfos: [
        { move: 'K10', order: 0, visits: 120, winrate: 0.56, scoreLead: 6.9 - p * 0.8,
          pv: ['K10', 'Q16', 'C3', 'R3', 'D16', 'Q4', 'F3'] },
        { move: 'Q4', order: 1, visits: 30, winrate: 0.5, scoreLead: 5.0 - p * 0.8,
          pv: ['Q4', 'D16'] }
      ]
    });
  }
  const cliText = AN.buildEnhancedSGF(cliGame, plies, true);
  const cliParsed = await SGF.buildGame(cliText, 'cli.sgf', 'nicomai');
  ok('CLI SGF decodes KT for every move', cliParsed.hasKT &&
    cliParsed.moves.every(function (m) { return m.loss !== null && m.best === 'K10' && m.pv.length >= 6; }),
    'moves=' + cliParsed.moves.length + ' hasKT=' + cliParsed.hasKT);
  ok('CLI point loss follows KaTrain formula', near(cliParsed.moves[0].loss, 0.8),
    'got ' + cliParsed.moves[0].loss);
  const cmts = [];
  const cre = /C\[([\s\S]*?)\](?=\s*;|\s*\))/g;
  let cm; while ((cm = cre.exec(cliText))) cmts.push(cm[1].replace(/\\\]/g, ']'));
  ok('CLI comment round-trips through parser', cmts.length === cliGame.moves.length + 1 &&
    SGF.parseComment(cmts[1]).pv.length >= 6, 'comments=' + cmts.length);

  console.log('\n----------------------------------------');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  if (fail) process.exit(1);
}

main().catch(function (e) {
  console.error('\nSELFTEST CRASHED:', e && e.stack || e);
  process.exit(1);
});
