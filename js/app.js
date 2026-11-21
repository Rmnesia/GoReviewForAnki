/* GoReview.App — UI wiring, review flow, three-step practice */
(function (root) {
  'use strict';
  var NS = root.GoReview;
  var SGF = NS.SGF, BM = NS.Board, Review = NS.Review, SRS = NS.SRS, Store = NS.Store;

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function num(v, dflt) { var n = parseFloat(v); return isFinite(n) ? n : dflt; }
  function int(v, dflt) { var n = parseInt(v, 10); return isFinite(n) ? n : dflt; }

  var board = null, previewBoard = null, memoBoard = null;
  var problems = [], problemById = {}, gamesByKey = {};
  var sessionQueue = [];
  var practice = null;
  var lesson = null, lessonTimer = null;
  var memo = null;   // 当前背谱状态（名局背谱，独立于 SRS）
  var mode = 'idle'; // idle | review | preview | result | memo
  var currentId = null;
  var toastTimer = null;

  /* ---------------- small helpers ---------------- */

  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.add('hidden'); }, 2600);
  }

  // An occupied intersection is not a legal move. The Board already blocks
  // such clicks; this is a second guard in case a handler is called directly.
  function occupiedAt(pos, x, y) {
    return !!(pos && pos.board && pos.board[y * pos.size + x] !== 0);
  }

  function notifyOccupied() {
    toast('这里已有棋子，点不了（不计错）');
  }

  function showPanel(id) {
    ['idlePanel', 'studyPanel', 'previewPanel', 'resultPanel', 'memoPanel'].forEach(function (p) {
      $(p).classList.toggle('hidden', p !== id);
    });
    // canvases hidden at construct time report clientWidth 0 -> redraw once visible
    setTimeout(function () {
      if (board) board.render();
      if (previewBoard) previewBoard.render();
      if (memoBoard) memoBoard.render();
    }, 0);
  }

  function today() { return new Date().toISOString().slice(0, 10); }

  function settings() { return Store.get().settings; }

  function gameFor(p) { return gamesByKey[p.gameId]; }

  /* ---------------- settings <-> UI ---------------- */

  function loadSettingsToUI() {
    var s = settings();
    $('setLearner').value = s.learnerId || '';
    $('setOpeningEnd').value = s.openingEnd;
    $('setMiddleEnd').value = s.middleEnd;
    $('setThOpening').value = s.thresholds.opening;
    $('setThMiddle').value = s.thresholds.middle;
    $('setThEndgame').value = s.thresholds.endgame;
    $('setPvSteps').value = s.pvSteps;
    $('setRateEasy').value = s.rating.easyMax;
    $('setRateGood').value = s.rating.goodMax;
    $('setRateHard').value = s.rating.hardMax;
    $('setMerge').checked = !!s.mergeConsecutive;
    $('setMergeBasis').value = s.mergeBasis;
    $('setMergeDistance').value = s.mergeDistance;
  }

  function saveSettingsFromUI() {
    var op = Math.max(1, int($('setOpeningEnd').value, 50));
    var mid = Math.max(op + 1, int($('setMiddleEnd').value, 150));
    Store.setSettings({
      learnerId: $('setLearner').value.trim(),
      openingEnd: op,
      middleEnd: mid,
      thresholds: {
        opening: Math.max(0, num($('setThOpening').value, 2)),
        middle: Math.max(0, num($('setThMiddle').value, 5)),
        endgame: Math.max(0, num($('setThEndgame').value, 3))
      },
      pvSteps: Math.max(1, Math.min(5, int($('setPvSteps').value, 3))),
      rating: {
        easyMax: Math.max(0, int($('setRateEasy').value, 0)),
        goodMax: Math.max(0, int($('setRateGood').value, 1)),
        hardMax: Math.max(0, int($('setRateHard').value, 2))
      },
      mergeConsecutive: $('setMerge').checked,
      mergeBasis: $('setMergeBasis').value,
      mergeDistance: Math.max(0, Math.min(6, int($('setMergeDistance').value, 0)))
    });
    refresh();
  }

  /* ---------------- main refresh ---------------- */

  function refresh() {
    var st = Store.get(), s = st.settings;

    // learner id may have changed -> recompute colour from PB/PW (filename fallback)
    st.games.forEach(function (g) {
      var ids = SGF.idsFromFilename(g.filename) || {};
      var b = g.pb || ids.black || '', w = g.pw || ids.white || '';
      g.playerColor = s.learnerId && b === s.learnerId ? 'B'
                    : (s.learnerId && w === s.learnerId ? 'W' : null);
    });

    var res = Review.collectProblems(st.games, s);
    problems = res.problems;
    problemById = {}; gamesByKey = {};
    problems.forEach(function (p) { problemById[p.id] = p; });
    st.games.forEach(function (g) { gamesByKey[Review.gameId(g)] = g; });

    renderStats(res.notes);
    renderGameList();
    renderSummary();
    renderNotes(res.notes);
    renderProblemTable();
    renderMemoSource();
    updateIdle();
  }

  function renderStats() {
    var st = Store.get();
    var c = SRS.counts(problems, st.cards, st.deletedIds, Date.now());
    $('statGames').textContent = st.games.length;
    $('statProblems').textContent = c.total;
    $('statDue').textContent = c.due + c.fresh;
    $('statToday').textContent = st.stats.day === today() ? st.stats.dayReviews : 0;
    $('studyTitle').textContent = mode === 'memo' ? '名局背谱' : '复习';
    $('queueInfo').textContent = mode === 'memo'
      ? '不进 SRS · 自主练习'
      : '待复习 ' + (c.due + c.fresh) + ' 张';
    $('problemCount').textContent = problems.length + ' 条';
  }

  function renderGameList() {
    var st = Store.get(), box = $('gameList');
    if (!st.games.length) { box.innerHTML = ''; return; }
    box.innerHTML = st.games.map(function (g) {
      var ok = !!g.playerColor;
      var data = g.moves.filter(function (m) { return m.loss !== null; }).length;
      var pill = !ok ? '<span class="pill bad">id 未匹配</span>'
        : (data ? '<span class="pill ok">' + (g.playerColor === 'B' ? '执黑' : '执白') + ' · ' + data + ' 手有数据</span>'
                : '<span class="pill warn">无分析数据</span>');
      var kt = g.hasKT ? 'KT' : '仅注释';
      return '<div class="game-row"><span class="gname" title="' + esc(g.filename) + '">' + esc(g.filename) + '</span>' +
        '<span class="gmeta">' + g.moves.length + ' 手 · ' + kt + '</span>' + pill + '</div>';
    }).join('');
  }

  function renderSummary() {
    var s = Review.summarize(problems);
    $('summary').innerHTML =
      '<div class="sitem">开局<b>' + s.opening + '</b></div>' +
      '<div class="sitem">中盘<b>' + s.middle + '</b></div>' +
      '<div class="sitem">官子<b>' + s.endgame + '</b></div>' +
      '<div class="sitem">平均目差<b>' + s.lossAvg.toFixed(1) + '</b></div>' +
      '<div class="sitem">最大目差<b>' + s.lossMax.toFixed(1) + '</b></div>' +
      '<div class="sitem">合并掉<b>' + s.mergedCount + '</b> 手</div>';
  }

  function renderNotes(notes) {
    var box = $('notes');
    if (!notes || !notes.length) { box.innerHTML = ''; return; }
    box.innerHTML = notes.slice(0, 8).map(function (n) {
      return '<div class="nitem">' + esc(n.text) + '</div>';
    }).join('');
  }

  function renderProblemTable() {
    var st = Store.get(), now = Date.now(), body = $('problemBody');
    if (!problems.length) {
      body.innerHTML = '<tr class="empty-row"><td colspan="7">暂无问题手 — 试着调低目差阈值或导入更多棋谱</td></tr>';
      return;
    }
    body.innerHTML = problems.map(function (p) {
      var c = st.cards[p.id];
      var status, cls = '';
      if (st.deletedIds.indexOf(p.id) >= 0) { status = '已删除'; cls = 'muted'; }
      else if (!c || !c.reps) status = '新卡';
      else if (c.due <= now) status = '待复习';
      else status = '已学 ' + c.reps + ' 次';
      return '<tr data-id="' + esc(p.id) + '" class="' + (currentId === p.id ? 'active' : '') + '">' +
        '<td title="' + esc(p.filename) + '">' + p.ply + '</td>' +
        '<td class="stage">' + Review.stageName(p.stage) + '</td>' +
        '<td class="loss">' + p.loss.toFixed(1) + '</td>' +
        '<td>' + esc(p.gtp || 'pass') + '</td>' +
        '<td>' + esc(p.best || '—') + '</td>' +
        '<td class="muted">' + (p.merged.length ? '+' + p.merged.length : '—') + '</td>' +
        '<td class="' + cls + '">' + status + '</td>' +
        '</tr>';
    }).join('');
    Array.prototype.forEach.call(body.querySelectorAll('tr[data-id]'), function (tr) {
      tr.addEventListener('click', function () {
        var p = problemById[tr.getAttribute('data-id')];
        if (p) previewProblem(p);
      });
    });
  }

  function updateIdle() {
    var st = Store.get();
    var c = SRS.counts(problems, st.cards, st.deletedIds, Date.now());
    var title = '', text = '';
    if (!st.games.length) {
      title = '还没有导入棋谱';
      text = '点「AI 分析（网页端）」生成分析数据，或导入已有 SGF，调整阈值后即可开始。';
    } else if (!problems.length) {
      title = currentId ? '本轮复习完成' : '当前阈值下没有问题手';
      text = currentId ? '所有卡片都已处理，明天再来复习吧。' : '试着调低三阶段的目差阈值，或检查学习方 id 是否正确。';
    } else if (c.due + c.fresh === 0) {
      title = '今日卡片已完成';
      text = '还有 ' + c.suspended + ' 张卡片未到期，到期后会自动回到队列。';
    } else {
      title = '准备开始复习';
      text = '共 ' + c.due + ' 张到期 + ' + c.fresh + ' 张新卡，按间隔重复安排。';
    }
    $('idleTitle').textContent = title;
    $('idleText').textContent = text;
    $('btnStartReview').disabled = (c.due + c.fresh) === 0;
    $('btnStartReview').textContent = (c.due + c.fresh) ? '开始复习（' + (c.due + c.fresh) + ' 张）' : '暂无待复习卡片';
  }

  /* ---------------- import ---------------- */

  async function importTexts(items) {
    if (!items.length) { toast('没有可导入的 SGF'); return; }
    var st = Store.get(), map = Object.create(null);
    st.games.forEach(function (g) { map[g.filename] = g; });
    var added = 0, errs = [], warns = [];
    for (var i = 0; i < items.length; i++) {
      try {
        var g = await SGF.buildGame(items[i].text, items[i].name, settings().learnerId);
        map[g.filename] = g;
        added++;
        if (g.warning) warns.push(g.filename + '：' + g.warning);
      } catch (e) {
        errs.push(items[i].name + '：' + (e && e.message || e));
      }
    }
    Store.setGames(Object.keys(map).map(function (k) { return map[k]; }));
    refresh();

    var note = '已导入 ' + added + ' 个棋谱（共 ' + Object.keys(map).length + ' 个）。';
    if (warns.length) {
      note += ' ⚠ ' + warns.length + ' 个棋谱缺少完整分析数据：' + esc(warns[0]) +
        '。请点「AI 分析（网页端）」或运行 node tools/analyze.js 生成完整分析。';
    }
    if (errs.length) note += ' 失败 ' + errs.length + ' 个：' + esc(errs[0]);
    $('importNote').className = 'import-note' + (warns.length || errs.length ? ' warn' : '');
    $('importNote').innerHTML = note;
    toast('导入完成：' + added + ' 个棋谱');
  }

  async function importFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []).filter(function (f) { return /\.sgf$/i.test(f.name); });
    if (!files.length) { toast('未找到 .sgf 文件'); return; }
    var items = [];
    for (var i = 0; i < files.length; i++) {
      items.push({ name: files[i].name, text: await files[i].text() });
    }
    await importTexts(items);
  }

  async function loadGenerated(names) {
    var note = $('importNote');
    if (location.protocol === 'file:') {
      note.className = 'import-note warn';
      note.textContent = '「载入分析结果」需要本地服务：请运行 node tools/serve.js 后访问 http://127.0.0.1:8000；或直接用「导入文件夹」选择 sgfout/ 目录。';
      return;
    }
    try {
      var url = '/api/generated' + (names && names.length ? '?names=' + encodeURIComponent(names.join('|')) : '');
      var r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var j = await r.json();
      if (!j.count) {
        note.className = 'import-note warn';
        note.textContent = 'sgfout/ 里还没有分析结果。请点「AI 分析（网页端）」生成，或运行 node tools/analyze.js。';
        toast('还没有分析结果');
        return;
      }
      await importTexts(j.files.map(function (f) { return { name: f.name, text: f.text }; }));
    } catch (e) {
      note.className = 'import-note warn';
      note.textContent = '无法读取本地分析结果：' + esc(e && e.message || e) +
        '。请确认是通过 node tools/serve.js 启动的页面。';
    }
  }

  /* ---------------- web-side AI analysis ---------------- */

  var anTimer = null, anLoaded = false, anPanelReady = false;

  function anSelected() {
    return Array.prototype.slice.call(document.querySelectorAll('#anFiles input:checked'))
      .map(function (cb) { return cb.value; });
  }

  function renderAnLog(lines) {
    var box = $('anLog');
    box.textContent = (lines || []).slice(-60).join('\n');
    box.scrollTop = box.scrollHeight;
  }

  function renderAnStatus(s) {
    var total = s.total || 0;
    var pct = total ? Math.min(100, Math.round((s.done + (s.failed || 0)) / total * 100))
      : (s.finishedAt ? 100 : 0);
    $('anBar').style.width = pct + '%';
    var text;
    if (s.running) {
      text = '分析中 ' + s.done + '/' + total + ' 局面 · ' + (s.rate || 0).toFixed(1) + '/s' +
        (s.eta ? ' · 预计剩余 ' + s.eta + 's' : '') + ' · 已生成 ' + (s.outputs || []).length + ' 份';
    } else if (s.error) text = '出错：' + s.error;
    else if (s.finishedAt) text = (s.cancelled ? '已停止' : '完成') + '：' + s.done +
      ' 个局面，失败 ' + (s.failed || 0) + ' 个，用时 ' + (s.seconds || 0).toFixed(1) +
      's，生成 ' + (s.outputs || []).length + ' 份棋谱';
    else text = '尚未开始（只会分析勾选的棋谱）';
    $('anStatus').textContent = text;
    $('btnAnalyzeStart').disabled = !!s.running;
    $('btnAnalyzeStop').disabled = !s.running;
    if (s.logs) renderAnLog(s.logs);
  }

  function renderAnFiles(files, keep) {
    var prev = {}, any = false;
    if (keep) {
      Array.prototype.slice.call(document.querySelectorAll('#anFiles input')).forEach(function (cb) {
        prev[cb.value] = cb.checked;
        if (cb.checked) any = true;
      });
    }
    $('anFiles').innerHTML = files.map(function (f, i) {
      var checked = any ? !!prev[f.name] : i === 0;
      var cls = f.error ? 'bad' : (f.total && f.cached >= f.total ? 'ok' : (f.cached ? 'warn' : 'bad'));
      var meta = f.error ? '读取失败' : (f.moves + ' 手 · 缓存 ' + f.cached + '/' + f.total);
      return '<label class="an-file"><input type="checkbox" value="' + esc(f.name) + '"' +
        (checked ? ' checked' : '') + (f.error ? ' disabled' : '') + '>' +
        '<span class="gname" title="' + esc(f.name) + '">' + esc(f.name) + '</span>' +
        '<span class="gmeta">' + esc(meta) + '</span>' +
        '<span class="pill ' + cls + '">' + (f.generated ? '已生成' : '待分析') + '</span></label>';
    }).join('') || '<div class="an-note">没有找到待分析棋谱（检查 E:\\Katrain\\sgf）。</div>';
  }

  async function refreshSourceGames() {
    if (location.protocol === 'file:') {
      $('anEngine').className = 'pill bad';
      $('anEngine').textContent = '需要本地服务';
      return;
    }
    try {
      var r = await fetch('/api/source-games?visits=' + int($('anVisits').value, 100), { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var j = await r.json();
      $('anEngine').className = 'pill ' + (j.available ? 'ok' : 'bad');
      $('anEngine').textContent = j.available ? 'KataGo 就绪' : (j.hint || '引擎不可用');
      renderAnFiles(j.files, anPanelReady);
      anPanelReady = true;
    } catch (e) {
      $('anEngine').className = 'pill bad';
      $('anEngine').textContent = '需 node tools/serve.js';
      $('anFiles').innerHTML = '<div class="an-note">无法连接分析服务：' + esc(e.message) +
        '。请用 <code>node tools/serve.js</code> 启动后再打开本页。</div>';
    }
  }

  async function pollAnalysis(autoLoad) {
    if (location.protocol === 'file:') return;
    try {
      var r = await fetch('/api/analyze/status', { cache: 'no-store' });
      if (!r.ok) return;
      var s = await r.json();
      renderAnStatus(s);
      if (autoLoad && !s.running && (s.finishedAt || s.error)) {
        clearInterval(anTimer); anTimer = null;
        if (!anLoaded) {
          anLoaded = true;
          if (!s.error && s.outputs && s.outputs.length) {
            await loadGenerated(s.outputs);
            toast('分析完成，已载入 ' + s.outputs.length + ' 份棋谱');
          }
          refreshSourceGames();
        }
      }
    } catch (e) { /* service unavailable */ }
  }

  function startAnPolling() {
    clearInterval(anTimer);
    anTimer = setInterval(function () { pollAnalysis(true); }, 1000);
  }

  async function startAnalysis() {
    if (location.protocol === 'file:') { toast('网页端分析需要本地服务：node tools/serve.js'); return; }
    var names = anSelected();
    if (!names.length) { toast('请至少勾选一个棋谱'); return; }
    var body = {
      files: names,
      visits: int($('anVisits').value, 100),
      threads: int($('anThreads').value, 6),
      limit: Math.max(0, int($('anLimit').value, 0)),
      force: $('anForce').checked,
      comments: true
    };
    $('btnAnalyzeStart').disabled = true;
    try {
      var r = await fetch('/api/analyze', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      var j = await r.json();
      if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
      anLoaded = false;
      renderAnStatus(j);
      startAnPolling();
      pollAnalysis(true);
      toast('已启动 ' + names.length + ' 局分析');
    } catch (e) {
      $('btnAnalyzeStart').disabled = false;
      $('anStatus').textContent = '启动失败：' + e.message;
      toast('启动失败：' + e.message);
    }
  }

  async function stopAnalysis() {
    try { await fetch('/api/analyze/stop', { method: 'POST' }); } catch (e) { /* ignore */ }
    pollAnalysis(true);
  }

  /* ---------------- practice ---------------- */

  function cardInfoHTML(p) {
    return '<span class="cname" title="' + esc(p.filename) + '">' + esc(p.filename) + '</span>' +
      '<span>第 <b>' + p.ply + '</b> 手</span>' +
      '<span>阶段 <b>' + Review.stageName(p.stage) + '</b></span>' +
      '<span>执 <b>' + (p.color === 'B' ? '黑' : '白') + '</b></span>' +
      '<span class="badge loss">目差 ' + p.loss.toFixed(1) + ' 目</span>' +
      '<span class="badge">阈值 ' + p.threshold + ' 目</span>' +
      (p.merged.length ? '<span class="badge">合并 +' + p.merged.length + ' 手</span>' : '');
  }

  function startPractice(p) {
    var g = gameFor(p);
    if (!g) { nextCard(); return; }
    var pos0 = BM.positionBefore(g, p.ply, g.size);
    var seq = Review.buildSequence(pos0, p, g.playerColor, settings().pvSteps);
    practice = {
      p: p, game: g, learner: g.playerColor, opp: g.playerColor === 'B' ? 'W' : 'B',
      pos: pos0.clone(), seq: seq, step: 0, mistakes: 0, marks: [], done: false
    };
    currentId = p.id;
    mode = 'review';
    showPanel('studyPanel');
    board.hoverEnabled = true;
    board.hoverColor = practice.learner;
    board.setPosition(practice.pos);
    renderPractice('悬浮可先确认要落子的格子，点击后再落子。下出学习方的正确一手。', '');
    $('cardInfo').innerHTML = cardInfoHTML(p);
  }

  function renderPractice(msg, kind) {
    if (!practice) return;
    var n = practice.seq.n;
    $('progressBar').style.width = Math.round(practice.step / n * 100) + '%';
    $('stepInfo').textContent = '第 ' + Math.min(practice.step + 1, n) + ' / ' + n + ' 步';
    $('mistakeInfo').textContent = '错误 ' + practice.mistakes + ' 次';
    $('pvInfo').textContent = practice.seq.truncated
      ? 'AI 变化不足，本题只练 ' + n + ' 步'
      : 'AI 预测变化 ' + practice.seq.pvLength + ' 手';
    var tip = $('tipText');
    tip.textContent = msg;
    tip.className = 'tip-text' + (kind ? ' ' + kind : '');
    renderProblemTable();
  }

  function onBoardClick(x, y, gtp) {
    if (mode !== 'review' || !practice || practice.done) return;
    if (occupiedAt(practice.pos, x, y)) { notifyOccupied(); return; }
    var exp = practice.seq.expected[practice.step];
    if (!exp) return;
    if (String(gtp).toUpperCase() === String(exp).toUpperCase()) {
      practice.pos.playGtp(practice.learner, exp);
      var xy = SGF.gtpToXY(exp, practice.game.size);
      if (xy) practice.marks.push({ x: xy.x, y: xy.y, type: 'num', label: String(practice.step + 1) });
      var ai = practice.seq.replies[practice.step];
      if (practice.step < practice.seq.n - 1 && ai) practice.pos.playGtp(practice.opp, ai);
      practice.step++;
      board.setPosition(practice.pos);
      board.setMarks(practice.marks);
      if (practice.step >= practice.seq.n) {
        $('progressBar').style.width = '100%';
        finishPractice();
      } else {
        renderPractice('正确！AI 已应对，继续下出我方第 ' + (practice.step + 1) + ' 手。', 'ok');
      }
    } else {
      // Wrong answer: DO NOT reset the step. Stay here and count the mistake.
      practice.mistakes++;
      board.setMarks(practice.marks.concat([{ x: x, y: y, type: 'wrong' }]));
      renderPractice('不对，再想想 —— 仍停在第 ' + (practice.step + 1) + ' 步，不会从头开始。', 'bad');
      var snapshot = practice;
      setTimeout(function () {
        if (mode === 'review' && practice === snapshot && !practice.done) board.setMarks(practice.marks);
      }, 750);
    }
  }

  function finishPractice() {
    practice.done = true;
    var p = practice.p;
    var rating = SRS.rate(practice.mistakes, settings().rating);
    var res = SRS.schedule(Store.getCard(p.id), rating, Date.now());
    Store.setCard(p.id, res.card);
    Store.bumpReview();
    if (rating === 'again') sessionQueue.push(p.id); // reappear later in this session

    mode = 'result';
    showPanel('resultPanel');
    var rr = $('resultRating');
    rr.textContent = SRS.LABEL[rating];
    rr.style.color = SRS.COLOR[rating];
    rr.style.background = SRS.COLOR[rating] + '18';
    $('resultDetail').innerHTML =
      '累计下错 <b>' + practice.mistakes + '</b> 次 · 连续下对 <b>' + practice.seq.n + '</b> 手<br>' +
      '评级 <b>' + SRS.LABEL[rating] + '</b>，下次复习：<b>' + res.text + '</b> 后' +
      (rating === 'again' ? '（本轮稍后会再次出现）' : '') +
      '<br><span style="font-size:12px;color:#96a1b2">熟练度 ease ' + res.card.ease.toFixed(2) +
      ' · 已复习 ' + res.card.reviews + ' 次</span>';
    renderStats();
    renderProblemTable();
    updateIdle();
  }

  function startReview() {
    var st = Store.get();
    var q = SRS.buildQueue(problems, st.cards, st.deletedIds, Date.now());
    if (!q.length) { toast('当前没有待复习卡片'); return; }
    sessionQueue = q.map(function (p) { return p.id; });
    currentId = null;
    nextCard();
  }

  function nextCard() {
    while (sessionQueue.length) {
      var id = sessionQueue.shift();
      var st = Store.get();
      if (st.deletedIds.indexOf(id) >= 0) continue;
      var p = problemById[id];
      if (!p) continue; // filtered out by a threshold change
      startPractice(p);
      return;
    }
    mode = 'idle';
    practice = null;
    currentId = 'done';
    showPanel('idlePanel');
    updateIdle();
    renderProblemTable();
  }

  function deleteCurrent() {
    var id = currentId;
    if (!id || !problemById[id]) { toast('当前没有可删除的卡片'); return; }
    Store.deleteCard(id);
    sessionQueue = sessionQueue.filter(function (x) { return x !== id; });
    practice = null;
    refresh();
    toast('已删除该卡片，之后不再出现');
    if (mode === 'review' || mode === 'result') nextCard();
    else { mode = 'idle'; showPanel('idlePanel'); updateIdle(); }
  }

  /* ---------------- preview: click to learn the AI's next three moves ---------------- */

  function staticLessonText() {
    $('lessonInfo').textContent = '蓝圈 = AI 正解，红叉 = 实战落点。点击左侧列表可切换预览。';
    $('lessonTip').className = 'tip-text';
    $('lessonTip').textContent = '直接点击棋盘即可跟练 AI 教的三步；也可点下方按钮开始或自动演示。悬浮会先高亮要落子的格子与坐标。';
  }

  function stopLessonDemo() { clearInterval(lessonTimer); lessonTimer = null; }

  function clearLesson() {
    stopLessonDemo();
    lesson = null;
    previewBoard.interactive = true;
    previewBoard.hoverEnabled = true;
    previewBoard.onClick = onPreviewBoardClick;
  }

  // Clicking the preview board itself starts the three-step AI lesson.
  function onPreviewBoardClick(x, y, gtp) {
    if (!lesson) { startLesson(); return; }
    onPreviewClick(x, y, gtp);
  }

  function renderLesson(msg, kind) {
    if (!lesson) return;
    var n = lesson.seq.n;
    var seqText = lesson.seq.expected.map(function (gtp, i) {
      return (i + 1) + '.' + gtp + (lesson.seq.replies[i] ? ' / ' + lesson.seq.replies[i] : '');
    }).join('   ');
    $('lessonInfo').innerHTML = '<b>AI 教学</b> · 第 <b>' + Math.min(lesson.step + 1, n) + ' / ' + n +
      '</b> 步' + (lesson.done ? ' <span class="done">✓ 已学完</span>' : '') +
      '<br><span class="seq">' + esc(seqText) + '</span>' +
      (lesson.seq.truncated ? '<br>AI 变化不足，本题只演示 ' + n + ' 步。' : '');
    $('lessonTip').className = 'tip-text' + (kind ? ' ' + kind : '');
    $('lessonTip').textContent = msg;
  }

  function startLesson() {
    var p = problemById[currentId];
    var g = p && gameFor(p);
    if (!g) { toast('请先在左侧点选一个问题手'); return; }
    var pos0 = BM.positionBefore(g, p.ply, g.size);
    var seq = Review.buildSequence(pos0, p, g.playerColor, settings().pvSteps);
    lesson = {
      p: p, game: g, learner: g.playerColor,
      opp: g.playerColor === 'B' ? 'W' : 'B',
      pos0: pos0, pos: pos0.clone(), seq: seq,
      step: 0, marks: [], done: false
    };
    stopLessonDemo();
    previewBoard.interactive = true;
    previewBoard.hoverEnabled = true;
    previewBoard.hoverColor = lesson.learner;
    previewBoard.onClick = onPreviewBoardClick;
    previewBoard.setPosition(lesson.pos);
    previewBoard.setMarks([]);
    renderLesson('点击棋盘，点出 AI 教的第 1 手（悬浮可先确认格子与坐标）。', '');
  }

  function lessonPlay(gtp) {
    if (!lesson || lesson.done) return false;
    var i = lesson.step, exp = lesson.seq.expected[i];
    if (!exp || String(gtp).toUpperCase() !== String(exp).toUpperCase()) return false;
    lesson.pos.playGtp(lesson.learner, exp);
    var xy = SGF.gtpToXY(exp, lesson.game.size);
    if (xy) lesson.marks.push({ x: xy.x, y: xy.y, type: 'num', label: String(i + 1) });
    var reply = lesson.seq.replies[i];
    if (i < lesson.seq.n - 1 && reply) lesson.pos.playGtp(lesson.opp, reply);
    lesson.step++;
    previewBoard.setPosition(lesson.pos);
    previewBoard.setMarks(lesson.marks);
    if (lesson.step >= lesson.seq.n) {
      lesson.done = true;
      renderLesson('已学完 AI 教的 ' + lesson.seq.n + ' 步，可以重置再看一遍，或点「开始复习」正式练习。', 'ok');
    } else {
      renderLesson('正确！AI 已应对，继续点出第 ' + (lesson.step + 1) + ' 手。', 'ok');
    }
    return true;
  }

  function onPreviewClick(x, y, gtp) {
    if (mode !== 'preview' || !lesson) return;
    if (occupiedAt(lesson.pos, x, y)) { notifyOccupied(); return; }
    if (lessonPlay(gtp)) return;
    if (lesson.done) return;
    var exp = lesson.seq.expected[lesson.step];
    previewBoard.setMarks(lesson.marks.concat([{ x: x, y: y, type: 'wrong' }]));
    renderLesson('这里不是 AI 教的第 ' + (lesson.step + 1) + ' 手' +
      (exp ? '（应为 ' + exp + '）' : '') + '，看准悬浮格子再点一次。', 'bad');
    var snapshot = lesson;
    setTimeout(function () {
      if (mode === 'preview' && lesson === snapshot && !lesson.done) previewBoard.setMarks(lesson.marks);
    }, 800);
  }

  function demoLesson() {
    if (!lesson) startLesson();
    if (!lesson) return;
    stopLessonDemo();
    lessonTimer = setInterval(function () {
      if (!lesson || lesson.done) { stopLessonDemo(); return; }
      lessonPlay(lesson.seq.expected[lesson.step]);
    }, 800);
  }

  function resetLesson() {
    clearLesson();
    var p = problemById[currentId];
    if (p) previewProblem(p);
  }

  function previewProblem(p) {
    var g = gameFor(p);
    if (!g) return;
    clearLesson();
    currentId = p.id;
    mode = 'preview';
    previewBoard.hoverColor = g.playerColor;
    var pos = BM.positionBefore(g, p.ply, g.size);
    previewBoard.setPosition(pos);
    var marks = [], bxy = p.best ? SGF.gtpToXY(p.best, g.size) : null;
    if (bxy) marks.push({ x: bxy.x, y: bxy.y, type: 'hint', label: '✓' });
    var axy = SGF.gtpToXY(p.gtp, g.size);
    if (axy && (!bxy || axy.x !== bxy.x || axy.y !== bxy.y)) marks.push({ x: axy.x, y: axy.y, type: 'wrong' });
    previewBoard.setMarks(marks);
    $('previewInfo').innerHTML = cardInfoHTML(p) +
      '<span>实战 <b>' + esc(p.gtp || 'pass') + '</b></span><span>正解 <b>' + esc(p.best || '—') + '</b></span>' +
      (p.merged.length ? '<span>合并手数 <b>' + p.merged.join(', ') + '</b></span>' : '');
    staticLessonText();
    showPanel('previewPanel');
    renderProblemTable();
  }

  /* ---------------- 名局背谱（master games，与 SRS 完全独立） ---------------- */

  function renderMemoSource() {
    var sel = $('memoSource');
    if (!sel) return;
    var cur = sel.value, gs = Store.get().games;
    sel.innerHTML = gs.length
      ? gs.map(function (g) { return '<option value="' + esc(g.filename) + '">' + esc(g.filename) + '</option>'; }).join('')
      : '<option value="">（尚未导入棋谱，可用下方按钮直接选 .sgf 文件）</option>';
    if (cur && gs.some(function (g) { return g.filename === cur; })) sel.value = cur;
  }

  // 名局只保存落子序列，不需要目差 / AI 变化，也不随已导入棋谱被清空。
  function normalizeMaster(g) {
    return {
      id: g.filename,
      name: String(g.filename).replace(/\.sgf$/i, ''),
      filename: g.filename,
      size: g.size || 19,
      pb: g.pb || '', pw: g.pw || '',
      blackId: g.blackId || g.pb || '', whiteId: g.whiteId || g.pw || '',
      moves: g.moves.map(function (m) {
        return { ply: m.ply, color: m.color, sgf: m.sgf, gtp: m.gtp };
      }),
      note: '', addedAt: new Date().toISOString()
    };
  }

  async function memoAddSelected() {
    var fn = $('memoSource').value;
    var g = Store.get().games.filter(function (x) { return x.filename === fn; })[0];
    if (!g) { toast('请先导入棋谱，或改点「从 .sgf 文件收录」'); return; }
    if (!g.moves.length) { toast('该棋谱没有落子序列'); return; }
    var m = normalizeMaster(g);
    var r = Store.addMaster(m);
    renderMemoList(); renderMemoSource();
    toast(r.added ? '已收录为名局：' + m.name : '该棋谱已在名局库中，已刷新落子（保留名称与进度）');
  }

  async function memoAddFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []).filter(function (f) { return /\.sgf$/i.test(f.name); });
    if (!files.length) { toast('未找到 .sgf 文件'); return; }
    var added = 0, dup = 0, errs = [];
    for (var i = 0; i < files.length; i++) {
      try {
        var g = await SGF.buildGame(await files[i].text(), files[i].name, '');
        if (!g.moves.length) { errs.push(files[i].name + '（无落子）'); continue; }
        var r = Store.addMaster(normalizeMaster(g));
        if (r.added) added++; else dup++;
      } catch (e) {
        errs.push(files[i].name + '：' + (e && e.message || e));
      }
    }
    renderMemoList(); renderMemoSource();
    toast('收录完成：新增 ' + added + ' 局' + (dup ? '、更新 ' + dup + ' 局' : '') +
      (errs.length ? '，失败 ' + errs.length + ' 个（' + errs[0] + '）' : ''));
  }

  function memoProgressLabel(p) {
    if (!p) return '未开始';
    if (p.done) return '已背完 ✓';
    return '续背：第 ' + p.ply + ' 手';
  }

  function renderMemoList() {
    var st = Store.get(), box = $('memoList');
    $('memoCount').textContent = st.masters.length + ' 局';
    if (!st.masters.length) {
      box.innerHTML = '<div class="memo-empty">还没有名局。可从上方「☆ 收录选中棋谱」，或直接点「从 .sgf 文件收录」选任意 SGF（不需要 AI 分析数据）。</div>';
      return;
    }
    box.innerHTML = st.masters.map(function (m) {
      var p = Store.getMasterProgress(m.id);
      var resume = p && !p.done;
      var label = (p && p.done) ? '再背一遍' : (resume ? '继续背（第 ' + p.ply + ' 手）' : '开始背谱');
      return '<div class="memo-item" data-id="' + esc(m.id) + '">' +
        '<div class="memo-top">' +
          '<input class="memo-name" data-act="name" value="' + esc(m.name) + '" title="点击可直接改名">' +
          '<button class="btn ghost danger" data-act="del" title="从名局库删除">删除</button>' +
        '</div>' +
        '<div class="memo-meta">黑 ' + esc(m.blackId || '?') + ' / 白 ' + esc(m.whiteId || '?') +
          ' · ' + m.moves.length + ' 手 · ' +
          '<span class="pill memo">' + memoProgressLabel(p) + '</span>' +
          (m.note ? '<br>备注：' + esc(m.note) : '') + '</div>' +
        '<div class="memo-ops">' +
          '<button class="btn primary" data-act="start">' + label + '</button>' +
          (resume ? '<button class="btn" data-act="restart">从头背</button>' : '') +
          '<button class="btn ghost" data-act="note">备注</button>' +
          (p ? '<button class="btn ghost" data-act="clear">清除进度</button>' : '') +
        '</div></div>';
    }).join('');

    Array.prototype.forEach.call(box.querySelectorAll('.memo-item'), function (item) {
      var id = item.getAttribute('data-id');
      var nameInput = item.querySelector('[data-act=name]');
      nameInput.addEventListener('change', function () {
        var v = nameInput.value.trim();
        Store.updateMaster(id, { name: v || '未命名名局' });
        renderMemoList(); toast('名称已保存');
      });
      Array.prototype.forEach.call(item.querySelectorAll('button[data-act]'), function (b) {
        b.addEventListener('click', function () {
          var act = b.getAttribute('data-act');
          var m = Store.get().masters.filter(function (x) { return x.id === id; })[0];
          if (!m) return;
          if (act === 'del') {
            if (!confirm('从名局库删除「' + m.name + '」？该局背谱进度也会一并清除。')) return;
            Store.removeMaster(id);
            if (memo && memo.master.id === id) { memo = null; backFromMemo(); }
            else renderMemoList();
            toast('已删除该名局');
          } else if (act === 'start') {
            var pg = Store.getMasterProgress(id);
            startMemo(id, !!(pg && pg.done));
          } else if (act === 'restart') {
            startMemo(id, true);
          } else if (act === 'note') {
            var v = prompt('给「' + m.name + '」写个备注（可留空）：', m.note || '');
            if (v !== null) { Store.updateMaster(id, { note: v.trim() }); renderMemoList(); }
          } else if (act === 'clear') {
            Store.clearMasterProgress(id); renderMemoList(); toast('已清除该局背谱进度');
          }
        });
      });
    });
  }

  function memoParams() {
    return {
      color: $('memoColor').value === 'W' ? 'W' : 'B',
      from: Math.max(1, int($('memoFrom').value, 1)),
      to: Math.max(0, int($('memoTo').value, 0))
    };
  }

  function memoMoveAt(ply) { return memo ? (memo.master.moves[ply - 1] || null) : null; }

  function currentMemoIsPass() {
    if (!memo || memo.done) return false;
    var mv = memoMoveAt(memo.ply);
    return !!(mv && mv.color === memo.color && SGF.isPassGtp(mv.gtp));
  }

  function saveMemoProgress() {
    if (!memo) return;
    Store.setMasterProgress(memo.master.id, {
      color: memo.color, from: memo.from, to: memo.to,
      ply: memo.ply, mistakes: memo.mistakes, hints: memo.hints,
      done: !!memo.done, updatedAt: new Date().toISOString()
    });
  }

  function renderMemo(msg, kind) {
    if (!memo) return;
    var span = Math.max(1, memo.to - memo.from + 1);
    var doneCnt = Math.max(0, Math.min(span, memo.ply - memo.from));
    $('memoProgressBar').style.width = Math.round(doneCnt / span * 100) + '%';
    $('memoInfo').innerHTML =
      '<span class="cname" title="' + esc(memo.master.name) + '">' + esc(memo.master.name) + '</span>' +
      '<span>第 <b>' + Math.min(memo.ply, memo.to) + '</b> / ' + memo.to + ' 手</span>' +
      '<span>执 <b>' + (memo.color === 'B' ? '黑' : '白') + '</b> 背谱</span>' +
      '<span class="badge">区间 ' + memo.from + '–' + memo.to + '</span>' +
      '<span class="badge">全谱 ' + memo.N + ' 手</span>' +
      '<span>黑 <b>' + esc(memo.master.blackId || '?') + '</b></span>' +
      '<span>白 <b>' + esc(memo.master.whiteId || '?') + '</b></span>';
    $('memoStep').textContent = memo.done ? '已背完' : ('第 ' + memo.ply + ' 手');
    $('memoMistakes').textContent = '点错 ' + memo.mistakes + ' 次';
    $('memoHints').textContent = '提示 ' + memo.hints + ' 次';
    var tip = $('memoTip');
    tip.textContent = msg;
    tip.className = 'tip-text' + (kind ? ' ' + kind : '');
    $('btnMemoHint').disabled = !!memo.done;
    $('btnMemoPass').disabled = !!memo.done || !currentMemoIsPass();
    $('memoDone').classList.toggle('hidden', !memo.done);
  }

  // 对弈式：自动摆出对手的每一手，直到轮到我方（或超出区间）才停下等点击。
  function advanceOpponent(initial) {
    if (!memo) return;
    while (!memo.done && memo.ply <= memo.to) {
      var mv = memoMoveAt(memo.ply);
      if (!mv) { memo.ply++; continue; }
      if (mv.color === memo.color) break;
      memo.pos.play(mv.color, SGF.sgfToXY(mv.sgf, memo.pos.size), mv.gtp);
      memo.ply++;
    }
    if (memo.ply > memo.to) { finishMemo(); return; }
    memoBoard.setPosition(memo.pos);
    memoBoard.setMarks(memo.marks.concat(memo.hintMark ? [memo.hintMark] : []));
    var isPass = currentMemoIsPass();
    renderMemo(isPass
      ? '第 ' + memo.ply + ' 手原谱是虚着（pass），点「本手 Pass」继续。'
      : (initial
          ? '已摆好前 ' + (memo.ply - 1) + ' 手。轮到你执' + (memo.color === 'B' ? '黑' : '白') + '，点出第 ' + memo.ply + ' 手。'
          : '对手已应对，继续点出第 ' + memo.ply + ' 手。'),
      initial ? '' : 'ok');
    saveMemoProgress();
  }

  function finishMemo() {
    memo.done = true;
    memoBoard.setPosition(memo.pos);
    memoBoard.setMarks([]);
    $('memoProgressBar').style.width = '100%';
    var myMoves = memo.master.moves.filter(function (mv) {
      return mv.color === memo.color && mv.ply >= memo.from && mv.ply <= memo.to;
    }).length;
    renderMemo('已背完第 ' + memo.from + '–' + memo.to + ' 手，干得漂亮。', 'ok');
    $('memoDone').innerHTML =
      '<b>✓ 背谱完成</b><br>' +
      '区间第 ' + memo.from + '–' + memo.to + ' 手 · 执' + (memo.color === 'B' ? '黑' : '白') +
      ' 共下 <b>' + myMoves + '</b> 手<br>' +
      '点错 <b>' + memo.mistakes + '</b> 次 · 提示 <b>' + memo.hints + '</b> 次' +
      '<br><span style="font-size:11.5px;color:#5b7a68">仅作记录，不评级、不进 SRS。</span>' +
      '<div class="btn-row tiny">' +
        '<button class="btn primary" id="btnMemoAgain">再背一遍</button>' +
        '<button class="btn ghost" id="btnMemoBack2">返回名局库</button>' +
      '</div>';
    $('btnMemoAgain').addEventListener('click', function () { startMemo(memo.master.id, true); });
    $('btnMemoBack2').addEventListener('click', backFromMemo);
    saveMemoProgress();
    renderMemoList();
  }

  function startMemo(id, forceRestart) {
    var m = Store.get().masters.filter(function (x) { return x.id === id; })[0];
    if (!m) { toast('该名局已不存在'); return; }
    var prm = memoParams(), N = m.moves.length;
    if (prm.from > N) { toast('起手超过该局总手数（' + N + ' 手）'); return; }
    var to = prm.to > 0 ? Math.min(N, prm.to) : N;
    to = Math.max(prm.from, to);

    var saved = forceRestart ? null : Store.getMasterProgress(id);
    var reuse = saved && !saved.done && saved.color === prm.color &&
      saved.from === prm.from && saved.to === to;
    var ply = reuse ? Math.max(prm.from, Math.min(to, int(saved.ply, prm.from))) : prm.from;

    var pos = new BM.Position(m.size || 19);
    for (var i = 0; i < m.moves.length && m.moves[i].ply < ply; i++) {
      var mv = m.moves[i];
      pos.play(mv.color, SGF.sgfToXY(mv.sgf, pos.size), mv.gtp);
    }

    memo = {
      master: m, color: prm.color, from: prm.from, to: to, N: N,
      pos: pos, ply: ply,
      mistakes: reuse ? (saved.mistakes || 0) : 0,
      hints: reuse ? (saved.hints || 0) : 0,
      learned: 0, done: false, marks: [], hintMark: null
    };
    mode = 'memo';
    currentId = null;
    renderStats();
    showPanel('memoPanel');
    memoBoard.interactive = true;
    memoBoard.hoverEnabled = true;
    memoBoard.hoverColor = prm.color;
    memoBoard.onClick = onMemoBoardClick;
    memoBoard.setPosition(pos);
    memoBoard.setMarks([]);
    saveMemoProgress();
    toast('开始背谱：执' + (prm.color === 'B' ? '黑' : '白') + '，第 ' + prm.from + '–' + to + ' 手' +
      (reuse ? '（从第 ' + ply + ' 手续背）' : ''));
    advanceOpponent(true);
  }

  function onMemoBoardClick(x, y, gtp) {
    if (mode !== 'memo' || !memo || memo.done) return;
    if (occupiedAt(memo.pos, x, y)) { notifyOccupied(); return; }
    var mv = memoMoveAt(memo.ply);
    if (!mv || mv.color !== memo.color) return;
    if (String(gtp).toUpperCase() === String(mv.gtp).toUpperCase()) {
      memo.pos.play(mv.color, SGF.sgfToXY(mv.sgf, memo.pos.size), mv.gtp);
      var xy = SGF.gtpToXY(mv.gtp, memo.pos.size);
      memo.marks = xy ? [{ x: xy.x, y: xy.y, type: 'ok' }] : [];
      memo.hintMark = null;
      memo.ply++;
      memo.learned++;
      saveMemoProgress();
      advanceOpponent(false);
    } else {
      // 停住重试：不重置进度，只累计点错次数
      memo.mistakes++;
      memoBoard.setMarks(memo.marks.concat([{ x: x, y: y, type: 'wrong' }],
        memo.hintMark ? [memo.hintMark] : []));
      renderMemo('不对，再想想 —— 仍停在第 ' + memo.ply + ' 手，不会重来。点「提示」可看落点。', 'bad');
      saveMemoProgress();
      var snapshot = memo;
      setTimeout(function () {
        if (mode === 'memo' && memo === snapshot && !memo.done) {
          memoBoard.setMarks(memo.marks.concat(memo.hintMark ? [memo.hintMark] : []));
        }
      }, 800);
    }
  }

  function memoHint() {
    if (mode !== 'memo' || !memo || memo.done) return;
    var mv = memoMoveAt(memo.ply);
    if (!mv || mv.color !== memo.color) return;
    memo.hints++;
    if (SGF.isPassGtp(mv.gtp)) {
      renderMemo('提示：第 ' + memo.ply + ' 手原谱是虚着（pass），点「本手 Pass」即可。', 'bad');
    } else {
      var xy = SGF.gtpToXY(mv.gtp, memo.pos.size);
      memo.hintMark = xy ? { x: xy.x, y: xy.y, type: 'hint', label: '✓' } : null;
      memoBoard.setMarks(memo.marks.concat(memo.hintMark ? [memo.hintMark] : []));
      renderMemo('提示：第 ' + memo.ply + ' 手应下在标记处（' + esc(mv.gtp) +
        '）；仍需自己点，提示单独计数、不算错。', 'bad');
    }
    saveMemoProgress();
  }

  function memoPass() {
    if (mode !== 'memo' || !memo || memo.done || !currentMemoIsPass()) { toast('这一手不是虚着'); return; }
    var mv = memoMoveAt(memo.ply);
    memo.pos.play(mv.color, null, 'pass');
    memo.marks = [];
    memo.hintMark = null;
    memo.ply++;
    memo.learned++;
    saveMemoProgress();
    advanceOpponent(false);
  }

  function jumpToMemoCard() {
    var c = $('memoCard');
    if (!c) return;
    if (c.scrollIntoView) c.scrollIntoView({ behavior: 'smooth', block: 'start' });
    c.style.boxShadow = '0 0 0 3px rgba(43,108,176,.35)';
    setTimeout(function () { c.style.boxShadow = ''; }, 1500);
  }

  function backFromMemo() {
    memo = null;
    mode = 'idle';
    renderStats();
    showPanel('idlePanel');
    updateIdle();
    renderMemoList();
    jumpToMemoCard();
  }

  /* ---------------- misc actions ---------------- */

  function download(name, text, mime) {
    var blob = new Blob([text], { type: mime || 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function bind() {
    // settings
    ['setOpeningEnd', 'setMiddleEnd', 'setThOpening', 'setThMiddle', 'setThEndgame',
     'setPvSteps', 'setRateEasy', 'setRateGood', 'setRateHard', 'setMergeDistance',
     'setMerge', 'setMergeBasis'].forEach(function (id) {
      $(id).addEventListener('input', saveSettingsFromUI);
      $(id).addEventListener('change', saveSettingsFromUI);
    });
    $('setLearner').addEventListener('change', saveSettingsFromUI);
    $('setLearner').addEventListener('blur', saveSettingsFromUI);

    $('btnResetSettings').addEventListener('click', function () {
      Store.setSettings(JSON.parse(JSON.stringify(Store.DEFAULT_SETTINGS)));
      loadSettingsToUI(); refresh(); toast('已恢复默认设置');
    });

    // import
    $('btnImport').addEventListener('click', function () { $('fileInput').click(); });
    $('btnImportDir').addEventListener('click', function () { $('dirInput').click(); });
    $('btnLoadGenerated').addEventListener('click', function () { loadGenerated(); });
    $('btnAnalyzeToggle').addEventListener('click', function () {
      var p = $('analyzePanel');
      p.classList.toggle('hidden');
      if (!p.classList.contains('hidden')) { refreshSourceGames(); pollAnalysis(false); }
    });
    $('btnAnalyzeRefresh').addEventListener('click', function () { refreshSourceGames(); pollAnalysis(false); });
    $('anVisits').addEventListener('change', refreshSourceGames);
    $('btnAnalyzeStart').addEventListener('click', startAnalysis);
    $('btnAnalyzeStop').addEventListener('click', stopAnalysis);
    $('fileInput').addEventListener('change', function (e) { importFiles(e.target.files); e.target.value = ''; });
    $('dirInput').addEventListener('change', function (e) { importFiles(e.target.files); e.target.value = ''; });
    $('btnPasteToggle').addEventListener('click', function () { $('pasteArea').classList.toggle('hidden'); });
    $('btnPasteClear').addEventListener('click', function () { $('pasteText').value = ''; });
    $('btnPasteLoad').addEventListener('click', function () {
      var t = $('pasteText').value.trim();
      if (!t) { toast('请先粘贴 SGF 文本'); return; }
      importTexts([{ name: '粘贴棋谱-' + Date.now() + '.sgf', text: t }]);
    });
    $('btnClearGames').addEventListener('click', function () {
      if (!confirm('确定清空所有已导入棋谱？复习进度与名局库会保留。')) return;
      Store.setGames([]); refresh(); toast('已清空棋谱（名局库不受影响）');
    });

    // 名局背谱
    $('btnMemoJump').addEventListener('click', jumpToMemoCard);
    $('btnMemoAddSelected').addEventListener('click', memoAddSelected);
    $('btnMemoAddFiles').addEventListener('click', function () { $('memoFileInput').click(); });
    $('memoFileInput').addEventListener('change', function (e) {
      memoAddFiles(e.target.files); e.target.value = '';
    });
    $('btnMemoHint').addEventListener('click', memoHint);
    $('btnMemoPass').addEventListener('click', memoPass);
    $('btnMemoBack').addEventListener('click', backFromMemo);
    $('btnMemoRestart').addEventListener('click', function () {
      if (!memo) return;
      startMemo(memo.master.id, true);
      toast('已从头开始背（点错与提示计数清零）');
    });

    // help
    $('btnHelp').addEventListener('click', function () { $('helpPanel').classList.toggle('hidden'); });
    $('btnHelpClose').addEventListener('click', function () { $('helpPanel').classList.add('hidden'); });

    // backup
    $('btnBackup').addEventListener('click', function () {
      download('goreview-backup-' + today() + '.json', Store.exportBackup());
      toast('备份已导出');
    });
    $('btnRestore').addEventListener('click', function () {
      var inp = document.createElement('input');
      inp.type = 'file'; inp.accept = '.json';
      inp.addEventListener('change', function () {
        var f = inp.files[0];
        if (!f) return;
        f.text().then(function (t) {
          try { Store.importBackup(t); loadSettingsToUI(); refresh(); renderMemoList(); toast('备份已恢复'); }
          catch (e) { toast('备份恢复失败：' + e.message); }
        });
      });
      inp.click();
    });

    // study
    $('btnStartReview').addEventListener('click', startReview);
    $('btnNext').addEventListener('click', nextCard);
    $('btnDelete').addEventListener('click', deleteCurrent);
    $('btnDelete2').addEventListener('click', deleteCurrent);
    $('btnHint').addEventListener('click', function () {
      if (mode !== 'review' || !practice || practice.done) return;
      var exp = practice.seq.expected[practice.step];
      var xy = SGF.gtpToXY(exp, practice.game.size);
      practice.mistakes++;
      if (xy) board.setMarks(practice.marks.concat([{ x: xy.x, y: xy.y, type: 'hint', label: '✓' }]));
      renderPractice('提示：正解在标记处（记 1 次错），点它继续。', 'bad');
      var snapshot = practice;
      setTimeout(function () {
        if (mode === 'review' && practice === snapshot && !practice.done) board.setMarks(practice.marks);
      }, 2200);
    });
    $('btnRestart').addEventListener('click', function () {
      if (!practice) return;
      startPractice(practice.p);
      toast('本题已重置（不计入评分）');
    });
    $('btnLessonStart').addEventListener('click', startLesson);
    $('btnLessonDemo').addEventListener('click', demoLesson);
    $('btnLessonReset').addEventListener('click', resetLesson);
    $('btnPreviewBack').addEventListener('click', function () {
      clearLesson();
      mode = 'idle'; showPanel('idlePanel'); updateIdle();
    });
    $('btnPreviewStudy').addEventListener('click', function () { clearLesson(); startReview(); });
    $('btnRestoreDeleted').addEventListener('click', function () {
      var st = Store.get();
      if (!st.deletedIds.length) { toast('没有被删除的卡片'); return; }
      st.deletedIds = []; Store.save(); refresh(); toast('已恢复全部被删除的卡片');
    });
    $('btnResetProgress').addEventListener('click', function () {
      if (!confirm('确定清空全部复习进度（SRS 记录与已删除标记）？')) return;
      var st = Store.get();
      st.cards = {}; st.deletedIds = []; st.stats = { totalReviews: 0, day: today(), dayReviews: 0 };
      Store.save(); refresh(); toast('复习进度已清空');
    });
  }

  /* ---------------- boot ---------------- */

  function init() {
    if (!NS.SGF || !NS.Board || !NS.Review || !NS.SRS || !NS.Store) {
      document.body.innerHTML = '<p style="padding:30px">模块加载失败，请确认 js/ 目录完整。</p>';
      return;
    }
    board = new BM.Board($('board'), 19);
    board.onClick = onBoardClick;
    board.onOccupiedClick = notifyOccupied;
    previewBoard = new BM.Board($('previewBoard'), 19);
    previewBoard.interactive = false;
    previewBoard.onOccupiedClick = notifyOccupied;
    memoBoard = new BM.Board($('memoBoard'), 19);
    memoBoard.onClick = onMemoBoardClick;
    memoBoard.onOccupiedClick = notifyOccupied;

    loadSettingsToUI();
    bind();
    refresh();
    renderMemoList();

    if (Store.get().memoryOnly) {
      $('importNote').className = 'import-note warn';
      $('importNote').textContent = '当前环境无法写入 localStorage（可能是浏览器限制），数据只会保留到关闭页面。建议用本地服务器打开（例如在 go-review 目录执行 python -m http.server 8000）。';
    }
    var st = Store.get();
    if (!st.games.length) {
      $('importNote').innerHTML = '推荐点 <b>「AI 分析（网页端）」</b> 直接让本机 KataGo 逐手生成目差与 AI 变化；也可导入 KaTrain 导出的 SGF 或点击「载入分析结果」。详见右上角「使用说明」。';
    }
    $('learnerNote').textContent = '从 SGF 的 PB/PW 判定执黑执白，文件名 [A]vs[B] 作为兜底；id 改变后自动重算。';
    if (location.protocol !== 'file:') { refreshSourceGames(); pollAnalysis(false); }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(typeof globalThis !== 'undefined' ? globalThis : this);
