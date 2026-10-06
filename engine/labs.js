/* Interstitium Labs — guided labs engine (workstream C).
   Vanilla JS, zero dependencies, ES5-compatible.
   Renders lab cards from content.json "labs" into the existing #labsBody
   inside #view-labs (static markup lives in templates/bootcamp.html).
   Watches terminal commands via window.ILBTerminal.onCommand and ticks
   checks automatically. Completions persist to localStorage. */
(function () {
  'use strict';

  var SLUG = (window.BOOTCAMP_PAGE && window.BOOTCAMP_PAGE.slug) || '';
  var LS_KEY = 'ilb-bootcamp-' + SLUG + '-labs-v1';

  var state = {
    labs: null,      /* array from content.json */
    loaded: false,
    activeId: null,  /* lab the candidate is currently working */
    done: {},        /* {labId: true} from localStorage */
    ticked: {},      /* {labId: {checkIndex: true}} for the active run */
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

  function labById(id) {
    for (var i = 0; i < state.labs.length; i++) {
      if (state.labs[i].id === id) return state.labs[i];
    }
    return null;
  }
  function doneCount() {
    var n = 0, i;
    for (i = 0; i < state.labs.length; i++) {
      if (state.done[state.labs[i].id]) n++;
    }
    return n;
  }

  /* ---------- view handling ---------- */
  function showLabsView() {
    var sec = $('view-labs');
    if (!sec) return;
    var views = document.querySelectorAll('#main .view');
    for (var i = 0; i < views.length; i++) {
      views[i].classList.toggle('active', views[i] === sec);
    }
  }

  /* ---------- rendering ---------- */
  function counterHtml() {
    return '<p class="labs-counter" style="color:var(--muted);font-size:13px">' +
      'Labs completed <strong style="color:var(--accent)">' + doneCount() +
      '</strong> / ' + state.labs.length + '</p>';
  }

  function hintBarHtml(lab) {
    if (!lab) return '';
    return '<div class="labs-hintbar" role="status" style="margin:0 0 16px">' +
      '<p style="margin:0"><strong>Active lab: ' + esc(lab.title) + '.</strong> ' +
      'Run each step\u2019s commands in the <strong>Terminal</strong> tab \u2014 ' +
      'checks validate automatically.</p></div>';
  }

  function terminalNoticeHtml() {
    return '<div class="labs-notice" role="alert" style="margin:0 0 16px">' +
      '<p style="margin:0"><strong>Interstitium Labs:</strong> the Terminal engine ' +
      'is not loaded, so live checks are unavailable right now. Open the Terminal ' +
      'tab once \u2014 checks will start validating from there.</p></div>';
  }

  function emptyHtml() {
    return '<div class="labs-empty"><p class="eyebrow">INTERSTITIUM LABS \u00B7 GUIDED PRACTICE</p>' +
      '<h3>No guided labs on this path yet</h3>' +
      '<p style="color:var(--muted)">The adaptive drill queue and the Terminal tab are ' +
      'ready when you are \u2014 labs for this bootcamp are still being built.</p></div>';
  }

  function checkRowHtml(lab, ci, check) {
    var ticked = state.ticked[lab.id] && state.ticked[lab.id][ci];
    var done = !!state.done[lab.id];
    var mark = (ticked || done) ? '\u2714' : '\u25CB';
    var cls = (ticked || done) ? 'lab-check is-done' : 'lab-check';
    return '<li class="' + cls + '"><span class="lab-tick" aria-hidden="true">' + mark +
      '</span><span>' + esc(check.hint || 'Run the step\u2019s command in the Terminal tab.') +
      '</span></li>';
  }

  function cardHtml(lab) {
    var i, steps = '', checks = '';
    var isActive = state.activeId === lab.id;
    var isDone = !!state.done[lab.id];
    for (i = 0; i < lab.steps.length; i++) {
      steps += '<li>' + esc(lab.steps[i]) + '</li>';
    }
    for (i = 0; i < lab.checks.length; i++) {
      checks += checkRowHtml(lab, i, lab.checks[i]);
    }
    var btn = isDone
      ? '<span class="btn small" aria-label="Lab completed" style="opacity:.7">\u2714 Completed</span>'
      : '<button class="btn small primary" data-lab-start="' + esc(lab.id) + '">' +
        (isActive ? 'Restart lab' : 'Start lab') + ' \u2192</button>';
    return '<article class="panel lab-card' + (isActive ? ' is-active' : '') +
      (isDone ? ' is-done' : '') + '" data-lab="' + esc(lab.id) + '">' +
      '<div class="section-head" style="margin-bottom:12px"><div>' +
      '<p class="eyebrow">GUIDED LAB</p><h3 style="margin:0">' + esc(lab.title) + '</h3></div></div>' +
      '<p style="color:var(--muted)">' + esc(lab.objective) + '</p>' +
      '<ol class="lab-steps">' + steps + '</ol>' +
      '<p class="eyebrow" style="margin-top:14px">CHECKS</p>' +
      '<ul class="lab-checks">' + checks + '</ul>' +
      '<div class="action-row" style="margin-top:14px">' + btn + '</div>' +
      '<div class="lab-result" aria-live="polite"></div>' +
      '</article>';
  }

  function completePanelHtml(lab) {
    return '<div class="lab-complete" role="status">' +
      '<p class="eyebrow">INTERSTITIUM LABS \u00B7 LAB COMPLETE</p>' +
      '<h3>\u2714 ' + esc(lab.title) + ' \u2014 cleared</h3>' +
      '<p>' + esc(lab.success_message) + '</p></div>';
  }

  function paint() {
    var body = $('labsBody');
    if (!body || !state.labs) return;
    var html = '';
    var activeLab = state.activeId ? labById(state.activeId) : null;
    html += counterHtml();
    if (!window.ILBTerminal || typeof window.ILBTerminal.onCommand !== 'function') {
      html += terminalNoticeHtml();
    }
    if (!state.labs.length) {
      html += emptyHtml();
    } else {
      html += hintBarHtml(activeLab);
      html += '<div class="lab-grid" id="labsGrid">';
      for (var i = 0; i < state.labs.length; i++) {
        html += cardHtml(state.labs[i]);
      }
      html += '</div>';
    }
    body.innerHTML = html;
    bindCards(body);
    /* re-show completion panels for already-finished labs */
    for (var j = 0; j < state.labs.length; j++) {
      if (state.done[state.labs[j].id]) {
        var card = body.querySelector('[data-lab="' + state.labs[j].id + '"] .lab-result');
        if (card) card.innerHTML = completePanelHtml(state.labs[j]);
      }
    }
  }

  function bindCards(body) {
    var btns = body.querySelectorAll('[data-lab-start]');
    for (var i = 0; i < btns.length; i++) {
      (function (b) {
        b.addEventListener('click', function () {
          startLab(b.getAttribute('data-lab-start'));
        });
      })(btns[i]);
    }
  }

  /* ---------- lab lifecycle ---------- */
  function startLab(id) {
    var lab = labById(id);
    if (!lab) return;
    state.activeId = id;
    state.ticked[id] = {};
    if (state.done[id]) {
      /* allow re-running a completed lab: clear the flag for this attempt */
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
    var lab = labById(state.activeId);
    if (!lab || state.done[lab.id]) return;
    var out = String(output == null ? '' : output);
    var changed = false, i, check, rx, ok;
    if (!state.ticked[lab.id]) state.ticked[lab.id] = {};
    for (i = 0; i < lab.checks.length; i++) {
      if (state.ticked[lab.id][i]) continue;
      check = lab.checks[i];
      try { rx = new RegExp(check.command_pattern); }
      catch (e) { continue; }
      ok = rx.test(String(cmd)) && out.indexOf(String(check.expect_contains)) >= 0;
      if (ok) {
        state.ticked[lab.id][i] = true;
        changed = true;
      }
    }
    if (changed) {
      var all = true;
      for (i = 0; i < lab.checks.length; i++) {
        if (!state.ticked[lab.id][i]) { all = false; break; }
      }
      if (all) completeLab(lab);
      else paint();
    }
  }

  function completeLab(lab) {
    state.done[lab.id] = true;
    saveDone();
    state.activeId = null;
    paint();
    var body = $('labsBody');
    if (body) {
      var slot = body.querySelector('[data-lab="' + lab.id + '"] .lab-result');
      if (slot) slot.innerHTML = completePanelHtml(lab);
      if (slot && slot.scrollIntoView) {
        try { slot.scrollIntoView({ block: 'nearest' }); } catch (e) {}
      }
    }
  }

  /* ---------- load & events ---------- */
  function render() {
    showLabsView();
    state.done = loadDone();
    var body = $('labsBody');
    if (state.loaded) { paint(); return; }
    if (body) {
      body.innerHTML = '<p style="color:var(--muted)">Loading guided labs\u2026</p>';
    }
    fetch('./content.json', { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('content.json ' + r.status);
        return r.json();
      })
      .then(function (data) {
        state.labs = (data && data.labs) || [];
        state.loaded = true;
        ensureListener();
        paint();
      })
      .catch(function () {
        state.labs = [];
        state.loaded = true;
        if (body) body.innerHTML = counterHtml() + emptyHtml();
      });
  }

  document.addEventListener('ilb:view', function (e) {
    if (e && e.detail === 'labs') render();
  });

  window.LabsView = { render: render, startLab: startLab };
})();
