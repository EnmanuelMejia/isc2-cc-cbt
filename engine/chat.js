/* ============================================================
   Interstitium Labs — Certification Bootcamps: chat companion engine
   Vanilla JS, zero dependencies.

   RUNTIME CONTRACT (set by the generator shell before this loads):
     window.CHAT_PAGE = {
       slug:        "python",
       bootcampUrl: "../index.html",   // back to the bootcamp
       hubUrl:      "../../../index.html",
       title:       "Python Programming"
     }
   Then this engine fetches "../content.json" and runs a mock-assessment
   conversation from CONTENT.chat = { persona, topics[] } where each topic is
   { id, name, key_points[], followups[], prompt?, hint? }.

   Feedback is keyword-heuristic (same algorithm as the proven companion):
   each key point becomes a keyword set derived from its wording; an answer
   is strong (>=60% of cues hit), partial (some cues), or missed (none).
   Everything runs locally in the browser. Nothing is sent anywhere.
   ============================================================ */
(function(){
'use strict';

var PAGE = window.CHAT_PAGE || {};

/* ---------------- utils ---------------- */
function $(id){ return document.getElementById(id); }
function esc(s){ return String(s == null ? '' : s)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function shuffle(a){ var r = a.slice();
  for (var i = r.length - 1; i > 0; i--){
    var j = Math.floor(Math.random() * (i + 1)), t = r[i]; r[i] = r[j]; r[j] = t; }
  return r; }

/* ---------------- keyword derivation ----------------
   Schema key_points are plain strings ("mutable default args").
   We turn each into matchable cues: significant words (len>=4, not a
   stopword) plus the full normalized phrase for exact-phrase hits. */
var STOP = {};
('a,an,the,and,or,but,if,then,else,for,of,to,in,on,at,by,with,from,as,is,are,' +
 'was,were,be,been,being,has,have,had,do,does,did,will,would,can,could,' +
 'should,may,might,must,shall,it,its,this,that,these,those,you,your,they,' +
 'their,we,our,he,she,his,her,not,no,yes,so,such,than,too,very,just,into,' +
 'over,under,between,through,during,before,after,when,where,which,who,whom,' +
 'what,why,how,all,any,both,each,few,more,most,other,some,only,own,same,' +
 'per,via,using,use,used,make,makes,many,much,also,well,key,core,main,' +
 'based').split(',').forEach(function(w){ STOP[w] = 1; });

function keywordsFor(point){
  var norm = String(point || '').toLowerCase().replace(/\s+/g, ' ').trim();
  var words = norm.split(/[^a-z0-9+#]+/).filter(function(w){
    return w.length >= 4 && !STOP[w];
  });
  var cues = words.slice();
  if (norm.length >= 6 && cues.indexOf(norm) < 0) cues.push(norm); // phrase cue
  /* de-dupe */
  var seen = {}, out = [];
  cues.forEach(function(c){ if (!seen[c]){ seen[c] = 1; out.push(c); } });
  return out;
}

/* ---------------- feedback engine ---------------- */
function analyze(answer, keyPoints){
  var text = ' ' + String(answer || '').toLowerCase() + ' ';
  return keyPoints.map(function(kp){
    var cues = keywordsFor(kp.label);
    var hits = cues.filter(function(kw){ return text.indexOf(kw) > -1; });
    var ratio = cues.length ? hits.length / cues.length : 0;
    var verdict = ratio >= 0.6 ? 'strong' : (hits.length > 0 ? 'partial' : 'missed');
    return { label: kp.label, verdict: verdict, hits: hits.length, of: cues.length };
  });
}
function feedbackHtml(results){
  var icons = { strong: '✓', partial: '~', missed: '✗' };
  var html = '<div class="feedback-lines" role="status">';
  results.forEach(function(r){
    html += '<div class="fline"><span class="badge b-' + r.verdict + '">' +
      icons[r.verdict] + '</span><span>' + esc(r.label) +
      ' <span style="color:var(--muted)">(' + r.hits + '/' + r.of + ' cues)</span></span></div>';
  });
  return html + '</div>';
}

/* ---------------- chat plumbing ---------------- */
function addMsg(kind, html){
  var log = $('chatLog');
  var d = document.createElement('div');
  d.className = 'msg ' + kind;
  d.innerHTML = '<span class="who">' + (kind === 'bot' ? 'COACH' : 'YOU') + '</span>' + html;
  log.appendChild(d);
  d.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  return d;
}
function botSay(html, delay, cb){
  var t = addMsg('bot', '<span class="typing" aria-label="Coach is typing"><i></i><i></i><i></i></span>');
  setTimeout(function(){
    t.innerHTML = '<span class="who">COACH</span>' + html;
    t.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    if (cb) cb();
  }, delay == null ? 600 : delay);
}
function setChips(chips){
  var row = $('chipRow');
  row.innerHTML = '';
  chips.forEach(function(c){
    var b = document.createElement('button');
    b.className = 'chip'; b.type = 'button'; b.textContent = c.label;
    b.setAttribute('aria-label', c.label);
    b.addEventListener('click', c.fn);
    row.appendChild(b);
  });
}

/* ---------------- session state ---------------- */
var TOPICS = [];      // [{id,name,keyPoints:[{label}],followups[],prompt,hint}]
var session = null;

function newStats(){
  var s = {};
  TOPICS.forEach(function(t){
    s[t.id] = { name: t.name, asked: 0, answered: 0, strong: 0, points: 0, themes: {} };
  });
  return s;
}
function topicPrompt(t){
  if (t.prompt) return t.prompt;
  return 'An interviewer leans in: "Walk me through ' + t.name +
    ' — the key ideas, the trade-offs, and how you would apply them under pressure." ' +
    'Answer as you would in the real thing: specific and structured.';
}
function topicHint(t){
  if (t.hint) return t.hint;
  return 'A strong answer touches each key point below — ' +
    'structure yours as a short list and give one concrete detail per point.';
}

function startSession(modeId){
  /* modeId: 'full' or a topic id */
  var queue = [];
  if (modeId === 'full'){
    shuffle(TOPICS).forEach(function(t){
      queue.push({ topic: t, q: topicPrompt(t), kind: 'prompt' });
    });
  } else {
    var t = TOPICS.filter(function(x){ return x.id === modeId; })[0];
    if (!t) return;
    queue.push({ topic: t, q: topicPrompt(t), kind: 'prompt' });
    (t.followups || []).forEach(function(f){
      queue.push({ topic: t, q: f, kind: 'followup' });
    });
  }
  session = { mode: modeId, queue: queue, pos: 0, stats: newStats(),
              awaiting: false, modelShown: false };
  $('chatLanding').style.display = 'none';
  $('chatScreen').style.display = '';
  $('chatLog').innerHTML = '';
  var modeName = modeId === 'full' ? 'Full session' :
    (TOPICS.filter(function(x){ return x.id === modeId; })[0] || {}).name;
  botSay('Locked in. <b>' + esc(modeName) + '</b> — ' + queue.length +
    ' rounds. Answer like it\'s the real thing: specific, structured, honest.',
    700, askNext);
}

function askNext(){
  if (!session || session.pos >= session.queue.length){ endSession(true); return; }
  var round = session.queue[session.pos];
  var t = round.topic;
  session.awaiting = true; session.modelShown = false;
  session.stats[t.id].asked++;
  updateProgress();
  $('chatInput').focus();
  var n = session.pos + 1, total = session.queue.length;
  setChips([
    { label: '💡 Hint', fn: showHint },
    { label: '📖 Model points', fn: showModel },
    { label: '⏭ Skip', fn: skipRound }
  ]);
  botSay('<b>Round ' + n + ' of ' + total + ' — ' + esc(t.name) + ':</b><br><br>' +
    esc(round.q), 900);
}
function updateProgress(){
  var total = session.queue.length, done = Math.min(session.pos, total);
  var label = session.mode === 'full' ? 'Full session' :
    (TOPICS.filter(function(x){ return x.id === session.mode; })[0] || {}).name + ' practice';
  $('progressLabel').textContent = label;
  $('progressCount').textContent = done + ' / ' + total;
  $('progressFill').style.width = (total ? (done / total * 100) : 0) + '%';
}
function currentRound(){ return session.queue[session.pos]; }

function showHint(){
  if (!session || !session.awaiting) return;
  var t = currentRound().topic;
  addMsg('bot', '💡 <b>Hint:</b> ' + esc(topicHint(t)));
}
function showModel(){
  if (!session || !session.awaiting) return;
  var t = currentRound().topic;
  session.modelShown = true;
  var html = '📖 <b>Model points for this round</b> — a strong answer touches all of these:<br><br><ul style="margin:0;padding-left:20px">';
  t.keyPoints.forEach(function(kp){ html += '<li>' + esc(kp.label) + '</li>'; });
  addMsg('bot', html + '</ul><br>Now give it your own shot — in your own words.');
}
function skipRound(){
  if (!session || !session.awaiting) return;
  session.awaiting = false;
  setChips([]);
  addMsg('bot', '⏭ Skipped — no shame in it. The point will come back around in drills.');
  session.pos++;
  setTimeout(askNext, 700);
}

var COACH_OPENERS = [
  'Debrief time. Here\'s how that landed:',
  'Sharp effort. Let\'s break it down:',
  'Good reps. Here\'s the honest read:',
  'Round complete — here\'s your debrief:'
];

function handleAnswer(raw){
  var answer = (raw || '').trim();
  if (!session || !session.awaiting || !answer) return;
  var round = currentRound(), t = round.topic;
  session.awaiting = false;
  setChips([]);
  addMsg('user', esc(answer));
  $('chatInput').value = '';

  var wordCount = answer.split(/\s+/).length;
  var results = analyze(answer, t.keyPoints);
  recordResults(t, results);
  var strongCount = results.filter(function(r){ return r.verdict === 'strong'; }).length;
  var total = results.length;

  var verdictLine;
  if (strongCount === total)
    verdictLine = '<b>Full coverage — ' + strongCount + '/' + total + ' key points hit.</b> That\'s the standard. Hold it.';
  else if (strongCount >= Math.ceil(total / 2))
    verdictLine = '<b>' + strongCount + '/' + total + ' key points strong.</b> Solid foundation — the gaps below are your reps for next time.';
  else
    verdictLine = '<b>' + strongCount + '/' + total + ' key points strong.</b> Honest read: this one needs another rep. Study the model points, then run it back.';

  var nudge = wordCount < 8 ?
    '<br><br>⚠️ <i>That was thin (' + wordCount + ' words). Interviewers read brevity as uncertainty — aim for a structured 4–6 sentence answer next round.</i>' : '';

  var opener = COACH_OPENERS[Math.floor(Math.random() * COACH_OPENERS.length)];
  botSay(opener + '<br><br>' + verdictLine + feedbackHtml(results) + nudge,
    900, function(){
      session.pos++;
      setTimeout(askNext, 1200);
    });
}
function recordResults(t, results){
  var st = session.stats[t.id];
  st.answered++; st.points += t.keyPoints.length;
  results.forEach(function(r){
    if (r.verdict === 'strong') st.strong++;
    else st.themes[r.label] = (st.themes[r.label] || 0) + 1;
  });
}

function endSession(finished){
  if (!session) return;
  session.awaiting = false;
  setChips([]);
  var stats = session.stats;
  var rows = '', totalStrong = 0, totalPoints = 0, totalAnswered = 0, totalAsked = 0;
  var themeAgg = {};
  TOPICS.forEach(function(t){
    var st = stats[t.id];
    if (!st.asked) return;
    totalStrong += st.strong; totalPoints += st.points;
    totalAnswered += st.answered; totalAsked += st.asked;
    Object.keys(st.themes).forEach(function(th){
      themeAgg[th] = (themeAgg[th] || 0) + st.themes[th];
    });
    var pct = st.points ? Math.round(st.strong / st.points * 100) : 0;
    rows += '<tr><td>' + esc(st.name) + '</td><td>' + st.answered + '/' + st.asked +
      '</td><td>' + st.strong + '/' + st.points + '</td><td>' + pct + '%</td></tr>';
  });
  var themes = Object.keys(themeAgg).sort(function(a, b){ return themeAgg[b] - themeAgg[a]; });
  var themeHtml = themes.length ?
    '<p><b>Improvement themes</b> — key points that came back missed or partial:</p>' +
    '<ul class="theme-list">' + themes.map(function(th){
      return '<li><b>' + esc(th) + '</b> — flagged ' + themeAgg[th] + '×</li>';
    }).join('') + '</ul>' :
    '<p><b>No weak themes.</b> Every key point you touched landed strong.</p>';

  var head = finished ? 'Session debrief ⚡' : 'Session ended';
  var html = '<h2 style="margin:0 0 10px">' + head + '</h2>' +
    '<p>' + totalAnswered + ' rounds answered · ' + totalStrong + '/' + totalPoints +
    ' key points strong.</p>' +
    (rows ? '<table class="debrief-table"><tr><th>Topic</th><th>Rounds</th><th>Strong</th><th>Rate</th></tr>' +
      rows + '</table>' : '<p>No rounds completed this session.</p>') +
    themeHtml +
    '<p style="color:var(--muted);font-size:13px">Feedback is keyword-based coaching, not an AI judge. ' +
    'Everything ran locally in your browser — nothing was sent anywhere.</p>';
  addMsg('bot', html);
  updateProgress();
  setChips([
    { label: '🔁 New session', fn: resetToLanding },
    { label: '← Back to bootcamp', fn: function(){
        window.location.href = PAGE.bootcampUrl || '../index.html'; } }
  ]);
}
function resetToLanding(){
  session = null;
  $('chatScreen').style.display = 'none';
  $('chatLanding').style.display = '';
  $('chatLog').innerHTML = '';
}

/* ---------------- boot ---------------- */
function renderLanding(chat){
  $('chatPersona').textContent = chat.persona ||
    'A rigorous mock assessor running you through realistic rounds.';
  $('chatBootcampName').textContent = PAGE.title || 'Bootcamp';
  var chips = $('topicChips');
  chips.innerHTML = '';
  TOPICS.forEach(function(t){
    var b = document.createElement('button');
    b.className = 'chip'; b.type = 'button';
    b.textContent = t.name + ' (' + t.keyPoints.length + ' points)';
    b.setAttribute('aria-label', 'Practice ' + t.name);
    b.addEventListener('click', function(){ startSession(t.id); });
    chips.appendChild(b);
  });
  var full = document.createElement('button');
  full.className = 'chip'; full.type = 'button';
  full.innerHTML = '<b>⚡ Full session — all ' + TOPICS.length + ' topics</b>';
  full.setAttribute('aria-label', 'Start a full session across all topics');
  full.addEventListener('click', function(){ startSession('full'); });
  chips.appendChild(full);
}

function showError(msg){
  $('chatLanding').innerHTML =
    '<div class="empty-note"><h2 style="color:var(--ink)">Companion is on the way</h2>' +
    '<p>' + esc(msg) + '</p><p><a href="' + esc(PAGE.bootcampUrl || '../index.html') +
    '">← Back to the bootcamp</a></p></div>';
}

function boot(){
  $('chatForm').addEventListener('submit', function(e){
    e.preventDefault();
    handleAnswer($('chatInput').value);
  });
  $('endSessionBtn').addEventListener('click', function(){ endSession(false); });

  fetch('../content.json', { cache: 'no-store' })
    .then(function(r){
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function(content){
      var chat = content.chat || {};
      TOPICS = (chat.topics || []).map(function(t){
        return {
          id: t.id, name: t.name,
          keyPoints: (t.key_points || []).map(function(kp){ return { label: kp }; }),
          followups: t.followups || [],
          prompt: t.prompt || null,
          hint: t.hint || null
        };
      }).filter(function(t){ return t.keyPoints.length > 0; });
      if (!TOPICS.length) throw new Error('No chat topics found in content.json.');
      document.title = 'Chat Companion — ' + (content.title || PAGE.title || 'Bootcamp');
      renderLanding(chat);
    })
    .catch(function(err){ showError('This companion\'s conversation content is being built. (' + err.message + ')'); });
}

/* Testing seam: when window.ENGINE_TEST is truthy (never set by the
   generator shells), expose pure internals for headless validation.
   See test/smoke.js. */
if (typeof window !== 'undefined' && window.ENGINE_TEST){
  window.__chatEngine = { keywordsFor: keywordsFor, analyze: analyze,
                          topicPrompt: topicPrompt };
}

if (document.readyState === 'loading')
  document.addEventListener('DOMContentLoaded', boot);
else
  boot();

})();
