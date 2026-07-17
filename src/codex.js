'use strict';

// Read OpenAI Codex CLI session logs into the same shape engine.js produces for
// Claude Code, so the dashboard can aggregate both in one place. Codex keeps one
// JSONL "rollout" file per session under ~/.codex/sessions/YYYY/MM/DD/, opening
// with a session_meta line and carrying per-turn usage in event_msg/token_count
// lines (payload.info.last_token_usage is the delta for that turn).

const fs = require('fs');
const path = require('path');
const os = require('os');

const CODEX_DIR = path.join(os.homedir(), '.codex');
const CODEX_SESSIONS = path.join(CODEX_DIR, 'sessions');
const INDEX_FILE = path.join(CODEX_DIR, 'session_index.jsonl');

function projectName(cwd) {
  if (!cwd) return null;
  return path.basename(cwd) || cwd;
}

function blankSession(sid) {
  return {
    sid, title: null, lastPrompt: null, cwd: null, project: null, model: 'gpt',
    firstT: null, lastT: null, userMsgs: 0, assistantMsgs: 0, toolCalls: 0,
    errors: 0, promptTimes: [], lastStopReason: null, lastAssistantT: null,
    lastWasError: false, source: 'codex', ctxWindow: null,
  };
}

// thread_name per session id, from the index, for human titles. Cached 60s.
let titleCache = { at: 0, map: null };
function loadTitles() {
  const now = Date.now();
  if (titleCache.map && now - titleCache.at < 60000) return titleCache.map;
  const map = {};
  try {
    const raw = fs.readFileSync(INDEX_FILE, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try { const o = JSON.parse(line); if (o.id && o.thread_name) map[o.id] = o.thread_name; } catch (e) {}
    }
  } catch (e) {}
  titleCache = { at: now, map: map };
  return map;
}

// Every rollout-*.jsonl under the date hierarchy.
function listCodexFiles() {
  const out = [];
  (function walk(dir) {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of ents) {
      const fp = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(fp);
      else if (ent.name.indexOf('rollout-') === 0 && ent.name.endsWith('.jsonl')) out.push(fp);
    }
  })(CODEX_SESSIONS);
  return out;
}

function parseFile(fp) {
  const data = { tokens: [], tools: [], sessions: {} };
  let raw;
  try { raw = fs.readFileSync(fp, 'utf8'); } catch (e) { return data; }
  const titles = loadTitles();

  let sid = null;
  let model = 'gpt';
  let s = null;

  for (const line of raw.split('\n')) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch (e) { continue; }
    const tsMs = o.timestamp ? Date.parse(o.timestamp) : null;
    const p = o.payload || {};

    if (o.type === 'session_meta') {
      sid = p.id || null;
      if (sid) {
        if (!data.sessions[sid]) data.sessions[sid] = blankSession(sid);
        s = data.sessions[sid];
        s.cwd = p.cwd || null;
        s.project = projectName(p.cwd);
        if (titles[sid]) s.title = titles[sid];
        if (tsMs) { s.firstT = tsMs; s.lastT = tsMs; }
      }
      continue;
    }
    if (!s && sid) s = data.sessions[sid];
    if (s && tsMs) {
      if (!s.firstT || tsMs < s.firstT) s.firstT = tsMs;
      if (!s.lastT || tsMs > s.lastT) s.lastT = tsMs;
    }

    if (o.type === 'turn_context' && p.model) { model = p.model; if (s) s.model = p.model; }

    // the model's real context window, reported at the start of every task
    if (o.type === 'event_msg' && p.type === 'task_started' && s && p.model_context_window) {
      s.ctxWindow = p.model_context_window;
    }

    // a user_message event is the actual typed prompt (response_items with
    // role=user also carry replayed history and environment XML, so they are
    // useless as counters). Count turns and take the title from here.
    if (o.type === 'event_msg' && p.type === 'user_message' && s && typeof p.message === 'string') {
      s.userMsgs++;
      if (tsMs) s.promptTimes.push(tsMs);
      const txt = p.message.replace(/\s+/g, ' ').trim();
      if (!s.title && txt && txt[0] !== '<') s.title = txt.slice(0, 80).trim();
      if (txt) s.lastPrompt = txt.slice(0, 200);
    }

    // tool calls, for the activity feed and per-session counters. Forked
    // rollouts replay the parent's items, so each entry carries a stable key
    // (call_id/id) and the engine dedupes across files.
    if (o.type === 'response_item' && (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'web_search_call')) {
      if (s) s.toolCalls++;
      let hint = '';
      if (p.arguments) {
        try { const a = JSON.parse(p.arguments); hint = a.cmd || a.command || a.path || a.file_path || a.query || ''; } catch (e) {}
      }
      if (!hint && p.action && p.action.query) hint = p.action.query;
      if (Array.isArray(hint)) hint = hint.join(' ');
      data.tools.push({
        t: tsMs, sid, source: 'codex', key: p.call_id || p.id || null,
        name: p.type === 'web_search_call' ? 'WebSearch' : (p.name || 'tool'),
        hint: String(hint).replace(/\s+/g, ' ').trim().slice(0, 90),
      });
    }

    if (o.type === 'event_msg' && p.type === 'token_count') {
      const info = p.info || {};
      const last = info.last_token_usage || {};
      const inTot = last.input_tokens || 0;
      const cached = last.cached_input_tokens || 0;
      const m = (info.model_context && info.model_context.model) || model;
      if (s) { s.model = m; s.assistantMsgs++; if (tsMs) s.lastAssistantT = tsMs; }
      if (tsMs && (inTot || last.output_tokens)) {
        data.tokens.push({
          t: tsMs, sid: sid, source: 'codex', model: m,
          inp: Math.max(0, inTot - cached), cwr: 0, crd: cached, out: last.output_tokens || 0,
        });
      }
    }

  }

  return data;
}

module.exports = { listCodexFiles, parseFile, CODEX_SESSIONS, CODEX_DIR };
