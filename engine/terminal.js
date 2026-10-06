/* ============================================================
   Interstitium Labs — Certification Bootcamps: interactive terminal
   engine/terminal.js

   A real interactive in-browser terminal, vanilla JS, zero
   dependencies, ES5-compatible, fully offline (no network calls).

   Renders inside the existing #terminalBody element (the static
   #view-terminal section + nav button are provided by the shell).

   Shell profiles are keyed by bootcamp slug:
     window.BOOTCAMP_PAGE.slug  ->  profileFor(slug)

   Integration contract:
     document 'ilb:view' event with detail === 'terminal' -> focus input
     window.ILBTerminal = {
       onCommand: fn(commandString, fullOutputText),
       print:     text,
       focus:     ()
     }
   Testing seam (never set by the generator shells):
     window.ENGINE_TEST -> window.__terminalEngine.{profileFor,profiles}

   Typing animation (~8ms/char, chunked) is skippable with any key or
   click; honors prefers-reduced-motion (prints instantly).
   ============================================================ */
(function(){
'use strict';

var W = (typeof window !== 'undefined') ? window : {};
var DOC = (typeof document !== 'undefined') ? document : null;
var PAGE = W.BOOTCAMP_PAGE || {};
var SLUG = PAGE.slug || 'bootcamp';
var TITLE = PAGE.title || 'Certification Bootcamp';

var REDUCED = false;
try {
  REDUCED = !!(W.matchMedia && W.matchMedia('(prefers-reduced-motion: reduce)').matches);
} catch(e){ REDUCED = false; }

/* ---------------- utils ---------------- */
function padRight(s, n){ s = String(s); while (s.length < n) s += ' '; return s; }
function padLeft(s, n){ s = String(s); while (s.length < n) s = ' ' + s; return s; }
function repeat(s, n){ var r=''; for (var i=0;i<n;i++) r+=s; return r; }
function trim(s){ return String(s).replace(/^\s+|\s+$/g, ''); }

/* Split a command line into tokens, honoring '...' "..." and \ escapes. */
function splitArgs(line){
  var args = [], cur = '', i = 0, n = line.length, q = null;
  while (i < n){
    var c = line.charAt(i);
    if (q){
      if (c === '\\' && i + 1 < n){ cur += line.charAt(i+1); i += 2; continue; }
      if (c === q){ q = null; i++; continue; }
      cur += c; i++; continue;
    }
    if (c === '"' || c === "'"){ q = c; i++; continue; }
    if (c === '\\' && i + 1 < n){ cur += line.charAt(i+1); i += 2; continue; }
    if (c === ' ' || c === '\t'){ if (cur !== ''){ args.push(cur); cur=''; } i++; continue; }
    cur += c; i++;
  }
  if (cur !== '') args.push(cur);
  return args;
}

/* ---------------- injected styles (scoped .ilb-term-*) ---------------- */
var CSS = [
'.ilb-term{background:#05090e;border:1px solid var(--line,#223046);border-radius:14px;overflow:hidden;box-shadow:var(--shadow,0 16px 50px rgba(0,0,0,.45));font-family:var(--mono,ui-monospace,Menlo,Consolas,monospace);}',
'.ilb-term-bar{display:flex;align-items:center;gap:12px;padding:10px 16px;background:#0b1119;border-bottom:1px solid var(--line,#223046);}',
'.ilb-dots{display:flex;gap:7px;}',
'.ilb-dots i{width:11px;height:11px;border-radius:50%;display:block;}',
'.ilb-dots i:nth-child(1){background:#f87171;}',
'.ilb-dots i:nth-child(2){background:#fbbf24;}',
'.ilb-dots i:nth-child(3){background:#3ddc97;}',
'.ilb-term-title{font-size:12px;color:#8fa3b8;letter-spacing:.04em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
'.ilb-term-title b{color:var(--accent,#3ddc97);font-weight:700;}',
'.ilb-term-sim{margin-left:auto;font-size:10px;font-weight:700;letter-spacing:.1em;color:#5c7186;border:1px dashed #33465f;border-radius:99px;padding:3px 10px;white-space:nowrap;}',
'.ilb-term-screen{position:relative;padding:18px 20px 22px;min-height:420px;max-height:62vh;overflow-y:auto;font-size:13.5px;line-height:1.65;color:var(--code-ink,#b9f5d8);cursor:text;}',
'.ilb-term-line{white-space:pre-wrap;word-break:break-word;}',
'.ilb-term-line.ilb-err{color:#f87171;}',
'.ilb-term-line.ilb-dim{color:#5c7186;}',
'.ilb-term-line.ilb-accent{color:var(--accent,#3ddc97);}',
'.ilb-term-row{display:flex;align-items:flex-start;flex-wrap:wrap;}',
'.ilb-prompt{color:var(--accent,#3ddc97);font-weight:700;white-space:pre;}',
'.ilb-typed{white-space:pre-wrap;word-break:break-all;}',
'.ilb-cursor{display:inline-block;width:.62em;height:1.18em;background:var(--accent,#3ddc97);vertical-align:-0.22em;animation:ilbBlink 1.06s steps(1) infinite;}',
'@keyframes ilbBlink{50%{opacity:0;}}',
'.ilb-term-hidden{position:absolute;left:8px;bottom:8px;width:10px;height:10px;opacity:0;border:0;padding:0;}',
'@media (prefers-reduced-motion:reduce){.ilb-cursor{animation:none;}}'
].join('\n');

function injectCSS(){
  if (!DOC || !DOC.head) return;
  if (DOC.getElementById('ilb-term-css')) return;
  var st = DOC.createElement('style');
  st.setAttribute('id', 'ilb-term-css');
  st.setAttribute('type', 'text/css');
  if (st.styleSheet) st.styleSheet.cssText = CSS; else st.appendChild(DOC.createTextNode(CSS));
  DOC.head.appendChild(st);
}

/* ---------------- terminal core state ---------------- */
var term = null; /* built by buildTerminal() */

function el(tag, cls, parent){
  var d = DOC.createElement(tag);
  if (cls) d.className = cls;
  if (parent) parent.appendChild(d);
  return d;
}
function textEl(tag, cls, txt, parent){
  var d = el(tag, cls, parent);
  d.textContent = txt;
  return d;
}

/* Typing-animation print pipeline. Jobs print FIFO; any key/click while
   printing completes output instantly. */
var printQueue = [];
var printing = false;
var skipPrint = false;
var afterDrain = [];   /* callbacks run when the queue fully drains */

function enqueuePrint(text, cls){
  printQueue.push({ text: String(text), cls: cls || '' });
  pumpPrint();
}
function pumpPrint(){
  if (printing || !term || !printQueue.length){
    if (!printing && !printQueue.length && term) drainDone();
    return;
  }
  printing = true;
  var job = printQueue.shift();
  var line = el('div', 'ilb-term-line' + (job.cls ? ' ' + job.cls : ''), term.out);
  term.screen.setAttribute('aria-busy', 'true');
  if (REDUCED || job.text.length === 0){
    line.textContent = job.text;
    if (term.acc) term.acc.push(job.text);
    endJob();
    return;
  }
  var i = 0, CHUNK = 16, text = job.text;
  (function tick(){
    if (skipPrint){
      line.textContent = text;
      if (term.acc) term.acc.push(text);
      skipPrint = false;
      endJob();
      return;
    }
    i += CHUNK;
    line.textContent = text.slice(0, i);
    scrollBottom();
    if (i < text.length){ setTimeout(tick, 128); }
    else { if (term.acc) term.acc.push(text); endJob(); }
  })();
}
function endJob(){
  printing = false;
  if (term) term.screen.setAttribute('aria-busy', 'false');
  scrollBottom();
  pumpPrint();
}
function drainDone(){
  var cbs = afterDrain.slice(); afterDrain = [];
  for (var i = 0; i < cbs.length; i++){ try { cbs[i](); } catch(e){} }
}
function scrollBottom(){
  if (term && term.screen) term.screen.scrollTop = term.screen.scrollHeight;
}
function printNow(text, cls){ /* bypass animation */
  var line = el('div', 'ilb-term-line' + (cls ? ' ' + cls : ''), term.out);
  line.textContent = String(text);
  if (term.acc) term.acc.push(String(text));
  scrollBottom();
}

/* Build the terminal chrome + I/O inside #terminalBody. */
function buildTerminal(){
  var mount = DOC.getElementById('terminalBody');
  if (!mount || mount.getAttribute('data-ilb-term')) return null;
  mount.setAttribute('data-ilb-term', '1');
  injectCSS();

  var profile = profileFor(SLUG);
  var box = el('div', 'ilb-term', mount);
  var bar = el('div', 'ilb-term-bar', box);
  var dots = el('span', 'ilb-dots', bar);
  el('i', '', dots); el('i', '', dots); el('i', '', dots);
  var title = el('span', 'ilb-term-title', bar);
  var b = el('b', '', title); b.textContent = 'ilb-terminal';
  title.appendChild(DOC.createTextNode(' · ' + profile.label));
  var sim = el('span', 'ilb-term-sim', bar); sim.textContent = 'SIMULATED · OFFLINE';

  var screen = el('div', 'ilb-term-screen', box);
  screen.setAttribute('role', 'log');
  screen.setAttribute('aria-label', 'Simulated terminal for ' + TITLE);
  var out = el('div', 'ilb-term-out', screen);
  var row = el('div', 'ilb-term-row', screen);
  var promptEl = el('span', 'ilb-prompt', row);
  var before = el('span', 'ilb-typed', row);
  var cursor = el('span', 'ilb-cursor', row);
  var after = el('span', 'ilb-typed', row);
  var hidden = el('input', 'ilb-term-hidden', screen);
  hidden.setAttribute('type', 'text');
  hidden.setAttribute('autocomplete', 'off');
  hidden.setAttribute('autocapitalize', 'none');
  hidden.setAttribute('autocorrect', 'off');
  hidden.setAttribute('spellcheck', 'false');
  hidden.setAttribute('aria-label', 'Terminal command input');

  term = {
    mount: mount, box: box, screen: screen, out: out, row: row,
    promptEl: promptEl, before: before, after: after, cursor: cursor,
    hidden: hidden, profile: profile,
    state: (typeof profile.initState === 'function') ? profile.initState() : {},
    hist: [], histIdx: 0, draft: '',
    acc: null, motdDone: false, firstFocus: false
  };

  refreshPrompt();
  wireInput();
  wireSkip();
  return term;
}

function promptText(){
  var p = term.profile.prompt;
  return (typeof p === 'function') ? p.call(term.profile, term) : String(p);
}
function refreshPrompt(){ if (term) term.promptEl.textContent = promptText(); }

function renderInput(){
  var v = term.hidden.value || '';
  var pos = term.hidden.selectionStart;
  if (pos == null || pos < 0 || pos > v.length) pos = v.length;
  term.before.textContent = v.slice(0, pos);
  term.after.textContent = v.slice(pos);
}
function focusInput(){
  if (term && term.hidden){
    try { term.hidden.focus({ preventScroll: true }); } catch(e){ try { term.hidden.focus(); } catch(e2){} }
  }
}
function viewActive(){
  var sec = DOC.getElementById('view-terminal');
  return !!(sec && sec.classList && sec.classList.contains('active'));
}

/* ---------------- input wiring ---------------- */
function wireInput(){
  var h = term.hidden;
  h.addEventListener('input', function(){ renderInput(); });
  h.addEventListener('click', function(){ renderInput(); });
  h.addEventListener('keyup', function(){ renderInput(); });
  term.screen.addEventListener('click', function(){
    if (printing){ skipPrint = true; }
    focusInput();
  });
  h.addEventListener('keydown', function(e){
    var key = e.key;
    if (e.ctrlKey && (key === 'c' || key === 'C')){
      e.preventDefault();
      if (printing) skipPrint = true;
      echoLine(h.value);
      printNow('^C', 'ilb-dim');
      h.value = ''; renderInput(); refreshPrompt();
      return;
    }
    if (e.ctrlKey && (key === 'l' || key === 'L')){
      e.preventDefault();
      if (printing) skipPrint = true;
      clearScreen();
      return;
    }
    if (key === 'Enter'){
      e.preventDefault();
      submitLine();
      return;
    }
    if (key === 'Tab'){
      e.preventDefault();
      tabComplete();
      return;
    }
    if (key === 'ArrowUp'){ e.preventDefault(); histMove(-1); return; }
    if (key === 'ArrowDown'){ e.preventDefault(); histMove(1); return; }
  });
}

/* While output is animating, any key (when the terminal has focus)
   completes it instantly instead of reaching the input. */
function wireSkip(){
  DOC.addEventListener('keydown', function(e){
    if (!printing || !term || !viewActive()) return;
    var t = e.target;
    var inTerm = (t === term.hidden) || (term.box && term.box.contains(t));
    if (!inTerm) return;
    if (e.ctrlKey && (e.key === 'c' || e.key === 'C')) return; /* handled above */
    skipPrint = true;
    e.preventDefault();
    e.stopPropagation();
  }, true);
}

/* ---------------- history ---------------- */
function histMove(dir){
  var h = term.hist;
  if (!h.length) return;
  if (dir < 0){
    if (term.histIdx === h.length) term.draft = term.hidden.value;
    if (term.histIdx > 0) term.histIdx--;
  } else {
    if (term.histIdx < h.length) term.histIdx++;
  }
  term.hidden.value = (term.histIdx === h.length) ? term.draft : h[term.histIdx];
  renderInput();
}

/* ---------------- tab completion ---------------- */
function tabComplete(){
  var val = term.hidden.value;
  var m = val.match(/^(.*?)(\S*)$/);
  var head = m[1], frag = m[2];
  var cands = [];
  var toks = splitArgs(trim(val));
  var p = term.profile;
  if (toks.length <= 1){
    var names = Object.keys(p.commands);
    for (var i = 0; i < names.length; i++)
      if (names[i].indexOf(frag) === 0) cands.push(names[i]);
    /* profile-level aliases (e.g. ".tables") already live in commands */
  } else if (p.subs && toks.length === 2){
    var list = p.subs[toks[0]];
    if (list) for (var j = 0; j < list.length; j++)
      if (list[j].indexOf(frag) === 0) cands.push(list[j]);
  }
  if (p.extraComplete){
    var extra = p.extraComplete(toks, frag, term);
    for (var k = 0; k < extra.length; k++) cands.push(extra[k]);
  }
  if (cands.length === 1){
    term.hidden.value = head + cands[0] + (toks.length <= 1 ? ' ' : '');
    renderInput();
  } else if (cands.length > 1){
    echoLine(val);
    enqueuePrint(cands.join('   '), 'ilb-dim');
  }
}

/* ---------------- command execution ---------------- */
var cmdHandlers = [];

function echoLine(val){
  var line = el('div', 'ilb-term-line', term.out);
  var pr = el('span', 'ilb-prompt', line); pr.textContent = promptText();
  var tx = el('span', 'ilb-typed', line); tx.textContent = val; /* textContent: user input escaped */
  scrollBottom();
}

function clearScreen(){
  term.out.innerHTML = '';
  term.hidden.value = ''; renderInput(); refreshPrompt();
  scrollBottom();
}

function submitLine(){
  var raw = term.hidden.value;
  if (printing){ skipPrint = true; return; }
  echoLine(raw);
  term.hidden.value = ''; renderInput();
  var cmd = trim(raw);
  if (!cmd){ refreshPrompt(); scrollBottom(); fireHandlers(raw, ''); return; }
  term.hist.push(cmd); term.histIdx = term.hist.length; term.draft = '';

  var acc = [];
  term.acc = acc;
  var done = function(outText){
    /* runs after the queue drains */
    afterDrain.push(function(){
      term.acc = null;
      refreshPrompt(); scrollBottom();
      fireHandlers(cmd, acc.join('\n'));
    });
    pumpPrint();
  };
  try {
    var ctx = makeCtx();
    var outText = term.profile.runLine(cmd, ctx);
    if (outText !== undefined && outText !== null && outText !== '')
      enqueuePrint(String(outText));
  } catch(err){
    enqueuePrint('Error: ' + (err && err.message ? err.message : String(err)), 'ilb-err');
  }
  done();
}

function makeCtx(){
  return {
    term: term,
    profile: term.profile,
    state: term.state,
    print: function(t, cls){ enqueuePrint(t, cls); },
    err: function(t){ enqueuePrint(t, 'ilb-err'); },
    dim: function(t){ enqueuePrint(t, 'ilb-dim'); }
  };
}

function fireHandlers(cmd, fullOutput){
  for (var i = 0; i < cmdHandlers.length; i++){
    try { cmdHandlers[i](cmd, fullOutput); } catch(e){}
  }
}

/* ---------------- MOTD ---------------- */
function motdLines(){
  var W2 = 64;
  function boxLine(s){
    s = ' ' + s;
    if (s.length > W2 - 2) s = s.slice(0, W2 - 5) + '...';
    return '│' + padRight(s, W2 - 2) + '│';
  }
  var top = '┌─ INTERSTITIUM LABS ── ' + TITLE + ' ── interactive terminal ─';
  while (top.length < W2 - 1) top += '─';
  top += '┐';
  return [
    top,
    boxLine('Type `help` to list commands.'),
    boxLine('This is a simulated ' + term.profile.shellName + ' for practice —'),
    boxLine('no real systems are touched. Everything runs locally.'),
    '└' + repeat('─', W2 - 2) + '┘'
  ].join('\n');
}

/* ---------------- TerminalView + public API ---------------- */
var TerminalView = {
  show: function(){
    if (!term) buildTerminal();
    if (!term) return;
    if (!term.motdDone){
      term.motdDone = true;
      enqueuePrint(motdLines(), 'ilb-accent');
    }
    setTimeout(focusInput, 30);
    scrollBottom();
  },
  print: function(text){ if (term) enqueuePrint(String(text)); },
  focus: function(){ focusInput(); },
  clear: clearScreen
};

W.ILBTerminal = {
  onCommand: function(fn){ if (typeof fn === 'function') cmdHandlers.push(fn); },
  print: function(text){ TerminalView.print(text); },
  focus: function(){ TerminalView.focus(); }
};
W.TerminalView = TerminalView;

if (DOC && DOC.addEventListener){
  DOC.addEventListener('ilb:view', function(e){
    if (e && e.detail === 'terminal') TerminalView.show();
  });
}

/* ---------------- default line dispatcher ---------------- */
function defaultRunLine(line, ctx){
  var p = ctx.profile;
  var args = splitArgs(line);
  if (!args.length) return '';
  var name = args[0];
  var cmd = p.commands[name];
  if (cmd) return cmd.run(args.slice(1), ctx);
  if (p.tool && p.subcmds && p.subcmds.indexOf(name) >= 0)
    return 'Did you mean "' + p.tool + ' ' + line + '"? This shell simulates ' + p.tool + ' — prefix subcommands with `' + p.tool + '`.';
  return name + ': command not found (simulated shell)';
}

/* Built-in meta commands shared by most profiles. */
function metaCommands(extra){
  var cmds = {
    help: { d: 'List available commands', run: function(a, ctx){
      var names = Object.keys(ctx.profile.commands).sort();
      var out = ['Available commands (' + ctx.profile.shellName + '):'];
      for (var i = 0; i < names.length; i++)
        out.push('  ' + padRight(names[i], 22) + (ctx.profile.commands[names[i]].d || ''));
      return out.join('\n');
    }},
    clear: { d: 'Clear the terminal screen', run: function(a, ctx){ clearScreen(); return ''; } },
    history: { d: 'Show command history', run: function(a, ctx){
      var out = [];
      for (var i = 0; i < term.hist.length; i++) out.push('  ' + (i+1) + '  ' + term.hist[i]);
      return out.length ? out.join('\n') : '(no history yet)';
    }},
    exit: { d: 'Leave the simulated shell (stays open for practice)', run: function(){
      return 'Session kept alive — this is a simulated shell for practice.';
    }}
  };
  if (extra) for (var k in extra) cmds[k] = extra[k];
  return cmds;
}

/* ---------------- profile registry ---------------- */
var PROFILES = {};

function defineProfile(id, def){
  def.id = id;
  if (!def.runLine) def.runLine = defaultRunLine;
  PROFILES[id] = def;
  return def;
}

/* profileFor(slug): map the 68 catalog slugs to shell profiles.
   Order matters: exact/prefix matches first, substring matches last. */
function profileFor(slug){
  var s = String(slug || '').toLowerCase();
  var parts = s.split(/[-_]/);
  function has(part){ return parts.indexOf(part) >= 0; }

  if (/^aws-/.test(s)) return PROFILES.aws;
  if (['az-104','az-305','az-700','azure-developer','sc-200','sc-300','m365','ms-fundamentals'].indexOf(s) >= 0) return PROFILES.az;
  if (['k8s-associate','cka','ckad','openshift'].indexOf(s) >= 0) return PROFILES.kubectl;
  if (s === 'terraform') return PROFILES.terraform;
  if (s === 'docker') return PROFILES.docker;
  if (s === 'git-devops') return PROFILES.git;
  if (s === 'vault-consul') return PROFILES.vault;
  if (s === 'mongodb') return PROFILES.mongosh;
  if (s === 'oracle-oci' || s === 'oracle-db') return PROFILES.oci;
  if (['sql','oracle-sql','dp-203','data-engineering','data-analyst'].indexOf(s) >= 0) return PROFILES.sql;
  if (['linux-essentials','rhcsa','rhce','sre-platform','comptia-core','comptia-cyber',
       'comptia-infra','cissp','cism','pentest','soc-analyst','zerotrust','dod-8140',
       'nice-framework','hackers-arise','nsa-codebreaker','systems-cs',
       'full-spectrum-dominance'].indexOf(s) >= 0) return PROFILES.bash;
  if (s.indexOf('python') >= 0 || s.indexOf('datascience') >= 0 ||
      s.indexOf('llm-engineering') >= 0 || s.indexOf('nvidia-ai') >= 0 ||
      s.indexOf('dsa') >= 0 || has('ml')) return PROFILES.python;
  return bashLiteProfile(s);
}

/* ---------------- boot ----------------
   NOTE: the actual boot invocation lives at the end of this file, after
   all profile definitions, so profileFor() sees the full registry. */
function init(){
  if (!DOC) return;
  /* Build lazily on first view open so the terminal only costs what it uses.
     Also build eagerly if the terminal view is somehow already active. */
  if (DOC.getElementById('view-terminal') &&
      DOC.getElementById('view-terminal').classList.contains('active')){
    TerminalView.show();
  }
}

/* Testing seam (mirrors engine/bootcamp.js). Exposed at load; the PROFILES
   registry is populated by defineProfile() calls below before any test
   invokes profileFor(). */
if (W.ENGINE_TEST){
  W.__terminalEngine = {
    profileFor: profileFor,
    profiles: PROFILES,
    defineProfile: defineProfile,
    commandCount: function(id){ return Object.keys(PROFILES[id].commands).length; },
    splitArgs: splitArgs
  };
}

/* (IIFE closes after the profile definitions below) */

/* ================= PYTHON PROFILE =================
   Tiny safe Python subset: tokenizer + recursive-descent parser +
   tree-walking evaluator. No eval() of arbitrary JS anywhere. */

function pyErr(name, msg){
  var e = new Error(name + ': ' + msg);
  e.pyName = name;
  return e;
}
function pyTraceback(e){
  return 'Traceback (most recent call last):\n' +
         '  File "<stdin>", line 1, in <module>\n' + e.message;
}

/* ---- value helpers (JS values stand in for Python values) ----
   Floats are wrapped as {$float:1, v:n} so the REPL can echo 4.0 vs 4. */
function uv(v){ return (v !== null && typeof v === 'object' && !Array.isArray(v) && v.$float === 1) ? v.v : v; }
function isFV(v){ return v !== null && typeof v === 'object' && !Array.isArray(v) && v.$float === 1; }
function wrapF(n){ return { $float: 1, v: n }; }
function pyIsInt(v){ return typeof v === 'number' && isFinite(v) && Math.floor(v) === v; }
function pyIsDict(v){ return v !== null && typeof v === 'object' && !Array.isArray(v) && v.$d === 1; }
function pyIsBuiltin(v){ return v !== null && typeof v === 'object' && v.$b; }
function pyIsMethod(v){ return v !== null && typeof v === 'object' && v.$m; }

function pyTypeName(v){
  if (v === null) return 'NoneType';
  if (isFV(v)) return 'float';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'string') return 'str';
  if (typeof v === 'number') return pyIsInt(v) ? 'int' : 'float';
  if (Array.isArray(v)) return 'list';
  if (pyIsDict(v)) return 'dict';
  if (v.$mod) return 'module';
  if (pyIsBuiltin(v) || pyIsMethod(v)) return 'builtin_function_or_method';
  if (v.$cls) return 'type';
  return 'object';
}
function pyStr(v){
  var wasF = isFV(v);
  v = uv(v);
  if (v === null) return 'None';
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'string') return v;
  if (typeof v === 'number'){
    if (!isFinite(v)) return v > 0 ? 'inf' : '-inf';
    if (wasF && pyIsInt(v) && Math.abs(v) < 1e21) return String(v) + '.0';
    return String(v);
  }
  if (Array.isArray(v)) return '[' + v.map(pyRepr).join(', ') + ']';
  if (pyIsDict(v)){
    var parts = [];
    for (var k in v.m) parts.push(pyRepr(v.m[k].k) + ': ' + pyRepr(v.m[k].v));
    return '{' + parts.join(', ') + '}';
  }
  if (v.$mod) return "<module '" + v.$mod + "'>";
  if (pyIsBuiltin(v)) return '<built-in function ' + v.$b + '>';
  if (pyIsMethod(v)) return '<built-in method ' + v.$m + ' of ' + pyTypeName(v.obj) + ' object>';
  if (v.$cls) return "<class '" + v.$cls + "'>";
  return String(v);
}
function pyRepr(v){
  var wasF = isFV(v);
  v = uv(v);
  if (typeof v === 'string')
    return "'" + v.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\t/g, '\\t') + "'";
  if (typeof v === 'number' && isFinite(v)){
    if (wasF && pyIsInt(v) && Math.abs(v) < 1e21) return String(v) + '.0';
    var s = String(v);
    if (!pyIsInt(v) && s.indexOf('.') < 0 && s.indexOf('e') < 0) s += '.0';
    return s;
  }
  return pyStr(v);
}
function pyTruthy(v){
  v = uv(v);
  if (v === null || v === false) return false;
  if (v === true) return true;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (pyIsDict(v)){ for (var k in v.m) return true; return false; }
  return true;
}
function pyEq(a, b){
  a = uv(a); b = uv(b);
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b){
    if (typeof a === 'number' && typeof b === 'number') return a === b;
    return false;
  }
  if (Array.isArray(a) && Array.isArray(b)){
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (!pyEq(a[i], b[i])) return false;
    return true;
  }
  if (pyIsDict(a) && pyIsDict(b)){
    var ka = Object.keys(a.m), kb = Object.keys(b.m);
    if (ka.length !== kb.length) return false;
    for (var j = 0; j < ka.length; j++){
      if (!b.m.hasOwnProperty(ka[j])) return false;
      if (!pyEq(a.m[ka[j]].v, b.m[ka[j]].v)) return false;
    }
    return true;
  }
  return a === b;
}
function dictKey(v){
  v = uv(v);
  var t = typeof v;
  if (t === 'string') return 's:' + v;
  if (t === 'number') return 'n:' + v;
  if (t === 'boolean') return 'b:' + v;
  throw pyErr('TypeError', 'unhashable type: ' + pyTypeName(v));
}
function newDict(){ return { $d: 1, m: {} }; }
function dictSet(d, k, v){ d.m[dictKey(k)] = { k: k, v: v }; }
function dictGet(d, k){ var e = d.m[dictKey(k)]; return e ? e.v : undefined; }

