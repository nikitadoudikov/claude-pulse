'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadConfig, saveConfig, PLAN_BUDGETS } = require('./config');
const { scan, sessionDigest, dayDigest } = require('./engine');
const notify = require('./notify');
const approvals = require('./approvals');
const transcript = require('./transcript');
const search = require('./search');
const snapshots = require('./snapshots');
const phonepage = require('./phonepage');
const ntfy = require('./ntfy');
const limits = require('./limits');
const scheduler = require('./scheduler');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

let statsCache = { at: 0, data: null };
const filteredCache = {}; // source -> { at, data }

const SOUNDS_DIR = path.join(os.homedir(), '.claude-pulse', 'sounds');
const SOUND_NAMES = ['done', 'attention', 'error', 'sent'];
function availableSounds() {
  const out = [];
  for (const n of SOUND_NAMES) {
    try { fs.accessSync(path.join(SOUNDS_DIR, n + '.mp3')); out.push(n); } catch (e) {}
  }
  return out;
}
const budgetAlerted = {}; // window name -> highest pct threshold already pushed

// Push a phone alert when a rolling-window budget crosses 80% then 100%.
function checkBudgets() {
  const cfg = loadConfig();
  if (!cfg.ntfyTopic) return;
  const b = cfg.budgets || {};
  if (!b.fiveHour && !b.day && !b.week) return;
  let st;
  try { st = getStats(); } catch (e) { return; }
  const W = st.windows || {};
  const checks = [
    { name: 'fiveHour', label: '5h', cost: (W.fiveHour || {}).cost || 0, budget: b.fiveHour },
    { name: 'day', label: 'today', cost: (W.today || {}).cost || 0, budget: b.day },
    { name: 'week', label: 'this week', cost: (W.week || {}).cost || 0, budget: b.week },
  ];
  for (const c of checks) {
    if (!c.budget || c.budget <= 0) continue;
    const pct = (c.cost / c.budget) * 100;
    if (pct < 50) { budgetAlerted[c.name] = 0; continue; } // reset once it falls back
    const threshold = pct >= 100 ? 100 : pct >= 80 ? 80 : 0;
    if (threshold > (budgetAlerted[c.name] || 0)) {
      budgetAlerted[c.name] = threshold;
      ntfy.push(cfg.ntfyTopic, {
        title: 'Pulse: ' + c.label + ' budget ' + Math.round(pct) + '%',
        message: '$' + c.cost.toFixed(0) + ' of $' + c.budget + ' (API-equivalent) used this ' + c.label,
        tags: threshold >= 100 ? 'rotating_light' : 'warning',
        priority: threshold >= 100 ? 'high' : 'default',
      });
    }
  }
}

function getStats(source) {
  const now = Date.now();
  if (source === 'claude' || source === 'codex') {
    const c = filteredCache[source];
    if (c && c.data && now - c.at < 1200 && statsCache.at <= c.at) return c.data;
  } else if (statsCache.data && now - statsCache.at < 1200) {
    return statsCache.data;
  }

  const config = loadConfig();
  const hit = limits.latestHit(now);
  const data = scan(config, now, hit ? hit.hitT : null, source);

  // strip synthetic / empty model buckets for a clean breakdown
  for (const k of Object.keys(data.byModel)) {
    if (!data.byModel[k].tokens || k === '<synthetic>') delete data.byModel[k];
  }

  const events = notify.readEvents(20);
  data.waiting = notify.computeWaiting(events, data.sessions, now);
  // a notification prompt is stale the moment Claude is clearly working again
  // (e.g. right after you tap Allow all): drop it so the mascot sits back down.
  if (data.waiting && data.eta && data.eta.working) data.waiting = null;
  data.notifications = events.slice(0, 10);
  data.pending = approvals.readPending();
  // hooks (approvals, notifications) are Claude Code machinery; on the pure
  // Codex dashboard they would claim "Claude is waiting" about the wrong agent
  if (source === 'codex') { data.waiting = null; data.pending = []; data.notifications = []; }
  data.rules = approvals.readRules();
  data.ntfyTopic = config.ntfyTopic || '';
  // notification preferences + per-session modes, so the UI can render toggles
  data.prefs = {
    ntfyPushApproval: config.ntfyPushApproval !== false,
    ntfyPushNotification: config.ntfyPushNotification !== false,
    ntfyPushStop: config.ntfyPushStop !== false,
    desktopNotify: config.desktopNotify !== false,
  };
  data.sessionModes = (data.rules && data.rules.sessions) || {};
  data.schedule = scheduler.readAll().filter((x) => x.status === 'pending' || (x.sentAt || x.at) > now - 86400 * 1000);
  data.limitHit = hit && hit.active ? hit : null;
  // the real ceiling: your 5h spend at the moment you last hit the limit (within
  // 24h). When present, the bars use it instead of the all-time peak guess.
  data.limitCeiling = data.calCeiling && data.calCeiling > 0 ? data.calCeiling : null;
  // heartbeat phase: flatline on an active limit, amber when Claude needs you
  if (data.pulse) {
    data.pulse.phase = data.limitHit ? 'limit'
      : (data.pending && data.pending.length) || data.waiting ? 'waiting'
      : (data.eta && data.eta.working) ? 'working' : 'rest';
    if (data.limitHit) data.pulse.bpm = 0;
  }
  data.sounds = availableSounds();
  data.source = source || 'all';

  if (source === 'claude' || source === 'codex') filteredCache[source] = { at: now, data };
  else statsCache = { at: now, data };
  return data;
}

