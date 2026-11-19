/* Generate KaTrain-style demo SGFs (with KT[...] + Chinese review comments)
 * so the tool can be tried end-to-end before real KaTrain exports exist.
 * Run: node tools/make_sample.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const sandbox = {
  console, atob, Blob, DecompressionStream, TextDecoder, TextEncoder,
  devicePixelRatio: 1, setTimeout, clearTimeout, Date, Math, JSON
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
['sgf.js', 'board.js', 'review.js'].forEach(function (f) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), sandbox, { filename: f });
});
const G = sandbox.GoReview;
const SGF = G.SGF, BM = G.Board;

function readMoves(sgfFile) {
  const text = fs.readFileSync(sgfFile, 'utf8');
  const line = SGF.mainLine(SGF.parseSGF(text));
  const pos = new BM.Position(19);
  const out = [];
  for (let i = 1; i < line.length; i++) {
    const p = line[i].props;
    let color = null, coord = '';
    if (p.B) { color = 'B'; coord = p.B[0]; }
    else if (p.W) { color = 'W'; coord = p.W[0]; }
    if (!color) continue;
    const xy = SGF.sgfToXY(coord, 19);
    if (!pos.play(color, xy, SGF.xyToGtp(xy ? xy.x : 0, xy ? xy.y : 0, 19))) continue; // keep the position legal
    out.push({ color, sgf: coord, gtp: SGF.xyToGtp(xy.x, xy.y, 19) });
  }
  return out;
}

/* find a legal principal variation from a position */
const PREFERRED = ['Q16', 'D4', 'Q4', 'D16', 'K10', 'K4', 'D10', 'Q10', 'C3', 'R3', 'C17', 'R17',
  'F3', 'F17', 'O3', 'O17', 'J4', 'J16', 'C9', 'Q9'];

function legalPV(pos, firstColor, len) {
  const sim = pos.clone(), size = pos.size, out = [];
  const cand = PREFERRED.slice();
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) cand.push(SGF.xyToGtp(x, y, size));
  for (let i = 0; i < cand.length && out.length < len; i++) {
    const color = out.length % 2 === 0 ? firstColor : (firstColor === 'B' ? 'W' : 'B');
    if (sim.playGtp(color, cand[i])) out.push(cand[i]);
  }
  return out;
}

function packFloats(n) {
  const buf = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) buf.writeFloatLE(0.001 * (i % 7), i * 4);
  return buf;
}

function encodeKT(analysis) {
  const main = JSON.stringify(analysis);
  return [
    zlib.gzipSync(packFloats(361)), // ownership (unused by the tool)
    zlib.gzipSync(packFloats(362)), // policy (unused by the tool)
    zlib.gzipSync(Buffer.from(main, 'utf8'))
  ].map(function (b) { return b.toString('base64'); });
}

function sgfValue(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/\]/g, '\\]');
}

