'use strict';

// Open the notch strip. Preferred: a tiny native always-on-top overlay
// (native/PulseNotch.swift, compiled once with the Xcode CLI tools) that
// floats above every app and every Space. Fallbacks: a Chrome app-mode
// window, then a plain browser tab. Shared by `claude-pulse notch` and the
// dashboard button (POST /api/notch-open).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawn } = require('child_process');

const W = 470, H = 190;
const BIN = path.join(os.homedir(), '.claude-pulse', 'PulseNotch');
const SRC = path.join(__dirname, '..', 'native', 'PulseNotch.swift');

function stopNative() {
  try { execSync('pkill -x PulseNotch', { stdio: 'ignore' }); return true; } catch (e) { return false; }
}

// compile once (and again only when the source changes); ~10s with swiftc
function ensureBinary() {
  let need = true;
  try {
    const bs = fs.statSync(BIN);
    const ss = fs.statSync(SRC);
    need = ss.mtimeMs > bs.mtimeMs;
  } catch (e) {}
  if (!need) return true;
  try { execSync('xcrun --find swiftc', { stdio: 'ignore', timeout: 10000 }); } catch (e) { return false; }
  try {
    fs.mkdirSync(path.dirname(BIN), { recursive: true });
    execSync(`xcrun -sdk macosx swiftc -O -o ${JSON.stringify(BIN)} ${JSON.stringify(SRC)}`,
      { stdio: 'ignore', timeout: 180000 });
    return true;
  } catch (e) { return false; }
}

function launchNative(url) {
  if (process.platform !== 'darwin') return null;
  if (!ensureBinary()) return null;
  stopNative(); // re-opening should move the strip to the front, not stack copies
  try {
    const child = spawn(BIN, [url], { stdio: 'ignore', detached: true });
    child.unref();
    return { ok: true, via: 'native overlay (always on top; right-click it to close)', url };
  } catch (e) { return null; }
}

function launchChromeApp(url) {
  let x = 500;
  try {
    const b = execSync("osascript -e 'tell application \"Finder\" to get bounds of window of desktop'", { timeout: 3000 })
      .toString().trim().split(',').map((n) => parseInt(n, 10));
    if (b[2]) x = Math.round((b[2] - W) / 2);
  } catch (e) {}
  const chromes = ['Google Chrome', 'Chromium', 'Brave Browser', 'Microsoft Edge', 'Arc'];
  for (const app of chromes) {
    try {
      const child = spawn('open', ['-na', app, '--args', '--app=' + url,
        `--window-size=${W},${H}`, `--window-position=${x},0`], { stdio: 'ignore', detached: true });
      child.unref();
      return { ok: true, via: app + ' app window', url };
    } catch (e) {}
  }
  return null;
}

function launch(port) {
  const url = `http://127.0.0.1:${port || 4317}/notch`;
  const native = launchNative(url);
  if (native) return native;
  if (process.platform === 'darwin') {
    const chrome = launchChromeApp(url);
    if (chrome) return chrome;
  }
  return { ok: false, url };
}

module.exports = { launch, stopNative, W, H };
