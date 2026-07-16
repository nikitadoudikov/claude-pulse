'use strict';

// Two-way ntfy. Pulse pushes a notification when Claude needs you, and the
// Allow / Allow all / Deny buttons on that notification post the answer back to
// "<topic>-reply", which Pulse is subscribed to. No LAN, no IP, no port to open:
// the phone only needs the ntfy app subscribed to your topic. Works anywhere.
//
// Server + token: "ntfyServer" (default https://ntfy.sh) and "ntfyToken" in
// ~/.claude-pulse.json let the same flow ride a self-hosted server and/or
// reserved (access-controlled) topics. With a token set, every publish and the
// reply subscription carry "Authorization: Bearer <token>".

const https = require('https');
const http = require('http');
const { loadConfig } = require('./config');
const approvals = require('./approvals');

function replyTopic(topic) { return topic ? topic + '-reply' : ''; }

// Resolve server/token once per call; falls back to ntfy.sh on a bad URL so a
// config typo degrades to upstream behavior instead of breaking pushes.
function serverParts() {
  const cfg = loadConfig();
  let u;
  try { u = new URL(String(cfg.ntfyServer || 'https://ntfy.sh')); }
  catch (e) { u = new URL('https://ntfy.sh'); }
  return {
    mod: u.protocol === 'http:' ? http : https,
    hostname: u.hostname,
    port: u.port ? parseInt(u.port, 10) : (u.protocol === 'http:' ? 80 : 443),
    token: String(cfg.ntfyToken || ''),
  };
}

// Fire-and-forget push to a topic.
function push(topic, opts) {
  if (!topic) return;
  const o = opts || {};
  const s = serverParts();
  const headers = {};
  if (o.title) headers.Title = String(o.title).replace(/[^\x20-\x7E]/g, '');
  if (o.tags) headers.Tags = o.tags;
  if (o.priority) headers.Priority = String(o.priority);
  if (o.actions) headers.Actions = o.actions;
  if (s.token) headers.Authorization = 'Bearer ' + s.token;
  const data = Buffer.from(String(o.message || ''), 'utf8');
  headers['Content-Length'] = data.length;
  try {
    const req = s.mod.request({ method: 'POST', hostname: s.hostname, port: s.port, path: '/' + encodeURIComponent(topic), headers: headers },
      (res) => { res.on('data', () => {}); res.on('end', () => {}); });
    req.on('error', () => {});
    req.write(data); req.end();
  } catch (e) {}
}

// Apply a decision message of the form "<decision>|<scope>|<id>".
function applyMessage(msg) {
  const parts = String(msg || '').trim().split('|');
  if (parts.length < 3) return;
  const decision = parts[0], scope = parts[1] || 'once', id = parts[2];
  if ((decision !== 'allow' && decision !== 'deny') || !id) return;
  // ignore stale / replayed messages: only act on a request we are waiting for.
  // ntfy can replay a cached message when we reconnect, and a stale "allow all"
  // must never silently flip the global rule.
  if (!approvals.readPending().some((p) => p.id === id)) return;
  if (decision === 'allow' && scope === 'all') {
    const r = approvals.readRules(); r.allowAll = true; approvals.writeRules(r);
  }
  approvals.writeDecision(id, { decision: decision, scope: scope, time: Date.now() });
}

let currentTopic = null;
let activeReq = null;
let reconnectTimer = null;

function scheduleReconnect(topic) {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (topic === currentTopic) connect(topic); // skip if the topic was changed meanwhile
  }, 5000);
  reconnectTimer.unref && reconnectTimer.unref();
}

function connect(topic) {
  const s = serverParts();
  const path = '/' + encodeURIComponent(replyTopic(topic)) + '/json';
  const headers = {};
  if (s.token) headers.Authorization = 'Bearer ' + s.token;
  let req;
  try {
    req = s.mod.get({ hostname: s.hostname, port: s.port, path: path, headers: headers }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return scheduleReconnect(topic); }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          try { const o = JSON.parse(line); if (o.event === 'message' && topic === currentTopic) applyMessage(o.message); } catch (e) {}
        }
      });
      res.on('end', () => scheduleReconnect(topic));
    });
  } catch (e) { return scheduleReconnect(topic); }
  req.on('error', () => scheduleReconnect(topic));
  req.setTimeout(0);
  activeReq = req;
}

// Subscribe so the phone's reply buttons take effect. Safe to call again with a
// new topic: it tears down the old subscription and listens on the new one live.
function subscribeReplies(topic) {
  if (!topic || topic === currentTopic) return;
  currentTopic = topic;
  if (activeReq) { try { activeReq.destroy(); } catch (e) {} activeReq = null; }
  connect(topic);
}

module.exports = { push, replyTopic, applyMessage, subscribeReplies };
