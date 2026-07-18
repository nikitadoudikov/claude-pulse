'use strict';

// ---------- state ----------
function agentName() { return state.sourceFilter === 'codex' ? 'Codex' : 'Claude'; }
function statsUrl() {
  return '/api/stats' + (state.sourceFilter ? '?source=' + state.sourceFilter : '');
}
function fetchStats() { return fetch(statsUrl()); }

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
  if (typeof ms === 'string') ms = Date.parse(ms); // ISO strings must not become "NaNd ago"
  if (!ms || !isFinite(ms)) return '';
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
  renderPhoneCard(s);

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
  var modes = s.sessionModes || {};
  var rows = list.map(function (x) {
    var auto = modes[x.sid] === 'auto';
    return '<div class="ctxrow ctxrow--link" data-sid="' + esc(x.sid) + '">' +
      '<div class="ctxrow__top">' +
        '<span class="ctxrow__name"><span class="dot is-on"></span>' + esc(x.title) + ' <small>' + esc(x.project) + '</small></span>' +
        '<span class="ctxrow__side">' +
          '<button class="mode-pill' + (auto ? ' is-on' : '') + '" data-mode-sid="' + esc(x.sid) + '" ' +
            'title="auto mode: Pulse answers every permission prompt for this session with Allow. Use for long unattended runs.">' +
            (auto ? 'auto ✓' : 'auto') + '</button>' +
          '<span class="ctxrow__val">' + numSpan(x.contextUsed) + ' / ' + fmtTokens(x.contextLimit) + ' · ' + x.contextPercent + '%</span>' +
        '</span>' +
      '</div>' +
      barHtml(x.contextPercent, barClass(x.contextPercent)) +
    '</div>';
  }).join('');
  el.innerHTML = head + rows;
}

