#!/usr/bin/env node
/* claude-deck CLI: install | uninstall | status | start | stop
 *
 * install    clones the app to a per-user dir, runs it at login, and registers
 *            the claude-deck:// URL scheme so the web page can wake it
 * uninstall  removes everything install created (never touches ~/.claude)
 *
 * Linux is fully supported (systemd --user service + xdg scheme + GTK tray).
 * macOS (launchd + .app URL scheme) and Windows (registry + Startup) are
 * best-effort — same flow, less battle-tested.
 */
import { execFileSync, spawnSync, spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const HOME = os.homedir();
const PLATFORM = process.platform; // linux | darwin | win32
const REPO_URL = process.env.DECK_REPO_URL || 'https://github.com/amirbukhari/better-claude-cli-ui.git';
const PORT = process.env.PORT || '3456';
const URL_LOCAL = `http://127.0.0.1:${PORT}`;
const PAGES_URL = 'https://amirbukhari.github.io/better-claude-cli-ui/';
const SELF_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const APP_ROOT = PLATFORM === 'win32'
  ? path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'claude-deck')
  : PLATFORM === 'darwin'
    ? path.join(HOME, 'Library', 'Application Support', 'claude-deck')
    : path.join(HOME, '.local', 'share', 'claude-deck');
const APP_DIR = path.join(APP_ROOT, 'app');
const TOKEN_FILE = path.join(APP_DIR, '.deck-token');

const log = m => console.log(m);
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });
const tryRun = (cmd, args, opts = {}) => spawnSync(cmd, args, { stdio: 'pipe', encoding: 'utf8', ...opts });
// npm is a .cmd batch file on Windows, which spawnSync refuses to run without
// a shell (EINVAL, CVE-2024-27980) — and args here are fixed flags, so no
// shell-quoting risk. Surface spawn failures: they'd otherwise read as "ran".
const npmRun = (args, opts = {}) => {
  const r = tryRun('npm', args, { stdio: 'inherit', shell: PLATFORM === 'win32', ...opts });
  if (r.error) log(`  npm did not run: ${r.error.message}`);
  return r;
};

// ---------------------------------------------------------------------------
// shared steps
// ---------------------------------------------------------------------------
function ptyLoads(dir) {
  return tryRun(process.execPath, ['-e', 'import("node-pty").then(()=>process.exit(0),()=>process.exit(1))'], { cwd: dir }).status === 0;
}

function npmInstall(dir) {
  log('  installing dependencies (node-pty compiles natively — may take a minute)…');
  npmRun(['install', '--omit=dev', '--no-fund', '--no-audit'], { cwd: dir });
  if (ptyLoads(dir)) return;
  // node-pty is an optionalDependency so npm won't hard-fail; build it
  // explicitly, then retry with the bundled shim for old-GCC Linux systems
  log('  node-pty is not built yet — building it directly…');
  npmRun(['install', 'node-pty', '--no-save', '--no-fund', '--no-audit'], { cwd: dir });
  if (ptyLoads(dir)) return;
  const shim = path.join(dir, 'tools', 'g++20-shim');
  if (PLATFORM !== 'win32' && fs.existsSync(shim)) {
    log('  plain build failed — retrying with the bundled g++20 shim (old-GCC systems)…');
    npmRun(['install', 'node-pty', '--no-save', '--no-fund', '--no-audit'],
      { cwd: dir, env: { ...process.env, CXX: shim } });
  }
  if (!ptyLoads(dir)) throw new Error('node-pty failed to build — install a C++20-capable compiler toolchain and rerun');
}

function cloneOrPull() {
  fs.mkdirSync(APP_ROOT, { recursive: true });
  if (fs.existsSync(path.join(APP_DIR, '.git'))) {
    log(`  updating existing checkout at ${APP_DIR}`);
    run('git', ['-C', APP_DIR, 'pull', '--ff-only']);
  } else {
    log(`  cloning ${REPO_URL}`);
    run('git', ['clone', '--depth', '1', REPO_URL, APP_DIR]);
  }
  npmInstall(APP_DIR);
}

// the server reads this file at startup; creating it here avoids the race
// where install finishes before the service has generated one
function ensureToken() {
  try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch {}
  const token = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(TOKEN_FILE, token + '\n', { mode: 0o600 });
  return token;
}

function printConnectHelp(token) {
  log('\nDone. Open the Deck:');
  log(`  local:            ${URL_LOCAL}`);
  log(`  from GitHub Pages (paste this whole URL in your browser):`);
  log(`    ${PAGES_URL}?server=${URL_LOCAL}&token=${token}`);
  log('\nUninstall any time: npx github:amirbukhari/better-claude-cli-ui uninstall');
}

