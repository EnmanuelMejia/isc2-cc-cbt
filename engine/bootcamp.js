/* ============================================================
   Interstitium Labs — Certification Bootcamps: shared bootcamp engine
   Vanilla JS, zero dependencies.

   RUNTIME CONTRACT (set by the generator shell before this loads):
     window.BOOTCAMP_PAGE = {
       slug:    "python",          // bootcamp slug; namespaces localStorage
       hubUrl:  "../../index.html",// hub landing URL
       title:   "Python Programming"
     }
   Then this engine fetches "./content.json" (schema: docs/content-schema.md)
   and renders: hero stats, mastery dashboard, scenario browser, adaptive
   drill workbench, timed simulation, behavioral prep, chat-companion link.

   Progress is stored per bootcamp:
     localStorage["ilb-bootcamp-<slug>-v1"] = { scenarioId: {a, c} }
   a = attempts, c = correct answers. A scenario is "cleared" once answered
   correctly at least once.
   ============================================================ */
(function(){
'use strict';

/* ---------------- page contract ---------------- */
var PAGE = window.BOOTCAMP_PAGE || {};
var SLUG = PAGE.slug || 'bootcamp';
var LS_KEY = 'ilb-bootcamp-' + SLUG + '-v1';

/* ---------------- utils ---------------- */
function el(id){ return document.getElementById(id); }
function esc(s){ return String(s == null ? '' : s)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;')
  .replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function pad(n){ return (n < 10 ? '0' : '') + n; }
function fmtClock(sec){ sec = Math.max(0, Math.floor(sec));
  var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h > 0 ? h + ':' + pad(m) : m) + ':' + pad(s); }
function shuffle(a){ var r = a.slice();
  for (var i = r.length - 1; i > 0; i--){
    var j = Math.floor(Math.random() * (i + 1)), t = r[i]; r[i] = r[j]; r[j] = t; }
  return r; }
function truncate(s, n){ s = String(s || '');
  return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; }

var toastTimer = null;
function toast(msg){
  var t = el('toast'); if (!t) return;
  t.textContent = msg; t.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function(){ t.classList.remove('show'); }, 2600);
}

/* ---------------- progress store ---------------- */
function loadProg(){ try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; }
  catch(e){ return {}; } }
var prog = loadProg();
function saveProg(){ try { localStorage.setItem(LS_KEY, JSON.stringify(prog)); } catch(e){} }
function recordResult(id, correct){
  var r = prog[id] || {a:0, c:0}; r.a++; if (correct) r.c++;
  prog[id] = r; saveProg(); }
function cleared(id){ return !!(prog[id] && prog[id].c > 0); }
function attempted(id){ return !!prog[id]; }

/* ---------------- content model ---------------- */
var CONTENT = null;      // raw content.json
var SCEN = [];           // flattened scenarios, each with .domain / .domainId
var BY_ID = {};
var DOMAINS = [];        // domain names in content order
var DOMAIN_IDS = {};     // name -> id
var TOTAL = 0;
var SIM = { items: 12, minutes: 180, evidence_cost_mins: 0 };

function ingest(content){
  CONTENT = content;
  SCEN = []; BY_ID = {}; DOMAINS = []; DOMAIN_IDS = {};
  (content.domains || []).forEach(function(d){
    DOMAINS.push(d.name); DOMAIN_IDS[d.name] = d.id;
    (d.scenarios || []).forEach(function(s){
      var item = {
        id: d.id + ':' + s.id,
        domain: d.name, domainId: d.id,
        title: s.title, situation: s.situation, prompt: s.prompt,
        evidence: s.evidence || [], choices: s.choices || [],
        answer: s.answer, why: s.why, hint: s.hint,
        objectives: s.objectives || [], mins: s.mins || 6,
        desc: s.desc || truncate(s.situation, 140)
      };
      SCEN.push(item); BY_ID[item.id] = item;
    });
  });
  TOTAL = SCEN.length;
  if (content.simulation){
    if (content.simulation.items) SIM.items = content.simulation.items;
    if (content.simulation.minutes) SIM.minutes = content.simulation.minutes;
    if (content.simulation.evidence_cost_mins)
      SIM.evidence_cost_mins = content.simulation.evidence_cost_mins;
  }
}

/* ---------------- mastery & adaptive queue ---------------- */
function domainItems(d){ return SCEN.filter(function(s){ return s.domain === d; }); }
function domainCleared(d){
  return domainItems(d).filter(function(s){ return cleared(s.id); }).length; }
function mastery(d){ var items = domainItems(d);
  return items.length ? domainCleared(d) / items.length : 0; }
function answeredCount(d){
  return domainItems(d).filter(function(s){ return attempted(s.id); }).length; }
