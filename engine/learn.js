/* Interstitium Labs — Learn view: animated slide-lecture renderer (workstream A).
   Vanilla JS, zero dependencies, ES5-compatible.
   Renders into the existing #learnBody inside #view-learn (static markup lives
   in templates/bootcamp.html). Listens for the coordinator's CustomEvent
   'ilb:view' with e.detail === 'learn'.

   Lecture ids:
     c-<domain_id>  -> built at runtime from content.json lessons[] (slide transform)
     f-<track>-<i>  -> engine/foundations.json tracks[track].lectures[i] (slide-model)
     m-<math_id>    -> expands to ALL lectures of engine/math.json modules[math_id]

   Progress persists to localStorage 'ilb-bootcamp-<slug>-lectures-v1'. */
(function () {
'use strict';

var SLUG = (window.BOOTCAMP_PAGE && window.BOOTCAMP_PAGE.slug) || '';
var LS_LECTURES = 'ilb-bootcamp-' + SLUG + '-lectures-v1';
var LS_LABS = 'ilb-bootcamp-' + SLUG + '-labs-v1';
var LS_DRILL = 'ilb-bootcamp-' + SLUG + '-v1';

/* ---------------- state ---------------- */
var S = {
  loaded: false,
  loading: false,
  content: null,       /* ./content.json */
  foundations: null,    /* ../engine/foundations.json */
  math: null,           /* ../engine/math.json */
  level: 'overview',   /* overview | lectures | deck */
  sectionId: null,
  deck: null,          /* {lid, title, slides, idx} */
  doneLect: {},
  timers: []
};

/* ---------------- utils ---------------- */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function $(id) { return document.getElementById(id); }

function loadJSON(url) {
  return fetch(url).then(function (r) {
    if (!r.ok) throw new Error('missing');
    return r.json();
  }).catch(function () { return null; });
}
function loadDone() {
  try { return JSON.parse(localStorage.getItem(LS_LECTURES)) || {}; }
  catch (e) { return {}; }
}
function saveDone() {
  try { localStorage.setItem(LS_LECTURES, JSON.stringify(S.doneLect)); }
  catch (e) { /* storage unavailable — session-only progress */ }
}
function loadDrillProg() {
  try { return JSON.parse(localStorage.getItem(LS_DRILL)) || {}; }
  catch (e) { return {}; }
}
function loadLabsDone() {
  try { return JSON.parse(localStorage.getItem(LS_LABS)) || {}; }
  catch (e) { return {}; }
}
function clearTimers() {
  for (var i = 0; i < S.timers.length; i++) clearInterval(S.timers[i]);
  S.timers = [];
}

/* ---------------- inline deck stylesheet (selectors not in the theme) ---------------- */
var DECK_CSS = [
  '.learn-crumb{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 14px}',
  '.learn-counter{font:600 12px var(--mono);color:var(--muted)}',
  '.learn-deck{max-width:860px}',
  '.learn-stage{min-height:340px}',
  '.learn-slide{animation:learnIn .45s ease}',
  '@keyframes learnIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}',
  '.learn-slide h3{margin:0 0 14px;font-size:clamp(22px,3vw,30px);letter-spacing:-.03em}',
  '.learn-lede{color:var(--muted);font-size:16px;max-width:640px}',
  '.learn-points{margin:0 0 16px;padding:0;list-style:none;display:grid;gap:10px}',
  '.learn-points li{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:12px 16px;font-size:14px;line-height:1.55}',
  '.learn-dots{display:flex;gap:8px;justify-content:center;margin:18px 0 6px;flex-wrap:wrap}',
  '.learn-dot{width:11px;height:11px;border-radius:50%;border:1px solid var(--line-strong);background:transparent;padding:0;cursor:pointer}',
  '.learn-dot.on{background:var(--accent);border-color:var(--accent)}',
  '.learn-decknav{display:flex;gap:10px;align-items:center;justify-content:space-between;margin-top:14px;flex-wrap:wrap}',
  '.learn-narration{margin-top:16px;font-size:13px;color:var(--muted)}',
  '.learn-narration summary{cursor:pointer;font:600 11px var(--mono);letter-spacing:.06em;color:var(--accent)}',
  '.learn-narration p{margin:8px 0 0;line-height:1.6}',
  '.learn-diagram{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:18px;margin:0 0 14px;overflow-x:auto}',
  '.learn-diagram svg{display:block;margin:auto;max-width:100%}',
  '.learn-diagram .dnode{opacity:0;animation:dpop .5s ease forwards}',
  '@keyframes dpop{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}',
  '.learn-diagram .dbox{fill:var(--surface-2);stroke:var(--accent);stroke-width:1.5}',
  '.learn-diagram .dtext{fill:var(--ink);font:600 13px var(--mono);text-anchor:middle}',
  '.learn-diagram .dedge{stroke:var(--muted);stroke-width:1.5;fill:none}',
  '.learn-diagram .dtitle{fill:var(--muted);font:600 11px var(--mono);text-anchor:middle;letter-spacing:.08em}',
  '.learn-note{color:var(--muted);font-size:13px;margin:0 0 4px}',
  '.learn-code{position:relative}',
  '.learn-code.typing pre::after{content:"▍";color:var(--accent);animation:blink 1s steps(1) infinite}',
  '@keyframes blink{50%{opacity:0}}',
  '.learn-path{display:grid;gap:14px}',
  '.learn-sec{display:flex;gap:16px;align-items:center;justify-content:space-between;flex-wrap:wrap;cursor:pointer;text-align:left;width:100%}',
  '.learn-secstats{display:flex;gap:18px;flex-wrap:wrap;font:600 12px var(--mono);color:var(--muted)}',
  '.learn-secstats b{color:var(--ink)}',
  '.learn-bar{height:8px;background:var(--surface-2);border-radius:99px;overflow:hidden;margin-top:10px}',
  '.learn-bar i{display:block;height:100%;background:var(--accent);border-radius:99px;transition:width .4s ease}',
  '.learn-lectrow{display:flex;gap:12px;align-items:center;justify-content:space-between;cursor:pointer;width:100%;text-align:left}',
  '.learn-badge{font:600 10px var(--mono);letter-spacing:.08em;color:var(--accent);border:1px solid var(--accent);border-radius:99px;padding:3px 10px;white-space:nowrap}',
  '.learn-check{color:var(--accent);font-weight:800}',
  '.learn-soon{color:var(--muted);font-size:13px;font-style:italic}',
  '.learn-media-figure{margin:0;background:var(--surface);border:1px solid var(--line);' +
    'border-radius:var(--radius);padding:18px;max-width:100%}',
  '.learn-media-figure img{display:block;max-width:100%;height:auto;margin:0 auto}',
  '.learn-media-figure figcaption{margin-top:12px;color:var(--muted);font-size:13px;' +
    'line-height:1.6;text-align:center}',
  '.learn-resources{display:grid;gap:16px;max-width:860px}',
  '.learn-gloss{display:grid;gap:10px;margin:0}',
  '.learn-gloss div{background:var(--surface);border:1px solid var(--line);border-radius:10px;' +
    'padding:12px 16px;font-size:14px}',
  '.learn-gloss dt{font-weight:700}',
  '.learn-gloss dd{margin:2px 0 0;color:var(--muted)}',
  '.learn-checklist{list-style:none;margin:0;padding:0;display:grid;gap:8px}',
  '.learn-checklist li{background:var(--surface);border:1px solid var(--line);border-radius:10px;' +
    'padding:10px 14px;font-size:14px}',
  '.learn-links{list-style:none;margin:0;padding:0;display:grid;gap:8px}',
  '.learn-links li{background:var(--surface);border:1px solid var(--line);border-radius:10px;' +
    'padding:10px 14px;font-size:14px}',
  '.learn-links a{color:var(--accent)}',
  '@media (prefers-reduced-motion: reduce){.learn-slide,.learn-diagram .dnode{animation:none;opacity:1}}'
].join('\n');
var cssInjected = false;
function injectCSS() {
  if (cssInjected || !document.head) return;
  var st = document.createElement('style');
  st.setAttribute('data-learn-deck', '1');
  st.textContent = DECK_CSS;
  document.head.appendChild(st);
  cssInjected = true;
}

/* ---------------- lessons -> slides transform ---------------- */
function diagramTypeFor(concepts) {
  var t = concepts.join(' ').toLowerCase();
  if (/(cycle|circular|feedback loop|round-trip|round trip|iterat)/.test(t)) return 'cycle';
  if (/( vs |versus|compared|comparison|difference between|trade-?off|instead of|rather than|on the other hand)/.test(t)) return 'compare';
  if (/(timeline|step|sequence|pipeline|lifecycle|stage|phase|first,|then,|finally|in order|workflow)/.test(t)) return 'timeline';
  if (/(hierarchy|tree|parent|child|root|branch)/.test(t)) return 'hierarchy';
  if (/(layer|stack|tier)/.test(t)) return 'layers';
  return 'flow';
}
function shortLabel(concept) {
  var head = String(concept).split(':')[0];
  head = head.split(/[—–]/)[0];            /* drop em/en-dash tails */
  head = head.replace(/\([^)]*\)/g, ' '); /* drop parentheticals */
  head = head.replace(/\s+/g, ' ').trim();
  var words = head.split(' ');
  if (words.length > 4) words = words.slice(0, 4);
  var glue = { with: 1, or: 1, and: 1, the: 1, a: 1, an: 1, of: 1, to: 1,
    for: 1, in: 1, on: 1, that: 1, as: 1, by: 1, from: 1 };
  while (words.length > 1 && glue[words[words.length - 1].toLowerCase()]) words.pop();
  var label = words.join(' ');
  if (label.length > 22) label = label.slice(0, 21).replace(/\s+\S*$/, '') + '…';
  return label;
}
function extractNodes(concepts) {
  var nodes = [], seen = {};
  for (var i = 0; i < concepts.length && nodes.length < 5; i++) {
    var label = shortLabel(concepts[i]).replace(/[.\s]+$/, '');
    var key = label.toLowerCase();
    if (label && !seen[key]) { seen[key] = 1; nodes.push(label); }
  }
  return nodes;
}
function narrate(kind, p) {
  if (kind === 'title') return 'This lecture is "' + p.heading + '". ' + p.lede;
  if (kind === 'bullets') {
    if (p.heading === 'Common pitfalls') {
      return 'The traps to avoid in this lecture: ' + p.bullets.join(' ');
    }
    var ord = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth'];
    var parts = [];
    for (var i = 0; i < p.bullets.length; i++) {
      parts.push((ord[i] || 'Next') + ': ' + p.bullets[i]);
    }
    return 'The key ideas in this lecture. ' + parts.join(' ');
  }
  if (kind === 'diagram') {
    return 'Picture these ideas as a ' + p.diagram.type + ' diagram: ' +
      p.diagram.nodes.join('; ') + '. ' + (p.diagram.note || '');
  }
  if (kind === 'code') {
    return 'A worked example in ' + p.code.lang + '. ' + p.walkthrough;
  }
  if (kind === 'tryit') return p.text + ' Use the button below to jump to the Terminal tab and try it now.';
  return '';
}
function lessonToSlides(lesson, domainName) {
  var concepts = lesson.concepts || [];
  var pitfalls = lesson.pitfalls || [];
  var ex = lesson.example || { lang: 'text', code: '', walkthrough: '' };
  var dtype = diagramTypeFor(concepts);
  var nodes = extractNodes(concepts);
  var titleSlide = { kind: 'title', heading: lesson.title,
    lede: 'A guided lecture on ' + domainName + ': learn the core ideas first, see them worked, dodge the common traps, then try it yourself in the terminal.' };
  titleSlide.narration = narrate('title', titleSlide);
  var conceptSlide = { kind: 'bullets', heading: 'Key concepts', bullets: concepts };
  conceptSlide.narration = narrate('bullets', conceptSlide);
  var diagramSlide = { kind: 'diagram', heading: 'How the ideas fit together',
    diagram: { type: dtype, title: domainName, nodes: nodes,
      note: 'Each node is one key idea from this lecture; follow the shape to see how they connect.' } };
  diagramSlide.narration = narrate('diagram', diagramSlide);
  var codeSlide = { kind: 'code', heading: 'Worked example',
    code: { lang: ex.lang || 'text', code: ex.code || '' }, walkthrough: ex.walkthrough || '' };
  codeSlide.narration = narrate('code', codeSlide);
  var pitSlide = { kind: 'bullets', heading: 'Common pitfalls', bullets: pitfalls };
  pitSlide.narration = narrate('bullets', pitSlide);
  var trySlide = { kind: 'tryit', heading: 'Try it yourself', text: lesson.try_it || 'Try it now in the Terminal tab →' };
  trySlide.narration = narrate('tryit', trySlide);
  return [titleSlide, conceptSlide, diagramSlide, codeSlide, pitSlide, trySlide];
}

/* ---------------- lecture resolution ---------------- */
function lessonByDomain(domainId) {
  var lessons = (S.content && S.content.lessons) || [];
  for (var i = 0; i < lessons.length; i++) {
    if (lessons[i].domain_id === domainId) return lessons[i];
  }
  return null;
}
function domainNameById(domainId) {
  var domains = (S.content && S.content.domains) || [];
  for (var i = 0; i < domains.length; i++) {
    if (domains[i].id === domainId) return domains[i].name || domainId;
  }
  return domainId;
}
/* Normalize any lecture source to {lid, title, slides, badge}. */
function asLecture(lid, obj, badge) {
  if (!obj || !obj.slides || !obj.slides.length) return null;
  return { lid: lid, title: obj.title || lid, slides: obj.slides, badge: badge };
}
function resolveCoreLecture(lid) {
  var domainId = lid.slice(2);
  var lesson = lessonByDomain(domainId);
  if (!lesson) return null;
  var slides = lessonToSlides(lesson, domainNameById(domainId));
  insertMediaSlides(slides, lid); /* enterprise CBT: media[] diagrams after the example slide */
  return { lid: lid, title: lesson.title, slides: slides, badge: 'LECTURE' };
}

/* ---------------- enterprise CBT: embedded media ----------------
   media[] entries whose lesson_ref matches the lesson card id
   (c-<domain_id>) render as extra slides inserted right after the
   worked-example ("code") slide. Degrades gracefully when media[] is
   absent or empty. */
function mediaForLesson(lid) {
  var media = (S.content && S.content.media) || [];
  var out = [], i;
  for (i = 0; i < media.length; i++) {
    if (media[i] && media[i].lesson_ref === lid && media[i].svg) out.push(media[i]);
  }
  return out;
}
function insertMediaSlides(slides, lid) {
  var items = mediaForLesson(lid);
  if (!items.length) return;
  var at = slides.length, i, j;
  for (i = 0; i < slides.length; i++) {
    if (slides[i] && slides[i].kind === 'code') { at = i + 1; break; }
  }
  var extra = [];
  for (j = 0; j < items.length; j++) {
    extra.push({ kind: 'figure', heading: items[j].title || 'Diagram',
      media: { svg: items[j].svg, caption: items[j].caption || '',
        alt: items[j].alt || items[j].title || 'Diagram' } });
  }
  Array.prototype.splice.apply(slides, [at, 0].concat(extra));
}
function resolveFoundationLecture(lid) {
  /* f-<track>-<i> */
  var m = /^f-(.+)-(\d+)$/.exec(lid);
  if (!m || !S.foundations) return null;
  var tracks = S.foundations.tracks || {};
  var track = tracks[m[1]];
  var lectures = (track && track.lectures) || [];
  var lec = lectures[parseInt(m[2], 10)];
  return asLecture(lid, lec, 'FOUNDATION');
}
function expandMathLectures(mid) {
  /* m-<math_id> -> every lecture of the module */
  if (!S.math) return [];
  var modules = S.math.modules || {};
  var mod = modules[mid];
  var lectures = (mod && mod.lectures) || (Array.isArray(mod) ? mod : []);
  var out = [];
  for (var i = 0; i < lectures.length; i++) {
    var lec = asLecture('m-' + mid + '-' + i, lectures[i], 'MATH');
    if (lec) out.push(lec);
  }
  return out;
}
/* Full ordered lecture list for a section, with unresolvable ids skipped. */
function resolveSectionLectures(section) {
  var out = [];
  var ids = section.lectures || [];
  for (var i = 0; i < ids.length; i++) {
    var lid = ids[i];
    if (lid.indexOf('m-') === 0) {
      var expanded = expandMathLectures(lid.slice(2));
      for (var j = 0; j < expanded.length; j++) out.push(expanded[j]);
    } else if (lid.indexOf('f-') === 0) {
      var f = resolveFoundationLecture(lid);
      if (f) out.push(f);
    } else if (lid.indexOf('c-') === 0) {
      var c = resolveCoreLecture(lid);
      if (c) out.push(c);
    }
  }
  return out;
}

/* ---------------- progress ---------------- */
function drillMastery(domainIds) {
  if (!domainIds || !domainIds.length || !S.content) return null;
  var prog = loadDrillProg();
  var total = 0, cleared = 0;
  var domains = S.content.domains || [];
  for (var d = 0; d < domains.length; d++) {
    if (domainIds.indexOf(domains[d].id) < 0) continue;
    var scs = domains[d].scenarios || [];
    for (var s = 0; s < scs.length; s++) {
      total++;
      var rec = prog[scs[s].id];
      if (rec && rec.c > 0) cleared++;
    }
  }
  if (!total) return null;
  return Math.round(100 * cleared / total);
}
function sectionStats(section) {
  var lectures = resolveSectionLectures(section);
  var doneL = 0;
  for (var i = 0; i < lectures.length; i++) {
    if (S.doneLect[lectures[i].lid]) doneL++;
  }
  var labsDone = loadLabsDone();
  var doneLabs = 0;
  var labIds = section.lab_ids || [];
  for (var j = 0; j < labIds.length; j++) {
    if (labsDone[labIds[j]]) doneLabs++;
  }
  return { lectures: lectures, doneLect: doneL,
    labIds: labIds, doneLabs: doneLabs,
    mastery: drillMastery(section.drill_domain_ids) };
}

/* ---------------- SVG diagram builder (6 types, staggered reveal) ---------------- */
function dnode(x, y, w, h, label, delay) {
  return '<g class="dnode" style="animation-delay:' + delay + 'ms">' +
    '<rect class="dbox" x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="10"/>' +
    '<text class="dtext" x="' + (x + w / 2) + '" y="' + (y + h / 2 + 5) + '">' + esc(label) + '</text></g>';
}
function dedge(x1, y1, x2, y2) {
  return '<line class="dedge" x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" marker-end="url(#darrow)"/>';
}
function defsArrow() {
  return '<defs><marker id="darrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">' +
    '<path d="M0,0 L8,4 L0,8" fill="none" stroke="var(--muted)" stroke-width="1.5"/></marker></defs>';
}
function buildDiagram(d) {
  var nodes = (d.nodes || []).slice(0, 5);
  if (!nodes.length) nodes = ['Concept'];
  var type = d.type || 'flow';
  var svg = '', W = 720;
  if (type === 'flow') {
    var bw = 150, bh = 64, gap = 44;
    var totalW = nodes.length * bw + (nodes.length - 1) * gap;
    var x = (W - totalW) / 2, y = 44, H = 150;
    svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(d.title || 'diagram') + '">' + defsArrow();
    svg += '<text class="dtitle" x="' + W / 2 + '" y="20">' + esc((d.title || '').toUpperCase()) + '</text>';
    for (var i = 0; i < nodes.length; i++) {
      if (i > 0) svg += dedge(x - gap + 6, y + bh / 2, x - 6, y + bh / 2);
      svg += dnode(x, y, bw, bh, nodes[i], i * 160);
      x += bw + gap;
    }
    svg += '</svg>';
  } else if (type === 'layers') {
    var lw = 430, lh = 54, lgap = 20, ly = 40;
    var LH = ly + nodes.length * (lh + lgap) + 10;
    svg = '<svg viewBox="0 0 ' + W + ' ' + LH + '" role="img" aria-label="' + esc(d.title || 'diagram') + '">' + defsArrow();
    svg += '<text class="dtitle" x="' + W / 2 + '" y="20">' + esc((d.title || '').toUpperCase()) + '</text>';
    for (var j = 0; j < nodes.length; j++) {
      svg += dnode((W - lw) / 2, ly, lw, lh, nodes[j], j * 160);
      ly += lh + lgap;
    }
    svg += '</svg>';
  } else if (type === 'cycle') {
    var cx = W / 2, cy = 165, r = 105, CH = 330;
    svg = '<svg viewBox="0 0 ' + W + ' ' + CH + '" role="img" aria-label="' + esc(d.title || 'diagram') + '">' + defsArrow();
    svg += '<text class="dtitle" x="' + W / 2 + '" y="20">' + esc((d.title || '').toUpperCase()) + '</text>';
    svg += '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="var(--line-strong)" stroke-width="1.5" stroke-dasharray="6 5"/>';
    for (var k = 0; k < nodes.length; k++) {
      var a = -Math.PI / 2 + k * 2 * Math.PI / nodes.length;
      var nx = cx + r * Math.cos(a) - 75, ny = cy + r * Math.sin(a) - 28;
      svg += dnode(nx, ny, 150, 56, nodes[k], k * 160);
    }
    svg += '</svg>';
  } else if (type === 'compare') {
    var half = Math.ceil(nodes.length / 2);
    var left = nodes.slice(0, half), right = nodes.slice(half);
    var cw = 280, chh = 56, cgap = 22;
    var rows = Math.max(left.length, right.length);
    var HH = 60 + rows * (chh + cgap) + 10;
    svg = '<svg viewBox="0 0 ' + W + ' ' + HH + '" role="img" aria-label="' + esc(d.title || 'diagram') + '">' + defsArrow();
    svg += '<text class="dtitle" x="' + W / 2 + '" y="20">' + esc((d.title || '').toUpperCase()) + '</text>';
    svg += '<line class="dedge" x1="' + W / 2 + '" y1="44" x2="' + W / 2 + '" y2="' + (HH - 12) + '" stroke-dasharray="5 5"/>';
    svg += '<text class="dtitle" x="' + W / 2 + '" y="' + (HH - 16) + '">VS</text>';
    var yy = 48;
    for (var q = 0; q < rows; q++) {
      if (left[q]) svg += dnode(30, yy, cw, chh, left[q], q * 160);
      if (right[q]) svg += dnode(W - 30 - cw, yy, cw, chh, right[q], q * 160 + 80);
      yy += chh + cgap;
    }
    svg += '</svg>';
  } else if (type === 'hierarchy') {
    var hw = 170, hh = 56;
    var kids = nodes.slice(1);
    var totalKW = kids.length * hw + Math.max(0, kids.length - 1) * 30;
    var kx = (W - totalKW) / 2, ky = 150;
    var YH = ky + hh + 30;
    svg = '<svg viewBox="0 0 ' + W + ' ' + YH + '" role="img" aria-label="' + esc(d.title || 'diagram') + '">' + defsArrow();
    svg += '<text class="dtitle" x="' + W / 2 + '" y="20">' + esc((d.title || '').toUpperCase()) + '</text>';
    svg += dnode(W / 2 - hw / 2, 44, hw, hh, nodes[0], 0);
    for (var z = 0; z < kids.length; z++) {
      svg += '<line class="dedge" x1="' + W / 2 + '" y1="100" x2="' + (kx + hw / 2) + '" y2="' + ky + '"/>';
      svg += dnode(kx, ky, hw, hh, kids[z], (z + 1) * 160);
      kx += hw + 30;
    }
    svg += '</svg>';
  } else { /* timeline */
    var tx0 = 70, tx1 = W - 70, ty = 90, TH = 190;
    svg = '<svg viewBox="0 0 ' + W + ' ' + TH + '" role="img" aria-label="' + esc(d.title || 'diagram') + '">' + defsArrow();
    svg += '<text class="dtitle" x="' + W / 2 + '" y="20">' + esc((d.title || '').toUpperCase()) + '</text>';
    svg += '<line class="dedge" x1="' + tx0 + '" y1="' + ty + '" x2="' + tx1 + '" y2="' + ty + '"/>';
    for (var w = 0; w < nodes.length; w++) {
      var px = nodes.length === 1 ? (tx0 + tx1) / 2 : tx0 + w * (tx1 - tx0) / (nodes.length - 1);
      svg += '<g class="dnode" style="animation-delay:' + w * 160 + 'ms">' +
        '<circle cx="' + px + '" cy="' + ty + '" r="9" fill="var(--accent)"/>' +
        '<text class="dtext" x="' + px + '" y="' + (ty + 34) + '">' + esc(nodes[w]) + '</text></g>';
    }
    svg += '</svg>';
  }
  return svg;
}

/* ---------------- slide rendering ---------------- */
function transcriptHTML(narration) {
  if (!narration) return '';
  return '<details class="learn-narration"><summary>TRANSCRIPT</summary><p>' +
    esc(narration) + '</p></details>';
}
function slideHTML(slide) {
  var h = '';
  if (slide.kind === 'title') {
    h = '<div class="learn-slide"><p class="eyebrow">INTERSTITIUM LABS · LECTURE</p>' +
      '<h2 style="font-size:clamp(28px,4vw,44px);letter-spacing:-.04em;margin:0 0 12px">' + esc(slide.heading) + '</h2>' +
      '<p class="learn-lede">' + esc(slide.lede || '') + '</p>' +
      transcriptHTML(slide.narration) + '</div>';
  } else if (slide.kind === 'bullets') {
    h = '<div class="learn-slide"><p class="eyebrow">' +
      (slide.heading === 'Common pitfalls' ? 'WATCH OUT' : 'STUDY HALL') + '</p>' +
      '<h3>' + esc(slide.heading) + '</h3><ul class="learn-points">';
    for (var i = 0; i < slide.bullets.length; i++) {
      h += '<li>' + esc(slide.bullets[i]) + '</li>';
    }
    h += '</ul>' + transcriptHTML(slide.narration) + '</div>';
  } else if (slide.kind === 'diagram') {
    h = '<div class="learn-slide"><p class="eyebrow">VISUAL MAP</p>' +
      '<h3>' + esc(slide.heading) + '</h3>' +
      '<div class="learn-diagram" id="learnDiagram"></div>' +
      '<p class="learn-note">' + esc((slide.diagram && slide.diagram.note) || '') + '</p>' +
      transcriptHTML(slide.narration) + '</div>';
  } else if (slide.kind === 'code') {
    h = '<div class="learn-slide"><p class="eyebrow">WORKED EXAMPLE</p>' +
      '<h3>' + esc(slide.heading) + '</h3>' +
      '<div class="learn-example learn-code typing"><span class="learn-lang">' + esc(slide.code.lang) + '</span>' +
      '<pre id="learnCodePre"></pre></div>' +
      '<p class="learn-walkthrough">' + esc(slide.walkthrough || '') + '</p>' +
      transcriptHTML(slide.narration) + '</div>';
  } else if (slide.kind === 'figure') {
    /* enterprise CBT: embedded media[] diagram (SVG <img> + caption) */
    var m = slide.media || {};
    h = '<div class="learn-slide"><p class="eyebrow">DIAGRAM</p>' +
      '<h3>' + esc(slide.heading) + '</h3>' +
      '<figure class="learn-media-figure">' +
      '<img src="./' + esc(m.svg) + '" alt="' + esc(m.alt || slide.heading) + '" loading="lazy" />' +
      (m.caption ? '<figcaption>' + esc(m.caption) + '</figcaption>' : '') +
      '</figure>' + transcriptHTML(slide.narration || '') + '</div>';
  } else if (slide.kind === 'tryit') {
    h = '<div class="learn-slide"><p class="eyebrow">YOUR TURN</p>' +
      '<h3>' + esc(slide.heading) + '</h3>' +
      '<p class="learn-tryit">' + esc(slide.text) + '</p>' +
      '<div class="cta-row" style="margin-top:16px"><button class="btn primary" data-act="goto-terminal">Open the Terminal tab →</button></div>' +
      transcriptHTML(slide.narration) + '</div>';
  } else {
    h = '<div class="learn-slide"><h3>' + esc(slide.heading || 'Slide') + '</h3></div>';
  }
  return h;
}

/* ---------------- deck ---------------- */
function completeLecture(lid) {
  if (S.doneLect[lid]) return;
  S.doneLect[lid] = true;
  saveDone();
}
function deckHTML() {
  var deck = S.deck;
  var n = deck.slides.length;
  var h = '<div class="learn-deck">';
  h += '<div class="learn-crumb"><button class="btn small ghost" data-act="back">← Lectures</button>' +
    '<span class="learn-counter">' + (deck.idx + 1) + ' / ' + n + '</span></div>';
  h += '<div class="learn-stage" id="learnStage"></div>';
  h += '<div class="learn-dots" role="group" aria-label="Slides">';
  for (var i = 0; i < n; i++) {
    h += '<button class="learn-dot' + (i === deck.idx ? ' on' : '') + '" data-act="dot" data-i="' + i +
      '" aria-label="Go to slide ' + (i + 1) + '"></button>';
  }
  h += '</div>';
  h += '<div class="learn-decknav">';
  h += '<button class="btn secondary" data-act="prev"' + (deck.idx === 0 ? ' disabled' : '') + '>← Prev</button>';
  var slide = deck.slides[deck.idx];
  if (slide.kind === 'diagram') {
    h += '<button class="btn small ghost" data-act="replay">↻ Replay diagram</button>';
  } else {
    h += '<span></span>';
  }
  if (deck.idx === n - 1) {
    h += S.doneLect[deck.lid]
      ? '<span class="learn-check">Completed ✓</span>'
      : '<button class="btn primary" data-act="complete">Mark lecture complete ✓</button>';
  } else {
    h += '<button class="btn primary" data-act="next">Next →</button>';
  }
  h += '</div></div>';
  return h;
}
function paintSlide() {
  clearTimers();
  var deck = S.deck;
  var stage = $('learnStage');
  if (!stage) return;
  var slide = deck.slides[deck.idx];
  stage.innerHTML = slideHTML(slide);
  if (slide.kind === 'diagram') renderDiagram();
  if (slide.kind === 'code') typeCode(slide);
  if (deck.idx === deck.slides.length - 1) {
    completeLecture(deck.lid); /* auto-complete on reaching the last slide */
  }
  /* refresh dots / counter / nav without full re-render */
  var body = $('learnBody');
  if (body) {
    var dots = body.querySelectorAll('.learn-dot');
    for (var i = 0; i < dots.length; i++) {
      dots[i].classList.toggle('on', i === deck.idx);
    }
    var counter = body.querySelector('.learn-counter');
    if (counter) counter.textContent = (deck.idx + 1) + ' / ' + deck.slides.length;
    var nav = body.querySelector('.learn-decknav');
    if (nav) {
      var tmp = document.createElement('div');
      tmp.innerHTML = deckHTML();
      var fresh = tmp.querySelector('.learn-decknav');
      nav.parentNode.replaceChild(fresh, nav);
      var crumb = body.querySelector('.learn-crumb .learn-counter');
      if (crumb) crumb.textContent = (deck.idx + 1) + ' / ' + deck.slides.length;
    }
  }
}
function renderDiagram() {
  var host = $('learnDiagram');
  if (!host) return;
  var slide = S.deck.slides[S.deck.idx];
  host.innerHTML = buildDiagram(slide.diagram || {});
}
function typeCode(slide) {
  var pre = $('learnCodePre');
  if (!pre) return;
  var full = (slide.code && slide.code.code) || '';
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce || full.length < 40) {
    pre.textContent = full;
    var box = pre.parentNode;
    if (box) box.classList.remove('typing');
    return;
  }
  var i = 0;
  var timer = setInterval(function () {
    i += 14;
    if (i >= full.length) {
      clearInterval(timer);
      pre.textContent = full;
      var b = pre.parentNode;
      if (b) b.classList.remove('typing');
      return;
    }
    pre.textContent = full.slice(0, i);
  }, 22);
  S.timers.push(timer);
}
function openDeck(lecture) {
  S.level = 'deck';
  S.deck = { lid: lecture.lid, title: lecture.title, slides: lecture.slides, idx: 0 };
  renderDeck();
  window.scrollTo(0, 0);
}
function renderDeck() {
  var body = $('learnBody');
  if (!body) return;
  body.innerHTML = deckHTML();
  paintSlide();
}
function goSlide(i) {
  var n = S.deck.slides.length;
  if (i < 0 || i >= n) return;
  S.deck.idx = i;
  paintSlide();
  window.scrollTo(0, 0);
}

