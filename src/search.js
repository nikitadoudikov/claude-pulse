'use strict';

// Full text search across every Claude Code session on disk. Reads the raw log
// for a fast substring reject, then parses only the files that actually match to
// pull out a title and a few snippets. Sessions come back newest first.

const fs = require('fs');
const transcript = require('./transcript');

function snippetAround(text, q) {
  const i = text.toLowerCase().indexOf(q);
  if (i === -1) return null;
  const start = Math.max(0, i - 50);
  const end = Math.min(text.length, i + q.length + 80);
  return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ').trim() + (end < text.length ? '…' : '');
}

function searchSessions(query, opts = {}) {
  const q = String(query || '').toLowerCase().trim();
  if (q.length < 2) return [];
  const limit = opts.limit || 40;
  const out = [];
  for (const s of transcript.listSessions()) {
    let raw;
    try { raw = fs.readFileSync(s.file, 'utf8'); } catch (e) { continue; }
    if (raw.toLowerCase().indexOf(q) === -1) continue; // fast skip non-matching files

    const { meta, blocks } = transcript.parseLog(s.file);
    let count = 0;
    const snippets = [];
    for (const b of blocks) {
      if (!b.text) continue;
      const lt = b.text.toLowerCase();
      let idx = lt.indexOf(q);
      while (idx !== -1) { count++; idx = lt.indexOf(q, idx + q.length); }
      if (snippets.length < 3) { const sn = snippetAround(b.text, q); if (sn) snippets.push({ role: b.role, text: sn }); }
    }
    if (!count) continue;
    // meta.lastT is the raw ISO string from the log; the UI wants epoch ms
    const lastMs = meta.lastT ? Date.parse(meta.lastT) || null : null;
    out.push({ sid: meta.sid, title: meta.title, project: meta.project, lastT: lastMs, observer: !!s.observer, host: s.host || null, count, snippets });
    if (out.length >= limit) break;
  }
  return out;
}

module.exports = { searchSessions };
