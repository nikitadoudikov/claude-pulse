#!/usr/bin/env node
'use strict';

const os = require('os');
const { spawn } = require('child_process');
const { start } = require('../src/server');

const COMMANDS = new Set(['run', 'start', 'stop', 'restart', 'status', 'recover', 'export-all',
  'install-hooks', 'uninstall-hooks', 'install-service', 'uninstall-service', 'notch', 'gen-sounds']);

function lanIp() {
  try {
    const ifs = os.networkInterfaces();
    for (const k in ifs) for (const a of ifs[k]) if (a.family === 'IPv4' && !a.internal) return a.address;
  } catch (e) {}
  return '';
}

function parseArgs(argv) {
  const out = { port: 4317, open: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') out.port = parseInt(argv[++i], 10) || out.port;
    else if (a === '--no-open') out.open = false;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--version' || a === '-v') out.version = true;
  }
  return out;
}

function openBrowser(url) {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open';
  try {
    const child = spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: platform === 'win32' });
    child.unref();
  } catch (e) {}
}

function printHelp() {
  console.log(`claude-pulse - local dashboard for Claude Code

Usage: claude-pulse [command] [options]

Commands:
  (none) / run        run in the foreground (ctrl+c to stop)
  start               run in the background, survives closing the terminal
  stop                stop the background instance
  restart             restart the background instance
  status              show whether Pulse is running
  recover [n|id]      show + save the last session (lost it after a crash? run this)
  export-all          save every session as one small gzipped markdown file
  notch               tiny always-visible strip under the MacBook notch (needs Chrome)
  gen-sounds          generate custom UI sounds with ElevenLabs (needs ELEVENLABS_API_KEY)
  install-hooks       wire the Pulse hooks into ~/.claude/settings.json
  uninstall-hooks     remove the Pulse hooks from ~/.claude/settings.json
  install-service     macOS: start at login and auto-restart if it dies
  uninstall-service   macOS: remove the login service

Options:
  -p, --port <n>   port to listen on (default 4317)
      --no-open    do not open the browser automatically
  -h, --help       show this help
  -v, --version    show version
`);
}

function recover(rest) {
  const t = require('../src/transcript');
  const daemon = require('../src/daemon');
  const positional = rest.find((a) => !a.startsWith('-'));
  const sessions = t.listSessions();
  if (!sessions.length) { console.log('no sessions found under ~/.claude/projects'); return; }

  let s;
  if (positional && /^\d+$/.test(positional)) s = sessions[parseInt(positional, 10) - 1];
  else if (positional) s = sessions.find((x) => x.sid.startsWith(positional));
  else s = sessions[0];
  if (!s) { console.log(`no session for "${positional}". recent ones:`); sessions.slice(0, 6).forEach((x, i) => console.log(`  ${i + 1}. ${x.sid.slice(0, 8)}  ${new Date(x.mtimeMs).toISOString().slice(0, 16).replace('T', ' ')}`)); return; }

  console.log('');
  console.log(t.recapText(s.file, 8));
  const r = t.saveExport(s, {});
  const running = daemon.running();
  const port = running ? running.port : 4317;
  console.log('');
  console.log(`full transcript saved: ${r.path}`);
  console.log(`read it in the browser or on your phone: http://127.0.0.1:${port}/transcript?sid=${s.sid}`);
  if (sessions.length > 1) console.log(`a different one? claude-pulse recover 2  (or an id)`);
}

// A notch-style strip: a small chromeless browser window pinned top-center,
// showing state + approvals. Shared logic lives in src/notchlaunch.js so the
// dashboard button can do the same thing.
function openNotch(args) {
  const daemon = require('../src/daemon');
  const running = daemon.running();
  const port = (running && running.port) || args.port || 4317;
  const r = require('../src/notchlaunch').launch(port);
  if (r.ok) {
    console.log(`notch opened via ${r.via} at ${r.url}`);
    console.log('tip: drag it under the camera notch once; Chrome remembers the spot');
  } else {
    openBrowser(r.url);
    console.log('no Chromium browser found for the chromeless window; opened as a normal tab: ' + r.url);
  }
}