function weakestFirst(){
  return DOMAINS.slice().sort(function(a, b){
    var dm = mastery(a) - mastery(b);
    if (dm !== 0) return dm;
    var da = answeredCount(a) - answeredCount(b);
    if (da !== 0) return da;
    return a < b ? -1 : 1;
  });
}
function overallPct(){
  return TOTAL ? Math.round(100 * SCEN.filter(function(s){ return cleared(s.id); }).length / TOTAL) : 0; }
function clearedCount(){ return SCEN.filter(function(s){ return cleared(s.id); }).length; }

/* ---------------- enterprise CBT: progress intelligence ----------------
   window.ILBProgress exposes cross-engine recommendations. It reads the
   labs / simulations / missions localStorage keys directly (tolerating
   missing engines — absent keys simply read as empty) and recommends the
   next incomplete lab, simulation, or mission inside the weakest domains. */
function domNameById(id){
  var ds = (CONTENT && CONTENT.domains) || [], i;
  for (i = 0; i < ds.length; i++){
    if (ds[i].id === id) return ds[i].name || id;
  }
  return id;
}
function readLSMap(key){
  try { return JSON.parse(localStorage.getItem(key)) || {}; }
  catch (e) { return {}; }
}
/* Normalize the sims progress map: engines store {id:{completed:true,...}};
   tolerate the legacy/plain {id:true} shape too. */
function simDoneSet(){
  var m = readLSMap('ilb-bootcamp-' + SLUG + '-sims-v1'), out = {}, k, v;
  for (k in m){
    if (m.hasOwnProperty(k)){
      v = m[k];
      out[k] = !!(v && (v === true || v.completed === true));
    }
  }
  return out;
}
function domainMastery(){
  var out = {}, i, items, cl;
  var ds = (CONTENT && CONTENT.domains) || [];
  for (i = 0; i < ds.length; i++){
    items = domainItems(ds[i].name);
    cl = domainCleared(ds[i].name);
    out[ds[i].id] = { name: ds[i].name,
      pct: items.length ? Math.round(100 * cl / items.length) : 0,
      cleared: cl, total: items.length };
  }
  return out;
}
var KIND_VIEW = { lab: 'labs', simulation: 'exercises', mission: 'missions' };
var KIND_LABEL = { lab: 'lab', simulation: 'simulation', mission: 'mission' };
function nextRecommendations(limit){
  limit = limit || 3;
  var labsDone = readLSMap('ilb-bootcamp-' + SLUG + '-labs-v1');
  var simsDone = simDoneSet();
  var misDone = readLSMap('ilb-bootcamp-' + SLUG + '-missions-v1');
  var labs = (CONTENT && CONTENT.labs) || [];
  var sims = (CONTENT && CONTENT.simulations) || [];
  var missions = (CONTENT && CONTENT.terminalMissions) || [];
  var masteryMap = domainMastery();
  var recs = [], di, i, item;
  var order = weakestFirst(); /* domain names, weakest first */
  function firstIncomplete(list, doneSet){
    for (var k = 0; k < list.length; k++){
      if (!doneSet[list[k].id]) return list[k];
    }
    return null;
  }
  function byDomain(list, domainId){
    var out = [], k;
    for (k = 0; k < list.length; k++){
      if (list[k] && list[k].domain_id === domainId) out.push(list[k]);
    }
    return out;
  }
  for (di = 0; di < order.length && recs.length < limit; di++){
    var dName = order[di], dId = DOMAIN_IDS[dName];
    var m = masteryMap[dId] || { name: dName, pct: 0 };
    var cands = [
      { kind: 'lab', item: firstIncomplete(byDomain(labs, dId), labsDone) },
      { kind: 'simulation', item: firstIncomplete(byDomain(sims, dId), simsDone) },
      { kind: 'mission', item: firstIncomplete(byDomain(missions, dId), misDone) }
    ];
    for (i = 0; i < cands.length && recs.length < limit; i++){
      item = cands[i].item;
      if (!item) continue;
      recs.push({ kind: cands[i].kind, id: item.id, title: item.title,
        domain_id: dId, domain: dName,
        reason: 'Weakest domain \u00B7 ' + dName + ' at ' + m.pct + '% drill mastery' });
    }
  }
  return recs;
}
window.ILBProgress = {
  domainMastery: domainMastery,
  nextRecommendations: nextRecommendations,
  kindView: function (kind){ return KIND_VIEW[kind] || null; }
};

/* Queue: domains weakest-first; within each domain, uncleared (shuffled)
   before cleared (shuffled) so reps target gaps while keeping wins warm. */