async function confirm(question) {
  if (process.argv.includes('--yes') || process.argv.includes('-y')) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(r => rl.question(question + ' [y/N] ', r));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

// ---------------------------------------------------------------------------
// linux: systemd --user + xdg scheme handler + GTK tray
// ---------------------------------------------------------------------------
const LX = {
  handler: path.join(APP_ROOT, 'open.sh'),
  service: path.join(HOME, '.config', 'systemd', 'user', 'claude-deck.service'),
  desktopDir: path.join(HOME, '.local', 'share', 'applications'),
  desktop: path.join(HOME, '.local', 'share', 'applications', 'claude-deck.desktop'),
  mimeapps: path.join(HOME, '.config', 'mimeapps.list'),
  autostart: path.join(HOME, '.config', 'autostart', 'claude-deck-tray.desktop'),

  hasSystemd() {
    const r = tryRun('systemctl', ['--user', 'is-system-running']);
    return r.status !== null && !/not been booted|Failed to connect/i.test(r.stderr || '');
  },

  install() {
    // launch-at-login service
    if (this.hasSystemd()) {
      fs.mkdirSync(path.dirname(this.service), { recursive: true });
      fs.writeFileSync(this.service, `[Unit]
Description=Claude Deck (Amir Hates The Claude CLI UI)

[Service]
ExecStart=${process.execPath} ${APP_DIR}/server.js
WorkingDirectory=${APP_DIR}
Environment=PORT=${PORT}
Environment=DECK_INSTALLED=1
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`);
      run('systemctl', ['--user', 'daemon-reload']);
      run('systemctl', ['--user', 'enable', '--now', 'claude-deck.service']);
      log('  service enabled (systemctl --user status claude-deck)');
    } else {
      log('  (no systemd --user — the claude-deck:// handler and tray start the server on demand)');
    }

    // claude-deck:// handler
    fs.writeFileSync(this.handler, `#!/bin/bash
if command -v systemctl >/dev/null && systemctl --user list-unit-files claude-deck.service >/dev/null 2>&1; then
  systemctl --user start claude-deck.service
else
  curl -sf -m 2 ${URL_LOCAL}/api/state >/dev/null 2>&1 || \\
    setsid nohup "${process.execPath}" "${APP_DIR}/server.js" >/dev/null 2>&1 &
fi
for i in $(seq 1 20); do curl -sf -m 1 ${URL_LOCAL}/api/state >/dev/null 2>&1 && break; sleep 0.5; done
xdg-open "${URL_LOCAL}"
`, { mode: 0o755 });
    fs.mkdirSync(this.desktopDir, { recursive: true });
    fs.writeFileSync(this.desktop, `[Desktop Entry]
Type=Application
Name=Claude Deck
Exec=${this.handler} %u
MimeType=x-scheme-handler/claude-deck;
NoDisplay=true
`);
    tryRun('update-desktop-database', [this.desktopDir]);
    tryRun('xdg-mime', ['default', 'claude-deck.desktop', 'x-scheme-handler/claude-deck']);
    log('  registered claude-deck:// URL scheme');

    // tray icon (top bar): start/stop/open from a menu, autostarts at login
    fs.mkdirSync(path.dirname(this.autostart), { recursive: true });
    fs.writeFileSync(this.autostart, `[Desktop Entry]
Type=Application
Name=Claude Deck Tray
Exec=python3 ${APP_DIR}/bin/tray.py
X-GNOME-Autostart-enabled=true
`);
    // reinstalls must not stack tray icons: clear any running tray first
    // (tray.py also holds a single-instance lock as a second line of defense)
    tryRun('pkill', ['-f', 'claude-deck/app/bin/tray.py']);
    const tray = spawn('python3', [path.join(APP_DIR, 'bin', 'tray.py')], { detached: true, stdio: 'ignore' });
    tray.unref();
    log('  tray icon installed (starts at login; running now)');
  },

  uninstall() {
    tryRun('pkill', ['-f', 'claude-deck/app/bin/tray.py']);
    if (this.hasSystemd()) {
      tryRun('systemctl', ['--user', 'disable', '--now', 'claude-deck.service']);
      if (fs.existsSync(this.service)) { fs.rmSync(this.service); log(`  removed ${this.service}`); }
      tryRun('systemctl', ['--user', 'daemon-reload']);
    }
    for (const f of [this.desktop, this.autostart]) {
      if (fs.existsSync(f)) { fs.rmSync(f); log(`  removed ${f}`); }
    }
    tryRun('update-desktop-database', [this.desktopDir]);
    try {
      const lines = fs.readFileSync(this.mimeapps, 'utf8').split('\n');
      const kept = lines.filter(l => !l.includes('x-scheme-handler/claude-deck'));
      if (kept.length !== lines.length) fs.writeFileSync(this.mimeapps, kept.join('\n'));
    } catch {}
  },

  stop() { tryRun('systemctl', ['--user', 'stop', 'claude-deck.service']); },
  serviceState() { return (tryRun('systemctl', ['--user', 'is-active', 'claude-deck.service']).stdout || '').trim(); },
};

// ---------------------------------------------------------------------------
// macos: launchd + minimal .app bundle for the URL scheme (best-effort)
// ---------------------------------------------------------------------------
const MAC = {
  plist: path.join(HOME, 'Library', 'LaunchAgents', 'com.claude-deck.server.plist'),
  appBundle: path.join(HOME, 'Applications', 'Claude Deck.app'),

  install() {
    fs.mkdirSync(path.dirname(this.plist), { recursive: true });
    fs.writeFileSync(this.plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.claude-deck.server</string>
  <key>ProgramArguments</key><array>
    <string>${process.execPath}</string><string>${APP_DIR}/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>${APP_DIR}</string>
  <key>EnvironmentVariables</key><dict>
    <key>PORT</key><string>${PORT}</string>
    <key>DECK_INSTALLED</key><string>1</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
`);
    tryRun('launchctl', ['unload', this.plist]);
    const loaded = tryRun('launchctl', ['load', '-w', this.plist]);
    if (loaded.status === 0) log('  launchd agent loaded (launchctl list | grep claude-deck)');
    else log('  launchd agent written; load deferred to next login (headless session?)');

    // minimal .app so LaunchServices routes claude-deck:// to us
    const macos = path.join(this.appBundle, 'Contents', 'MacOS');
    fs.mkdirSync(macos, { recursive: true });
    fs.writeFileSync(path.join(this.appBundle, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Claude Deck</string>
  <key>CFBundleIdentifier</key><string>com.claude-deck.opener</string>
  <key>CFBundleExecutable</key><string>claude-deck</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleURLTypes</key><array><dict>
    <key>CFBundleURLName</key><string>Claude Deck</string>
    <key>CFBundleURLSchemes</key><array><string>claude-deck</string></array>
  </dict></array>
</dict></plist>
`);
    fs.writeFileSync(path.join(macos, 'claude-deck'), `#!/bin/bash
launchctl load -w "${this.plist}" 2>/dev/null
for i in $(seq 1 20); do curl -sf -m 1 ${URL_LOCAL}/api/state >/dev/null 2>&1 && break; sleep 0.5; done
open "${URL_LOCAL}"
`, { mode: 0o755 });
    tryRun('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
      ['-f', this.appBundle]);
    log('  registered claude-deck:// via Claude Deck.app (menu-bar tray not available on macOS yet)');
  },

  uninstall() {
    tryRun('launchctl', ['unload', this.plist]);
    for (const f of [this.plist]) if (fs.existsSync(f)) { fs.rmSync(f); log(`  removed ${f}`); }
    if (fs.existsSync(this.appBundle)) { fs.rmSync(this.appBundle, { recursive: true, force: true }); log(`  removed ${this.appBundle}`); }
  },

  stop() { tryRun('launchctl', ['unload', this.plist]); },
  serviceState() { return tryRun('launchctl', ['list', 'com.claude-deck.server']).status === 0 ? 'active' : 'inactive'; },
};

// ---------------------------------------------------------------------------
// windows: registry URL scheme + Startup launcher (best-effort)
// ---------------------------------------------------------------------------
const WIN = {
  startupVbs: path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'),
    'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'claude-deck.vbs'),
  openVbs: path.join(APP_ROOT, 'open.vbs'),

  launcherVbs() {
    return `Set sh = CreateObject("WScript.Shell")\r\nsh.Run """${process.execPath}"" ""${APP_DIR}\\server.js""", 0, False\r\n`;
  },

  install() {
    fs.writeFileSync(this.startupVbs, this.launcherVbs());
    fs.writeFileSync(this.openVbs,
      this.launcherVbs() + `WScript.Sleep 1500\r\nsh.Run "${URL_LOCAL}", 1, False\r\n`);
    // start it now, hidden
    spawn('wscript', [this.startupVbs], { detached: true, stdio: 'ignore' }).unref();
    log('  startup launcher installed (runs hidden at login)');

    const base = 'HKCU\\Software\\Classes\\claude-deck';
    run('reg', ['add', base, '/ve', '/d', 'URL:Claude Deck', '/f']);
    run('reg', ['add', base, '/v', 'URL Protocol', '/d', '', '/f']);
    run('reg', ['add', `${base}\\shell\\open\\command`, '/ve', '/d', `wscript "${this.openVbs}" "%1"`, '/f']);
    log('  registered claude-deck:// URL scheme (tray icon not available on Windows yet)');
  },

  uninstall() {
    // ask the server to exit via its token-guarded endpoint, then remove files
    try {
      const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
      tryRun('curl', ['-s', '-m', '3', '-X', 'POST', `${URL_LOCAL}/api/shutdown?token=${token}`]);
    } catch {}
    for (const f of [this.startupVbs, this.openVbs]) {
      if (fs.existsSync(f)) { fs.rmSync(f); log(`  removed ${f}`); }
    }
    tryRun('reg', ['delete', 'HKCU\\Software\\Classes\\claude-deck', '/f']);
  },

  stop() {
    try {
      const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
      tryRun('curl', ['-s', '-m', '3', '-X', 'POST', `${URL_LOCAL}/api/shutdown?token=${token}`]);
    } catch {}
  },
  serviceState() { return 'n/a (Startup launcher)'; },
};

const OS_IMPL = PLATFORM === 'linux' ? LX : PLATFORM === 'darwin' ? MAC : PLATFORM === 'win32' ? WIN : null;

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------
// A managed rollout can pin the claude executable up front with
// `--claude-bin=/path`, for machines where auto-detection would miss it (custom
// npm prefix, locked-down PATH, two installs). We write it into ~/.claude-deck.json
// — the same file the server reads at startup — so it's one mechanism across all
// OSes and stays editable afterward. Merges, so it won't clobber other keys.
const CONFIG_FILE = path.join(HOME, '.claude-deck.json');
function applyClaudeBinFlag() {
  const arg = process.argv.find(a => a.startsWith('--claude-bin='));
  if (!arg) return;
  const bin = arg.slice('--claude-bin='.length).trim();
  if (!bin) { log('  --claude-bin= given with no path — ignoring'); return; }
  if (!fs.existsSync(bin)) log(`  warning: ${bin} does not exist yet — writing it anyway`);
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {}; } catch {}
  cfg.claudeBin = bin;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
  log(`  pinned claude binary → ${bin} (in ${CONFIG_FILE})`);
}

