'use strict';

// ---------- state ----------
var state = { stats: null, tab: 'overview', connected: false, exactNums: false, chartMetric: 'cost', chartRange: '14d', session: null, officeState: null };

// ---------- formatting ----------
function fmtTokens(n) {
  n = n || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
}
function fmtCost(n) {
  n = n || 0;
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function relTime(ms) {
  if (!ms) return '';
  var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return s + 's ago';
  var m = Math.round(s / 60);
  if (m < 60) return m + 'm ago';
  var h = Math.round(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.round(h / 24) + 'd ago';
}
function clock(ms) {
  if (!ms) return '';
  var d = new Date(ms);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function barClass(pct) {
  if (pct >= 90) return 'is-danger';
  if (pct >= 70) return 'is-warn';
  return 'is-ok';
}
function full(n) { return Math.round(n || 0).toLocaleString('en-US'); }
function metricFmt(v) { return state.chartMetric === 'cost' ? fmtCost(v) : fmtTokens(v); }
// a token number that shows the exact value on hover, and everywhere when
// "exact mode" is on (click any number to toggle).
function numSpan(n) {
  n = Math.round(n || 0);
  var shown = state.exactNums ? full(n) : fmtTokens(n);
  return '<span class="num" title="' + full(n) + ' tokens">' + shown + '</span>';
}

// ---------- bars ----------
function barHtml(pct, cls) {
  pct = Math.max(0, Math.min(100, pct || 0));
  return '<div class="bar"><div class="bar__fill ' + (cls || '') + '" style="width:' + pct + '%"></div></div>';
}

// ---------- overview ----------
function renderOverview() {
  var s = state.stats;
  var cards = [
    { label: 'This hour', w: s.windows.hour },
    { label: '5-hour window', w: s.windows.fiveHour },
    { label: 'Today', w: s.windows.today },
    { label: 'This week', w: s.windows.week },
  ];
  document.getElementById('ov-cards').innerHTML = cards.map(function (c) {
    return '<div class="stat" data-focus="1" data-flabel="' + c.label + '" data-fcost="' + c.w.cost + '" data-ftok="' + c.w.tokens + '">' +
      '<div class="stat__label">' + c.label + '</div>' +
      '<div class="stat__value">' + numSpan(c.w.tokens) + '</div>' +
      '<div class="stat__sub">' + fmtCost(c.w.cost) + ' equiv</div></div>';
  }).join('');

  renderActiveSessions(s);

  // active session
  var a = s.active;
  var actEl = document.getElementById('ov-active');
  if (a) {
    actEl.innerHTML =
      '<div class="card__head"><span class="card__title">Active session</span>' +
      '<span class="card__hint">' + (a.active ? 'live' : relTime(a.lastT)) + '</span></div>' +
      '<div class="act__title">' + esc(a.title) + '</div>' +
      '<div class="act__row">' +
        '<span class="chip chip--accent">' + esc(a.project) + '</span>' +
        '<span class="chip">' + esc(a.model) + '</span>' +
        '<span class="chip">' + numSpan(a.tokens) + ' tokens</span>' +
        '<span class="chip">' + fmtCost(a.cost) + ' equiv</span>' +
      '</div>' +
      (a.lastPrompt ? '<div class="act__prompt">' + esc(a.lastPrompt.slice(0, 160)) + '</div>' : '');
  } else {
    actEl.innerHTML = '<div class="card__head"><span class="card__title">Active session</span></div><div class="empty">no recent session</div>';
  }

  // sparkline
  var pts = seriesFor(s, state.chartRange);
  var total = pts.reduce(function (n, p) { return n + (p[state.chartMetric] || 0); }, 0);
  document.getElementById('ov-spark-total').textContent = metricFmt(total) + ' · ' + state.chartMetric;
  setRangeButtons();
  chart(document.getElementById('ov-spark'), pts, 'line');

  // limits compact
  renderLimitBars(document.getElementById('ov-limits'), s);
}

function renderActiveSessions(s) {
  var list = s.activeSessions || [];
  var el = document.getElementById('ov-active-sessions');
  var head = '<div class="card__head"><span class="card__title">Active now</span>' +
    '<span class="card__hint">' + list.length + (list.length === 1 ? ' session' : ' sessions') + ' · context per session</span></div>';
  if (!list.length) { el.innerHTML = head + '<div class="empty">no sessions in the last few minutes</div>'; return; }
  var rows = list.map(function (x) {
    return '<div class="ctxrow ctxrow--link" data-sid="' + esc(x.sid) + '">' +
      '<div class="ctxrow__top">' +
        '<span class="ctxrow__name"><span class="dot is-on"></span>' + esc(x.title) + ' <small>' + esc(x.project) + '</small></span>' +
        '<span class="ctxrow__val">' + numSpan(x.contextUsed) + ' / ' + fmtTokens(x.contextLimit) + ' · ' + x.contextPercent + '%</span>' +
      '</div>' +
      barHtml(x.contextPercent, barClass(x.contextPercent)) +
    '</div>';
  }).join('');
  el.innerHTML = head + rows;
}

// ---------- sessions ----------
function renderSessions() {
  var s = state.stats;
  document.getElementById('sessions-count').textContent = s.totals.sessions + ' total';
  var rows = s.sessions.map(function (x) {
    return '<div class="trow trow--link" data-sid="' + esc(x.sid) + '">' +
      '<span class="dot ' + (x.active ? 'is-on' : '') + '"></span>' +
      '<span class="trow__title">' + esc(x.title) + ' <small>' + esc(x.project) + '</small></span>' +
      '<span class="trow__model"><span class="chip">' + esc(x.model) + '</span></span>' +
      '<span class="trow__num">' + fmtTokens(x.tokens) + '</span>' +
      '<span class="trow__num trow__cost">' + fmtCost(x.cost) + '</span>' +
      '<span class="trow__num">' + relTime(x.lastT) + '</span>' +
    '</div>';
  }).join('');
  document.getElementById('sessions-table').innerHTML = rows || '<div class="empty">no sessions found</div>';
}

// ---------- usage ----------
function renderUsage() {
  var s = state.stats;
  chart(document.getElementById('usage-daily'), seriesFor(s, '30d'), 'bars');
  document.getElementById('usage-models').innerHTML = breakdownHtml(s.byModel);
  document.getElementById('usage-projects').innerHTML = breakdownHtml(s.byProject);
  document.getElementById('usage-tools').innerHTML = toolsHtml(s.byTool || {});

  var t = s.windows.total;
  var comp = [
    { k: 'input', v: t.inp }, { k: 'output', v: t.out },
    { k: 'cache write', v: t.cwr }, { k: 'cache read', v: t.crd },
  ];
  document.getElementById('usage-composition').innerHTML =
    '<div class="comp">' + comp.map(function (c) {
      return '<div class="comp__item"><div class="comp__k">' + c.k + '</div><div class="comp__v">' + fmtTokens(c.v) + '</div></div>';
    }).join('') + '</div>';
}

function breakdownHtml(map) {
  var keys = Object.keys(map);
  if (!keys.length) return '<div class="empty">no data</div>';
  var max = 0;
  keys.forEach(function (k) { if (map[k].tokens > max) max = map[k].tokens; });
  keys.sort(function (a, b) { return map[b].tokens - map[a].tokens; });
  return keys.map(function (k) {
    var b = map[k];
    var pct = max ? (b.tokens / max) * 100 : 0;
    return '<div class="brk"><div class="brk__top"><span class="brk__name">' + esc(k) + '</span>' +
      '<span class="brk__val">' + fmtTokens(b.tokens) + ' · ' + fmtCost(b.cost) + '</span></div>' +
      barHtml(pct, 'is-ok') + '</div>';
  }).join('');
}

function toolsHtml(map) {
  var keys = Object.keys(map);
  if (!keys.length) return '<div class="empty">no data</div>';
  var max = 0;
  keys.forEach(function (k) { if (map[k].count > max) max = map[k].count; });
  keys.sort(function (a, b) { return map[b].count - map[a].count; });
  return keys.map(function (k) {
    var b = map[k];
    var pct = max ? (b.count / max) * 100 : 0;
    return '<div class="brk"><div class="brk__top"><span class="brk__name">' + esc(k) + '</span>' +
      '<span class="brk__val">' + full(b.count) + ' call' + (b.count === 1 ? '' : 's') + '</span></div>' +
      barHtml(pct, 'is-ok') + '</div>';
  }).join('');
}

// ---------- limits ----------
function resetText(s, fk) {
  if (fk === 'today') {
    var d = new Date();
    var mid = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    return 'resets in ' + dur(mid - Date.now());
  }
  var ms = s.resets ? (fk === 'fiveHour' ? s.resets.fiveHourMs : fk === 'week' ? s.resets.weekMs : null) : null;
  return ms != null ? 'resets in ' + dur(ms) : '';
}

function renderLimitBars(container, s) {
  var b = s.budgets || {};
  var rows = [
    { name: '5-hour window', w: s.windows.fiveHour, budget: b.fiveHour, fk: 'fiveHour' },
    { name: 'Today', w: s.windows.today, budget: b.day, fk: 'today' },
    { name: 'This week', w: s.windows.week, budget: b.week, fk: 'week' },
  ];
  var peaks = s.peaks || {};
  container.innerHTML = rows.map(function (r) {
    var used = r.w.cost;
    var peakKey = r.fk === 'today' ? 'day' : r.fk;
    var denom = r.budget != null ? r.budget : peaks[peakKey];
    var pct = denom ? Math.round(used / denom * 100) : 0;
    var rt = resetText(s, r.fk);
    var reset = rt ? '<div class="limitrow__reset">' + rt + '</div>' : '';
    var attrs = ' data-focus="1" data-flabel="' + r.name + '" data-fcost="' + used + '" data-ftok="' + r.w.tokens + '"';
    var right = r.budget != null
      ? '<b>' + pct + '%</b> · ' + fmtCost(used) + ' / ' + fmtCost(r.budget)
      : '<b>' + pct + '%</b> · ' + fmtCost(used);
    return '<div class="limitrow"' + attrs + '><div class="limitrow__top"><span class="limitrow__name">' + r.name + '</span>' +
      '<span class="limitrow__val">' + right + '</span></div>' +
      barHtml(Math.min(100, pct), barClass(pct)) + reset + '</div>';
  }).join('');
}

function renderLimits() {
  var s = state.stats;
  document.getElementById('limits-plan').textContent = 'plan: ' + s.plan;
  var ctx = s.context;
  var bars = document.getElementById('limits-bars');
  renderLimitBars(bars, s);
  // append context row
  bars.insertAdjacentHTML('beforeend',
    '<div class="limitrow"><div class="limitrow__top"><span class="limitrow__name">Context window</span>' +
    '<span class="limitrow__val"><b>' + fmtTokens(ctx.used) + '</b> / ' + fmtTokens(ctx.limit) + ' · ' + ctx.percent + '%</span></div>' +
    barHtml(ctx.percent, barClass(ctx.percent)) + '</div>');
  document.getElementById('limits-note').textContent =
    'Percent is measured against your own busiest window so far, the closest honest proxy since Anthropic does not publish real limits. Click any row to see the exact tokens and dollars. Set fixed targets in ~/.claude-pulse.json ("budgets": {"fiveHour": 50, "day": 150, "week": 400}) to use those instead. Cost is an API-equivalent estimate, not what you pay on a subscription.';
}

// ---------- approvals: Allow / Allow all / Deny from the dashboard ----------
function renderApprovals(s) {
  var box = document.getElementById('approvals');
  if (!box) return;
  var pend = s.pending || [];
  // audible + visible signal whenever a new approval shows up, on any screen
  if (pend.length > (state.lastPendingCount || 0)) playAttention();
  state.lastPendingCount = pend.length;
  if (!pend.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = pend.map(function (p) {
    return '<div class="appr">' +
      '<div class="appr__info">' +
        '<span class="appr__tool">' + esc(p.tool) + '</span> wants to run' +
        (p.project ? ' <span class="appr__proj">' + esc(p.project) + '</span>' : '') +
        (p.summary ? '<div class="appr__sum">' + esc(p.summary) + '</div>' : '') +
      '</div>' +
      '<div class="appr__btns">' +
        '<button class="abtn abtn--allow" data-id="' + esc(p.id) + '" data-dec="allow" data-scope="once">Allow</button>' +
        '<button class="abtn abtn--all" data-id="' + esc(p.id) + '" data-dec="allow" data-scope="all">Allow all</button>' +
        '<button class="abtn abtn--deny" data-id="' + esc(p.id) + '" data-dec="deny" data-scope="once">Deny</button>' +
      '</div></div>';
  }).join('');
}

document.addEventListener('click', function (e) {
  var b = e.target.closest('.abtn');
  if (!b) return;
  fetch('/api/decision', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: b.getAttribute('data-id'), decision: b.getAttribute('data-dec'), scope: b.getAttribute('data-scope') }),
  }).then(function () { return fetch('/api/stats'); }).then(function (r) { return r.json(); }).then(applyStats).catch(function () {});
});

// ---------- result readiness ring (top right, on every screen) ----------
var READY_CIRC = 2 * Math.PI * 15;
function updateReady(s) {
  var el = document.getElementById('ready');
  if (!el) return;
  var waiting = !!s.waiting;
  var phase = waiting ? 'waiting' : (s.eta ? s.eta.phase : 'idle');
  if (phase === 'idle') { el.hidden = true; return; }
  el.hidden = false;
  el.classList.toggle('is-done', phase === 'done');

  var pct;
  if (phase === 'done' || phase === 'waiting') pct = 100;
  else pct = (s.eta && s.eta.medianMs) ? Math.min(99, Math.max(3, Math.round(s.eta.elapsedMs / s.eta.medianMs * 100))) : 50;

  document.getElementById('ready-fg').style.strokeDashoffset = (READY_CIRC * (1 - pct / 100)).toFixed(2);
  document.getElementById('ready-pct').textContent = phase === 'done' ? 'ready' : phase === 'waiting' ? 'you' : pct + '%';
  el.title = phase === 'working' ? ('result about ' + pct + '% ready') : phase === 'done' ? 'result ready, your turn' : 'needs you';
}

// ---------- office (crab) ----------
function dur(ms) {
  var s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + 's';
  var m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return r ? m + 'm ' + r + 's' : m + 'm';
  var h = Math.floor(m / 60); return h + 'h ' + (m % 60) + 'm';
}

var audioCtx = null;
function initAudio() { if (audioCtx) return; try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} }
document.addEventListener('click', initAudio);
function tone(freq, start, len, vol) {
  if (!audioCtx) return;
  var o = audioCtx.createOscillator(), g = audioCtx.createGain();
  o.type = 'sine'; o.frequency.value = freq;
  o.connect(g); g.connect(audioCtx.destination);
  var t = audioCtx.currentTime + start;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(vol || 0.08, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  o.start(t); o.stop(t + len + 0.03);
}
function playAttention() { tone(660, 0, 0.16); tone(880, 0.16, 0.2); }
function playDone() { tone(523, 0, 0.14); tone(659, 0.13, 0.14); tone(784, 0.26, 0.26); }
function playError() { tone(220, 0, 0.18); tone(165, 0.14, 0.26); }

// maskot voice: rotating phrases per state, swears (mildly) on errors
var PHRASES = {
  working: ['cooking...', 'in the zone', 'typing furiously', 'brain on fire', 'locked in', 'deep in the code', 'do not disturb', 'shipping it', 'compiling genius', 'hold my coffee'],
  done: ['done!', 'shipped.', 'nailed it', 'boom.', "that's a wrap", 'ez', 'your turn'],
  waiting: ['yo, need you', 'tap me in', 'your move', 'permission pls', 'unblock me', 'waiting on you'],
  idle: ['chilling', 'coffee break', 'zzz', 'bored', 'awaiting orders', 'idle hands'],
  error: ['ah, crap.', 'well, shit.', 'damn it.', '@#$%!', "that's busted", 'oof, that broke', 'ugh, error'],
};
function phraseFor(s) {
  var pool = PHRASES[s] || [s];
  return pool[Math.floor(Date.now() / 10000) % pool.length];
}

// turn the latest tool call into a readable "what Claude is doing" label
var VERB = {
  Edit: 'editing', MultiEdit: 'editing', Write: 'writing', NotebookEdit: 'editing',
  Read: 'reading', Bash: 'running', Grep: 'searching', Glob: 'searching', LS: 'listing',
  Task: 'delegating', WebFetch: 'fetching', WebSearch: 'searching', TodoWrite: 'planning',
};
function cap1(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function actionLabel(a) {
  if (!a || !a.name) return '';
  var verb = VERB[a.name] || a.name.toLowerCase();
  var hint = a.hint || '';
  if (hint.indexOf('/') !== -1 && a.name !== 'Bash') hint = hint.split('/').pop();
  hint = hint.replace(/\s+/g, ' ').trim().slice(0, 30);
  return cap1(hint ? (verb + ' ' + hint) : verb);
}

function summarizeActions(actions) {
  if (!actions || !actions.length) return '';
  var counts = {};
  actions.forEach(function (a) { counts[a.name] = (counts[a.name] || 0) + 1; });
  return Object.keys(counts).map(function (k) { return counts[k] + '× ' + esc(k); }).join(' · ');
}
function hideDoneOverlay() {
  var ov = document.getElementById('done-overlay');
  if (ov) ov.hidden = true;
  if (state.doneOvTimer) { clearTimeout(state.doneOvTimer); state.doneOvTimer = null; }
}
function showDoneOverlay(sid) {
  if (!sid) return;
  fetch('/api/session?sid=' + encodeURIComponent(sid)).then(function (r) { return r.json(); }).then(function (d) {
    var turns = d.turns || [];
    var t = turns[turns.length - 1];
    if (!t) return;
    var acts = t.actions || [];
    if (acts.length < 1 && (!t.text || t.text.length < 40)) return; // trivial reply, skip the big overlay
    document.getElementById('done-phrase').textContent = phraseFor('done');
    document.getElementById('done-did').innerHTML =
      (acts.length ? '<div class="done__acts">' + summarizeActions(acts) + '</div>' : '') +
      (t.text ? '<div class="done__text">' + esc(t.text.slice(0, 200)) + '</div>' : '');
    var ov = document.getElementById('done-overlay');
    ov.hidden = false;
    if (state.doneOvTimer) clearTimeout(state.doneOvTimer);
    state.doneOvTimer = setTimeout(function () { ov.hidden = true; }, 8000);
  }).catch(function () {});
}

var VIBE_LABEL = { office: 'Office', garage: 'Garage', courchevel: 'Courchevel', paris: 'Paris' };
var STEAM_POS = {
  office: { left: '60%', top: '63%' }, garage: { left: '57%', top: '66%' },
  courchevel: { left: '58%', top: '70%' }, paris: { left: '60%', top: '72%' },
};

function buildLights() {
  if (state.lightsBuilt) return;
  var box = document.getElementById('scene-lights');
  if (!box) return;
  var colors = ['#f5c87a', '#d97757', '#e8e6da', '#9bb4d0', '#ffd9a0'];
  var html = '';
  for (var i = 0; i < 34; i++) {
    var x = (16 + Math.random() * 76).toFixed(1);
    var y = (18 + Math.random() * 42).toFixed(1);
    var c = colors[Math.floor(Math.random() * colors.length)];
    html += '<i style="left:' + x + '%;top:' + y + '%;background:' + c +
      ';animation-delay:' + (Math.random() * 4).toFixed(2) + 's;animation-duration:' + (2.4 + Math.random() * 2.6).toFixed(2) + 's"></i>';
  }
  box.innerHTML = html;
  state.lightsBuilt = true;
}

function setVibeButtons() {
  var btns = document.querySelectorAll('#vibe-seg button');
  for (var i = 0; i < btns.length; i++) {
    btns[i].classList.toggle('is-on', btns[i].getAttribute('data-vibe') === (state.vibe || 'office'));
  }
}

function flashDone() {
  state.doneFlash = true;
  if (state.doneTimer) clearTimeout(state.doneTimer);
  state.doneTimer = setTimeout(function () { state.doneFlash = false; if (state.tab === 'office') renderOffice(); }, 5000);
}

function renderOffice() {
  var s = state.stats;
  var scene = document.getElementById('scene');
  if (!scene) return;
  buildLights();
  setVibeButtons();

  var waiting = !!s.waiting || (s.pending && s.pending.length > 0);
  var eta = s.eta;
  var phase = eta ? eta.phase : 'idle';        // working | done | idle
  var ns = waiting ? 'waiting' : phase;

  if (state.officeState !== ns) {
    if (ns === 'waiting') playAttention();
    else if (ns === 'error') playError();
    else if (ns === 'done') { playDone(); showDoneOverlay(s.active && s.active.sid); }
    state.officeState = ns;
  }
  if (ns !== 'done') hideDoneOverlay();

  // scene image: at the desk only while actually working, standing otherwise
  var vibe = state.vibe || 'office';
  var atDesk = (ns === 'working');
  var src = 'assets/Claude' + VIBE_LABEL[vibe] + (atDesk ? 'Work' : '') + '.png';
  var img = document.getElementById('scene-img');
  if (img.getAttribute('src') !== src) img.setAttribute('src', src);

  scene.classList.toggle('is-working', ns === 'working');

  var steam = document.getElementById('scene-steam');
  var pos = STEAM_POS[vibe];
  if (pos) { steam.style.left = pos.left; steam.style.top = pos.top; }

  var bubble = document.getElementById('scene-bubble');
  bubble.className = 'scene__bubble';
  if (ns === 'waiting') { bubble.hidden = false; bubble.textContent = '!'; }
  else if (ns === 'error') { bubble.hidden = false; bubble.textContent = '✕'; bubble.classList.add('is-error'); }
  else { bubble.hidden = true; }

  var stateLabel;
  if (ns === 'working') {
    var a0 = (s.activity && s.activity[0]) ? s.activity[0] : null;
    stateLabel = a0 ? actionLabel(a0) : cap1(phraseFor('working'));
  } else {
    stateLabel = cap1(phraseFor(ns));
  }
  document.getElementById('office-state').textContent = stateLabel;

  var etaEl = document.getElementById('office-eta');
  var subEl = document.getElementById('office-sub');
  if (ns === 'waiting') {
    if (s.pending && s.pending.length) {
      var p0 = s.pending[0];
      etaEl.textContent = p0.tool + ' needs approval';
      subEl.textContent = (p0.summary ? p0.summary.slice(0, 80) + ' · ' : '') + 'use the buttons above';
    } else if (s.waiting) {
      etaEl.textContent = s.waiting.message || 'waiting for your approval';
      subEl.textContent = (s.waiting.project ? s.waiting.project + ' · ' : '') + 'respond in your terminal';
    } else {
      etaEl.textContent = 'waiting for you';
      subEl.textContent = '';
    }
  } else if (ns === 'working' && eta) {
    if (eta.remainingMs != null && eta.medianMs) etaEl.textContent = 'ready in about ' + dur(eta.remainingMs);
    else etaEl.textContent = 'working for ' + dur(eta.elapsedMs);
    subEl.textContent = eta.medianMs ? ('typical task here ~' + dur(eta.medianMs) + ' · rough estimate') : 'rough estimate';
  } else if (ns === 'error') {
    var r5 = s.resets && s.resets.fiveHourMs;
    etaEl.textContent = r5 ? ('limit? resets in ' + dur(r5)) : 'something broke';
    subEl.textContent = 'check your terminal';
  } else if (ns === 'done') {
    etaEl.textContent = 'your turn';
    subEl.textContent = 'finished, waiting for you';
  } else {
    etaEl.textContent = 'nothing running';
    subEl.textContent = 'Claude is resting';
  }

  // most important numbers, surfaced right on this screen
  var info = document.getElementById('office-info');
  if (info) {
    var base = s.active
      ? 'context ' + s.active.contextPercent + '% · today ' + numSpan(s.windows.today.tokens) + ' tok · ' + fmtCost(s.windows.today.cost)
      : 'today ' + fmtTokens(s.windows.today.tokens) + ' tok · ' + fmtCost(s.windows.today.cost);
    info.innerHTML = base;
  }
}

// ---------- activity ----------
function renderActivity() {
  var s = state.stats;
  var rows = s.activity.map(function (a) {
    return '<div class="fitem">' +
      '<span class="fitem__time">' + clock(a.t) + '</span>' +
      '<span class="ftag">' + esc(a.name) + '</span>' +
      '<span class="fitem__hint">' + esc(a.hint) + '</span>' +
      '<span class="fitem__proj">' + esc(a.project) + '</span>' +
    '</div>';
  }).join('');
  document.getElementById('activity-feed').innerHTML = rows || '<div class="empty">no activity yet</div>';
}

// ---------- charts ----------
function setupCanvas(canvas) {
  var dpr = window.devicePixelRatio || 1;
  // cache the logical height once: assigning canvas.height below mutates the
  // height attribute, so reading it again each frame would compound by dpr
  // and the chart would grow taller on every update.
  if (canvas._h == null) canvas._h = parseInt(canvas.getAttribute('height'), 10) || 120;
  var h = canvas._h;
  var w = canvas.clientWidth || canvas.parentNode.clientWidth || 600;
  canvas.style.width = '100%';
  canvas.style.height = h + 'px';
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  var ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx: ctx, w: w, h: h };
}

// robust scale max: 90th percentile of non-zero values so a single huge day
// (cache-read spikes) does not flatten everything else to the floor
function scaleMax(vals) {
  var nz = vals.filter(function (v) { return v > 0; }).sort(function (a, b) { return a - b; });
  if (!nz.length) return 1;
  return Math.max(nz[Math.floor(nz.length * 0.9)] || nz[nz.length - 1], 1);
}

// build a labelled series for a range: 24h uses hourly, the rest use daily
function seriesFor(s, range) {
  if (range === '24h') {
    return s.hourly.map(function (p) { return { label: clock(p.t), tokens: p.tokens, cost: p.cost }; });
  }
  var n = range === '7d' ? 7 : range === '30d' ? 30 : 14;
  return s.daily.slice(-n).map(function (d) { return { label: d.date.slice(5), tokens: d.tokens, cost: d.cost }; });
}

// one chart entry point; supports 'line' and 'bars', with hover tooltip
function chart(canvas, points, type) {
  if (!canvas) return;
  canvas._data = points;
  canvas._type = type;
  drawChart(canvas, null);
  attachHover(canvas);
}

function drawChart(canvas, hi) {
  var c = setupCanvas(canvas);
  if (c.w < 2) return;
  var ctx = c.ctx, w = c.w, h = c.h, pad = canvas._type === 'bars' ? 8 : 6;
  ctx.clearRect(0, 0, w, h);
  var pts = canvas._data || [];
  var vals = pts.map(function (p) { return p[state.chartMetric] || 0; });
  var max = scaleMax(vals);
  var n = vals.length;
  var accent = cssVar('--accent') || '#d97757';
  var geom = [];

  if (canvas._type === 'bars') {
    var gap = n > 40 ? 1 : 3;
    var bw = (w - pad * 2 - gap * (n - 1)) / n;
    var track = cssVar('--track') || 'rgba(0,0,0,.07)';
    for (var i = 0; i < n; i++) {
      var bh = Math.min(1, vals[i] / max) * (h - pad * 2);
      if (vals[i] > 0) bh = Math.max(bh, 3);
      var bx = pad + i * (bw + gap);
      ctx.fillStyle = track;
      roundRect(ctx, bx, pad, bw, h - pad * 2, 2); ctx.fill();
      ctx.fillStyle = hi === i ? cssVar('--text') : (vals[i] ? accent : track);
      roundRect(ctx, bx, h - pad - bh, bw, bh, 2); ctx.fill();
      geom.push({ x: bx + bw / 2 });
    }
  } else {
    var X = function (i) { return pad + (n === 1 ? (w - pad * 2) / 2 : (i / (n - 1)) * (w - pad * 2)); };
    var Y = function (v) { return h - pad - Math.min(1, v / max) * (h - pad * 2); };
    ctx.beginPath(); ctx.moveTo(X(0), h - pad);
    for (var a = 0; a < n; a++) ctx.lineTo(X(a), Y(vals[a]));
    ctx.lineTo(X(n - 1), h - pad); ctx.closePath();
    ctx.fillStyle = hexA(accent, 0.12); ctx.fill();
    ctx.beginPath();
    for (var b = 0; b < n; b++) { var px = X(b), py = Y(vals[b]); b ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }
    ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
    for (var k = 0; k < n; k++) geom.push({ x: X(k), y: Y(vals[k]) });
    if (hi != null && geom[hi]) {
      var g = geom[hi];
      ctx.strokeStyle = hexA(accent, 0.45); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(g.x, pad); ctx.lineTo(g.x, h - pad); ctx.stroke();
      ctx.fillStyle = accent; ctx.beginPath(); ctx.arc(g.x, g.y, 4, 0, Math.PI * 2); ctx.fill();
    }
  }
  canvas._geom = geom;
}

function attachHover(canvas) {
  if (canvas._hoverBound) return;
  canvas._hoverBound = true;
  canvas.addEventListener('mousemove', function (e) {
    if (!canvas._geom || !canvas._geom.length) return;
    var rect = canvas.getBoundingClientRect();
    var mx = e.clientX - rect.left;
    var best = 0, bd = 1e9;
    for (var i = 0; i < canvas._geom.length; i++) {
      var d = Math.abs(canvas._geom[i].x - mx);
      if (d < bd) { bd = d; best = i; }
    }
    drawChart(canvas, best);
    showTip(e.clientX, e.clientY, canvas._data[best]);
  });
  canvas.addEventListener('mouseleave', function () { drawChart(canvas, null); hideTip(); });
}

function showTip(cx, cy, p) {
  var tip = document.getElementById('chart-tip');
  if (!tip || !p) return;
  tip.innerHTML = '<div class="tip__label">' + esc(p.label || '') + '</div>' +
    '<div class="tip__val">' + fmtCost(p.cost) + ' · ' + full(p.tokens) + ' tok</div>';
  tip.hidden = false;
  var x = cx + 14, y = cy + 14;
  if (x + tip.offsetWidth > window.innerWidth - 8) x = cx - tip.offsetWidth - 14;
  tip.style.left = x + 'px';
  tip.style.top = y + 'px';
}
function hideTip() { var t = document.getElementById('chart-tip'); if (t) t.hidden = true; }

function setRangeButtons() {
  var btns = document.querySelectorAll('#ov-range button');
  for (var i = 0; i < btns.length; i++) {
    btns[i].classList.toggle('is-on', btns[i].getAttribute('data-range') === state.chartRange);
  }
}

function roundRect(ctx, x, y, w, h, r) {
  if (h < 0) { y += h; h = -h; }
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function hexA(hex, a) {
  hex = hex.replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(function (x) { return x + x; }).join('');
  var n = parseInt(hex, 16);
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
}

// ---------- top-level render ----------
function render() {
  document.body.classList.toggle('office-mode', state.tab === 'office');
  var s = state.stats;
  if (!s) return;

  var rb = document.getElementById('rank-badge');
  if (rb) rb.textContent = s.rank || '';

  updateReady(s);
  renderApprovals(s);

  var at = document.getElementById('appr-toggle');
  if (at) {
    var on = !!(s.rules && s.rules.enabled);
    var allowAll = !!(s.rules && s.rules.allowAll);
    at.textContent = !on ? 'approvals off' : (allowAll ? 'allow-all · not asking' : 'approvals on');
    at.classList.toggle('is-on', on && !allowAll);
    at.classList.toggle('is-allowall', on && allowAll);
    at.title = (on && allowAll)
      ? 'Allow-all is on: Claude runs tools without asking. Click to resume asking.'
      : 'remote approvals: gate Claude\'s tools until you allow from here or your phone';
  }

  var sel = document.getElementById('plan-select');
  if (sel) {
    var has = [].some.call(sel.options, function (o) { return o.value === s.plan; });
    sel.value = has ? s.plan : 'unknown';
  }

  // waiting banner
  var wEl = document.getElementById('waiting');
  if (s.waiting) {
    wEl.hidden = false;
    document.getElementById('waiting-text').textContent = s.waiting.message || 'Claude is waiting for you';
    document.getElementById('waiting-meta').textContent =
      (s.waiting.project ? s.waiting.project + ' · ' : '') + relTime(s.waiting.time);
    document.title = '● Pulse - waiting for you';
  } else {
    wEl.hidden = true;
    document.title = 'Pulse for Claude Code';
  }

  var tab = state.tab;
  if (tab === 'overview') renderOverview();
  else if (tab === 'office') renderOffice();
  else if (tab === 'sessions') renderSessions();
  else if (tab === 'usage') renderUsage();
  else if (tab === 'limits') renderLimits();
  else if (tab === 'activity') renderActivity();

  // live + footer
  var stale = Date.now() - s.generatedAt > 8000 || !state.connected;
  document.getElementById('live-dot').classList.toggle('is-stale', stale);
  document.getElementById('foot-status').textContent =
    (state.connected ? 'live' : 'polling') + ' · updated ' + relTime(s.generatedAt);
}

// ---------- tabs ----------
document.getElementById('tabs').addEventListener('click', function (e) {
  var btn = e.target.closest('.tab');
  if (!btn) return;
  state.tab = btn.getAttribute('data-tab');
  document.querySelectorAll('.tab').forEach(function (t) { t.classList.toggle('is-active', t === btn); });
  document.querySelectorAll('.panel').forEach(function (p) {
    p.classList.toggle('is-active', p.id === 'panel-' + state.tab);
  });
  render();
});

// brand click returns to Overview (handy escape from immersive office)
var brandEl = document.querySelector('.brand');
if (brandEl) {
  brandEl.style.cursor = 'pointer';
  brandEl.addEventListener('click', function () {
    state.tab = 'overview';
    document.querySelectorAll('.tab').forEach(function (t) { t.classList.toggle('is-active', t.getAttribute('data-tab') === 'overview'); });
    document.querySelectorAll('.panel').forEach(function (p) { p.classList.toggle('is-active', p.id === 'panel-overview'); });
    render();
  });
}

// ---------- search across all sessions ----------
var searchTimer;
var searchEl = document.getElementById('sessions-search');
var projEl = document.getElementById('search-project');
if (searchEl) {
  searchEl.addEventListener('input', function () {
    clearTimeout(searchTimer);
    var q = searchEl.value.trim();
    searchTimer = setTimeout(function () { runSearch(q); }, 250);
  });
}
if (projEl) projEl.addEventListener('change', function () { renderSearch(); });

function hl(text, q) {
  var et = esc(text);
  if (!q) return et;
  try {
    var re = new RegExp('(' + esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig');
    return et.replace(re, '<mark>$1</mark>');
  } catch (e) { return et; }
}
function renderSearch() {
  var box = document.getElementById('search-results');
  if (!box) return;
  var q = state.searchQuery || '';
  var sel = projEl ? projEl.value : '';
  var list = (state.searchResults || []).filter(function (x) { return !sel || x.project === sel; });
  var rows = list.map(function (x) {
    var snips = (x.snippets || []).map(function (sn) {
      return '<div class="sr__snip"><span class="sr__who">' + esc(sn.role === 'user' ? 'you' : 'claude') + '</span> ' + hl(sn.text, q) + '</div>';
    }).join('');
    return '<div class="sr trow--link" data-sid="' + esc(x.sid) + '">' +
      '<div class="sr__top"><span class="sr__title">' + hl(x.title || x.sid, q) + ' <small>' + esc(x.project) + (x.lastT ? ' · ' + relTime(x.lastT) : '') + '</small></span>' +
      '<span class="sr__count">' + x.count + '×</span></div>' + snips + '</div>';
  }).join('');
  box.innerHTML = rows || '<div class="empty">nothing found for "' + esc(q) + '"</div>';
}
function runSearch(q) {
  var table = document.getElementById('sessions-table');
  var box = document.getElementById('search-results');
  if (!box) return;
  if (!q || q.length < 2) {
    box.hidden = true; box.innerHTML = ''; if (table) table.hidden = false;
    if (projEl) { projEl.hidden = true; }
    state.searchResults = null;
    return;
  }
  if (table) table.hidden = true;
  box.hidden = false;
  box.innerHTML = '<div class="empty">searching…</div>';
  fetch('/api/search?q=' + encodeURIComponent(q)).then(function (r) { return r.json(); }).then(function (d) {
    state.searchResults = d.results || [];
    state.searchQuery = q;
    // populate the project filter from the results
    if (projEl) {
      var projects = [];
      state.searchResults.forEach(function (x) { if (x.project && projects.indexOf(x.project) === -1) projects.push(x.project); });
      if (projects.length > 1) {
        projEl.hidden = false;
        projEl.innerHTML = '<option value="">all projects</option>' + projects.map(function (p) { return '<option value="' + esc(p) + '">' + esc(p) + '</option>'; }).join('');
      } else { projEl.hidden = true; }
    }
    renderSearch();
  }).catch(function () { box.innerHTML = '<div class="empty">search failed</div>'; });
}

// ---------- remote approvals toggle ----------
document.getElementById('appr-toggle').addEventListener('click', function () {
  var r = (state.stats && state.stats.rules) || {};
  // if allow-all is on, one click resumes asking; otherwise toggle approvals
  var body = (r.enabled && r.allowAll) ? { allowAll: false, clearTools: true } : { enabled: !r.enabled };
  fetch('/api/rules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(function () { return fetch('/api/stats'); }).then(function (r) { return r.json(); }).then(applyStats).catch(function () {});
});

// ---------- fullscreen ----------
document.getElementById('fs-toggle').addEventListener('click', function () {
  try {
    if (!document.fullscreenElement) {
      var el = document.documentElement;
      (el.requestFullscreen || el.webkitRequestFullscreen || function () {}).call(el);
    } else {
      (document.exitFullscreen || document.webkitExitFullscreen || function () {}).call(document);
    }
  } catch (e) {}
});

// ---------- theme ----------
document.getElementById('theme-toggle').addEventListener('click', function () {
  var cur = document.documentElement.getAttribute('data-theme');
  var next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('pulse-theme', next); } catch (e) {}
  render();
});

// click any token number to switch all numbers between short and exact
// (but not inside a focusable card, where the click means "focus this metric")
document.addEventListener('click', function (e) {
  if (e.target.closest('.num') && !e.target.closest('[data-focus]')) {
    state.exactNums = !state.exactNums; render(); if (state.tab === 'session') renderSession();
  }
});

// ---------- focus a single metric (counter centered, rest blurred) ----------
function openFocus(label, tok, cost) {
  document.getElementById('focus-label').textContent = label;
  document.getElementById('focus-value').textContent = full(tok);
  document.getElementById('focus-sub').textContent = fmtTokens(tok) + ' tokens · ' + fmtCost(cost) + ' equiv';
  document.getElementById('focus').hidden = false;
}
function closeFocus() { document.getElementById('focus').hidden = true; }

document.addEventListener('click', function (e) {
  var f = e.target.closest('[data-focus]');
  if (f) openFocus(f.getAttribute('data-flabel'), +f.getAttribute('data-ftok'), +f.getAttribute('data-fcost'));
});
document.getElementById('focus').addEventListener('click', closeFocus);
document.getElementById('done-overlay').addEventListener('click', hideDoneOverlay);
document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeFocus(); });

// ---------- panels & session detail ----------
function showPanel(id) {
  document.querySelectorAll('.panel').forEach(function (p) { p.classList.toggle('is-active', p.id === id); });
  document.querySelectorAll('.tab').forEach(function (t) { t.classList.toggle('is-active', 'panel-' + t.getAttribute('data-tab') === id); });
  document.body.classList.toggle('office-mode', id === 'panel-office');
}

function openSession(sid) {
  fetch('/api/session?sid=' + encodeURIComponent(sid))
    .then(function (r) { return r.json(); })
    .then(function (d) { state.session = d; state.sessionSid = sid; state.tab = 'session'; showPanel('panel-session'); renderSession(); window.scrollTo(0, 0); })
    .catch(function () {});
}

function renderSession() {
  var d = state.session;
  if (!d) return;
  var m = d.meta;
  var lastTurn = d.turns[d.turns.length - 1];
  var head =
    '<div class="card">' +
      '<div class="sdetail__title">' + esc(m.title || '(untitled session)') + '</div>' +
      '<div class="act__row">' +
        '<span class="chip chip--accent">' + esc(m.project || '') + '</span>' +
        '<span class="chip">' + esc(m.model || '') + '</span>' +
        '<span class="chip">' + d.turns.length + ' requests</span>' +
        (lastTurn ? '<span class="chip">context ' + numSpan(lastTurn.context) + '</span>' : '') +
        '<a class="chip chip--accent" style="text-decoration:none" target="_blank" rel="noopener" href="/transcript?sid=' + encodeURIComponent(state.sessionSid || '') + '">open transcript</a>' +
        '<a class="chip chip--accent" style="text-decoration:none" href="/api/export?sid=' + encodeURIComponent(state.sessionSid || '') + '&dl=1">download .md</a>' +
        '<button class="chip chip--accent resume-btn" style="border:0;cursor:pointer">copy resume cmd</button>' +
      '</div>' +
      '<div class="card__head" style="margin-top:18px"><span class="card__title">Usage growth per request</span>' +
        '<span class="card__hint">cumulative ' + state.chartMetric + '</span></div>' +
      '<canvas id="session-growth" class="chart" height="140"></canvas>' +
    '</div>';

  var turns = d.turns.slice().reverse().map(function (t) {
    var actions = t.actions.map(function (a) {
      return '<span class="saction"><span class="ftag">' + esc(a.name) + '</span>' +
        (a.hint ? '<span class="saction__hint">' + esc(a.hint) + '</span>' : '') + '</span>';
    }).join('');
    return '<div class="turn">' +
      '<div class="turn__head"><span class="turn__idx">#' + t.index + '</span>' +
        '<span class="turn__meta">' + clock(t.t) + ' · ' + numSpan(t.tokens) + ' tokens · ' + fmtCost(t.cost) + '</span></div>' +
      (t.prompt ? '<div class="turn__prompt">' + esc(t.prompt) + '</div>' : '') +
      (actions ? '<div class="turn__actions">' + actions + '</div>' : '') +
      (t.text ? '<div class="turn__text">' + esc(t.text) + '</div>' : '') +
    '</div>';
  }).join('');

  document.getElementById('session-detail').innerHTML = head + '<div class="turns">' + turns + '</div>';
  drawGrowth(document.getElementById('session-growth'), d.turns);
}

function drawGrowth(canvas, turns) {
  if (!canvas) return;
  var c = setupCanvas(canvas);
  var ctx = c.ctx, w = c.w, h = c.h, pad = 8;
  ctx.clearRect(0, 0, w, h);
  var key = state.chartMetric === 'cost' ? 'cumCost' : 'cumTokens';
  var vals = turns.map(function (t) { return t[key] || 0; });
  if (!vals.length) return;
  var max = Math.max.apply(null, vals.concat([1]));
  var n = vals.length;
  var accent = cssVar('--accent') || '#d97757';
  function x(i) { return pad + (n === 1 ? 0 : (i / (n - 1)) * (w - pad * 2)); }
  function y(v) { return h - pad - (v / max) * (h - pad * 2); }
  ctx.beginPath(); ctx.moveTo(x(0), h - pad);
  for (var i = 0; i < n; i++) ctx.lineTo(x(i), y(vals[i]));
  ctx.lineTo(x(n - 1), h - pad); ctx.closePath();
  ctx.fillStyle = hexA(accent, 0.12); ctx.fill();
  ctx.beginPath();
  for (var j = 0; j < n; j++) { var px = x(j), py = y(vals[j]); j ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }
  ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
}

// copy the resume command for the open session
document.addEventListener('click', function (e) {
  var rb = e.target.closest('.resume-btn');
  if (!rb) return;
  e.stopPropagation();
  var cmd = 'claude --resume ' + (state.sessionSid || '');
  try { if (navigator.clipboard) navigator.clipboard.writeText(cmd); } catch (err) {}
  rb.textContent = 'copied!';
  setTimeout(function () { rb.textContent = 'copy resume cmd'; }, 1500);
});

// open a session from any linked row (but not when toggling a number)
document.addEventListener('click', function (e) {
  if (e.target.closest('.resume-btn')) return;
  if (e.target.closest('.num')) return;
  var row = e.target.closest('[data-sid]');
  if (row) openSession(row.getAttribute('data-sid'));
});

document.getElementById('session-back').addEventListener('click', function () {
  state.tab = 'sessions'; state.session = null; showPanel('panel-sessions'); render();
});

// plan selector -> save to ~/.claude-pulse.json
document.getElementById('plan-select').addEventListener('change', function (e) {
  var plan = e.target.value;
  fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan: plan }) })
    .then(function (r) { return r.json(); })
    .then(function () { return fetch('/api/stats'); })
    .then(function (r) { return r.json(); })
    .then(applyStats)
    .catch(function () {});
});

