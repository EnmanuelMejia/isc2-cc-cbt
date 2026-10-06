/* Interstitium Labs — interactive scenario simulations engine (enterprise CBT).
   Vanilla JS, zero dependencies, ES5-compatible.
   Renders simulation cards from content.json "simulations" into #exercisesBody
   inside #view-exercises (static markup lives in templates/bootcamp.html).
   Kinds: troubleshoot | branching | ordering | config-check.
   Validation + scoring are pure functions (see window.__simsEngine seam).
   Completions persist to localStorage 'ilb-bootcamp-<slug>-sims-v1'.
   Listens for the coordinator's CustomEvent 'ilb:view' with e.detail === 'exercises'.
   Exposes window.SimsView = {render}. */
(function () {
  'use strict';

  var SLUG = (window.BOOTCAMP_PAGE && window.BOOTCAMP_PAGE.slug) || '';
  var LS_KEY = 'ilb-bootcamp-' + SLUG + '-sims-v1';

  var state = {
    sims: null,     /* array from content.json */
    loaded: false,
    activeId: null, /* simulation the candidate is currently running */
    done: {},       /* {simId: {completed, earned, possible, score, when}} */
    run: null       /* transient runner state for the active simulation */
  };

  /* ---------- utils ---------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function $(id) { return document.getElementById(id); }

  function loadDone() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function saveDone() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(state.done)); }
    catch (e) { /* storage unavailable — session-only progress */ }
  }
  function simById(id) {
    for (var i = 0; i < state.sims.length; i++) {
      if (state.sims[i].id === id) return state.sims[i];
    }
    return null;
  }
  function doneCount() {
    var n = 0, i;
    for (i = 0; i < state.sims.length; i++) {
      if (state.done[state.sims[i].id] && state.done[state.sims[i].id].completed) n++;
    }
    return n;
  }
  function kindLabel(kind) {
    return { troubleshoot: 'TROUBLESHOOT', branching: 'DECISION TREE',
      ordering: 'ORDER THE STEPS', 'config-check': 'CONFIG AUDIT' }[kind] || 'EXERCISE';
  }
  function pointsOf(sim) {
    var p = parseInt(sim && sim.points, 10);
    return (p > 0) ? p : 10;
  }

  /* ---------- pure validators (also exposed on the testing seam) ---------- */
  function toNumArray(a) {
    var out = [], i;
    a = a || [];
    for (i = 0; i < a.length; i++) {
      var n = parseInt(a[i], 10);
      if (!isNaN(n)) out.push(n);
    }
    return out;
  }
  /* checkOrdering(items, selectedOrder, correctOrder): selectedOrder and
     correctOrder are arrays of item indices in candidate/authored order. */
  function checkOrdering(items, selectedOrder, correctOrder) {
    var sel = toNumArray(selectedOrder), cor = toNumArray(correctOrder);
    var n = cor.length, hits = 0, per = [], i, ok;
    for (i = 0; i < n; i++) {
      ok = (i < sel.length && sel[i] === cor[i]);
      per.push(ok);
      if (ok) hits++;
    }
    var full = (sel.length === n && hits === n);
    return { correct: full, hits: hits, total: n, score: n ? hits / n : 0,
      perPosition: per };
  }
  /* scoreBranching(path): path is an array of chosen choice objects
     ({points}) or plain point numbers. Returns the earned total. */
  function scoreBranching(path) {
    var total = 0, i, c;
    path = path || [];
    for (i = 0; i < path.length; i++) {
      c = path[i];
      total += (c && typeof c === 'object') ? (parseInt(c.points, 10) || 0)
        : (parseInt(c, 10) || 0);
    }
    return { total: total, steps: path.length };
  }
  /* Maximum achievable points on a branching tree (DFS from the first step). */
  function maxBranchingPoints(steps) {
    var byId = {}, i;
    steps = steps || [];
    for (i = 0; i < steps.length; i++) {
      if (steps[i] && steps[i].id) byId[steps[i].id] = steps[i];
    }
    function best(nodeId) {
      var node = byId[nodeId];
      if (!node || !node.choices || !node.choices.length) return 0;
      var m = 0, j, ch, v;
      for (j = 0; j < node.choices.length; j++) {
        ch = node.choices[j];
        v = (parseInt(ch.points, 10) || 0);
        if (ch.next && ch.next !== 'END') v += best(ch.next);
        if (v > m) m = v;
      }
      return m;
    }
    return steps.length ? best(steps[0].id) : 0;
  }
  /* checkConfigCheck(selectedLines, issues, find): selectedLines are the
     1-based line numbers the candidate flagged; issues carry .line. */
  function checkConfigCheck(selectedLines, issues, find) {
    var sel = toNumArray(selectedLines), issueLines = [], i;
    issues = issues || [];
    for (i = 0; i < issues.length; i++) {
      var ln = parseInt(issues[i] && issues[i].line, 10);
      if (!isNaN(ln)) issueLines.push(ln);
    }
    var hits = 0, fps = 0, j, k, isIssue, missed = [];
    for (j = 0; j < sel.length; j++) {
      isIssue = false;
      for (k = 0; k < issueLines.length; k++) {
        if (sel[j] === issueLines[k]) { isIssue = true; break; }
      }
      if (isIssue) hits++; else fps++;
    }
    for (j = 0; j < issueLines.length; j++) {
      isIssue = false;
      for (k = 0; k < sel.length; k++) {
        if (sel[k] === issueLines[j]) { isIssue = true; break; }
      }
      if (!isIssue) missed.push(issueLines[j]);
    }
    var denom = Math.max(parseInt(find, 10) || 0, issueLines.length, 1);
    var score = (hits - 0.5 * fps) / denom;
    if (score < 0) score = 0;
    if (score > 1) score = 1;
    return { correct: (hits === issueLines.length && fps === 0),
      hits: hits, falsePositives: fps, missed: missed, score: score };
  }

  /* ---------- injected stylesheet (runner-specific selectors) ---------- */
  var SIM_CSS = [
    '.sim-crumb{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 14px}',
    '.sim-counter{font:600 12px var(--mono);color:var(--muted)}',
    '.sim-points{margin:0 0 16px;padding:0;list-style:none;display:grid;gap:10px}',
    '.sim-points li{background:var(--surface);border:1px solid var(--line);border-radius:10px;' +
      'padding:12px 16px;font-size:14px;line-height:1.55}'
  ].join('\n');
  var cssInjected = false;
  function injectCSS() {
    if (cssInjected || !document.head) return;
    var st = document.createElement('style');
    st.setAttribute('data-sims', '1');
    st.textContent = SIM_CSS;
    document.head.appendChild(st);
    cssInjected = true;
  }

  /* ---------- view handling ---------- */
  function showSection() {
    var sec = $('view-exercises');
    if (!sec) return;
    var views = document.querySelectorAll('#main .view');
    for (var i = 0; i < views.length; i++) {
      views[i].classList.toggle('active', views[i] === sec);
    }
    var btns = document.querySelectorAll('.nav button[data-view]');
    for (var j = 0; j < btns.length; j++) {
      btns[j].classList.toggle('active',
        btns[j].getAttribute('data-view') === 'exercises');
    }
  }

  /* ---------- card list rendering ---------- */
  function counterHtml() {
    return '<p class="labs-counter" style="color:var(--muted);font-size:13px">' +
      'Simulations completed <strong style="color:var(--accent)">' + doneCount() +
      '</strong> / ' + state.sims.length + '</p>';
  }
  function emptyHtml() {
    return '<div class="labs-empty"><p class="eyebrow">INTERSTITIUM LABS \u00B7 SCENARIO PRACTICE</p>' +
      '<h3>No interactive exercises on this path yet</h3>' +
      '<p style="color:var(--muted)">The adaptive drill queue and the Terminal tab are ' +
      'ready when you are \u2014 scenario exercises for this bootcamp are still being built.</p></div>';
  }
  function cardHtml(sim) {
    var rec = state.done[sim.id];
    var isDone = !!(rec && rec.completed);
    var isActive = state.activeId === sim.id;
    var status = isDone
      ? '<span class="btn small" aria-label="Simulation completed" style="opacity:.7">\u2714 ' +
        esc(String(rec.earned)) + '/' + esc(String(rec.possible)) + ' pts</span>'
      : '<button class="btn small primary" data-sim-start="' + esc(sim.id) + '">' +
        (isActive ? 'Restart exercise' : 'Start exercise') + ' \u2192</button>';
    return '<article class="panel lab-card' + (isActive ? ' is-active' : '') +
      (isDone ? ' is-done' : '') + '" data-sim="' + esc(sim.id) + '">' +
      '<div class="section-head" style="margin-bottom:12px"><div>' +
      '<p class="eyebrow">INTERACTIVE SIMULATION \u00B7 ' + esc(kindLabel(sim.kind)) + '</p>' +
      '<h3 style="margin:0">' + esc(sim.title) + '</h3></div></div>' +
      '<p style="color:var(--muted)">' + esc(sim.brief || '') + '</p>' +
      '<div class="lab-meta"><span class="tag">' + esc(String(pointsOf(sim))) + ' pts</span>' +
      (sim.difficulty ? '<span class="tag">Difficulty ' + esc(String(sim.difficulty)) + '/3</span>' : '') +
      '</div>' +
      '<div class="action-row" style="margin-top:14px">' + status + '</div>' +
      '<div class="sim-result" aria-live="polite"></div>' +
      '</article>';
  }
  function paintList() {
    var body = $('exercisesBody');
    if (!body || !state.sims) return;
    var html = counterHtml();
    if (!state.sims.length) {
      html += emptyHtml();
    } else {
      html += '<div class="lab-grid" id="simsGrid">';
      for (var i = 0; i < state.sims.length; i++) html += cardHtml(state.sims[i]);
      html += '</div>';
    }
    body.innerHTML = html;
    bindList(body);
  }
  function bindList(body) {
    var btns = body.querySelectorAll('[data-sim-start]');
    for (var i = 0; i < btns.length; i++) {
      (function (b) {
        b.addEventListener('click', function () {
          startSim(b.getAttribute('data-sim-start'));
        });
      })(btns[i]);
    }
  }

  /* ---------- runner ---------- */
  function startSim(id) {
    var sim = simById(id);
    if (!sim) return;
    state.activeId = id;
    state.run = newRun(sim);
    if (state.done[id] && state.done[id].completed) {
      delete state.done[id]; /* allow re-running a completed simulation */
      saveDone();
    }
    paintRunner();
    window.scrollTo(0, 0);
  }
  function newRun(sim) {
    var run = { kind: sim.kind, step: 0, correct: 0, path: [], nodeId: null,
      selected: [], selLines: {}, order: [], answered: false };
    if (sim.kind === 'branching' && sim.steps && sim.steps.length) {
      run.nodeId = sim.steps[0].id;
    }
    if (sim.kind === 'ordering' && sim.steps && sim.steps.items) {
      var idx = [], i;
      for (i = 0; i < sim.steps.items.length; i++) idx.push(i);
      for (i = idx.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1)), t = idx[i];
        idx[i] = idx[j]; idx[j] = t;
      }
      run.order = idx;
    }
    return run;
  }
  function finishSim(sim, score01) {
    var possible = pointsOf(sim);
    var earned = Math.round(possible * Math.max(0, Math.min(1, score01)));
    state.done[sim.id] = { completed: true, earned: earned, possible: possible,
      score: score01, when: Date.now() };
    saveDone();
    state.activeId = null;
    state.run = null;
    paintList();
    var body = $('exercisesBody');
    if (body) {
      var slot = body.querySelector('[data-sim="' + sim.id + '"] .sim-result');
      if (slot) slot.innerHTML = completeHtml(sim, earned, possible);
      if (slot && slot.scrollIntoView) {
        try { slot.scrollIntoView({ block: 'nearest' }); } catch (e) {}
      }
    }
  }
  function completeHtml(sim, earned, possible) {
    return '<div class="lab-complete" role="status">' +
      '<p class="eyebrow">INTERSTITIUM LABS \u00B7 EXERCISE COMPLETE</p>' +
      '<h3>\u2714 ' + esc(sim.title) + ' \u2014 ' + esc(String(earned)) + '/' +
      esc(String(possible)) + ' pts</h3>' +
      '<p>' + esc(sim.debrief || 'Exercise complete. Review the debrief above and keep drilling.') + '</p></div>';
  }
  function runnerShell(sim, inner) {
    return '<div class="sim-crumb"><button class="btn small ghost" data-sim-back="\u2190">\u2190 All exercises</button>' +
      '<span class="sim-counter">' + esc(kindLabel(sim.kind)) + ' \u00B7 ' +
      esc(String(pointsOf(sim))) + ' pts</span></div>' +
      '<article class="panel"><p class="eyebrow">INTERACTIVE SIMULATION</p>' +
      '<h3 style="margin:0 0 8px">' + esc(sim.title) + '</h3>' +
      '<p style="color:var(--muted)">' + esc(sim.brief || '') + '</p>' + inner + '</article>';
  }
  function paintRunner() {
    var body = $('exercisesBody');
    var sim = state.activeId ? simById(state.activeId) : null;
    if (!body || !sim || !state.run) { paintList(); return; }
    var inner = '';
    if (sim.kind === 'troubleshoot') inner = troubleshootHtml(sim);
    else if (sim.kind === 'branching') inner = branchingHtml(sim);
    else if (sim.kind === 'ordering') inner = orderingHtml(sim);
    else if (sim.kind === 'config-check') inner = configCheckHtml(sim);
    else inner = '<p style="color:var(--muted)">Unknown exercise kind \u201C' +
      esc(sim.kind) + '\u201D \u2014 this exercise cannot run yet.</p>';
    body.innerHTML = runnerShell(sim, inner);
    bindRunner(body, sim);
  }
  function bindRunner(body, sim) {
    var back = body.querySelector('[data-sim-back]');
    if (back) back.addEventListener('click', function () {
      state.activeId = null; state.run = null; paintList();
    });
    var q = body.querySelectorAll('[data-sim-act]');
    for (var i = 0; i < q.length; i++) {
      (function (b) {
        b.addEventListener('click', function () {
          handleRunnerAction(sim, b.getAttribute('data-sim-act'),
            b.getAttribute('data-sim-arg'));
        });
      })(q[i]);
    }
  }

  /* ----- troubleshoot runner ----- */
  function troubleshootHtml(sim) {
    var run = state.run, steps = sim.steps || [];
    if (run.step >= steps.length) return '';
    var st = steps[run.step], i, h;
    h = '<p class="eyebrow" style="margin-top:14px">STEP ' + (run.step + 1) + ' / ' +
      steps.length + '</p>';
    h += '<p><strong>Symptom:</strong> ' + esc(st.symptom || '') + '</p>';
    if (st.evidence && st.evidence.length) {
      h += '<div class="situation">';
      for (i = 0; i < st.evidence.length; i++) {
        h += '<p><strong>' + esc(st.evidence[i][0]) + '</strong></p><pre>' +
          esc(st.evidence[i][1]) + '</pre>';
      }
      h += '</div>';
    }
    if (!run.answered) {
      h += '<p class="decision-prompt">What is the right next diagnostic action?</p><div class="choices">';
      for (i = 0; i < (st.options || []).length; i++) {
        h += '<button class="choice" data-sim-act="answer" data-sim-arg="' + i + '">' +
          esc(st.options[i]) + '</button>';
      }
      h += '</div>';
    } else {
      var ok = run.lastCorrect;
      h += '<div class="feedback ' + (ok ? 'good' : 'bad') + '" role="status"><p><strong>' +
        (ok ? '\u2714 Correct.' : '\u2718 Not quite.') + '</strong> ' +
        esc(st.explain || '') + '</p></div>';
      h += '<div class="action-row" style="margin-top:12px"><button class="btn primary" ' +
        'data-sim-act="next-step">' + (run.step + 1 < steps.length ? 'Next step \u2192' : 'See results \u2192') +
        '</button></div>';
    }
    return h;
  }

  /* ----- branching runner ----- */
  function nodeById(sim, id) {
    var steps = sim.steps || [];
    for (var i = 0; i < steps.length; i++) {
      if (steps[i].id === id) return steps[i];
    }
    return null;
  }
  function branchingHtml(sim) {
    var run = state.run, node = nodeById(sim, run.nodeId), i, h;
    if (!node) return '<p style="color:var(--muted)">Decision tree is malformed (unknown node).</p>';
    h = '<div class="situation"><p>' + esc(node.text || '') + '</p></div>';
    if (!run.answered) {
      h += '<p class="decision-prompt">Choose your next move:</p><div class="choices">';
      for (i = 0; i < (node.choices || []).length; i++) {
        h += '<button class="choice" data-sim-act="branch" data-sim-arg="' + i + '">' +
          esc(node.choices[i].label) + '</button>';
      }
      h += '</div>';
    } else {
      var ch = run.lastChoice || {};
      h += '<div class="feedback" role="status"><p>' + esc(ch.feedback || '') + '</p></div>';
      var last = !ch.next || ch.next === 'END';
      h += '<div class="action-row" style="margin-top:12px"><button class="btn primary" ' +
        'data-sim-act="branch-next">' + (last ? 'See outcome \u2192' : 'Continue \u2192') +
        '</button></div>';
    }
    return h;
  }

  /* ----- ordering runner ----- */
  function orderingHtml(sim) {
    var run = state.run, steps = sim.steps || {}, items = steps.items || [], i, h;
    h = '<div class="situation"><p>' + esc(steps.context || 'Put the steps in the correct order.') + '</p></div>';
    if (!run.answered) {
      h += '<p class="eyebrow">YOUR ORDER (click to remove)</p><ol class="sim-points" id="simOrderList">';
      for (i = 0; i < run.selected.length; i++) {
        h += '<li><button class="btn small ghost" data-sim-act="unpick" data-sim-arg="' + i + '">' +
          esc(items[run.selected[i]]) + ' \u2718</button></li>';
      }
      if (!run.selected.length) h += '<li style="color:var(--muted)">Nothing placed yet \u2014 click steps below.</li>';
      h += '</ol><p class="eyebrow">AVAILABLE STEPS</p><div class="choices">';
      for (i = 0; i < run.order.length; i++) {
        var idx = run.order[i];
        if (run.selected.indexOf(idx) >= 0) continue;
        h += '<button class="choice" data-sim-act="pick" data-sim-arg="' + idx + '">' +
          esc(items[idx]) + '</button>';
      }
      h += '</div><div class="action-row" style="margin-top:12px">' +
        '<button class="btn small ghost" data-sim-act="clear-order">Clear</button>' +
        '<button class="btn primary" data-sim-act="check-order" ' +
        (run.selected.length === items.length ? '' : 'disabled') + '>Check order</button></div>';
    } else {
      var res = run.lastResult;
      h += '<div class="feedback ' + (res.correct ? 'good' : 'bad') + '" role="status"><p><strong>' +
        (res.correct ? '\u2714 Perfect order.' : '\u2718 ' + res.hits + ' of ' + res.total +
        ' steps in the right position.') + '</strong></p></div>';
      h += '<ol class="sim-points">';
      for (i = 0; i < items.length; i++) {
        var mine = run.selected[i], want = (steps.correct_order || [])[i];
        var ok = mine === want;
        h += '<li>' + (ok ? '\u2714 ' : '\u2718 ') + esc(items[mine]) +
          (ok ? '' : ' <span style="color:var(--muted)">(should be: ' + esc(items[want]) + ')</span>') + '</li>';
      }
      h += '</ol><div class="action-row" style="margin-top:12px"><button class="btn primary" ' +
        'data-sim-act="finish-order">See results \u2192</button></div>';
    }
    return h;
  }

  /* ----- config-check runner ----- */
  function configCheckHtml(sim) {
    var run = state.run, steps = sim.steps || {};
    var lines = String(steps.config || '').split('\n');
    var i, h;
    h = '<div class="situation"><p>Click every misconfigured line you can find \u2014 ' +
      'there ' + (steps.find === 1 ? 'is' : 'are') + ' <strong>' + esc(String(steps.find || 0)) +
      '</strong> issue' + (steps.find === 1 ? '' : 's') + ' hiding in this config. Then submit your findings.</p></div>';
    if (!run.answered) {
      h += '<pre class="sim-config" style="background:var(--surface);border:1px solid var(--line);' +
        'border-radius:10px;padding:14px;overflow-x:auto;font:13px/1.7 var(--mono)">';
      for (i = 0; i < lines.length; i++) {
        var ln = i + 1, sel = !!run.selLines[ln];
        h += '<span class="sim-line' + (sel ? ' is-sel' : '') + '" data-sim-act="toggle-line" ' +
          'data-sim-arg="' + ln + '" role="button" tabindex="0" style="display:block;cursor:pointer;' +
          (sel ? 'background:rgba(255,180,0,.12);' : '') + '"><span style="color:var(--muted);' +
          'display:inline-block;width:2.5em;text-align:right;margin-right:1em">' + ln +
          '</span>' + esc(lines[i]) + '</span>';
      }
      h += '</pre><div class="action-row" style="margin-top:12px">' +
        '<span style="color:var(--muted);font-size:13px">' + Object.keys(run.selLines).length +
        ' line(s) flagged</span>' +
        '<button class="btn primary" data-sim-act="check-config">Submit findings</button></div>';
    } else {
      var res = run.lastResult, issues = steps.issues || [];
      var hitSet = {};
      for (i = 0; i < issues.length; i++) hitSet[issues[i].line] = issues[i];
      h += '<div class="feedback ' + (res.correct ? 'good' : 'bad') + '" role="status"><p><strong>' +
        (res.correct ? '\u2714 All issues found, no false alarms.' :
          '\u2718 ' + res.hits + ' of ' + issues.length + ' found' +
          (res.falsePositives ? ', ' + res.falsePositives + ' false alarm(s)' : '') + '.') +
        '</strong></p></div>';
      h += '<div class="sim-points">';
      for (i = 0; i < issues.length; i++) {
        var iss = issues[i];
        h += '<div style="background:var(--surface);border:1px solid var(--line);border-radius:10px;' +
          'padding:12px 16px;font-size:14px"><strong>Line ' + esc(String(iss.line)) + ':</strong> ' +
          esc(iss.description || '') + '<br><span style="color:var(--muted)">Fix: ' +
          esc(iss.fix || '') + '</span></div>';
      }
      h += '</div><div class="action-row" style="margin-top:12px"><button class="btn primary" ' +
        'data-sim-act="finish-config">See results \u2192</button></div>';
    }
    return h;
  }

  /* ----- runner actions ----- */
  function handleRunnerAction(sim, act, arg) {
    var run = state.run;
    if (!run) return;
    if (act === 'answer') {
      var steps = sim.steps || [], st = steps[run.step];
      if (!st || run.answered) return;
      var pick = parseInt(arg, 10);
      var ok = pick === st.correct;
      run.answered = true;
      run.lastCorrect = ok;
      if (ok) run.correct++;
      paintRunner();
    } else if (act === 'next-step') {
      var n = (sim.steps || []).length;
      run.step++;
      run.answered = false;
      if (run.step >= n) {
        finishSim(sim, n ? run.correct / n : 0);
      } else {
        paintRunner();
      }
    } else if (act === 'branch') {
      var node = nodeById(sim, run.nodeId);
      if (!node || run.answered) return;
      var ch = (node.choices || [])[parseInt(arg, 10)];
      if (!ch) return;
      run.answered = true;
      run.lastChoice = ch;
      run.path.push(ch);
      paintRunner();
    } else if (act === 'branch-next') {
      var last = run.lastChoice || {};
      run.answered = false;
      if (!last.next || last.next === 'END') {
        var earned = scoreBranching(run.path).total;
        var possible = maxBranchingPoints(sim.steps || []);
        var node2 = nodeById(sim, run.nodeId);
        var good = node2 && node2.outcome === 'good';
        var score = possible > 0 ? earned / possible : (good ? 1 : 0);
        finishSim(sim, score);
      } else {
        run.nodeId = last.next;
        paintRunner();
      }
    } else if (act === 'pick') {
      var idx = parseInt(arg, 10);
      if (run.selected.indexOf(idx) < 0) run.selected.push(idx);
      paintRunner();
    } else if (act === 'unpick') {
      run.selected.splice(parseInt(arg, 10), 1);
      paintRunner();
    } else if (act === 'clear-order') {
      run.selected = [];
      paintRunner();
    } else if (act === 'check-order') {
      var stp = sim.steps || {};
      run.lastResult = checkOrdering(stp.items, run.selected, stp.correct_order);
      run.answered = true;
      paintRunner();
    } else if (act === 'finish-order') {
      finishSim(sim, run.lastResult ? run.lastResult.score : 0);
    } else if (act === 'toggle-line') {
      var ln = parseInt(arg, 10);
      if (run.selLines[ln]) delete run.selLines[ln];
      else run.selLines[ln] = true;
      paintRunner();
    } else if (act === 'check-config') {
      var cfg = sim.steps || {};
      var sel = [];
      for (var k in run.selLines) {
        if (run.selLines.hasOwnProperty(k)) sel.push(parseInt(k, 10));
      }
      run.lastResult = checkConfigCheck(sel, cfg.issues, cfg.find);
      run.answered = true;
      paintRunner();
    } else if (act === 'finish-config') {
      finishSim(sim, run.lastResult ? run.lastResult.score : 0);
    }
  }

  /* ---------- load & events ---------- */
  function render() {
    injectCSS();
    showSection();
    state.done = loadDone();
    var body = $('exercisesBody');
    if (state.loaded) {
      if (state.activeId && state.run) paintRunner();
      else paintList();
      return;
    }
    if (body) {
      body.innerHTML = '<p style="color:var(--muted)">Loading interactive exercises\u2026</p>';
    }
    fetch('./content.json', { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('content.json ' + r.status);
        return r.json();
      })
      .then(function (data) {
        state.sims = (data && data.simulations) || [];
        state.loaded = true;
        paintList();
      })
      .catch(function () {
        state.sims = [];
        state.loaded = true;
        if (body) body.innerHTML = counterHtml() + emptyHtml();
      });
  }

  document.addEventListener('ilb:view', function (e) {
    if (e && e.detail === 'exercises') render();
  });

  window.SimsView = { render: render, start: startSim };

  /* Testing seam: pure validators for headless validation (see test/smoke.js). */
  if (typeof window !== 'undefined' && window.ENGINE_TEST) {
    window.__simsEngine = {
      checkOrdering: checkOrdering,
      scoreBranching: scoreBranching,
      maxBranchingPoints: maxBranchingPoints,
      checkConfigCheck: checkConfigCheck
    };
  }
})();