// toggle a session's auto mode from its pill
document.addEventListener('click', function (e) {
  var mp = e.target.closest('.mode-pill');
  if (!mp) return;
  e.stopPropagation();
  var sid = mp.getAttribute('data-mode-sid');
  var cur = (state.stats && state.stats.sessionModes) || {};
  var next = cur[sid] === 'auto' ? 'off' : 'auto';
  if (next === 'auto' && !window.confirm('Auto mode: Pulse will answer every permission prompt in this session with Allow, including shell commands. Turn on?')) return;
  fetch('/api/rules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sid: sid, mode: next }) })
    .then(function () { return fetchStats(); }).then(function (r) { return r.json(); }).then(applyStats).catch(function () {});
});

// ---------- sessions ----------
function visibleSessions(s) {
  var list = s.sessions || [];
  if (!state.showObservers) list = list.filter(function (x) { return !x.observer; });
  return list;
}

function renderSessionJump(list) {
  var sel = document.getElementById('sessions-jump');
  if (!sel) return;
  var sorted = list.slice().sort(function (a, b) {
    return (a.title + a.project).toLowerCase().localeCompare((b.title + b.project).toLowerCase());
  });
  var opts = '<option value="">jump to a session…</option>' + sorted.map(function (x) {
    return '<option value="' + esc(x.sid) + '">' + esc(x.title.slice(0, 60)) + ' — ' + esc(x.project) + '</option>';
  }).join('');
  if (sel.getAttribute('data-n') !== String(sorted.length)) { // don't clobber an open dropdown
    sel.innerHTML = opts;
    sel.setAttribute('data-n', String(sorted.length));
  }
}

function renderSessions() {
  var s = state.stats;
  var list = visibleSessions(s);
  var hiddenN = (s.sessions || []).length - list.length;
  document.getElementById('sessions-count').textContent =
    s.totals.sessions + ' total' + (hiddenN && !state.showObservers ? ' · ' + hiddenN + ' observer hidden' : '');
  var ob = document.getElementById('sessions-observers');
  if (ob) {
    ob.parentElement.hidden = !(s.sessions || []).some(function (x) { return x.observer; });
    ob.checked = !!state.showObservers;
  }
  renderSessionJump(list);
  var queued = {};
  (s.schedule || []).forEach(function (it) { if (it.status === 'pending') queued[it.sid] = 1; });
  var rows = list.map(function (x) {
    return '<div class="trow trow--link" data-sid="' + esc(x.sid) + '">' +
      '<span class="dot ' + (x.active ? 'is-on' : '') + '"></span>' +
      '<span class="trow__title">' + esc(x.title) + (queued[x.sid] ? ' <span class="chip chip--sched" title="a scheduled message is queued">⏰</span>' : '') + ' <small>' + esc(x.project) + '</small>' + (x.host ? ' <span class="chip chip--host" title="from an extra session root">' + esc(x.host) + '</span>' : '') + '</span>' +
      '<span class="trow__model">' + (x.source === 'codex' ? '<span class="chip chip--codex">Codex</span> ' : '') + '<span class="chip">' + esc(x.model) + '</span></span>' +
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
    // a real ceiling learned from your last limit hit beats the all-time peak guess (5h only)
    var capVal = r.budget != null ? r.budget : ((r.fk === 'fiveHour' && s.limitCeiling) ? s.limitCeiling : null);
    var denom = capVal != null ? capVal : peaks[peakKey];
    var pct = denom ? Math.round(used / denom * 100) : 0;
    var rt = resetText(s, r.fk);
    var reset = rt ? '<div class="limitrow__reset">' + rt + '</div>' : '';
    // burn rate + how long until the wall, on the limiting 5h window
    var burn = '';
    if (r.fk === 'fiveHour') {
      var rate = (s.windows.hour && s.windows.hour.cost) || 0; // cost in the last hour ~ $/hour
      if (rate > 0.01 && denom) {
        var remaining = denom - used;
        var label = r.budget != null ? 'your 5h budget' : (s.limitCeiling ? 'your real limit' : 'your usual 5h peak');
        burn = remaining > 0
          ? '<div class="limitrow__burn">burning ~' + fmtCost(rate) + '/hr · ~' + dur(remaining / rate * 3600000) + ' to ' + label + '</div>'
          : '<div class="limitrow__burn">burning ~' + fmtCost(rate) + '/hr · past ' + label + '</div>';
      }
    }
    var attrs = ' data-focus="1" data-flabel="' + r.name + '" data-fcost="' + used + '" data-ftok="' + r.w.tokens + '"';
    var right = capVal != null
      ? '<b>' + pct + '%</b> · ' + fmtCost(used) + ' / ' + fmtCost(capVal)
      : '<b>' + pct + '%</b> · ' + fmtCost(used);
    return '<div class="limitrow"' + attrs + '><div class="limitrow__top"><span class="limitrow__name">' + r.name + '</span>' +
      '<span class="limitrow__val">' + right + '</span></div>' +
      barHtml(Math.min(100, pct), barClass(pct)) + reset + burn + '</div>';
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
// render the tool call the way Claude Code itself shows it: the command in a
// code block, edits as a mini-diff, the file path underneath
function apprBody(p) {
  var d = p.detail || null;
  if (!d) return p.summary ? '<div class="appr__sum">' + esc(p.summary) + '</div>' : '';
  var parts = [];
  if (d.description) parts.push('<div class="appr__desc">' + esc(d.description) + '</div>');
  if (d.command) parts.push('<pre class="appr__code">' + esc(d.command) + '</pre>');
  if (d.oldStr != null || d.newStr != null) {
    parts.push('<div class="appr__diff">' +
      (d.oldStr ? '<pre class="appr__code appr__code--del">' + esc(d.oldStr) + '</pre>' : '') +
      (d.newStr ? '<pre class="appr__code appr__code--add">' + esc(d.newStr) + '</pre>' : '') +
      '</div>');
  } else if (d.preview) {
    parts.push('<pre class="appr__code">' + esc(d.preview) + '</pre>');
  }
  if (d.file) parts.push('<div class="appr__file">' + esc(d.file) + '</div>');
  if (d.url) parts.push('<div class="appr__file">' + esc(d.url) + '</div>');
  if (!parts.length && p.summary) parts.push('<div class="appr__sum">' + esc(p.summary) + '</div>');
  return parts.join('');
}

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
        '<div class="appr__head">Claude wants to use <span class="appr__tool">' + esc(p.tool) + '</span>' +
        (p.project ? ' in <span class="appr__proj">' + esc(p.project) + '</span>' : '') +
        '<span class="appr__time">' + relTime(p.time) + '</span></div>' +
        apprBody(p) +
      '</div>' +
      '<div class="appr__btns">' +
        '<button class="abtn abtn--allow" data-id="' + esc(p.id) + '" data-dec="allow" data-scope="once">Allow</button>' +
        '<button class="abtn abtn--tool" data-id="' + esc(p.id) + '" data-dec="allow" data-scope="tool" title="always allow this tool">Always ' + esc(p.tool) + '</button>' +
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
  }).then(function () { return fetchStats(); }).then(function (r) { return r.json(); }).then(applyStats).catch(function () {});
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
// custom sounds (generated via `claude-pulse gen-sounds`): each has one job.
// A missing file falls back to the built-in synth tone.
function playCustom(name) {
  var have = state.stats && state.stats.sounds;
  if (!have || have.indexOf(name) === -1) return false;
  try { new Audio('/sounds/' + name).play().catch(function () {}); return true; } catch (e) { return false; }
}
function playAttention() { if (playCustom('attention')) return; tone(660, 0, 0.16); tone(880, 0.16, 0.2); }
function playDone() { if (playCustom('done')) return; tone(523, 0, 0.14); tone(659, 0.13, 0.14); tone(784, 0.26, 0.26); }
function playError() { if (playCustom('error')) return; tone(220, 0, 0.18); tone(165, 0.14, 0.26); }

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

// turn the latest tool call into a readable "what the agent is doing" label
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

var VIBE_LABEL = { office: 'Office', garage: 'Garage', courchevel: 'Courchevel', paris: 'Paris', saturn: 'Saturn', earth: 'Earth' };
var STEAM_POS = {
  office: { left: '60%', top: '63%' }, garage: { left: '57%', top: '66%' },
  courchevel: { left: '58%', top: '70%' }, paris: { left: '60%', top: '72%' },
  saturn: { left: '66%', top: '71%' }, earth: { left: '64%', top: '71%' },
};
// vibes available per mode (the office image sets)
var MODE_VIBES = { claude: ['office', 'garage', 'courchevel', 'paris'], codex: ['saturn', 'earth'] };

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
  var mode = state.mode || 'claude';
  var vibe = state.vibe || (mode === 'codex' ? 'saturn' : 'office');
  if (MODE_VIBES[mode].indexOf(vibe) === -1) vibe = MODE_VIBES[mode][0]; // keep vibe valid for the mode
  var atDesk = (ns === 'working');
  var src = 'assets/' + (mode === 'codex' ? 'Codex' : 'Claude') + VIBE_LABEL[vibe] + (atDesk ? 'Work' : '') + '.png';
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
    subEl.textContent = agentName() + ' is resting';
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
function renderLimitBanner(s) {
  var el = document.getElementById('limit-banner');
  if (!el) return;
  var h = s && s.limitHit;
  if (!h || !h.resetsAt || h.resetsAt <= Date.now()) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML =
    '<span class="limit-banner__dot"></span>' +
    '<span class="limit-banner__text">Usage limit reached</span>' +
    '<span class="limit-banner__meta">resets at ' + esc(h.resetText) + ' · in ' + dur(h.resetsAt - Date.now()) + '</span>';
}

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
    document.getElementById('waiting-text').textContent = s.waiting.message || (agentName() + ' is waiting for you');
    document.getElementById('waiting-meta').textContent =
      (s.waiting.project ? s.waiting.project + ' · ' : '') + relTime(s.waiting.time);
    document.title = '● Pulse - waiting for you';
  } else {
    wEl.hidden = true;
    document.title = 'Pulse for Claude Code';
  }

  renderLimitBanner(s);

  var tab = state.tab;
  if (tab === 'overview') renderOverview();
  else if (tab === 'office') renderOffice();
  else if (tab === 'sessions') renderSessions();
  else if (tab === 'usage') renderUsage();
  else if (tab === 'limits') renderLimits();
  else if (tab === 'activity') renderActivity();
  else if (tab === 'profile') renderProfile();

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

// ---------- connect your phone ----------
function renderPhoneCard(s) {
  var el = document.getElementById('ov-phone');
  if (!el) return;
  var topic = (s && s.ntfyTopic) || '';
  el.hidden = false;
  var key = topic || 'none';
  if (el.getAttribute('data-topic') === key) return; // already rendered, don't clobber status
  el.setAttribute('data-topic', key);
  if (!topic) {
    el.innerHTML =
      '<div class="card__head"><span class="card__title">Approve from your phone</span>' +
        '<span class="card__hint">not set up</span></div>' +
      '<p class="note" style="margin:6px 0 12px">Get a push with Allow / Deny when Claude needs you, even away from the keyboard. One tap to start:</p>' +
      '<div class="phone-actions"><button class="phone-gen">Generate my topic</button>' +
        '<span class="phone-msg" id="phone-msg"></span></div>';
    return;
  }
  el.innerHTML =
    '<div class="card__head"><span class="card__title">Approve from your phone</span>' +
      '<span class="card__hint">set up once</span></div>' +
    '<ol class="phone-steps">' +
      '<li>Install the free <a href="https://ntfy.sh" target="_blank" rel="noopener">ntfy</a> app on your phone.</li>' +
      '<li>In ntfy, subscribe to this topic: <code class="phone-topic">' + esc(topic) + '</code> ' +
        '<button class="chip chip--accent phone-copy" data-topic="' + esc(topic) + '" style="border:0;cursor:pointer">copy</button></li>' +
      '<li>Tap <b>Send test</b>, then on the push <b>expand it</b> (pull down / long-press) to see <b>Allow</b> / <b>Deny</b>.</li>' +
    '</ol>' +
    '<div class="phone-actions"><button class="phone-test">Send test notification</button>' +
      '<span class="phone-msg" id="phone-msg"></span></div>';
}

document.addEventListener('click', function (e) {
  var pg = e.target.closest('.phone-gen');
  if (pg) {
    var gmsg = document.getElementById('phone-msg');
    pg.disabled = true; if (gmsg) gmsg.textContent = 'generating…';
    fetch('/api/gen-topic', { method: 'POST' }).then(function (r) { return r.json(); }).then(function (d) {
      if (d && d.topic) {
        if (state.stats) state.stats.ntfyTopic = d.topic;
        var pel = document.getElementById('ov-phone'); if (pel) pel.setAttribute('data-topic', '');
        renderPhoneCard(state.stats);
      } else { pg.disabled = false; if (gmsg) gmsg.textContent = 'failed'; }
    }).catch(function () { pg.disabled = false; if (gmsg) gmsg.textContent = 'failed'; });
    return;
  }
  var cp = e.target.closest('.phone-copy');
  if (cp) {
    try { if (navigator.clipboard) navigator.clipboard.writeText(cp.getAttribute('data-topic') || ''); } catch (err) {}
    cp.textContent = 'copied!'; setTimeout(function () { cp.textContent = 'copy'; }, 1500);
    return;
  }
  var pt = e.target.closest('.phone-test');
  if (pt) {
    var msg = document.getElementById('phone-msg');
    pt.disabled = true; if (msg) msg.textContent = 'sending…';
    fetch('/api/test-push', { method: 'POST' }).then(function (r) { return r.json(); }).then(function (d) {
      pt.disabled = false;
      if (msg) msg.textContent = (d && d.ok) ? 'sent, check your phone (expand the push for the buttons)' : 'set ntfyTopic in ~/.claude-pulse.json first';
    }).catch(function () { pt.disabled = false; if (msg) msg.textContent = 'failed'; });
  }
});

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
  if (!state.showObservers) list = list.filter(function (x) { return !x.observer; });
  var rows = list.map(function (x) {
    var snips = (x.snippets || []).map(function (sn) {
      return '<div class="sr__snip"><span class="sr__who">' + esc(sn.role === 'user' ? 'you' : 'claude') + '</span> ' + hl(sn.text, q) + '</div>';
    }).join('');
    return '<div class="sr trow--link" data-sid="' + esc(x.sid) + '">' +
      '<div class="sr__top"><span class="sr__title">' + hl(x.title || x.sid, q) + ' <small>' + esc(x.project) + (x.lastT ? ' · ' + relTime(x.lastT) : '') + '</small>' + (x.host ? ' <span class="chip chip--host">' + esc(x.host) + '</span>' : '') + '</span>' +
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
    .then(function () { return fetchStats(); }).then(function (r) { return r.json(); }).then(applyStats).catch(function () {});
});

// ---------- notch from the dashboard ----------
// window.open on a user click is the one way that reliably produces a window
// in every browser. Spawning Chrome app-mode from the server looks nicer but
// silently does nothing when Chrome is already running (the second instance
// hands off and drops the --app flag) - that path stays CLI-only.
var notchBtn = document.getElementById('notch-open');
if (notchBtn) notchBtn.addEventListener('click', function () {
  // the native overlay floats above every app and Space; first run compiles
  // it (~10s), so show a busy state. Fallback: an in-browser popup.
  notchBtn.disabled = true;
  notchBtn.textContent = '…';
  var restore = function () { notchBtn.disabled = false; notchBtn.textContent = '▂'; };
  fetch('/api/notch-open', { method: 'POST' }).then(function (r) { return r.json(); }).then(function (d) {
    restore();
    if (d.action === 'closed') return; // toggle: second press closed the overlay
    if (!d.ok) {
      var left = Math.max(0, Math.round(((screen.width || 1440) - 470) / 2));
      window.open('/notch', 'pulse-notch',
        'popup=yes,width=470,height=190,top=0,left=' + left + ',menubar=no,toolbar=no,location=no,status=no');
    }
  }).catch(function () {
    restore();
    window.open('/notch', 'pulse-notch', 'popup=yes,width=470,height=190,top=0');
  });
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
        '<button class="chip chip--accent handoff-btn" style="border:0;cursor:pointer">copy handoff</button>' +
        '<button class="chip chip--accent sched-btn" style="border:0;cursor:pointer">schedule message</button>' +
        '<button class="chip chip--accent replay-btn" style="border:0;cursor:pointer">▶ replay</button>' +
      '</div>' +
      '<div class="replay" id="replay" hidden></div>' +
      schedHtml(state.sessionSid) +
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

// ---------- scheduled messages ("limit resets at 10:00 -> queue 'continue'") ----------
function schedHtml(sid) {
  var items = ((state.stats && state.stats.schedule) || []).filter(function (x) { return x.sid === sid; });
  var rows = items.map(function (it) {
    var when = new Date(it.at);
    var label = String(when.getHours()).padStart(2, '0') + ':' + String(when.getMinutes()).padStart(2, '0') +
      (when.toDateString() !== new Date().toDateString() ? ' ' + when.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '');
    var st = it.status === 'pending' ? '' : ' · ' + it.status;
    var extra = '';
    if (it.status === 'sent' && it.resultSid) {
      extra = '<button class="chip chip--accent sched__open" data-open-sid="' + esc(it.resultSid) + '" style="border:0;cursor:pointer">open result</button>';
    } else if (it.status === 'failed') {
      extra = (it.error ? '<span class="sched__err" title="' + esc(it.error) + '">' + esc(it.error.slice(0, 60)) + '</span>' : '') +
        '<button class="chip sched__retry" data-retry-id="' + esc(it.id) + '" style="border:0;cursor:pointer">retry now</button>';
    } else if (it.status === 'missed') {
      extra = '<span class="sched__err">missed — Mac was asleep or Pulse was down</span>' +
        '<button class="chip sched__retry" data-retry-id="' + esc(it.id) + '" style="border:0;cursor:pointer">send now</button>';
    }
    return '<div class="sched__item' + (it.status !== 'pending' ? ' is-done' : '') + '">' +
      '<span class="sched__when">⏰ ' + esc(label) + st + '</span>' +
      '<span class="sched__text">' + esc(it.text.slice(0, 120)) + '</span>' + extra +
      (it.status === 'pending' ? '<button class="sched__del" data-sched-id="' + esc(it.id) + '">✕</button>' : '') +
    '</div>';
  }).join('');
  return '<div class="sched" id="sched-box">' +
    '<div class="sched__form" id="sched-form" hidden>' +
      '<input type="time" id="sched-time" class="sched__inp" />' +
      '<input type="text" id="sched-text" class="sched__inp sched__inp--text" placeholder="continue where you left off" />' +
      '<button class="abtn abtn--allow" id="sched-queue">queue</button>' +
      '<span class="sched__hint">runs claude --resume headless at that time; a past time means tomorrow. Note: resuming replays the session\'s full context — on a long session that is a real chunk of your limit</span>' +
    '</div>' +
    (rows ? '<div class="sched__list">' + rows + '</div>' : '') +
  '</div>';
}

document.addEventListener('click', function (e) {
  var sb = e.target.closest('.sched-btn');
  if (sb) {
    e.stopPropagation();
    var f = document.getElementById('sched-form');
    if (f) {
      f.hidden = !f.hidden;
      if (!f.hidden) {
        var t = document.getElementById('sched-time');
        if (t && !t.value) {
          var d = new Date(Date.now() + 10 * 60000);
          t.value = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
        }
      }
    }
    return;
  }
  var q = e.target.closest('#sched-queue');
  if (q) {
    e.stopPropagation();
    var tv = (document.getElementById('sched-time') || {}).value || '';
    var tx = (document.getElementById('sched-text') || {}).value || '';
    if (!tv || !tx.trim()) { q.textContent = 'time + text needed'; setTimeout(function () { q.textContent = 'queue'; }, 1500); return; }
    var hm = tv.split(':');
    var at = new Date(); at.setHours(+hm[0], +hm[1], 0, 0);
    if (at.getTime() < Date.now() - 30000) at.setDate(at.getDate() + 1); // past time = tomorrow
    fetch('/api/schedule', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sid: state.sessionSid, at: at.getTime(), text: tx.trim() }),
    }).then(function (r) { return r.json(); }).then(function () {
      return fetchStats();
    }).then(function (r) { return r.json(); }).then(function (d) {
      state.stats = d; renderSession();
    }).catch(function () {});
    return;
  }
  var op = e.target.closest('.sched__open');
  if (op) { e.stopPropagation(); openSession(op.getAttribute('data-open-sid')); return; }
  var rt2 = e.target.closest('.sched__retry');
  if (rt2) {
    e.stopPropagation();
    fetch('/api/schedule-now', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: rt2.getAttribute('data-retry-id') }),
    }).then(function () { return fetchStats(); }).then(function (r) { return r.json(); }).then(function (d) {
      state.stats = d; renderSession();
    }).catch(function () {});
    return;
  }
  var del = e.target.closest('.sched__del');
  if (del) {
    e.stopPropagation();
    fetch('/api/schedule-remove', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: del.getAttribute('data-sched-id') }),
    }).then(function () { return fetchStats(); }).then(function (r) { return r.json(); }).then(function (d) {
      state.stats = d; renderSession();
    }).catch(function () {});
  }
});

