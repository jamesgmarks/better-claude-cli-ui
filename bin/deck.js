#!/usr/bin/env node
/* claude-deck CLI: install | uninstall | status | start
 *
 * install    clones the app to ~/.local/share/claude-deck/app, runs it as a
 *            systemd --user service, and registers the claude-deck:// URL
 *            scheme so the web page can wake it with one click
 * uninstall  removes every file install created (service, handler, app dir)
 * status     shows service + server state
 * start      runs the server in the foreground from the current checkout
 */
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const HOME = os.homedir();
const REPO_URL = process.env.DECK_REPO_URL || 'https://github.com/amirbukhari/better-claude-cli-ui.git';
const APP_ROOT = path.join(HOME, '.local', 'share', 'claude-deck');
const APP_DIR = path.join(APP_ROOT, 'app');
const HANDLER = path.join(APP_ROOT, 'open.sh');
const SERVICE_FILE = path.join(HOME, '.config', 'systemd', 'user', 'claude-deck.service');
const DESKTOP_DIR = path.join(HOME, '.local', 'share', 'applications');
const DESKTOP_FILE = path.join(DESKTOP_DIR, 'claude-deck.desktop');
const MIMEAPPS = path.join(HOME, '.config', 'mimeapps.list');
const PORT = process.env.PORT || '3456';
const SELF_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const log = m => console.log(m);
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });
const tryRun = (cmd, args, opts = {}) => spawnSync(cmd, args, { stdio: 'pipe', encoding: 'utf8', ...opts });
const hasSystemd = () => tryRun('systemctl', ['--user', 'is-system-running']).status !== null
  && !/not been booted|Failed to connect/i.test(tryRun('systemctl', ['--user', 'is-system-running']).stderr || '');

function npmInstall(dir) {
  log('  installing dependencies (node-pty compiles natively — may take a minute)…');
  const plain = tryRun('npm', ['install', '--omit=dev', '--no-fund', '--no-audit'], { cwd: dir, stdio: 'inherit' });
  if (plain.status === 0) return;
  const shim = path.join(dir, 'tools', 'g++20-shim');
  if (fs.existsSync(shim)) {
    log('  plain build failed — retrying with the bundled g++20 shim (old-GCC systems)…');
    run('npm', ['install', '--omit=dev', '--no-fund', '--no-audit'], { cwd: dir, env: { ...process.env, CXX: shim } });
  } else {
    throw new Error('npm install failed');
  }
}

function install() {
  if (process.platform !== 'linux') {
    log(`Sorry — the installer currently supports Linux only (you're on ${process.platform}).`);
    log('You can still run the server directly: npx github:amirbukhari/better-claude-cli-ui start');
    process.exit(1);
  }

  log('Installing Claude Deck…');
  fs.mkdirSync(APP_ROOT, { recursive: true });

  // 1. app checkout (a git clone, so updates are just `git pull`)
  if (fs.existsSync(path.join(APP_DIR, '.git'))) {
    log(`  updating existing checkout at ${APP_DIR}`);
    run('git', ['-C', APP_DIR, 'pull', '--ff-only']);
  } else {
    log(`  cloning ${REPO_URL}`);
    run('git', ['clone', '--depth', '1', REPO_URL, APP_DIR]);
  }
  npmInstall(APP_DIR);

  // 2. protocol handler script — claude-deck:// links land here
  fs.writeFileSync(HANDLER, `#!/bin/bash
# claude-deck:// URL handler: make sure the server is up, then open the UI
if command -v systemctl >/dev/null && systemctl --user list-unit-files claude-deck.service >/dev/null 2>&1; then
  systemctl --user start claude-deck.service
else
  curl -sf -m 2 http://127.0.0.1:${PORT}/api/state >/dev/null 2>&1 || \\
    setsid nohup "${process.execPath}" "${APP_DIR}/server.js" >/dev/null 2>&1 &
fi
for i in $(seq 1 20); do curl -sf -m 1 http://127.0.0.1:${PORT}/api/state >/dev/null 2>&1 && break; sleep 0.5; done
xdg-open "http://127.0.0.1:${PORT}"
`, { mode: 0o755 });
  log(`  wrote ${HANDLER}`);

  // 3. systemd --user service (auto-restarts, survives logout with linger)
  if (hasSystemd()) {
    fs.mkdirSync(path.dirname(SERVICE_FILE), { recursive: true });
    fs.writeFileSync(SERVICE_FILE, `[Unit]
Description=Claude Deck (Amir Hates The Claude CLI UI)

[Service]
ExecStart=${process.execPath} ${APP_DIR}/server.js
WorkingDirectory=${APP_DIR}
Environment=PORT=${PORT}
Environment=DECK_INSTALLED=1
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`);
    run('systemctl', ['--user', 'daemon-reload']);
    run('systemctl', ['--user', 'enable', '--now', 'claude-deck.service']);
    log(`  service enabled: systemctl --user status claude-deck`);
  } else {
    log('  (no systemd --user found — skipping service; the claude-deck:// handler will start the server on demand)');
  }

  // 4. register the claude-deck:// URL scheme
  fs.mkdirSync(DESKTOP_DIR, { recursive: true });
  fs.writeFileSync(DESKTOP_FILE, `[Desktop Entry]
Type=Application
Name=Claude Deck
Exec=${HANDLER} %u
MimeType=x-scheme-handler/claude-deck;
NoDisplay=true
`);
  tryRun('update-desktop-database', [DESKTOP_DIR]);
  tryRun('xdg-mime', ['default', 'claude-deck.desktop', 'x-scheme-handler/claude-deck']);
  log('  registered claude-deck:// URL scheme');

  const token = readToken();
  log('\nDone. Open the Deck:');
  log(`  local:  http://127.0.0.1:${PORT}`);
  if (token) log(`  from GitHub Pages: use server http://127.0.0.1:${PORT} + token ${token}`);
  log('  from a claude-deck:// link: it now opens with one click');
  log('\nUninstall any time with: npx github:amirbukhari/better-claude-cli-ui uninstall');
}