function serveStatic(req, res) {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const fp = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!fp.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(fp, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    // never cache the dashboard assets, so a refresh always shows the latest UI.
    // CSP keeps an injected script from posting your session data off-machine
    // (connect-src 'self'); inline script/style are allowed so the UI still works.
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src https://www.youtube-nocookie.com https://www.youtube.com; base-uri 'self'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(buf);
  });
}

function sendJson(res, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, cb) {
  let data = '';
  req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
  req.on('end', () => { let o = {}; try { o = JSON.parse(data || '{}'); } catch (e) {} cb(o); });
}

const sseClients = new Set();

function broadcast() {
  if (!sseClients.size) return;
  let payload;
  try { payload = JSON.stringify(getStats()); } catch (e) { return; }
  const frame = `event: stats\ndata: ${payload}\n\n`;
  for (const res of sseClients) {
    try { res.write(frame); } catch (e) {}
  }
}

function handleSse(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.write('retry: 3000\n\n');
  sseClients.add(res);
  // initial push
  try { res.write(`event: stats\ndata: ${JSON.stringify(getStats())}\n\n`); } catch (e) {}
  req.on('close', () => sseClients.delete(res));
}

function createServer() {
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/api/stats') {
      const q = new URLSearchParams(req.url.split('?')[1] || '');
      return sendJson(res, getStats(q.get('source')));
    }
    if (url === '/api/events') return handleSse(req, res);
    if (url === '/api/health') return sendJson(res, { ok: true });
    if (url === '/api/day') {
      const q = new URLSearchParams(req.url.split('?')[1] || '');
      const date = q.get('date') || '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { res.writeHead(400); return res.end('date=YYYY-MM-DD required'); }
      try { return sendJson(res, dayDigest(date, loadConfig())); }
      catch (e) { res.writeHead(500); return res.end('error'); }
    }
    if (url.indexOf('/sounds/') === 0) {
      const name = url.slice('/sounds/'.length).replace(/[^a-z]/g, '');
      if (SOUND_NAMES.indexOf(name) === -1) { res.writeHead(404); return res.end('not found'); }
      return fs.readFile(path.join(SOUNDS_DIR, name + '.mp3'), (err, buf) => {
        if (err) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'max-age=300' });
        res.end(buf);
      });
    }
    if (url === '/api/notch-open' && req.method === 'POST') {
      // spawns a local browser window, so localhost only
      const remote = req.socket.remoteAddress || '';
      const isLocal = remote.indexOf('127.0.0.1') !== -1 || remote === '::1' || remote.indexOf('::ffff:127.0.0.1') !== -1;
      if (!isLocal) { res.writeHead(403); return res.end('forbidden'); }
      const r = require('./notchlaunch').launch(req.socket.localPort);
      return sendJson(res, r);
    }
    if (url === '/notch') {
      return fs.readFile(path.join(PUBLIC_DIR, 'notch.html'), (err, buf) => {
        if (err) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
        res.end(buf);
      });
    }
    if (url === '/api/test-push') {
      const cfg = loadConfig();
      if (!cfg.ntfyTopic) return sendJson(res, { ok: false, error: 'no-topic' });
      // honor ntfyServer, and embed the token in each button: the phone app
      // does not attach credentials to "http" actions on its own, so a
      // reserved reply topic needs it (same treatment as the approval flow).
      let origin;
      try { origin = new URL(String(cfg.ntfyServer || 'https://ntfy.sh')).origin; }
      catch (e) { origin = 'https://ntfy.sh'; }
      const rt = origin + '/' + encodeURIComponent(cfg.ntfyTopic + '-reply');
      const acts = [
        { label: 'Allow', body: 'test|ok|x' },
        { label: 'Deny', body: 'test|no|x' },
      ].map((a) => {
        const act = { action: 'http', label: a.label, url: rt, method: 'POST', body: a.body, clear: true };
        if (cfg.ntfyToken) act.headers = { Authorization: 'Bearer ' + cfg.ntfyToken };
        return act;
      });
      ntfy.push(cfg.ntfyTopic, {
        title: 'Pulse test',
        message: 'If you can see this with Allow / Deny buttons, your phone is connected.',
        tags: 'lock', priority: 'high',
        actions: JSON.stringify(acts),
      });
      return sendJson(res, { ok: true });
    }
    if (url === '/api/gen-topic' && req.method === 'POST') {
      // alphabet with no l, 1, i, o, 0 so the topic is safe to type by hand
      const alphabet = 'abcdefghjkmnpqrstvwxyz23456789';
      let t = 'claude-pulse-';
      for (let i = 0; i < 8; i++) t += alphabet[Math.floor(Math.random() * alphabet.length)];
      saveConfig({ ntfyTopic: t });
      try { ntfy.subscribeReplies(t); } catch (e) {}
      statsCache.at = 0;
      return sendJson(res, { ok: true, topic: t });
    }
    if (url === '/api/session') {
      const q = new URLSearchParams(req.url.split('?')[1] || '');
      const sid = q.get('sid');
      if (!sid) { res.writeHead(400); return res.end('sid required'); }
      try { return sendJson(res, sessionDigest(sid, loadConfig())); }
      catch (e) { res.writeHead(500); return res.end('error'); }
    }
    if (url === '/api/config' && req.method === 'POST') {
      return readBody(req, (body) => {
        const partial = {};
        const PLANS = ['unknown', 'pro', 'max5', 'max20', 'custom'];
        if (body && PLANS.indexOf(body.plan) !== -1) partial.plan = body.plan;
        if (body && body.budgets) partial.budgets = body.budgets;
        if (body && body.contextLimit) partial.contextLimit = body.contextLimit;
        // notification toggles from the settings panel
        for (const k of ['ntfyPushApproval', 'ntfyPushNotification', 'ntfyPushStop', 'desktopNotify']) {
          if (body && typeof body[k] === 'boolean') partial[k] = body[k];
        }
        const cfg = saveConfig(partial);
        statsCache.at = 0;
        sendJson(res, { ok: true, config: cfg });
      });
    }
    if (url === '/api/config') return sendJson(res, loadConfig());

    if (url === '/api/decision') {
      const q = new URLSearchParams(req.url.split('?')[1] || '');
      const remote = req.socket.remoteAddress || '';
      const isLocal = remote.indexOf('127.0.0.1') !== -1 || remote === '::1' || remote.indexOf('::ffff:127.0.0.1') !== -1;
      const apply = (body) => {
        const id = body.id || q.get('id');
        const decision = body.decision || q.get('decision');
        const scope = body.scope || q.get('scope') || 'once';
        if (!id || (decision !== 'allow' && decision !== 'deny')) { res.writeHead(400); return res.end('bad request'); }
        if (!isLocal && (body.token || q.get('token')) !== approvals.token()) { res.writeHead(403); return res.end('forbidden'); }
        if (decision === 'allow' && scope === 'all') { const r = approvals.readRules(); r.allowAll = true; approvals.writeRules(r); }
        if (scope === 'tool') {
          const pend = approvals.readPending().filter((p) => p.id === id)[0];
          if (pend) {
            const r = approvals.readRules();
            const key = decision === 'allow' ? 'allowTools' : 'denyTools';
            const set = {}; (r[key] || []).concat([pend.tool]).forEach((t) => { set[t] = 1; });
            r[key] = Object.keys(set);
            approvals.writeRules(r);
          }
        }
        approvals.writeDecision(id, { decision: decision, scope: scope, time: Date.now() });
        statsCache.at = 0;
        sendJson(res, { ok: true });
      };
      if (req.method === 'POST') return readBody(req, apply);
      return apply({});
    }
    if (url === '/api/search') {
      const q = new URLSearchParams(req.url.split('?')[1] || '');
      try { return sendJson(res, { results: search.searchSessions(q.get('q') || '', { limit: 40 }) }); }
      catch (e) { res.writeHead(500); return res.end('error'); }
    }
    if (url === '/api/phone') {
      const st = getStats();
      const a = st.active || (st.activeSessions || [])[0] || null;
      return sendJson(res, {
        paused: !!(st.rules && st.rules.paused),
        working: !!(st.eta && st.eta.working),
        waiting: st.waiting || null,
        pending: (st.pending || []).length,
        rank: st.rank || '',
        active: a ? { title: a.title, project: a.project, contextPercent: a.contextPercent || 0, lastT: a.lastT } : null,
        activity: (st.activity || []).slice(0, 10).map((x) => ({ name: x.name, hint: x.hint || '', t: x.t })),
      });
    }
    if (url === '/phone') {
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
      return res.end(phonepage.render(approvals.token()));
    }
    if (url === '/api/pause') {
      const q = new URLSearchParams(req.url.split('?')[1] || '');
      const remote = req.socket.remoteAddress || '';
      const isLocal = remote.indexOf('127.0.0.1') !== -1 || remote === '::1' || remote.indexOf('::ffff:127.0.0.1') !== -1;
      const apply = (body) => {
        if (!isLocal && (body.token || q.get('token')) !== approvals.token()) { res.writeHead(403); return res.end('forbidden'); }
        const v = body.paused != null ? body.paused : q.get('paused');
        const r = approvals.readRules();
        r.paused = (v === true || v === 'true' || v === '1');
        approvals.writeRules(r);
        statsCache.at = 0;
        sendJson(res, { ok: true, paused: r.paused });
      };
      if (req.method === 'POST') return readBody(req, apply);
      return apply({});
    }

    if (url === '/transcript') {
      const q = new URLSearchParams(req.url.split('?')[1] || '');
      const s = transcript.findSession(q.get('sid'));
      if (!s) { res.writeHead(404); return res.end('session not found'); }
      try {
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
        return res.end(transcript.renderHtmlPage(s.file));
      } catch (e) { res.writeHead(500); return res.end('error'); }
    }
    if (url === '/api/export') {
      const q = new URLSearchParams(req.url.split('?')[1] || '');
      const s = transcript.findSession(q.get('sid'));
      if (!s) { res.writeHead(404); return res.end('session not found'); }
      try {
        const md = transcript.renderMarkdown(s.file, { full: q.get('full') === '1' });
        const headers = { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' };
        if (q.get('dl') === '1') headers['Content-Disposition'] = `attachment; filename="pulse-${s.sid.slice(0, 8)}.md"`;
        res.writeHead(200, headers);
        return res.end(md);
      } catch (e) { res.writeHead(500); return res.end('error'); }
    }
    if (url === '/api/export-all') {
      // plain markdown by default: a .md.gz confused archive tools that guessed
      // a tar inside (#8). Localhost bandwidth is free; ?gz=1 keeps the old form.
      const q = new URLSearchParams(req.url.split('?')[1] || '');
      try {
        const md = transcript.combinedMarkdown({});
        if (q.get('gz') === '1') {
          res.writeHead(200, { 'Content-Type': 'application/gzip', 'Cache-Control': 'no-store',
            'Content-Disposition': 'attachment; filename="pulse-history.md.gz"' });
          return res.end(require('zlib').gzipSync(md));
        }
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store',
          'Content-Disposition': 'attachment; filename="pulse-history.md"' });
        return res.end(md);
      } catch (e) { res.writeHead(500); return res.end('error'); }
    }

    if (url === '/api/rules' && req.method === 'POST') {
      return readBody(req, (b) => {
        const r = approvals.readRules();
        if (typeof b.enabled === 'boolean') r.enabled = b.enabled;
        if (typeof b.allowAll === 'boolean') r.allowAll = b.allowAll;
        if (b.clearTools) r.allowTools = [];
        // per-session mode: 'auto' answers every prompt for that session
        if (b.sid && (b.mode === 'auto' || b.mode === 'off')) {
          r.sessions = r.sessions || {};
          if (b.mode === 'auto') r.sessions[b.sid] = 'auto';
          else delete r.sessions[b.sid];
        }
        approvals.writeRules(r);
        statsCache.at = 0;
        sendJson(res, { ok: true, rules: r });
      });
    }

    // scheduled prompts: queue "send this text to that session at HH:MM"
    if (url === '/api/schedule' && req.method === 'POST') {
      return readBody(req, (b) => {
        if (!b.sid || !b.at || !b.text) { res.writeHead(400); return res.end('sid, at, text required'); }
        const at = Number(b.at);
        if (!isFinite(at) || at < Date.now() - 60000) { res.writeHead(400); return res.end('time is in the past'); }
        const it = scheduler.add({ sid: b.sid, at, text: b.text });
        statsCache.at = 0;
        sendJson(res, { ok: true, item: it });
      });
    }
    if (url === '/api/schedule-now' && req.method === 'POST') {
      return readBody(req, (b) => {
        const ok = scheduler.requeue(b.id);
        statsCache.at = 0;
        sendJson(res, { ok });
      });
    }
    if (url === '/api/schedule-remove' && req.method === 'POST') {
      return readBody(req, (b) => {
        const ok = scheduler.remove(b.id);
        statsCache.at = 0;
        sendJson(res, { ok });
      });
    }
    if (url === '/api/schedule') return sendJson(res, { items: scheduler.readAll() });

    return serveStatic(req, res);
  });
  return server;
}

