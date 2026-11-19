/* GoReview.Review — problem-move selection */
(function (root) {
  'use strict';
  var NS = (root.GoReview = root.GoReview || {});
  var SGF = NS.SGF;

  function stageOf(ply, settings) {
    if (ply <= settings.openingEnd) return 'opening';
    if (ply <= settings.middleEnd) return 'middle';
    return 'endgame';
  }

  function stageName(s) {
    return s === 'opening' ? '开局' : (s === 'middle' ? '中盘' : '官子');
  }

  function gameId(game) {
    // Stable even when the learner id changes afterwards, so SRS progress survives.
    return game.filename;
  }

  function coordDistance(a, b, size) {
    var pa = SGF.gtpToXY(a, size), pb = SGF.gtpToXY(b, size);
    if (!pa || !pb) return Infinity;
    return Math.abs(pa.x - pb.x) + Math.abs(pa.y - pb.y);
  }

  function sameProblem(prev, cur, settings, size) {
    var d = settings.mergeDistance || 0;
    var checkBest = settings.mergeBasis === 'best' || settings.mergeBasis === 'either';
    var checkPlayed = settings.mergeBasis === 'played' || settings.mergeBasis === 'either';
    var byBest = false, byPlayed = false;
    if (checkBest && prev.best && cur.best) {
      byBest = d === 0
        ? String(prev.best).toUpperCase() === String(cur.best).toUpperCase()
        : coordDistance(prev.best, cur.best, size) <= d;
    }
    if (checkPlayed && prev.gtp && cur.gtp) {
      byPlayed = d === 0
        ? String(prev.gtp).toUpperCase() === String(cur.gtp).toUpperCase()
        : coordDistance(prev.gtp, cur.gtp, size) <= d;
    }
    return byBest || byPlayed;
  }

  /**
   * Collect problem moves from all imported games.
   * "连续同一步" merge: when consecutive learner moves (ply gap <= 2) are all
   * problem moves pointing at the same answer / same wrong point, only the
   * FIRST one is kept.
   */
  function collectProblems(games, settings) {
    var all = [], notes = [];

    games.forEach(function (game) {
      if (!game.playerColor) {
        notes.push({ level: 'warn', text: game.filename + '：未匹配到学习方 id「' + (settings.learnerId || '') + '」，已跳过（PB=' + (game.pb || '空') + ' / PW=' + (game.pw || '空') + '）' });
        return;
      }
      if (game.warning) notes.push({ level: 'warn', text: game.filename + '：' + game.warning });

      var candidates = [];
      game.moves.forEach(function (m) {
        if (m.color !== game.playerColor) return;
        var st = stageOf(m.ply, settings);
        var th = Number(settings.thresholds[st]);
        if (!(m.loss !== null && m.loss > th)) return;
        candidates.push({
          id: gameId(game) + '#' + m.ply,
          gameId: gameId(game), filename: game.filename,
          ply: m.ply, color: m.color, gtp: m.gtp, sgf: m.sgf,
          loss: m.loss, best: m.best, pv: (m.pv || []).slice(),
          stage: st, threshold: th, size: game.size,
          upto: m.ply - 1,
          source: m.source, merged: []
        });
      });

      if (!settings.mergeConsecutive) { all = all.concat(candidates); return; }

      var kept = [], prev = null;
      for (var i = 0; i < candidates.length; i++) {
        var c = candidates[i];
        var last = kept.length ? kept[kept.length - 1] : null;
        // "consecutive" is about the raw candidate chain (a gap of 2 plies
        // means the learner's next move), while "same problem" is judged
        // against the FIRST occurrence so a whole chain collapses into it.
        var consecutive = prev && (c.ply - prev.ply <= 2);
        if (consecutive && last && sameProblem(last, c, settings, game.size)) {
          last.merged.push(c.ply);
        } else {
          kept.push(c);
        }
        prev = c;
      }
      all = all.concat(kept);
    });

    all.sort(function (a, b) { return a.loss - b.loss; }).sort(function (a, b) {
      return a.filename.localeCompare(b.filename) || a.ply - b.ply;
    });
    return { problems: all, notes: notes };
  }

  function summarize(problems) {
    var out = {
      total: problems.length,
      opening: 0, middle: 0, endgame: 0,
      lossSum: 0, lossMax: 0, mergedCount: 0
    };
    problems.forEach(function (p) {
      out[p.stage]++;
      out.lossSum += p.loss;
      out.lossMax = Math.max(out.lossMax, p.loss);
      out.mergedCount += p.merged.length;
    });
    out.lossAvg = out.total ? out.lossSum / out.total : 0;
    return out;
  }

  // Learner moves with analysis, used by the "all moves" inspector.
  function learnerMoves(games, settings) {
    var rows = [];
    games.forEach(function (g) {
      if (!g.playerColor) return;
      g.moves.forEach(function (m) {
        if (m.color !== g.playerColor) return;
        rows.push({
          filename: g.filename, ply: m.ply, gtp: m.gtp, best: m.best,
          loss: m.loss, stage: stageOf(m.ply, settings),
          threshold: Number(settings.thresholds[stageOf(m.ply, settings)]),
          isProblem: m.loss !== null && m.loss > Number(settings.thresholds[stageOf(m.ply, settings)])
        });
      });
    });
    return rows;
  }

  /**
   * Simulate the AI principal variation on a copy of the position and keep
   * only legal moves. 'expected' = learner moves, 'replies' = automatic AI answers.
   * pos must be a GoReview.Board.Position (clone()/playGtp()).
   */
  function buildSequence(pos, problem, learner, steps) {
    var pv = (problem.pv || []).filter(function (g) { return !SGF.isPassGtp(g); })
      .map(function (g) { return String(g).toUpperCase(); });
    if (problem.best && !SGF.isPassGtp(problem.best)) {
      var b = String(problem.best).toUpperCase();
      if (!pv.length) pv = [b];
      else if (pv[0] !== b) pv = [b].concat(pv);
    }
    var opp = learner === 'B' ? 'W' : 'B';
    var sim = pos.clone(), seq = [], need = steps * 2 - 1;
    for (var i = 0; i < pv.length && seq.length < need; i++) {
      if (!sim.playGtp(i % 2 === 0 ? learner : opp, pv[i])) break;
      seq.push(pv[i]);
    }
    var n = Math.max(1, Math.min(steps, Math.ceil(seq.length / 2)));
    return {
      expected: seq.filter(function (_, i) { return i % 2 === 0; }).slice(0, n),
      replies: seq.filter(function (_, i) { return i % 2 === 1; }).slice(0, n - 1),
      n: n, pvLength: (problem.pv || []).length, truncated: n < steps
    };
  }

  NS.Review = {
    stageOf: stageOf, stageName: stageName, gameId: gameId,
    collectProblems: collectProblems, summarize: summarize,
    learnerMoves: learnerMoves, buildSequence: buildSequence
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
