'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { priceFor } = require('./config');
const codex = require('./codex');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// Per-file parse cache so unchanged sessions are never re-read.
// path -> { mtimeMs, size, data }
const fileCache = new Map();

// every session jsonl across the local root plus any configured extraRoots
// (rsync'd mirrors of a second host etc.); extra-root files carry that root's
// label so the UI can show where a session came from (#9).
function listJsonl(extraRoots) {
  const roots = [{ dir: PROJECTS_DIR, label: null }];
  for (const r of extraRoots || []) {
    if (r.claudeProjects) roots.push({ dir: r.claudeProjects, label: r.label });
  }
  const out = [];
  for (const root of roots) {
    let dirs;
    try { dirs = fs.readdirSync(root.dir, { withFileTypes: true }); } catch (e) { continue; }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const p = path.join(root.dir, d.name);
      let files;
      try { files = fs.readdirSync(p); } catch (e) { continue; }
      for (const f of files) {
        if (f.endsWith('.jsonl')) out.push({ path: path.join(p, f), observer: /^observer\b/i.test(f), label: root.label });
      }
    }
  }
  return out;
}

function projectName(cwd) {
  if (!cwd) return 'unknown';
  if (cwd === os.homedir()) return 'home';
  return path.basename(cwd) || cwd;
}

function toolHint(input) {
  if (!input || typeof input !== 'object') return '';
  const h = input.file_path || input.command || input.pattern ||
            input.description || input.url || input.path || input.query || '';
  return String(h).replace(/\s+/g, ' ').trim().slice(0, 90);
}

function emptyFileData() {
  return { tokens: [], tools: [], sessions: {} };
}

function blankSession(sid) {
  return {
    sid,
    title: null,
    fallbackTitle: null,
    lastPrompt: null,
    cwd: null,
    project: null,
    model: null,
    firstT: null,
    lastT: null,
    userMsgs: 0,
    assistantMsgs: 0,
    toolCalls: 0,
    errors: 0,
    promptTimes: [],
    lastStopReason: null,
    lastAssistantT: null,
    lastWasError: false,
  };
}

function parseFile(fp) {
  const data = emptyFileData();
  let raw;
  try { raw = fs.readFileSync(fp, 'utf8'); } catch (e) { return data; }

  const lines = raw.split('\n');
  for (const line of lines) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch (e) { continue; }

    const type = o.type;
    const sid = o.sessionId;
    const tsMs = o.timestamp ? Date.parse(o.timestamp) : null;

    let s = null;
    if (sid) {
      if (!data.sessions[sid]) data.sessions[sid] = blankSession(sid);
      s = data.sessions[sid];
      if (tsMs) {
        if (!s.firstT || tsMs < s.firstT) s.firstT = tsMs;
        if (!s.lastT || tsMs > s.lastT) s.lastT = tsMs;
      }
      if (o.cwd) { s.cwd = o.cwd; s.project = projectName(o.cwd); }
    }

    if (type === 'ai-title' && s) s.title = o.aiTitle;
    if (type === 'last-prompt' && s) s.lastPrompt = o.lastPrompt;
    if (type === 'user' && s && !o.isSidechain) {
      s.userMsgs++;
      if (o.promptSource === 'typed' && tsMs) s.promptTimes.push(tsMs);
      // newer Claude Code builds no longer write the ai-title event (#4), so
      // keep the first real typed prompt around as a title of last resort.
      if (!s.fallbackTitle && o.promptSource === 'typed') {
        const txt = userText((o.message || {}).content);
        if (txt && !txt.startsWith('<') && !txt.startsWith('Caveat')) {
          s.fallbackTitle = txt.replace(/\s+/g, ' ').slice(0, 80).trim();
        }
      }
    }

    if (type === 'assistant') {
      const msg = o.message || {};
      if (s) {
        s.assistantMsgs++;
        if (msg.model && msg.model !== '<synthetic>') s.model = msg.model;
        if (o.isApiErrorMessage) s.errors++;
        if (tsMs && (!s.lastAssistantT || tsMs > s.lastAssistantT)) {
          s.lastAssistantT = tsMs;
          s.lastStopReason = msg.stop_reason || null;
          s.lastWasError = !!(o.isApiErrorMessage || o.apiErrorStatus);
        }
      }
      const u = msg.usage;
      if (u && tsMs) {
        data.tokens.push({
          t: tsMs,
          sid: sid || null,
          model: msg.model || 'unknown',
          inp: u.input_tokens || 0,
          cwr: u.cache_creation_input_tokens || 0,
          crd: u.cache_read_input_tokens || 0,
          out: u.output_tokens || 0,
        });
      }
      const content = Array.isArray(msg.content) ? msg.content : [];
      for (const c of content) {
        if (c && c.type === 'tool_use') {
          if (s) s.toolCalls++;
          data.tools.push({ t: tsMs, sid: sid || null, name: c.name, hint: toolHint(c.input) });
        }
      }
    }
  }
  return data;
}