// ---------- session replay: drag the slider, watch the session unfold ----------
function replayFrame(i) {
  var d = state.session;
  if (!d || !d.turns.length) return;
  i = Math.max(0, Math.min(d.turns.length - 1, i));
  state.replayIdx = i;
  var t = d.turns[i];
  // every unique file touched up to this point in time (file tools only:
  // Bash hints are command fragments, not paths)
  var FILE_TOOLS = { Edit: 1, MultiEdit: 1, Write: 1, Read: 1, NotebookEdit: 1 };
  var seen = {}, files = [];
  for (var k = 0; k <= i; k++) {
    (d.turns[k].actions || []).forEach(function (a) {
      if (!FILE_TOOLS[a.name]) return;
      var h = a.hint || '';
      if (!h || h.indexOf('/') === -1) return;
      var short = h.split('/').pop();
      if (!seen[short]) { seen[short] = 1; files.push({ name: short, turn: k }); }
    });
  }
  var slider = document.getElementById('replay-slider');
  if (slider && +slider.value !== i) slider.value = i;
  var pct = d.turns.length > 1 ? Math.round(i / (d.turns.length - 1) * 100) : 100;
  document.getElementById('replay-pos').textContent =
    '#' + t.index + ' / ' + d.turns.length + ' · ' + clock(t.t) + ' · ' + fmtTokens(t.cumTokens) + ' tok · ' + fmtCost(t.cumCost);
  document.getElementById('replay-frame').innerHTML =
    barHtml(pct, 'is-ok') +
    (t.prompt ? '<div class="replay__prompt">' + esc(t.prompt.slice(0, 300)) + '</div>' : '') +
    ((t.actions || []).length
      ? '<div class="replay__acts">' + summarizeActions(t.actions) + '</div>'
      : '') +
    (t.text ? '<div class="replay__text">' + esc(t.text.slice(0, 260)) + '</div>' : '') +
    (files.length
      ? '<div class="replay__files"><span class="replay__fileslabel">files so far (' + files.length + ')</span>' +
        files.slice(-24).map(function (f) {
          return '<span class="chip' + (f.turn === i ? ' chip--accent' : '') + '">' + esc(f.name) + '</span>';
        }).join(' ') + '</div>'
      : '');
}
function stopReplayAuto() {
  if (state.replayTimer) { clearInterval(state.replayTimer); state.replayTimer = null; }
  var b = document.getElementById('replay-auto');
  if (b) b.textContent = '▶';
}
document.addEventListener('click', function (e) {
  var rb = e.target.closest('.replay-btn');
  if (rb) {
    e.stopPropagation();
    var box = document.getElementById('replay');
    if (!box) return;
    if (!box.hidden) { box.hidden = true; stopReplayAuto(); return; }
    var d = state.session;
    if (!d || !d.turns.length) return;
    box.hidden = false;
    box.innerHTML =
      '<div class="replay__bar">' +
        '<button class="replay__play" id="replay-auto" title="autoplay">▶</button>' +
        '<input type="range" id="replay-slider" min="0" max="' + (d.turns.length - 1) + '" value="0" step="1" />' +
        '<span class="replay__pos" id="replay-pos"></span>' +
      '</div>' +
      '<div id="replay-frame"></div>';
    replayFrame(0);
    document.getElementById('replay-slider').addEventListener('input', function () {
      stopReplayAuto();
      replayFrame(+this.value);
    });
    return;
  }
  var auto = e.target.closest('#replay-auto');
  if (auto) {
    e.stopPropagation();
    if (state.replayTimer) { stopReplayAuto(); return; }
    auto.textContent = '⏸';
    if (state.replayIdx >= ((state.session || {}).turns || []).length - 1) state.replayIdx = -1;
    state.replayTimer = setInterval(function () {
      var d = state.session;
      if (!d) return stopReplayAuto();
      if (state.replayIdx >= d.turns.length - 1) return stopReplayAuto();
      replayFrame((state.replayIdx || 0) + 1);
    }, 900);
  }
});

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