function install() {
  if (!OS_IMPL) { log(`Unsupported platform: ${PLATFORM}`); process.exit(1); }
  log(`Installing Claude Deck (${PLATFORM})…`);
  cloneOrPull();
  const token = ensureToken();
  applyClaudeBinFlag();
  OS_IMPL.install();
  printConnectHelp(token);
}

async function uninstall() {
  if (!OS_IMPL) { log(`Unsupported platform: ${PLATFORM}`); process.exit(1); }
  const ok = await confirm(
    `This removes the Claude Deck service/launcher, the claude-deck:// handler, the tray icon, and ${APP_ROOT}.\n` +
    'Your Claude Code config and conversations are NOT touched. Continue?');
  if (!ok) { log('Aborted — nothing removed.'); return; }
  OS_IMPL.uninstall();
  if (fs.existsSync(APP_ROOT)) { fs.rmSync(APP_ROOT, { recursive: true, force: true }); log(`  removed ${APP_ROOT}`); }
  log('Uninstalled. (~/.claude and your conversations were left untouched.)');
}

function status() {
  if (OS_IMPL) log(`service: ${OS_IMPL.serviceState() || 'not installed'}`);
  const ping = tryRun('curl', ['-sf', '-m', '2', `${URL_LOCAL}/api/state`]);
  log(`server:  ${ping.status === 0 ? `responding on :${PORT}` : 'not responding'}`);
  log(`app dir: ${fs.existsSync(APP_DIR) ? APP_DIR : '(not installed — running from a checkout?)'}`);
}

const cmd = process.argv[2] || 'start';
if (cmd === 'install') install();
else if (cmd === 'uninstall') await uninstall();
else if (cmd === 'status') status();
else if (cmd === 'stop') OS_IMPL?.stop();
else if (cmd === 'start') await import(PLATFORM === 'win32'
  ? new URL('../server.js', import.meta.url).href
  : path.join(SELF_DIR, 'server.js'));
else {
  log('usage: claude-deck [install|uninstall|status|start|stop]');
  log('  install [--claude-bin=/path/to/claude]  pin the claude executable explicitly');
  process.exit(1);
}