function getFileData(fp) {
  let st;
  try { st = fs.statSync(fp); } catch (e) { return null; }
  const cached = fileCache.get(fp);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.data;
  const data = parseFile(fp);
  fileCache.set(fp, { mtimeMs: st.mtimeMs, size: st.size, data });
  return data;
}

// same, for an OpenAI Codex rollout file (cached by mtime under a codex: key)
function getCodexFileData(fp) {
  let st;
  try { st = fs.statSync(fp); } catch (e) { return null; }
  const key = 'codex:' + fp;
  const cached = fileCache.get(key);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.data;
  const data = codex.parseFile(fp);
  fileCache.set(key, { mtimeMs: st.mtimeMs, size: st.size, data });
  return data;
}

// ---- aggregation helpers ----

function entryTokens(e) {
  return e.inp + e.cwr + e.crd + e.out;
}

function entryCost(e, pricing) {
  const p = priceFor(e.model, pricing);
  return (e.inp * p.in + e.out * p.out + e.cwr * p.cacheWrite + e.crd * p.cacheRead) / 1e6;
}

function startOfLocalDay(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function startOfLocalWeek(now) {
  const d = new Date(now);
  const day = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function newBucket() {
  return { tokens: 0, cost: 0, inp: 0, out: 0, cwr: 0, crd: 0, count: 0 };
}

function addToBucket(b, e, pricing) {
  b.tokens += entryTokens(e);
  b.cost += entryCost(e, pricing);
  b.inp += e.inp; b.out += e.out; b.cwr += e.cwr; b.crd += e.crd;
  b.count++;
}

function scan(config, nowMs, calibrateAt, source) {
  const now = nowMs || Date.now();
  const pricing = config.pricing;

  const files = listJsonl(config.extraRoots);
  let allTokens = [];
  let allTools = [];
  let sessions = {};

  for (const f of files) {
    const d = getFileData(f.path);
    if (!d) continue;
    for (const e of d.tokens) allTokens.push(e);
    for (const t of d.tools) allTools.push(t);
    for (const sid of Object.keys(d.sessions)) {
      const fs0 = d.sessions[sid];
      if (f.observer) fs0.observer = true;
      if (f.label) fs0.host = f.label;
      const cur = sessions[sid];
      if (!cur) { sessions[sid] = Object.assign({}, fs0); continue; }
      // merge a session that spans multiple files
      cur.firstT = Math.min(cur.firstT || fs0.firstT, fs0.firstT || cur.firstT);
      cur.lastT = Math.max(cur.lastT || fs0.lastT, fs0.lastT || cur.lastT);
      cur.userMsgs += fs0.userMsgs;
      cur.assistantMsgs += fs0.assistantMsgs;
      cur.toolCalls += fs0.toolCalls;
      cur.errors += fs0.errors;
      cur.title = fs0.title || cur.title;
      cur.fallbackTitle = fs0.fallbackTitle || cur.fallbackTitle;
      cur.lastPrompt = fs0.lastPrompt || cur.lastPrompt;
      cur.cwd = fs0.cwd || cur.cwd;
      cur.project = fs0.project || cur.project;
      cur.model = fs0.model || cur.model;
      cur.promptTimes = (cur.promptTimes || []).concat(fs0.promptTimes || []);
      if ((fs0.lastAssistantT || 0) > (cur.lastAssistantT || 0)) {
        cur.lastAssistantT = fs0.lastAssistantT;
        cur.lastStopReason = fs0.lastStopReason;
        cur.lastWasError = fs0.lastWasError;
      }
    }
  }

  // fold in OpenAI Codex CLI sessions too (set "codex": false in config to disable)
  if (config.codex !== false) {
    const codexToolSeen = new Set();
    const codexTokSeen = new Set();
    for (const cf of codex.listCodexFiles(config.extraRoots)) {
      const d = getCodexFileData(cf.path);
      if (!d) continue;
      if (cf.label) for (const cs of Object.keys(d.sessions)) d.sessions[cs].host = cf.label;
      for (const e of d.tokens) {
        // forked rollouts replay the parent's token_count events too; the same
        // usage entry showing up in two files must only be counted once
        const k = e.sid + '|' + e.t + '|' + e.inp + '|' + e.crd + '|' + e.out;
        if (codexTokSeen.has(k)) continue;
        codexTokSeen.add(k);
        allTokens.push(e);
      }
      for (const t of d.tools) {
        // forked rollouts replay the parent's tool calls; call ids are stable
        if (t.key) { if (codexToolSeen.has(t.key)) continue; codexToolSeen.add(t.key); }
        allTools.push(t);
      }
      for (const cs of Object.keys(d.sessions)) {
        const c = d.sessions[cs];
        // forked rollouts open with a shell session_meta whose events all land
        // on the parent sid; skip these empty shells instead of listing them
        if (!c.userMsgs && !c.assistantMsgs) continue;
        const cur = sessions[cs];
        // the same sid can appear in several rollout files (fork replays);
        // keep whichever record saw the most of the conversation
        if (!cur || (cur.source === 'codex' && (c.userMsgs + c.assistantMsgs) > (cur.userMsgs + cur.assistantMsgs))) {
          sessions[cs] = Object.assign({}, c);
        }
      }
    }
  }

  // optional source filter: the Codex dashboard shows Codex numbers, the
  // Claude dashboard shows Claude numbers, instead of both showing the sum
  if (source === 'claude' || source === 'codex') {
    allTokens = allTokens.filter((e) => (e.source || 'claude') === source);
    allTools = allTools.filter((t) => (t.source || 'claude') === source);
    const keep = {};
    for (const sid of Object.keys(sessions)) {
      if ((sessions[sid].source || 'claude') === source) keep[sid] = sessions[sid];
    }
    sessions = keep;
  }

  const dayStart = startOfLocalDay(now);
  const weekStart = startOfLocalWeek(now);
  const hourStart = now - 3600 * 1000;
  const fiveHourStart = now - 5 * 3600 * 1000;
  // optional: cost in the 5h window ending at a past limit hit, used to calibrate
  // the real ceiling (what your usage actually was when you hit the limit).
  const calStart = calibrateAt ? calibrateAt - 5 * 3600 * 1000 : 0;
  const calBucket = calibrateAt ? newBucket() : null;

  const windows = {
    hour: newBucket(),
    fiveHour: newBucket(),
    today: newBucket(),
    week: newBucket(),
    total: newBucket(),
  };
  const byModel = {};
  const byProject = {};
  const bySid = {};

  // sparkline: last 24 hours, hourly
  const hourly = [];
  for (let i = 23; i >= 0; i--) {
    const hStart = now - i * 3600 * 1000;
    hourly.push({ t: hStart, tokens: 0, cost: 0 });
  }
  const hourlyBase = now - 24 * 3600 * 1000;

  // daily: last 13 weeks (the UI charts slice what they need; the profile
  // heatmap wants the full quarter)
  const daily = {};
  for (let i = 90; i >= 0; i--) {
    const d = new Date(now - i * 86400 * 1000);
    d.setHours(0, 0, 0, 0);
    const key = dateKey(d.getTime());
    daily[key] = { date: key, tokens: 0, cost: 0 };
  }

  // sid -> project for attributing tokens to projects
  const sidProject = {};
  for (const sid of Object.keys(sessions)) sidProject[sid] = sessions[sid].project || 'unknown';

  for (const e of allTokens) {
    addToBucket(windows.total, e, pricing);
    if (e.t >= hourStart) addToBucket(windows.hour, e, pricing);
    if (e.t >= fiveHourStart) addToBucket(windows.fiveHour, e, pricing);
    if (e.t >= dayStart) addToBucket(windows.today, e, pricing);
    if (e.t >= weekStart) addToBucket(windows.week, e, pricing);
    if (calBucket && e.t >= calStart && e.t <= calibrateAt) addToBucket(calBucket, e, pricing);

    const mk = modelKey(e.model);
    (byModel[mk] = byModel[mk] || newBucket());
    addToBucket(byModel[mk], e, pricing);

    const pk = sidProject[e.sid] || 'unknown';
    (byProject[pk] = byProject[pk] || newBucket());
    addToBucket(byProject[pk], e, pricing);

    if (e.t >= hourlyBase) {
      const idx = Math.min(23, Math.floor((e.t - hourlyBase) / (3600 * 1000)));
      if (hourly[idx]) { hourly[idx].tokens += entryTokens(e); hourly[idx].cost += entryCost(e, pricing); }
    }
    const dk = dateKey(e.t);
    if (daily[dk]) { daily[dk].tokens += entryTokens(e); daily[dk].cost += entryCost(e, pricing); }

    // keep a running total of tokens and cost per session id.
    // addition is done in the loop that already walks every token, so a session total costs no extra pass.
    if (e.sid) {
      const sb = bySid[e.sid] || (bySid[e.sid] = { tokens: 0, cost: 0 });
      sb.tokens += entryTokens(e);
      sb.cost += entryCost(e, pricing);
    }
  }

  // per session: the latest call defines current context, the largest call ever
  // seen defines which window (200k or 1M) that session runs on. One assistant
  // message's top-level usage is a single API call, so this is never a sum.
  const latestUsageBySid = {};
  const maxCtxBySid = {};
  for (const e of allTokens) {
    const ctx = e.inp + e.cwr + e.crd;
    // current context = latest call that actually had a prompt; synthetic /
    // injected messages report ~0 cache and would otherwise zero it out
    if (ctx > 0) {
      const cur = latestUsageBySid[e.sid];
      if (!cur || e.t > cur.t) latestUsageBySid[e.sid] = e;
    }
    if (!maxCtxBySid[e.sid] || ctx > maxCtxBySid[e.sid]) maxCtxBySid[e.sid] = ctx;
  }
  function contextFor(sid) {
    const e = latestUsageBySid[sid];
    const used = e ? (e.inp + e.cwr + e.crd) : 0;
    // Codex reports the model's real context window per task; trust it over
    // the 200k/1M guessing that Claude sessions need.
    const sess = sessions[sid];
    if (sess && sess.ctxWindow) {
      const cw = sess.ctxWindow;
      return { used, limit: cw, percent: cw ? Math.min(100, Math.round((used / cw) * 100)) : 0 };
    }
    const peak = maxCtxBySid[sid] || used;
    const limit = limitFor(peak, config.contextLimit, config.contextLimitExplicit);
    return { used, limit, percent: limit ? Math.min(100, Math.round((used / limit) * 100)) : 0 };
  }

  // most recently active session, and every session still inside the idle window
  const sessionList = Object.values(sessions)
    .filter(s => s.lastT)
    .sort((a, b) => b.lastT - a.lastT);
  const active = sessionList.length ? sessionList[0] : null;
  const context = active ? contextFor(active.sid) : { used: 0, limit: config.contextLimit || 200000, percent: 0 };

  const idleMs = (config.idleMinutes || 10) * 60 * 1000;
  const sessionsOut = sessionList.slice(0, 50).map(s => {
    const cf = contextFor(s.sid);
    const tot = bySid[s.sid] || { tokens: 0, cost: 0 };
    return {
      sid: s.sid,
      title: s.title || s.fallbackTitle || '(untitled session)',
      project: s.project || 'unknown',
      cwd: s.cwd,
      model: modelKey(s.model),
      source: s.source || 'claude',
      observer: !!s.observer,
      host: s.host || null,
      lastPrompt: s.lastPrompt,
      firstT: s.firstT,
      lastT: s.lastT,
      userMsgs: s.userMsgs,
      assistantMsgs: s.assistantMsgs,
      toolCalls: s.toolCalls,
      errors: s.errors,
      tokens: tot.tokens,
      cost: tot.cost,
      contextUsed: cf.used,
      contextLimit: cf.limit,
      contextPercent: cf.percent,
      active: now - s.lastT <= idleMs,
    };
  });

  const activity = allTools
    .filter(t => t.t)
    .sort((a, b) => b.t - a.t)
    .slice(0, 60)
    .map(t => ({
      t: t.t,
      name: t.name,
      hint: t.hint,
      project: sidProject[t.sid] || 'unknown',
    }));

  // count tool calls by name (Bash, Edit, Read, ...) across every session.
  const byTool = {};
  for (const t of allTools) {
    if (!t.name) continue;
    (byTool[t.name] = byTool[t.name] || { count: 0 }).count++;
  }

  // rough ETA for the active session: how long past turns took vs how long the
  // current one has been running. Inherently a guess, labelled as such in the UI.
  function computeEta(sid) {
    if (!sid || !sessions[sid]) return null;
    const sess = sessions[sid];
    const prompts = (sess.promptTimes || []).slice().sort((a, b) => a - b);
    const ats = allTokens.filter(e => e.sid === sid).map(e => e.t).sort((a, b) => a - b);
    if (!prompts.length && !ats.length) return null;
    const durs = [];
    for (let i = 0; i + 1 < prompts.length; i++) {
      let last = null;
      for (const t of ats) { if (t >= prompts[i] && t < prompts[i + 1]) last = t; }
      if (last !== null) durs.push(last - prompts[i]);
    }
    durs.sort((a, b) => a - b);
    const median = durs.length ? durs[Math.floor(durs.length / 2)] : null;
    const lastPrompt = prompts.length ? prompts[prompts.length - 1] : 0;
    const lastAsst = sess.lastAssistantT || (ats.length ? ats[ats.length - 1] : 0);
    const stop = sess.lastStopReason;
    const RECENT = 120 * 1000;

    // phase from stop_reason: error trumps all, tool_use = working, end_turn = done
    const recentError = sess.lastWasError && (now - lastAsst) < RECENT;
    let phase;
    if (recentError) phase = 'error';
    else if (lastPrompt > lastAsst && (now - lastPrompt) < 5 * 60 * 1000) phase = 'working';
    else if (stop === 'tool_use' && (now - lastAsst) < RECENT) phase = 'working';
    else if (stop === 'end_turn' && (now - lastAsst) < RECENT) phase = 'done';
    else phase = 'idle';

    const elapsed = now - lastPrompt;
    const remaining = (phase === 'working' && median != null) ? Math.max(0, median - elapsed) : null;
    return { phase, working: phase === 'working', elapsedMs: elapsed, medianMs: median, remainingMs: remaining, turns: durs.length };
  }
  const eta = active ? computeEta(active.sid) : null;

  // window reset estimates. Claude uses fixed windows that open at the first
  // message of a block and last a fixed length; a message past the window opens
  // a new block. We find the current block start and add the window length.
  const sortedTs = allTokens.map(e => e.t).sort((a, b) => a - b);
  function blockReset(windowMs) {
    if (!sortedTs.length) return null;
    let start = sortedTs[0];
    for (const t of sortedTs) { if (t > start + windowMs) start = t; }
    return Math.max(0, start + windowMs - now);
  }
  const resets = {
    fiveHourMs: blockReset(5 * 3600 * 1000),
    weekMs: blockReset(7 * 86400 * 1000),
  };

  // peak spend per window type = best honest proxy for the real ceiling, since
  // Anthropic does not publish limits. Percent is shown against this.
  const blockB = {}, weekB = {}, dayB = {};
  for (const e of allTokens) {
    const c = entryCost(e, pricing);
    const bk = Math.floor(e.t / (5 * 3600 * 1000));
    const wk = Math.floor(e.t / (7 * 86400 * 1000));
    const dk = dateKey(e.t);
    blockB[bk] = (blockB[bk] || 0) + c;
    weekB[wk] = (weekB[wk] || 0) + c;
    dayB[dk] = (dayB[dk] || 0) + c;
  }
  const maxOf = (o) => { let m = 0; for (const k in o) if (o[k] > m) m = o[k]; return m; };
  const peaks = { fiveHour: maxOf(blockB), day: maxOf(dayB), week: maxOf(weekB) };

  // the pulse itself: a heart rate for the dashboard. Resting ~45 bpm; tool
  // calls and generated output over the last two minutes drive it up. The
  // server may override it to 0 (flatline) while a usage limit is active.
  const twoMinStart = now - 120000;
  let tools2m = 0, outTok2m = 0;
  for (const t of allTools) if (t.t && t.t >= twoMinStart) tools2m++;
  for (const e of allTokens) if (e.t >= twoMinStart) outTok2m += e.out;
  const pulse = {
    bpm: Math.min(185, Math.round(45 + Math.min(92, tools2m * 6) + Math.min(48, outTok2m / 400))),
    tools2m,
    outTok2m,
  };

  return {
    generatedAt: now,
    plan: config.plan,
    rank: rankFor(windows.total.tokens),
    pulse,
    eta,
    resets,
    peaks,
    calCeiling: calBucket ? calBucket.cost : null,
    budgets: config.budgets,
    context,
    active: active ? sessionsOut.find(s => s.sid === active.sid) || null : null,
    activeSessions: sessionsOut.filter(s => s.active),
    windows,
    byModel,
    byProject,
    byTool,
    hourly,
    daily: Object.values(daily),
    sessions: sessionsOut,
    activity,
    totals: {
      sessions: sessionList.length,
      files: files.length,
    },
  };
}

// Effective context window for a session. Claude Code uses 200k by default and
// 1M with the long-context beta; we infer which from the largest call the
// session ever made. If the user pinned contextLimit, that value is hard.
function limitFor(peak, base, explicit) {
  const floor = base || 200000;
  if (explicit) return floor;
  if (peak <= floor) return floor;
  if (peak <= 1000000) return 1000000;
  return Math.ceil(peak / 100000) * 100000;
}

// A tongue-in-cheek rank based on all-time token throughput.
function rankFor(totalTokens) {
  const tiers = [
    [1e6, 'Lurker'],
    [1e7, 'Coder'],
    [1e8, 'Vibe Coder'],
    [5e8, 'Power Coder'],
    [2e9, 'God Coder'],
    [Infinity, 'Genius'],
  ];
  for (const [lim, name] of tiers) if (totalTokens < lim) return name;
  return 'Genius';
}

function modelKey(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('fable') || m.includes('mythos')) return 'fable';
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  return model || 'unknown';
}

function dateKey(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ---- session digest: a clean, no-noise timeline of one session ----

function userText(content) {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter(c => c && c.type === 'text' && c.text)
      .map(c => c.text)
      .join(' ')
      .trim();
  }
  return '';
}
function cap(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n).trim() + '…' : s;
}