/* ---------------- overview + lecture list ---------------- */
function sections() {
  var c = S.content;
  if (c && c.sections && c.sections.length) return c.sections;
  /* fallback: single section from lessons when sections[] is absent */
  var lessons = (c && c.lessons) || [];
  return [{ id: 'core', title: 'Core', kind: 'core',
    lectures: lessons.map(function (l) { return 'c-' + l.domain_id; }),
    lab_ids: [], drill_domain_ids: [] }];
}
function overviewHTML() {
  var secs = sections();
  var h = '<div class="learn-path">';
  for (var i = 0; i < secs.length; i++) {
    var st = sectionStats(secs[i]);
    var totalL = st.lectures.length;
    var pct = totalL ? Math.round(100 * st.doneLect / totalL) : 0;
    h += '<button class="panel learn-sec" data-act="section" data-id="' + esc(secs[i].id) + '">' +
      '<div><p class="eyebrow">INTERSTITIUM LABS · ' + esc(secs[i].kind.toUpperCase()) + '</p>' +
      '<h3 style="margin:0 0 6px">' + esc(secs[i].title) + '</h3>' +
      '<div class="learn-secstats"><span>Lectures <b>' + st.doneLect + '/' + totalL + '</b></span>' +
      '<span>Labs <b>' + st.doneLabs + '/' + st.labIds.length + '</b></span>' +
      (st.mastery === null ? '' : '<span>Drill mastery <b>' + st.mastery + '%</b></span>') +
      '</div><div class="learn-bar"><i style="width:' + pct + '%"></i></div></div>' +
      '<span aria-hidden="true">→</span></button>';
  }
  h += '</div>';
  return h;
}
function badgeFor(kind) {
  return kind === 'foundation' ? 'FOUNDATION' : kind === 'advanced' ? 'ADVANCED' : 'CORE';
}
function lectureListHTML(section) {
  var lectures = resolveSectionLectures(section);
  var h = '<div class="learn-crumb"><button class="btn small ghost" data-act="overview">← Learning path</button>' +
    '<span class="learn-counter">' + lectures.length + ' lectures</span></div>';
  h += '<p class="eyebrow">INTERSTITIUM LABS · ' + esc(section.kind.toUpperCase()) + '</p>';
  h += '<h3 style="margin:0 0 14px;font-size:clamp(22px,3vw,30px)">' + esc(section.title) + '</h3>';
  if (!lectures.length) {
    h += '<div class="empty-note"><p class="brand">INTERSTITIUM&nbsp;LABS</p>' +
      '<p>Lectures for this section are still being prepared.</p></div>';
    return h;
  }
  h += '<div class="learn-list">';
  for (var i = 0; i < lectures.length; i++) {
    var L = lectures[i];
    h += '<button class="learn-card learn-lectrow" data-act="lecture" data-lid="' + esc(L.lid) + '">' +
      '<span><span class="learn-badge">' + esc(L.badge || badgeFor(section.kind)) + '</span> ' +
      '<strong>' + esc(L.title) + '</strong></span>' +
      (S.doneLect[L.lid] ? '<span class="learn-check">✓</span>' : '<span aria-hidden="true">→</span>') +
      '</button>';
  }
  h += '</div>';
  return h;
}