function start(opts) {
  const options = opts || {};
  const port = options.port || 4317;
  const cfg = loadConfig();
  notify.ensureRuntimeDir();
  approvals.ensure();
  approvals.heartbeat();

  const server = createServer();

  // heartbeat + live push (cheap thanks to the per-file parse cache). The
  // heartbeat lets the permission hook know Pulse is up before it ever blocks.
  const timer = setInterval(() => { approvals.heartbeat(); broadcast(); }, 2000);
  timer.unref && timer.unref();

  // auto-snapshot recently active sessions so a crash never loses one
  const snapMin = cfg.snapshotMinutes;
  if (snapMin && snapMin > 0) {
    try { snapshots.snapshotActive(cfg); } catch (e) {}
    const snapTimer = setInterval(() => { try { snapshots.snapshotActive(loadConfig()); } catch (e) {} }, snapMin * 60000);
    snapTimer.unref && snapTimer.unref();
  }

  // subscribe to phone replies (Allow/Deny tapped on the ntfy notification)
  try { ntfy.subscribeReplies(cfg.ntfyTopic); } catch (e) {}

  // budget alerts to your phone, checked every 30s
  const budgetTimer = setInterval(() => { try { checkBudgets(); } catch (e) {} }, 30000);
  budgetTimer.unref && budgetTimer.unref();

  // scheduled prompts: fire due items, tell the phone when one goes out
  const schedTimer = setInterval(() => {
    try {
      scheduler.runDue((it) => {
        statsCache.at = 0;
        const c = loadConfig();
        if (c.ntfyTopic) {
          ntfy.push(c.ntfyTopic, {
            title: 'Pulse: scheduled prompt sent',
            message: (it.text || '').slice(0, 120),
            tags: 'alarm_clock', priority: 'default',
          });
        }
        broadcast();
      });
    } catch (e) {}
  }, 15000);
  schedTimer.unref && schedTimer.unref();

  // instant push when the hook writes a notification or a pending approval
  try {
    fs.watch(notify.runtimeDir(), () => { statsCache.at = 0; broadcast(); });
  } catch (e) {}
  try {
    fs.watch(approvals.PENDING, () => { statsCache.at = 0; broadcast(); });
  } catch (e) {}

  const host = cfg.bindLan ? '0.0.0.0' : '127.0.0.1';
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => resolve({ server, port, host }));
  });
}

module.exports = { start, getStats, createServer };