function readToken() {
  try { return fs.readFileSync(path.join(APP_DIR, '.deck-token'), 'utf8').trim(); } catch { return ''; }
}

async function uninstall() {
  const yes = process.argv.includes('--yes') || process.argv.includes('-y');
  if (!yes) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise(r => rl.question(
      `This removes the Claude Deck service, the claude-deck:// handler, and ${APP_ROOT}.\n` +
      'Your Claude Code config and conversations are NOT touched. Continue? [y/N] ', r));
    rl.close();
    if (!/^y(es)?$/i.test(answer.trim())) { log('Aborted — nothing removed.'); return; }
  }

  if (hasSystemd()) {
    tryRun('systemctl', ['--user', 'disable', '--now', 'claude-deck.service']);
    if (fs.existsSync(SERVICE_FILE)) { fs.rmSync(SERVICE_FILE); log(`  removed ${SERVICE_FILE}`); }
    tryRun('systemctl', ['--user', 'daemon-reload']);
  }

  if (fs.existsSync(DESKTOP_FILE)) { fs.rmSync(DESKTOP_FILE); log(`  removed ${DESKTOP_FILE}`); }
  tryRun('update-desktop-database', [DESKTOP_DIR]);
  try { // drop our scheme line from mimeapps.list
    const lines = fs.readFileSync(MIMEAPPS, 'utf8').split('\n');
    const kept = lines.filter(l => !l.includes('x-scheme-handler/claude-deck'));
    if (kept.length !== lines.length) {
      fs.writeFileSync(MIMEAPPS, kept.join('\n'));
      log(`  cleaned claude-deck entry from ${MIMEAPPS}`);
    }
  } catch {}

  if (fs.existsSync(APP_ROOT)) { fs.rmSync(APP_ROOT, { recursive: true, force: true }); log(`  removed ${APP_ROOT}`); }
  log('Uninstalled. (~/.claude and your conversations were left untouched.)');
}

function status() {
  if (hasSystemd()) {
    const r = tryRun('systemctl', ['--user', 'is-active', 'claude-deck.service']);
    log(`service: ${(r.stdout || '').trim() || 'not installed'}`);
  }
  const ping = tryRun('curl', ['-sf', '-m', '2', `http://127.0.0.1:${PORT}/api/state`]);
  log(`server:  ${ping.status === 0 ? `responding on :${PORT}` : 'not responding'}`);
  log(`app dir: ${fs.existsSync(APP_DIR) ? APP_DIR : '(not installed — running from a checkout?)'}`);
}

const cmd = process.argv[2] || 'start';
if (cmd === 'install') install();
else if (cmd === 'uninstall') await uninstall();
else if (cmd === 'status') status();
else if (cmd === 'start') await import(path.join(SELF_DIR, 'server.js'));
else {
  log('usage: claude-deck [install|uninstall|status|start]');
  process.exit(1);
}