function buildQueue(onlyDomain){
  var order = weakestFirst().filter(function(d){ return !onlyDomain || d === onlyDomain; });
  var q = [];
  order.forEach(function(d){
    var items = domainItems(d);
    var unm = shuffle(items.filter(function(s){ return !cleared(s.id); }));
    var mst = shuffle(items.filter(function(s){ return cleared(s.id); }));
    unm.concat(mst).forEach(function(s){ q.push(s.id); });
  });
  return q;
}

/* Simulation lineup: round-robin over weakest-first domains until SIM.items
   is reached; prefer uncleared scenarios so the sim hunts real gaps. */
function pickSimItems(){
  var order = weakestFirst();
  if (!order.length) return [];
  var picks = [], round = 0;
  while (picks.length < SIM.items && round < 40){
    var progressed = false;
    for (var i = 0; i < order.length && picks.length < SIM.items; i++){
      var items = domainItems(order[i]);
      var unm = items.filter(function(s){ return !cleared(s.id) && picks.indexOf(s.id) < 0; });
      var pool = unm.length ? unm : items.filter(function(s){ return picks.indexOf(s.id) < 0; });
      if (pool.length){
        picks.push(pool[Math.floor(Math.random() * pool.length)].id);
        progressed = true;
      }
    }
    if (!progressed) break;
    round++;
  }
  return picks;
}

/* ---------------- views ---------------- */
var VIEWS = ['dashboard', 'learn', 'workbench', 'terminal', 'labs',
  'exercises', 'console', 'missions', 'resources', 'simulation', 'behavioral'];
function showView(v){
  VIEWS.forEach(function(x){
    var sec = el('view-' + x);
    if (sec) sec.classList.toggle('active', x === v);
  });
  var btns = document.querySelectorAll('.nav button[data-view]');
  for (var i = 0; i < btns.length; i++)
    btns[i].classList.toggle('active', btns[i].getAttribute('data-view') === v);
  if (v === 'dashboard') renderDashboard();
  if (v === 'workbench' && bench.timerId){
    /* resume paused drill clock */
    bench.t0 = Date.now() - bench.elapsed * 1000; startBenchClock();
  }
  /* Notify decoupled view modules (learn/terminal/labs engines). */
  if (typeof document !== 'undefined' && document.dispatchEvent){
    try { document.dispatchEvent(new CustomEvent('ilb:view', {detail: v})); } catch(e){}
  }
  window.scrollTo(0, 0);
}
function bindNav(){
  var btns = document.querySelectorAll('.nav button[data-view]');
  for (var i = 0; i < btns.length; i++){
    (function(b){ b.addEventListener('click', function(){
      if (b.getAttribute('data-view') === 'workbench' && !bench.queue.length){
        startDrill(null, null); return; }
      showView(b.getAttribute('data-view'));
    }); })(btns[i]);
  }
}