function sessionDigest(sid, config) {
  const pricing = config && config.pricing;
  const all = listJsonl(config && config.extraRoots).map(f => f.path);
  let files = all.filter(fp => path.basename(fp) === sid + '.jsonl');
  if (!files.length) files = all; // fallback: scan everything for this sid

  let records = [];
  for (const fp of files) {
    let raw;
    try { raw = fs.readFileSync(fp, 'utf8'); } catch (e) { continue; }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let o; try { o = JSON.parse(line); } catch (e) { continue; }
      if (o.sessionId !== sid) continue;
      records.push(o);
    }
  }
  records = records
    .map((o, i) => ({ o, i, t: o.timestamp ? Date.parse(o.timestamp) : 0 }))
    .sort((a, b) => (a.t - b.t) || (a.i - b.i))
    .map(x => x.o);

  const meta = { sid, title: null, project: null, cwd: null, model: null, firstT: null, lastT: null };
  const turns = [];
  let cur = null;

  for (const o of records) {
    const t = o.timestamp ? Date.parse(o.timestamp) : null;
    if (t) { if (!meta.firstT) meta.firstT = t; meta.lastT = t; }
    if (o.type === 'ai-title') meta.title = o.aiTitle || meta.title;
    if (o.cwd) { meta.cwd = o.cwd; meta.project = projectName(o.cwd); }

    if (o.type === 'user' && !o.isSidechain && o.promptSource === 'typed') {
      const txt = userText((o.message || {}).content);
      if (!meta.title && txt && !txt.startsWith('<') && !txt.startsWith('Caveat')) {
        meta.title = txt.replace(/\s+/g, ' ').slice(0, 80).trim();
      }
      cur = { index: turns.length + 1, t: t, prompt: cap(txt, 2000), text: '', actions: [], tokens: 0, cost: 0, context: 0 };
      turns.push(cur);
    } else if (o.type === 'assistant') {
      const m = o.message || {};
      if (m.model) meta.model = m.model;
      if (!cur) { cur = { index: turns.length + 1, t: t, prompt: '(session start)', text: '', actions: [], tokens: 0, cost: 0, context: 0 }; turns.push(cur); }
      const content = Array.isArray(m.content) ? m.content : [];
      for (const c of content) {
        if (c && c.type === 'text' && c.text && c.text.trim()) cur.text += (cur.text ? '\n' : '') + c.text.trim();
        else if (c && c.type === 'tool_use') cur.actions.push({ name: c.name, hint: toolHint(c.input) });
      }
      const u = m.usage;
      if (u) {
        const e = { inp: u.input_tokens || 0, cwr: u.cache_creation_input_tokens || 0, crd: u.cache_read_input_tokens || 0, out: u.output_tokens || 0, model: m.model };
        cur.tokens += entryTokens(e);
        cur.cost += entryCost(e, pricing);
        cur.context = e.inp + e.cwr + e.crd;
      }
    }
  }

  let cum = 0, cumCost = 0;
  for (const tn of turns) { tn.text = cap(tn.text, 1600); cum += tn.tokens; cumCost += tn.cost; tn.cumTokens = cum; tn.cumCost = cumCost; }

  meta.model = modelKey(meta.model);
  return { meta, turns: turns.slice(-120) };
}