/* ---- tokenizer ---- */
function pyTok(src){
  var toks = [], i = 0, n = src.length;
  function isDig(c){ return c >= '0' && c <= '9'; }
  function isIdS(c){ return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c > '\u007f'; }
  function isIdC(c){ return isIdS(c) || isDig(c); }
  var OPS3 = ['**=', '//=', '<<=', '>>='];
  var OPS2 = ['**', '//', '<<', '>>', '==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^='];
  while (i < n){
    var c = src.charAt(i);
    if (c === ' ' || c === '\t' || c === '\r'){ i++; continue; }
    if (c === '#'){ while (i < n && src.charAt(i) !== '\n') i++; continue; }
    /* string prefixes */
    if (isIdS(c)){
      var j = i;
      while (j < n && isIdC(src.charAt(j))) j++;
      var word = src.slice(i, j);
      var q = src.charAt(j);
      if ((q === '"' || q === "'") && /^(f|F|r|R|b|B|fr|Fr|fR|FR|rb|Rb|rB|RB|br|Br|bR|BR)$/.test(word)){
        var res = readPyString(src, j, word);
        toks.push(res.tok); i = res.i; continue;
      }
      toks.push({ t: 'id', v: word }); i = j; continue;
    }
    if (isDig(c) || (c === '.' && isDig(src.charAt(i + 1)))){
      var m = src.slice(i).match(/^(0[xX][0-9a-fA-F]+|0[oO][0-7]+|0[bB][01]+|\d+\.\d*([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?|\d+[eE][+-]?\d+|\d+)/);
      var num = m[0], v;
      if (/^0[xX]/.test(num)) v = parseInt(num, 16);
      else if (/^0[oO]/.test(num)) v = parseInt(num.slice(2), 8);
      else if (/^0[bB]/.test(num)) v = parseInt(num.slice(2), 2);
      else v = parseFloat(num);
      toks.push({ t: 'num', v: v, f: /[.eE]/.test(num) && !/^0[xXoObB]/.test(num) }); i += num.length; continue;
    }
    if (c === '"' || c === "'"){
      var r2 = readPyString(src, i, '');
      toks.push(r2.tok); i = r2.i; continue;
    }
    var three = src.substr(i, 3), two = src.substr(i, 2);
    if (OPS3.indexOf(three) >= 0){ toks.push({ t: 'op', v: three }); i += 3; continue; }
    if (OPS2.indexOf(two) >= 0){ toks.push({ t: 'op', v: two }); i += 2; continue; }
    if ('=<>+-*/%&|^~()[]{}.,:;@'.indexOf(c) >= 0){ toks.push({ t: 'op', v: c }); i++; continue; }
    throw pyErr('SyntaxError', 'invalid syntax');
  }
  return toks;
}
function readPyString(src, i, prefix){
  var n = src.length, q = src.charAt(i), triple = src.substr(i, 3) === q + q + q;
  var close = triple ? q + q + q : q;
  i += triple ? 3 : 1;
  var out = '', raw = prefix.toLowerCase().indexOf('r') >= 0;
  var isF = prefix.toLowerCase().indexOf('f') >= 0;
  var parts = null, lit = '';
  function pushLit(){ if (parts) parts.push({ s: lit }); else out += lit; lit = ''; }
  if (isF) parts = [];
  while (i < n){
    if (src.substr(i, close.length) === close){ i += close.length; break; }
    var c = src.charAt(i);
    if (isF && c === '{'){
      if (src.charAt(i + 1) === '{'){ lit += '{'; i += 2; continue; }
      pushLit();
      var depth = 1, j = i + 1, expr = '';
      while (j < n && depth > 0){
        var cc = src.charAt(j);
        if (cc === '{') depth++;
        else if (cc === '}') depth--;
        if (depth > 0) expr += cc;
        j++;
      }
      if (depth !== 0) throw pyErr('SyntaxError', 'f-string: unmatched \'{\'');
      parts.push({ e: expr }); i = j; continue;
    }
    if (isF && c === '}' && src.charAt(i + 1) === '}'){ lit += '}'; i += 2; continue; }
    if (c === '\\' && !raw && i + 1 < n){
      var e2 = src.charAt(i + 1), map = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', '0': '\0' };
      lit += (map[e2] !== undefined) ? map[e2] : e2;
      i += 2; continue;
    }
    lit += c; i++;
  }
  pushLit();
  if (isF) return { tok: { t: 'fstr', parts: parts }, i: i };
  return { tok: { t: 'str', v: out }, i: i };
}

/* ---- parser ---- */
function pyParser(toks){
  var pos = 0;
  function peek(){ return toks[pos]; }
  function next(){ return toks[pos++]; }
  function expectOp(v){
    var t = next();
    if (!t || t.t !== 'op' || t.v !== v) throw pyErr('SyntaxError', 'invalid syntax');
    return t;
  }
  function peekOp(){
    var t = peek();
    return (t && t.t === 'op') ? t.v : null;
  }
  function peekId(){
    var t = peek();
    return (t && t.t === 'id') ? t.v : null;
  }

  function parseExpr(){ return parseIfExp(); }
  function parseIfExp(){
    var a = parseOr();
    if (peekId() === 'if'){
      next();
      var c = parseOr();
      if (peekId() !== 'else') throw pyErr('SyntaxError', 'invalid syntax');
      next();
      var b = parseIfExp();
      return { t: 'ifexp', c: c, a: a, b: b };
    }
    return a;
  }
  function parseOr(){
    var l = parseAnd();
    while (peekId() === 'or'){ next(); l = { t: 'boolop', op: 'or', vals: [l, parseAnd()] }; }
    return l;
  }
  function parseAnd(){
    var l = parseNot();
    while (peekId() === 'and'){ next(); l = { t: 'boolop', op: 'and', vals: [l, parseNot()] }; }
    return l;
  }
  function parseNot(){
    if (peekId() === 'not'){ next(); return { t: 'not', x: parseNot() }; }
    return parseCmp();
  }
  function parseCmp(){
    var l = parseBitOr(), ops = [];
    for (;;){
      var op = null, t = peek();
      if (t && t.t === 'op' && ['==','!=','<','<=','>','>='].indexOf(t.v) >= 0){ op = t.v; next(); }
      else if (t && t.t === 'id' && t.v === 'in'){ op = 'in'; next(); }
      else if (t && t.t === 'id' && t.v === 'not'){
        var t2 = toks[pos + 1];
        if (t2 && t2.t === 'id' && t2.v === 'in'){ op = 'not in'; pos += 2; }
        else break;
      }
      else if (t && t.t === 'id' && t.v === 'is'){
        var t3 = toks[pos + 1];
        if (t3 && t3.t === 'id' && t3.v === 'not'){ op = 'is not'; pos += 2; }
        else { op = 'is'; pos += 1; }
      }
      else break;
      ops.push({ op: op, r: parseBitOr() });
    }
    if (!ops.length) return l;
    return { t: 'cmp', l: l, ops: ops };
  }
  function parseBitOr(){
    var l = parseBitXor();
    while (peekOp() === '|'){ next(); l = { t: 'binop', op: '|', l: l, r: parseBitXor() }; }
    return l;
  }
  function parseBitXor(){
    var l = parseBitAnd();
    while (peekOp() === '^'){ next(); l = { t: 'binop', op: '^', l: l, r: parseBitAnd() }; }
    return l;
  }
  function parseBitAnd(){
    var l = parseShift();
    while (peekOp() === '&'){ next(); l = { t: 'binop', op: '&', l: l, r: parseShift() }; }
    return l;
  }
  function parseShift(){
    var l = parseAdd(), op = peekOp();
    while (op === '<<' || op === '>>'){ next(); l = { t: 'binop', op: op, l: l, r: parseAdd() }; op = peekOp(); }
    return l;
  }
  function parseAdd(){
    var l = parseMul(), op = peekOp();
    while (op === '+' || op === '-'){ next(); l = { t: 'binop', op: op, l: l, r: parseMul() }; op = peekOp(); }
    return l;
  }
  function parseMul(){
    var l = parseUnary(), op = peekOp();
    while (op === '*' || op === '/' || op === '//' || op === '%'){
      next(); l = { t: 'binop', op: op, l: l, r: parseUnary() }; op = peekOp();
    }
    return l;
  }
  function parseUnary(){
    var op = peekOp();
    if (op === '-' || op === '+' || op === '~'){ next(); return { t: 'unop', op: op, x: parseUnary() }; }
    return parsePower();
  }
  function parsePower(){
    var b = parsePostfix2();
    if (peekOp() === '**'){ next(); return { t: 'binop', op: '**', l: b, r: parseUnary() }; }
    return b;
  }
  function parseAtom(){
    var t = next();
    if (!t) throw pyErr('SyntaxError', 'invalid syntax');
    if (t.t === 'num') return { t: 'num', v: t.v, f: t.f };
    if (t.t === 'str') return { t: 'str', v: t.v };
    if (t.t === 'fstr') return { t: 'fstr', parts: t.parts };
    if (t.t === 'id'){
      if (t.v === 'True') return { t: 'bool', v: true };
      if (t.v === 'False') return { t: 'bool', v: false };
      if (t.v === 'None') return { t: 'none' };
      return { t: 'name', id: t.v };
    }
    if (t.t === 'op' && t.v === '('){
      if (peekOp() === ')'){ next(); return { t: 'tuple', items: [] }; }
      var e = parseExpr();
      if (peekOp() === ','){
        var items = [e];
        while (peekOp() === ','){ next(); if (peekOp() === ')') break; items.push(parseExpr()); }
        expectOp(')');
        return { t: 'tuple', items: items };
      }
      expectOp(')');
      return e;
    }
    if (t.t === 'op' && t.v === '['){
      var items = [];
      if (peekOp() !== ']'){
        for (;;){
          items.push(parseExpr());
          if (peekOp() === ','){ next(); if (peekOp() === ']') break; continue; }
          break;
        }
      }
      expectOp(']');
      return { t: 'list', items: items };
    }
    if (t.t === 'op' && t.v === '{'){
      var pairs = [];
      if (peekOp() !== '}'){
        for (;;){
          var k = parseExpr();
          expectOp(':');
          var vv = parseExpr();
          pairs.push([k, vv]);
          if (peekOp() === ','){ next(); if (peekOp() === '}') break; continue; }
          break;
        }
      }
      expectOp('}');
      return { t: 'dict', pairs: pairs };
    }
    throw pyErr('SyntaxError', 'invalid syntax');
  }

  /* subscript/slice handled here to keep obj reference */
  function parsePostfix2(){
    var node = parseAtom();
    for (;;){
      var op = peekOp();
      if (op === '('){
        next();
        var args = [], kwargs = {};
        if (peekOp() !== ')'){
          for (;;){
            var tt = peek();
            if (tt && tt.t === 'id' && toks[pos + 1] && toks[pos + 1].t === 'op' && toks[pos + 1].v === '='){
              var kn = next().v; next();
              kwargs[kn] = parseExpr();
            } else args.push(parseExpr());
            if (peekOp() === ','){ next(); if (peekOp() === ')') break; continue; }
            break;
          }
        }
        expectOp(')');
        node = { t: 'call', fn: node, args: args, kwargs: kwargs };
      } else if (op === '.'){
        next();
        var nm = next();
        if (!nm || nm.t !== 'id') throw pyErr('SyntaxError', 'invalid syntax');
        node = { t: 'attr', obj: node, name: nm.v };
      } else if (op === '['){
        next();
        node = parseSubscript(node);
        expectOp(']');
      } else break;
    }
    return node;
  }
  function parseSubscript(obj){
    /* slice or index; parse at expression level with ':' detection */
    var saved = pos;
    var first = null, hasFirst = false;
    if (peekOp() !== ':'){ first = parseExpr(); hasFirst = true; }
    if (peekOp() === ':'){
      next();
      var second = null, third = null;
      if (peekOp() !== ':' && peekOp() !== ']') second = parseExpr();
      if (peekOp() === ':'){
        next();
        if (peekOp() !== ']') third = parseExpr();
      }
      return { t: 'slice', obj: obj, a: first, b: second, c: third };
    }
    return { t: 'sub', obj: obj, idx: first };
  }

  function splitTopLevel(tokArr){
    var parts = [], cur = [], depth = 0;
    for (var i = 0; i < tokArr.length; i++){
      var tt = tokArr[i];
      if (tt.t === 'op' && '([{'.indexOf(tt.v) >= 0) depth++;
      if (tt.t === 'op' && ')]}'.indexOf(tt.v) >= 0) depth--;
      if (tt.t === 'op' && tt.v === ';' && depth === 0){ parts.push(cur); cur = []; continue; }
      cur.push(tt);
    }
    parts.push(cur);
    return parts;
  }
  function parseBody(tokArr){
    var out = [], parts = splitTopLevel(tokArr);
    for (var i = 0; i < parts.length; i++){
      if (!parts[i].length) continue;
      var saveToks = toks, savePos = pos;
      toks = parts[i]; pos = 0;
      out.push(parseStmt());
      if (pos !== toks.length) throw pyErr('SyntaxError', 'invalid syntax');
      toks = saveToks; pos = savePos;
    }
    if (!out.length) throw pyErr('SyntaxError', 'invalid syntax');
    return out;
  }
  function parseSuite(){
    /* tokens after ':' on this line form the suite */
    var rest = toks.slice(pos);
    pos = toks.length;
    if (!rest.length) throw pyErr('IndentationError', 'expected an indented block');
    return parseBody(rest);
  }
  function tryTarget(){
    var save = pos;
    var node = parsePostfix2();
    var op = peekOp();
    if ((node.t === 'name' || node.t === 'sub' || node.t === 'attr') &&
        (op === '=' || op === '+=' || op === '-=' || op === '*=' || op === '/=' ||
         op === '//=' || op === '%=' || op === '**=')){
      next();
      return { target: node, op: op };
    }
    pos = save;
    return null;
  }
  function parseStmt(){
    var kw = peekId();
    if (kw === 'for'){
      next();
      var vname = next();
      if (!vname || vname.t !== 'id') throw pyErr('SyntaxError', 'invalid syntax');
      if (peekId() !== 'in') throw pyErr('SyntaxError', 'invalid syntax');
      next();
      /* iter expr up to top-level ':' */
      var depth = 0, itoks = [];
      while (pos < toks.length){
        var tt = toks[pos];
        if (tt.t === 'op' && '([{'.indexOf(tt.v) >= 0) depth++;
        if (tt.t === 'op' && ')]}'.indexOf(tt.v) >= 0) depth--;
        if (tt.t === 'op' && tt.v === ':' && depth === 0) break;
        itoks.push(tt); pos++;
      }
      if (peekOp() !== ':') throw pyErr('SyntaxError', 'invalid syntax');
      next();
      var saveToks = toks, savePos = pos;
      toks = itoks; pos = 0;
      var iter = parseExpr();
      if (pos !== toks.length) throw pyErr('SyntaxError', 'invalid syntax');
      toks = saveToks; pos = savePos;
      var body = parseSuite();
      return { t: 'for', vname: vname.v, iter: iter, body: body };
    }
    if (kw === 'if'){
      next();
      var depth2 = 0, ctoks = [];
      while (pos < toks.length){
        var t2 = toks[pos];
        if (t2.t === 'op' && '([{'.indexOf(t2.v) >= 0) depth2++;
        if (t2.t === 'op' && ')]}'.indexOf(t2.v) >= 0) depth2--;
        if (t2.t === 'op' && t2.v === ':' && depth2 === 0) break;
        ctoks.push(t2); pos++;
      }
      if (peekOp() !== ':') throw pyErr('SyntaxError', 'invalid syntax');
      next();
      var sT = toks, sP = pos;
      toks = ctoks; pos = 0;
      var cond = parseExpr();
      if (pos !== toks.length) throw pyErr('SyntaxError', 'invalid syntax');
      toks = sT; pos = sP;
      /* check for top-level else: */
      var elseBody = null;
      var rest = toks.slice(pos);
      var edepth = 0, eidx = -1;
      for (var e = 0; e < rest.length; e++){
        var et = rest[e];
        if (et.t === 'op' && '([{'.indexOf(et.v) >= 0) edepth++;
        if (et.t === 'op' && ')]}'.indexOf(et.v) >= 0) edepth--;
        if (edepth === 0 && et.t === 'id' && et.v === 'else' &&
            rest[e + 1] && rest[e + 1].t === 'op' && rest[e + 1].v === ':'){ eidx = e; break; }
      }
      var bodyToks = eidx >= 0 ? rest.slice(0, eidx) : rest;
      pos = toks.length;
      var sT2 = toks, sP2 = pos;
      toks = bodyToks; pos = 0;
      var bodyStmts = parseBody(toks);
      toks = sT2;
      pos = sT2.length; /* the whole line was consumed by this statement */
      if (eidx >= 0){
        var elseToks = rest.slice(eidx + 2);
        toks = elseToks; pos = 0;
        elseBody = parseBody(toks);
        toks = sT2;
        pos = sT2.length;
      }
      return { t: 'if', cond: cond, body: bodyStmts, elseBody: elseBody };
    }
    if (kw === 'import' || kw === 'from' || kw === 'del' ||
        kw === 'pass' || kw === 'break' || kw === 'continue'){
      next();
      if (kw === 'pass') return { t: 'pass' };
      if (kw === 'break') return { t: 'break' };
      if (kw === 'continue') return { t: 'continue' };
      if (kw === 'del'){
        var tgt = parsePostfix2();
        if (pos !== toks.length) throw pyErr('SyntaxError', 'invalid syntax');
        return { t: 'del', target: tgt };
      }
      /* import forms */
      if (kw === 'import'){
        var mods = [];
        for (;;){
          var mn = next();
          if (!mn || mn.t !== 'id') throw pyErr('SyntaxError', 'invalid syntax');
          var as = mn.v;
          if (peekId() === 'as'){ next(); var an = next(); as = an.v; }
          mods.push({ mod: mn.v, as: as });
          if (peekOp() === ','){ next(); continue; }
          break;
        }
        return { t: 'import', mods: mods };
      }
      /* from X import a, b */
      var fm = next();
      if (!fm || fm.t !== 'id') throw pyErr('SyntaxError', 'invalid syntax');
      if (peekId() !== 'import') throw pyErr('SyntaxError', 'invalid syntax');
      next();
      var names = [];
      for (;;){
        var nn = next();
        if (!nn || nn.t !== 'id') throw pyErr('SyntaxError', 'invalid syntax');
        names.push(nn.v);
        if (peekOp() === ','){ next(); continue; }
        break;
      }
      return { t: 'fromimport', mod: fm.v, names: names };
    }
    if (kw === 'return' || kw === 'def' || kw === 'class' || kw === 'while' ||
        kw === 'with' || kw === 'try' || kw === 'lambda'){
      throw pyErr('SyntaxError', kw + ' blocks need multiple lines — this REPL is single-line. Try a one-liner instead.');
    }
    var asg = tryTarget();
    if (asg){
      var val = parseExpr();
      if (pos !== toks.length) throw pyErr('SyntaxError', 'invalid syntax');
      return { t: 'assign', target: asg.target, op: asg.op, val: val };
    }
    var ex = parseExpr();
    if (pos !== toks.length) throw pyErr('SyntaxError', 'invalid syntax');
    return { t: 'expr', x: ex };
  }

  return {
    parse: function(){
      var stmts = [];
      var parts = splitTopLevel(toks);
      for (var i = 0; i < parts.length; i++){
        if (!parts[i].length) continue;
        var saveToks = toks, savePos = pos;
        toks = parts[i]; pos = 0;
        stmts.push(parseStmt());
        if (pos !== toks.length) throw pyErr('SyntaxError', 'invalid syntax');
        toks = saveToks; pos = savePos;
      }
      if (!stmts.length) throw pyErr('SyntaxError', 'invalid syntax');
      return stmts;
    }
  };
}

/* ---- python evaluator ---- */
var PY_BUILTINS = {};
var PY_MATH = { $mod: 'math' };

function pyNumOp(op, a, b){
  var ta = pyTypeName(a), tb = pyTypeName(b);
  var fa = isFV(a), fb = isFV(b);
  a = uv(a); b = uv(b);
  if (typeof a !== 'number' || typeof b !== 'number')
    throw pyErr('TypeError', "unsupported operand type(s) for " + op + ": '" + ta + "' and '" + tb + "'");
  if ((fa || fb) && (op === '<<' || op === '>>' || op === '&' || op === '|' || op === '^'))
    throw pyErr('TypeError', "unsupported operand type(s) for " + op + ": '" + ta + "' and '" + tb + "'");
  var r;
  switch (op){
    case '+': r = a + b; break;
    case '-': r = a - b; break;
    case '*': r = a * b; break;
    case '/':
      if (b === 0) throw pyErr('ZeroDivisionError', 'division by zero');
      return wrapF(a / b);
    case '//':
      if (b === 0) throw pyErr('ZeroDivisionError', 'integer division or modulo by zero');
      r = Math.floor(a / b); break;
    case '%':
      if (b === 0) throw pyErr('ZeroDivisionError', 'integer division or modulo by zero');
      r = a - Math.floor(a / b) * b; break;
    case '**': r = Math.pow(a, b); break;
    case '<<': r = a << b; break;
    case '>>': r = a >> b; break;
    case '&': r = a & b; break;
    case '|': r = a | b; break;
    case '^': r = a ^ b; break;
    default: throw pyErr('TypeError', 'unsupported operand');
  }
  return (fa || fb) ? wrapF(r) : r;
}
function pyBinop(op, a, b){
  if (op === '+'){
    if (typeof a === 'string' && typeof b === 'string') return a + b;
    if (Array.isArray(a) && Array.isArray(b)) return a.concat(b);
    if ((typeof a === 'string' || Array.isArray(a) || typeof b === 'string' || Array.isArray(b)))
      throw pyErr('TypeError', 'can only concatenate ' + pyTypeName(a) + ' (not "' + pyTypeName(b) + '") to ' + pyTypeName(a));
    return pyNumOp(op, a, b);
  }
  if (op === '*'){
    if (typeof a === 'string' && typeof b === 'number'){
      if (!pyIsInt(b)) throw pyErr('TypeError', "can't multiply sequence by non-int of type 'float'");
      if (b < 0) return '';
      return repeat(a, b);
    }
    if (typeof b === 'string' && typeof a === 'number') return pyBinop(op, b, a);
    if (Array.isArray(a) && typeof b === 'number'){
      if (!pyIsInt(b)) throw pyErr('TypeError', "can't multiply sequence by non-int of type 'float'");
      var r = [];
      for (var i = 0; i < b; i++) r = r.concat(a.slice());
      return r;
    }
    if (Array.isArray(b) && typeof a === 'number') return pyBinop(op, b, a);
    return pyNumOp(op, a, b);
  }
  return pyNumOp(op, a, b);
}
function pyCompare(op, a, b){
  a = uv(a); b = uv(b);
  if (op === '==') return pyEq(a, b);
  if (op === '!=') return !pyEq(a, b);
  if (op === 'in'){
    if (typeof b === 'string' && typeof a === 'string') return b.indexOf(a) >= 0;
    if (Array.isArray(b)){ for (var i = 0; i < b.length; i++) if (pyEq(a, b[i])) return true; return false; }
    if (pyIsDict(b)) return b.m.hasOwnProperty(dictKey(a));
    throw pyErr('TypeError', "argument of type '" + pyTypeName(b) + "' is not iterable");
  }
  if (op === 'not in') return !pyCompare('in', a, b);
  if (op === 'is') return a === b;
  if (op === 'is not') return a !== b;
  var ta = typeof a, tb = typeof b;
  if (ta === 'number' && tb === 'number' || ta === 'string' && tb === 'string'){
    switch (op){
      case '<': return a < b; case '<=': return a <= b;
      case '>': return a > b; case '>=': return a >= b;
    }
  }
  throw pyErr('TypeError', "'" + op + "' not supported between instances of '" + pyTypeName(a) + "' and '" + pyTypeName(b) + "'");
}
function pyGetItem(obj, idx){
  idx = uv(idx);
  if (typeof obj === 'string' || Array.isArray(obj)){
    if (typeof idx !== 'number' || !pyIsInt(idx))
      throw pyErr('TypeError', pyTypeName(obj) + ' indices must be integers, not ' + pyTypeName(idx));
    var i = idx < 0 ? obj.length + idx : idx;
    if (i < 0 || i >= obj.length)
      throw pyErr('IndexError', (Array.isArray(obj) ? 'list' : 'string') + ' index out of range');
    return obj.charAt ? obj.charAt(i) : obj[i];
  }
  if (pyIsDict(obj)){
    var v = dictGet(obj, idx);
    if (v === undefined) throw pyErr('KeyError', pyRepr(idx));
    return v;
  }
  throw pyErr('TypeError', "'" + pyTypeName(obj) + "' object is not subscriptable");
}
function pySlice(obj, a, b, c){
  var isStr = typeof obj === 'string';
  if (!isStr && !Array.isArray(obj)) throw pyErr('TypeError', 'slice indices must be integers');
  a = uv(a); b = uv(b); c = uv(c);
  var n = obj.length, step = (c === null || c === undefined) ? 1 : c;
  if (typeof step !== 'number' || !pyIsInt(step) || step === 0)
    throw pyErr('ValueError', 'slice step cannot be zero');
  function norm(x, dflt){
    if (x === null || x === undefined) return dflt;
    if (typeof x !== 'number' || !pyIsInt(x)) throw pyErr('TypeError', 'slice indices must be integers or None');
    if (x < 0) x = Math.max(n + x, step > 0 ? 0 : -1);
    return step > 0 ? Math.min(x, n) : Math.min(x, n - 1);
  }
  var start = norm(a, step > 0 ? 0 : n - 1), stop = norm(b, step > 0 ? n : -1);
  var res = isStr ? '' : [], i;
  if (step > 0){ for (i = start; i < stop; i += step) res = isStr ? res + obj.charAt(i) : res.concat([obj[i]]); }
  else { for (i = start; i > stop; i += step) res = isStr ? res + obj.charAt(i) : res.concat([obj[i]]); }
  return res;
}
function pySetItem(obj, idx, val){
  if (Array.isArray(obj)){
    if (typeof idx !== 'number' || !pyIsInt(idx)) throw pyErr('TypeError', 'list indices must be integers');
    var i = idx < 0 ? obj.length + idx : idx;
    if (i < 0 || i >= obj.length) throw pyErr('IndexError', 'list assignment index out of range');
    obj[i] = val; return;
  }
  if (pyIsDict(obj)){ dictSet(obj, idx, val); return; }
  throw pyErr('TypeError', "'" + pyTypeName(obj) + "' object does not support item assignment");
}

function pyCallValue(fval, args, kwargs, env, out){
  if (pyIsBuiltin(fval)){
    var bf = PY_BUILTINS[fval.$b];
    if (!bf) throw pyErr('NameError', "name '" + fval.$b + "' is not defined");
    return bf(args, kwargs, env, out);
  }
  if (pyIsMethod(fval)) return pyMethodCall(fval.obj, fval.$m, args, kwargs);
  if (fval && fval.$mathfn){
    var mf = PY_MATH_FNS[fval.$mathfn];
    return mf(args);
  }
  throw pyErr('TypeError', "'" + pyTypeName(fval) + "' object is not callable");
}

function pyEval(node, env, out){
  switch (node.t){
    case 'num': return node.f ? wrapF(node.v) : node.v;
    case 'str': return node.v;
    case 'bool': return node.v;
    case 'none': return null;
    case 'fstr': {
      var s = '';
      for (var i = 0; i < node.parts.length; i++){
        var p = node.parts[i];
        if (p.s !== undefined) s += p.s;
        else {
          var sub = pyParser(pyTok(p.e)).parse();
          if (sub.length !== 1 || sub[0].t !== 'expr') throw pyErr('SyntaxError', 'invalid syntax');
          s += pyStr(pyEval(sub[0].x, env, out));
        }
      }
      return s;
    }
    case 'name': {
      if (node.id in env) return env[node.id];
      if (PY_BUILTINS[node.id]) return { $b: node.id };
      throw pyErr('NameError', "name '" + node.id + "' is not defined");
    }
    case 'list': {
      var r = [];
      for (var j = 0; j < node.items.length; j++) r.push(pyEval(node.items[j], env, out));
      return r;
    }
    case 'tuple': {
      var rt = [];
      for (var j2 = 0; j2 < node.items.length; j2++) rt.push(pyEval(node.items[j2], env, out));
      rt.$tuple = 1;
      return rt;
    }
    case 'dict': {
      var d = newDict();
      for (var j3 = 0; j3 < node.pairs.length; j3++)
        dictSet(d, pyEval(node.pairs[j3][0], env, out), pyEval(node.pairs[j3][1], env, out));
      return d;
    }
    case 'binop': return pyBinop(node.op, pyEval(node.l, env, out), pyEval(node.r, env, out));
    case 'unop': {
      var xv = pyEval(node.x, env, out);
      var xwf = isFV(xv), x = uv(xv);
      if (node.op === '~'){
        if (xwf || typeof x !== 'number')
          throw pyErr('TypeError', "bad operand type for unary ~: '" + pyTypeName(xv) + "'");
        return ~x;
      }
      if (typeof x !== 'number')
        throw pyErr('TypeError', "bad operand type for unary " + node.op + ": '" + pyTypeName(xv) + "'");
      var ur = node.op === '-' ? -x : +x;
      return xwf ? wrapF(ur) : ur;
    }
    case 'boolop': {
      if (node.op === 'and'){
        var av = pyEval(node.vals[0], env, out);
        return pyTruthy(av) ? pyEval(node.vals[1], env, out) : av;
      }
      var ov = pyEval(node.vals[0], env, out);
      return pyTruthy(ov) ? ov : pyEval(node.vals[1], env, out);
    }
    case 'not': return !pyTruthy(pyEval(node.x, env, out));
    case 'cmp': {
      var l = pyEval(node.l, env, out);
      for (var k = 0; k < node.ops.length; k++){
        var rr = pyEval(node.ops[k].r, env, out);
        if (!pyCompare(node.ops[k].op, l, rr)) return false;
        l = rr;
      }
      return true;
    }
    case 'ifexp': return pyTruthy(pyEval(node.c, env, out)) ? pyEval(node.a, env, out) : pyEval(node.b, env, out);
    case 'call': {
      var fn = pyEval(node.fn, env, out);
      var aa = [];
      for (var a2 = 0; a2 < node.args.length; a2++) aa.push(pyEval(node.args[a2], env, out));
      var kw = {};
      for (var kk in node.kwargs) kw[kk] = pyEval(node.kwargs[kk], env, out);
      return pyCallValue(fn, aa, kw, env, out);
    }
    case 'attr': {
      var o = pyEval(node.obj, env, out);
      if (o && o.$mod === 'math'){
        if (node.name === 'pi') return Math.PI;
        if (node.name === 'e') return Math.E;
        if (node.name === 'tau') return Math.PI * 2;
        if (PY_MATH_FNS[node.name]) return { $mathfn: node.name };
        throw pyErr('AttributeError', "module 'math' has no attribute '" + node.name + "'");
      }
      return { $m: node.name, obj: o };
    }
    case 'sub': return pyGetItem(pyEval(node.obj, env, out), pyEval(node.idx, env, out));
    case 'slice': {
      var so = pyEval(node.obj, env, out);
      var sa = node.a ? pyEval(node.a, env, out) : null;
      var sb = node.b ? pyEval(node.b, env, out) : null;
      var sc = node.c ? pyEval(node.c, env, out) : null;
      return pySlice(so, sa, sb, sc);
    }
  }
  throw pyErr('SyntaxError', 'invalid syntax');
}

function pyMethodCall(obj, name, args, kwargs){
  var tn = pyTypeName(obj);
  function arity(n){
    if (args.length !== n) throw pyErr('TypeError', name + '() takes exactly ' + n + ' argument(s) (' + args.length + ' given)');
  }
  if (tn === 'str'){
    var s = obj;
    switch (name){
      case 'upper': arity(0); return s.toUpperCase();
      case 'lower': arity(0); return s.toLowerCase();
      case 'strip': arity(0); return s.replace(/^\s+|\s+$/g, '');
      case 'lstrip': arity(0); return s.replace(/^\s+/, '');
      case 'rstrip': arity(0); return s.replace(/\s+$/, '');
      case 'capitalize': arity(0); return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
      case 'title': arity(0); return s.replace(/\w\S*/g, function(w){ return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(); });
      case 'split': {
        var sep = args.length ? args[0] : null;
        if (sep === null) return s.split(/\s+/).filter(function(x){ return x !== ''; });
        if (typeof sep !== 'string') throw pyErr('TypeError', 'must be str or None');
        return s.split(sep);
      }
      case 'join': {
        arity(1);
        if (!Array.isArray(args[0])) throw pyErr('TypeError', 'can only join an iterable of str');
        return args[0].map(function(x){
          if (typeof x !== 'string') throw pyErr('TypeError', 'sequence item must be str');
          return x;
        }).join(s);
      }
      case 'replace': {
        if (args.length < 2 || args.length > 3) throw pyErr('TypeError', 'replace() takes 2-3 arguments');
        var cnt = args[2] === undefined ? -1 : args[2];
        if (cnt === -1) return s.split(args[0]).join(args[1]);
        var parts = s.split(args[0]), out = parts[0];
        for (var i = 1; i < parts.length && i <= cnt; i++) out += args[1] + parts[i];
        return out + parts.slice(cnt + 1).join(args[0]);
      }
      case 'startswith': arity(1); return s.indexOf(args[0]) === 0;
      case 'endswith': arity(1); return s.slice(-args[0].length) === args[0];
      case 'find': arity(1); return s.indexOf(args[0]);
      case 'count': arity(1); return s.split(args[0]).length - 1;
      case 'format': throw pyErr('NotImplementedError', 'str.format() is not in this REPL subset — try an f-string');
    }
    throw pyErr('AttributeError', "'str' object has no attribute '" + name + "'");
  }
  if (tn === 'list'){
    switch (name){
      case 'append': arity(1); obj.push(args[0]); return null;
      case 'extend': arity(1); {
        var it = pyIter(args[0]);
        for (var e = 0; e < it.length; e++) obj.push(it[e]);
        return null;
      }
      case 'insert': {
        if (args.length !== 2) throw pyErr('TypeError', 'insert() takes exactly 2 arguments');
        obj.splice(args[0] < 0 ? Math.max(obj.length + args[0], 0) : args[0], 0, args[1]);
        return null;
      }
      case 'remove': arity(1); {
        for (var r2 = 0; r2 < obj.length; r2++) if (pyEq(obj[r2], args[0])){ obj.splice(r2, 1); return null; }
        throw pyErr('ValueError', 'list.remove(x): x not in list');
      }
      case 'pop': {
        if (args.length > 1) throw pyErr('TypeError', 'pop() takes at most 1 argument');
        var idx = args.length ? args[0] : -1;
        if (obj.length === 0) throw pyErr('IndexError', 'pop from empty list');
        var pi = idx < 0 ? obj.length + idx : idx;
        if (pi < 0 || pi >= obj.length) throw pyErr('IndexError', 'pop index out of range');
        return obj.splice(pi, 1)[0];
      }
      case 'index': arity(1); {
        for (var q = 0; q < obj.length; q++) if (pyEq(obj[q], args[0])) return q;
        throw pyErr('ValueError', pyRepr(args[0]) + ' is not in list');
      }
      case 'count': arity(1); {
        var c2 = 0;
        for (var w = 0; w < obj.length; w++) if (pyEq(obj[w], args[0])) c2++;
        return c2;
      }
      case 'sort': {
        var rev = kwargs.reverse === true;
        obj.sort(function(a, b){
          if (typeof a === 'number' && typeof b === 'number') return a - b;
          var sa = pyStr(a), sb = pyStr(b);
          return sa < sb ? -1 : sa > sb ? 1 : 0;
        });
        if (rev) obj.reverse();
        return null;
      }
      case 'reverse': arity(0); obj.reverse(); return null;
      case 'clear': arity(0); obj.length = 0; return null;
      case 'copy': arity(0); return obj.slice();
    }
    throw pyErr('AttributeError', "'list' object has no attribute '" + name + "'");
  }
  if (tn === 'dict'){
    switch (name){
      case 'keys': arity(0); { var ks = []; for (var k in obj.m) ks.push(obj.m[k].k); return ks; }
      case 'values': arity(0); { var vs = []; for (var k2 in obj.m) vs.push(obj.m[k2].v); return vs; }
      case 'items': arity(0); { var ps = []; for (var k3 in obj.m) ps.push([obj.m[k3].k, obj.m[k3].v]); return ps; }
      case 'get': {
        if (args.length < 1 || args.length > 2) throw pyErr('TypeError', 'get() takes 1-2 arguments');
        var gv = dictGet(obj, args[0]);
        return gv === undefined ? (args.length === 2 ? args[1] : null) : gv;
      }
      case 'pop': arity(1); {
        var pk = dictKey(args[0]);
        if (!obj.m.hasOwnProperty(pk)) throw pyErr('KeyError', pyRepr(args[0]));
        var pv = obj.m[pk].v; delete obj.m[pk]; return pv;
      }
      case 'update': arity(1); {
        if (!pyIsDict(args[0])) throw pyErr('TypeError', 'update() argument must be a dict');
        for (var uk in args[0].m) obj.m[uk] = args[0].m[uk];
        return null;
      }
      case 'clear': arity(0); obj.m = {}; return null;
      case 'copy': arity(0); { var cp = newDict(); for (var ck in obj.m) cp.m[ck] = obj.m[ck]; return cp; }
    }
    throw pyErr('AttributeError', "'dict' object has no attribute '" + name + "'");
  }
  throw pyErr('AttributeError', "'" + tn + "' object has no attribute '" + name + "'");
}

function pyIter(v){
  if (Array.isArray(v)) return v.slice();
  if (typeof v === 'string') return v.split('');
  if (pyIsDict(v)){ var ks = []; for (var k in v.m) ks.push(v.m[k].k); return ks; }
  throw pyErr('TypeError', "'" + pyTypeName(v) + "' object is not iterable");
}

/* math functions */
var PY_MATH_FNS = {
  sqrt: function(a){ pyMathArity('sqrt', a, 1); if (a[0] < 0) throw pyErr('ValueError', 'math domain error'); return wrapF(Math.sqrt(a[0])); },
  floor: function(a){ pyMathArity('floor', a, 1); return Math.floor(a[0]); },
  ceil: function(a){ pyMathArity('ceil', a, 1); return Math.ceil(a[0]); },
  pow: function(a){ pyMathArity('pow', a, 2); return wrapF(Math.pow(a[0], a[1])); },
  fabs: function(a){ pyMathArity('fabs', a, 1); return wrapF(Math.abs(a[0])); },
  sin: function(a){ pyMathArity('sin', a, 1); return wrapF(Math.sin(a[0])); },
  cos: function(a){ pyMathArity('cos', a, 1); return wrapF(Math.cos(a[0])); },
  tan: function(a){ pyMathArity('tan', a, 1); return wrapF(Math.tan(a[0])); },
  log: function(a){
    if (a.length < 1 || a.length > 2) throw pyErr('TypeError', 'log() takes 1-2 arguments');
    for (var i = 0; i < a.length; i++) a[i] = uv(a[i]);
    return wrapF(a.length === 2 ? Math.log(a[0]) / Math.log(a[1]) : Math.log(a[0]));
  },
  exp: function(a){ pyMathArity('exp', a, 1); return wrapF(Math.exp(a[0])); },
  factorial: function(a){
    pyMathArity('factorial', a, 1);
    if (!pyIsInt(a[0]) || a[0] < 0) throw pyErr('ValueError', 'factorial() not defined for negative values');
    var r = 1; for (var i = 2; i <= a[0]; i++) r *= i; return r;
  },
  gcd: function(a){ pyMathArity('gcd', a, 2); return pyGcd(Math.abs(a[0]), Math.abs(a[1])); }
};
function pyMathArity(n, a, k){
  if (a.length !== k) throw pyErr('TypeError', n + '() takes exactly ' + k + ' argument(s)');
  for (var i = 0; i < a.length; i++){
    a[i] = uv(a[i]);
    if (typeof a[i] !== 'number') throw pyErr('TypeError', 'must be real number, not ' + pyTypeName(a[i]));
  }
}
function pyGcd(a, b){ return b ? pyGcd(b, a % b) : a; }

/* builtins */
PY_BUILTINS.print = function(args, kwargs, env, out){
  var sep = kwargs.sep !== undefined ? kwargs.sep : ' ';
  var end = kwargs.end !== undefined ? kwargs.end : '\n';
  if (typeof sep !== 'string' || typeof end !== 'string') throw pyErr('TypeError', 'sep/end must be str');
  var line = args.map(pyStr).join(sep);
  out.push(end === '\n' ? line : line + pyStr(end));
  return null;
};
PY_BUILTINS.len = function(args){
  if (args.length !== 1) throw pyErr('TypeError', 'len() takes exactly one argument');
  var v = args[0];
  if (typeof v === 'string' || Array.isArray(v)) return v.length;
  if (pyIsDict(v)){ var n = 0; for (var k in v.m) n++; return n; }
  throw pyErr('TypeError', "object of type '" + pyTypeName(v) + "' has no len()");
};
PY_BUILTINS.type = function(args){
  if (args.length !== 1) throw pyErr('TypeError', 'type() takes exactly one argument');
  return { $cls: pyTypeName(args[0]) };
};
PY_BUILTINS.str = function(args){
  if (args.length > 1) throw pyErr('TypeError', 'str() takes at most 1 argument');
  return args.length ? pyStr(args[0]) : '';
};
PY_BUILTINS.int = function(args, kwargs){
  var base = kwargs.base !== undefined ? kwargs.base : 10;
  if (args.length < 1 || args.length > 2) throw pyErr('TypeError', 'int() takes 1-2 arguments');
  var v = uv(args[0]);
  if (typeof v === 'number'){
    if (!isFinite(v)) throw pyErr('OverflowError', 'cannot convert float infinity to integer');
    return v < 0 ? Math.ceil(v) : Math.floor(v);
  }
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string'){
    var s = trim(v);
    var n = parseInt(s, base);
    if (isNaN(n) || !/^[+-]?[0-9a-zA-Z_]+$/.test(s)) throw pyErr('ValueError', "invalid literal for int() with base " + base + ": " + pyRepr(args[0]));
    return n;
  }
  throw pyErr('TypeError', "int() argument must be a string or a number, not '" + pyTypeName(v) + "'");
};
PY_BUILTINS.float = function(args){
  if (args.length > 1) throw pyErr('TypeError', 'float() takes at most 1 argument');
  if (!args.length) return wrapF(0);
  var v = uv(args[0]);
  if (typeof v === 'number') return wrapF(v);
  if (typeof v === 'boolean') return wrapF(v ? 1 : 0);
  if (typeof v === 'string'){
    var s = trim(v).toLowerCase();
    if (s === 'inf' || s === '+inf' || s === 'infinity') return wrapF(Infinity);
    if (s === '-inf') return wrapF(-Infinity);
    if (s === 'nan') return wrapF(NaN);
    var n = parseFloat(v);
    if (isNaN(n)) throw pyErr('ValueError', 'could not convert string to float: ' + pyRepr(args[0]));
    return wrapF(n);
  }
  throw pyErr('TypeError', "float() argument must be a string or a number, not '" + pyTypeName(v) + "'");
};
PY_BUILTINS.bool = function(args){
  if (args.length > 1) throw pyErr('TypeError', 'bool() takes at most 1 argument');
  return args.length ? pyTruthy(args[0]) : false;
};
PY_BUILTINS.abs = function(args){
  if (args.length !== 1) throw pyErr('TypeError', 'abs() takes exactly one argument');
  var wf = isFV(args[0]), v = uv(args[0]);
  if (typeof v !== 'number') throw pyErr('TypeError', "bad operand type for abs(): '" + pyTypeName(args[0]) + "'");
  return wf ? wrapF(Math.abs(v)) : Math.abs(v);
};
PY_BUILTINS.round = function(args){
  if (args.length < 1 || args.length > 2) throw pyErr('TypeError', 'round() takes 1-2 arguments');
  var v = uv(args[0]);
  if (typeof v !== 'number') throw pyErr('TypeError', "type '" + pyTypeName(args[0]) + "' doesn't define __round__");
  if (args.length === 2){
    var nd = uv(args[1]);
    var f = Math.pow(10, nd);
    return wrapF(Math.round(v * f) / f);
  }
  return Math.round(v);
};
PY_BUILTINS.sum = function(args){
  if (args.length < 1 || args.length > 2) throw pyErr('TypeError', 'sum() takes 1-2 arguments');
  var it = pyIter(args[0]), tot = args.length === 2 ? uv(args[1]) : 0, s = '';
  var fl = isFV(args[1]);
  for (var i = 0; i < it.length; i++){
    if (typeof it[i] === 'string'){ s += it[i]; continue; }
    fl = fl || isFV(it[i]);
    tot = uv(pyBinop('+', tot, it[i]));
  }
  if (s && tot === 0 && !fl) return s;
  return fl ? wrapF(tot) : tot;
};
PY_BUILTINS.min = function(args){
  var it = args.length === 1 ? pyIter(args[0]) : args;
  if (!it.length) throw pyErr('ValueError', 'min() arg is an empty sequence');
  var m = it[0];
  for (var i = 1; i < it.length; i++) if (pyCompare('<', it[i], m)) m = it[i];
  return m;
};
PY_BUILTINS.max = function(args){
  var it = args.length === 1 ? pyIter(args[0]) : args;
  if (!it.length) throw pyErr('ValueError', 'max() arg is an empty sequence');
  var m = it[0];
  for (var i = 1; i < it.length; i++) if (pyCompare('>', it[i], m)) m = it[i];
  return m;
};
PY_BUILTINS.sorted = function(args, kwargs){
  if (args.length !== 1) throw pyErr('TypeError', 'sorted() takes exactly 1 argument');
  var it = pyIter(args[0]).slice();
  it.sort(function(a, b){
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    var sa = pyStr(a), sb = pyStr(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });
  if (kwargs.reverse === true) it.reverse();
  return it;
};
PY_BUILTINS.range = function(args){
  if (args.length < 1 || args.length > 3) throw pyErr('TypeError', 'range() takes 1-3 arguments');
  for (var i = 0; i < args.length; i++)
    if (typeof args[i] !== 'number' || !pyIsInt(args[i]))
      throw pyErr('TypeError', "'" + pyTypeName(args[i]) + "' object cannot be interpreted as an integer");
  var start = 0, stop, step = 1;
  if (args.length === 1) stop = args[0];
  else if (args.length === 2){ start = args[0]; stop = args[1]; }
  else { start = args[0]; stop = args[1]; step = args[2]; }
  if (step === 0) throw pyErr('ValueError', 'range() arg 3 must not be zero');
  var r = [];
  if (step > 0) for (var a = start; a < stop; a += step) r.push(a);
  else for (var b = start; b > stop; b += step) r.push(b);
  return r;
};
PY_BUILTINS.enumerate = function(args){
  if (args.length !== 1) throw pyErr('TypeError', 'enumerate() takes exactly 1 argument');
  var it = pyIter(args[0]), r = [];
  for (var i = 0; i < it.length; i++) r.push([i, it[i]]);
  return r;
};
PY_BUILTINS.zip = function(args){
  var its = args.map(pyIter), n = Math.min.apply(null, its.map(function(x){ return x.length; }));
  var r = [];
  for (var i = 0; i < n; i++){ var row = []; for (var j = 0; j < its.length; j++) row.push(its[j][i]); r.push(row); }
  return r;
};
PY_BUILTINS.input = function(){
  throw pyErr('EOFError', 'EOF when reading a line');
};
PY_BUILTINS.dir = function(args, kwargs, env){
  if (args.length) throw pyErr('TypeError', 'dir() with arguments is not in this REPL subset');
  var names = [];
  for (var k in env) if (env.hasOwnProperty(k) && k.charAt(0) !== '_') names.push(k);
  for (var b in PY_BUILTINS) names.push(b);
  names.push('math');
  return names.sort();
};
PY_BUILTINS.vars = function(args, kwargs, env){
  if (args.length) throw pyErr('TypeError', 'vars() with arguments is not in this REPL subset');
  var d = newDict();
  for (var k in env) if (env.hasOwnProperty(k) && k.charAt(0) !== '_') dictSet(d, k, env[k]);
  return d;
};
PY_BUILTINS.help = function(args, kwargs, env, out){
  out.push(pyHelpText());
  return null;
};

function pyHelpText(){
  return [
    'Python 3.12 REPL (simulated subset) — Interstitium Labs',
    '',
    'Statements:  x = expr | x += n | for i in range(n): stmt | if cond: stmt [else: stmt]',
    '             import math | from math import sqrt | del x | expr',
    'Builtins:    print len type str int float bool abs round sum min max',
    '             sorted range enumerate zip input dir vars help',
    'Types:       int float str bool list dict | indexing, slicing, f-strings',
    'Methods:     str.upper/lower/strip/split/join/replace/startswith/endswith/find',
    '             list.append/extend/insert/remove/pop/index/count/sort/reverse/clear/copy',
    '             dict.keys/values/items/get/pop/update/clear/copy',
    'math:        import math, then math.sqrt/floor/ceil/pow/sin/cos/log/exp/factorial/gcd, math.pi/e/tau',
    'Meta:        help  clear  history  vars  exit'
  ].join('\n');
}

/* statement execution */
function pyExec(stmt, env, out){
  switch (stmt.t){
    case 'expr': {
      var v = pyEval(stmt.x, env, out);
      if (v !== null) out.push(pyRepr(v));
      return;
    }
    case 'assign': {
      var val = pyEval(stmt.val, env, out);
      var t2 = stmt.target;
      if (stmt.op !== '='){
        var cur;
        if (t2.t === 'name'){
          if (!(t2.id in env)) throw pyErr('NameError', "name '" + t2.id + "' is not defined");
          cur = env[t2.id];
        } else if (t2.t === 'sub') cur = pyGetItem(pyEval(t2.obj, env, out), pyEval(t2.idx, env, out));
        else cur = pyEval(t2.obj, env, out)[t2.name];
        val = pyBinop(stmt.op.charAt(0), cur, val);
      }
      if (t2.t === 'name') env[t2.id] = val;
      else if (t2.t === 'sub') pySetItem(pyEval(t2.obj, env, out), pyEval(t2.idx, env, out), val);
      else {
        var oo = pyEval(t2.obj, env, out);
        if (pyIsDict(oo)) dictSet(oo, t2.name, val);
        else throw pyErr('AttributeError', "can't set attribute");
      }
      return;
    }
    case 'for': {
      var it = pyEval(stmt.iter, env, out);
      var items = pyIter(it);
      for (var i = 0; i < items.length; i++){
        env[stmt.vname] = items[i];
        try {
          for (var s2 = 0; s2 < stmt.body.length; s2++) pyExec(stmt.body[s2], env, out);
        } catch (e){
          if (e && e.$brk === 1) break;
          if (e && e.$brk === 2) continue;
          throw e;
        }
      }
      return;
    }
    case 'if': {
      var c = pyEval(stmt.cond, env, out);
      var body = pyTruthy(c) ? stmt.body : (stmt.elseBody || []);
      for (var s3 = 0; s3 < body.length; s3++) pyExec(body[s3], env, out);
      return;
    }
    case 'import': {
      for (var m = 0; m < stmt.mods.length; m++){
        var mm = stmt.mods[m];
        if (mm.mod === 'math') env[mm.as] = PY_MATH;
        else throw pyErr('ModuleNotFoundError', "No module named '" + mm.mod + "'");
      }
      return;
    }
    case 'fromimport': {
      if (stmt.mod !== 'math') throw pyErr('ModuleNotFoundError', "No module named '" + stmt.mod + "'");
      for (var n2 = 0; n2 < stmt.names.length; n2++){
        var nm = stmt.names[n2];
        if (nm === 'pi') env.pi = Math.PI;
        else if (nm === 'e') env.e = Math.E;
        else if (nm === 'tau') env.tau = Math.PI * 2;
        else if (PY_MATH_FNS[nm]) env[nm] = { $mathfn: nm };
        else throw pyErr('ImportError', "cannot import name '" + nm + "' from 'math'");
      }
      return;
    }
    case 'del': {
      var dt = stmt.target;
      if (dt.t === 'name'){
        if (!(dt.id in env)) throw pyErr('NameError', "name '" + dt.id + "' is not defined");
        delete env[dt.id];
      } else if (dt.t === 'sub'){
        var so = pyEval(dt.obj, env, out), si = pyEval(dt.idx, env, out);
        if (Array.isArray(so)){
          var ii = si < 0 ? so.length + si : si;
          so.splice(ii, 1);
        } else if (pyIsDict(so)) delete so.m[dictKey(si)];
        else throw pyErr('TypeError', 'del not supported here');
      } else throw pyErr('SyntaxError', 'invalid syntax');
      return;
    }
    case 'break': throw { $brk: 1 };
    case 'continue': throw { $brk: 2 };
    case 'pass': return;
  }
  throw pyErr('SyntaxError', 'invalid syntax');
}

/* ---- python profile ---- */
defineProfile('python', {
  label: 'Python 3.12 REPL',
  shellName: 'Python REPL',
  prompt: '>>> ',
  initState: function(){ return { env: {} }; },
  commands: (function(){
    var cmds = {
      help: { d: 'Show Python REPL help', run: function(){ return pyHelpText(); } },
      clear: { d: 'Clear the terminal screen', run: function(){ clearScreen(); return ''; } },
      history: { d: 'Show command history', run: function(){
        var out = [];
        for (var i = 0; i < term.hist.length; i++) out.push('  ' + (i+1) + '  ' + term.hist[i]);
        return out.length ? out.join('\n') : '(no history yet)';
      }},
      vars: { d: 'Show defined variables', run: function(a, ctx){
        var env = ctx.state.env || {};
        var names = Object.keys(env).filter(function(k){ return k.charAt(0) !== '_'; }).sort();
        if (!names.length) return '(no variables defined yet)';
        return names.map(function(k){ return k + ' = ' + pyRepr(env[k]); }).join('\n');
      }},
      exit: { d: 'Exit (kept open — simulated)', run: function(){
        return 'Use clear to wipe the screen — the simulated REPL stays open for practice.';
      }},
      quit: { d: 'Exit (kept open — simulated)', run: function(){
        return 'Use clear to wipe the screen — the simulated REPL stays open for practice.';
      }}
    };
    var builtinDesc = {
      print: 'Print values', len: 'Length of a sequence', type: 'Show the type',
      str: 'Convert to string', int: 'Convert to integer', float: 'Convert to float',
      bool: 'Convert to boolean', abs: 'Absolute value', round: 'Round a number',
      sum: 'Sum an iterable', min: 'Smallest item', max: 'Largest item',
      sorted: 'Sorted list copy', range: 'Range of integers', enumerate: 'Index/value pairs',
      zip: 'Aggregate iterables', input: 'Read input (simulated EOF)', dir: 'List names',
      help: 'Show help'
    };
    Object.keys(builtinDesc).forEach(function(b){
      if (!cmds[b]) cmds[b] = { d: builtinDesc[b] + ' (Python builtin)', run: function(a, ctx){
        return pyRepr({ $b: b });
      }};
    });
    return cmds;
  })(),
  runLine: function(line, ctx){
    var t = trim(line);
    var head = t.split(/\s+/)[0];
    if (head === 'clear' || head === 'history' || head === 'vars' ||
        head === 'exit' || head === 'quit' || t === 'help'){
      var cmd = (t === 'help') ? this.commands.help : this.commands[head];
      if (cmd) return cmd.run([], ctx);
    }
    /* full python evaluation */
    var env = ctx.state.env, out = [];
    try {
      var stmts = pyParser(pyTok(t)).parse();
      for (var i = 0; i < stmts.length; i++) pyExec(stmts[i], env, out);
    } catch(e){
      if (e && e.$brk) return pyTraceback(pyErr('SyntaxError', "'break' outside loop"));
      if (e && e.pyName) return pyTraceback(e);
      return pyTraceback(pyErr('Error', String((e && e.message) || e)));
    }
    return out.join('\n');
  }
});

/* ================= BASH PROFILE (simulated filesystem) ================= */
function newBashFS(){
  function D(kids){ return { t: 'd', kids: kids || {} }; }
  function F(content){ return { t: 'f', content: content }; }
  return D({
    home: D({ candidate: D({
      'README.md': F('# Practice workspace\n\nInterstitium Labs hands-on terminal.\nTry: ls, cat notes.txt, cd logs, grep ERROR app.log\n'),
      'notes.txt': F(
        'Linux essentials — study notes\n' +
        '===============================\n' +
        '- ls -la : long listing incl. hidden files\n' +
        '- chmod 755 script.sh : rwxr-xr-x\n' +
        '- grep -R "TODO" . : recursive search\n' +
        '- ps aux | grep python : find processes\n' +
        '- df -h / du -sh * : disk usage\n' +
        '- history | tail -20 : recent commands\n'),
      'app.py': F(
        'def greet(name):\n' +
        '    return f"hello, {name}"\n\n' +
        'for i in range(3):\n' +
        '    print(greet("candidate"), i)\n'),
      logs: D({
        'app.log': F(
          '2026-10-04 09:12:01 INFO  server starting on :8080\n' +
          '2026-10-04 09:12:04 INFO  connected to postgres (3ms)\n' +
          '2026-10-04 09:14:47 ERROR connection refused: cache:6379\n' +
          '2026-10-04 09:14:48 WARN  retry 1/3 in 2s\n' +
          '2026-10-04 09:14:51 INFO  cache reachable, pool=10\n' +
          '2026-10-04 09:20:02 ERROR timeout after 30s: /api/report\n'),
        'access.log': F(
          '10.0.0.8 - - [04/Oct/2026:09:12:11] "GET /health HTTP/1.1" 200 12\n' +
          '10.0.0.8 - - [04/Oct/2026:09:15:02] "POST /api/report HTTP/1.1" 504 0\n' +
          '10.0.0.8 - - [04/Oct/2026:09:21:40] "GET /api/report HTTP/1.1" 200 48211\n')
      }),
      '.bashrc': F('# ~/.bashrc — simulated\nPS1="candidate@interstitium:\\w$ "\nalias ll="ls -la"\n')
    })}),
    etc: D({
      hosts: F('127.0.0.1\tlocalhost\n::1\t\tlocalhost\n10.0.0.8\tinterstitium\n'),
      passwd: F('root:x:0:0:root:/root:/bin/bash\ncandidate:x:1000:1000::/home/candidate:/bin/bash\n')
    }),
    var: D({ log: D({ syslog: F('Oct  4 09:00:01 interstitium systemd[1]: Started daily backup.\nOct  4 09:12:01 interstitium kernel: eth0: link up\n') }) }),
    tmp: D({})
  });
}
function bashResolve(cwdParts, p){
  var path = String(p || '');
  if (path.charAt(0) === '~') path = '/home/candidate' + path.slice(1);
  var parts = path.charAt(0) === '/' ? [] : cwdParts.slice();
  var segs = path.split('/');
  for (var i = 0; i < segs.length; i++){
    var s = segs[i];
    if (s === '' || s === '.') continue;
    if (s === '..'){ if (parts.length) parts.pop(); continue; }
    parts.push(s);
  }
  return parts;
}
function bashGet(root, parts){
  var n = root, i;
  for (i = 0; i < parts.length; i++){
    if (!n || n.t !== 'd' || !n.kids.hasOwnProperty(parts[i])) return null;
    n = n.kids[parts[i]];
  }
  return n;
}
function bashParent(root, parts){
  if (!parts.length) return null;
  var pn = bashGet(root, parts.slice(0, -1));
  return pn && pn.t === 'd' ? pn : null;
}
function bashLsLine(name, node){
  if (node.t === 'd') return 'drwxr-xr-x 2 candidate candidate 4096 Oct  4 09:12 ' + name + '/';
  var size = node.content.length;
  return '-rw-r--r-- 1 candidate candidate ' + padLeft(size, 5) + ' Oct  4 09:12 ' + name;
}
function bashReadFile(st, path, cmd){
  var parts = bashResolve(st.cwd, path);
  var n = bashGet(st.root, parts);
  if (!n) return { err: cmd + ': ' + path + ': No such file or directory' };
  if (n.t === 'd') return { err: cmd + ': ' + path + ': Is a directory' };
  return { node: n, parts: parts };
}

defineProfile('bash', {
  label: 'Bash 5.2',
  shellName: 'bash (simulated filesystem)',
  tool: 'bash',
  prompt: function(t){
    var cwd = t.state.cwd;
    var disp;
    if (cwd.length === 2 && cwd[0] === 'home' && cwd[1] === 'candidate') disp = '~';
    else if (cwd.length > 2 && cwd[0] === 'home' && cwd[1] === 'candidate') disp = '~/' + cwd.slice(2).join('/');
    else disp = '/' + cwd.join('/');
    return 'candidate@interstitium:' + disp + '$ ';
  },
  initState: function(){
    return {
      root: newBashFS(), cwd: ['home', 'candidate'], oldpwd: ['home', 'candidate'],
      env: {
        USER: 'candidate', LOGNAME: 'candidate', HOME: '/home/candidate',
        HOSTNAME: 'interstitium', SHELL: '/bin/bash',
        PATH: '/usr/local/bin:/usr/bin:/bin:/usr/local/games',
        LANG: 'en_US.UTF-8', TERM: 'xterm-256color', SHLVL: '1'
      },
      boot: Date.now()
    };
  },
  extraComplete: function(toks, frag, t){
    if (toks.length !== 2) return [];
    var fileCmds = ['ls','cd','cat','head','tail','wc','grep','rm','mkdir','touch','cp','mv'];
    if (fileCmds.indexOf(toks[0]) < 0) return [];
    var st = t.state;
    var dir = frag, base = '';
    var li = frag.lastIndexOf('/');
    if (li >= 0){ dir = frag.slice(0, li + 1) || '/'; base = frag.slice(li + 1); }
    else dir = '.';
    var node = bashGet(st.root, bashResolve(st.cwd, dir));
    if (!node || node.t !== 'd') return [];
    var out = [];
    Object.keys(node.kids).forEach(function(k){
      if (k.indexOf(base) === 0) out.push((li >= 0 ? frag.slice(0, li + 1) : '') + k);
    });
    return out;
  },
  runLine: function(line, ctx){
    /* echo with redirection, handled before dispatch */
    var m = line.match(/^\s*echo(\s+([\s\S]*?))?\s*(>>?)\s*(\S+)\s*$/);
    if (m && m[3]){
      var st0 = ctx.state;
      var text = (m[2] || '').replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, function(mm, v){
        return st0.env[v] !== undefined ? st0.env[v] : '';
      });
      var parts = bashResolve(st0.cwd, m[4]);
      var parent = bashParent(st0.root, parts);
      var nm = parts[parts.length - 1];
      if (!parent) return 'bash: ' + m[4] + ': No such file or directory';
      var cur = parent.kids[nm];
      if (cur && cur.t === 'd') return 'bash: ' + m[4] + ': Is a directory';
      var body = text.replace(/^(['"])([\s\S]*)\1$/, '$2');
      parent.kids[nm] = { t: 'f', content: (m[3] === '>>' && cur ? cur.content : '') + body + '\n' };
      return '';
    }
    return defaultRunLine(line, ctx);
  },
  commands: metaCommands({
    ls: { d: 'List directory contents', run: function(a, ctx){
      var st = ctx.state, long = false, all = false, target = null;
      a.forEach(function(x){
        if (x.charAt(0) === '-'){
          if (x.indexOf('l') >= 0) long = true;
          if (x.indexOf('a') >= 0) all = true;
        } else target = x;
      });
      var node = target ? bashGet(st.root, bashResolve(st.cwd, target)) : bashGet(st.root, st.cwd);
      if (!node) return 'ls: cannot access ' + target + ': No such file or directory';
      if (node.t === 'f') return long ? bashLsLine(target.split('/').pop(), node) : target;
      var names = Object.keys(node.kids).sort();
      if (!all) names = names.filter(function(x){ return x.charAt(0) !== '.'; });
      if (long) return names.map(function(x){ return bashLsLine(x, node.kids[x]); }).join('\n');
      return names.map(function(x){ return node.kids[x].t === 'd' ? x + '/' : x; }).join('   ');
    }},
    cd: { d: 'Change directory', run: function(a, ctx){
      var st = ctx.state, dest = a[0];
      if (!dest || dest === '~'){ st.oldpwd = st.cwd; st.cwd = ['home','candidate']; return ''; }
      if (dest === '-'){ var tmp = st.cwd; st.cwd = st.oldpwd; st.oldpwd = tmp; return '/' + st.cwd.join('/'); }
      var parts = bashResolve(st.cwd, dest);
      var n = bashGet(st.root, parts);
      if (!n) return 'bash: cd: ' + dest + ': No such file or directory';
      if (n.t !== 'd') return 'bash: cd: ' + dest + ': Not a directory';
      st.oldpwd = st.cwd; st.cwd = parts;
      return '';
    }},
    pwd: { d: 'Print working directory', run: function(a, ctx){ return '/' + ctx.state.cwd.join('/'); } },
    cat: { d: 'Concatenate files', run: function(a, ctx){
      var st = ctx.state, files = a.filter(function(x){ return x.charAt(0) !== '-'; });
      if (!files.length) return 'cat: reading from stdin is not simulated — pass a file';
      var out = [];
      for (var i = 0; i < files.length; i++){
        var r = bashReadFile(st, files[i], 'cat');
        if (r.err) return r.err;
        out.push(r.node.content.replace(/\n$/, ''));
      }
      return out.join('\n');
    }},
    echo: { d: 'Print text ($VAR expands)', run: function(a, ctx){
      var st = ctx.state;
      return a.map(function(x){
        return x.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, function(mm, v){
          return st.env[v] !== undefined ? st.env[v] : '';
        });
      }).join(' ');
    }},
    grep: { d: 'Search text in files', run: function(a, ctx){
      var st = ctx.state, ci = false, ln = false, rec = false, pat = null, files = [];
      for (var i = 0; i < a.length; i++){
        var x = a[i];
        if (!pat && x.charAt(0) === '-' && x.length > 1){
          if (x.indexOf('i') >= 0) ci = true;
          if (x.indexOf('n') >= 0) ln = true;
          if (x.indexOf('r') >= 0 || x.indexOf('R') >= 0) rec = true;
        } else if (pat === null) pat = x;
        else files.push(x);
      }
      if (pat === null) return 'Usage: grep [-inr] PATTERN [FILE]...';
      if (!files.length) return 'grep: reading from stdin is not simulated — pass a file';
      var out = [], found = false;
      function scanFile(node, label){
        var lines = node.content.split('\n');
        for (var l = 0; l < lines.length; l++){
          var hay = ci ? lines[l].toLowerCase() : lines[l];
          var nd = ci ? pat.toLowerCase() : pat;
          if (hay.indexOf(nd) >= 0){
            found = true;
            out.push((files.length > 1 || rec ? label + ':' : '') + (ln ? (l+1) + ':' : '') + lines[l]);
          }
        }
      }
      function walk(node, prefix){
        Object.keys(node.kids).forEach(function(k){
          var c = node.kids[k];
          if (c.t === 'f') scanFile(c, prefix + k);
          else if (rec) walk(c, prefix + k + '/');
        });
      }
      for (var f = 0; f < files.length; f++){
        var n = bashGet(st.root, bashResolve(st.cwd, files[f]));
        if (!n){ out.push('grep: ' + files[f] + ': No such file or directory'); continue; }
        if (n.t === 'd'){ if (rec) walk(n, files[f].replace(/\/?$/, '/')); else out.push('grep: ' + files[f] + ': Is a directory'); continue; }
        scanFile(n, files[f]);
      }
      return out.join('\n');
    }},
    mkdir: { d: 'Create directories', run: function(a, ctx){
      var st = ctx.state, mkp = false, dirs = [];
      a.forEach(function(x){ if (x === '-p') mkp = true; else if (x.charAt(0) !== '-') dirs.push(x); });
      if (!dirs.length) return 'mkdir: missing operand';
      for (var i = 0; i < dirs.length; i++){
        var parts = bashResolve(st.cwd, dirs[i]);
        var cur = st.root;
        for (var j = 0; j < parts.length; j++){
          var nm = parts[j];
          if (!cur.kids[nm]){
            if (!mkp && j < parts.length - 1) return 'mkdir: cannot create directory ' + dirs[i] + ': No such file or directory';
            cur.kids[nm] = { t: 'd', kids: {} };
          } else if (cur.kids[nm].t !== 'd') return 'mkdir: cannot create directory ' + dirs[i] + ': Not a directory';
          cur = cur.kids[nm];
        }
      }
      return '';
    }},
    touch: { d: 'Create empty files', run: function(a, ctx){
      var st = ctx.state, files = a.filter(function(x){ return x.charAt(0) !== '-'; });
      if (!files.length) return 'touch: missing file operand';
      for (var i = 0; i < files.length; i++){
        var parts = bashResolve(st.cwd, files[i]);
        var parent = bashParent(st.root, parts);
        if (!parent) return 'touch: cannot touch ' + files[i] + ': No such file or directory';
        var nm = parts[parts.length - 1];
        if (!parent.kids[nm]) parent.kids[nm] = { t: 'f', content: '' };
      }
      return '';
    }},
    rm: { d: 'Remove files/dirs (simulated)', run: function(a, ctx){
      var st = ctx.state, rec = false, force = false, targets = [];
      a.forEach(function(x){
        if (x.charAt(0) === '-'){ if (x.indexOf('r') >= 0 || x.indexOf('R') >= 0) rec = true; if (x.indexOf('f') >= 0) force = true; }
        else targets.push(x);
      });
      if (!targets.length) return 'rm: missing operand';
      for (var i = 0; i < targets.length; i++){
        var parts = bashResolve(st.cwd, targets[i]);
        if (!parts.length) return 'rm: it is dangerous to operate recursively on \'/\' — refused (simulated)';
        var parent = bashParent(st.root, parts);
        var nm = parts[parts.length - 1];
        if (!parent || !parent.kids[nm]){
          if (!force) return 'rm: cannot remove ' + targets[i] + ': No such file or directory';
          continue;
        }
        if (parent.kids[nm].t === 'd' && !rec) return 'rm: cannot remove ' + targets[i] + ': Is a directory';
        delete parent.kids[nm];
      }
      return '';
    }},
    cp: { d: 'Copy files', run: function(a, ctx){
      var st = ctx.state, files = a.filter(function(x){ return x.charAt(0) !== '-'; });
      if (files.length < 2) return 'cp: missing destination file operand';
      var sp = bashResolve(st.cwd, files[0]);
      var src = bashGet(st.root, sp);
      if (!src) return 'cp: cannot stat ' + files[0] + ': No such file or directory';
      if (src.t === 'd') return 'cp: -r not specified; omitting directory ' + files[0];
      var dp = bashResolve(st.cwd, files[1]);
      var dest = bashGet(st.root, dp);
      var name, par;
      if (dest && dest.t === 'd'){ par = dest; name = sp[sp.length - 1]; }
      else { par = bashParent(st.root, dp); name = dp[dp.length - 1]; }
      if (!par) return 'cp: cannot create ' + files[1] + ': No such file or directory';
      par.kids[name] = { t: 'f', content: src.content };
      return '';
    }},
    mv: { d: 'Move/rename files', run: function(a, ctx){
      var st = ctx.state, files = a.filter(function(x){ return x.charAt(0) !== '-'; });
      if (files.length < 2) return 'mv: missing destination file operand';
      var sp = bashResolve(st.cwd, files[0]);
      var spar = bashParent(st.root, sp);
      var snm = sp[sp.length - 1];
      if (!spar || !spar.kids[snm]) return 'mv: cannot stat ' + files[0] + ': No such file or directory';
      var dp = bashResolve(st.cwd, files[1]);
      var dest = bashGet(st.root, dp);
      var par, name;
      if (dest && dest.t === 'd'){ par = dest; name = snm; }
      else { par = bashParent(st.root, dp); name = dp[dp.length - 1]; }
      if (!par) return 'mv: cannot move to ' + files[1] + ': No such file or directory';
      par.kids[name] = spar.kids[snm];
      delete spar.kids[snm];
      return '';
    }},
    whoami: { d: 'Print current user', run: function(){ return 'candidate'; } },
    hostname: { d: 'Print system hostname', run: function(){ return 'interstitium'; } },
    id: { d: 'Print user identity', run: function(){ return 'uid=1000(candidate) gid=1000(candidate) groups=1000(candidate)'; } },
    uname: { d: 'Print system info', run: function(a){
      if (a.indexOf('-a') >= 0) return 'Linux interstitium 6.8.0-ilb x86_64 GNU/Linux (simulated)';
      return 'Linux';
    }},
    ps: { d: 'List processes', run: function(){
      return ['  PID TTY          TIME CMD',
              '  412 pts/0    00:00:00 bash',
              '  891 pts/0    00:00:00 python3 app.py',
              ' 1337 pts/0    00:00:01 node server.js',
              ' 2048 pts/0    00:00:00 ps'].join('\n');
    }},
    df: { d: 'Disk space usage', run: function(){
      return ['Filesystem      Size  Used Avail Use% Mounted on',
              '/dev/sda1       1.8T  1.0T  800G  57% /',
              'tmpfs            32G     0   32G   0% /dev/shm'].join('\n');
    }},
    env: { d: 'Print environment', run: function(a, ctx){
      var st = ctx.state, out = [];
      Object.keys(st.env).forEach(function(k){ out.push(k + '=' + st.env[k]); });
      out.push('PWD=/' + st.cwd.join('/'));
      out.push('OLDPWD=/' + st.oldpwd.join('/'));
      return out.join('\n');
    }},
    head: { d: 'First lines of files', run: function(a, ctx){
      return bashHeadTail(a, ctx, 'head');
    }},
    tail: { d: 'Last lines of files', run: function(a, ctx){
      return bashHeadTail(a, ctx, 'tail');
    }},
    wc: { d: 'Count lines/words/bytes', run: function(a, ctx){
      var st = ctx.state, mode = null, files = [];
      a.forEach(function(x){
        if (x === '-l' || x === '-w' || x === '-c') mode = x;
        else if (x.charAt(0) !== '-') files.push(x);
      });
      if (!files.length) return 'wc: reading from stdin is not simulated — pass a file';
      var out = [], tl = 0, tw = 0, tc = 0;
      for (var i = 0; i < files.length; i++){
        var r = bashReadFile(st, files[i], 'wc');
        if (r.err) return r.err;
        var lines = r.node.content.split('\n');
        if (lines[lines.length - 1] === '') lines.pop();
        var words = r.node.content.split(/\s+/).filter(function(w){ return w !== ''; }).length;
        tl += lines.length; tw += words; tc += r.node.content.length;
        var row = mode === '-l' ? lines.length : mode === '-w' ? words : mode === '-c' ? r.node.content.length
          : padLeft(lines.length, 7) + padLeft(words, 8) + padLeft(r.node.content.length, 8);
        out.push(row + ' ' + files[i]);
      }
      if (files.length > 1){
        var tot = mode === '-l' ? tl : mode === '-w' ? tw : mode === '-c' ? tc
          : padLeft(tl, 7) + padLeft(tw, 8) + padLeft(tc, 8);
        out.push(tot + ' total');
      }
      return out.join('\n');
    }},
    date: { d: 'Current date/time', run: function(){ return new Date().toString(); } },
    nmap: { d: 'Scan a host (simulated)', run: function(a){
      var target = a.filter(function(x){ return x.charAt(0) !== '-'; })[0] || 'scanme.interstitium.lab';
      return ['Starting Nmap (simulated) scan against ' + target,
        'Nmap scan report for ' + target + ' (10.0.7.23)',
        'Host is up (0.021s latency).',
        'PORT     STATE SERVICE',
        '22/tcp   open  ssh',
        '80/tcp   open  http',
        '443/tcp  open  https',
        'Nmap done: 1 IP address (1 host up) scanned.'].join('\n');
    }},
    dig: { d: 'DNS lookup (simulated)', run: function(a){
      var q = a.filter(function(x){ return x.charAt(0) !== '-'; })[0] || 'example.com';
      return ['; <<>> DiG (simulated) <<>> ' + q,
        ';; ANSWER SECTION:',
        q + '.    300    IN    A    93.184.216.34',
        ';; Query time: 12 msec'].join('\n');
    }},
    curl: { d: 'Fetch a URL (simulated, offline)', run: function(a){
      var url = a.filter(function(x){ return x.charAt(0) !== '-'; })[0] || '';
      if (!url) return 'curl: try \'curl <url>\' (simulated — no real network)';
      return '[simulated] GET ' + url + ' -> 200 OK (offline sandbox; no real request sent)';
    }},
    ping: { d: 'Ping a host (simulated)', run: function(a){
      var target = a.filter(function(x){ return x.charAt(0) !== '-'; })[0] || 'interstitium';
      var out = ['PING ' + target + ' (10.0.7.1) 56(84) bytes of data. (simulated)'];
      for (var i = 1; i <= 4; i++)
        out.push('64 bytes from 10.0.7.1: icmp_seq=' + i + ' ttl=64 time=' + (8 + i) + '.2 ms');
      out.push('--- ' + target + ' ping statistics ---');
      out.push('4 packets transmitted, 4 received, 0% packet loss');
      return out.join('\n');
    }},
    ip: { d: 'Show interfaces/routes (simulated)', run: function(a){
      var sub = (a[0] || '').toLowerCase();
      if (sub === 'route' || sub === 'r')
        return 'default via 10.0.7.1 dev eth0 proto dhcp (simulated)\n10.0.7.0/24 dev eth0 proto kernel scope link src 10.0.7.23';
      return '1: lo: <LOOPBACK,UP> mtu 65536\n    inet 127.0.0.1/8 scope host lo\n2: eth0: <BROADCAST,MULTICAST,UP> mtu 1500\n    inet 10.0.7.23/24 scope global eth0 (simulated)';
    }},
    ss: { d: 'List sockets (simulated)', run: function(){
      return 'Netid  State   Recv-Q  Local Address:Port\ntcp    LISTEN  0       0.0.0.0:22\ntcp    LISTEN  0       0.0.0.0:80\ntcp    LISTEN  0       0.0.0.0:443 (simulated)';
    }},
    systemctl: { d: 'Service status (simulated)', run: function(a){
      var svc = a[a.length - 1] || '';
      if (a[0] === 'status' && svc && svc !== 'status')
        return '* ' + svc + '.service — simulated unit\n   Active: active (running) since boot\n   Main PID: 4242 (simulated)';
      return 'systemctl: simulated — try \'systemctl status <service>\'';
    }},
    journalctl: { d: 'Read service logs (simulated)', run: function(a){
      var unit = '', i;
      for (i = 0; i < a.length; i++) if (a[i] === '-u' && i + 1 < a.length) unit = a[i + 1];
      unit = unit || 'app';
      return ['-- Logs begin at boot -- (simulated)', unit + ': starting service...',
        unit + ': listening on :8080', unit + ': ready'].join('\n');
    }},
    free: { d: 'Memory usage (simulated)', run: function(){
      return '               total        used        free\nMem:         4024548      812340     3212208\nSwap:        2097148           0     2097148 (simulated)';
    }},
    sha256sum: { d: 'SHA-256 of text (computed for real)', run: function(a){
      if (!a.length) return 'sha256sum: pass text to hash (simulated shell; hash is computed for real)';
      return sha256Hex(a.join(' ')) + '  ' + a.join(' ');
    }},
    ssh: { d: 'SSH (disabled in sandbox)', run: function(){
      return 'ssh: outbound connections are disabled in this simulated terminal (sandbox).';
    }},
    sudo: { d: 'Run as root (refused)', run: function(){
      return '[interstitium] nice try — this terminal is simulated. No root for you here.';
    }}
  })
});

/* Compact SHA-256 (FIPS 180-4), verified against standard test vectors.
   Used by the bash profile's sha256sum so the simulator reports real hashes. */
function sha256Hex(str){
  function rr(x, n){ return (x >>> n) | (x << (32 - n)); }
  var K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  var H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  var bytes = [], i, c;
  for (i = 0; i < str.length; i++){
    c = str.charCodeAt(i);
    if (c < 128) bytes.push(c);
    else if (c < 2048) bytes.push(192 | (c >> 6), 128 | (c & 63));
    else bytes.push(224 | (c >> 12), 128 | ((c >> 6) & 63), 128 | (c & 63));
  }
  var bitLen = bytes.length * 8;
  bytes.push(128);
  while (bytes.length % 64 !== 56) bytes.push(0);
  var hi = Math.floor(bitLen / 4294967296), lo = bitLen >>> 0;
  bytes.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255,
             (lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);
  var w = new Array(64);
  for (var b = 0; b < bytes.length; b += 64){
    for (i = 0; i < 16; i++)
      w[i] = (bytes[b + i * 4] << 24) | (bytes[b + i * 4 + 1] << 16) | (bytes[b + i * 4 + 2] << 8) | bytes[b + i * 4 + 3];
    for (i = 16; i < 64; i++){
      var s0 = rr(w[i - 15], 7) ^ rr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      var s1 = rr(w[i - 2], 17) ^ rr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    var a = H[0], bb = H[1], cc = H[2], dd = H[3], ee = H[4], ff = H[5], gg = H[6], hh = H[7];
    for (i = 0; i < 64; i++){
      var S1 = rr(ee, 6) ^ rr(ee, 11) ^ rr(ee, 25), ch = (ee & ff) ^ ((~ee) & gg), t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
      var S0 = rr(a, 2) ^ rr(a, 13) ^ rr(a, 22), mj = (a & bb) ^ (a & cc) ^ (bb & cc), t2 = (S0 + mj) | 0;
      hh = gg; gg = ff; ff = ee; ee = (dd + t1) | 0; dd = cc; cc = bb; bb = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + bb) | 0; H[2] = (H[2] + cc) | 0; H[3] = (H[3] + dd) | 0;
    H[4] = (H[4] + ee) | 0; H[5] = (H[5] + ff) | 0; H[6] = (H[6] + gg) | 0; H[7] = (H[7] + hh) | 0;
  }
  return H.map(function(x){ var s = (x >>> 0).toString(16); while (s.length < 8) s = '0' + s; return s; }).join('');
}

function bashHeadTail(a, ctx, which){
  var st = ctx.state, n = 10, files = [];
  for (var i = 0; i < a.length; i++){
    var x = a[i];
    if (x === '-n' && i + 1 < a.length){ n = parseInt(a[++i], 10) || 10; }
    else if (/^-\d+$/.test(x)) n = parseInt(x.slice(1), 10);
    else if (x.charAt(0) !== '-') files.push(x);
  }
  if (!files.length) return which + ': reading from stdin is not simulated — pass a file';
  var out = [];
  for (var f = 0; f < files.length; f++){
    var r = bashReadFile(st, files[f], which);
    if (r.err) return r.err;
    var lines = r.node.content.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    var sel = which === 'head' ? lines.slice(0, n) : lines.slice(Math.max(lines.length - n, 0));
    if (files.length > 1) out.push('==> ' + files[f] + ' <==');
    out.push(sel.join('\n'));
  }
  return out.join('\n');
}

/* ================= KUBECTL PROFILE ================= */
function kubeTable(headers, rows){
  var widths = headers.map(function(h){ return h.length; });
  rows.forEach(function(r){
    r.forEach(function(c, i){ widths[i] = Math.max(widths[i], String(c).length); });
  });
  var out = [headers.map(function(h, i){ return padRight(h, widths[i]); }).join('   ')];
  rows.forEach(function(r){
    out.push(r.map(function(c, i){ return padRight(String(c), widths[i]); }).join('   '));
  });
  return out.join('\n');
}
function kubeNsOf(args, dflt){
  for (var i = 0; i < args.length; i++){
    if ((args[i] === '-n' || args[i] === '--namespace') && i + 1 < args.length) return args[i + 1];
    var m = args[i].match(/^--namespace=(.+)$/);
    if (m) return m[1];
  }
  return dflt || 'default';
}
function kubeFindPod(st, ns, name){
  var n = st.ns[ns];
  if (!n) return { err: 'Error from server (NotFound): namespaces "' + ns + '" not found' };
  for (var i = 0; i < n.pods.length; i++)
    if (n.pods[i].name === name) return { pod: n.pods[i] };
  return { err: 'Error from server (NotFound): pods "' + name + '" not found' };
}

defineProfile('kubectl', {
  label: 'kubectl v1.31',
  shellName: 'kubectl (simulated cluster)',
  tool: 'kubectl',
  subcmds: ['get','describe','logs','apply','delete','exec','top','config','version','create','expose','scale','rollout'],
  subs: { kubectl: ['get','describe','logs','apply','delete','exec','top','config','version','create','expose','scale','rollout'] },
  prompt: 'candidate@interstitium:~$ ',
  initState: function(){
    return {
      contexts: ['ilb-prod', 'ilb-staging'], current: 'ilb-prod',
      nodes: [
        { name: 'node-1', status: 'Ready', roles: 'control-plane', age: '30d', ver: 'v1.31.2' },
        { name: 'node-2', status: 'Ready', roles: '<none>', age: '30d', ver: 'v1.31.2' }
      ],
      ns: {
        'default': {
          pods: [
            { name: 'api-7d9f8c6b4-x2kzq', ready: '1/1', status: 'Running', restarts: 0, age: '6d', ip: '10.244.1.12', node: 'node-1' },
            { name: 'api-7d9f8c6b4-p9mwl', ready: '1/1', status: 'Running', restarts: 1, age: '6d', ip: '10.244.2.9', node: 'node-2' },
            { name: 'web-5c4d8f2a1-q7rtx', ready: '1/1', status: 'Running', restarts: 0, age: '2d', ip: '10.244.1.20', node: 'node-1' }
          ],
          deployments: [
            { name: 'api', desired: 2, avail: 2, age: '6d' },
            { name: 'web', desired: 1, avail: 1, age: '2d' }
          ],
          services: [
            { name: 'api-svc', type: 'ClusterIP', ip: '10.96.4.21', ports: '80/TCP', age: '6d' },
            { name: 'web-svc', type: 'NodePort', ip: '10.96.7.44', ports: '80:30080/TCP', age: '2d' }
          ]
        },
        'kube-system': {
          pods: [
            { name: 'coredns-6d4b9cb9-x1aa2', ready: '1/1', status: 'Running', restarts: 0, age: '30d', ip: '10.244.0.2', node: 'node-1' },
            { name: 'etcd-node-1', ready: '1/1', status: 'Running', restarts: 0, age: '30d', ip: '10.244.0.1', node: 'node-1' }
          ],
          deployments: [ { name: 'coredns', desired: 1, avail: 1, age: '30d' } ],
          services: [ { name: 'kube-dns', type: 'ClusterIP', ip: '10.96.0.10', ports: '53/UDP,53/TCP', age: '30d' } ]
        },
        'prod': {
          pods: [ { name: 'api-9a1b2c3d4-e5f66', ready: '2/2', status: 'Running', restarts: 0, age: '12d', ip: '10.244.3.7', node: 'node-2' } ],
          deployments: [ { name: 'api', desired: 1, avail: 1, age: '12d' } ],
          services: [ { name: 'api-svc', type: 'LoadBalancer', ip: '10.96.9.9', ports: '443:30443/TCP', age: '12d' } ]
        }
      }
    };
  },
  runLine: function(line, ctx){
    var args = splitArgs(line);
    if (!args.length) return '';
    if (args[0] !== 'kubectl') return defaultRunLine(line, ctx);
    if (args.length === 1)
      return 'kubectl controls the Kubernetes cluster manager.\nFind more information at: https://kubernetes.io/docs/reference/kubectl/\n\nTry: kubectl get pods   kubectl config get-contexts';
    var sub = args[1], rest = args.slice(2);
    var cmd = this.commands[sub];
    if (cmd) return cmd.run(rest, ctx);
    return 'error: unknown command "' + sub + '" for "kubectl"';
  },
  commands: metaCommands({
    get: { d: 'List resources', run: function(a, ctx){
      var st = ctx.state;
      var res = null, rest = [];
      a.forEach(function(x){ if (['pods','po','deployments','deploy','services','svc','namespaces','ns','nodes','no'].indexOf(x) >= 0 && !res) res = x; else rest.push(x); });
      if (!res) return 'error: the server doesn\'t have a resource type "' + (a[0] || '') + '"';
      var ns = kubeNsOf(a, 'default');
      var wide = a.indexOf('-o') >= 0;
      if (res === 'namespaces' || res === 'ns')
        return kubeTable(['NAME', 'STATUS', 'AGE'], Object.keys(st.ns).map(function(k){ return [k, 'Active', '30d']; }));
      if (res === 'nodes' || res === 'no')
        return kubeTable(['NAME', 'STATUS', 'ROLES', 'AGE', 'VERSION'],
          st.nodes.map(function(n){ return [n.name, n.status, n.roles, n.age, n.ver]; }));
      if (!st.ns[ns]) return 'Error from server (NotFound): namespaces "' + ns + '" not found';
      var n = st.ns[ns];
      if (res === 'pods' || res === 'po'){
        var rows = n.pods.map(function(p){
          var r = [p.name, p.ready, p.status, p.restarts, p.age];
          if (wide) r.push(p.ip, p.node);
          return r;
        });
        var h = ['NAME', 'READY', 'STATUS', 'RESTARTS', 'AGE'];
        if (wide) h.push('IP', 'NODE');
        return rows.length ? kubeTable(h, rows) : 'No resources found in ' + ns + ' namespace.';
      }
      if (res === 'deployments' || res === 'deploy')
        return kubeTable(['NAME', 'READY', 'UP-TO-DATE', 'AVAILABLE', 'AGE'],
          n.deployments.map(function(d){ return [d.name, d.avail + '/' + d.desired, d.desired, d.avail, d.age]; }));
      if (res === 'services' || res === 'svc')
        return kubeTable(['NAME', 'TYPE', 'CLUSTER-IP', 'PORT(S)', 'AGE'],
          n.services.map(function(s){ return [s.name, s.type, s.ip, s.ports, s.age]; }));
      return '';
    }},
    describe: { d: 'Show resource details', run: function(a, ctx){
      var st = ctx.state;
      var target = null;
      a.forEach(function(x){ if (x.charAt(0) !== '-' && !target) target = x; });
      if (!target) return 'error: the server doesn\'t have a resource type ""';
      var ns = kubeNsOf(a, 'default');
      var m = target.match(/^(pod|deployment|deploy|service|svc)\/(.+)$/);
      var kind = m ? m[1] : 'pod', name = m ? m[2] : target;
      if (!st.ns[ns]) return 'Error from server (NotFound): namespaces "' + ns + '" not found';
      var n = st.ns[ns];
      if (kind === 'pod'){
        var f = kubeFindPod(st, ns, name);
        if (f.err) return f.err;
        var p = f.pod;
        return ['Name:             ' + p.name,
                'Namespace:        ' + ns,
                'Status:           ' + p.status,
                'IP:               ' + p.ip,
                'Node:             ' + p.node,
                'Containers:',
                '  app:',
                '    Ready:          ' + (p.ready === '1/1' ? 'True' : 'False'),
                '    Restart Count:  ' + p.restarts,
                'Conditions:',
                '  Type              Status',
                '  Ready             True',
                'Events:             <none> (simulated)'].join('\n');
      }
      var list = kind === 'service' || kind === 'svc' ? n.services : n.deployments;
      for (var i = 0; i < list.length; i++){
        if (list[i].name === name){
          var d = list[i];
          return ['Name:             ' + d.name,
                  'Namespace:        ' + ns,
                  kind === 'service' || kind === 'svc'
                    ? 'Type:             ' + d.type + '\nIP:               ' + d.ip + '\nPort(s):          ' + d.ports
                    : 'Replicas:         ' + d.avail + ' desired | ' + d.desired + ' updated',
                  'Age:              ' + d.age].join('\n');
        }
      }
      return 'Error from server (NotFound): ' + kind + 's "' + name + '" not found';
    }},
    logs: { d: 'Print pod logs', run: function(a, ctx){
      var st = ctx.state, name = null;
      a.forEach(function(x){ if (x.charAt(0) !== '-' && !name) name = x; });
      if (!name) return 'error: expected \'logs POD_NAME\'';
      var ns = kubeNsOf(a, 'default');
      var f = kubeFindPod(st, ns, name);
      if (f.err) return f.err;
      return ['2026-10-04T09:12:01Z INFO  starting ' + name,
              '2026-10-04T09:12:04Z INFO  listening on :8080',
              '2026-10-04T09:14:47Z ERROR dial tcp 10.96.0.5:6379: connect: connection refused',
              '2026-10-04T09:14:51Z INFO  cache reachable, pool=10'].join('\n');
    }},
    apply: { d: 'Apply a manifest', run: function(a, ctx){
      var st = ctx.state, file = null;
      for (var i = 0; i < a.length; i++)
        if ((a[i] === '-f' || a[i] === '--filename') && i + 1 < a.length) file = a[i + 1];
      if (!file) return 'error: -f/--filename is required (simulated)';
      var ns = kubeNsOf(a, 'default');
      if (!st.ns[ns]) return 'Error from server (NotFound): namespaces "' + ns + '" not found';
      var name = file.split('/').pop().replace(/\.(yaml|yml|json)$/, '');
      var n = st.ns[ns], exists = false;
      for (var j = 0; j < n.deployments.length; j++)
        if (n.deployments[j].name === name) exists = true;
      if (!exists){
        n.deployments.push({ name: name, desired: 1, avail: 1, age: '0s' });
        n.pods.push({ name: name + '-6f8d9c0a1-ab12c', ready: '1/1', status: 'Running', restarts: 0, age: '0s', ip: '10.244.9.99', node: 'node-2' });
      }
      return 'deployment.apps/' + name + (exists ? ' configured' : ' created') + ' (simulated)';
    }},
    delete: { d: 'Delete resources', run: function(a, ctx){
      var st = ctx.state, kind = a[0], name = a[1];
      var ns = kubeNsOf(a, 'default');
      if (kind === '-f') return 'resource from ' + (a[1] || 'manifest') + ' deleted (simulated)';
      if (!st.ns[ns]) return 'Error from server (NotFound): namespaces "' + ns + '" not found';
      var n = st.ns[ns];
      if (kind === 'pod' || kind === 'pods'){
        for (var i = 0; i < n.pods.length; i++)
          if (n.pods[i].name === name){ n.pods.splice(i, 1); return 'pod "' + name + '" deleted'; }
        return 'Error from server (NotFound): pods "' + name + '" not found';
      }
      if (kind === 'deployment' || kind === 'deployments'){
        for (var j = 0; j < n.deployments.length; j++)
          if (n.deployments[j].name === name){ n.deployments.splice(j, 1); return 'deployment.apps "' + name + '" deleted'; }
        return 'Error from server (NotFound): deployments.apps "' + name + '" not found';
      }
      return 'error: expected \'delete (pod|deployment) NAME\'';
    }},
    exec: { d: 'Exec into a pod', run: function(a, ctx){
      return 'Interactive exec is not attached in this simulated cluster.\nTry: kubectl logs <pod>   or   kubectl describe pod/<pod>';
    }},
    top: { d: 'Resource usage', run: function(a, ctx){
      var st = ctx.state, what = a[0] || 'pods';
      var ns = kubeNsOf(a, 'default');
      function usage(name){
        var h = 0;
        for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 997;
        return [5 + (h % 180) + 'm', 40 + (h % 420) + 'Mi'];
      }
      if (what === 'nodes' || what === 'node')
        return kubeTable(['NAME', 'CPU(cores)', 'MEMORY(bytes)'],
          st.nodes.map(function(n){ var u = usage(n.name); return [n.name, (300 + u[0].length * 37) + 'm', (900 + u[1].length * 91) + 'Mi']; }));
      if (!st.ns[ns]) return 'Error from server (NotFound): namespaces "' + ns + '" not found';
      return kubeTable(['NAME', 'CPU(cores)', 'MEMORY(bytes)'],
        st.ns[ns].pods.map(function(p){ var u = usage(p.name); return [p.name, u[0], u[1]]; }));
    }},
    config: { d: 'Manage kubeconfig', run: function(a, ctx){
      var st = ctx.state;
      if (a[0] === 'get-contexts')
        return kubeTable(['CURRENT', 'NAME', 'CLUSTER', 'USER'],
          st.contexts.map(function(c){ return [c === st.current ? '*' : '', c, c, 'candidate']; }));
      if (a[0] === 'use-context' && a[1]){
        if (st.contexts.indexOf(a[1]) < 0) return 'error: no context is currently set, use "kubectl config use-context <context>" to select a new one';
        st.current = a[1];
        return 'Switched to context "' + a[1] + '".';
      }
      if (a[0] === 'current-context') return st.current;
      return 'error: expected \'config (get-contexts|use-context|current-context)\'';
    }},
    version: { d: 'Client/server versions', run: function(){
      return 'Client Version: v1.31.2\nServer Version: v1.31.2 (simulated control plane)';
    }},
    create: { d: 'Create resources', run: function(a, ctx){
      var st = ctx.state;
      if (a[0] !== 'deployment' || !a[1]) return 'error: expected \'create deployment NAME --image=img\'';
      var ns = kubeNsOf(a, 'default'), img = 'nginx:latest';
      a.forEach(function(x){ var m = x.match(/^--image=(.+)$/); if (m) img = m[1]; });
      var n = st.ns[ns];
      if (!n) return 'Error from server (NotFound): namespaces "' + ns + '" not found';
      n.deployments.push({ name: a[1], desired: 1, avail: 1, age: '0s' });
      n.pods.push({ name: a[1] + '-7b9c1d2e3-zz99y', ready: '1/1', status: 'Running', restarts: 0, age: '0s', ip: '10.244.9.98', node: 'node-1' });
      return 'deployment.apps/' + a[1] + ' created (image: ' + img + ', simulated)';
    }},
    expose: { d: 'Expose a deployment', run: function(a, ctx){
      var st = ctx.state;
      if (a[0] !== 'deployment' || !a[1]) return 'error: expected \'expose deployment NAME --port=N\'';
      var ns = kubeNsOf(a, 'default'), port = '80', type = 'ClusterIP';
      a.forEach(function(x){
        var m1 = x.match(/^--port=(.+)$/); if (m1) port = m1[1];
        var m2 = x.match(/^--type=(.+)$/); if (m2) type = m2[1];
      });
      var n = st.ns[ns];
      if (!n) return 'Error from server (NotFound): namespaces "' + ns + '" not found';
      n.services.push({ name: a[1], type: type, ip: '10.96.8.50', ports: port + '/TCP', age: '0s' });
      return 'service/' + a[1] + ' exposed on port ' + port + ' (' + type + ', simulated)';
    }},
    scale: { d: 'Scale a deployment', run: function(a, ctx){
      var st = ctx.state;
      var m = (a[0] || '').match(/^deployment\/(.+)$/);
      var name = m ? m[1] : (a[0] === 'deployment' ? a[1] : null);
      var rep = null;
      a.forEach(function(x){ var mm = x.match(/^--replicas=(\d+)$/); if (mm) rep = parseInt(mm[1], 10); });
      if (!name || rep === null) return 'error: expected \'scale deployment/NAME --replicas=N\'';
      var ns = kubeNsOf(a, 'default'), n = st.ns[ns];
      if (!n) return 'Error from server (NotFound): namespaces "' + ns + '" not found';
      for (var i = 0; i < n.deployments.length; i++){
        if (n.deployments[i].name === name){
          var d = n.deployments[i];
          d.desired = rep; d.avail = rep;
          n.pods = n.pods.filter(function(p){ return p.name.indexOf(name + '-') !== 0; });
          for (var r = 0; r < rep; r++)
            n.pods.push({ name: name + '-7d9f8c6b4-s' + r, ready: '1/1', status: 'Running', restarts: 0, age: '0s', ip: '10.244.4.' + (10 + r), node: r % 2 ? 'node-2' : 'node-1' });
          return 'deployment.apps/' + name + ' scaled to ' + rep + ' (simulated)';
        }
      }
      return 'Error from server (NotFound): deployments.apps "' + name + '" not found';
    }},
    rollout: { d: 'Rollout status', run: function(a, ctx){
      var m = (a[1] || '').match(/^deployment\/(.+)$/);
      var name = m ? m[1] : a[1];
      if (a[0] !== 'status' || !name) return 'error: expected \'rollout status deployment/NAME\'';
      return 'deployment "' + name + '" successfully rolled out (simulated)';
    }}
  })
});

/* ================= AWS PROFILE ================= */
defineProfile('aws', {
  label: 'AWS CLI v2',
  shellName: 'aws (simulated)',
  tool: 'aws',
  subcmds: ['s3', 'ec2', 'iam', 'sts', 'configure'],
  subs: { aws: ['s3', 'ec2', 'iam', 'sts', 'configure'] },
  prompt: 'candidate@interstitium:~$ ',
  initState: function(){
    return {
      buckets: {
        'ilb-artifacts': ['builds/bootcamp-v3.zip', 'builds/bootcamp-v4.zip', 'reports/q3.pdf'],
        'ilb-backups-2026': ['db/snapshot-2026-10-01.sql.gz']
      },
      instances: [
        { id: 'i-0a1b2c3d4e5f60718', name: 'ilb-web-01', state: 'running', type: 't3.medium', az: 'us-east-1a' },
        { id: 'i-0f9e8d7c6b5a43210', name: 'ilb-db-01', state: 'stopped', type: 'r6g.large', az: 'us-east-1b' }
      ],
      users: [
        { name: 'candidate', arn: 'arn:aws:iam::123456789012:user/candidate' },
        { name: 'deploy-bot', arn: 'arn:aws:iam::123456789012:user/deploy-bot' }
      ],
      roles: [
        { name: 'ilb-ec2-role', arn: 'arn:aws:iam::123456789012:role/ilb-ec2-role' },
        { name: 'ilb-lambda-exec', arn: 'arn:aws:iam::123456789012:role/ilb-lambda-exec' }
      ]
    };
  },
  runLine: function(line, ctx){
    var args = splitArgs(line);
    if (!args.length) return '';
    if (args[0] !== 'aws') return defaultRunLine(line, ctx);
    if (args.length === 1) return 'usage: aws <service> <operation> [options]   (simulated)\nTry: aws s3 ls   aws ec2 describe-instances   aws sts get-caller-identity';
    var svc = args[1], op = args[2], rest = args.slice(3);
    var key = svc + ' ' + (op || '');
    var cmd = this.commands[key] || this.commands[svc];
    if (cmd && this.commands[key]) return cmd.run(rest, ctx);
    if (svc === 's3' || svc === 'ec2' || svc === 'iam' || svc === 'sts' || svc === 'configure')
      return 'Unknown operation "' + (op || '') + '" for service "' + svc + '" (simulated).\nTry: aws ' + svc + ' help';
    return 'Unknown service "' + svc + '". Valid services (simulated): s3 ec2 iam sts configure';
  },
  commands: metaCommands({
    's3 ls': { d: 'List buckets/objects', run: function(a, ctx){
      var st = ctx.state, target = a[0];
      if (!target)
        return Object.keys(st.buckets).map(function(b){ return '2026-09-12 10:00:00 ' + b; }).join('\n');
      var m = target.match(/^s3:\/\/([^\/]+)\/?(.*)$/);
      if (!m) return 'Invalid S3 path: ' + target;
      var keys = st.buckets[m[1]];
      if (!keys) return 'An error occurred (NoSuchBucket): The specified bucket does not exist';
      var out = keys.filter(function(k){ return k.indexOf(m[2]) === 0; })
        .map(function(k){ return '2026-10-0' + (1 + (k.length % 3)) + ' 09:12:00 ' + padLeft(1000 + k.length * 37, 10) + ' ' + k; });
      return out.join('\n');
    }},
    's3 cp': { d: 'Copy to/from S3', run: function(a, ctx){
      var st = ctx.state;
      if (a.length < 2) return 'usage: aws s3 cp <source> <dest> (simulated)';
      var src = a[0], dst = a[1];
      function parseS3(p){ var m = p.match(/^s3:\/\/([^\/]+)\/(.+)$/); return m ? { b: m[1], k: m[2] } : null; }
      var s = parseS3(src), d = parseS3(dst);
      if (s && !d){
        if (!st.buckets[s.b] || st.buckets[s.b].indexOf(s.k) < 0) return 'An error occurred (NoSuchKey): The specified key does not exist.';
        return 'download: s3://' + s.b + '/' + s.k + ' to ./' + s.k.split('/').pop();
      }
      if (!s && d){
        if (!st.buckets[d.b]) return 'An error occurred (NoSuchBucket): The specified bucket does not exist';
        st.buckets[d.b].push(d.k);
        return 'upload: ./' + src + ' to s3://' + d.b + '/' + d.k;
      }
      if (s && d){
        if (!st.buckets[s.b]) return 'An error occurred (NoSuchBucket): source bucket does not exist';
        if (!st.buckets[d.b]) return 'An error occurred (NoSuchBucket): dest bucket does not exist';
        st.buckets[d.b].push(d.k);
        return 'copy: s3://' + s.b + '/' + s.k + ' to s3://' + d.b + '/' + d.k;
      }
      return 'Both paths are local — nothing to do (simulated).';
    }},
    's3 mb': { d: 'Create a bucket', run: function(a, ctx){
      var st = ctx.state, m = (a[0] || '').match(/^s3:\/\/([^\/]+)\/?$/);
      if (!m) return 'usage: aws s3 mb s3://<bucket> (simulated)';
      if (st.buckets[m[1]]) return 'An error occurred (BucketAlreadyExists): ' + m[1];
      st.buckets[m[1]] = [];
      return 'make_bucket: ' + m[1];
    }},
    's3 rb': { d: 'Remove a bucket', run: function(a, ctx){
      var st = ctx.state, m = (a[0] || '').match(/^s3:\/\/([^\/]+)\/?$/);
      if (!m) return 'usage: aws s3 rb s3://<bucket> (simulated)';
      if (!st.buckets[m[1]]) return 'An error occurred (NoSuchBucket): ' + m[1];
      if (st.buckets[m[1]].length) return 'An error occurred (BucketNotEmpty): empty it first (simulated)';
      delete st.buckets[m[1]];
      return 'remove_bucket: ' + m[1];
    }},
    's3': { d: 'S3 operations', run: function(){
      return 'usage: aws s3 (ls|cp|mb|rb) ...   (simulated)';
    }},
    'ec2 describe-instances': { d: 'List EC2 instances', run: function(a, ctx){
      var st = ctx.state, ids = [];
      for (var i = 0; i < a.length; i++)
        if (a[i] === '--instance-ids') ids = a.slice(i + 1);
      var list = st.instances.filter(function(x){ return !ids.length || ids.indexOf(x.id) >= 0; });
      if (!list.length) return 'An error occurred (InvalidInstanceID.NotFound): no instances matched (simulated)';
      return kubeTable(['InstanceId', 'Name', 'State', 'Type', 'AZ'],
        list.map(function(x){ return [x.id, x.name, x.state, x.type, x.az]; }));
    }},
    'ec2 describe-vpcs': { d: 'List VPCs', run: function(){
      return kubeTable(['VpcId', 'CidrBlock', 'State', 'IsDefault'],
        [['vpc-0a1b2c3d', '10.0.0.0/16', 'available', 'true'],
         ['vpc-0f9e8d7c', '172.31.0.0/16', 'available', 'false']]);
    }},
    'ec2 describe-security-groups': { d: 'List security groups', run: function(){
      return kubeTable(['GroupId', 'GroupName', 'VpcId'],
        [['sg-0a1b2c3d', 'ilb-web-sg', 'vpc-0a1b2c3d'],
         ['sg-0f9e8d7c', 'ilb-db-sg', 'vpc-0a1b2c3d']]);
    }},
    'ec2 start-instances': { d: 'Start instances', run: function(a, ctx){
      return awsPower(a, ctx, 'running', 'start');
    }},
    'ec2 stop-instances': { d: 'Stop instances', run: function(a, ctx){
      return awsPower(a, ctx, 'stopped', 'stop');
    }},
    'ec2': { d: 'EC2 operations', run: function(){
      return 'usage: aws ec2 (describe-instances|describe-vpcs|describe-security-groups|start-instances|stop-instances) ...';
    }},
    'iam list-users': { d: 'List IAM users', run: function(a, ctx){
      return kubeTable(['UserName', 'Arn'], ctx.state.users.map(function(u){ return [u.name, u.arn]; }));
    }},
    'iam list-roles': { d: 'List IAM roles', run: function(a, ctx){
      return kubeTable(['RoleName', 'Arn'], ctx.state.roles.map(function(r){ return [r.name, r.arn]; }));
    }},
    'iam': { d: 'IAM operations', run: function(){ return 'usage: aws iam (list-users|list-roles) ...   (simulated)'; } },
    'sts get-caller-identity': { d: 'Caller identity', run: function(){
      return JSON.stringify({
        UserId: 'AIDACKCEVSQ6C2EXAMPLE',
        Account: '123456789012',
        Arn: 'arn:aws:iam::123456789012:user/candidate'
      }, null, 2) + '\n(simulated)';
    }},
    'sts': { d: 'STS operations', run: function(){ return 'usage: aws sts get-caller-identity   (simulated)'; } },
    'configure list': { d: 'Show config', run: function(){
      return ['      Name                    Value             Type    Location',
              '      ----                    -----             ----    --------',
              '   profile                <not set>             None    None',
              'access_key     ****************MPLE              env',
              'secret_key     ****************MPLE              env',
              '    region                us-east-1              env    AWS_REGION',
              '(simulated — no real credentials)'].join('\n');
    }},
    'configure': { d: 'Configure CLI', run: function(){ return 'usage: aws configure list   (simulated)'; } }
  })
});

function awsPower(a, ctx, to, verb){
  var st = ctx.state, ids = [];
  for (var i = 0; i < a.length; i++)
    if (a[i] === '--instance-ids') ids = a.slice(i + 1);
  if (!ids.length) return 'usage: aws ec2 ' + verb + '-instances --instance-ids <id> ... (simulated)';
  var out = [];
  ids.forEach(function(id){
    var hit = false;
    st.instances.forEach(function(x){
      if (x.id === id){ x.state = to; hit = true; out.push(id + ': ' + verb + 'ing (now ' + to + ')'); }
    });
    if (!hit) out.push('An error occurred (InvalidInstanceID.NotFound): ' + id);
  });
  return out.join('\n');
}

/* ================= SQL PROFILE ================= */
function sqlTok(src){
  var toks = [], i = 0, n = src.length;
  while (i < n){
    var c = src.charAt(i);
    if (/\s/.test(c)){ i++; continue; }
    if (c === "'"){
      var j = i + 1, s = '';
      while (j < n){
        if (src.charAt(j) === "'"){
          if (src.charAt(j + 1) === "'"){ s += "'"; j += 2; continue; }
          j++; break;
        }
        s += src.charAt(j); j++;
      }
      toks.push({ t: 'str', v: s }); i = j; continue;
    }
    if (c === '"'){
      var k = i + 1, id = '';
      while (k < n && src.charAt(k) !== '"'){ id += src.charAt(k); k++; }
      toks.push({ t: 'word', v: id }); i = k + 1; continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src.charAt(i + 1)))){
      var m = src.slice(i).match(/^\d+(\.\d+)?/);
      toks.push({ t: 'num', v: parseFloat(m[0]) }); i += m[0].length; continue;
    }
    if (/[A-Za-z_]/.test(c)){
      var m2 = src.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/);
      toks.push({ t: 'word', v: m2[0] }); i += m2[0].length; continue;
    }
    var two = src.substr(i, 2);
    if (['<=', '>=', '!=', '<>'].indexOf(two) >= 0){
      toks.push({ t: 'op', v: two === '<>' ? '!=' : two }); i += 2; continue;
    }
    if ('=<>(),;.*+-/%'.indexOf(c) >= 0){ toks.push({ t: 'op', v: c }); i++; continue; }
    throw { sql: 'near "' + c + '": syntax error' };
  }
  return toks;
}
function sqlParser(toks){
  var pos = 0;
  function peek(){ return toks[pos]; }
  function next(){ return toks[pos++]; }
  function eof(){ return pos >= toks.length; }
  function isKw(w){
    var t = peek();
    return t && t.t === 'word' && t.v.toUpperCase() === w;
  }
  function expectKw(w){
    if (!isKw(w)) throw { sql: 'near "' + (peek() ? peek().v : '') + '": syntax error, expected ' + w };
    return next().v;
  }
  function expectOp(v){
    var t = peek();
    if (!t || t.t !== 'op' || t.v !== v) throw { sql: 'near "' + (t ? t.v : '') + '": syntax error, expected ' + v };
    return next().v;
  }
  function ident(){
    var t = next();
    if (!t || t.t !== 'word') throw { sql: 'near "' + (t ? t.v : '') + '": syntax error, expected identifier' };
    return t.v.toLowerCase();
  }
  function value(){
    var t = next();
    if (!t) throw { sql: 'incomplete input' };
    if (t.t === 'str') return t.v;
    if (t.t === 'num') return t.v;
    if (t.t === 'word'){
      var u = t.v.toUpperCase();
      if (u === 'NULL') return null;
      if (u === 'TRUE') return true;
      if (u === 'FALSE') return false;
      throw { sql: 'near "' + t.v + '": syntax error' };
    }
    throw { sql: 'near "' + t.v + '": syntax error' };
  }
  /* WHERE expression */
  function wOr(){
    var l = wAnd();
    while (isKw('OR')){ next(); l = { t: 'or', l: l, r: wAnd() }; }
    return l;
  }
  function wAnd(){
    var l = wNot();
    while (isKw('AND')){ next(); l = { t: 'and', l: l, r: wNot() }; }
    return l;
  }
  function wNot(){
    if (isKw('NOT')){ next(); return { t: 'not', x: wNot() }; }
    return wCmp();
  }
  function wCmp(){
    if (peek() && peek().t === 'op' && peek().v === '('){
      next();
      var e = wOr();
      expectOp(')');
      return e;
    }
    var col = ident();
    var t = peek();
    if (t && t.t === 'word' && t.v.toUpperCase() === 'IS'){
      next();
      var neg = false;
      if (isKw('NOT')){ next(); neg = true; }
      expectKw('NULL');
      return { t: 'isnull', col: col, neg: neg };
    }
    if (t && t.t === 'word' && t.v.toUpperCase() === 'LIKE'){ next(); return { t: 'like', col: col, pat: value() }; }
    if (t && t.t === 'word' && t.v.toUpperCase() === 'IN'){
      next(); expectOp('(');
      var vs = [];
      if (!(peek() && peek().t === 'op' && peek().v === ')')){
        for (;;){ vs.push(value()); if (peek() && peek().t === 'op' && peek().v === ','){ next(); continue; } break; }
      }
      expectOp(')');
      return { t: 'in', col: col, vs: vs };
    }
    if (!t || t.t !== 'op' || ['=','!=','<','>','<=','>='].indexOf(t.v) < 0)
      throw { sql: 'near "' + (t ? t.v : '') + '": syntax error in WHERE' };
    var op = next().v;
    return { t: 'cmp', col: col, op: op, v: value() };
  }
  function where(){
    if (!isKw('WHERE')) return null;
    next();
    return wOr();
  }
  return {
    select: function(){
      expectKw('SELECT');
      var distinct = false;
      if (isKw('DISTINCT')){ next(); distinct = true; }
      var items = [];
      if (peek() && peek().t === 'op' && peek().v === '*'){ next(); items.push({ star: true }); }
      else {
        for (;;){
          if (isKw('COUNT')){
            next(); expectOp('(');
            var star = peek() && peek().t === 'op' && peek().v === '*';
            if (star) next(); else ident();
            expectOp(')');
            var alias = 'COUNT(*)';
            if (isKw('AS')){ next(); alias = ident(); }
            items.push({ agg: 'count', alias: alias });
          } else {
            var c = ident(), alias2 = c;
            if (isKw('AS')){ next(); alias2 = ident(); }
            items.push({ col: c, alias: alias2 });
          }
          if (peek() && peek().t === 'op' && peek().v === ','){ next(); continue; }
          break;
        }
      }
      expectKw('FROM');
      var table = ident();
      var w = where(), order = null, limit = null;
      if (isKw('ORDER')){
        next(); expectKw('BY');
        order = [];
        for (;;){
          var oc = ident(), dir = 1;
          if (isKw('ASC')) next();
          else if (isKw('DESC')){ next(); dir = -1; }
          order.push({ col: oc, dir: dir });
          if (peek() && peek().t === 'op' && peek().v === ','){ next(); continue; }
          break;
        }
      }
      if (isKw('LIMIT')){ next(); var lt = next(); limit = lt.v; }
      return { items: items, table: table, where: w, order: order, limit: limit, distinct: distinct };
    },
    insert: function(){
      expectKw('INSERT'); expectKw('INTO');
      var table = ident(), cols = null;
      if (peek() && peek().t === 'op' && peek().v === '('){
        next(); cols = [];
        for (;;){ cols.push(ident()); if (peek() && peek().t === 'op' && peek().v === ','){ next(); continue; } break; }
        expectOp(')');
      }
      expectKw('VALUES');
      var rows = [];
      for (;;){
        expectOp('(');
        var vs = [];
        for (;;){ vs.push(value()); if (peek() && peek().t === 'op' && peek().v === ','){ next(); continue; } break; }
        expectOp(')');
        rows.push(vs);
        if (peek() && peek().t === 'op' && peek().v === ','){ next(); continue; }
        break;
      }
      return { table: table, cols: cols, rows: rows };
    },
    update: function(){
      expectKw('UPDATE');
      var table = ident();
      expectKw('SET');
      var sets = [];
      for (;;){
        var c = ident(); expectOp('=');
        sets.push({ col: c, v: value() });
        if (peek() && peek().t === 'op' && peek().v === ','){ next(); continue; }
        break;
      }
      return { table: table, sets: sets, where: where() };
    },
    del: function(){
      expectKw('DELETE'); expectKw('FROM');
      var table = ident();
      return { table: table, where: where() };
    },
    create: function(){
      expectKw('CREATE'); expectKw('TABLE');
      var table = ident();
      expectOp('(');
      var cols = [];
      for (;;){
        var c = ident();
        var type = '';
        while (peek() && ((peek().t === 'word') || (peek().t === 'op' && peek().v === '(') || (peek().t === 'num') || (peek().t === 'op' && peek().v === ')'))){
          if (peek().t === 'op' && peek().v === ')') break;
          type += (type ? ' ' : '') + next().v;
          if (peek() && peek().t === 'op' && peek().v === '('){
            next();
            var sz = next().v;
            type += '(' + sz + ')';
            expectOp(')');
          }
        }
        cols.push({ name: c, type: type || 'TEXT' });
        if (peek() && peek().t === 'op' && peek().v === ','){ next(); continue; }
        break;
      }
      expectOp(')');
      return { table: table, cols: cols };
    }
  };
}
function sqlLikeMatch(s, pat){
  var re = '^' + String(pat).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$';
  return new RegExp(re, 'i').test(String(s));
}
function sqlWhereFn(w){
  if (!w) return function(){ return true; };
  function ev(n, row){
    switch (n.t){
      case 'or': return ev(n.l, row) || ev(n.r, row);
      case 'and': return ev(n.l, row) && ev(n.r, row);
      case 'not': return !ev(n.x, row);
      case 'cmp': {
        var v = row[n.col];
        if (v === undefined) throw { sql: 'no such column: ' + n.col };
        var b = n.v;
        if (v === null || b === null) return n.op === '!=' ? v !== b : v === b;
        switch (n.op){
          case '=': return v == b; case '!=': return v != b;
          case '<': return v < b; case '>': return v > b;
          case '<=': return v <= b; case '>=': return v >= b;
        }
        return false;
      }
      case 'like': {
        var lv = row[n.col];
        if (lv === undefined) throw { sql: 'no such column: ' + n.col };
        return sqlLikeMatch(lv, n.pat);
      }
      case 'in': {
        var iv = row[n.col];
        if (iv === undefined) throw { sql: 'no such column: ' + n.col };
        for (var i = 0; i < n.vs.length; i++) if (iv == n.vs[i]) return true;
        return false;
      }
      case 'isnull': {
        var nv = row[n.col];
        if (nv === undefined) throw { sql: 'no such column: ' + n.col };
        return n.neg ? nv !== null : nv === null;
      }
    }
    return false;
  }
  return function(row){ return ev(w, row); };
}
function sqlVal(v){
  return v === null ? 'NULL' : String(v);
}

defineProfile('sql', {
  label: 'SQL · in-memory DB',
  shellName: 'sql',
  prompt: 'sql> ',
  initState: function(){
    function T(cols, rows){
      return { cols: cols.map(function(c){ return { name: c[0], type: c[1] }; }),
               rows: rows.map(function(r){
                 var o = {};
                 cols.forEach(function(c, i){ o[c[0]] = r[i]; });
                 return o;
               }) };
    }
    return { db: {
      employees: T(
        [['id','INTEGER'],['name','TEXT'],['dept','TEXT'],['salary','INTEGER'],['hired','TEXT']],
        [[1,'Ada Okafor','Engineering',145000,'2021-03-15'],
         [2,'Liam Chen','Engineering',138000,'2022-07-01'],
         [3,'Maya Ruiz','Data',129000,'2020-11-20'],
         [4,'Noah Kim','Security',151000,'2019-05-30'],
         [5,'Zoe Alvarez','Data',121000,'2023-01-10'],
         [6,'Eli Park','Engineering',99000,'2024-06-03']]),
      orders: T(
        [['id','INTEGER'],['employee_id','INTEGER'],['product','TEXT'],['amount','INTEGER'],['status','TEXT']],
        [[101,1,'laptop',2400,'shipped'],
         [102,3,'monitor',680,'shipped'],
         [103,2,'keyboard',180,'pending'],
         [104,4,'server',8900,'shipped'],
         [105,1,'dock',320,'cancelled'],
         [106,5,'laptop',2400,'pending']])
    } };
  },
  runLine: function(line, ctx){
    var t = trim(line).replace(/;$/, '');
    if (!t) return '';
    if (t.charAt(0) === '.') return sqlDot(t.slice(1), ctx);
    var toks;
    try { toks = sqlTok(t); }
    catch(e){ return 'Error: ' + (e.sql || 'syntax error'); }
    if (!toks.length) return '';
    var kw = toks[0].t === 'word' ? toks[0].v.toUpperCase() : '';
    var P = sqlParser(toks);
    try {
      if (kw === 'HELP') return this.commands.help.run([], ctx);
      if (kw === 'CLEAR'){ clearScreen(); return ''; }
      if (kw === 'HISTORY') return this.commands.history.run([], ctx);
      if (kw === 'EXIT' || kw === 'QUIT') return 'Session kept alive — this is a simulated shell for practice.';
      if (kw === 'SELECT') return sqlSelect(P.select(), ctx);
      if (kw === 'INSERT') return sqlInsert(P.insert(), ctx);
      if (kw === 'UPDATE') return sqlUpdate(P.update(), ctx);
      if (kw === 'DELETE') return sqlDelete(P.del(), ctx);
      if (kw === 'CREATE') return sqlCreate(P.create(), ctx);
      if (kw === 'DROP'){
        P = null;
        var m = t.match(/^drop\s+table\s+([A-Za-z_][A-Za-z0-9_]*)$/i);
        if (!m) return 'Error: near "DROP": syntax error';
        var tn = m[1].toLowerCase(), db0 = ctx.state.db;
        if (!db0[tn]) return 'Error: no such table: ' + tn;
        delete db0[tn];
        return 'Table dropped.';
      }
      if (kw === 'ALTER'){
        var am = t.match(/^alter\s+table\s+([A-Za-z_][A-Za-z0-9_]*)\s+add\s+(column\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(.*)$/i);
        if (!am) return 'Error: only ALTER TABLE t ADD [COLUMN] c TYPE is simulated';
        var at = ctx.state.db[am[1].toLowerCase()];
        if (!at) return 'Error: no such table: ' + am[1];
        at.cols.push({ name: am[3].toLowerCase(), type: trim(am[4]) || 'TEXT' });
        at.rows.forEach(function(r){ r[am[3].toLowerCase()] = null; });
        return 'Table altered.';
      }
      if (kw === 'DESCRIBE' || kw === 'DESC'){
        var dm = t.match(/^(?:describe|desc)\s+([A-Za-z_][A-Za-z0-9_]*)$/i);
        if (!dm) return 'Error: usage: DESCRIBE <table>';
        var dt = ctx.state.db[dm[1].toLowerCase()];
        if (!dt) return 'Error: no such table: ' + dm[1];
        return kubeTable(['column', 'type'], dt.cols.map(function(c){ return [c.name, c.type]; }));
      }
      if (kw === 'SHOW'){
        if (/^show\s+tables$/i.test(t)) return sqlTables(ctx);
        return 'Error: only SHOW TABLES is simulated';
      }
      return 'Error: near "' + toks[0].v + '": syntax error';
    } catch(e){
      return 'Error: ' + (e.sql || 'syntax error');
    }
  },
  commands: {
    select: { d: 'SELECT ... FROM ... [WHERE] [ORDER BY] [LIMIT]', run: function(){ return 'Usage: SELECT <cols|*> FROM <table> [WHERE ...] [ORDER BY ...] [LIMIT n]'; } },
    insert: { d: 'INSERT INTO t [(cols)] VALUES (...)', run: function(){ return 'Usage: INSERT INTO <table> [(cols)] VALUES (...), ...'; } },
    update: { d: 'UPDATE t SET c=v [WHERE]', run: function(){ return 'Usage: UPDATE <table> SET col=val [, ...] [WHERE ...]'; } },
    delete: { d: 'DELETE FROM t [WHERE]', run: function(){ return 'Usage: DELETE FROM <table> [WHERE ...]'; } },
    create: { d: 'CREATE TABLE t (col TYPE, ...)', run: function(){ return 'Usage: CREATE TABLE <table> (col TYPE, ...)'; } },
    drop: { d: 'DROP TABLE t', run: function(){ return 'Usage: DROP TABLE <table>'; } },
    alter: { d: 'ALTER TABLE t ADD COLUMN c TYPE', run: function(){ return 'Usage: ALTER TABLE <table> ADD [COLUMN] <col> <type>'; } },
    describe: { d: 'DESCRIBE <table>', run: function(){ return 'Usage: DESCRIBE <table>'; } },
    '.schema': { d: '.schema <table> — column list', run: function(){ return 'Usage: .schema <table>'; } },
    '.tables': { d: 'List tables', run: function(a, ctx){ return sqlTables(ctx); } },
    show: { d: 'SHOW TABLES', run: function(a, ctx){ return sqlTables(ctx); } },
    help: { d: 'List available commands', run: function(a, ctx){
      var names = Object.keys(ctx.profile.commands).sort();
      var out = ['SQL commands (SQLite-style, simulated):'];
      for (var i = 0; i < names.length; i++)
        out.push('  ' + padRight(names[i], 12) + (ctx.profile.commands[names[i]].d || ''));
      out.push('', 'Try: SELECT * FROM employees;   SELECT dept, COUNT(*) FROM employees GROUP BY dept;');
      out.push('(GROUP BY is not in this subset — try WHERE / ORDER BY / LIMIT instead)');
      return out.join('\n');
    }},
    clear: { d: 'Clear the terminal screen', run: function(){ clearScreen(); return ''; } },
    history: { d: 'Show command history', run: function(){
      var out = [];
      for (var i = 0; i < term.hist.length; i++) out.push('  ' + (i+1) + '  ' + term.hist[i]);
      return out.length ? out.join('\n') : '(no history yet)';
    }},
    exit: { d: 'Leave (stays open)', run: function(){ return 'Session kept alive — this is a simulated shell for practice.'; } }
  }
});

function sqlTables(ctx){
  var names = Object.keys(ctx.state.db).sort();
  return names.length ? names.join('\n') : '(no tables)';
}
function sqlDot(rest, ctx){
  var a = splitArgs(rest), cmd = (a[0] || '').toLowerCase();
  if (cmd === 'tables') return sqlTables(ctx);
  if (cmd === 'schema' && a[1]){
    var t = ctx.state.db[a[1].toLowerCase()];
    if (!t) return 'Error: no such table: ' + a[1];
    return 'CREATE TABLE ' + a[1].toLowerCase() + ' (\n' +
      t.cols.map(function(c){ return '  ' + c.name + ' ' + c.type; }).join(',\n') + '\n);';
  }
  if (cmd === 'help' || cmd === 'h')
    return 'Dot-commands: .tables  .schema <table>  .help  .quit';
  if (cmd === 'quit' || cmd === 'exit') return 'Session kept alive — this is a simulated shell for practice.';
  return 'Error: unknown dot-command ".' + cmd + '" — try .help';
}
function sqlSelect(q, ctx){
  var t = ctx.state.db[q.table];
  if (!t) return 'Error: no such table: ' + q.table;
  var fn = sqlWhereFn(q.where);
  var rows = t.rows.filter(fn);
  if (q.order){
    rows = rows.slice();
    rows.sort(function(a, b){
      for (var i = 0; i < q.order.length; i++){
        var c = q.order[i].col;
        if (!(c in a)) throw { sql: 'no such column: ' + c };
        if (a[c] < b[c]) return -1 * q.order[i].dir;
        if (a[c] > b[c]) return 1 * q.order[i].dir;
      }
      return 0;
    });
  }
  if (q.limit !== null && q.limit !== undefined) rows = rows.slice(0, q.limit);
  var headers, data;
  if (q.items.length === 1 && q.items[0].agg === 'count'){
    headers = [q.items[0].alias];
    data = [[rows.length]];
  } else {
    var cols = [];
    q.items.forEach(function(it){
      if (it.star) t.cols.forEach(function(c){ cols.push({ col: c.name, alias: c.name }); });
      else {
        if (!t.cols.some(function(c){ return c.name === it.col; })) throw { sql: 'no such column: ' + it.col };
        cols.push(it);
      }
    });
    headers = cols.map(function(c){ return c.alias; });
    data = rows.map(function(r){ return cols.map(function(c){ return sqlVal(r[c.col]); }); });
    if (q.distinct){
      var seen = {}, dd = [];
      data.forEach(function(r){
        var k = JSON.stringify(r);
        if (!seen[k]){ seen[k] = 1; dd.push(r); }
      });
      data = dd;
    }
  }
  return kubeTable(headers, data) + '\n' + data.length + ' row(s)';
}
function sqlInsert(q, ctx){
  var t = ctx.state.db[q.table];
  if (!t) return 'Error: no such table: ' + q.table;
  var cols = q.cols || t.cols.map(function(c){ return c.name; });
  cols.forEach(function(c){
    if (!t.cols.some(function(x){ return x.name === c; })) throw { sql: 'no such column: ' + c };
  });
  var n = 0;
  q.rows.forEach(function(vs){
    if (vs.length !== cols.length) throw { sql: 'table ' + q.table + ' has ' + cols.length + ' columns but ' + vs.length + ' values were supplied' };
    var r = {};
    t.cols.forEach(function(c){ r[c.name] = null; });
    cols.forEach(function(c, i){ r[c] = vs[i]; });
    t.rows.push(r); n++;
  });
  return n + ' row(s) inserted.';
}
function sqlUpdate(q, ctx){
  var t = ctx.state.db[q.table];
  if (!t) return 'Error: no such table: ' + q.table;
  var fn = sqlWhereFn(q.where), n = 0;
  t.rows.forEach(function(r){
    if (fn(r)){
      q.sets.forEach(function(s){
        if (!(s.col in r)) throw { sql: 'no such column: ' + s.col };
        r[s.col] = s.v;
      });
      n++;
    }
  });
  return n + ' row(s) updated.';
}
function sqlDelete(q, ctx){
  var t = ctx.state.db[q.table];
  if (!t) return 'Error: no such table: ' + q.table;
  var fn = sqlWhereFn(q.where), before = t.rows.length;
  t.rows = t.rows.filter(function(r){ return !fn(r); });
  return (before - t.rows.length) + ' row(s) deleted.';
}
function sqlCreate(q, ctx){
  var db = ctx.state.db;
  if (db[q.table]) return 'Error: table ' + q.table + ' already exists';
  db[q.table] = { cols: q.cols, rows: [] };
  return 'Table created.';
}

/* ================= MONGOSH PROFILE ================= */
var mongoIdCounter = 0;
function mongoObjectId(){
  mongoIdCounter++;
  var h = '';
  var seed = Date.now() + mongoIdCounter * 7919;
  for (var i = 0; i < 24; i++){ seed = (seed * 1103515245 + 12345) % 2147483648; h += '0123456789abcdef'[seed % 16]; }
  return { $oid: h };
}
function mongoParse(src){
  var i = 0, n = src.length;
  function ws(){ while (i < n && /\s/.test(src.charAt(i))) i++; }
  function parseVal(){
    ws();
    var c = src.charAt(i);
    if (c === "'" || c === '"'){
      var q = c, j = i + 1, s = '';
      while (j < n && src.charAt(j) !== q){ s += src.charAt(j) === '\\' && j + 1 < n ? src.charAt(++j) : src.charAt(j); j++; }
      i = j + 1;
      return s;
    }
    if (c === '{') return parseObj();
    if (c === '['){
      i++;
      var arr = [];
      ws();
      if (src.charAt(i) === ']'){ i++; return arr; }
      for (;;){ arr.push(parseVal()); ws(); if (src.charAt(i) === ','){ i++; continue; } break; }
      ws();
      if (src.charAt(i) !== ']') throw { mongo: 'Expected ]' };
      i++;
      return arr;
    }
    var m = src.slice(i).match(/^(-?\d+(\.\d+)?)/);
    if (m){ i += m[0].length; return parseFloat(m[0]); }
    var w = src.slice(i).match(/^[A-Za-z_$][A-Za-z0-9_$]*/);
    if (w){
      var word = w[0];
      i += word.length; ws();
      if (src.charAt(i) === '('){
        i++; ws();
        var arg = null;
        if (src.charAt(i) === "'" || src.charAt(i) === '"') arg = parseVal();
        ws();
        if (src.charAt(i) !== ')') throw { mongo: 'Expected )' };
        i++;
        if (word === 'ObjectId') return { $oid: arg || mongoObjectId().$oid };
        return arg;
      }
      if (word === 'true') return true;
      if (word === 'false') return false;
      if (word === 'null') return null;
      throw { mongo: 'Unexpected identifier: ' + word };
    }
    throw { mongo: 'Unexpected character: ' + c };
  }
  function parseObj(){
    i++; /* { */
    var o = {};
    ws();
    if (src.charAt(i) === '}'){ i++; return o; }
    for (;;){
      ws();
      var key;
      if (src.charAt(i) === "'" || src.charAt(i) === '"') key = parseVal();
      else {
        var km = src.slice(i).match(/^[A-Za-z_$][A-Za-z0-9_$.]*/);
        if (!km) throw { mongo: 'Expected key' };
        key = km[0]; i += key.length;
      }
      ws();
      if (src.charAt(i) !== ':') throw { mongo: 'Expected :' };
      i++;
      o[key] = parseVal();
      ws();
      if (src.charAt(i) === ','){ i++; continue; }
      break;
    }
    ws();
    if (src.charAt(i) !== '}') throw { mongo: 'Expected }' };
    i++;
    return o;
  }
  ws();
  var v = parseVal();
  ws();
  if (i < n) throw { mongo: 'Unexpected trailing input' };
  return v;
}
function mongoRepr(v){
  if (v && v.$oid) return "ObjectId('" + v.$oid + "')";
  if (v === null) return 'null';
  if (typeof v === 'string') return "'" + v.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
  if (Array.isArray(v)) return '[ ' + v.map(mongoRepr).join(', ') + ' ]';
  if (typeof v === 'object'){
    var parts = [];
    for (var k in v) parts.push((/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : mongoRepr(k)) + ': ' + mongoRepr(v[k]));
    return '{ ' + parts.join(', ') + ' }';
  }
  return String(v);
}
function mongoMatch(doc, q){
  for (var k in q){
    var cond = q[k], dv = doc[k];
    if (cond && typeof cond === 'object' && !cond.$oid && !Array.isArray(cond)){
      var ops = 0;
      for (var op in cond){
        ops++;
        if (op === '$gt'){ if (!(dv > cond[op])) return false; }
        else if (op === '$gte'){ if (!(dv >= cond[op])) return false; }
        else if (op === '$lt'){ if (!(dv < cond[op])) return false; }
        else if (op === '$lte'){ if (!(dv <= cond[op])) return false; }
        else if (op === '$ne'){ if (!(dv != cond[op])) return false; }
        else if (op === '$in'){
          var hit = false;
          for (var z = 0; z < cond[op].length; z++) if (dv == cond[op][z]) hit = true;
          if (!hit) return false;
        }
        else return false;
      }
      if (!ops) return false;
    } else {
      if (cond && cond.$oid){ if (!dv || dv.$oid !== cond.$oid) return false; }
      else if (dv != cond) return false;
    }
  }
  return true;
}

defineProfile('mongosh', {
  label: 'mongosh 2.3',
  shellName: 'mongosh (simulated)',
  prompt: '> ',
  initState: function(){
    return {
      currentDb: 'ilb',
      dbs: {
        ilb: {
          users: [
            { _id: { $oid: '68f001a1b2c3d4e5f6071821' }, name: 'Ada Okafor', role: 'engineer', skills: ['python', 'k8s'], active: true },
            { _id: { $oid: '68f001a1b2c3d4e5f6071822' }, name: 'Liam Chen', role: 'engineer', skills: ['go', 'terraform'], active: true },
            { _id: { $oid: '68f001a1b2c3d4e5f6071823' }, name: 'Maya Ruiz', role: 'analyst', skills: ['sql', 'dbt'], active: true },
            { _id: { $oid: '68f001a1b2c3d4e5f6071824' }, name: 'Noah Kim', role: 'engineer', skills: ['rust'], active: false }
          ],
          orders: [
            { _id: { $oid: '68f001a1b2c3d4e5f6071901' }, user: 'Ada Okafor', total: 2400, status: 'shipped' },
            { _id: { $oid: '68f001a1b2c3d4e5f6071902' }, user: 'Maya Ruiz', total: 680, status: 'pending' }
          ]
        },
        admin: {},
        config: {}
      }
    };
  },
  runLine: function(line, ctx){
    var t = trim(line), st = ctx.state;
    if (t === 'db') return st.currentDb;
    var mShow = t.match(/^show\s+(dbs|databases|collections)$/i);
    if (mShow){
      if (mShow[1].toLowerCase() === 'collections'){
        var db = st.dbs[st.currentDb] || {};
        var names = Object.keys(db);
        return names.length ? names.join('\n') : '(no collections)';
      }
      return Object.keys(st.dbs).map(function(d){
        var sz = JSON.stringify(st.dbs[d]).length;
        return padRight(d, 12) + (sz / 1024).toFixed(2) + ' KiB';
      }).join('\n');
    }
    var mUse = t.match(/^use\s+([A-Za-z_][A-Za-z0-9_$\-]*)$/);
    if (mUse){
      st.currentDb = mUse[1];
      if (!st.dbs[st.currentDb]) st.dbs[st.currentDb] = {};
      return 'switched to db ' + st.currentDb;
    }
    var mDb = t.match(/^db\.([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\(([\s\S]*)\)$/);
    if (mDb){
      var coll = mDb[1], method = mDb[2], argSrc = trim(mDb[3]);
      var db = st.dbs[st.currentDb] || (st.dbs[st.currentDb] = {});
      var docs = db[coll] || (db[coll] = []);
      var args = [];
      if (argSrc){
        /* split top-level commas */
        var parts = [], depth = 0, cur = '', instr = null;
        for (var i = 0; i < argSrc.length; i++){
          var c = argSrc.charAt(i);
          if (instr){ cur += c; if (c === instr) instr = null; continue; }
          if (c === "'" || c === '"') instr = c;
          else if ('{['.indexOf(c) >= 0) depth++;
          else if ('}]'.indexOf(c) >= 0) depth--;
          if (c === ',' && depth === 0){ parts.push(cur); cur = ''; continue; }
          cur += c;
        }
        parts.push(cur);
        try {
          for (var p = 0; p < parts.length; p++) args.push(mongoParse(parts[p]));
        } catch(e){ return 'MongoServerError: ' + (e.mongo || 'parse error'); }
      }
      return mongoMethod(coll, docs, method, args);
    }
    if (t === 'db.createCollection' || t.indexOf('db.createCollection(') === 0){
      var mm = t.match(/^db\.createCollection\(\s*['"]([^'"]+)['"]\s*\)$/);
      if (mm){
        var db2 = st.dbs[st.currentDb] || (st.dbs[st.currentDb] = {});
        db2[mm[1]] = db2[mm[1]] || [];
        return '{ ok: 1 }';
      }
    }
    if (t === 'db.getCollectionNames()'){
      var db3 = st.dbs[st.currentDb] || {};
      return '[ ' + Object.keys(db3).map(function(k){ return "'" + k + "'"; }).join(', ') + ' ]';
    }
    return defaultRunLine(line, ctx);
  },
  commands: {
    show: { d: 'show dbs | show collections', run: function(){ return 'Usage: show dbs | show collections'; } },
    use: { d: 'use <db> — switch database', run: function(){ return 'Usage: use <db>'; } },
    db: { d: 'db.<coll>.<method>() — collection ops', run: function(){ return 'Usage: db.<collection>.<method>(...)  e.g. db.users.find()'; } },
    find: { d: 'db.<coll>.find([query])', run: function(){ return 'Usage: db.<coll>.find([{...}])'; } },
    findOne: { d: 'db.<coll>.findOne([query])', run: function(){ return 'Usage: db.<coll>.findOne([{...}])'; } },
    insertOne: { d: 'db.<coll>.insertOne(doc)', run: function(){ return 'Usage: db.<coll>.insertOne({...})'; } },
    deleteOne: { d: 'db.<coll>.deleteOne(filter)', run: function(){ return 'Usage: db.<coll>.deleteOne({...})'; } },
    updateOne: { d: 'db.<coll>.updateOne(filter, update)', run: function(){ return 'Usage: db.<coll>.updateOne({...}, {$set: {...}})'; } },
    countDocuments: { d: 'db.<coll>.countDocuments([filter])', run: function(){ return 'Usage: db.<coll>.countDocuments([{...}])'; } },
    createCollection: { d: 'db.createCollection(name)', run: function(){ return 'Usage: db.createCollection(\'name\')'; } },
    help: { d: 'List available commands', run: function(){
      return ['mongosh (simulated) — try:',
        '  show dbs                  show collections',
        '  use ilb                   db',
        '  db.users.find()           db.users.find({ role: \'engineer\' })',
        '  db.users.findOne({ name: \'Ada Okafor\' })',
        '  db.users.insertOne({ name: \'Zoe\', role: \'analyst\' })',
        '  db.users.updateOne({ name: \'Zoe\' }, { $set: { active: true } })',
        '  db.users.deleteOne({ name: \'Zoe\' })',
        '  db.users.countDocuments()',
        'Operators in queries: $gt $gte $lt $lte $ne $in'].join('\n');
    }},
    clear: { d: 'Clear the terminal screen', run: function(){ clearScreen(); return ''; } },
    history: { d: 'Show command history', run: function(){
      var out = [];
      for (var i = 0; i < term.hist.length; i++) out.push('  ' + (i+1) + '  ' + term.hist[i]);
      return out.length ? out.join('\n') : '(no history yet)';
    }},
    exit: { d: 'Leave (stays open)', run: function(){ return 'Session kept alive — this is a simulated shell for practice.'; } }
  }
});

function mongoMethod(coll, docs, method, args){
  var q = args[0] || {};
  function matches(d){ return mongoMatch(d, q); }
  switch (method){
    case 'find': {
      var hits = docs.filter(matches);
      if (!hits.length) return '';
      return hits.map(mongoRepr).join('\n');
    }
    case 'findOne': {
      for (var i = 0; i < docs.length; i++) if (matches(docs[i])) return mongoRepr(docs[i]);
      return 'null';
    }
    case 'insertOne': {
      if (!args[0] || typeof args[0] !== 'object' || Array.isArray(args[0]))
        return 'MongoServerError: document must be an object';
      var doc = args[0];
      if (!doc._id) doc._id = mongoObjectId();
      docs.push(doc);
      return '{\n  acknowledged: true,\n  insertedId: ' + mongoRepr(doc._id) + '\n}';
    }
    case 'deleteOne': {
      for (var d2 = 0; d2 < docs.length; d2++){
        if (matches(docs[d2])){ docs.splice(d2, 1); return '{\n  acknowledged: true,\n  deletedCount: 1\n}'; }
      }
      return '{\n  acknowledged: true,\n  deletedCount: 0\n}';
    }
    case 'updateOne': {
      var upd = args[1] || {};
      for (var u = 0; u < docs.length; u++){
        if (matches(docs[u])){
          if (upd.$set) for (var k in upd.$set) docs[u][k] = upd.$set[k];
          else return 'MongoServerError: only $set updates are simulated';
          return '{\n  acknowledged: true,\n  matchedCount: 1,\n  modifiedCount: 1\n}';
        }
      }
      return '{\n  acknowledged: true,\n  matchedCount: 0,\n  modifiedCount: 0\n}';
    }
    case 'countDocuments': {
      var n = 0;
      for (var c2 = 0; c2 < docs.length; c2++) if (matches(docs[c2])) n++;
      return String(n);
    }
    default:
      return 'TypeError: db.' + coll + '.' + method + ' is not a function (simulated)';
  }
}

/* ================= TERRAFORM PROFILE ================= */
defineProfile('terraform', {
  label: 'Terraform v1.9.8',
  shellName: 'terraform (simulated)',
  tool: 'terraform',
  subcmds: ['init','plan','apply','destroy','fmt','validate','show','output','state','taint','untaint','version'],
  subs: { terraform: ['init','plan','apply','destroy','fmt','validate','show','output','state','taint','version'] },
  prompt: 'candidate@interstitium:~$ ',
  initState: function(){
    return {
      initialized: false,
      desired: [
        { addr: 'aws_instance.web', type: 'aws_instance', name: 'web' },
        { addr: 'aws_db_instance.main', type: 'aws_db_instance', name: 'main' }
      ],
      applied: {},
      tainted: {},
      outputs: { web_ip: '10.0.1.12', db_endpoint: 'ilb-main.c9a8b7.us-east-1.rds.amazonaws.com' }
    };
  },
  runLine: function(line, ctx){
    var args = splitArgs(line);
    if (!args.length) return '';
    if (args[0] !== 'terraform') return defaultRunLine(line, ctx);
    if (args.length === 1) return 'Usage: terraform [global options] <subcommand> [args]   (simulated)\nTry: terraform init   terraform plan';
    var sub = args[1], rest = args.slice(2);
    var cmd = this.commands[sub];
    if (cmd) return cmd.run(rest, ctx);
    return 'terraform: unknown command "' + sub + '" (simulated)';
  },
  commands: metaCommands({
    init: { d: 'Initialize backend/providers', run: function(a, ctx){
      ctx.state.initialized = true;
      return ['Initializing the backend...',
              'Initializing provider plugins...',
              '- Finding hashicorp/aws versions matching "~> 5.0"...',
              '- Installing hashicorp/aws v5.82.0...',
              'Terraform has been successfully initialized!'].join('\n');
    }},
    plan: { d: 'Show execution plan', run: function(a, ctx){
      var st = ctx.state;
      if (!st.initialized) return 'Error: terraform init is required before plan (simulated)';
      var adds = [], replaces = [], i;
      for (i = 0; i < st.desired.length; i++){
        var r = st.desired[i];
        if (!st.applied[r.addr]) adds.push(r);
        else if (st.tainted[r.addr]) replaces.push(r);
      }
      var out = ['Terraform used the selected providers to generate the following execution plan.'];
      adds.forEach(function(r){ out.push('  + ' + r.addr + '  (new ' + r.type + ')'); });
      replaces.forEach(function(r){ out.push('  -/+ ' + r.addr + '  (tainted — must be replaced)'); });
      out.push('');
      out.push('Plan: ' + adds.length + ' to add, ' + replaces.length + ' to replace, 0 to change, 0 to destroy.');
      if (!adds.length && !replaces.length) out.push('No changes. Your infrastructure matches the configuration.');
      return out.join('\n');
    }},
    apply: { d: 'Apply changes', run: function(a, ctx){
      var st = ctx.state;
      if (!st.initialized) return 'Error: terraform init is required before apply (simulated)';
      if (a.indexOf('-auto-approve') < 0)
        return 'Apply requires confirmation — re-run as:\n  terraform apply -auto-approve   (simulated; no real infrastructure)';
      var pending = st.desired.filter(function(r){ return !st.applied[r.addr] || st.tainted[r.addr]; });
      if (!pending.length) return 'Apply complete! Resources: 0 added, 0 changed, 0 destroyed.';
      pending.forEach(function(r){
        ctx.print(r.addr + ': Creating...', 'ilb-dim');
        ctx.print(r.addr + ': Creation complete after 4s [id=' + r.name + '-0a1b2c]', 'ilb-accent');
        st.applied[r.addr] = true;
        delete st.tainted[r.addr];
      });
      ctx.print('', '');
      return 'Apply complete! Resources: ' + pending.length + ' added, 0 changed, 0 destroyed.';
    }},
    destroy: { d: 'Destroy infrastructure', run: function(a, ctx){
      var st = ctx.state;
      if (!st.initialized) return 'Error: terraform init is required before destroy (simulated)';
      var doomed = Object.keys(st.applied);
      if (!doomed.length) return 'Destroy complete! Resources: 0 destroyed.';
      if (a.indexOf('-auto-approve') < 0)
        return 'Destroy requires confirmation — re-run as:\n  terraform destroy -auto-approve   (simulated)';
      doomed.forEach(function(addr){
        ctx.print(addr + ': Destroying...', 'ilb-dim');
        ctx.print(addr + ': Destruction complete', 'ilb-accent');
        delete st.applied[addr];
      });
      return 'Destroy complete! Resources: ' + doomed.length + ' destroyed.';
    }},
    fmt: { d: 'Format configuration', run: function(){ return 'main.tf\nvariables.tf\n(no changes — files already formatted, simulated)'; } },
    validate: { d: 'Validate configuration', run: function(a, ctx){
      if (!ctx.state.initialized) return 'Error: terraform init is required before validate (simulated)';
      return 'Success! The configuration is valid.';
    }},
    show: { d: 'Show state', run: function(a, ctx){
      var st = ctx.state, addrs = Object.keys(st.applied);
      if (!addrs.length) return 'No state. (run terraform apply -auto-approve)';
      var out = ['# state (simulated):'];
      addrs.forEach(function(addr){
        out.push('resource "' + addr + '" {', '  id = "' + addr.split('.')[1] + '-0a1b2c"', '}');
      });
      return out.join('\n');
    }},
    output: { d: 'Show outputs', run: function(a, ctx){
      var st = ctx.state, out = [];
      Object.keys(st.outputs).forEach(function(k){
        if (!a.length || a[0] === k) out.push(k + ' = "' + st.outputs[k] + '"');
      });
      return out.length ? out.join('\n') : 'No outputs matched.';
    }},
    state: { d: 'State subcommands', run: function(a, ctx){
      var st = ctx.state;
      if (a[0] === 'list'){
        var addrs = Object.keys(st.applied);
        return addrs.length ? addrs.join('\n') : '(no resources in state)';
      }
      if (a[0] === 'show' && a[1])
        return st.applied[a[1]] ? '# ' + a[1] + ':\nresource "' + a[1] + '" {\n  id = "' + a[1].split('.')[1] + '-0a1b2c"\n}'
          : 'Error: resource ' + a[1] + ' not in state';
      return 'usage: terraform state (list|show ADDR)   (simulated)';
    }},
    taint: { d: 'Mark resource tainted', run: function(a, ctx){
      var st = ctx.state;
      if (!a[0]) return 'usage: terraform taint ADDR   (simulated)';
      if (!st.applied[a[0]]) return 'Error: resource ' + a[0] + ' not in state';
      st.tainted[a[0]] = true;
      return 'Resource instance ' + a[0] + ' has been marked as tainted.';
    }},
    untaint: { d: 'Clear tainted mark', run: function(a, ctx){
      var st = ctx.state;
      if (!a[0]) return 'usage: terraform untaint ADDR   (simulated)';
      delete st.tainted[a[0]];
      return 'Resource instance ' + a[0] + ' has been successfully untainted.';
    }},
    version: { d: 'Terraform version', run: function(){ return 'Terraform v1.9.8\non linux_amd64 (simulated)'; } }
  })
});

/* ================= DOCKER PROFILE ================= */
var dockerCounter = 0;
function dockerId(){
  dockerCounter++;
  var h = '', seed = Date.now() + dockerCounter * 104729;
  for (var i = 0; i < 12; i++){ seed = (seed * 1103515245 + 12345) % 2147483648; h += '0123456789abcdef'[seed % 16]; }
  return h;
}
function dockerFind(st, ref){
  for (var i = 0; i < st.containers.length; i++){
    var c = st.containers[i];
    if (c.id.indexOf(ref) === 0 || c.name === ref) return c;
  }
  return null;
}

defineProfile('docker', {
  label: 'Docker 27.x',
  shellName: 'docker (simulated)',
  tool: 'docker',
  subcmds: ['ps','images','pull','run','logs','exec','stop','rm','rmi','version'],
  subs: { docker: ['ps','images','pull','run','logs','exec','stop','rm','rmi','version'] },
  prompt: 'candidate@interstitium:~$ ',
  initState: function(){
    return {
      images: [
        { repo: 'nginx', tag: 'latest', id: 'a1b2c3d4e5f6', size: '188MB' },
        { repo: 'python', tag: '3.12-slim', id: 'b2c3d4e5f6a7', size: '132MB' },
        { repo: 'redis', tag: '7-alpine', id: 'c3d4e5f6a7b8', size: '40MB' }
      ],
      containers: [
        { id: 'd4e5f6a7b8c9', image: 'nginx:latest', name: 'web', status: 'Up 2 hours', ports: '0.0.0.0:8080->80/tcp' },
        { id: 'e5f6a7b8c9d0', image: 'redis:7-alpine', name: 'cache', status: 'Up 2 hours', ports: '6379/tcp' }
      ]
    };
  },
  runLine: function(line, ctx){
    var args = splitArgs(line);
    if (!args.length) return '';
    if (args[0] !== 'docker') return defaultRunLine(line, ctx);
    if (args.length === 1) return 'Usage:  docker [OPTIONS] COMMAND   (simulated)\nTry: docker ps   docker images   docker run --help';
    var sub = args[1], rest = args.slice(2);
    var cmd = this.commands[sub];
    if (cmd) return cmd.run(rest, ctx);
    return 'docker: \'' + sub + '\' is not a docker command (simulated)';
  },
  commands: metaCommands({
    ps: { d: 'List containers', run: function(a, ctx){
      var st = ctx.state, all = a.indexOf('-a') >= 0 || a.indexOf('--all') >= 0;
      var list = st.containers.filter(function(c){ return all || c.status.indexOf('Up') === 0; });
      if (!list.length) return 'CONTAINER ID   IMAGE          COMMAND   CREATED   STATUS    PORTS   NAMES';
      return kubeTable(['CONTAINER ID', 'IMAGE', 'STATUS', 'PORTS', 'NAMES'],
        list.map(function(c){ return [c.id, c.image, c.status, c.ports, c.name]; }));
    }},
    images: { d: 'List images', run: function(a, ctx){
      return kubeTable(['REPOSITORY', 'TAG', 'IMAGE ID', 'SIZE'],
        ctx.state.images.map(function(i){ return [i.repo, i.tag, i.id, i.size]; }));
    }},
    pull: { d: 'Pull an image', run: function(a, ctx){
      var st = ctx.state, ref = a[0] || '';
      if (!ref) return '"docker pull" requires exactly 1 argument.';
      var parts = ref.split(':'), repo = parts[0], tag = parts[1] || 'latest';
      var exists = st.images.some(function(i){ return i.repo === repo && i.tag === tag; });
      var out = ['Using default tag: ' + tag,
                 tag + ': Pulling from library/' + repo,
                 'digest: sha256:' + dockerId() + dockerId() + ' (simulated)',
                 'Status: ' + (exists ? 'Image is up to date for ' + repo + ':' + tag : 'Downloaded newer image for ' + repo + ':' + tag)];
      if (!exists) st.images.push({ repo: repo, tag: tag, id: dockerId(), size: (20 + repo.length * 7) + 'MB' });
      return out.join('\n');
    }},
    run: { d: 'Run a container', run: function(a, ctx){
      var st = ctx.state, detach = false, name = null, ports = [], image = null;
      for (var i = 0; i < a.length; i++){
        var x = a[i];
        if (x === '-d' || x === '--detach') detach = true;
        else if (x === '--name' && i + 1 < a.length) name = a[++i];
        else if ((x === '-p' || x === '--publish') && i + 1 < a.length) ports.push(a[++i]);
        else if (x.charAt(0) !== '-') { image = x; break; }
      }
      if (!image) return '"docker run" requires at least 1 argument (IMAGE).';
      var parts = image.split(':'), repo = parts[0], tag = parts[1] || 'latest';
      var out = [];
      if (!st.images.some(function(im){ return im.repo === repo && im.tag === tag; })){
        out.push('Unable to find image \'' + image + '\' locally',
                 'latest: Pulling from library/' + repo,
                 'Status: Downloaded newer image for ' + repo + ':' + tag);
        st.images.push({ repo: repo, tag: tag, id: dockerId(), size: (20 + repo.length * 7) + 'MB' });
      }
      var id = dockerId();
      st.containers.push({
        id: id, image: repo + ':' + tag, name: name || ('brave_' + id.slice(0, 6)),
        status: 'Up 1 second',
        ports: ports.length ? ports.map(function(p){ return '0.0.0.0:' + p.split(':')[0] + '->' + p.split(':')[1] + '/tcp'; }).join(', ') : ''
      });
      out.push(id);
      return out.join('\n');
    }},
    logs: { d: 'Container logs', run: function(a, ctx){
      var c = dockerFind(ctx.state, a[0] || '');
      if (!c) return 'Error response from daemon: No such container: ' + (a[0] || '');
      return ['2026-10-04T09:12:01Z ' + c.image + ' starting',
              '2026-10-04T09:12:02Z listening on container port',
              '2026-10-04T09:20:11Z 10.0.0.8 - "GET / HTTP/1.1" 200'].join('\n');
    }},
    exec: { d: 'Exec in container', run: function(a, ctx){
      var c = dockerFind(ctx.state, a[0] || '');
      if (!c) return 'Error response from daemon: No such container: ' + (a[0] || '');
      var cmd = a.slice(1);
      if (!cmd.length) return '"docker exec" requires a command.';
      if (cmd[0] === 'echo') return cmd.slice(1).join(' ');
      if (cmd[0] === 'ls') return 'bin   etc   usr   var   app';
      if (cmd[0] === 'pwd') return '/';
      if (cmd[0] === 'whoami') return 'root';
      return 'exec simulated in ' + c.name + ' — no real container attached.';
    }},
    stop: { d: 'Stop a container', run: function(a, ctx){
      var c = dockerFind(ctx.state, a[0] || '');
      if (!c) return 'Error response from daemon: No such container: ' + (a[0] || '');
      c.status = 'Exited (0) 1 second ago';
      return c.name;
    }},
    rm: { d: 'Remove a container', run: function(a, ctx){
      var st = ctx.state, force = a.indexOf('-f') >= 0 || a.indexOf('--force') >= 0;
      var ref = a.filter(function(x){ return x.charAt(0) !== '-'; })[0] || '';
      var idx = -1;
      for (var i = 0; i < st.containers.length; i++){
        var c = st.containers[i];
        if (c.id.indexOf(ref) === 0 || c.name === ref){ idx = i; break; }
      }
      if (idx < 0) return 'Error response from daemon: No such container: ' + ref;
      if (st.containers[idx].status.indexOf('Up') === 0 && !force)
        return 'Error response from daemon: You cannot remove a running container. Stop it first or use -f.';
      return st.containers.splice(idx, 1)[0].name;
    }},
    rmi: { d: 'Remove an image', run: function(a, ctx){
      var st = ctx.state, ref = a[0] || '';
      for (var i = 0; i < st.images.length; i++){
        var im = st.images[i];
        if (im.repo + ':' + im.tag === ref || im.repo === ref || im.id.indexOf(ref) === 0){
          st.images.splice(i, 1);
          return 'Untagged: ' + im.repo + ':' + im.tag + '\nDeleted: sha256:' + im.id + ' (simulated)';
        }
      }
      return 'Error response from daemon: No such image: ' + ref;
    }},
    version: { d: 'Docker version', run: function(){
      return 'Client: Docker Engine 27.3.1\nServer: Docker Engine 27.3.1 (simulated)';
    }}
  })
});

/* ================= GIT PROFILE ================= */
var gitCounter = 0;
function gitHash(){
  gitCounter++;
  var h = '', seed = Date.now() + gitCounter * 1299709;
  for (var i = 0; i < 7; i++){ seed = (seed * 1103515245 + 12345) % 2147483648; h += '0123456789abcdef'[seed % 16]; }
  return h;
}

defineProfile('git', {
  label: 'git 2.47',
  shellName: 'git (simulated repo)',
  tool: 'git',
  subcmds: ['status','log','add','commit','branch','checkout','diff','push','pull','clone','remote','stash','merge','tag'],
  subs: { git: ['status','log','add','commit','branch','checkout','diff','push','pull','clone','remote','stash','merge','tag'] },
  prompt: function(t){ return 'candidate@interstitium:~/repo (' + t.state.current + ')$ '; },
  initState: function(){
    return {
      current: 'main',
      staged: [],
      branches: {
        main: [
          { hash: '9f3a2c1', msg: 'Add CI pipeline', author: 'candidate', date: '2026-09-28' },
          { hash: '4b7d9e2', msg: 'Refactor auth middleware', author: 'candidate', date: '2026-09-25' },
          { hash: 'c1a8f44', msg: 'Initial commit', author: 'candidate', date: '2026-09-20' }
        ],
        'feature/auth': [
          { hash: '77e0b31', msg: 'WIP: oauth callback', author: 'candidate', date: '2026-10-02' },
          { hash: '9f3a2c1', msg: 'Add CI pipeline', author: 'candidate', date: '2026-09-28' },
          { hash: '4b7d9e2', msg: 'Refactor auth middleware', author: 'candidate', date: '2026-09-25' },
          { hash: 'c1a8f44', msg: 'Initial commit', author: 'candidate', date: '2026-09-20' }
        ]
      },
      pushed: true
    };
  },
  runLine: function(line, ctx){
    var args = splitArgs(line);
    if (!args.length) return '';
    if (args[0] !== 'git') return defaultRunLine(line, ctx);
    if (args.length === 1) return 'usage: git <command> [<args>]   (simulated)\nTry: git status   git log --oneline';
    var sub = args[1], rest = args.slice(2);
    var cmd = this.commands[sub];
    if (cmd) return cmd.run(rest, ctx);
    return 'git: \'' + sub + '\' is not a git command (simulated). See \'git help\'.';
  },
  commands: metaCommands({
    status: { d: 'Working tree status', run: function(a, ctx){
      var st = ctx.state, out = ['On branch ' + st.current];
      if (st.staged.length){
        out.push('Changes to be committed:');
        st.staged.forEach(function(f){ out.push('  new file:   ' + f); });
      }
      out.push('Changes not staged for commit:', '  modified:   app.py', '',
               'no changes added to commit (simulated — use "git add" and "git commit")');
      return out.join('\n');
    }},
    log: { d: 'Commit history', run: function(a, ctx){
      var st = ctx.state, commits = st.branches[st.current], oneline = a.indexOf('--oneline') >= 0;
      var n = null;
      a.forEach(function(x){ var m = x.match(/^-n\s*(\d+)$/) || x.match(/^-(\d+)$/); if (m) n = parseInt(m[1], 10); });
      var list = n ? commits.slice(0, n) : commits;
      return list.map(function(c){
        return oneline ? c.hash + ' ' + c.msg
          : 'commit ' + c.hash + '0a1b2c (simulated)\nAuthor: candidate <candidate@interstitium>\nDate:   ' + c.date + '\n\n    ' + c.msg;
      }).join('\n\n');
    }},
    add: { d: 'Stage changes', run: function(a, ctx){
      var st = ctx.state;
      if (!a.length) return 'Nothing specified, nothing added.';
      a.forEach(function(f){
        if (f !== '.' && st.staged.indexOf(f) < 0) st.staged.push(f);
      });
      if (a.indexOf('.') >= 0 && st.staged.indexOf('app.py') < 0) st.staged.push('app.py');
      return '';
    }},
    commit: { d: 'Record staged changes', run: function(a, ctx){
      var st = ctx.state, msg = null;
      for (var i = 0; i < a.length; i++)
        if ((a[i] === '-m' || a[i] === '--message') && i + 1 < a.length) msg = a[i + 1];
      if (!msg) return 'Aborting commit due to empty commit message. (hint: git commit -m "msg")';
      if (!st.staged.length) return 'On branch ' + st.current + '\nnothing to commit, working tree clean (simulated)';
      var h = gitHash();
      st.branches[st.current].unshift({ hash: h, msg: msg, author: 'candidate', date: '2026-10-04' });
      st.staged = []; st.pushed = false;
      return '[' + st.current + ' ' + h + '] ' + msg + '\n 1 file changed (simulated)';
    }},
    branch: { d: 'List/create branches', run: function(a, ctx){
      var st = ctx.state, names = Object.keys(st.branches).sort();
      if (!a.length || a[0] === '-a')
        return names.map(function(b){ return (b === st.current ? '* ' : '  ') + b; }).join('\n');
      if (a[0] === '-d' && a[1]){
        if (a[1] === st.current) return 'error: cannot delete branch \'' + a[1] + '\' (checked out)';
        if (!st.branches[a[1]]) return 'error: branch \'' + a[1] + '\' not found.';
        delete st.branches[a[1]];
        return 'Deleted branch ' + a[1] + ' (simulated).';
      }
      var nb = a[0];
      if (st.branches[nb]) return 'fatal: a branch named \'' + nb + '\' already exists.';
      st.branches[nb] = st.branches[st.current].slice();
      return '';
    }},
    checkout: { d: 'Switch branches', run: function(a, ctx){
      var st = ctx.state;
      if (a[0] === '-b' && a[1]){
        if (st.branches[a[1]]) return 'fatal: a branch named \'' + a[1] + '\' already exists.';
        st.branches[a[1]] = st.branches[st.current].slice();
        st.current = a[1];
        return 'Switched to a new branch \'' + a[1] + '\'';
      }
      var b = a[0];
      if (!b) return 'usage: git checkout <branch>   (simulated)';
      if (!st.branches[b]) return 'error: pathspec \'' + b + '\' did not match any branch (simulated)';
      st.current = b;
      return 'Switched to branch \'' + b + '\'';
    }},
    diff: { d: 'Show changes', run: function(){
      return ['diff --git a/app.py b/app.py (simulated)',
              'index 4b7d9e2..9f3a2c1 100644',
              '--- a/app.py', '+++ b/app.py',
              '@@ -1,3 +1,4 @@',
              ' def greet(name):',
              '-    return "hello, " + name',
              '+    return f"hello, {name}"',
              '+',
              ' for i in range(3):'].join('\n');
    }},
    push: { d: 'Push to origin', run: function(a, ctx){
      var st = ctx.state;
      if (st.pushed) return 'Everything up-to-date (simulated).';
      st.pushed = true;
      return ['To github.com:interstitium-labs/bootcamp-practice.git (simulated)',
              '   9f3a2c1..' + st.branches[st.current][0].hash + '  ' + st.current + ' -> ' + st.current].join('\n');
    }},
    pull: { d: 'Pull from origin', run: function(){
      return 'Already up to date. (simulated)';
    }},
    clone: { d: 'Clone a repo', run: function(a){
      if (!a[0]) return 'usage: git clone <url>   (simulated)';
      var dir = a[0].split('/').pop().replace(/\.git$/, '');
      return 'Cloning into \'' + dir + '\'...\ndone. (simulated — no network)';
    }},
    stash: { d: 'Stash working changes', run: function(a, ctx){
      var st = ctx.state;
      st.stash = st.stash || [];
      if (a[0] === 'pop'){
        if (!st.stash.length) return 'No stash entries found. (simulated)';
        st.stash.pop();
        return 'Dropped refs/stash@{0} (simulated)';
      }
      if (a[0] === 'list')
        return st.stash.length
          ? st.stash.map(function(s, i){ return 'stash@{' + i + '}: ' + s; }).join('\n')
          : '(no stash entries) (simulated)';
      st.stash.push('WIP on ' + st.current);
      return 'Saved working directory and index state WIP on ' + st.current + ' (simulated)';
    }},
    merge: { d: 'Merge a branch', run: function(a, ctx){
      var st = ctx.state, br = a[0];
      if (!br) return 'usage: git merge <branch> (simulated)';
      if (!st.branches[br]) return 'merge: branch \'' + br + '\' not found (simulated)';
      return 'Merge made by the \'ort\' strategy (simulated).\n ' + br + ' -> ' + st.current;
    }},
    tag: { d: 'List/create tags', run: function(a, ctx){
      var st = ctx.state;
      st.tags = st.tags || ['v0.1.0'];
      if (a[0]){ st.tags.push(a[0]); return ''; }
      return st.tags.join('\n') + ' (simulated)';
    }},
    remote: { d: 'Manage remotes', run: function(a){
      if (a[0] === '-v' || a[0] === '--verbose')
        return 'origin\tgithub.com:interstitium-labs/bootcamp-practice.git (fetch)\norigin\tgithub.com:interstitium-labs/bootcamp-practice.git (push)\n(simulated)';
      return 'origin';
    }}
  })
});

/* ================= AZ PROFILE ================= */
defineProfile('az', {
  label: 'Azure CLI 2.66',
  shellName: 'az (simulated)',
  tool: 'az',
  subcmds: ['account', 'group', 'vm', 'aks', 'storage', 'network', 'version', 'login'],
  subs: { az: ['account', 'group', 'vm', 'aks', 'storage', 'network', 'version', 'login'] },
  prompt: 'candidate@interstitium:~$ ',
  initState: function(){
    return {
      groups: [
        { name: 'ilb-rg', location: 'eastus' },
        { name: 'ilb-network-rg', location: 'eastus2' }
      ],
      vms: [
        { name: 'ilb-web-01', rg: 'ilb-rg', state: 'VM running', size: 'Standard_D2s_v3' },
        { name: 'ilb-build-01', rg: 'ilb-rg', state: 'VM stopped', size: 'Standard_B2s' }
      ],
      aks: [ { name: 'ilb-aks', rg: 'ilb-rg', nodes: 3, version: '1.30' } ],
      storage: [ { name: 'ilbartifacts', rg: 'ilb-rg', sku: 'Standard_LRS' } ],
      vnets: [ { name: 'ilb-vnet', rg: 'ilb-network-rg', prefix: '10.0.0.0/16' } ]
    };
  },
  runLine: function(line, ctx){
    var args = splitArgs(line);
    if (!args.length) return '';
    if (args[0] !== 'az') return defaultRunLine(line, ctx);
    if (args.length === 1) return 'Use "az [command] --help" for more information (simulated).\nTry: az account show   az vm list';
    var sub = args[1], rest = args.slice(2);
    var cmd = this.commands[sub];
    if (cmd) return cmd.run(rest, ctx);
    return '\'' + sub + '\' is not in the \'az\' command group (simulated).';
  },
  commands: metaCommands({
    account: { d: 'Subscription info', run: function(a){
      if (a[0] === 'show')
        return JSON.stringify({
          environmentName: 'AzureCloud', id: '12345678-1234-1234-1234-123456789012',
          name: 'ILB-Playground', state: 'Enabled', tenantId: '87654321-4321-4321-4321-210987654321',
          user: { name: 'candidate@interstitium', type: 'user' }
        }, null, 2) + '\n(simulated)';
      if (a[0] === 'list')
        return kubeTable(['Name', 'SubscriptionId', 'State'],
          [['ILB-Playground', '12345678-1234-1234-1234-123456789012', 'Enabled'],
           ['ILB-Archive', '23456789-2345-2345-2345-345678901234', 'Enabled']]);
      return 'usage: az account (show|list)   (simulated)';
    }},
    group: { d: 'Resource groups', run: function(a, ctx){
      var st = ctx.state;
      if (a[0] === 'list' || !a.length)
        return kubeTable(['Name', 'Location'], st.groups.map(function(g){ return [g.name, g.location]; }));
      if (a[0] === 'create'){
        var name = null, loc = 'eastus';
        for (var i = 1; i < a.length; i++){
          if ((a[i] === '--name' || a[i] === '-n') && i + 1 < a.length) name = a[++i];
          else if (a[i] === '--location' || a[i] === '-l') loc = a[++i];
        }
        if (!name) return 'usage: az group create --name NAME --location LOCATION';
        st.groups.push({ name: name, location: loc });
        return JSON.stringify({ id: '/subscriptions/12345678/resourceGroups/' + name, location: loc, name: name }, null, 2) + '\n(simulated)';
      }
      return 'usage: az group (list|create)   (simulated)';
    }},
    vm: { d: 'Virtual machines', run: function(a, ctx){
      var st = ctx.state, op = a[0];
      function flag(n){
        for (var i = 0; i < a.length; i++)
          if ((a[i] === n || a[i] === '--name' && n === '-n' || a[i] === '--resource-group' && n === '-g') && i + 1 < a.length) return a[i + 1];
        return null;
      }
      var nm = flag('-n'), rg = flag('-g');
      if (op === 'list' || !op){
        var list = st.vms.filter(function(v){ return !rg || v.rg === rg; });
        return kubeTable(['Name', 'ResourceGroup', 'PowerState', 'Size'],
          list.map(function(v){ return [v.name, v.rg, v.state, v.size]; }));
      }
      if (op === 'start' || op === 'stop'){
        if (!nm) return 'usage: az vm ' + op + ' -n NAME -g RG   (simulated)';
        for (var i = 0; i < st.vms.length; i++){
          if (st.vms[i].name === nm && (!rg || st.vms[i].rg === rg)){
            st.vms[i].state = op === 'start' ? 'VM running' : 'VM stopped';
            return 'VM ' + nm + ' ' + (op === 'start' ? 'started' : 'deallocated') + ' (simulated).';
          }
        }
        return '(ResourceNotFound) The Resource \'Microsoft.Compute/virtualMachines/' + nm + '\' was not found.';
      }
      return 'usage: az vm (list|start|stop)   (simulated)';
    }},
    aks: { d: 'AKS clusters', run: function(a, ctx){
      if (a[0] === 'list' || !a.length)
        return kubeTable(['Name', 'ResourceGroup', 'Nodes', 'K8sVersion'],
          ctx.state.aks.map(function(k){ return [k.name, k.rg, k.nodes, k.version]; }));
      return 'usage: az aks list   (simulated)';
    }},
    storage: { d: 'Storage accounts', run: function(a, ctx){
      if (a[0] === 'account' && a[1] === 'list')
        return kubeTable(['Name', 'ResourceGroup', 'Sku'],
          ctx.state.storage.map(function(s){ return [s.name, s.rg, s.sku]; }));
      return 'usage: az storage account list   (simulated)';
    }},
    network: { d: 'Network resources', run: function(a, ctx){
      if (a[0] === 'vnet' && a[1] === 'list')
        return kubeTable(['Name', 'ResourceGroup', 'AddressPrefix'],
          ctx.state.vnets.map(function(v){ return [v.name, v.rg, v.prefix]; }));
      return 'usage: az network vnet list   (simulated)';
    }},
    version: { d: 'CLI version', run: function(){
      return JSON.stringify({ 'azure-cli': '2.66.0', 'azure-cli-core': '2.66.0' }, null, 2) + '\n(simulated)';
    }},
    login: { d: 'Sign in (simulated)', run: function(){
      return 'Already signed in as candidate@interstitium (simulated — no real auth).';
    }}
  })
});

/* ================= VAULT PROFILE ================= */
/* Consul companion for the vault profile (simulated KV + members; no real cluster). */
function consulRun(a, ctx){
  var st = ctx.state;
  st.consulKv = st.consulKv || { 'app/config/timeout': '30s', 'app/config/retries': '3' };
  st.consulMembers = st.consulMembers || ['server-1', 'server-2', 'server-3'];
  var sub = a[0] || '';
  if (sub === 'kv'){
    if (a[1] === 'put' && a[2]){
      var kv = a[2], val = a.slice(3).join(' ') || '', eq = kv.indexOf('=');
      if (eq > 0){ st.consulKv[kv.slice(0, eq)] = kv.slice(eq + 1); }
      else st.consulKv[kv] = val;
      return 'Success! Data written to: ' + kv.split('=')[0] + ' (simulated)';
    }
    if (a[1] === 'get' && a[2]){
      var v = st.consulKv[a[2]];
      return v === undefined ? 'Error: key not found (simulated)' : v + ' (simulated)';
    }
    if (a[1] === 'list' || a[1] === 'ls')
      return Object.keys(st.consulKv).join('\n') + ' (simulated)';
    return 'Usage: consul kv <put|get|list> ... (simulated)';
  }
  if (sub === 'members')
    return 'Node        Status\n' + st.consulMembers.map(function(m){ return m + '   alive'; }).join('\n') + ' (simulated)';
  if (sub === 'version') return 'Consul v1.19 (simulated)';
  return 'Usage: consul <kv|members|version> ... (simulated — no real cluster)';
}

defineProfile('vault', {
  label: 'Vault v1.18',
  shellName: 'vault (simulated)',
  tool: 'vault',
  subcmds: ['status','login','kv','token','policy','secrets','auth','version'],
  subs: { vault: ['status','login','kv','token','policy','secrets','auth','version'] },
  prompt: 'candidate@interstitium:~$ ',
  initState: function(){
    return {
      kv: {
        'secret/creds/db': { username: 'app', password: 's3cret-simulated' },
        'secret/api/keys': { stripe: 'sk_test_simulated' }
      },
      policies: ['default', 'ilb-admin', 'ilb-readonly'],
      tokens: []
    };
  },
  runLine: function(line, ctx){
    var args = splitArgs(line);
    if (!args.length) return '';
    if (args[0] === 'consul') return consulRun(args.slice(1), ctx);
    if (args[0] !== 'vault') return defaultRunLine(line, ctx);
    if (args.length === 1) return 'Usage: vault <command> [args]   (simulated)\nTry: vault status   vault kv list secret/';
    var sub = args[1], rest = args.slice(2);
    var cmd = this.commands[sub];
    if (cmd) return cmd.run(rest, ctx);
    return 'unknown command "' + sub + '" for "vault" (simulated)';
  },
  commands: metaCommands({
    status: { d: 'Seal/cluster status', run: function(){
      return ['Key             Value',
              '---             -----',
              'Seal Type       shamir',
              'Initialized     true',
              'Sealed          false',
              'Total Shares    5',
              'Version         1.18.2',
              'Cluster Name    ilb-vault',
              'HA Enabled      true',
              '(simulated)'].join('\n');
    }},
    login: { d: 'Authenticate', run: function(a){
      if (a[0] === '-method=userpass' || a[0] === '-method' && a[1] === 'userpass')
        return 'Success! You are now authenticated. (simulated token, never a real secret)';
      return 'usage: vault login -method=userpass username=candidate   (simulated)';
    }},
    kv: { d: 'KV secrets engine', run: function(a, ctx){
      var st = ctx.state, op = a[0];
      if (op === 'put' && a[1]){
        var path = a[1], data = {};
        for (var i = 2; i < a.length; i++){
          var m = a[i].match(/^([^=]+)=(.*)$/);
          if (m) data[m[1]] = m[2];
        }
        st.kv[path] = data;
        return 'Success! Data written to: ' + path + ' (simulated)';
      }
      if (op === 'get' && a[1]){
        var g = st.kv[a[1]];
        if (!g) return 'No value found at ' + a[1];
        var json = a.indexOf('-format=json') >= 0;
        if (json) return JSON.stringify({ data: g }, null, 2);
        var out = ['====== Data ======', 'Key        Value', '---        -----'];
        Object.keys(g).forEach(function(k){ out.push(padRight(k, 11) + g[k]); });
        return out.join('\n');
      }
      if (op === 'list'){
        var prefix = (a[1] || 'secret/').replace(/\/?$/, '/');
        var keys = Object.keys(st.kv).filter(function(k){ return k.indexOf(prefix) === 0; })
          .map(function(k){ return k.slice(prefix.length).split('/')[0]; });
        var uniq = [];
        keys.forEach(function(k){ if (uniq.indexOf(k) < 0) uniq.push(k); });
        return uniq.length ? ['Keys', '----'].concat(uniq).join('\n') : 'No value found at ' + prefix;
      }
      if (op === 'delete' && a[1]){
        if (!st.kv[a[1]]) return 'No value found at ' + a[1];
        delete st.kv[a[1]];
        return 'Success! Data deleted (if it existed) at: ' + a[1] + ' (simulated)';
      }
      return 'usage: vault kv (put|get|list|delete) PATH [k=v ...]   (simulated)';
    }},
    token: { d: 'Token operations', run: function(a, ctx){
      var st = ctx.state;
      if (a[0] === 'create'){
        var t = 's.' + dockerId() + dockerId();
        st.tokens.push(t);
        return 'Key                  Value\n---                  -----\ntoken                ' + t + '\n(simulated)';
      }
      if (a[0] === 'lookup')
        return 'Key         Value\n---         -----\npolicies    [default]\nttl         768h\n(simulated)';
      return 'usage: vault token (create|lookup)   (simulated)';
    }},
    policy: { d: 'List policies', run: function(a, ctx){
      if (a[0] === 'list' || !a.length) return ctx.state.policies.join('\n');
      return 'usage: vault policy list   (simulated)';
    }},
    secrets: { d: 'List secret engines', run: function(a){
      if (a[0] === 'list' || !a.length)
        return kubeTable(['Path', 'Type', 'Version'], [['kv/', 'kv', '2'], ['secret/', 'kv', '2'], ['pki/', 'pki', '-']]);
      return 'usage: vault secrets list   (simulated)';
    }},
    auth: { d: 'Auth methods', run: function(a){
      if (a[0] === 'list' || !a.length)
        return kubeTable(['Path', 'Type'], [['userpass/', 'userpass'], ['token/', 'token']]);
      return 'usage: vault auth list   (simulated)';
    }},
    version: { d: 'Vault version', run: function(){ return 'Vault v1.18.2 (simulated)'; } }
  })
});

/* ================= OCI PROFILE ================= */
defineProfile('oci', {
  label: 'OCI CLI 3.44',
  shellName: 'oci (simulated)',
  tool: 'oci',
  subcmds: ['iam', 'compute', 'network', 'os'],
  subs: { oci: ['iam', 'compute', 'network', 'os'] },
  prompt: 'candidate@interstitium:~$ ',
  initState: function(){
    return {
      compartments: [
        { id: 'ocid1.compartment.oc1..aaaaaaaailbprod', name: 'ilb-prod' },
        { id: 'ocid1.compartment.oc1..aaaaaaaailbdev', name: 'ilb-dev' }
      ],
      instances: [
        { id: 'ocid1.instance.oc1.iad.aaaaaaaailbweb', name: 'ilb-web-01', state: 'RUNNING', shape: 'VM.Standard.E5.Flex' },
        { id: 'ocid1.instance.oc1.iad.aaaaaaaailbdb', name: 'ilb-db-01', state: 'STOPPED', shape: 'VM.Standard.E5.Flex' }
      ],
      images: [ { id: 'ocid1.image.oc1.iad.aaaaaaaaoel9', name: 'Oracle-Linux-9.5', os: 'Oracle Linux' } ],
      vcns: [ { id: 'ocid1.vcn.oc1.iad.aaaaaaaailbvcn', name: 'ilb-vcn', cidr: '10.0.0.0/16' } ],
      buckets: [ { name: 'ilb-artifacts', namespace: 'ilbns' } ]
    };
  },
  runLine: function(line, ctx){
    var args = splitArgs(line);
    if (!args.length) return '';
    if (args[0] !== 'oci' && args[0] !== 'oci.exe') return defaultRunLine(line, ctx);
    var rest = args.slice(1);
    if (!rest.length) return 'Usage: oci <service> <resource> <action> [options]   (simulated)';
    if (rest[0] === '--version' || rest[0] === 'version') return this.commands.version.run([], ctx);
    var key3 = rest.slice(0, 3).join(' '), key2 = rest.slice(0, 2).join(' ');
    var key = this.commands[key3] ? key3 : (this.commands[key2] ? key2 : null);
    if (!key) return 'ServiceError: unknown command "oci ' + rest.slice(0, 3).join(' ') + '" (simulated)';
    return this.commands[key].run(rest.slice(key.split(' ').length), ctx);
  },
  commands: {
    'iam compartment list': { d: 'List compartments', run: function(a, ctx){
      return JSON.stringify({ data: ctx.state.compartments.map(function(c){
        return { 'compartment-id': c.id, name: c.name, 'lifecycle-state': 'ACTIVE' };
      }) }, null, 2);
    }},
    'iam group list': { d: 'List IAM groups', run: function(){
      return JSON.stringify({ data: [
        { id: 'ocid1.group.oc1..aaaaaaaailbadmins', name: 'ilb-admins' },
        { id: 'ocid1.group.oc1..aaaaaaaailbdevs', name: 'ilb-developers' }
      ] }, null, 2);
    }},
    'iam user list': { d: 'List IAM users', run: function(){
      return JSON.stringify({ data: [
        { id: 'ocid1.user.oc1..aaaaaaaacandidate', name: 'candidate' }
      ] }, null, 2);
    }},
    'compute instance list': { d: 'List compute instances', run: function(a, ctx){
      return JSON.stringify({ data: ctx.state.instances.map(function(x){
        return { id: x.id, 'display-name': x.name, 'lifecycle-state': x.state, shape: x.shape };
      }) }, null, 2);
    }},
    'compute instance launch': { d: 'Launch an instance', run: function(a, ctx){
      var st = ctx.state, name = 'ilb-new-01';
      for (var i = 0; i < a.length; i++)
        if (a[i] === '--display-name' && i + 1 < a.length) name = a[i + 1];
      var inst = { id: 'ocid1.instance.oc1.iad.aaaaaaaailb' + dockerId(), name: name, state: 'PROVISIONING', shape: 'VM.Standard.E5.Flex' };
      st.instances.push(inst);
      return JSON.stringify({ data: { id: inst.id, 'display-name': name, 'lifecycle-state': 'PROVISIONING' } }, null, 2) + '\n(simulated)';
    }},
    'compute instance terminate': { d: 'Terminate an instance', run: function(a, ctx){
      var st = ctx.state, id = null;
      for (var i = 0; i < a.length; i++)
        if (a[i] === '--instance-id' && i + 1 < a.length) id = a[i + 1];
      for (var j = 0; j < st.instances.length; j++){
        if (st.instances[j].id === id){ st.instances.splice(j, 1); return 'Instance terminated (simulated).'; }
      }
      return 'ServiceError: instance ' + (id || '') + ' not found (simulated)';
    }},
    'compute image list': { d: 'List images', run: function(a, ctx){
      return JSON.stringify({ data: ctx.state.images.map(function(x){
        return { id: x.id, 'display-name': x.name, 'operating-system': x.os };
      }) }, null, 2);
    }},
    'network vcn list': { d: 'List VCNs', run: function(a, ctx){
      return JSON.stringify({ data: ctx.state.vcns.map(function(v){
        return { id: v.id, 'display-name': v.name, 'cidr-block': v.cidr };
      }) }, null, 2);
    }},
    'os bucket list': { d: 'List buckets', run: function(a, ctx){
      return JSON.stringify({ data: ctx.state.buckets }, null, 2);
    }},
    version: { d: 'CLI version', run: function(){ return 'Oracle Cloud Infrastructure CLI 3.44.1 (simulated)'; } },
    help: { d: 'List available commands', run: function(a, ctx){
      var names = Object.keys(ctx.profile.commands).sort();
      var out = ['oci commands (simulated):'];
      for (var i = 0; i < names.length; i++)
        out.push('  oci ' + padRight(names[i], 28) + (ctx.profile.commands[names[i]].d || ''));
      return out.join('\n');
    }},
    clear: { d: 'Clear the terminal screen', run: function(){ clearScreen(); return ''; } },
    history: { d: 'Show command history', run: function(){
      var out = [];
      for (var i = 0; i < term.hist.length; i++) out.push('  ' + (i+1) + '  ' + term.hist[i]);
      return out.length ? out.join('\n') : '(no history yet)';
    }},
    exit: { d: 'Leave (stays open)', run: function(){ return 'Session kept alive — this is a simulated shell for practice.'; } }
  }
});

/* ================= BASH-LITE PROFILE (default) ================= */
var LITE_VERSIONS = {
  'java --version': 'openjdk version "21.0.4" 2024-07-16 LTS\nOpenJDK Runtime Environment (build 21.0.4+7-LTS)\n(simulated)',
  'javac --version': 'javac 21.0.4 (simulated)',
  'gcc --version': 'gcc (GCC) 14.2.1 20240912 (simulated)',
  'cc --version': 'cc (GCC) 14.2.1 (simulated)',
  'g++ --version': 'g++ (GCC) 14.2.1 (simulated)',
  'make --version': 'GNU Make 4.4.1 (simulated)',
  'dotnet --version': '9.0.100 (simulated)',
  'node --version': 'v22.11.0 (simulated)',
  'npm --version': '10.9.0 (simulated)',
  'go version': 'go version go1.23.4 linux/amd64 (simulated)',
  'code --version': '1.96.2 (simulated)'
};
function liteVersionCmd(tool, flag){
  return { d: tool + ' ' + flag + ' (static output)', run: function(a){
    var key = tool + ' ' + (a[0] || '');
    if (LITE_VERSIONS[key]) return LITE_VERSIONS[key];
    return 'usage: ' + tool + ' ' + flag + '   (simulated)';
  }};
}
function bashLiteProfile(slug){
  var s = String(slug || '').toLowerCase();
  var cmds = metaCommands({
    echo: { d: 'Print text', run: function(a){ return a.join(' '); } },
    whoami: { d: 'Print current user', run: function(){ return 'candidate'; } },
    id: { d: 'Print user identity', run: function(){ return 'uid=1000(candidate) gid=1000(candidate) groups=1000(candidate)'; } },
    date: { d: 'Current date/time', run: function(){ return new Date().toString(); } },
    ls: { d: 'List directory (static)', run: function(){ return 'README.md   app.py   logs/   notes.txt'; } },
    uname: { d: 'Print system info', run: function(a){
      return a.indexOf('-a') >= 0 ? 'Linux interstitium 6.8.0-ilb x86_64 GNU/Linux (simulated)' : 'Linux';
    }},
    pwd: { d: 'Print working directory', run: function(){ return '/home/candidate'; } },
    hostname: { d: 'Print hostname', run: function(){ return 'interstitium'; } }
  });
  /* flavor extras per path */
  function add(tool, flag){ if (!cmds[tool]) cmds[tool] = liteVersionCmd(tool, flag); }
  if (s === 'java' || s === 'spring'){ add('java', '--version'); add('javac', '--version'); }
  else if (s === 'c-lang'){ add('gcc', '--version'); add('cc', '--version'); }
  else if (s === 'cpp'){ add('g++', '--version'); add('make', '--version'); }
  else if (s === 'dotnet'){ add('dotnet', '--version'); }
  else if (s === 'react-frontend' || s === 'fullstack' || s === 'python-web'){ add('node', '--version'); add('npm', '--version'); }
  else if (s === 'blockchain-dev'){ add('node', '--version'); add('go', 'version'); }
  else if (s === 'ides-tooling'){ add('code', '--version'); }
  else if (s === 'creative-code'){ add('node', '--version'); }
  var def = {
    id: 'bash-lite',
    label: 'Bash (lite)',
    shellName: 'bash-lite (simulated)',
    prompt: 'candidate@interstitium:~$ ',
    commands: cmds
  };
  if (!def.runLine) def.runLine = defaultRunLine;
  return def;
}

/* ---------------- boot (runs after all profiles are defined) ---------------- */
if (DOC){
  if (DOC.readyState === 'loading') DOC.addEventListener('DOMContentLoaded', init);
  else init();
}

})(); /* end IIFE */