function buildDemo(srcFile, outName, learnerColor, problemSpec) {
  const moves = readMoves(srcFile);
  const N = moves.length;
  const opp = learnerColor === 'B' ? 'W' : 'B';

  // preset point losses: mostly small, a handful of big ones per stage
  const losses = new Array(N);
  for (let i = 0; i < N; i++) losses[i] = 0.15 + ((i * 37) % 11) * 0.09;
  Object.keys(problemSpec).forEach(function (plyStr) {
    const ply = parseInt(plyStr, 10) - 1;
    if (ply >= 0 && ply < N && moves[ply].color === learnerColor) losses[ply] = problemSpec[plyStr];
  });

  // scoreLead sequence that reproduces those losses via KaTrain's formula
  const score = [6.5];
  for (let i = 0; i < N; i++) {
    score.push(moves[i].color === 'B' ? score[i] - losses[i] : score[i] + losses[i]);
  }

  // positions after each move
  const positions = [new BM.Position(19)];
  for (let i = 0; i < N; i++) {
    const p = positions[i].clone();
    p.play(moves[i].color, SGF.sgfToXY(moves[i].sgf, 19), moves[i].gtp);
    positions.push(p);
  }

  // KT analysis for each node = candidates from THAT node's position
  const analyses = [];
  for (let j = 0; j <= N; j++) {
    const nextColor = j < N ? moves[j].color : (moves[N - 1].color === 'B' ? 'W' : 'B');
    const pv = legalPV(positions[j], nextColor, 9);
    const top = pv[0] || 'pass';
    const m = {};
    m[top] = {
      move: top, order: 0, visits: 500, winrate: 0.55,
      scoreLead: score[j] + (nextColor === 'B' ? 0.4 : -0.4),
      pv: pv
    };
    if (pv[1]) m[pv[1]] = { move: pv[1], order: 1, visits: 62, winrate: 0.53, scoreLead: score[j] - 1.2, pv: pv.slice(1) };
    if (pv[2]) m[pv[2]] = { move: pv[2], order: 2, visits: 31, winrate: 0.51, scoreLead: score[j] - 2.4, pv: pv.slice(2) };
    analyses.push({
      moves: m,
      root: { scoreLead: score[j], winrate: 0.5, visits: 500 },
      completed: true
    });
  }

  // assemble SGF
  const pb = learnerColor === 'B' ? 'nicomai' : (outName.indexOf('1236548789') >= 0 ? '1236548789' : '对手A');
  const pw = learnerColor === 'W' ? 'nicomai' : '里奥0208';
  const head = '(;GM[1]FF[4]CA[UTF-8]AP[KaTrain:1.19.0]KTV[1.0]\n' +
    'SZ[19]\nPB[' + sgfValue(pb) + ']\nPW[' + sgfValue(pw) + ']\n' +
    'KM[375]HA[0]RU[Chinese]RE[W+R]DT[2026-10-31]\n';

  let body = '';
  body += 'KT[' + encodeKT(analyses[0]).join('][') + ']C[SGF generated by KaTrain 1.19.0 (demo)]\n';
  for (let i = 0; i < N; i++) {
    const mv = moves[i];
    const topEntry = Object.keys(analyses[i].moves).map(function (k) { return analyses[i].moves[k]; })
      .filter(function (d) { return d.order === 0; })[0];
    const best = topEntry ? topEntry.move : 'pass';
    const pv = topEntry ? topEntry.pv : [];
    const loss = losses[i];
    let c = '手数 ' + (i + 1) + ': ' + mv.color + ' ' + mv.gtp + '\n' +
      '目差: 黑+' + Math.abs(score[i + 1]).toFixed(1) + '\n' +
      '胜率: 黑 55.0%\n';
    if (loss > 0.5) {
      c += '目数损失: ' + loss.toFixed(1) + '\n' +
        '推荐最佳选点 ' + best + ' (黑+7.0).\n' +
        'PV: ' + mv.color + ' ' + pv.join(' ') + '\n';
    } else {
      c += '该手为最佳选点\nPV: ' + mv.color + ' ' + pv.join(' ') + '\n';
    }
    body += ';' + mv.color + '[' + mv.sgf + ']' +
      'KT[' + encodeKT(analyses[i + 1]).join('][') + ']' +
      'C[' + sgfValue(c.trim()) + ']\n';
  }

  const out = head + body + ')\n';
  const dest = path.join(ROOT, 'sample', outName);
  fs.writeFileSync(dest, out, 'utf8');
  console.log(outName, '| moves', N, '| learner', learnerColor, '| size', (out.length / 1024).toFixed(0) + 'KB');
  return { outName, N };
}

const sgfDir = path.resolve(ROOT, '..', 'sgf');
const blackGame = path.join(sgfDir, '[nicomai]vs[里奥0208]1793435850030033060.sgf');
const whiteGame = path.join(sgfDir, '[1236548789]vs[nicomai]1793162379030032101.sgf');

// opening / middle / endgame mistakes; plies 41 & 43 share the same answer
// on purpose, to exercise the "连续同一步" merge rule.
buildDemo(blackGame, '[nicomai]vs[里奥0208]1793435850030033060.sgf', 'B', {
  7: 3.2, 19: 4.5, 41: 2.8, 43: 3.6,
  61: 7.1, 97: 6.0, 133: 5.6,
  161: 4.2, 197: 3.7
});
buildDemo(whiteGame, '[1236548789]vs[nicomai]1793162379030032101.sgf', 'W', {
  12: 3.4, 32: 2.6,
  62: 6.4, 108: 5.3,
  152: 3.9
});
