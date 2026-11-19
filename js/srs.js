/* GoReview.SRS — mistake-based grading + Anki-like spaced repetition */
(function (root) {
  'use strict';
  var NS = (root.GoReview = root.GoReview || {});

  var DAY = 86400000;
  var LEARNING_STEP = 10 * 60 * 1000; // 10 minutes for "again"

  var LABEL = { again: '重来', hard: '困难', good: '良好', easy: '简单' };
  var COLOR = { again: '#c0392b', hard: '#c47a17', good: '#1f8a5c', easy: '#2b6cb0' };

  /** mistakes -> grade; thresholds are editable in the UI */
  function rate(mistakes, cfg) {
    cfg = cfg || { easyMax: 0, goodMax: 1, hardMax: 2 };
    var n = Number(mistakes) || 0;
    if (n <= cfg.easyMax) return 'easy';
    if (n <= cfg.goodMax) return 'good';
    if (n <= cfg.hardMax) return 'hard';
    return 'again';
  }

  function newCardState() {
    return {
      ease: 2.5, interval: 0, due: 0, reps: 0, lapses: 0,
      status: 'new', reviews: 0, totalMistakes: 0, lastRating: null, lastReviewed: 0
    };
  }

  function clampEase(e) { return Math.max(1.3, Math.min(3.0, e)); }

  /** Returns an updated card state + a human readable next interval. */
  function schedule(card, rating, now) {
    now = now || Date.now();
    var c = Object.assign(newCardState(), card || {});
    var first = c.reps === 0;
    var intervalMs;

    if (rating === 'again') {
      c.ease = clampEase(c.ease - 0.2);
      c.interval = 0;
      c.lapses++;
      c.status = 'learning';
      intervalMs = LEARNING_STEP;
    } else if (rating === 'hard') {
      c.ease = clampEase(c.ease - 0.15);
      c.interval = first ? 1 : Math.max(1, c.interval * 1.2);
      c.status = 'review';
      intervalMs = c.interval * DAY;
    } else if (rating === 'good') {
      c.interval = first ? 1 : Math.max(1, c.interval * c.ease);
      c.status = 'review';
      intervalMs = c.interval * DAY;
    } else { // easy
      c.ease = clampEase(c.ease + 0.15);
      c.interval = first ? 4 : Math.max(1, c.interval * c.ease * 1.3);
      c.status = 'review';
      intervalMs = c.interval * DAY;
    }

    c.reps++;
    c.reviews++;
    c.lastRating = rating;
    c.lastReviewed = now;
    c.due = now + intervalMs;
    return { card: c, intervalMs: intervalMs, text: intervalText(intervalMs) };
  }

  function intervalText(ms) {
    if (ms < 60 * 60 * 1000) return Math.max(1, Math.round(ms / 60000)) + ' 分钟';
    if (ms < 24 * 3600 * 1000) return (ms / 3600000).toFixed(1).replace(/\.0$/, '') + ' 小时';
    var d = ms / DAY;
    return (d < 10 ? d.toFixed(1).replace(/\.0$/, '') : Math.round(d)) + ' 天';
  }

  /**
   * Build a study queue: due review cards first (oldest due), then new cards.
   * activeIds = currently selected problem ids, deletedIds = removed cards.
   */
  function buildQueue(problems, cards, deletedIds, now) {
    now = now || Date.now();
    var del = Object.create(null);
    (deletedIds || []).forEach(function (id) { del[id] = true; });
    var due = [], fresh = [];
    problems.forEach(function (p) {
      if (del[p.id]) return;
      var c = cards[p.id];
      if (!c || c.reps === 0) fresh.push(p);
      else if (c.due <= now) due.push(p);
    });
    due.sort(function (a, b) { return (cards[a.id].due || 0) - (cards[b.id].due || 0); });
    return due.concat(fresh);
  }

  function counts(problems, cards, deletedIds, now) {
    now = now || Date.now();
    var del = Object.create(null);
    (deletedIds || []).forEach(function (id) { del[id] = true; });
    var out = { due: 0, fresh: 0, suspended: 0, total: 0 };
    problems.forEach(function (p) {
      if (del[p.id]) return;
      out.total++;
      var c = cards[p.id];
      if (!c || c.reps === 0) out.fresh++;
      else if (c.due <= now) out.due++;
      else out.suspended++;
    });
    return out;
  }

  NS.SRS = {
    DAY: DAY, LABEL: LABEL, COLOR: COLOR,
    rate: rate, schedule: schedule, intervalText: intervalText,
    newCardState: newCardState, buildQueue: buildQueue, counts: counts
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