/* ---------------- dashboard ---------------- */
var activeFilter = null;
function statusFor(id){ return cleared(id) ? 'done' : (attempted(id) ? 'seen' : 'new'); }
function readinessLabel(pct){
  if (pct >= 85) return 'ASSESSMENT-READY';
  if (pct >= 60) return 'DEVELOPING';
  if (pct > 0) return 'WARMING UP';
  return 'BASELINE';
}
function renderDashboard(){
  if (!TOTAL) return;
  var pct = overallPct(), cc = clearedCount();
  setText('overallPct', pct + '%'); setWidth('overallBar', pct);
  setText('clearedCount', String(cc)); setWidth('clearedBar', Math.round(100 * cc / TOTAL));
  setText('readinessLabel', readinessLabel(pct));

  var weak = weakestFirst()[0];
  var wm = Math.round(100 * mastery(weak));
  setText('nextPriority', weak + ' · ' + wm + '%'); setWidth('nextBar', wm);

  el('masteryRows').innerHTML = weakestFirst().map(function(d){
    var m = Math.round(100 * mastery(d));
    return '<div class="skill-row"><span>' + esc(d) + '</span>' +
      '<div class="bar" role="img" aria-label="' + esc(d) + ' mastery ' + m + ' percent">' +
      '<i style="width:' + m + '%"></i></div><b>' + m + '%</b></div>';
  }).join('');

  var np = el('nextPanel');
  /* Enterprise CBT: surface the top cross-engine recommendations
     (labs / simulations / missions in the weakest domains) when any
     exist; otherwise fall back to the classic next-scenario rep. */
  var recs = [];
  try { recs = window.ILBProgress.nextRecommendations(2); } catch (e) { recs = []; }
  if (recs.length){
    var rh = '<p class="eyebrow">YOUR NEXT REP</p><h3>Recommended next steps</h3>';
    for (var ri = 0; ri < recs.length; ri++){
      var rc = recs[ri], rv = window.ILBProgress.kindView(rc.kind);
      rh += '<div class="lab-meta" style="margin:10px 0 4px"><span class="tag hot">' +
        esc(KIND_LABEL[rc.kind].toUpperCase()) + '</span>' +
        '<span class="tag">' + esc(rc.domain) + ' · weakest</span></div>' +
        '<p style="margin:0 0 4px"><strong>' + esc(rc.title) + '</strong></p>' +
        '<p style="color:var(--muted);font-size:13px;margin:0 0 8px">' + esc(rc.reason) + '</p>' +
        '<button class="btn small primary" data-rec-view="' + esc(rv) +
        '" style="margin-bottom:10px">Start this ' + esc(KIND_LABEL[rc.kind]) + ' \u2192</button>';
    }
    np.innerHTML = rh;
    var rbtns = np.querySelectorAll('[data-rec-view]');
    for (var bi = 0; bi < rbtns.length; bi++){
      (function (b){
        b.addEventListener('click', function (){
          /* showView toggles the section + nav and dispatches ilb:view
             with the matching detail so the target engine renders. */
          showView(b.getAttribute('data-rec-view'));
        });
      })(rbtns[bi]);
    }
  } else {
  var q = buildQueue(), nextId = q.length ? q[0] : null;
  if (nextId){
    var s = BY_ID[nextId];
    np.innerHTML =
      '<p class="eyebrow">YOUR NEXT REP</p><h3>' + esc(s.title) + '</h3>' +
      '<div class="lab-meta"><span class="tag hot">' + esc(s.domain) + ' · weakest</span>' +
      '<span class="tag">~' + s.mins + ' min</span>' +
      '<span class="tag">' + statusFor(s.id).toUpperCase() + '</span></div>' +
      '<p>' + esc(s.desc) + '</p>' +
      '<button class="btn primary" id="nextRepBtn">Start this scenario →</button>';
    el('nextRepBtn').addEventListener('click', function(){ startDrill(null, s.id); });
  } else {
    np.innerHTML =
      '<p class="eyebrow">YOUR NEXT REP</p><h3>Queue complete.</h3>' +
      '<p>Every scenario is cleared. Run the timed simulation to prove it under pressure.</p>' +
      '<button class="btn primary" id="nextRepBtn">Stage the simulation →</button>';
    el('nextRepBtn').addEventListener('click', function(){ showView('simulation'); });
  }
  }

  var chips = ['<button class="filter' + (activeFilter ? '' : ' active') + '" data-f="">All domains</button>']
    .concat(DOMAINS.map(function(d){
      return '<button class="filter' + (activeFilter === d ? ' active' : '') +
        '" data-f="' + esc(d) + '" aria-pressed="' + (activeFilter === d) + '">' + esc(d) + '</button>';
    }));
  el('filters').innerHTML = chips.join('');
  var fbtns = el('filters').querySelectorAll('.filter');
  for (var i = 0; i < fbtns.length; i++){
    (function(b){ b.addEventListener('click', function(){
      activeFilter = b.getAttribute('data-f') || null; renderDashboard();
    }); })(fbtns[i]);
  }

  var list = SCEN.filter(function(s){ return !activeFilter || s.domain === activeFilter; });
  if (!list.length){ el('labGrid').innerHTML = '<div class="empty-note">No scenarios in this filter.</div>'; return; }
  el('labGrid').innerHTML = list.map(function(s){
    var st = statusFor(s.id);
    var badge = st === 'done' ? '<span class="score-badge done">✓ CLEARED</span>' :
      (st === 'seen' ? '<span class="score-badge">ATTEMPTED</span>' : '<span class="score-badge">NEW</span>');
    return '<button class="lab-card" data-id="' + esc(s.id) + '">' +
      '<span class="tag">' + esc(s.domain) + '</span><h3>' + esc(s.title) + '</h3>' +
      '<p>' + esc(s.desc) + '</p>' +
      '<div class="lab-footer"><span class="score-badge">~' + s.mins + ' MIN</span>' + badge + '</div></button>';
  }).join('');
  var cards = el('labGrid').querySelectorAll('.lab-card');
  for (var k = 0; k < cards.length; k++){
    (function(c){ c.addEventListener('click', function(){
      startDrill(activeFilter, c.getAttribute('data-id')); }); })(cards[k]);
  }
}
function setText(id, v){ var n = el(id); if (n) n.textContent = v; }
function setWidth(id, pct){ var n = el(id); if (n) n.style.width = pct + '%'; }

function bindDashboardButtons(){
  el('startAdaptive').addEventListener('click', function(){ startDrill(null, null); });
  el('gotoSim').addEventListener('click', function(){ showView('simulation'); });
  var resetArmed = false, resetTimer = null;
  el('resetProgress').addEventListener('click', function(){
    var btn = el('resetProgress');
    if (!resetArmed){
      resetArmed = true; btn.textContent = 'Click again to confirm reset';
      resetTimer = setTimeout(function(){
        resetArmed = false; btn.textContent = 'Reset all progress'; }, 4000);
      return;
    }
    clearTimeout(resetTimer); resetArmed = false; btn.textContent = 'Reset all progress';
    try { localStorage.removeItem(LS_KEY); } catch(e){}
    prog = {};
    renderDashboard(); toast('Progress cleared. Fresh start.');
  });
}

