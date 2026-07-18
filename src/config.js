'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// API list prices per 1M tokens (USD). Used only to estimate an
// "API-equivalent" cost for subscription users, who do not pay per token.
// Override any of these in ~/.claude-pulse.json -> "pricing".
const PRICING = {
  fable:   { in: 10, out: 50, cacheWrite: 12.5,  cacheRead: 1 },   // Claude Fable 5 / Mythos 5
  opus:    { in: 5,  out: 25, cacheWrite: 6.25,  cacheRead: 0.5 }, // Opus 4.5 and later
  opusLegacy: { in: 15, out: 75, cacheWrite: 18.75, cacheRead: 1.5 }, // Opus 4.1 and older
  sonnet:  { in: 3,  out: 15, cacheWrite: 3.75,  cacheRead: 0.3 },
  haiku:   { in: 1,  out: 5,  cacheWrite: 1.25,  cacheRead: 0.1 },
  gpt:     { in: 1.25, out: 10, cacheWrite: 1.25, cacheRead: 0.125 }, // OpenAI Codex, rough GPT-5 class estimate
  default: { in: 3,  out: 15, cacheWrite: 3.75,  cacheRead: 0.3 },
};

// Anthropic does not publish exact subscription limits, and they are usage
// based rather than a hard token number. These are rough API-equivalent
// budgets (USD) per rolling window, meant as a starting point. Edit them in
// ~/.claude-pulse.json -> "budgets" to match what you actually observe.
const PLAN_BUDGETS = {
  pro:    { fiveHour: 8,   day: 20,  week: 60 },
  max5:   { fiveHour: 35,  day: 90,  week: 280 },
  max20:  { fiveHour: 140, day: 360, week: 1100 },
  custom: { fiveHour: null, day: null, week: null },
};

function priceFor(model, pricing) {
  const p = pricing || PRICING;
  const m = String(model || '').toLowerCase();
  if (p.fable && (m.includes('fable') || m.includes('mythos'))) return p.fable;
  if (m.includes('opus')) {
    // Opus 4.5 dropped to $5/$25; 4.1 and older stay at the old $15/$75
    const legacy = /opus-(3|4-0|4-1)\b/.test(m) || m.includes('claude-3-opus');
    return (legacy && p.opusLegacy) || p.opus;
  }
  if (m.includes('sonnet')) return p.sonnet;
  if (m.includes('haiku')) return p.haiku;
  if (p.gpt && (m.includes('gpt') || m.includes('codex'))) return p.gpt;
  return p.default;
}

function configPath() {
  return path.join(os.homedir(), '.claude-pulse.json');
}

function loadConfig() {
  const defaults = {
    plan: 'unknown',      // we cannot detect the real plan, so never claim one
    contextLimit: 200000, // Opus/Sonnet default; 1M is auto-detected per session
    idleMinutes: 10,      // a session is "active" if it moved within this window
    pricing: PRICING,
    budgets: null,        // filled from the plan preset unless set explicitly
    ntfyTopic: '',        // ntfy topic for phone push; empty = off
    ntfyServer: 'https://ntfy.sh', // ntfy server base URL (self-hosted or ntfy.sh)
    ntfyToken: '',        // ntfy access token for reserved/protected topics; empty = anonymous
    ntfyPushApproval: true,     // phone push for approval prompts (permission hook)
    ntfyPushNotification: true, // phone push for "Claude needs you" (notification hook)
    ntfyPushStop: true,         // phone push for "Claude finished" (stop hook)
    bindLan: false,       // listen on the LAN so a phone on Wi-Fi can approve
    lanUrl: '',           // e.g. http://192.168.1.20:4317 ; enables phone Allow buttons
    approvalTimeoutMs: 60000, // how long the Allow hook waits for you before the normal prompt
    snapshotMinutes: 15,  // auto-save a light export of active sessions this often (0 = off)
  };

  let user = {};
  try {
    user = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch (e) {
    // no user config yet, defaults are fine
  }

  const cfg = Object.assign({}, defaults, user);
  cfg.pricing = Object.assign({}, PRICING, user.pricing || {});
  // extra session roots (e.g. rsync'd mirrors of another host), unified into
  // the same dashboard. Each: { label, claudeProjects?, codexSessions? }.
  // CLAUDE_PULSE_EXTRA_ROOTS (JSON array) overrides the config file entry.
  let roots = user.extraRoots;
  if (process.env.CLAUDE_PULSE_EXTRA_ROOTS) {
    try { roots = JSON.parse(process.env.CLAUDE_PULSE_EXTRA_ROOTS); } catch (e) {}
  }
  cfg.extraRoots = Array.isArray(roots)
    ? roots.filter((r) => r && (r.claudeProjects || r.codexSessions))
        .map((r) => ({
          label: String(r.label || 'remote'),
          claudeProjects: r.claudeProjects ? String(r.claudeProjects) : null,
          codexSessions: r.codexSessions ? String(r.codexSessions) : null,
        }))
    : [];
  // Budgets are opt-in only. We never derive a USD budget from the plan: real
  // subscription limits are not exposed by Anthropic, and the API-equivalent
  // cost dwarfs any small preset, which produced nonsense like "2232% of limit".
  cfg.budgets = user.budgets || { fiveHour: null, day: null, week: null };
  // if the user pinned contextLimit explicitly, never auto-bump it to 1M
  cfg.contextLimitExplicit = Object.prototype.hasOwnProperty.call(user, 'contextLimit');
  return cfg;
}

function saveConfig(partial) {
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch (e) {}
  const next = Object.assign({}, cur, partial || {});
  // when the plan changes, drop stale explicit budgets so the preset applies
  if (partial && partial.plan && !partial.budgets) delete next.budgets;
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2));
  return loadConfig();
}

module.exports = { loadConfig, saveConfig, priceFor, PRICING, PLAN_BUDGETS, configPath };
