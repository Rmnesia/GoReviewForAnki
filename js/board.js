/* GoReview.Board — go position (with captures) + canvas renderer */
(function (root) {
  'use strict';
  var NS = (root.GoReview = root.GoReview || {});
  var SGF = NS.SGF;

  /* ---------------- position ---------------- */

  function Position(size) {
    this.size = size || 19;
    this.board = new Int8Array(this.size * this.size); // 0 empty, 1 black, -1 white
    this.history = []; // { color:'B'|'W', x, y, gtp, pass }
  }

  Position.prototype.clone = function () {
    var p = new Position(this.size);
    p.board.set(this.board);
    p.history = this.history.slice();
    return p;
  };

  Position.prototype.neighbors = function (idx) {
    var s = this.size, x = idx % s, y = (idx - x) / s, out = [];
    if (x > 0) out.push(idx - 1);
    if (x < s - 1) out.push(idx + 1);
    if (y > 0) out.push(idx - s);
    if (y < s - 1) out.push(idx + s);
    return out;
  };

  Position.prototype.group = function (idx) {
    var board = this.board, color = board[idx];
    var seen = Object.create(null), stack = [idx], stones = [], libs = Object.create(null);
    seen[idx] = true;
    while (stack.length) {
      var cur = stack.pop();
      stones.push(cur);
      var nb = this.neighbors(cur);
      for (var i = 0; i < nb.length; i++) {
        var j = nb[i];
        if (board[j] === 0) libs[j] = true;
        else if (board[j] === color && !seen[j]) { seen[j] = true; stack.push(j); }
      }
    }
    return { stones: stones, liberties: Object.keys(libs).length };
  };

  // xy === null means pass. Returns false if the point is occupied or suicide.
  Position.prototype.play = function (color, xy, gtp) {
    if (xy === null) {
      this.history.push({ color: color, x: -1, y: -1, gtp: gtp || 'pass', pass: true });
      return true;
    }
    var s = this.size, idx = xy.y * s + xy.x;
    if (xy.x < 0 || xy.y < 0 || xy.x >= s || xy.y >= s || this.board[idx] !== 0) return false;
    var stone = color === 'B' ? 1 : -1;
    this.board[idx] = stone;
    var nb = this.neighbors(idx);
    for (var i = 0; i < nb.length; i++) {
      var j = nb[i];
      if (this.board[j] === -stone) {
        var g = this.group(j);
        if (g.liberties === 0) for (var k = 0; k < g.stones.length; k++) this.board[g.stones[k]] = 0;
      }
    }
    if (this.group(idx).liberties === 0) { this.board[idx] = 0; return false; } // suicide
    this.history.push({ color: color, x: xy.x, y: xy.y, gtp: gtp || SGF.xyToGtp(xy.x, xy.y, s), pass: false });
    return true;
  };

  Position.prototype.playGtp = function (color, gtp) {
    return this.play(color, SGF.gtpToXY(gtp, this.size), gtp);
  };

  Position.prototype.lastMove = function () {
    for (var i = this.history.length - 1; i >= 0; i--) if (!this.history[i].pass) return this.history[i];
    return null;
  };

  // Rebuild the position just BEFORE move number `ply` (1-based) from a game record.
  function positionBefore(game, ply, size) {
    var pos = new Position(size || game.size || 19);
    for (var i = 0; i < game.moves.length; i++) {
      var m = game.moves[i];
      if (m.ply >= ply) break;
      pos.play(m.color, SGF.sgfToXY(m.sgf, pos.size), m.gtp);
    }
    return pos;
  }

  /* ---------------- renderer ---------------- */

  var STAR = [3, 9, 15];

  function Board(canvas, size) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.size = size || 19;
    this.pos = new Position(this.size);
    this.marks = [];       // { x, y, type:'ok'|'wrong'|'hint'|'ai'|'num', label }
    this.highlight = null; // {x,y}
    this.hover = null;     // {x,y} intersection under the cursor
    this.hoverColor = 'B'; // ghost stone colour
    this.hoverEnabled = true;
    this.onClick = null;
    this.onOccupiedClick = null; // optional feedback when clicking an occupied point
    this.ignoreOccupied = true;  // occupied intersections are not legal moves: never report a mistake
    this.interactive = true;
    var self = this;
    canvas.addEventListener('click', function (ev) {
      if (!self.interactive || !self.onClick) return;
      var p = self.eventToPoint(ev);
      if (!p) return;
      var occupied = self.pos && self.pos.board[p.y * self.size + p.x] !== 0;
      if (occupied && self.ignoreOccupied) {
        // A stone is already here, so the point cannot be played at all.
        // Keep the red hover square visible and do NOT forward the click to
        // the app (no mistake count, no hint state change, no progress change).
        self.hover = { x: p.x, y: p.y };
        self.render();
        if (self.onOccupiedClick) self.onOccupiedClick(p.x, p.y, SGF.xyToGtp(p.x, p.y, self.size));
        return;
      }
      self.hover = null;
      self.onClick(p.x, p.y, SGF.xyToGtp(p.x, p.y, self.size));
      self.render();
    });
    canvas.addEventListener('mousemove', function (ev) {
      if (!self.interactive || !self.hoverEnabled) {
        if (self.hover) { self.hover = null; self.render(); }
        return;
      }
      var p = self.eventToPoint(ev);
      var same = (!p && !self.hover) ||
        (p && self.hover && p.x === self.hover.x && p.y === self.hover.y);
      if (same) return;
      self.hover = p;
      self.render();
    });
    canvas.addEventListener('mouseleave', function () {
      if (self.hover) { self.hover = null; self.render(); }
    });
    if (root.ResizeObserver) {
      new root.ResizeObserver(function () { self.render(); }).observe(canvas);
    } else if (root.addEventListener) {
      root.addEventListener('resize', function () { self.render(); });
    }
  }

  Board.prototype.metrics = function () {
    var cssW = this.canvas.clientWidth || 560;
    var pad = Math.max(20, Math.round(cssW * 0.052));
    var step = (cssW - pad * 2) / (this.size - 1);
    return { w: cssW, pad: pad, step: step };
  };

  Board.prototype.eventToPoint = function (ev) {
    var rect = this.canvas.getBoundingClientRect();
    var m = this.metrics();
    var px = ev.clientX - rect.left, py = ev.clientY - rect.top;
    var x = Math.round((px - m.pad) / m.step);
    var y = Math.round((py - m.pad) / m.step);
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return null;
    if (Math.abs(px - (m.pad + x * m.step)) > m.step * 0.52) return null;
    if (Math.abs(py - (m.pad + y * m.step)) > m.step * 0.52) return null;
    return { x: x, y: y };
  };

  Board.prototype.setPosition = function (pos) {
    this.pos = pos;
    this.size = pos.size;
    this.marks = [];
    this.highlight = null;
    this.hover = null;
    this.render();
  };

  Board.prototype.setMarks = function (marks) {
    this.marks = marks || [];
    this.render();
  };

  Board.prototype.render = function () {
    var canvas = this.canvas, ctx = this.ctx;
    if (!canvas || !ctx) return;
    var m = this.metrics();
    var dpr = (root.devicePixelRatio || 1);
    if (canvas.width !== Math.round(m.w * dpr) || canvas.height !== Math.round(m.w * dpr)) {
      canvas.width = Math.round(m.w * dpr);
      canvas.height = Math.round(m.w * dpr);
      canvas.style.height = m.w + 'px';
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, m.w, m.w);

    // wooden board
    var grad = ctx.createLinearGradient(0, 0, m.w, m.w);
    grad.addColorStop(0, '#f1d9a6');
    grad.addColorStop(0.55, '#e9c98d');
    grad.addColorStop(1, '#e2bd7c');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, m.w, m.w);

    var pad = m.pad, step = m.step;
    var gx = function (i) { return pad + i * step; };
    var gy = function (i) { return pad + i * step; };

    ctx.strokeStyle = 'rgba(74,52,30,0.72)';
    ctx.lineWidth = Math.max(0.8, step * 0.022);
    ctx.beginPath();
    for (var i = 0; i < this.size; i++) {
      ctx.moveTo(gx(0), gy(i)); ctx.lineTo(gx(this.size - 1), gy(i));
      ctx.moveTo(gx(i), gy(0)); ctx.lineTo(gx(i), gy(this.size - 1));
    }
    ctx.stroke();

    // star points
    ctx.fillStyle = 'rgba(62,43,25,0.85)';
    var stars = this.size === 19 ? STAR : (this.size === 13 ? [3, 6, 9] : [2, 4, 6]);
    for (var a = 0; a < stars.length; a++) {
      for (var b = 0; b < stars.length; b++) {
        if (stars[a] >= this.size || stars[b] >= this.size) continue;
        ctx.beginPath();
        ctx.arc(gx(stars[a]), gy(stars[b]), Math.max(2, step * 0.075), 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // coordinates
    ctx.fillStyle = 'rgba(80,58,34,0.72)';
    ctx.font = Math.max(9, Math.round(step * 0.32)) + 'px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (var c = 0; c < this.size; c++) {
      ctx.fillText(SGF.LETTERS[c] || '?', gx(c), pad * 0.46);
      ctx.fillText(String(this.size - c), pad * 0.46, gy(c));
    }

    // stones
    var r = step * 0.47;
    for (var y = 0; y < this.size; y++) {
      for (var x = 0; x < this.size; x++) {
        var v = this.pos.board[y * this.size + x];
        if (!v) continue;
        var cx = gx(x), cy = gy(y);
        ctx.beginPath();
        ctx.arc(cx + step * 0.035, cy + step * 0.045, r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(60,44,26,0.20)';
        ctx.fill();
        var sg = ctx.createRadialGradient(cx - r * 0.34, cy - r * 0.38, r * 0.12, cx, cy, r * 1.08);
        if (v === 1) { sg.addColorStop(0, '#5c5c5c'); sg.addColorStop(0.45, '#242424'); sg.addColorStop(1, '#0c0c0c'); }
        else { sg.addColorStop(0, '#ffffff'); sg.addColorStop(0.55, '#f6f4ef'); sg.addColorStop(1, '#d9d4c9'); }
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = sg;
        ctx.fill();
        if (v === -1) { ctx.strokeStyle = 'rgba(90,80,66,0.35)'; ctx.lineWidth = 0.7; ctx.stroke(); }
      }
    }

    // last move marker
    var last = this.pos.lastMove();
    if (last) {
      var v2 = this.pos.board[last.y * this.size + last.x];
      ctx.strokeStyle = v2 === 1 ? '#f7f2e8' : '#3a3128';
      ctx.lineWidth = Math.max(1.3, step * 0.055);
      ctx.beginPath();
      ctx.arc(gx(last.x), gy(last.y), r * 0.46, 0, Math.PI * 2);
      ctx.stroke();
    }

    // hover: show the exact intersection + a ghost stone before confirming
    if (this.hover && this.interactive && this.hoverEnabled) {
      var hx = gx(this.hover.x), hy = gy(this.hover.y);
      var occupied = this.pos.board[this.hover.y * this.size + this.hover.x] !== 0;
      var half = step * 0.49;
      ctx.fillStyle = occupied ? 'rgba(192,57,43,0.12)' : 'rgba(47,125,225,0.12)';
      ctx.fillRect(hx - half, hy - half, half * 2, half * 2);
      ctx.strokeStyle = occupied ? 'rgba(192,57,43,0.75)' : 'rgba(47,125,225,0.8)';
      ctx.lineWidth = Math.max(1.2, step * 0.045);
      ctx.strokeRect(hx - half, hy - half, half * 2, half * 2);
      if (!occupied) {
        ctx.beginPath();
        ctx.moveTo(hx - step * 0.42, hy); ctx.lineTo(hx + step * 0.42, hy);
        ctx.moveTo(hx, hy - step * 0.42); ctx.lineTo(hx, hy + step * 0.42);
        ctx.strokeStyle = 'rgba(47,125,225,0.42)';
        ctx.lineWidth = Math.max(0.8, step * 0.022);
        ctx.stroke();
        ctx.globalAlpha = 0.52;
        ctx.beginPath(); ctx.arc(hx, hy, r * 0.92, 0, Math.PI * 2);
        ctx.fillStyle = this.hoverColor === 'W' ? '#ffffff' : '#141414';
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = this.hoverColor === 'W' ? 'rgba(60,60,60,0.55)' : 'rgba(255,255,255,0.65)';
        ctx.lineWidth = Math.max(1, step * 0.035);
        ctx.stroke();
      }
      var label = SGF.xyToGtp(this.hover.x, this.hover.y, this.size);
      var fs = Math.max(9, Math.round(step * 0.3));
      ctx.font = '600 ' + fs + 'px system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      var tw = ctx.measureText(label).width + fs * 0.8;
      var bx = hx, by = hy - step * 0.8;
      ctx.fillStyle = 'rgba(37,48,68,0.88)';
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(bx - tw / 2, by - fs * 0.7, tw, fs * 1.4, fs * 0.3);
      else ctx.rect(bx - tw / 2, by - fs * 0.7, tw, fs * 1.4);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(label, bx, by);
    }

    // marks
    for (var k = 0; k < this.marks.length; k++) {
      var mk = this.marks[k];
      var mx = gx(mk.x), my = gy(mk.y);
      var occupied = this.pos.board[mk.y * this.size + mk.x] !== 0;
      if (mk.type === 'wrong') {
        ctx.strokeStyle = '#d64545';
        ctx.lineWidth = Math.max(2, step * 0.09);
        ctx.beginPath();
        ctx.moveTo(mx - r * 0.42, my - r * 0.42); ctx.lineTo(mx + r * 0.42, my + r * 0.42);
        ctx.moveTo(mx + r * 0.42, my - r * 0.42); ctx.lineTo(mx - r * 0.42, my + r * 0.42);
        ctx.stroke();
      } else if (mk.type === 'hint' || mk.type === 'ok') {
        var col = mk.type === 'ok' ? '#1f9d6b' : '#2f7de1';
        ctx.strokeStyle = col;
        ctx.fillStyle = col;
        ctx.lineWidth = Math.max(1.8, step * 0.07);
        ctx.beginPath(); ctx.arc(mx, my, r * 0.62, 0, Math.PI * 2); ctx.stroke();
        if (!occupied) { ctx.beginPath(); ctx.arc(mx, my, r * 0.23, 0, Math.PI * 2); ctx.fill(); }
      } else if (mk.type === 'ai') {
        ctx.strokeStyle = 'rgba(47,125,225,0.85)';
        ctx.lineWidth = Math.max(1.4, step * 0.05);
        ctx.setLineDash([step * 0.14, step * 0.1]);
        ctx.beginPath(); ctx.arc(mx, my, r * 0.78, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
      }
      if (mk.label) {
        var fs = Math.max(10, Math.round(step * 0.42));
        ctx.font = '600 ' + fs + 'px system-ui, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        var lx = mx, ly = my;
        if (occupied) {
          ctx.fillStyle = 'rgba(255,255,255,0.9)';
          ctx.beginPath(); ctx.arc(lx, ly, fs * 0.62, 0, Math.PI * 2); ctx.fill();
        }
        ctx.fillStyle = occupied ? '#1b1b1b' : '#b3381f';
        ctx.fillText(String(mk.label), lx, ly + 0.5);
      }
    }
  };

  NS.Board = {
    Position: Position, Board: Board,
    positionBefore: positionBefore
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