/* ---------------- workbench (adaptive drill) ---------------- */
var bench = { queue: [], idx: 0, selected: -1, submitted: false,
              t0: 0, elapsed: 0, timerId: null };

function startDrill(domain, startId){
  bench.queue = buildQueue(domain);
  if (!bench.queue.length){ toast('No scenarios available.'); return; }
  bench.idx = startId ? Math.max(0, bench.queue.indexOf(startId)) : 0;
  showView('workbench');
  renderBench();
}
function startBenchClock(){
  if (bench.timerId) clearInterval(bench.timerId);
  bench.timerId = setInterval(function(){
    bench.elapsed = Math.floor((Date.now() - bench.t0) / 1000);
    setText('benchTimer', fmtClock(bench.elapsed));
  }, 1000);
}
function renderRail(){
  el('railList').innerHTML = bench.queue.map(function(id, i){
    var s = BY_ID[id];
    var st = cleared(id) ? '<span class="st done">✓</span>' :
      (attempted(id) ? '<span class="st">•</span>' : '<span class="st">○</span>');
    return '<button class="rail-item' + (i === bench.idx ? ' active' : '') + '" data-i="' + i + '">' +
      st + '<span style="flex:1"><b>' + esc(s.title) + '</b><span>' +
      esc(s.domain) + ' · ~' + s.mins + 'm</span></span></button>';
  }).join('');
  var items = el('railList').querySelectorAll('.rail-item');
  for (var i = 0; i < items.length; i++){
    (function(b){ b.addEventListener('click', function(){
      bench.idx = parseInt(b.getAttribute('data-i'), 10); renderBench(); }); })(items[i]);
  }
}
function renderBench(){
  var item = BY_ID[bench.queue[bench.idx]];
  if (!item) return;
  bench.selected = -1; bench.submitted = false; bench.elapsed = 0;

  setText('wbEyebrow', item.domain.toUpperCase() + ' · ~' + item.mins + ' MIN · ' +
    (bench.idx + 1) + ' / ' + bench.queue.length);
  setText('wbTitle', item.title);
  setText('wbDesc', item.desc);
  setText('wbSituation', item.situation);
  el('wbObjectives').innerHTML =
    item.objectives.map(function(o){ return '<li>' + esc(o) + '</li>'; }).join('');
  setText('decisionPrompt', item.prompt || 'Choose the best next action');

  el('evidenceButtons').innerHTML = item.evidence.map(function(p, i){
    return '<button class="evidence-btn" data-i="' + i + '">' + esc(p[0]) + '</button>';
  }).join('');
  el('terminal').innerHTML =
    '<span class="dim">Open each evidence source before deciding. Read first; act second.</span>';
  var ebtns = el('evidenceButtons').querySelectorAll('.evidence-btn');
  for (var e = 0; e < ebtns.length; e++){
    (function(b){ b.addEventListener('click', function(){
      var p = item.evidence[parseInt(b.getAttribute('data-i'), 10)];
      b.classList.add('ran'); b.disabled = true;
      var term = el('terminal');
      if (term.querySelector('.dim')) term.innerHTML = '';
      term.innerHTML += '<div class="ev-block"><span class="prompt">$ ' + esc(p[0]) +
        '</span>\n' + esc(p[1]) + '</div>';
    }); })(ebtns[e]);
  }

  el('choices').innerHTML = item.choices.map(function(c, i){
    return '<button class="choice" data-i="' + i + '">' + esc(c) + '</button>';
  }).join('');
  var cbtns = el('choices').querySelectorAll('.choice');
  for (var c = 0; c < cbtns.length; c++){
    (function(b){ b.addEventListener('click', function(){
      if (bench.submitted) return;
      bench.selected = parseInt(b.getAttribute('data-i'), 10);
      for (var j = 0; j < cbtns.length; j++) cbtns[j].classList.remove('selected');
      b.classList.add('selected');
      el('submitChoice').disabled = false;
    }); })(cbtns[c]);
  }

  var hintText = el('hintText');
  hintText.classList.remove('show'); hintText.textContent = '';
  var hintBtn = el('hintBtn');
  if (item.hint){
    hintBtn.style.display = '';
    hintBtn.onclick = function(){
      hintText.textContent = item.hint; hintText.classList.add('show');
      hintBtn.style.display = 'none';
    };
  } else { hintBtn.style.display = 'none'; }

  var fb = el('feedback'); fb.className = 'feedback'; fb.innerHTML = '';
  var sub = el('submitChoice'); sub.disabled = true; sub.style.display = '';
  el('nextItem').style.display = 'none';
  el('skipItem').style.display = '';
  renderRail();

  bench.t0 = Date.now();
  setText('benchTimer', '00:00');
  startBenchClock();
}
function bindBench(){
  el('submitChoice').addEventListener('click', function(){
    var item = BY_ID[bench.queue[bench.idx]];
    if (!item || bench.submitted || bench.selected < 0) return;
    bench.submitted = true;
    var ok = bench.selected === item.answer;
    recordResult(item.id, ok);

    var cbtns = el('choices').querySelectorAll('.choice');
    for (var j = 0; j < cbtns.length; j++){
      cbtns[j].disabled = true;
      var ji = parseInt(cbtns[j].getAttribute('data-i'), 10);
      if (ji === item.answer) cbtns[j].classList.add('correct');
      else if (ji === bench.selected) cbtns[j].classList.add('wrong');
    }
    var fb = el('feedback');
    fb.className = 'feedback show ' + (ok ? 'ok' : 'no');
    fb.setAttribute('role', 'status');
    fb.innerHTML = '<strong>' + (ok ? 'Correct.' : 'Not quite — the best answer is highlighted above.') +
      '</strong><div>' + esc(item.why) + '</div>';
    el('submitChoice').style.display = 'none';
    el('skipItem').style.display = 'none';
    el('hintBtn').style.display = 'none';
    el('nextItem').style.display = '';
    renderRail();
  });
  el('nextItem').addEventListener('click', function(){
    bench.idx++;
    if (bench.idx >= bench.queue.length){
      toast('Queue complete — rebuilding around your weakest domains.');
      bench.queue = buildQueue();
      bench.idx = 0;
    }
    renderBench();
  });
  el('skipItem').addEventListener('click', function(){
    bench.idx = (bench.idx + 1) % bench.queue.length;
    renderBench();
  });
}

