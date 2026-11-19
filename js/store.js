/* GoReview.Store — localStorage persistence */
(function (root) {
  'use strict';
  var NS = (root.GoReview = root.GoReview || {});

  var KEY = 'goreview.v1';

  var DEFAULT_SETTINGS = {
    learnerId: 'nicomai',
    openingEnd: 50,
    middleEnd: 150,
    thresholds: { opening: 2, middle: 5, endgame: 3 },
    pvSteps: 3,
    rating: { easyMax: 0, goodMax: 1, hardMax: 2 },
    mergeConsecutive: true,
    mergeBasis: 'either',
    mergeDistance: 0
  };

  function defaults() {
    return {
      version: 1,
      settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
      games: [],
      cards: {},
      deletedIds: [],
      stats: { totalReviews: 0, day: '', dayReviews: 0 },
      memoryOnly: false
    };
  }

  var state = null;

  function normalize(s) {
    var d = defaults();
    if (!s || typeof s !== 'object') return d;
    d.games = Array.isArray(s.games) ? s.games : [];
    d.cards = (s.cards && typeof s.cards === 'object') ? s.cards : {};
    d.deletedIds = Array.isArray(s.deletedIds) ? s.deletedIds : [];
    d.stats = Object.assign(d.stats, s.stats || {});
    d.settings = Object.assign(d.settings, s.settings || {});
    d.settings.thresholds = Object.assign({ opening: 2, middle: 5, endgame: 3 }, (s.settings || {}).thresholds || {});
    d.settings.rating = Object.assign({ easyMax: 0, goodMax: 1, hardMax: 2 }, (s.settings || {}).rating || {});
    return d;
  }

  function load() {
    if (state) return state;
    try {
      var raw = root.localStorage.getItem(KEY);
      state = normalize(raw ? JSON.parse(raw) : null);
    } catch (e) {
      state = normalize(null);
      state.memoryOnly = true;
    }
    return state;
  }

  function save() {
    try {
      root.localStorage.setItem(KEY, JSON.stringify(state));
      state.memoryOnly = false;
      return true;
    } catch (e) {
      state.memoryOnly = true;
      return false;
    }
  }

  function get() { return load(); }

  function setSettings(patch) {
    var s = load();
    s.settings = Object.assign(s.settings, patch);
    if (patch.thresholds) s.settings.thresholds = Object.assign({}, s.settings.thresholds, patch.thresholds);
    if (patch.rating) s.settings.rating = Object.assign({}, s.settings.rating, patch.rating);
    save();
    return s.settings;
  }

  function setGames(games) {
    var s = load();
    s.games = games;
    return save();
  }

  function getCard(id) { return load().cards[id] || null; }

  function setCard(id, cardState) {
    var s = load();
    s.cards[id] = cardState;
    save();
  }

  function deleteCard(id) {
    var s = load();
    if (s.deletedIds.indexOf(id) < 0) s.deletedIds.push(id);
    delete s.cards[id];
    save();
  }

  function restoreCard(id) {
    var s = load();
    var i = s.deletedIds.indexOf(id);
    if (i >= 0) s.deletedIds.splice(i, 1);
    save();
  }

  function bumpReview() {
    var s = load();
    var today = new Date().toISOString().slice(0, 10);
    if (s.stats.day !== today) { s.stats.day = today; s.stats.dayReviews = 0; }
    s.stats.dayReviews++;
    s.stats.totalReviews++;
    save();
  }

  function exportBackup() {
    var s = load();
    return JSON.stringify({
      version: 1, exportedAt: new Date().toISOString(),
      settings: s.settings, games: s.games, cards: s.cards,
      deletedIds: s.deletedIds, stats: s.stats
    }, null, 2);
  }

  function importBackup(text) {
    var obj = JSON.parse(text);
    if (!obj || typeof obj !== 'object') throw new Error('备份格式无效');
    var s = load();
    s.settings = Object.assign(s.settings, obj.settings || {});
    if (Array.isArray(obj.games)) s.games = obj.games;
    if (obj.cards && typeof obj.cards === 'object') s.cards = obj.cards;
    if (Array.isArray(obj.deletedIds)) s.deletedIds = obj.deletedIds;
    if (obj.stats) s.stats = Object.assign(s.stats, obj.stats);
    save();
    return s;
  }

  function resetAll() {
    state = defaults();
    try { root.localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
    return state;
  }

  NS.Store = {
    KEY: KEY, DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    load: load, get: get, save: save, setSettings: setSettings,
    setGames: setGames, getCard: getCard, setCard: setCard,
    deleteCard: deleteCard, restoreCard: restoreCard,
    bumpReview: bumpReview, exportBackup: exportBackup,
    importBackup: importBackup, resetAll: resetAll
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