// office vibe selector (office | garage)
try { state.vibe = localStorage.getItem('pulse-vibe') || 'office'; } catch (e) { state.vibe = 'office'; }
var vibeSeg = document.getElementById('vibe-seg');
if (vibeSeg) vibeSeg.addEventListener('click', function (e) {
  var b = e.target.closest('button[data-vibe]');
  if (!b) return;
  state.vibe = b.getAttribute('data-vibe');
  try { localStorage.setItem('pulse-vibe', state.vibe); } catch (e2) {}
  renderOffice();
});

// chart period selector
var rangeEl = document.getElementById('ov-range');
if (rangeEl) rangeEl.addEventListener('click', function (e) {
  var b = e.target.closest('button[data-range]');
  if (!b || !state.stats) return;
  state.chartRange = b.getAttribute('data-range');
  renderOverview();
});

// chart metric toggle (cost is default because token counts are very spiky)
document.getElementById('metric-toggle').addEventListener('click', function () {
  state.chartMetric = state.chartMetric === 'cost' ? 'tokens' : 'cost';
  document.getElementById('metric-toggle').textContent = state.chartMetric === 'cost' ? '$' : 'T';
  if (state.tab === 'session') renderSession(); else render();
});

// redraw charts on resize
var rt;
window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(function () { render(); if (state.tab === 'session') renderSession(); }, 150); });

// ---------- data: SSE with polling fallback ----------
function applyStats(data) { state.stats = data; render(); }

function startPolling() {
  function tick() {
    fetch('/api/stats').then(function (r) { return r.json(); })
      .then(function (d) { state.connected = false; applyStats(d); })
      .catch(function () {});
  }
  tick();
  setInterval(tick, 3000);
}

function connect() {
  if (!window.EventSource) { startPolling(); return; }
  var es = new EventSource('/api/events');
  es.addEventListener('stats', function (e) {
    state.connected = true;
    try { applyStats(JSON.parse(e.data)); } catch (err) {}
  });
  es.onerror = function () {
    state.connected = false;
    document.getElementById('live-dot').classList.add('is-stale');
  };
}

connect();
