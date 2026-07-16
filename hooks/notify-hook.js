#!/usr/bin/env node
'use strict';

/*
 * Claude Code "Notification" hook for Pulse.
 *
 * Claude Code runs this and pipes a JSON object on stdin whenever it needs
 * your attention (a permission / Allow prompt, or it has been idle waiting for
 * input). This script does two things:
 *   1. appends the event to ~/.claude-pulse/events.jsonl  (the dashboard reads it)
 *   2. fires a native desktop notification so you notice even if the tab is hidden
 *
 * Wire it up in ~/.claude/settings.json (see README), then keep `claude-pulse`
 * running. The script is intentionally tiny and never blocks Claude.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { spawn } = require('child_process');

const RUNTIME_DIR = path.join(os.homedir(), '.claude-pulse');
const EVENTS_FILE = path.join(RUNTIME_DIR, 'events.jsonl');
const MAX_LINES = 200; // keep the events file small

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 500); // never hang
  });
}

function classify(message) {
  const m = String(message || '').toLowerCase();
  if (m.includes('permission') || m.includes('approve') || m.includes('allow')) return 'permission';
  return 'notification';
}

function appendEvent(ev) {
  try { fs.mkdirSync(RUNTIME_DIR, { recursive: true }); } catch (e) {}
  let lines = [];
  try { lines = fs.readFileSync(EVENTS_FILE, 'utf8').split('\n').filter(Boolean); } catch (e) {}
  lines.push(JSON.stringify(ev));
  if (lines.length > MAX_LINES) lines = lines.slice(lines.length - MAX_LINES);
  try { fs.writeFileSync(EVENTS_FILE, lines.join('\n') + '\n'); } catch (e) {}
}

function desktopNotify(title, body) {
  try {
    if (process.platform === 'darwin') {
      const script = 'display notification ' + q(body) + ' with title ' + q(title) + ' sound name "Ping"';
      spawn('osascript', ['-e', script], { stdio: 'ignore', detached: true }).unref();
    } else if (process.platform === 'linux') {
      spawn('notify-send', [title, body], { stdio: 'ignore', detached: true }).unref();
    }
  } catch (e) {}
}
function q(s) { return '"' + String(s).replace(/["\\]/g, '\\$&') + '"'; }

// ntfy settings from ~/.claude-pulse.json: topic, server (self-hosted or
// ntfy.sh), access token for reserved topics, and the per-hook push toggle.
// A bad ntfyServer URL falls back to ntfy.sh so a typo cannot break the hook.
function ntfySettings() {
  var cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude-pulse.json'), 'utf8')) || {}; } catch (e) {}
  var u;
  try { u = new URL(String(cfg.ntfyServer || 'https://ntfy.sh')); }
  catch (e) { u = new URL('https://ntfy.sh'); }
  return {
    topic: cfg.ntfyTopic || '',
    token: String(cfg.ntfyToken || ''),
    mod: u.protocol === 'http:' ? require('http') : https,
    hostname: u.hostname,
    port: u.port ? parseInt(u.port, 10) : (u.protocol === 'http:' ? 80 : 443),
    pushNotification: cfg.ntfyPushNotification !== false,
  };
}
function pushNtfy(n, title, message, tags) {
  if (!n.topic || !n.pushNotification) return Promise.resolve();
  return new Promise(function (resolve) {
    var data = Buffer.from(message || '', 'utf8');
    var headers = {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': data.length,
      'Title': String(title || 'Claude Code').replace(/[^\x20-\x7E]/g, ''),
      'Tags': tags || 'warning',
      'Priority': 'high',
    };
    if (n.token) headers.Authorization = 'Bearer ' + n.token;
    var req = n.mod.request({
      method: 'POST', hostname: n.hostname, port: n.port, path: '/' + encodeURIComponent(n.topic),
      headers: headers,
    }, function (res) { res.on('data', function () {}); res.on('end', resolve); });
    req.on('error', resolve);
    req.write(data); req.end();
    setTimeout(resolve, 2500);
  });
}

(async function main() {
  const raw = await readStdin();
  let input = {};
  try { input = JSON.parse(raw); } catch (e) {}

  const message = input.message || input.notification || 'Claude needs your attention';
  const ev = {
    time: Date.now(),
    type: classify(message),
    sessionId: input.session_id || input.sessionId || null,
    cwd: input.cwd || null,
    message: message,
  };

  appendEvent(ev);
  const project = ev.cwd ? path.basename(ev.cwd) : '';
  desktopNotify('Claude Code' + (project ? ' · ' + project : ''), message);
  await pushNtfy(ntfySettings(), 'Claude needs you' + (project ? ' (' + project + ')' : ''), message, 'warning');

  process.exit(0);
})();