/* ---------------- simulation ---------------- */
var sim = null;
function verdict(p){
  if (p >= 85) return ['ASSESSMENT-READY',
    'You are operating at a hireable level across this path. Keep the weakest domains warm with short drills.'];
  if (p >= 70) return ['NEARLY READY',
    'Strong foundation with a few soft spots. Drill the domains below 70% until they clear, then run the simulation again.'];
  if (p >= 50) return ['DEVELOPING',
    'The instincts are forming but the gaps are real. Work the adaptive drill queue daily, weakest domain first.'];
  return ['FOUNDATIONS FIRST',
    'Too many misses across too many domains. Slow down: drill one domain at a time in the library before re-running the simulation.'];
}
function simModalText(){
  var cost = SIM.evidence_cost_mins > 0 ?
    ' Each evidence source you open costs ' + SIM.evidence_cost_mins + ' minutes.' : '';
  return 'The clock starts at ' + SIM.minutes + ':00. ' + SIM.items +
    ' scenarios are staged across all domains, weighted toward your weakest areas.' +
    ' Hints are disabled, each decision is final.' + cost + ' Progress is saved on this device.';
}
function bindSim(){
  el('openSim').addEventListener('click', function(){
    setText('modalTitle', 'Start the ' + SIM.minutes + '-minute run?');
    setText('modalDesc', simModalText());
    el('simModal').classList.add('show');
  });
  el('cancelSim').addEventListener('click', function(){ el('simModal').classList.remove('show'); });
  el('simModal').addEventListener('click', function(e){
    if (e.target === el('simModal')) el('simModal').classList.remove('show');
  });
  el('startSim').addEventListener('click', function(){
    el('simModal').classList.remove('show');
    var items = pickSimItems();
    if (!items.length){ toast('No scenarios available.'); return; }
    sim = { items: items, idx: 0, answers: {}, remaining: SIM.minutes * 60,
            timerId: null, selected: -1, submitted: false };
    el('simLanding').style.display = 'none';
    el('simResults').style.display = 'none';
    el('simActive').style.display = '';
    showView('simulation');
    renderSimItem();
    sim.timerId = setInterval(function(){
      sim.remaining--;
      if (sim.remaining <= 0){ endSim(true); return; }
      var t = el('simTimer');
      t.textContent = fmtClock(sim.remaining);
      t.classList.toggle('warn', sim.remaining < 600);
    }, 1000);
  });
  el('simSubmit').addEventListener('click', function(){
    var item = BY_ID[sim.items[sim.idx]];
    if (!sim || sim.submitted || sim.selected < 0) return;
    sim.submitted = true;
    var ok = sim.selected === item.answer;
    sim.answers[item.id] = ok;
    recordResult(item.id, ok);
    el('simSubmit').style.display = 'none';
    el('simNext').style.display = '';
  });
  el('simNext').addEventListener('click', function(){
    sim.idx++;
    if (sim.idx >= sim.items.length){ endSim(false); return; }
    renderSimItem();
  });
  el('endSimEarly').addEventListener('click', function(){ endSim(false); });
}
function renderSimItem(){
  var item = BY_ID[sim.items[sim.idx]];
  sim.selected = -1; sim.submitted = false;
  setText('simEyebrow', item.domain.toUpperCase() + ' · SCENARIO ' + (sim.idx + 1) +
    ' / ' + sim.items.length);
  setText('simTitle', item.title);
  setText('simSituation', item.situation);
  setText('simPrompt', item.prompt || 'Choose the best next action');
  setText('simProgress', (sim.idx + 1) + ' / ' + sim.items.length);

  el('simEvidence').innerHTML = item.evidence.map(function(p, i){
    return '<button class="evidence-btn" data-i="' + i + '">' + esc(p[0]) + '</button>';
  }).join('');
  el('simTerminal').innerHTML =
    '<span class="dim">Evidence is on the table. Decide like it counts — because it does.</span>';
  var ebtns = el('simEvidence').querySelectorAll('.evidence-btn');
  for (var e = 0; e < ebtns.length; e++){
    (function(b){ b.addEventListener('click', function(){
      var p = item.evidence[parseInt(b.getAttribute('data-i'), 10)];
      if (!b.disabled && SIM.evidence_cost_mins > 0){
        sim.remaining = Math.max(1, sim.remaining - SIM.evidence_cost_mins * 60);
        toast('Evidence opened: −' + SIM.evidence_cost_mins + ' min');
      }
      b.classList.add('ran'); b.disabled = true;
      var term = el('simTerminal');
      if (term.querySelector('.dim')) term.innerHTML = '';
      term.innerHTML += '<div class="ev-block"><span class="prompt">$ ' + esc(p[0]) +
        '</span>\n' + esc(p[1]) + '</div>';
    }); })(ebtns[e]);
  }

  el('simChoices').innerHTML = item.choices.map(function(c, i){
    return '<button class="choice" data-i="' + i + '">' + esc(c) + '</button>';
  }).join('');
  var cbtns = el('simChoices').querySelectorAll('.choice');
  for (var c = 0; c < cbtns.length; c++){
    (function(b){ b.addEventListener('click', function(){
      if (sim.submitted) return;
      sim.selected = parseInt(b.getAttribute('data-i'), 10);
      for (var j = 0; j < cbtns.length; j++) cbtns[j].classList.remove('selected');
      b.classList.add('selected');
      el('simSubmit').disabled = false;
    }); })(cbtns[c]);
  }
  var sub = el('simSubmit'); sub.disabled = true; sub.style.display = '';
  el('simNext').style.display = 'none';
}
function endSim(timedOut){
  if (sim.timerId) clearInterval(sim.timerId);
  var answered = Object.keys(sim.answers);
  var totalC = answered.reduce(function(a, id){ return a + (sim.answers[id] ? 1 : 0); }, 0);
  var pct = sim.items.length ? Math.round(100 * totalC / sim.items.length) : 0;
  var v = verdict(pct);

  var perDomain = {};
  answered.forEach(function(id){
    var s = BY_ID[id];
    perDomain[s.domain] = perDomain[s.domain] || {c:0, t:0};
    perDomain[s.domain].t++;
    if (sim.answers[id]) perDomain[s.domain].c++;
  });
  var breakdown = Object.keys(perDomain).map(function(d){
    var r = perDomain[d], m = Math.round(100 * r.c / r.t);
    return '<div class="sim-dom"><b>' + esc(d) + '</b>' + r.c + ' / ' + r.t +
      '<div class="bar"><i style="width:' + m + '%"></i></div></div>';
  }).join('');

  el('simActive').style.display = 'none';
  var res = el('simResults');
  res.style.display = '';
  res.innerHTML =
    '<article class="panel verdict"><p class="eyebrow">SIMULATION COMPLETE' +
    (timedOut ? ' · TIME EXPIRED' : '') + '</p>' +
    '<h2>' + v[0] + '</h2><p>' + esc(v[1]) + '</p>' +
    '<p style="margin-top:14px"><strong style="font-size:22px">' + totalC + ' / ' +
    sim.items.length + '</strong> <span style="color:var(--muted)">(' + pct + '%)</span></p></article>' +
    '<div class="sim-breakdown">' + breakdown + '</div>' +
    '<div class="action-row"><button class="btn primary" id="rerunSim">Run it again</button>' +
    '<button class="btn ghost" id="backToDash">Back to dashboard</button></div>';
  el('rerunSim').addEventListener('click', function(){
    el('simResults').style.display = 'none';
    el('simLanding').style.display = '';
    renderSimLanding();
  });
  el('backToDash').addEventListener('click', function(){ showView('dashboard'); });
  renderDashboard();
  showView('simulation');
}
function renderSimLanding(){
  setText('simStatItems', String(SIM.items));
  setText('simStatMins', String(SIM.minutes));
  setText('simStatDomains', String(DOMAINS.length));
}

