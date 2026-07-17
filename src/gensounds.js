'use strict';

// Generate the four Pulse UI sounds with the ElevenLabs sound-effects API and
// drop them into ~/.claude-pulse/sounds/. Each sound has one job:
//   done      - Claude finished, your turn (also the Stop hook chime)
//   attention - Claude needs you: an approval or a question
//   error     - something broke / limit hit
//   sent      - a scheduled message just went out
// The dashboard picks these up automatically (falls back to the built-in
// synth tones when a file is missing). Needs ELEVENLABS_API_KEY in the env;
// one run costs a few hundred characters of quota.

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const DIR = path.join(os.homedir(), '.claude-pulse', 'sounds');

const SOUNDS = [
  { name: 'done', duration: 1.4, text: 'Short warm two-note rising marimba success chime, clean and soft, modern UI notification, no reverb tail' },
  { name: 'attention', duration: 1.2, text: 'Gentle glass bell ping, friendly attention notification asking for input, single soft note, modern UI sound' },
  { name: 'error', duration: 1.2, text: 'Soft low muted double-buzz error tone, apologetic not harsh, modern UI notification' },
  { name: 'sent', duration: 0.9, text: 'Tiny quick airy whoosh swoosh of a message being sent, light and subtle, modern UI sound' },
];

function generate(key, s) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ text: s.text, duration_seconds: s.duration, prompt_influence: 0.4 });
    const req = https.request({
      method: 'POST', hostname: 'api.elevenlabs.io', path: '/v1/sound-generation',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode !== 200) return reject(new Error(s.name + ': HTTP ' + res.statusCode + ' ' + buf.toString().slice(0, 200)));
        fs.writeFileSync(path.join(DIR, s.name + '.mp3'), buf);
        resolve(buf.length);
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function run() {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    console.log('set ELEVENLABS_API_KEY first, then run this again:');
    console.log('  export ELEVENLABS_API_KEY=...   # from elevenlabs.io -> Profile -> API keys');
    console.log('  claude-pulse gen-sounds');
    process.exit(1);
  }
  fs.mkdirSync(DIR, { recursive: true });
  console.log('generating 4 sounds via ElevenLabs...');
  for (const s of SOUNDS) {
    process.stdout.write('  ' + s.name.padEnd(10) + '- ' + s.text.slice(0, 50) + '... ');
    try {
      const bytes = await generate(key, s);
      console.log('ok (' + Math.round(bytes / 1024) + ' KB)');
    } catch (e) {
      console.log('FAILED: ' + e.message);
    }
  }
  console.log('saved to ' + DIR + ' - refresh the dashboard, it picks them up automatically.');
  console.log('do not like one? delete the file to fall back to the built-in tone, or re-run to regenerate.');
}

module.exports = { run, SOUNDS, DIR };
