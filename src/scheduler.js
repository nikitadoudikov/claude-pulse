'use strict';

// Scheduled prompts: "at 10:00 send this to that session". Items live on disk
// so a restart never loses them; when one is due, Pulse runs
// `claude -p --resume <sid> "<text>"` headless. Claude Code resolves --resume
// per project directory, so the working directory MUST be the session's own
// cwd - we read it straight from the session's jsonl at fire time. The run's
// JSON output is captured so the dashboard can link to the resulting session
// and show an error when the run failed instead of pretending it went fine.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const FILE = path.join(os.homedir(), '.claude-pulse', 'schedule.json');
const RUNS = path.join(os.homedir(), '.claude-pulse', 'sched-runs');
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// don't fire a prompt that is very stale (laptop was asleep, daemon was down):
// a "continue at 10:00" sent at 16:40 is worse than not sending it. Missed
// items keep a "send now" button in the UI instead.
const MAX_LATE_MS = 45 * 60 * 1000;

function readAll() {
  let list;
  try { list = JSON.parse(fs.readFileSync(FILE, 'utf8')) || []; } catch (e) { return []; }
  // enrich finished runs with the result session id, parsed lazily from the
  // captured output (the process runs detached, so this is the reliable path)
  let changed = false;
  for (const it of list) {
    if (it.status === 'sent' && !it.resultSid && it.outFile) {
      try {
        const out = JSON.parse(fs.readFileSync(it.outFile, 'utf8'));
        if (out.session_id) { it.resultSid = out.session_id; changed = true; }
        if (out.is_error) { it.status = 'failed'; it.error = String(out.result || 'run errored').slice(0, 200); changed = true; }
      } catch (e) {}
      if (!it.resultSid && it.errFile) {
        try {
          const err = fs.readFileSync(it.errFile, 'utf8').trim();
          if (err && /no conversation|error|invalid/i.test(err) && Date.now() - (it.sentAt || 0) > 30000) {
            it.status = 'failed';
            it.error = err.split('\n').pop().slice(0, 200);
            changed = true;
          }
        } catch (e) {}
      }
    }
  }
  if (changed) writeAll(list);
  return list;
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

// re-queue a missed or failed item to fire on the next scheduler tick
function requeue(id) {
  const list = readAll();
  const it = list.find((x) => x.id === id);
  if (!it) return false;
  it.status = 'pending';
  it.at = Date.now();
  delete it.error;
  delete it.resultSid;
  delete it.outFile;
  delete it.errFile;
  writeAll(list);
  return true;
}

// keep the file from growing forever: drop finished items older than 7 days
function prune(list) {
  const cut = Date.now() - 7 * 86400 * 1000;
  return list.filter((x) => x.status === 'pending' || (x.sentAt || x.at) > cut);
}

// `claude --resume` only finds the session when run from the session's own
// project directory; the jsonl records carry that cwd - read it from disk.
function sessionCwd(sid) {
  let dirs;
  try { dirs = fs.readdirSync(PROJECTS_DIR); } catch (e) { return null; }
  for (const d of dirs) {
    const fp = path.join(PROJECTS_DIR, d, sid + '.jsonl');
    let raw;
    try { raw = fs.readFileSync(fp, 'utf8'); } catch (e) { continue; }
    for (const line of raw.split('\n').slice(0, 50)) {
      if (!line) continue;
      try { const o = JSON.parse(line); if (o.cwd) return o.cwd; } catch (e) {}
    }
    return null; // file found but no cwd recorded
  }
  return null;
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
      fs.mkdirSync(RUNS, { recursive: true });
      const outFile = path.join(RUNS, it.id + '.json');
      const errFile = path.join(RUNS, it.id + '.err');
      const opts = {
        detached: true,
        stdio: ['ignore', fs.openSync(outFile, 'w'), fs.openSync(errFile, 'w')],
      };
      const cwd = sessionCwd(it.sid);
      if (cwd) opts.cwd = cwd; // do NOT pre-check access: TCC-protected dirs stat as denied yet work as a cwd
      const child = spawn(claudeBin(), ['-p', '--resume', it.sid, it.text, '--output-format', 'json'], opts);
      child.on('error', function () { markStatus(it.id, 'failed', { error: 'claude binary not found' }); });
      child.on('exit', function (code) {
        if (code !== 0) {
          let msg = 'claude exited with code ' + code;
          try { msg = (fs.readFileSync(errFile, 'utf8').trim().split('\n').pop() || msg).slice(0, 200); } catch (e) {}
          markStatus(it.id, 'failed', { error: msg });
        }
      });
      child.unref();
      it.status = 'sent';
      it.sentAt = now;
      it.outFile = outFile;
      it.errFile = errFile;
      it.cwdUsed = cwd || null;
      if (onSent) { try { onSent(it); } catch (e) {} }
    } catch (e) {
      it.status = 'failed';
      it.error = String((e && e.message) || e);
    }
  }
  if (changed) writeAll(prune(list));
}

module.exports = { readAll, add, remove, requeue, runDue, sessionCwd, FILE };
