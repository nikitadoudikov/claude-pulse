'use strict';

// Scheduled prompts: "at 10:00 send this to that session". Items live on disk
// so a restart never loses them; when one is due, Pulse runs
// `claude -p --resume <sid> "<text>"` headless from the session's directory.
// The turn lands in the session's JSONL like any other, so the dashboard,
// transcript and recover all see it. Typical use: the usage limit resets at
// 10:00, you queue "continue" for 10:01 and walk away.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const FILE = path.join(os.homedir(), '.claude-pulse', 'schedule.json');

// don't fire a prompt that is very stale (laptop was asleep, daemon was down):
// a "continue at 10:00" sent at 16:40 is worse than not sending it.
const MAX_LATE_MS = 45 * 60 * 1000;

function readAll() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) || []; } catch (e) { return []; }
}
function writeAll(list) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
  } catch (e) {}
}

function add(item) {
  const it = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    sid: String(item.sid),
    cwd: item.cwd || null,
    at: Number(item.at),
    text: String(item.text || '').slice(0, 4000),
    status: 'pending',
    createdAt: Date.now(),
  };
  const list = readAll();
  list.push(it);
  writeAll(list);
  return it;
}

function remove(id) {
  const list = readAll();
  const next = list.filter((x) => x.id !== id);
  writeAll(next);
  return next.length !== list.length;
}

// keep the file from growing forever: drop finished items older than 7 days
function prune(list) {
  const cut = Date.now() - 7 * 86400 * 1000;
  return list.filter((x) => x.status === 'pending' || (x.sentAt || x.at) > cut);
}

// the daemon may run under launchd with a minimal PATH; look in common places
function claudeBin() {
  const candidates = [
    path.join(os.homedir(), '.claude', 'local', 'claude'),
    path.join(os.homedir(), '.npm-global', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    path.join(os.homedir(), '.local', 'bin', 'claude'),
  ];
  for (const c of candidates) {
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch (e) {}
  }
  return 'claude'; // hope PATH has it
}

function markStatus(id, status, extra) {
  const list = readAll();
  const it = list.find((x) => x.id === id);
  if (!it) return;
  it.status = status;
  Object.assign(it, extra || {});
  writeAll(list);
}

// run every due item; onSent(item) fires after a successful spawn so the
// server can push a phone notification.
function runDue(onSent) {
  let list = readAll();
  const now = Date.now();
  let changed = false;
  for (const it of list) {
    if (it.status !== 'pending' || it.at > now) continue;
    changed = true;
    if (now - it.at > MAX_LATE_MS) { it.status = 'missed'; continue; }
    try {
      const opts = { detached: true, stdio: ['ignore', 'ignore', 'ignore'] };
      if (it.cwd) {
        try { fs.accessSync(it.cwd); opts.cwd = it.cwd; } catch (e) {}
      }
      const child = spawn(claudeBin(), ['-p', '--resume', it.sid, it.text], opts);
      child.on('error', function () { markStatus(it.id, 'failed', { error: 'claude binary not found' }); });
      child.unref();
      it.status = 'sent';
      it.sentAt = now;
      if (onSent) { try { onSent(it); } catch (e) {} }
    } catch (e) {
      it.status = 'failed';
      it.error = String((e && e.message) || e);
    }
  }
  if (changed) writeAll(prune(list));
}

module.exports = { readAll, add, remove, runDue, FILE };