/* ---------------- empty / loading ---------------- */
function brandedEmpty(msg) {
  return '<div class="empty-note"><p class="brand">INTERSTITIUM&nbsp;LABS</p>' +
    '<p>' + esc(msg || 'Lessons for this path are still being written.') + '</p></div>';
}

/* ---------------- render root ---------------- */
function render() {
  injectCSS();
  var body = $('learnBody');
  if (!body) return;
  if (!S.loaded && !S.loading) {
    S.loading = true;
    S.doneLect = loadDone();
    body.innerHTML = '<div class="empty-note"><p class="brand">INTERSTITIUM&nbsp;LABS</p>' +
      '<p>Preparing the lecture hall…</p></div>';
    Promise.all([
      loadJSON('./content.json'),
      loadJSON('engine/foundations.json'),
      loadJSON('engine/math.json')
    ]).then(function (res) {
      S.content = res[0];
      S.foundations = res[1];
      S.math = res[2];
      S.loaded = true;
      S.loading = false;
      render();
      if (isResourcesActive()) renderResources(); /* resources view was waiting on the load */
    });
    return;
  }
  if (!S.loaded) return; /* still loading */
  if (!S.content || (!((S.content.sections || []).length) && !((S.content.lessons || []).length))) {
    body.innerHTML = brandedEmpty();
    return;
  }
  if (S.level === 'deck' && S.deck) { renderDeck(); return; }
  if (S.level === 'lectures' && S.sectionId) {
    var secs = sections();
    var sec = null;
    for (var i = 0; i < secs.length; i++) {
      if (secs[i].id === S.sectionId) sec = secs[i];
    }
    body.innerHTML = sec ? lectureListHTML(sec) : overviewHTML();
    return;
  }
  S.level = 'overview';
  body.innerHTML = overviewHTML();
}

