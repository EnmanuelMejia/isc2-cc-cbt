/* Interstitium Labs — structured terminal missions engine (enterprise CBT).
   Vanilla JS, zero dependencies, ES5-compatible.
   Renders mission cards from content.json "terminalMissions" into #missionsBody
   inside #view-missions (static markup lives in templates/bootcamp.html).
   Same check contract as labs.js: a regex on the typed command AND a substring
   in the terminal output. Watches terminal commands via
   window.ILBTerminal.onCommand and ticks checks automatically. Completions
   persist to localStorage 'ilb-bootcamp-<slug>-missions-v1'.
   Listens for the coordinator's CustomEvent 'ilb:view' with
   e.detail === 'missions'. Exposes window.MissionsView = {render}. */
(function () {
  'use strict';

  var SLUG = (window.BOOTCAMP_PAGE && window.BOOTCAMP_PAGE.slug) || '';
  var LS_KEY = 'ilb-bootcamp-' + SLUG + '-missions-v1';

  var state = {
    missions: null,  /* array from content.json */
    loaded: false,
    activeId: null,  /* mission the candidate is currently running */
    done: {},        /* {missionId: true} from localStorage */
    ticked: {},      /* {missionId: {checkIndex: true}} for the active run */
    listenerOn: false
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

  function missionById(id) {
    for (var i = 0; i < state.missions.length; i++) {
      if (state.missions[i].id === id) return state.missions[i];
    }
    return null;
  }
  function doneCount() {
    var n = 0, i;
    for (i = 0; i < state.missions.length; i++) {
      if (state.done[state.missions[i].id]) n++;
    }
    return n;
  }

  /* ---------- view handling ---------- */
  function showSection() {
    var sec = $('view-missions');
    if (!sec) return;
    var views = document.querySelectorAll('#main .view');
    for (var i = 0; i < views.length; i++) {
      views[i].classList.toggle('active', views[i] === sec);
    }
    var btns = document.querySelectorAll('.nav button[data-view]');
    for (var j = 0; j < btns.length; j++) {
      btns[j].classList.toggle('active',
        btns[j].getAttribute('data-view') === 'missions');
    }
  }

  /* ---------- rendering ---------- */
  function counterHtml() {
    return '<p class="labs-counter" style="color:var(--muted);font-size:13px">' +
      'Missions completed <strong style="color:var(--accent)">' + doneCount() +
      '</strong> / ' + state.missions.length + '</p>';
  }

  function hintBarHtml(mission) {
    if (!mission) return '';
    return '<div class="labs-hintbar" role="status" style="margin:0 0 16px">' +
      '<p style="margin:0"><strong>Active mission: ' + esc(mission.title) + '.</strong> ' +
      'Run each objective\u2019s commands in the <strong>Terminal</strong> tab \u2014 ' +
      'checks validate automatically.</p></div>';
  }

  function terminalNoticeHtml() {
    return '<div class="labs-notice" role="alert" style="margin:0 0 16px">' +
      '<p style="margin:0"><strong>Interstitium Labs:</strong> the Terminal engine ' +
      'is not loaded, so live checks are unavailable right now. Open the Terminal ' +
      'tab once \u2014 checks will start validating from there.</p></div>';
  }

  function emptyHtml() {
    return '<div class="labs-empty"><p class="eyebrow">INTERSTITIUM LABS \u00B7 TERMINAL MISSIONS</p>' +
      '<h3>No terminal missions on this path yet</h3>' +
      '<p style="color:var(--muted)">The adaptive drill queue and the Terminal tab are ' +
      'ready when you are \u2014 missions for this bootcamp are still being built.</p></div>';
  }

  function checkRowHtml(mission, ci, check) {
    var ticked = state.ticked[mission.id] && state.ticked[mission.id][ci];
    var done = !!state.done[mission.id];
    var mark = (ticked || done) ? '\u2714' : '\u25CB';
    var cls = (ticked || done) ? 'lab-check is-done' : 'lab-check';
    return '<li class="' + cls + '"><span class="lab-tick" aria-hidden="true">' + mark +
      '</span><span>' + esc(check.hint || 'Run the objective\u2019s command in the Terminal tab.') +
      '</span></li>';
  }

  function cardHtml(mission) {
    var i, objectives = '', checks = '';
    var isActive = state.activeId === mission.id;
    var isDone = !!state.done[mission.id];
    var objs = mission.objectives || [];
    for (i = 0; i < objs.length; i++) {
      objectives += '<li>' + esc(objs[i]) + '</li>';
    }
    var chks = mission.checks || [];
    for (i = 0; i < chks.length; i++) {
      checks += checkRowHtml(mission, i, chks[i]);
    }
    var btn = isDone
      ? '<span class="btn small" aria-label="Mission completed" style="opacity:.7">\u2714 Completed</span>'
      : '<button class="btn small primary" data-mission-start="' + esc(mission.id) + '">' +
        (isActive ? 'Restart mission' : 'Start mission') + ' \u2192</button>';
    return '<article class="panel lab-card' + (isActive ? ' is-active' : '') +
      (isDone ? ' is-done' : '') + '" data-mission="' + esc(mission.id) + '">' +
      '<div class="section-head" style="margin-bottom:12px"><div>' +
      '<p class="eyebrow">TERMINAL MISSION' +
      (mission.difficulty ? ' \u00B7 DIFFICULTY ' + esc(String(mission.difficulty)) + '/3' : '') + '</p>' +
      '<h3 style="margin:0">' + esc(mission.title) + '</h3></div></div>' +
      '<p style="color:var(--muted)">' + esc(mission.brief || '') + '</p>' +
      (objectives ? '<p class="eyebrow" style="margin-top:14px">OBJECTIVES</p>' +
        '<ol class="lab-steps">' + objectives + '</ol>' : '') +
      '<p class="eyebrow" style="margin-top:14px">CHECKS</p>' +
      '<ul class="lab-checks">' + checks + '</ul>' +
      '<div class="action-row" style="margin-top:14px">' + btn + '</div>' +
      '<div class="mission-result" aria-live="polite"></div>' +
      '</article>';
  }

  function completePanelHtml(mission) {
    return '<div class="lab-complete" role="status">' +
      '<p class="eyebrow">INTERSTITIUM LABS \u00B7 MISSION COMPLETE</p>' +
      '<h3>\u2714 ' + esc(mission.title) + ' \u2014 cleared</h3>' +
      '<p>' + esc(mission.success_message || 'Mission accomplished.') + '</p></div>';
  }

  function paint() {
    var body = $('missionsBody');
    if (!body || !state.missions) return;
    var html = '';
    var activeMission = state.activeId ? missionById(state.activeId) : null;
    html += counterHtml();
    if (!window.ILBTerminal || typeof window.ILBTerminal.onCommand !== 'function') {
      html += terminalNoticeHtml();
    }
    if (!state.missions.length) {
      html += emptyHtml();
    } else {
      html += hintBarHtml(activeMission);
      html += '<div class="lab-grid" id="missionsGrid">';
      for (var i = 0; i < state.missions.length; i++) {
        html += cardHtml(state.missions[i]);
      }
      html += '</div>';
    }
    body.innerHTML = html;
    bindCards(body);
    /* re-show completion panels for already-finished missions */
    for (var j = 0; j < state.missions.length; j++) {
      if (state.done[state.missions[j].id]) {
        var card = body.querySelector('[data-mission="' + state.missions[j].id + '"] .mission-result');
        if (card) card.innerHTML = completePanelHtml(state.missions[j]);
      }
    }
  }

  function bindCards(body) {
    var btns = body.querySelectorAll('[data-mission-start]');
    for (var i = 0; i < btns.length; i++) {
      (function (b) {
        b.addEventListener('click', function () {
          startMission(b.getAttribute('data-mission-start'));
        });
      })(btns[i]);
    }
  }

  /* ---------- mission lifecycle ---------- */
  function startMission(id) {
    var mission = missionById(id);
    if (!mission) return;
    state.activeId = id;
    state.ticked[id] = {};
    if (state.done[id]) {
      /* allow re-running a completed mission: clear the flag for this attempt */
      delete state.done[id];
      saveDone();
    }
    ensureListener();
    paint();
  }

  function ensureListener() {
    if (state.listenerOn) return;
    if (!window.ILBTerminal || typeof window.ILBTerminal.onCommand !== 'function') {
      return; /* notice already shown by paint() */
    }
    try {
      window.ILBTerminal.onCommand(handleCommand);
      state.listenerOn = true;
    } catch (e) { /* terminal present but hook failed; notice stays visible */ }
  }

  function handleCommand(cmd, output) {
    if (!state.activeId) return;
    var mission = missionById(state.activeId);
    if (!mission || state.done[mission.id]) return;
    var out = String(output == null ? '' : output);
    var changed = false, i, check, rx, ok;
    var checks = mission.checks || [];
    if (!state.ticked[mission.id]) state.ticked[mission.id] = {};
    for (i = 0; i < checks.length; i++) {
      if (state.ticked[mission.id][i]) continue;
      check = checks[i];
      try { rx = new RegExp(check.command_pattern); }
      catch (e) { continue; }
      ok = rx.test(String(cmd)) && out.indexOf(String(check.expect_contains)) >= 0;
      if (ok) {
        state.ticked[mission.id][i] = true;
        changed = true;
      }
    }
    if (changed) {
      var all = true;
      for (i = 0; i < checks.length; i++) {
        if (!state.ticked[mission.id][i]) { all = false; break; }
      }
      if (all) completeMission(mission);
      else paint();
    }
  }

  function completeMission(mission) {
    state.done[mission.id] = true;
    saveDone();
    state.activeId = null;
    paint();
    var body = $('missionsBody');
    if (body) {
      var slot = body.querySelector('[data-mission="' + mission.id + '"] .mission-result');
      if (slot) slot.innerHTML = completePanelHtml(mission);
      if (slot && slot.scrollIntoView) {
        try { slot.scrollIntoView({ block: 'nearest' }); } catch (e) {}
      }
    }
  }

  /* ---------- load & events ---------- */
  function render() {
    showSection();
    state.done = loadDone();
    var body = $('missionsBody');
    if (state.loaded) { paint(); return; }
    if (body) {
      body.innerHTML = '<p style="color:var(--muted)">Loading terminal missions\u2026</p>';
    }
    fetch('./content.json', { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('content.json ' + r.status);
        return r.json();
      })
      .then(function (data) {
        state.missions = (data && data.terminalMissions) || [];
        state.loaded = true;
        ensureListener();
        paint();
      })
      .catch(function () {
        state.missions = [];
        state.loaded = true;
        if (body) body.innerHTML = counterHtml() + emptyHtml();
      });
  }

  document.addEventListener('ilb:view', function (e) {
    if (e && e.detail === 'missions') render();
  });

  window.MissionsView = { render: render, startMission: startMission };

  /* Testing seam (headless): check contract helpers. */
  if (typeof window !== 'undefined' && window.ENGINE_TEST) {
    window.__missionsEngine = {
      checkCommand: function (commandPattern, expectContains, cmd, output) {
        var rx;
        try { rx = new RegExp(commandPattern); }
        catch (e) { return false; }
        return rx.test(String(cmd)) &&
          String(output == null ? '' : output).indexOf(String(expectContains)) >= 0;
      }
    };
  }
})();
