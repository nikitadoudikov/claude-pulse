'use strict';

// Read a Claude Code session log straight off disk and turn it into something
// a human can read: a light markdown transcript, a phone friendly HTML page, or
// a short terminal recap. Works with no server and no live session, because the
// jsonl under ~/.claude/projects is written as the session happens and survives
// the terminal that made it.

const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

function listSessions() {
  const out = [];
  let dirs;
  try { dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }); } catch (e) { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const p = path.join(PROJECTS_DIR, d.name);
    let files;
    try { files = fs.readdirSync(p); } catch (e) { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const fp = path.join(p, f);
      let st;
      try { st = fs.statSync(fp); } catch (e) { continue; }
      // newer Claude Code builds write background "observer" transcripts next
      // to real sessions; tag them so the UI can hide them by default
      out.push({ sid: f.replace(/\.jsonl$/, ''), file: fp, mtimeMs: st.mtimeMs, size: st.size, observer: /^observer\b/i.test(f) });
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

function findSession(arg) {
  const all = listSessions();
  if (!arg || arg === 'latest') return all[0] || null;
  return all.find((s) => s.sid === arg) || all.find((s) => s.sid.startsWith(arg)) || null;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
  return '';
}

function toolHint(input) {
  if (!input || typeof input !== 'object') return '';
  const h = input.file_path || input.command || input.pattern || input.description ||
            input.url || input.path || input.query || '';
  return String(h).replace(/\s+/g, ' ').trim().slice(0, 100);
}

// Parse a session file into { meta, blocks } where blocks is an ordered list of
// { role: 'user'|'claude', text, tools: [{name, hint, input}] }.
function parseLog(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const blocks = [];
  const meta = { sid: path.basename(file).replace(/\.jsonl$/, ''), title: null, project: 'unknown',
    cwd: null, model: null, firstT: null, lastT: null, users: 0, assists: 0, tools: 0 };

  for (const line of lines) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch (e) { continue; }
    const m = o.message;
    if (o.timestamp) { if (!meta.firstT) meta.firstT = o.timestamp; meta.lastT = o.timestamp; }
    if (o.cwd) { meta.cwd = o.cwd; meta.project = path.basename(o.cwd); }
    if (!m) continue;

    if (o.type === 'user') {
      const t = textOf(m.content).trim();
      if (!t || t.startsWith('<') || t.startsWith('Caveat')) continue; // skip system-injected
      meta.users++;
      if (!meta.title) meta.title = t.slice(0, 80).replace(/\s+/g, ' ');
      blocks.push({ role: 'user', text: t, tools: [] });
    } else if (o.type === 'assistant' && Array.isArray(m.content)) {
      if (m.model) meta.model = m.model;
      let text = '', tools = [];
      for (const p of m.content) {
        if (p.type === 'text' && p.text && p.text.trim()) text += (text ? '\n' : '') + p.text;
        else if (p.type === 'tool_use') { meta.tools++; tools.push({ name: p.name, hint: toolHint(p.input), input: p.input }); }
      }
      if (text || tools.length) { meta.assists++; blocks.push({ role: 'claude', text, tools }); }
    }
  }
  return { meta, blocks };
}

function metaLines(meta) {
  return [
    `- project: ${meta.project}${meta.cwd ? ` (${meta.cwd})` : ''}`,
    `- model: ${meta.model || 'unknown'}`,
    `- started: ${meta.firstT || '?'}`,
    `- last activity: ${meta.lastT || '?'}`,
    `- ${meta.users} prompts, ${meta.assists} replies, ${meta.tools} tool calls`,
  ];
}

function renderMarkdown(file, opts = {}) {
  const { meta, blocks } = parseLog(file);
  const parts = [`# Session ${meta.sid}`, '', ...metaLines(meta),
    meta.title ? `- title: ${meta.title}` : '', '', '---'];
  for (const b of blocks) {
    if (b.role === 'user') { parts.push(`\n### You\n\n${b.text}`); continue; }
    parts.push('\n### Claude\n');
    if (b.text) parts.push(b.text);
    for (const t of b.tools) {
      parts.push(`- \`${t.name}\`${t.hint ? ' ' + t.hint : ''}`);
      if (opts.full && t.input) parts.push('  ```\n  ' + JSON.stringify(t.input).slice(0, 2000) + '\n  ```');
    }
  }
  return parts.filter((x) => x !== '').join('\n');
}

// A short, terminal friendly recap: header plus the last n exchanges.
function recapText(file, n = 6) {
  const { meta, blocks } = parseLog(file);
  const out = [];
  out.push(`session ${meta.sid.slice(0, 8)}  ${meta.project}`);
  if (meta.title) out.push(`title: ${meta.title}`);
  out.push(`${meta.users} prompts, ${meta.assists} replies, last activity ${meta.lastT || '?'}`);
  out.push('');
  out.push(`last ${Math.min(n, blocks.length)} exchanges:`);
  for (const b of blocks.slice(-n)) {
    const who = b.role === 'user' ? 'YOU  ' : 'CLAUDE';
    let line = b.text ? b.text.replace(/\s+/g, ' ').trim() : '';
    if (!line && b.tools.length) line = b.tools.map((t) => t.name).join(', ');
    out.push(`  [${who}] ${line.slice(0, 160)}`);
  }
  return out.join('\n');
}

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// A self contained, phone readable HTML page in the Pulse palette.
function renderHtmlPage(file) {
  const { meta, blocks } = parseLog(file);
  const body = blocks.map((b) => {
    if (b.role === 'user') {
      return '<div class="t t--you"><div class="who">You</div><div class="body">' + escHtml(b.text) + '</div></div>';
    }
    let inner = b.text ? '<div class="body">' + escHtml(b.text) + '</div>' : '';
    if (b.tools.length) {
      inner += '<div class="tools">' + b.tools.map((t) =>
        '<span class="tool"><b>' + escHtml(t.name) + '</b>' + (t.hint ? ' ' + escHtml(t.hint) : '') + '</span>').join('') + '</div>';
    }
    return '<div class="t t--claude"><div class="who">Claude</div>' + inner + '</div>';
  }).join('\n');

  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(meta.title || meta.sid)} · Pulse transcript</title>
<style>
:root{--bg:#1c1b19;--card:#26241f;--ink:#ece7df;--dim:#9a958c;--accent:#d97757;--line:#3a372f}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 -apple-system,system-ui,Segoe UI,Roboto,sans-serif;padding:16px;max-width:820px;margin:0 auto}
h1{font-size:18px;margin:4px 0 2px}
.meta{color:var(--dim);font-size:13px;margin-bottom:16px}
.meta a{color:var(--accent);text-decoration:none}
.t{border:1px solid var(--line);border-radius:12px;padding:10px 13px;margin:10px 0;background:var(--card)}
.t--you{border-color:var(--accent)}
.who{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);margin-bottom:5px}
.t--you .who{color:var(--accent)}
.body{white-space:pre-wrap;word-wrap:break-word}
.tools{margin-top:8px;display:flex;flex-direction:column;gap:3px}
.tool{font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dim)}
.tool b{color:var(--ink)}
</style></head><body>
<h1>${escHtml(meta.title || '(untitled session)')}</h1>
<div class="meta">${escHtml(meta.project)} · ${meta.model || 'unknown'} · ${meta.users} prompts · ${meta.assists} replies ·
<a href="/api/export?sid=${encodeURIComponent(meta.sid)}&dl=1">download .md</a></div>
${body}
</body></html>`;
}

// Write a markdown export under ~/.claude-pulse/exports and return where it went.
function saveExport(session, opts = {}) {
  const zlib = require('zlib');
  const outDir = path.join(os.homedir(), '.claude-pulse', 'exports');
  const md = renderMarkdown(session.file, { full: opts.full });
  try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) {}
  const stamp = new Date().toISOString().slice(0, 10);
  const dest = path.join(outDir, `${session.sid.slice(0, 8)}-${stamp}.md`);
  fs.writeFileSync(dest, md);
  const result = { md, path: dest, gz: null };
  if (opts.gz) { result.gz = dest + '.gz'; fs.writeFileSync(result.gz, zlib.gzipSync(md)); }
  return result;
}

// One markdown blob of every session on disk, newest first. Gzips small.
function combinedMarkdown(opts = {}) {
  const parts = [];
  for (const s of listSessions()) {
    try { parts.push(renderMarkdown(s.file, opts), '\n\n' + '='.repeat(72) + '\n\n'); } catch (e) {}
  }
  return parts.join('');
}

module.exports = {
  PROJECTS_DIR, listSessions, findSession, parseLog,
  renderMarkdown, renderHtmlPage, recapText, metaLines, saveExport, combinedMarkdown,
};