// copy a compact handoff brief to paste into a fresh session
document.addEventListener('click', function (e) {
  var hb = e.target.closest('.handoff-btn');
  if (!hb) return;
  e.stopPropagation();
  var d = state.session;
  if (!d) return;
  var m = d.meta || {};
  var turns = (d.turns || []).slice(-5);
  var lines = [];
  lines.push('Continue this work in a fresh session. Here is where we left off.');
  lines.push('');
  lines.push('Project: ' + (m.project || '?') + ' (' + (d.turns ? d.turns.length : 0) + ' turns so far)');
  if (m.title) lines.push('Topic: ' + m.title);
  lines.push('');
  lines.push('Recent context:');
  turns.forEach(function (t) {
    if (t.prompt) lines.push('- I asked: ' + t.prompt.replace(/\s+/g, ' ').slice(0, 220));
    if (t.text) lines.push('  Claude: ' + t.text.replace(/\s+/g, ' ').slice(0, 220));
  });
  lines.push('');
  lines.push('For the full history run: claude-pulse recover ' + (state.sessionSid || ''));
  lines.push('Pick up from here.');
  try { if (navigator.clipboard) navigator.clipboard.writeText(lines.join('\n')); } catch (err) {}
  hb.textContent = 'copied!';
  setTimeout(function () { hb.textContent = 'copy handoff'; }, 1500);
});

// open a session from any linked row (but not when clicking an inline control)
document.addEventListener('click', function (e) {
  if (e.target.closest('.resume-btn')) return;
  if (e.target.closest('.num')) return;
  if (e.target.closest('.mode-pill')) return;
  if (e.target.closest('.sched-btn') || e.target.closest('#sched-box')) return;
  if (e.target.closest('.replay-btn') || e.target.closest('#replay')) return;
  var row = e.target.closest('[data-sid]');
  if (row) {
    var dov = document.getElementById('dayov');
    if (dov && !dov.hidden) dov.hidden = true;
    openSession(row.getAttribute('data-sid'));
  }
});

document.getElementById('session-back').addEventListener('click', function () {
  state.tab = 'sessions'; state.session = null; showPanel('panel-sessions'); render();
});

// plan selector -> save to ~/.claude-pulse.json
document.getElementById('plan-select').addEventListener('change', function (e) {
  var plan = e.target.value;
  fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan: plan }) })
    .then(function (r) { return r.json(); })
    .then(function () { return fetchStats(); })
    .then(function (r) { return r.json(); })
    .then(applyStats)
    .catch(function () {});
});

// dashboard mode: claude (warm, original) or codex (mono, black & white),
// chosen on a glass entry screen, switchable later by clicking the logo.
function applyMode(m) {
  state.mode = m;
  state.sourceFilter = m === 'codex' ? 'codex' : 'claude';
  document.documentElement.setAttribute('data-mode', m);
  try { localStorage.setItem('pulse-mode', m); } catch (e) {}
  fetchStats().then(function (r) { return r.json(); }).then(applyStats).catch(function () {});
  if (MODE_VIBES[m].indexOf(state.vibe) === -1) {
    state.vibe = MODE_VIBES[m][0];
    try { localStorage.setItem('pulse-vibe', state.vibe); } catch (e) {}
  }
  setVibeButtons();
  if (state.stats) render();
}
(function () {
  var stored;
  try { stored = localStorage.getItem('pulse-mode'); } catch (e) {}
  state.mode = stored || 'claude';
  state.sourceFilter = state.mode === 'codex' ? 'codex' : 'claude';
  document.documentElement.setAttribute('data-mode', state.mode);
  var pick = document.getElementById('mode-pick');
  if (pick) {
    if (!stored) pick.hidden = false; // first visit: ask which dashboard
    pick.addEventListener('click', function (e) {
      var c = e.target.closest('[data-pick]');
      if (!c) return;
      applyMode(c.getAttribute('data-pick'));
      pick.hidden = true;
    });
  }
  var brand = document.querySelector('.brand');
  if (brand) { brand.style.cursor = 'pointer'; brand.title = 'switch dashboard'; brand.addEventListener('click', function () { if (pick) pick.hidden = false; }); }
})();

// office vibe selector
try { state.vibe = localStorage.getItem('pulse-vibe') || (state.mode === 'codex' ? 'saturn' : 'office'); } catch (e) { state.vibe = 'office'; }
if (MODE_VIBES[state.mode] && MODE_VIBES[state.mode].indexOf(state.vibe) === -1) state.vibe = MODE_VIBES[state.mode][0];
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

// ---------- observer toggle + session jump dropdown ----------
try { state.showObservers = localStorage.getItem('pulse-observers') === '1'; } catch (e) { state.showObservers = false; }
var obEl = document.getElementById('sessions-observers');
if (obEl) obEl.addEventListener('change', function () {
  state.showObservers = obEl.checked;
  try { localStorage.setItem('pulse-observers', state.showObservers ? '1' : '0'); } catch (e) {}
  renderSessions();
  if (state.searchResults) renderSearch();
});
var jumpEl = document.getElementById('sessions-jump');
if (jumpEl) jumpEl.addEventListener('change', function () {
  if (jumpEl.value) { openSession(jumpEl.value); jumpEl.value = ''; }
});