/* ---------------- enterprise CBT: Resources view ----------------
   Renders resources.cheatsheet (sections), resources.glossary,
   resources.links (as real <a> links), resources.checklist into
   #resourcesBody. Graceful when resources{} is absent. */
function isResourcesActive() {
  var sec = $('view-resources');
  return !!(sec && sec.classList && typeof sec.classList.contains === 'function' &&
    sec.classList.contains('active'));
}
function showResourcesSection() {
  var sec = $('view-resources');
  if (!sec) return;
  var views = document.querySelectorAll('#main .view');
  for (var i = 0; i < views.length; i++) {
    views[i].classList.toggle('active', views[i] === sec);
  }
  var btns = document.querySelectorAll('.nav button[data-view]');
  for (var j = 0; j < btns.length; j++) {
    btns[j].classList.toggle('active',
      btns[j].getAttribute('data-view') === 'resources');
  }
}
function resourcesHTML() {
  var r = (S.content && S.content.resources) || null;
  if (!r) {
    return brandedEmpty('Reference resources for this path are still being written.');
  }
  var h = '<div class="learn-resources">', i, j;
  var cs = r.cheatsheet;
  if (cs && cs.sections && cs.sections.length) {
    h += '<div class="panel"><p class="eyebrow">CHEAT SHEET</p><h3 style="margin:0 0 10px">' +
      esc(cs.title || 'Cheat sheet') + '</h3>';
    for (i = 0; i < cs.sections.length; i++) {
      var secn = cs.sections[i], items = secn.items || [];
      h += '<h4 style="margin:14px 0 6px">' + esc(secn.heading || '') + '</h4><ul class="learn-checklist">';
      for (j = 0; j < items.length; j++) h += '<li>' + esc(items[j]) + '</li>';
      h += '</ul>';
    }
    h += '</div>';
  }
  var gl = r.glossary;
  if (gl && gl.length) {
    h += '<div class="panel"><p class="eyebrow">GLOSSARY</p><h3 style="margin:0 0 10px">Key terms</h3>' +
      '<dl class="learn-gloss">';
    for (i = 0; i < gl.length; i++) {
      h += '<div><dt>' + esc(gl[i].term || '') + '</dt><dd>' + esc(gl[i].def || '') + '</dd></div>';
    }
    h += '</dl></div>';
  }
  var links = r.links;
  if (links && links.length) {
    h += '<div class="panel"><p class="eyebrow">OFFICIAL REFERENCES</p>' +
      '<h3 style="margin:0 0 10px">Links</h3><ul class="learn-links">';
    for (i = 0; i < links.length; i++) {
      var l = links[i];
      h += '<li><a href="' + esc(l.url || '#') + '" target="_blank" rel="noopener noreferrer">' +
        esc(l.label || l.url || 'Link') + '</a>' +
        (l.note ? '<br><span style="color:var(--muted);font-size:13px">' + esc(l.note) + '</span>' : '') +
        '</li>';
    }
    h += '</ul></div>';
  }
  var cl = r.checklist;
  if (cl && cl.length) {
    h += '<div class="panel"><p class="eyebrow">READINESS CHECKLIST</p>' +
      '<h3 style="margin:0 0 10px">Before the exam</h3><ul class="learn-checklist">';
    for (i = 0; i < cl.length; i++) h += '<li>\u2610 ' + esc(cl[i]) + '</li>';
    h += '</ul></div>';
  }
  h += '</div>';
  return h;
}
function renderResources() {
  injectCSS();
  showResourcesSection();
  var body = $('resourcesBody');
  if (!body) return;
  if (!S.loaded) {
    if (!S.loading) render(); /* kicks the shared loader; re-renders resources when it lands */
    body.innerHTML = '<div class="empty-note"><p class="brand">INTERSTITIUM&nbsp;LABS</p>' +
      '<p>Gathering reference resources\u2026</p></div>';
    return;
  }
  body.innerHTML = resourcesHTML();
}