function installHooks() {
  const r = require('../src/hooksetup').installHooks();
  if (r.added) console.log(`wired ${r.added} hook(s) into ~/.claude/settings.json`);
  if (r.already) console.log(`${r.already} hook(s) were already set`);
  console.log('restart Claude Code (or open a new session) for the hooks to take effect');
}

function uninstallHooks() {
  const r = require('../src/hooksetup').uninstallHooks();
  console.log(r.removed ? `removed Pulse hooks from ${r.removed} event(s)` : 'no Pulse hooks were set');
}

function exportAll(rest) {
  const t = require('../src/transcript');
  const zlib = require('zlib');
  const fs = require('fs'), os = require('os'), path = require('path');
  const md = t.combinedMarkdown({ full: rest.indexOf('--full') !== -1 });
  const dir = path.join(os.homedir(), '.claude-pulse', 'exports');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  const dest = path.join(dir, 'history-' + new Date().toISOString().slice(0, 10) + '.md.gz');
  fs.writeFileSync(dest, zlib.gzipSync(md));
  console.log('exported every session to one file:');
  console.log(`  ${dest}`);
  console.log(`  ${(Buffer.byteLength(md) / 1048576).toFixed(1)} MB markdown -> ${(fs.statSync(dest).size / 1024).toFixed(0)} KB gzipped`);
}

async function runForeground(args) {
  try {
    const { port } = await start({ port: args.port });
    const url = `http://127.0.0.1:${port}`;
    console.log(`\n  Pulse for Claude Code`);
    console.log(`  running at ${url}`);
    console.log(`  reading ~/.claude/projects (read only)`);
    const cfg = require('../src/config').loadConfig();
    if (cfg.bindLan) {
      const ip = lanIp();
      if (ip) console.log(`  on your network: http://${ip}:${port}`);
    }
    console.log(cfg.ntfyTopic
      ? `  phone push: ntfy topic "${cfg.ntfyTopic}"`
      : `  phone push: set "ntfyTopic" in ~/.claude-pulse.json`);
    console.log(`\n  press ctrl+c to stop\n`);
    if (args.open) openBrowser(url);
  } catch (e) {
    if (e && e.code === 'EADDRINUSE') {
      console.error(`\n  port ${args.port} is busy. is Pulse already running? try: claude-pulse status`);
      console.error(`  or pick another port: claude-pulse --port ${args.port + 1}\n`);
    } else {
      console.error('  failed to start:', e && e.message);
    }
    process.exit(1);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] && !argv[0].startsWith('-') && COMMANDS.has(argv[0]) ? argv[0] : null;
  const args = parseArgs(cmd ? argv.slice(1) : argv);

  if (args.help) { printHelp(); return; }
  if (args.version) { console.log(require('../package.json').version); return; }

  if (cmd && cmd !== 'run') {
    const daemon = require('../src/daemon');
    if (cmd === 'start') return daemon.start({ port: args.port });
    if (cmd === 'stop') return daemon.stop();
    if (cmd === 'restart') return daemon.restart({ port: args.port });
    if (cmd === 'status') return daemon.status();
    if (cmd === 'recover') return recover(argv.slice(1));
    if (cmd === 'export-all') return exportAll(argv.slice(1));
    if (cmd === 'notch') return openNotch(args);
    if (cmd === 'gen-sounds') return require('../src/gensounds').run();
    if (cmd === 'install-hooks') return installHooks();
    if (cmd === 'uninstall-hooks') return uninstallHooks();
    if (cmd === 'install-service') return daemon.installService({ port: args.port });
    if (cmd === 'uninstall-service') return daemon.uninstallService();
  }

  await runForeground(args);
}

main();