// ---------- settings popover ----------
(function () {
  var panel = document.getElementById('settings');
  var openBtn = document.getElementById('settings-toggle');
  if (!panel || !openBtn) return;
  function syncSettings() {
    var s = state.stats || {};
    var prefs = s.prefs || {};
    var rules = s.rules || {};
    var m = {
      'set-desktop': prefs.desktopNotify !== false,
      'set-push-approval': prefs.ntfyPushApproval !== false,
      'set-push-notification': prefs.ntfyPushNotification !== false,
      'set-push-stop': prefs.ntfyPushStop !== false,
      'set-approvals': !!rules.enabled,
    };
    for (var id in m) { var el = document.getElementById(id); if (el) el.checked = m[id]; }
  }
  openBtn.addEventListener('click', function () { syncSettings(); panel.hidden = !panel.hidden; });
  document.getElementById('settings-close').addEventListener('click', function () { panel.hidden = true; });
  panel.addEventListener('click', function (e) { if (e.target === panel) panel.hidden = true; });
  var MAP = {
    'set-desktop': 'desktopNotify',
    'set-push-approval': 'ntfyPushApproval',
    'set-push-notification': 'ntfyPushNotification',
    'set-push-stop': 'ntfyPushStop',
  };
  panel.addEventListener('change', function (e) {
    var id = e.target && e.target.id;
    if (MAP[id]) {
      var body = {}; body[MAP[id]] = e.target.checked;
      fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then(function () { return fetchStats(); }).then(function (r) { return r.json(); }).then(applyStats).catch(function () {});
    } else if (id === 'set-approvals') {
      fetch('/api/rules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: e.target.checked }) })
        .then(function () { return fetchStats(); }).then(function (r) { return r.json(); }).then(applyStats).catch(function () {});
    }
  });
})();

// ---------- office music: paste a YouTube link, it plays in the corner ----------
function ytEmbed(url) {
  var s = String(url || '').trim();
  if (!s) return null;
  var id = null, list = null;
  var m;
  if ((m = s.match(/[?&]list=([\w-]+)/))) list = m[1];
  if ((m = s.match(/(?:youtu\.be\/|\/watch\?v=|[?&]v=|\/shorts\/|\/embed\/|\/live\/)([\w-]{6,})/))) id = m[1];
  else if (/^[\w-]{11}$/.test(s)) id = s;
  if (!id && list) return 'https://www.youtube-nocookie.com/embed/videoseries?list=' + encodeURIComponent(list) + '&autoplay=1';
  if (!id) return null;
  var src = 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(id) + '?autoplay=1';
  src += list ? '&list=' + encodeURIComponent(list) : '&loop=1&playlist=' + encodeURIComponent(id);
  return src;
}
// stations that explicitly allow embedding, for one-tap start (and as the
// escape hatch when a pasted video says "unavailable" = embed-blocked by owner)
var MUSIC_PRESETS = [
  { label: 'lofi', id: 'jfKfPfyJRdk' },
  { label: 'synthwave', id: '4xDzrJKXOOY' },
  { label: 'jazz', id: 'Dx5qFachd3A' },
];
(function () {
  var toggle = document.getElementById('music-toggle');
  if (!toggle) return;
  var panel = document.getElementById('music-panel');
  var frame = document.getElementById('music-frame');
  var urlEl = document.getElementById('music-url');
  var play = document.getElementById('music-play');
  var stop = document.getElementById('music-stop');
  var hint = document.getElementById('music-hint');
  try { urlEl.value = localStorage.getItem('pulse-music') || ''; } catch (e) {}
  toggle.addEventListener('click', function () { panel.hidden = !panel.hidden; });
  function startSrc(src) {
    frame.innerHTML = '<iframe width="320" height="180" src="' + src + '" title="music" frameborder="0" ' +
      'allow="autoplay; encrypted-media" allowfullscreen></iframe>';
    frame.hidden = false;
    stop.hidden = false;
    toggle.classList.add('is-on');
    if (hint) hint.textContent = 'says "unavailable"? that video blocks embedding — use a preset or another link';
  }
  function start() {
    var src = ytEmbed(urlEl.value);
    if (!src) { urlEl.value = ''; urlEl.placeholder = 'that does not look like a YouTube link'; return; }
    try { localStorage.setItem('pulse-music', urlEl.value.trim()); } catch (e) {}
    startSrc(src);
  }
  play.addEventListener('click', start);
  urlEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') start(); });
  stop.addEventListener('click', function () {
    frame.innerHTML = ''; frame.hidden = true; stop.hidden = true;
    toggle.classList.remove('is-on');
    if (hint) hint.textContent = '';
  });
  document.addEventListener('click', function (e) {
    var pr = e.target.closest('.music__preset');
    if (!pr) return;
    startSrc('https://www.youtube-nocookie.com/embed/' + pr.getAttribute('data-yt') + '?autoplay=1');
  });
  var presets = document.getElementById('music-presets');
  if (presets) presets.innerHTML = MUSIC_PRESETS.map(function (p) {
    return '<button class="music__preset" data-yt="' + p.id + '">' + p.label + '</button>';
  }).join('');
})();

// ---------- profile: rank, records, achievements (all local) ----------
var RANK_TIERS = [
  { at: 0, name: 'Lurker' }, { at: 1e6, name: 'Coder' }, { at: 1e7, name: 'Vibe Coder' },
  { at: 1e8, name: 'Power Coder' }, { at: 5e8, name: 'God Coder' }, { at: 2e9, name: 'Genius' },
];
function streakDays(daily) {
  var n = 0;
  for (var i = daily.length - 1; i >= 0; i--) {
    if (daily[i].tokens > 0) n++;
    else if (i === daily.length - 1) continue; // today can still be empty
    else break;
  }
  return n;
}
function computeAchievements(s) {
  var total = s.windows.total.tokens || 0;
  var daily = s.daily || [];
  var maxDayTok = 0, maxDayCost = 0;
  daily.forEach(function (d) { if (d.tokens > maxDayTok) maxDayTok = d.tokens; if (d.cost > maxDayCost) maxDayCost = d.cost; });
  var streak = streakDays(daily);
  var toolCalls = 0, toolMax = 0;
  Object.keys(s.byTool || {}).forEach(function (k) { toolCalls += s.byTool[k].count; if (s.byTool[k].count > toolMax) toolMax = s.byTool[k].count; });
  var models = Object.keys(s.byModel || {}).length;
  var sess = s.sessions || [];
  var hasCodex = sess.some(function (x) { return x.source === 'codex'; });
  var hasClaude = sess.some(function (x) { return x.source !== 'codex'; });
  var marathon = sess.some(function (x) { return x.firstT && x.lastT && (x.lastT - x.firstT) > 8 * 3600 * 1000; });
  var deep = sess.some(function (x) { return (x.userMsgs || 0) >= 100; });
  var night = (s.hourly || []).some(function (h) { return h.tokens > 0 && new Date(h.t).getHours() < 6; });
  return [
    { icon: '🔥', name: 'First Pulse', desc: 'any usage at all', ok: total > 0 },
    { icon: '💬', name: 'Coder', desc: '1M+ tokens all-time', ok: total >= 1e6 },
    { icon: '⚡', name: 'Vibe Coder', desc: '10M+ tokens all-time', ok: total >= 1e7 },
    { icon: '🚀', name: 'Power Coder', desc: '100M+ tokens all-time', ok: total >= 1e8 },
    { icon: '👑', name: 'God Coder', desc: '500M+ tokens all-time', ok: total >= 5e8 },
    { icon: '🌌', name: 'Genius', desc: '2B+ tokens all-time', ok: total >= 2e9 },
    { icon: '📅', name: 'Streak ×3', desc: '3 days in a row', ok: streak >= 3 },
    { icon: '🗓️', name: 'Streak ×7', desc: 'a full week, daily', ok: streak >= 7 },
    { icon: '🏆', name: 'Streak ×14', desc: 'two weeks, daily', ok: streak >= 14 },
    { icon: '🔨', name: 'Tool Master', desc: '1,000+ tool calls', ok: toolCalls >= 1000 },
    { icon: '🪚', name: 'Heavy Machinery', desc: '10,000+ tool calls', ok: toolCalls >= 10000 },
    { icon: '🌗', name: 'Night Shift', desc: 'tokens burned after midnight', ok: night },
    { icon: '🏃', name: 'Marathon', desc: 'one session, 8+ hours', ok: marathon },
    { icon: '🧠', name: 'Deep Focus', desc: '100+ prompts in one session', ok: deep },
    { icon: '🎭', name: 'Polyglot', desc: '3+ models used', ok: models >= 3 },
    { icon: '🤝', name: 'Double Agent', desc: 'Claude and Codex in one dashboard', ok: hasCodex && hasClaude },
    { icon: '💸', name: 'Big Spender', desc: '$100+ API-equivalent in a day', ok: maxDayCost >= 100 },
    { icon: '🌋', name: 'Volcano Day', desc: '100M+ tokens in a day', ok: maxDayTok >= 1e8 },
  ];
}
function renderProfile() {
  var s = state.stats;
  if (!s) return;
  var total = s.windows.total.tokens || 0;
  var tierIdx = 0;
  for (var i = 0; i < RANK_TIERS.length; i++) if (total >= RANK_TIERS[i].at) tierIdx = i;
  var next = RANK_TIERS[tierIdx + 1] || null;
  var progress = next ? Math.min(100, Math.round((total - RANK_TIERS[tierIdx].at) / (next.at - RANK_TIERS[tierIdx].at) * 100)) : 100;

  var topTool = '', topToolN = 0;
  Object.keys(s.byTool || {}).forEach(function (k) { if (s.byTool[k].count > topToolN) { topToolN = s.byTool[k].count; topTool = k; } });
  var topProj = '', topProjN = 0;
  Object.keys(s.byProject || {}).forEach(function (k) { if (k !== 'unknown' && s.byProject[k].tokens > topProjN) { topProjN = s.byProject[k].tokens; topProj = k; } });
  var daily = s.daily || [];
  var best = null;
  daily.forEach(function (d) { if (!best || d.tokens > best.tokens) best = d; });
  var streak = streakDays(daily);

  document.getElementById('profile-hero').innerHTML =
    '<div class="profile__rank">' + esc(s.rank || RANK_TIERS[tierIdx].name) + '</div>' +
    '<div class="profile__total">' + numSpan(total) + ' tokens all-time · ' + fmtCost(s.windows.total.cost) + ' API-equivalent</div>' +
    (next
      ? '<div class="profile__next">next rank: <b>' + esc(next.name) + '</b> at ' + fmtTokens(next.at) + '</div>' + barHtml(progress, 'is-ok')
      : '<div class="profile__next">maximum rank reached. touch grass?</div>') +
    '<div class="profile__like">' +
      (topProj ? 'most of your energy goes to <b>' + esc(topProj) + '</b>' : '') +
      (topTool ? (topProj ? ' · ' : '') + 'favourite move: <b>' + esc(topTool) + '</b> ×' + full(topToolN) : '') +
    '</div>' +
    '<button class="wrapped-btn" id="wrapped-open">✨ your week, wrapped</button>';

  renderHeatmap(s);

  var cards = [
    { label: 'Sessions', v: full(s.totals.sessions) },
    { label: 'Tool calls', v: full(Object.keys(s.byTool || {}).reduce(function (n, k) { return n + s.byTool[k].count; }, 0)) },
    { label: 'Current streak', v: streak + 'd' },
    { label: 'Best day', v: best ? fmtTokens(best.tokens) : '0' },
  ];
  document.getElementById('profile-stats').innerHTML = cards.map(function (c) {
    return '<div class="stat"><div class="stat__label">' + c.label + '</div><div class="stat__value">' + c.v + '</div></div>';
  }).join('');

  var ach = computeAchievements(s);
  var got = ach.filter(function (a) { return a.ok; }).length;
  document.getElementById('profile-achv-count').textContent = got + ' / ' + ach.length;
  document.getElementById('profile-achv').innerHTML = ach.map(function (a) {
    return '<div class="achv__item' + (a.ok ? ' is-got' : '') + '" title="' + esc(a.desc) + '">' +
      '<span class="achv__icon">' + a.icon + '</span>' +
      '<span class="achv__name">' + esc(a.name) + '</span>' +
      '<span class="achv__desc">' + esc(a.desc) + '</span>' +
    '</div>';
  }).join('');
}

// ---------- profile heatmap: GitHub-style, with month/weekday labels and paging ----------
var MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function heatGridHtml(daily) {
  var nz = daily.map(function (d) { return d.tokens; }).filter(function (v) { return v > 0; }).sort(function (a, b) { return a - b; });
  var q = function (p) { return nz.length ? nz[Math.min(nz.length - 1, Math.floor(nz.length * p))] : 1; };
  var t1 = q(0.25), t2 = q(0.5), t3 = q(0.75);
  function lvl(v) { return !v ? 0 : v <= t1 ? 1 : v <= t2 ? 2 : v <= t3 ? 3 : 4; }
  // columns are weeks; pad the front so columns start on Monday
  var first = daily.length ? new Date(daily[0].date + 'T12:00:00') : new Date();
  var pad = (first.getDay() + 6) % 7;
  var cells = [];
  for (var i = 0; i < pad; i++) cells.push(null);
  daily.forEach(function (d) { cells.push(d); });
  var weeks = [];
  for (var w = 0; w < cells.length; w += 7) weeks.push(cells.slice(w, w + 7));
  // a month label above the column that contains the 1st (GitHub-style)
  var months = weeks.map(function (col, wi) {
    for (var ci = 0; ci < col.length; ci++) {
      var d = col[ci];
      if (d && new Date(d.date + 'T12:00:00').getDate() === 1) return MONTHS_SHORT[new Date(d.date + 'T12:00:00').getMonth()];
      if (wi === 0 && d) { var m0 = new Date(d.date + 'T12:00:00'); if (m0.getDate() <= 7) return MONTHS_SHORT[m0.getMonth()]; }
    }
    return '';
  });
  var dayNames = ['Mon', '', 'Wed', '', 'Fri', '', ''];
  var monthRow = '<div class="heat__months">' + months.map(function (m) {
    return '<span>' + m + '</span>';
  }).join('') + '</div>';
  var grid = '<div class="heat__cols">' + weeks.map(function (col) {
    while (col.length < 7) col.push(null);
    return '<div class="heat__col">' + col.map(function (d) {
      if (!d) return '<i class="heat__cell is-pad"></i>';
      var niceDate = new Date(d.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      return '<i class="heat__cell l' + lvl(d.tokens) + '" data-day="' + esc(d.date) + '" title="' + esc(niceDate) + ' · ' + fmtTokens(d.tokens) + ' tok · ' + fmtCost(d.cost) + '"></i>';
    }).join('') + '</div>';
  }).join('') + '</div>';
  var days = '<div class="heat__days">' + dayNames.map(function (n) { return '<span>' + n + '</span>'; }).join('') + '</div>';
  return days + '<div class="heat__grid">' + monthRow + grid + '</div>';
}

function renderHeatmap(s) {
  var el = document.getElementById('profile-heat');
  if (!el) return;
  var off = state.heatOffset || 0;
  var render = function (daily) {
    el.innerHTML = heatGridHtml(daily);
    var active = daily.filter(function (d) { return d.tokens > 0; }).length;
    var hint = document.getElementById('profile-heat-hint');
    if (hint && daily.length) {
      var fmtD = function (ds) { return new Date(ds + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };
      hint.textContent = fmtD(daily[0].date) + ' – ' + fmtD(daily[daily.length - 1].date) + ' · ' + active + ' active days';
    }
    var newer = document.getElementById('heat-newer');
    if (newer) newer.disabled = off === 0;
  };
  if (off === 0) { render(s.daily || []); return; }
  state.heatPages = state.heatPages || {};
  if (state.heatPages[off]) { render(state.heatPages[off]); return; }
  var end = new Date();
  end.setDate(end.getDate() - off * 91);
  var endStr = end.getFullYear() + '-' + String(end.getMonth() + 1).padStart(2, '0') + '-' + String(end.getDate()).padStart(2, '0');
  el.innerHTML = '<div class="empty">loading…</div>';
  fetch('/api/daily?days=91&end=' + endStr).then(function (r) { return r.json(); }).then(function (d) {
    state.heatPages[off] = d.days || [];
    if ((state.heatOffset || 0) === off) render(state.heatPages[off]);
  }).catch(function () { el.innerHTML = '<div class="empty">failed to load</div>'; });
}
(function () {
  var older = document.getElementById('heat-older');
  var newer = document.getElementById('heat-newer');
  if (older) older.addEventListener('click', function () {
    state.heatOffset = (state.heatOffset || 0) + 1;
    if (state.stats) renderHeatmap(state.stats);
  });
  if (newer) newer.addEventListener('click', function () {
    state.heatOffset = Math.max(0, (state.heatOffset || 0) - 1);
    if (state.stats) renderHeatmap(state.stats);
  });
})();

// a plain-words story of the day, composed from the digest - no AI, just facts
function daySummary(d, nice) {
  if (!d.tokens) return 'A quiet day — nothing ran.';
  var bits = [];
  if (d.firstT && d.lastT) {
    var span = (d.lastT - d.firstT) / 3600000;
    bits.push('You worked from ' + clock(d.firstT) + ' to ' + clock(d.lastT) +
      (span >= 1 ? ' (a ' + (Math.round(span * 10) / 10) + '-hour day)' : ''));
  }
  var sess = d.sessions || [];
  if (sess.length) {
    var top = sess[0];
    var share = d.tokens ? Math.round(top.tokens / d.tokens * 100) : 0;
    bits.push(sess.length === 1
      ? 'everything went into “' + top.title.slice(0, 50) + '”'
      : sess.length + ' sessions, ' + share + '% of it on “' + top.title.slice(0, 50) + '” (' + top.project + ')');
  }
  var tools = d.tools || [];
  if (tools.length) {
    var tt = tools[0];
    var tCount = tools.reduce(function (n, t) { return n + t.count; }, 0);
    bits.push(tCount + ' tool calls, mostly ' + tt.name + ' (×' + tt.count + ')');
  }
  bits.push(fmtTokens(d.tokens) + ' tokens · ' + fmtCost(d.cost) + ' API-equivalent');
  return bits.join(' · ') + '.';
}

// click a heatmap square -> the day opens huge over frosted glass.
// Fetch FIRST, render, then animate: swapping content mid-transition is what
// made the old version feel janky.
function openDay(date) {
  var ov = document.getElementById('dayov');
  var box = document.getElementById('dayov-body');
  if (!ov || !box) return;
  fetch('/api/day?date=' + encodeURIComponent(date)).then(function (r) { return r.json(); }).then(function (d) {
    var when = new Date(date + 'T12:00:00');
    var weekday = when.toLocaleDateString('en-US', { weekday: 'long' });
    var monthday = when.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
    var sess = (d.sessions || []).map(function (x) {
      return '<div class="dayov__row trow--link" data-sid="' + esc(x.sid) + '">' +
        (x.source === 'codex' ? '<span class="chip chip--codex">Codex</span> ' : '') +
        '<span class="dayov__title">' + esc(x.title) + '</span>' +
        '<small>' + esc(x.project) + '</small>' +
        '<span class="dayov__num">' + fmtTokens(x.tokens) + ' · ' + fmtCost(x.cost) + '</span>' +
      '</div>';
    }).join('');
    var tools = (d.tools || []).map(function (t) {
      return '<span class="chip">' + esc(t.name) + ' ×' + t.count + '</span>';
    }).join(' ');
    box.innerHTML =
      '<div class="dayov__weekday">' + esc(weekday) + '</div>' +
      '<div class="dayov__date">' + esc(monthday) + '</div>' +
      '<div class="dayov__big">' + fmtTokens(d.tokens) + ' <small>tokens · ' + fmtCost(d.cost) + '</small></div>' +
      '<p class="dayov__summary">' + esc(daySummary(d, weekday)) + '</p>' +
      (sess ? '<div class="dayov__label">the story of the day</div>' + sess : '') +
      (tools ? '<div class="dayov__label">moves</div><div class="dayov__tools">' + tools + '</div>' : '');
    ov.hidden = false;
    requestAnimationFrame(function () { requestAnimationFrame(function () { ov.classList.add('is-open'); }); });
  }).catch(function () {
    box.innerHTML = '<div class="empty">failed to load this day</div>';
    ov.hidden = false;
    requestAnimationFrame(function () { ov.classList.add('is-open'); });
  });
}
function closeDay() {
  var ov = document.getElementById('dayov');
  if (!ov || ov.hidden) return;
  ov.classList.remove('is-open');
  setTimeout(function () { ov.hidden = true; }, 240);
}
document.addEventListener('click', function (e) {
  var cell = e.target.closest('.heat__cell[data-day]');
  if (cell) { openDay(cell.getAttribute('data-day')); return; }
  var ov = document.getElementById('dayov');
  if (ov && !ov.hidden && (e.target === ov || e.target.closest('#dayov-close'))) closeDay();
});

// ---------- Pulse Wrapped: your week as a shareable card ----------
function wrappedData(s) {
  var week = (s.daily || []).slice(-7);
  var tok = 0, cost = 0, days = 0, best = null;
  week.forEach(function (d) {
    tok += d.tokens; cost += d.cost;
    if (d.tokens > 0) days++;
    if (!best || d.tokens > best.tokens) best = d;
  });
  // top project this week: sessions that were touched in the last 7 days
  var cut = Date.now() - 7 * 86400 * 1000;
  var proj = {};
  (s.sessions || []).forEach(function (x) {
    if (x.lastT && x.lastT >= cut && x.project && x.project !== 'unknown') {
      proj[x.project] = (proj[x.project] || 0) + (x.tokens || 0);
    }
  });
  var topProj = '', topN = 0;
  Object.keys(proj).forEach(function (k) { if (proj[k] > topN) { topN = proj[k]; topProj = k; } });
  var range = week.length
    ? week[0].date.slice(5).replace('-', '/') + ' – ' + week[week.length - 1].date.slice(5).replace('-', '/')
    : '';
  var ach = computeAchievements(s);
  return {
    range: range, tokens: tok, cost: cost, days: days,
    best: best && best.tokens ? best : null,
    topProj: topProj, rank: s.rank || '',
    streak: streakDays(s.daily || []),
    achv: ach.filter(function (a) { return a.ok; }).length, achvTotal: ach.length,
  };
}

function openWrapped() {
  var s = state.stats;
  if (!s) return;
  var d = wrappedData(s);
  var rows = [
    { k: 'API-equivalent burned', v: fmtCost(d.cost) },
    { k: 'days at the keyboard', v: d.days + ' of 7' },
    d.best ? { k: 'biggest day', v: d.best.date.slice(5).replace('-', '/') + ' · ' + fmtTokens(d.best.tokens) } : null,
    d.topProj ? { k: 'obsession of the week', v: d.topProj } : null,
    { k: 'streak', v: d.streak + ' days' },
    { k: 'achievements', v: d.achv + ' / ' + d.achvTotal },
  ].filter(Boolean);
  document.getElementById('wrapped-card').innerHTML =
    '<div class="wrapped__brand">✦ PULSE WRAPPED</div>' +
    '<div class="wrapped__range">' + esc(d.range) + '</div>' +
    '<div class="wrapped__big">' + fmtTokens(d.tokens) + '</div>' +
    '<div class="wrapped__biglabel">tokens this week</div>' +
    '<div class="wrapped__rows">' + rows.map(function (r) {
      return '<div class="wrapped__row"><span>' + esc(r.k) + '</span><b>' + esc(r.v) + '</b></div>';
    }).join('') + '</div>' +
    '<div class="wrapped__rank">' + esc(d.rank) + '</div>' +
    '<div class="wrapped__foot">pulse for claude code · all data local</div>';
  document.getElementById('wrapped').hidden = false;
}

// draw the same card onto a canvas and download it as a PNG
function saveWrappedPng() {
  var s = state.stats;
  if (!s) return;
  var d = wrappedData(s);
  var W = 1080, H = 1350;
  var cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  var ctx = cv.getContext('2d');
  ctx.fillStyle = '#1f1e1b'; ctx.fillRect(0, 0, W, H);
  // subtle top glow
  var g = ctx.createLinearGradient(0, 0, 0, 420);
  g.addColorStop(0, 'rgba(217,119,87,0.22)'); g.addColorStop(1, 'rgba(217,119,87,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, 420);
  // heartbeat mark
  ctx.strokeStyle = '#d97757'; ctx.lineWidth = 10; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.beginPath();
  var hb = [[70, 150], [170, 150], [210, 100], [265, 205], [305, 150], [400, 150]];
  hb.forEach(function (p, i) { i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); });
  ctx.stroke();
  var sans = '-apple-system, "Segoe UI", Roboto, Helvetica, sans-serif';
  ctx.fillStyle = '#eceae1';
  ctx.font = '600 44px ' + sans;
  ctx.fillText('PULSE WRAPPED', 70, 260);
  ctx.fillStyle = '#9a988e';
  ctx.font = '400 34px ' + sans;
  ctx.fillText(d.range, 70, 315);
  // the big number
  ctx.fillStyle = '#d97757';
  ctx.font = '700 190px ' + sans;
  ctx.fillText(fmtTokens(d.tokens), 62, 540);
  ctx.fillStyle = '#9a988e';
  ctx.font = '400 40px ' + sans;
  ctx.fillText('tokens this week', 70, 605);
  // rows
  var rows = [
    ['API-equivalent burned', fmtCost(d.cost)],
    ['days at the keyboard', d.days + ' of 7'],
    d.best ? ['biggest day', d.best.date.slice(5).replace('-', '/') + ' · ' + fmtTokens(d.best.tokens)] : null,
    d.topProj ? ['obsession of the week', d.topProj] : null,
    ['streak', d.streak + ' days'],
    ['achievements', d.achv + ' / ' + d.achvTotal],
  ].filter(Boolean);
  var y = 710;
  rows.forEach(function (r) {
    ctx.strokeStyle = 'rgba(255,255,255,0.09)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(70, y - 46); ctx.lineTo(W - 70, y - 46); ctx.stroke();
    ctx.fillStyle = '#9a988e'; ctx.font = '400 34px ' + sans;
    ctx.fillText(r[0], 70, y);
    ctx.fillStyle = '#eceae1'; ctx.font = '600 36px ' + sans;
    var tw = ctx.measureText(r[1]).width;
    ctx.fillText(r[1], W - 70 - tw, y);
    y += 88;
  });
  // rank
  ctx.fillStyle = '#d97757'; ctx.font = '700 72px ' + sans;
  ctx.fillText(d.rank, 70, H - 130);
  ctx.fillStyle = '#6f6d64'; ctx.font = '400 30px ' + sans;
  ctx.fillText('pulse for claude code · all data local', 70, H - 70);
  var a = document.createElement('a');
  a.download = 'pulse-wrapped.png';
  a.href = cv.toDataURL('image/png');
  a.click();
}

document.addEventListener('click', function (e) {
  if (e.target.closest('#wrapped-open')) { openWrapped(); return; }
  if (e.target.closest('#wrapped-save')) { saveWrappedPng(); return; }
  if (e.target.closest('#wrapped-close')) { document.getElementById('wrapped').hidden = true; return; }
  var w = document.getElementById('wrapped');
  if (w && !w.hidden && e.target === w) w.hidden = true;
});

// ---------- the pulse itself: a live ECG of how hard Claude is working ----------
// One PQRST complex per beat; beat frequency = bpm from the server. Flatline
// on a usage limit, amber when Claude needs you, accent while working.
function ecgWave(ph) {
  if (ph < 0.06) return 0;
  if (ph < 0.14) return 0.14 * Math.sin((ph - 0.06) / 0.08 * Math.PI);          // P
  if (ph < 0.20) return 0;
  if (ph < 0.23) return -0.18 * ((ph - 0.20) / 0.03);                            // Q
  if (ph < 0.27) return -0.18 + 1.18 * ((ph - 0.23) / 0.04);                     // R up
  if (ph < 0.31) return 1.0 - 1.32 * ((ph - 0.27) / 0.04);                       // R down
  if (ph < 0.36) return -0.32 + 0.32 * ((ph - 0.31) / 0.05);                     // S recover
  if (ph < 0.44) return 0;
  if (ph < 0.60) return 0.26 * Math.sin((ph - 0.44) / 0.16 * Math.PI);           // T
  return 0;
}
(function () {
  var canvas = document.getElementById('ecg');
  if (!canvas) return;
  var wrap = document.getElementById('ecg-wrap');
  var bpmEl = document.getElementById('ecg-bpm');
  var dpr = window.devicePixelRatio || 1;
  var W = 92, H = 26;
  canvas.width = W * dpr; canvas.height = H * dpr;
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  var ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  var buf = new Array(W).fill(0);
  var beatT = 0, lastTs = 0, shownBpm = 0;
  function color(phase) {
    if (phase === 'limit') return '#cc6b5a';
    if (phase === 'waiting') return '#d9a157';
    if (phase === 'working') return cssVar('--accent') || '#d97757';
    return cssVar('--muted') || '#9a988e';
  }
  function frame(ts) {
    requestAnimationFrame(frame);
    if (!lastTs) { lastTs = ts; return; }
    var dt = Math.min(0.1, (ts - lastTs) / 1000);
    lastTs = ts;
    var p = (state.stats && state.stats.pulse) || { bpm: 0, phase: 'rest' };
    // ease the displayed bpm so rate changes feel organic, not stepped
    shownBpm += (p.bpm - shownBpm) * Math.min(1, dt * 2);
    var sample = 0;
    if (shownBpm > 1) {
      beatT = (beatT + dt * shownBpm / 60) % 1;
      sample = ecgWave(beatT);
    }
    buf.push(sample); buf.shift();
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = color(p.phase);
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    var base = H * 0.62, amp = H * 0.42;
    for (var i = 0; i < W; i++) {
      var y = base - buf[i] * amp;
      i ? ctx.lineTo(i, y) : ctx.moveTo(i, y);
    }
    ctx.stroke();
    var label = p.phase === 'limit' ? '—' : String(Math.round(shownBpm));
    if (bpmEl.textContent !== label) bpmEl.textContent = label;
    bpmEl.style.color = color(p.phase);
  }
  requestAnimationFrame(frame);
  if (wrap) wrap.addEventListener('click', function () {
    state.tab = 'office';
    document.querySelectorAll('.tab').forEach(function (t) { t.classList.toggle('is-active', t.getAttribute('data-tab') === 'office'); });
    document.querySelectorAll('.panel').forEach(function (pn) { pn.classList.toggle('is-active', pn.id === 'panel-office'); });
    render();
  });
})();

// ---------- data: SSE with polling fallback ----------
function applyStats(data) { state.stats = data; render(); }

function startPolling() {
  function tick() {
    fetchStats().then(function (r) { return r.json(); })
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
    if (state.sourceFilter) return; // filtered mode refreshes via fetchStats below
    try { applyStats(JSON.parse(e.data)); } catch (err) {}
  });
  // filtered modes poll on the same cadence the SSE pushes
  setInterval(function () {
    if (!state.sourceFilter) return;
    fetchStats().then(function (r) { return r.json(); }).then(applyStats).catch(function () {});
  }, 3000);
  es.onerror = function () {
    state.connected = false;
    document.getElementById('live-dot').classList.add('is-stale');
  };
}

connect();
