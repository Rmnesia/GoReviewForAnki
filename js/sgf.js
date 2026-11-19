/* GoReview.SGF — SGF(FF4) parser + KaTrain analysis decoder
 * Works both in the browser (plain <script>) and in Node (for selftest).
 */
(function (root) {
  'use strict';
  var NS = (root.GoReview = root.GoReview || {});

  var LETTERS = 'ABCDEFGHJKLMNOPQRST'; // GTP columns skip 'I'

  /* ---------------- basic coordinate helpers ---------------- */

  function sgfToXY(s, size) {
    size = size || 19;
    if (!s || s.length < 2) return null; // pass or empty
    var x = s.charCodeAt(0) - 97;
    var y = s.charCodeAt(1) - 97;
    if (x < 0 || y < 0 || x >= size || y >= size) return null;
    return { x: x, y: y };
  }

  function xyToSgf(x, y) {
    return String.fromCharCode(97 + x, 97 + y);
  }

  function gtpToXY(g, size) {
    size = size || 19;
    if (!g || /^pass$/i.test(g.trim())) return null;
    var m = /^([A-Za-z])(\d{1,2})$/.exec(g.trim());
    if (!m) return null;
    var col = LETTERS.indexOf(m[1].toUpperCase());
    var row = parseInt(m[2], 10);
    if (col < 0 || col >= size || row < 1 || row > size) return null;
    return { x: col, y: size - row };
  }

  function xyToGtp(x, y, size) {
    size = size || 19;
    return LETTERS[x] + (size - y);
  }

  function gtpToSgf(g, size) {
    var p = gtpToXY(g, size);
    return p ? xyToSgf(p.x, p.y) : '';
  }

  function isPassGtp(g) {
    return !g || /^pass$/i.test(String(g).trim());
  }

  /* ---------------- SGF tokenizer / tree ---------------- */

  function tokenize(text) {
    var tokens = [];
    var i = 0, n = text.length;

    function readValue() {
      // text[i] === '['
      i++;
      var out = '';
      while (i < n) {
        var c = text[i];
        if (c === '\\') {
          // SGF escaping: backslash escapes the next char; a backslash
          // immediately before a line break is a soft line break.
          if (i + 1 < n) {
            var nx = text[i + 1];
            if (nx === '\r' || nx === '\n') {
              i += 2;
              if (nx === '\r' && text[i] === '\n') i++;
              continue;
            }
            out += nx;
            i += 2;
            continue;
          }
          i++;
          continue;
        }
        if (c === ']') { i++; break; }
        out += c;
        i++;
      }
      return out;
    }

    while (i < n) {
      var ch = text[i];
      if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === '\ufeff') { i++; continue; }
      if (ch === '(' || ch === ')' || ch === ';') { tokens.push({ t: ch }); i++; continue; }
      if (ch === '[') { tokens.push({ t: 'V', v: readValue() }); i++; continue; }
      if (ch >= 'A' && ch <= 'Z') {
        var name = '';
        while (i < n && text[i] >= 'A' && text[i] <= 'Z') { name += text[i]; i++; }
        var vals = [];
        while (true) {
          var j = i;
          while (j < n && (text[j] === ' ' || text[j] === '\n' || text[j] === '\r' || text[j] === '\t')) j++;
          if (text[j] !== '[') break;
          i = j;
          vals.push(readValue());
        }
        tokens.push({ t: 'P', name: name, vals: vals });
        continue;
      }
      i++; // unknown char (e.g. lowercase junk) -> ignore
    }
    return tokens;
  }

  function parseSGF(text) {
    var tokens = tokenize(text);
    var pos = 0;

    function peek() { return pos < tokens.length ? tokens[pos].t : null; }

    function parseSequence(parentNode) {
      var nodes = [];
      while (peek() === ';') {
        pos++;
        var props = Object.create(null);
        while (peek() === 'P' || peek() === 'V') {
          if (peek() === 'V') { pos++; continue; }
          var tk = tokens[pos++];
          (props[tk.name] = props[tk.name] || []).push.apply(props[tk.name], tk.vals);
        }
        var node = { props: props, children: [], parent: parentNode || null };
        if (parentNode) parentNode.children.push(node);
        nodes.push(node);
        parentNode = node;
      }
      return nodes;
    }

    function parseTree(attachTo) {
      if (peek() !== '(') return null;
      pos++;
      var seq = parseSequence(attachTo);
      var last = seq.length ? seq[seq.length - 1] : attachTo;
      while (peek() === '(') parseTree(last);
      if (peek() === ')') pos++;
      return seq.length ? seq[0] : null;
    }

    var root = null;
    while (peek() === '(') {
      var r = parseTree(null);
      if (!root) root = r;
    }
    return root;
  }

  function mainLine(root) {
    var line = [];
    var n = root;
    while (n) {
      line.push(n);
      n = n.children.length ? n.children[0] : null;
    }
    return line;
  }

  function first(props, key, dflt) {
    return props[key] && props[key].length ? props[key][0] : dflt;
  }

  /* ---------------- KaTrain KT[...] decoding ---------------- */

  function base64ToBytes(b64) {
    var clean = String(b64).replace(/\s+/g, '');
    var bin = root.atob(clean);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function gunzipToString(bytes) {
    if (typeof root.DecompressionStream !== 'function') {
      throw new Error('当前环境不支持 gzip 解压，请使用较新版本的 Chrome / Edge');
    }
    var stream = new root.Blob([bytes]).stream().pipeThrough(new root.DecompressionStream('gzip'));
    var reader = stream.getReader();
    var chunks = [], total = 0;
    while (true) {
      var r = await reader.read();
      if (r.done) break;
      chunks.push(r.value);
      total += r.value.length;
    }
    var buf = new Uint8Array(total), off = 0;
    for (var k = 0; k < chunks.length; k++) { buf.set(chunks[k], off); off += chunks[k].length; }
    return new root.TextDecoder('utf-8').decode(buf);
  }

  // KT is a 3-value SGF property: [ownership][policy][main analysis json]
  async function decodeKT(values) {
    if (!values || !values.length) return null;
    var pick = values.length >= 3 ? values[2] : values[values.length - 1];
    try {
      var json = await gunzipToString(base64ToBytes(pick));
      var data = JSON.parse(json);
      if (!data || typeof data !== 'object') return null;
      return data;
    } catch (e) {
      return { __error: String(e && e.message || e) };
    }
  }

  /* ---------------- KaTrain readable comment fallback ---------------- */

  function parseComment(text) {
    var out = { loss: null, best: null, pv: null, pvPlayer: null, bestMove: false, hasInfo: false };
    if (!text) return out;
    var t = String(text).replace(/：/g, ':');
    var m;
    if ((m = /目数损失\s*:?\s*([\d.]+)/.exec(t)) ||
        (m = /目数?损失\s*[:：]?\s*([\d.]+)/.exec(t)) ||
        (m = /point[s]?\s+loss\s*:?\s*([\d.]+)/i.exec(t)) ||
        (m = /lost\s+([\d.]+)\s+points?/i.exec(t))) {
      out.loss = parseFloat(m[1]);
      out.hasInfo = true;
    }
    if (/该手为最佳选点|best move/i.test(t)) { out.bestMove = true; out.hasInfo = true; }
    if ((m = /推荐最佳选点\s*([A-Z]\d{1,2}|pass)/i.exec(t)) ||
        (m = /top\s+move\s*[:：]?\s*([A-Z]\d{1,2}|pass)/i.exec(t))) {
      out.best = m[1];
      out.hasInfo = true;
    }
    // KaTrain writes two PV shapes:
    //   "PV: B Q16 D4 ..."  (older / manually written)
    //   "PV: BQ16 D4 R3 ..." (real KaTrain 1.19 export: the colour letter is
    //                          glued to the first coordinate)
    // Normalise both into a plain coordinate array, e.g. ["Q16","D4","R3"].
    if ((m = /PV\s*:\s*([^\r\n]*)/i.exec(t))) {
      var raw = m[1].trim();
      var pm = /^([BW])\s*([A-Z]\d{1,2}|pass)\b/i.exec(raw);
      if (pm) {
        out.pvPlayer = pm[1].toUpperCase();
        var coords = [pm[2]];
        var rest = raw.slice(pm[0].length).trim();
        if (rest) {
          var parts = rest.split(/[\s,]+/);
          for (var k = 0; k < parts.length; k++) {
            if (/^(?:[A-Z]\d{1,2}|pass)$/i.test(parts[k])) coords.push(parts[k]);
            else break; // stop at trailing prose / next field
          }
        }
        out.pv = coords;
        out.hasInfo = true;
      }
    }
    return out;
  }

  /* ---------------- game building ---------------- */

  function idsFromFilename(filename) {
    var base = String(filename || '').replace(/^.*[\\/]/, '').replace(/\.sgf$/i, '');
    var m = /^\[([^\]]*)\]\s*vs\s*\[([^\]]*)\]/.exec(base);
    if (m) return { black: m[1], white: m[2] };
    return null;
  }

  // pick the AI's best move from a node's analysis (the KT of the PARENT node)
  function bestMoveFromAnalysis(analysis) {
    if (!analysis || !analysis.moves) return null;
    var list = Object.keys(analysis.moves).map(function (k) { return analysis.moves[k]; });
    if (!list.length) return null;
    var top = list.filter(function (d) { return d.order === 0; })[0];
    if (!top) {
      // fall back: highest visits
      top = list.slice().sort(function (a, b) { return (b.visits || 0) - (a.visits || 0); })[0];
    }
    if (!top) return null;
    var pv = (Array.isArray(top.pv) && top.pv.length) ? top.pv.slice()
           : (Array.isArray(analysis.root && analysis.root.pv) ? analysis.root.pv.slice() : [top.move]);
    return { move: top.move, pv: pv, visits: top.visits || 0 };
  }

  function scoreOf(analysis) {
    if (!analysis || !analysis.root) return null;
    var s = analysis.root.scoreLead;
    return typeof s === 'number' ? s : null;
  }

  /**
   * Build a compact, serialisable review record from one SGF.
   * Returns { filename, size, pb, pw, playerColor, learner, moves[], warning }
   * moves[]: { ply, color, sgf, gtp, loss, best, pv, stageHint, source }
   */
  async function buildGame(sgfText, filename, learnerId) {
    var treeRoot = parseSGF(sgfText);
    if (!treeRoot) throw new Error('不是有效的 SGF 文件');
    var line = mainLine(treeRoot);
    var rp = line[0].props;
    var size = parseInt(String(first(rp, 'SZ', '19')).split(':')[0], 10) || 19;
    var pb = first(rp, 'PB', ''), pw = first(rp, 'PW', '');
    var ids = idsFromFilename(filename);
    var blackId = pb || (ids && ids.black) || '';
    var whiteId = pw || (ids && ids.white) || '';
    var color = null;
    if (learnerId && blackId === learnerId) color = 'B';
    else if (learnerId && whiteId === learnerId) color = 'W';
    else if (learnerId && ids) {
      if (ids.black === learnerId) color = 'B';
      else if (ids.white === learnerId) color = 'W';
    }

    var analyses = [];
    for (var i = 0; i < line.length; i++) {
      var kt = line[i].props.KT;
      analyses.push(kt ? await decodeKT(kt) : null);
    }

    var moves = [], ply = 0;
    for (var j = 1; j < line.length; j++) {
      var p = line[j].props;
      var mcolor = null, coord = '';
      if (p.B) { mcolor = 'B'; coord = p.B[0]; }
      else if (p.W) { mcolor = 'W'; coord = p.W[0]; }
      if (!mcolor) continue; // a node without a move (setup/comment only)
      ply++;
      var xy = sgfToXY(coord, size);
      var gtp = xy ? xyToGtp(xy.x, xy.y, size) : 'pass';

      var loss = null, best = null, pv = null, source = 'none';
      var curA = analyses[j], parA = analyses[j - 1];
      var cs = scoreOf(curA), ps = scoreOf(parA);
      if (cs !== null && ps !== null) {
        // KaTrain: points_lost = player_sign * (parent.scoreLead - this.scoreLead)
        var sign = mcolor === 'B' ? 1 : -1;
        loss = sign * (ps - cs);
        source = 'KT';
      }
      var bm = bestMoveFromAnalysis(parA);
      if (bm) { best = bm.move; pv = bm.pv; }

      var cmt = parseComment((p.C || []).join('\n'));
      if (loss === null && cmt.loss !== null) { loss = cmt.loss; source = 'C'; }
      if (loss === null && cmt.bestMove) { loss = 0; source = 'C'; }
      if (!best && cmt.best) { best = cmt.best; }
      if (!pv && cmt.pv) { pv = cmt.pv; }
      if (source === 'none' && (cmt.best || cmt.pv)) source = 'C';

      // Normalise the PV so that pv[0] is the correct answer for this position.
      if (pv && pv.length && best && !isPassGtp(pv[0]) && !isPassGtp(best) &&
          String(pv[0]).toUpperCase() !== String(best).toUpperCase()) {
        pv = [best].concat(pv);
      }

      moves.push({
        ply: ply, color: mcolor, sgf: coord, gtp: gtp,
        loss: loss, best: best || null, pv: pv || [], source: source
      });
    }

    var withData = moves.filter(function (m) { return m.loss !== null; }).length;
    var warning = '';
    if (withData === 0) {
      warning = '未找到 KaTrain 分析数据（KT[...] 或复盘注释）';
    } else if (withData < moves.length * 0.2) {
      warning = '仅 ' + withData + '/' + moves.length + ' 手有分析数据，建议导出时勾选「分析缓存到SGF」';
    }

    return {
      filename: filename || '未命名.sgf', size: size, pb: pb, pw: pw,
      blackId: blackId, whiteId: whiteId, playerColor: color,
      learnerId: learnerId || '', moves: moves, warning: warning,
      hasKT: analyses.some(function (a) { return a && !a.__error; }),
      komi: first(rp, 'KM', ''), result: first(rp, 'RE', ''), date: first(rp, 'DT', '')
    };
  }

  NS.SGF = {
    LETTERS: LETTERS,
    sgfToXY: sgfToXY, xyToSgf: xyToSgf,
    gtpToXY: gtpToXY, xyToGtp: xyToGtp, gtpToSgf: gtpToSgf,
    isPassGtp: isPassGtp,
    tokenize: tokenize, parseSGF: parseSGF, mainLine: mainLine,
    decodeKT: decodeKT, parseComment: parseComment,
    idsFromFilename: idsFromFilename, buildGame: buildGame,
    bestMoveFromAnalysis: bestMoveFromAnalysis, scoreOf: scoreOf
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