/* ---------------- events (delegated) ---------------- */
function onAction(e) {
  var t = e.target;
  while (t && t !== document && !t.getAttribute) t = t.parentNode;
  while (t && t !== document && !t.hasAttribute('data-act')) t = t.parentNode;
  if (!t || t === document) return;
  var act = t.getAttribute('data-act');
  if (act === 'section') {
    S.sectionId = t.getAttribute('data-id');
    S.level = 'lectures';
    render();
  } else if (act === 'overview') {
    S.level = 'overview';
    S.sectionId = null;
    render();
  } else if (act === 'back') {
    S.level = 'lectures';
    S.deck = null;
    clearTimers();
    render();
  } else if (act === 'lecture') {
    var lid = t.getAttribute('data-lid');
    var sec = null, secs = sections();
    for (var i = 0; i < secs.length; i++) {
      if (secs[i].id === S.sectionId) sec = secs[i];
    }
    var lectures = sec ? resolveSectionLectures(sec) : [];
    for (var j = 0; j < lectures.length; j++) {
      if (lectures[j].lid === lid) { openDeck(lectures[j]); return; }
    }
  } else if (act === 'prev') {
    goSlide(S.deck.idx - 1);
  } else if (act === 'next') {
    goSlide(S.deck.idx + 1);
  } else if (act === 'dot') {
    goSlide(parseInt(t.getAttribute('data-i'), 10));
  } else if (act === 'replay') {
    renderDiagram();
  } else if (act === 'complete') {
    completeLecture(S.deck.lid);
    S.level = 'lectures';
    S.deck = null;
    clearTimers();
    render();
  } else if (act === 'goto-terminal') {
    var btn = document.querySelector('[data-view="terminal"]');
    if (btn) btn.click();
  }
}
function onKey(e) {
  if (S.level !== 'deck' || !S.deck) return;
  var tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
  if (e.key === 'ArrowRight') goSlide(S.deck.idx + 1);
  else if (e.key === 'ArrowLeft') goSlide(S.deck.idx - 1);
}

if (typeof document !== 'undefined') {
  document.addEventListener('ilb:view', function (e) {
    if (e && e.detail === 'learn') render(); /* re-render current level; first load shows overview */
    else if (e && e.detail === 'resources') renderResources(); /* enterprise CBT */
  });
  document.addEventListener('click', onAction);
  document.addEventListener('keydown', onKey);
}

/* testability seam */
window.LearnView = {
  render: render,
  lessonToSlides: lessonToSlides,
  diagramTypeFor: diagramTypeFor,
  extractNodes: extractNodes,
  buildDiagram: buildDiagram,
  resolveSectionLectures: function (section) { return resolveSectionLectures(section); },
  renderResources: renderResources,
  resourcesHTML: resourcesHTML,
  mediaForLesson: mediaForLesson,
  _state: S
};

})();