/* ---------------- behavioral ---------------- */
var STAR_GUIDE = [
  ['S — Situation', 'Set the scene in one or two sentences: when, where, and what was at stake.'],
  ['T — Task', 'Your specific responsibility or goal — what you personally owned.'],
  ['A — Action', 'What YOU did, step by step. Use "I", not "we". This is the core; give it half your time.'],
  ['R — Result', 'How it turned out — the measurable outcome — then the lesson you carried forward.']
];
function renderBehavioral(){
  var grid = el('starGrid');
  if (grid){
    grid.innerHTML = STAR_GUIDE.map(function(g){
      return '<div class="star-card"><b>' + esc(g[0]) + '</b><p>' + esc(g[1]) + '</p></div>';
    }).join('');
  }
  var items = (CONTENT.behavioral || []);
  el('behList').innerHTML = items.length ? items.map(function(b){
    var pts = (b.points || []).map(function(p){ return '<li>' + esc(p) + '</li>'; }).join('');
    var pits = (b.pitfalls || []).map(function(p){ return '<li>' + esc(p) + '</li>'; }).join('');
    return '<article class="beh-item"><h3>' + esc(b.prompt) + '</h3>' +
      '<p class="beh-framework">FRAMEWORK: ' + esc(b.framework || 'STAR') + '</p>' +
      '<div class="beh-cols"><div><h4>Hit these points</h4><ul>' + pts + '</ul></div>' +
      '<div><h4 class="pitfalls">Avoid</h4><ul class="pitfalls">' + pits + '</ul></div></div></article>';
  }).join('') : '<div class="empty-note">Behavioral prompts are on the way.</div>';
}