// ---- one day, expanded: what actually happened on that date ----
// Feeds the heatmap click-through: per-session tokens/cost, tool counts.
function dayDigest(date, config) {
  const pricing = config && config.pricing;
  const bySid = {};
  const byTool = {};
  const titles = {};
  let tokens = 0, cost = 0, firstT = null, lastT = null;

  const fold = (d) => {
    if (!d) return;
    for (const e of d.tokens) {
      if (dateKey(e.t) !== date) continue;
      const t = entryTokens(e), c = entryCost(e, pricing);
      tokens += t; cost += c;
      if (!firstT || e.t < firstT) firstT = e.t;
      if (!lastT || e.t > lastT) lastT = e.t;
      if (e.sid) {
        const b = bySid[e.sid] || (bySid[e.sid] = { tokens: 0, cost: 0, source: e.source || 'claude' });
        b.tokens += t; b.cost += c;
      }
    }
    for (const tl of d.tools || []) {
      if (!tl.t || dateKey(tl.t) !== date || !tl.name) continue;
      byTool[tl.name] = (byTool[tl.name] || 0) + 1;
    }
    for (const sid of Object.keys(d.sessions)) {
      const s = d.sessions[sid];
      if (!titles[sid]) titles[sid] = { title: s.title || s.fallbackTitle || null, project: s.project || null };
      else {
        if (!titles[sid].title) titles[sid].title = s.title || s.fallbackTitle || null;
        if (!titles[sid].project) titles[sid].project = s.project || null;
      }
    }
  };

  for (const f of listJsonl(config && config.extraRoots)) fold(getFileData(f.path));
  if (!config || config.codex !== false) for (const cf of codex.listCodexFiles(config && config.extraRoots)) fold(getCodexFileData(cf.path));

  const sessions = Object.keys(bySid)
    .map((sid) => ({
      sid,
      title: (titles[sid] && titles[sid].title) || '(untitled session)',
      project: (titles[sid] && titles[sid].project) || 'unknown',
      source: bySid[sid].source,
      tokens: bySid[sid].tokens,
      cost: bySid[sid].cost,
    }))
    .sort((a, b) => b.tokens - a.tokens);
  const tools = Object.keys(byTool)
    .map((name) => ({ name, count: byTool[name] }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
  return { date, tokens, cost, firstT, lastT, sessions, tools };
}

module.exports = { scan, sessionDigest, dayDigest, listJsonl, PROJECTS_DIR };
