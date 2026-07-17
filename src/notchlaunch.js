'use strict';

// Open the notch strip as a chromeless top-center window. Shared by the CLI
// (`claude-pulse notch`) and the dashboard button (POST /api/notch-open).
// Chrome's app mode provides the chromeless window; true always-on-top would
// need a native app, so this is the zero-dep version.

const { execSync, spawn } = require('child_process');

const W = 470, H = 190;

function launch(port) {
  const url = `http://127.0.0.1:${port || 4317}/notch`;
  let x = 500;
  if (process.platform === 'darwin') {
    try {
      const b = execSync("osascript -e 'tell application \"Finder\" to get bounds of window of desktop'", { timeout: 3000 })
        .toString().trim().split(',').map((n) => parseInt(n, 10));
      if (b[2]) x = Math.round((b[2] - W) / 2);
    } catch (e) {}
  }
  const chromes = process.platform === 'darwin'
    ? ['Google Chrome', 'Chromium', 'Brave Browser', 'Microsoft Edge', 'Arc']
    : [];
  for (const app of chromes) {
    try {
      const child = spawn('open', ['-na', app, '--args', '--app=' + url,
        `--window-size=${W},${H}`, `--window-position=${x},0`], { stdio: 'ignore', detached: true });
      child.unref();
      return { ok: true, via: app, url };
    } catch (e) {}
  }
  return { ok: false, url };
}

module.exports = { launch, W, H };