/* ---------------- boot ---------------- */
function renderHero(){
  setText('heroTitle', CONTENT.title);
  setText('heroTagline', CONTENT.tagline);
  setText('statScenarios', String(TOTAL));
  setText('statDomains', String(DOMAINS.length));
  setText('statSim', String(SIM.minutes));
  var v = CONTENT.vendor || {};
  setText('heroVendor', [v.name, v.certs].filter(Boolean).join(' · '));
  var d = el('heroDisclaimer');
  if (d) d.textContent = CONTENT.disclaimer || '';
  document.title = CONTENT.title + ' — Certification Bootcamp';
}

function showError(msg){
  document.querySelector('main').innerHTML =
    '<div class="wrap"><div class="empty-note" style="margin-top:60px">' +
    '<h2 style="color:var(--ink)">Content is on the way</h2><p>' + esc(msg) + '</p>' +
    '<p><a href="' + esc(PAGE.hubUrl || '../../index.html') + '">← Back to the catalog hub</a></p></div></div>';
}

function boot(){
  bindNav(); bindBench(); bindSim(); bindDashboardButtons();
  renderSimLandingStatic();

  fetch('./content.json', {cache: 'no-store'})
    .then(function(r){
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function(content){
      ingest(content);
      if (!TOTAL) throw new Error('No scenarios found in content.json.');
      renderHero();
      renderSimLanding();
      renderBehavioral();
      renderDashboard();
      showView('dashboard');
    })
    .catch(function(err){
      showError('This bootcamp\'s training content is being built. Check back soon. (' +
        err.message + ')');
    });
}

/* Static sim-landing numbers before content loads (progressive enhancement). */
function renderSimLandingStatic(){
  setText('simStatItems', '–'); setText('simStatMins', '–'); setText('simStatDomains', '–');
}

/* Testing seam: when window.ENGINE_TEST is truthy (never set by the
   generator shells), expose pure internals for headless validation.
   See test/smoke.js. */
if (typeof window !== 'undefined' && window.ENGINE_TEST){
  window.__bootcampEngine = {
    ingest: ingest, weakestFirst: weakestFirst, buildQueue: buildQueue,
    pickSimItems: pickSimItems, verdict: verdict, mastery: mastery,
    recordResult: recordResult, cleared: cleared, overallPct: overallPct,
    domainMastery: domainMastery, nextRecommendations: nextRecommendations,
    get SCEN(){ return SCEN; }, get DOMAINS(){ return DOMAINS; },
    get SIM(){ return SIM; }
  };
}

if (document.readyState === 'loading')
  document.addEventListener('DOMContentLoaded', boot);
else
  boot();

})();
