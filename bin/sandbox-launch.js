#!/usr/bin/env node
// Sandboxed session launcher — runs `claude` inside a Linux devcontainer.
//
// Spawned by server.js as the PTY process in place of `claude` when a session
// has sandbox=true, and runnable standalone:
//
//   node bin/sandbox-launch.js [--config-dir <dir>] [--claude-json <file>]
//                              [--project-devcontainer] [--smoke] [-- <claude args…>]
//
// What it does:
//   1. `devcontainer up` on the current directory (build/boot logs stream to
//      this terminal), using the project's own .devcontainer/ only when the
//      server passed --project-devcontainer (per-project confirmed trust);
//      otherwise Deck's bundled sandbox/ config.
//   2. Assembles the in-container Claude config dir (three-tier mount design):
//      - Tier 1: the host profile's whole config dir, mounted READ-ONLY at
//        /deck/claude-config-host and exposed to Claude via per-entry symlinks
//        — the sandboxed Claude sees settings/skills/hooks/agents normally but
//        cannot modify anything a future HOST session would execute or obey.
//      - Tier 2: projects/ todos/ shell-snapshots/ file-history/ statsig/ as
//        read-write binds, so transcripts persist to the host profile and
//        `claude --continue` works on the host afterwards.
//      - Tier 3: .claude.json is COPIED in at boot and never synced back (a
//        writable shared copy would let a rogue agent register a malicious MCP
//        server the next host session executes — a sandbox escape);
//        .credentials.json is a read-write single-file bind (verified: a bind
//        mountpoint cannot be renamed/unlinked from inside, so the worst case
//        is a failed refresh-write → re-login, never a silent detach).
//   3. Runs `claude <args>` interactively via `docker exec -it` (the docker
//      CLI forwards TTY resizes; the devcontainer CLI does not).
//
// Cross-platform: no host-side shell-outs beyond the `docker` CLI itself; the
// only shell scripts run INSIDE the (always-Linux) container.
import { execFile, spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEVCONTAINER_CLI = path.join(__dirname, '..', 'node_modules', '@devcontainers', 'cli', 'devcontainer.js');
const BUNDLED_CONFIG = path.join(__dirname, '..', 'sandbox', 'devcontainer.json');

// paths inside the container (Linux, regardless of host OS)
const C_CONFIG = '/deck/claude-config';
const C_CONFIG_HOST = '/deck/claude-config-host';
// host config-dir entries that get their own RW bind (session persistence —
// written constantly by the CLI, never executed by the host)
const RW_DIRS = ['projects', 'todos', 'shell-snapshots', 'file-history', 'statsig'];
// entries claude must be able to WRITE but that must never flow back to the
// host (their contents influence future host sessions): container-local dirs,
// not symlinks into the RO mount and not binds
const LOCAL_DIRS = ['session-env'];

// printed when the container is up and claude is about to take over the TTY;
// server.js watches session output for it to end the tab's "booting" state
export const SANDBOX_READY_MARK = '🛡 sandbox ready — launching claude';

const sh = (cmd, args, opts = {}) => new Promise(resolve =>
  execFile(cmd, args, { timeout: 60_000, maxBuffer: 4_000_000, ...opts },
    (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') })));

// ---------------------------------------------------------------------------
// Capability detection — shared with server.js (imported, no side effects)
// ---------------------------------------------------------------------------
const DOCKER_INSTALL_HINT = {
  darwin: 'install Docker Desktop, OrbStack, or Colima (https://docs.docker.com/desktop/setup/install/mac-install/)',
  win32: 'install Docker Desktop (https://docs.docker.com/desktop/setup/install/windows-install/)',
  linux: 'install Docker Engine (https://docs.docker.com/engine/install/)',
};
const DOCKER_START_HINT = {
  darwin: 'start Docker Desktop (or OrbStack/Colima)',
  win32: 'start Docker Desktop',
  linux: 'start it: sudo systemctl start docker',
};

export async function detectSandbox() {
  if (!fs.existsSync(DEVCONTAINER_CLI)) {
    return { available: false, reason: 'devcontainer CLI not installed — run `npm install` in the Deck folder' };
  }
  const { err } = await sh('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 15_000 });
  if (err?.code === 'ENOENT') {
    return { available: false, reason: `Docker not found — ${DOCKER_INSTALL_HINT[process.platform] || DOCKER_INSTALL_HINT.linux}` };
  }
  if (err) {
    return { available: false, reason: `Docker is installed but its daemon isn't reachable — ${DOCKER_START_HINT[process.platform] || DOCKER_START_HINT.linux}` };
  }
  return { available: true, reason: null };
}

// A project "ships its own devcontainer" if either standard config location
// exists. Returns the config path or null.
export function projectDevcontainerConfig(dir) {
  for (const rel of [path.join('.devcontainer', 'devcontainer.json'), '.devcontainer.json']) {
    const p = path.join(dir, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Config generation
// ---------------------------------------------------------------------------
// devcontainer.json allows comments and trailing commas; tolerate both.
export function parseJsonc(raw) {
  let out = '', str = false, i = 0;
  while (i < raw.length) {
    const c = raw[i], n = raw[i + 1];
    if (str) {
      out += c;
      if (c === '\\') { out += n ?? ''; i += 2; continue; }
      if (c === '"') str = false;
      i++;
    } else if (c === '"') { str = true; out += c; i++; }
    else if (c === '/' && n === '/') { while (i < raw.length && raw[i] !== '\n') i++; }
    else if (c === '/' && n === '*') { i += 2; while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) i++; i += 2; }
    else { out += c; i++; }
  }
  return JSON.parse(out.replace(/,\s*([}\]])/g, '$1'));
}

// resolve claude.json the same way the server does: prefer the file inside the
// config dir, fall back to legacy ~/.claude.json for the default dir only
export function resolveClaudeJson(configDir) {
  const inner = path.join(configDir, '.claude.json');
  if (fs.existsSync(inner)) return inner;
  const legacy = path.join(os.homedir(), '.claude.json');
  if (configDir === path.join(os.homedir(), '.claude') && fs.existsSync(legacy)) return legacy;
  return inner;
}

const hash = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);

function mountString(source, target, { readonly = false } = {}) {
  for (const p of [source, target]) {
    if (/[,=]/.test(p)) throw new Error(`cannot mount a path containing "," or "=": ${p}`);
  }
  return `source=${source},target=${target},type=bind${readonly ? ',readonly' : ''}`;
}

// Config dirs often contain symlinks pointing OUTSIDE the config dir (e.g.
// CLAUDE.md -> ~/AGENTS.md, skills/<x> -> ~/.claude-shared/skills/<x>). The RO
// root mount exposes the symlink itself, which would dangle in the container.
// Because the container is Linux and host paths are absolute POSIX paths, we
// mount each out-of-tree target READ-ONLY at its identical path — then every
// symlink resolves, at any depth, and stays part of the read-only surface.
// Scanned: config-dir top level plus one level inside skills/commands/agents.
export function symlinkTargetMounts(configDir) {
  if (process.platform === 'win32') return []; // host paths can't mirror into Linux
  const roots = ['', 'skills', 'commands', 'agents']
    .map(d => path.join(configDir, d)).filter(fs.existsSync);
  const targets = new Set();
  for (const dir of roots) {
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch {}
    for (const name of entries) {
      const p = path.join(dir, name);
      try {
        if (!fs.lstatSync(p).isSymbolicLink()) continue;
        const real = fs.realpathSync(p);
        if (!real.startsWith(configDir + path.sep)) targets.add(real);
      } catch {} // dangling on the host too — nothing to mount
    }
  }
  // drop targets already covered by another mounted target
  const list = [...targets].sort();
  const covered = t => list.some(o => o !== t && t.startsWith(o + path.sep));
  const mounts = [];
  for (const t of list.filter(t => !covered(t)).slice(0, 32)) {
    try { mounts.push(mountString(t, t, { readonly: true })); }
    catch { console.log(`note: skipping unmountable symlink target ${t}`); }
  }
  return mounts;
}

// Build the override devcontainer.json: the base config (bundled, or the
// project's own when trusted) plus the three-tier config-dir mounts and a
// workspace mount at the HOST path, so transcripts inside the container land
// under the same projects/<munged-path> dir that host `claude --continue` uses.
export function buildOverrideConfig({ baseConfigPath, hostCwd, configDir, credentials }) {
  const baseDir = path.dirname(baseConfigPath);
  const cfg = parseJsonc(fs.readFileSync(baseConfigPath, 'utf8'));

  // relative build paths break when the config is read from a temp location
  const abs = p => (typeof p === 'string' && !path.isAbsolute(p)) ? path.resolve(baseDir, p) : p;
  if (cfg.build) {
    cfg.build.dockerfile = abs(cfg.build.dockerfile);
    cfg.build.context = abs(cfg.build.context ?? '.');
  }
  if (cfg.dockerFile) { cfg.dockerFile = abs(cfg.dockerFile); cfg.context = abs(cfg.context ?? '.'); }
  if (cfg.dockerComposeFile) {
    cfg.dockerComposeFile = Array.isArray(cfg.dockerComposeFile)
      ? cfg.dockerComposeFile.map(abs) : abs(cfg.dockerComposeFile);
  }

  // Windows host paths can't exist inside a Linux container; those transcripts
  // key on /workspaces/<name> instead (documented resume caveat).
  const workspaceFolder = path.isAbsolute(hostCwd) && !/^[A-Za-z]:/.test(hostCwd)
    ? hostCwd : '/workspaces/' + path.basename(hostCwd);
  cfg.workspaceMount = mountString(hostCwd, workspaceFolder) + ',consistency=delegated';
  cfg.workspaceFolder = workspaceFolder;

  const mounts = [
    // Tier 1 — the whole profile config dir, read-only (the influence surface)
    mountString(configDir, C_CONFIG_HOST, { readonly: true }),
    // Tier 2 — RW session-persistence dirs, nested into the assembled config dir
    ...RW_DIRS.map(d => mountString(path.join(configDir, d), `${C_CONFIG}/${d}`)),
    // out-of-tree symlink targets, read-only at their own paths (see above)
    ...symlinkTargetMounts(configDir),
  ];
  // Tier 3b — credentials: reads for auth, writes for OAuth refresh. A bind
  // mountpoint can't be renamed or unlinked from inside the container, so a
  // rename-style refresh write fails loudly (worst case: re-login) and the
  // host file can never be silently replaced.
  if (credentials) mounts.push(mountString(credentials, `${C_CONFIG}/.credentials.json`));
  cfg.mounts = [...(cfg.mounts || []), ...mounts];

  cfg.containerEnv = { ...(cfg.containerEnv || {}), CLAUDE_CONFIG_DIR: C_CONFIG };
  return cfg;
}

// ---------------------------------------------------------------------------
// Container boot
// ---------------------------------------------------------------------------
function runDevcontainer(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [DEVCONTAINER_CLI, ...args], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    p.stdout.on('data', d => { out += d; process.stdout.write(d); });
    p.on('error', reject);
    p.on('exit', code => resolve({ code, out }));
  });
}

// refresh the per-entry symlinks that give the sandboxed Claude its read-only
// view of the host config dir (runs INSIDE the container, as the remote user)
const SEED_SCRIPT = `set -e
mkdir -p ${C_CONFIG}
find ${C_CONFIG} -maxdepth 1 -type l | while IFS= read -r l; do [ -e "$l" ] || rm -f "$l"; done
for name in ${LOCAL_DIRS.join(' ')}; do
  t="${C_CONFIG}/$name"
  if [ -L "$t" ]; then rm -f "$t"; fi  # reused container seeded before these went local
  mkdir -p "$t"
done
find ${C_CONFIG_HOST} -mindepth 1 -maxdepth 1 | while IFS= read -r src; do
  name=$(basename "$src")
  case " ${RW_DIRS.join(' ')} ${LOCAL_DIRS.join(' ')} .claude.json .credentials.json " in *" $name "*) continue ;; esac
  t="${C_CONFIG}/$name"
  if [ -e "$t" ] && [ ! -L "$t" ]; then continue; fi
  ln -sfn "$src" "$t"
done`;

async function bootContainer({ hostCwd, configDir, claudeJson, projectConfig }) {
  const detected = await detectSandbox();
  if (!detected.available) {
    console.error(`✗ sandbox unavailable: ${detected.reason}`);
    return null;
  }

  // Tier-2 dirs must exist on the host before Docker binds them (it would
  // otherwise create them root-owned)
  for (const d of RW_DIRS) fs.mkdirSync(path.join(configDir, d), { recursive: true });
  const credentials = fs.existsSync(path.join(configDir, '.credentials.json'))
    ? path.join(configDir, '.credentials.json') : null;
  // macOS stores Claude credentials in the Keychain, not a file. The Linux
  // container can't reach the Keychain, so seed a copy at boot (copy only,
  // never synced back — refreshed tokens stay in the container; worst case is
  // a re-login, same as the file-bind path).
  let keychainCreds = null;
  if (!credentials && process.platform === 'darwin') {
    const { err, stdout } = await sh('security',
      ['find-generic-password', '-w', '-s', 'Claude Code-credentials'], { timeout: 30_000 });
    if (!err && stdout.trim().startsWith('{')) keychainCreds = stdout.trim();
  }
  if (!credentials && !keychainCreds) {
    console.log('note: no stored Claude credentials found for this profile — you may be asked to log in inside the sandbox (it will not persist to the host)');
  }

  const baseConfigPath = projectConfig || BUNDLED_CONFIG;
  const cfg = buildOverrideConfig({ baseConfigPath, hostCwd, configDir, credentials });
  const overrideDir = path.join(os.tmpdir(), 'claude-deck-sandbox');
  fs.mkdirSync(overrideDir, { recursive: true });
  const overridePath = path.join(overrideDir, `devcontainer-${hash(hostCwd + configDir)}.json`);
  fs.writeFileSync(overridePath, JSON.stringify(cfg, null, 2));

  // id-labels are the container's identity: one container per project ×
  // profile × mount/config shape, reused across sessions (fast after first
  // boot). The shape hash includes the bundled Dockerfile + firewall script so
  // a Deck update that changes them gets a fresh container, never a stale jail.
  const shape = hash(JSON.stringify(cfg) + ['Dockerfile', 'init-firewall.sh']
    .map(f => { try { return fs.readFileSync(path.join(path.dirname(baseConfigPath), f), 'utf8'); } catch { return ''; } })
    .join('\0'));
  const idLabels = [
    '--id-label', 'claude-deck.sandbox=1',
    '--id-label', `claude-deck.ws=${hash(hostCwd)}`,
    '--id-label', `claude-deck.profile=${hash(configDir)}`,
    '--id-label', `claude-deck.shape=${shape}`,
  ];

  // an existing container with these exact labels means a warm start (seconds);
  // none means an image build is coming — say so, or the wait looks like a hang
  const probe = await sh('docker', ['ps', '-aq',
    ...idLabels.filter(a => a !== '--id-label').flatMap(l => ['--filter', `label=${l}`])]);
  console.log(`🛡 Claude Deck sandbox — ${projectConfig ? 'this project’s own devcontainer' : 'bundled devcontainer'}`);
  if (!probe.stdout.trim()) {
    console.log('⏳ First boot for this project/config — building the container image, typically 2–5 minutes (build logs stream below). Later sessions reuse it and start in seconds.');
  }
  const up = await runDevcontainer([
    'up', '--workspace-folder', hostCwd, '--override-config', overridePath, ...idLabels,
  ]);
  const resultLine = up.out.trim().split('\n').reverse().find(l => l.startsWith('{'));
  let result = null;
  try { result = JSON.parse(resultLine); } catch {}
  if (up.code !== 0 || result?.outcome !== 'success') {
    console.error(`✗ devcontainer up failed${result?.message ? ': ' + result.message : ''}`);
    return null;
  }
  const { containerId, remoteUser, remoteWorkspaceFolder } = result;

  // the config-dir skeleton may be root-owned (docker auto-creates bind targets)
  const own = await sh('docker', ['exec', '-u', 'root', containerId, 'sh', '-c',
    `mkdir -p ${C_CONFIG} && chown "$1" ${C_CONFIG}`, 'sh', remoteUser]);
  if (own.err) { console.error('✗ preparing config dir failed: ' + own.stderr.trim()); return null; }

  const seed = await sh('docker', ['exec', '-u', remoteUser, containerId, 'sh', '-c', SEED_SCRIPT]);
  if (seed.err) { console.error('✗ seeding config dir failed: ' + seed.stderr.trim()); return null; }

  // copy a file/string into the container as the remote user, via exec stdin
  const copyIn = (target, source) => new Promise(resolve => {
    const p = spawn('docker', ['exec', '-i', '-u', remoteUser, containerId, 'sh', '-c',
      `umask 077 && cat > ${target}`], { stdio: ['pipe', 'ignore', 'inherit'] });
    if (source.file) fs.createReadStream(source.file).pipe(p.stdin);
    else { p.stdin.end(source.content); }
    p.on('exit', code => resolve(code === 0));
    p.on('error', () => resolve(false));
  });

  // Tier 3a — .claude.json: copy in at boot, never sync back
  if (fs.existsSync(claudeJson)) {
    if (!await copyIn(`${C_CONFIG}/.claude.json`, { file: claudeJson })) {
      console.error('✗ copying .claude.json into the sandbox failed'); return null;
    }
  }
  // macOS Keychain credentials (see above) — copy-in, never synced back
  if (keychainCreds) {
    if (!await copyIn(`${C_CONFIG}/.credentials.json`, { content: keychainCreds })) {
      console.error('✗ seeding credentials into the sandbox failed'); return null;
    }
  }

  return { containerId, remoteUser, workspaceFolder: remoteWorkspaceFolder || cfg.workspaceFolder };
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = { claudeArgs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { opts.claudeArgs = argv.slice(i + 1); break; }
    else if (a === '--config-dir') opts.configDir = argv[++i];
    else if (a === '--claude-json') opts.claudeJson = argv[++i];
    else if (a === '--project-devcontainer') opts.projectDevcontainer = true;
    else if (a === '--smoke') opts.smoke = true;
    else { console.error(`unknown option: ${a}`); process.exit(2); }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const hostCwd = process.cwd();
  const configDir = path.resolve(opts.configDir
    || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
  fs.mkdirSync(configDir, { recursive: true });
  const claudeJson = opts.claudeJson ? path.resolve(opts.claudeJson) : resolveClaudeJson(configDir);
  const projectConfig = opts.projectDevcontainer ? projectDevcontainerConfig(hostCwd) : null;

  const boot = await bootContainer({ hostCwd, configDir, claudeJson, projectConfig });
  if (!boot) process.exit(1);

  const tty = process.stdin.isTTY && process.stdout.isTTY;
  console.log(SANDBOX_READY_MARK);
  const claudeArgs = opts.smoke && !opts.claudeArgs.length ? ['--version'] : opts.claudeArgs;
  // docker (not devcontainer) exec: the docker CLI forwards TTY resizes, which
  // the claude TUI needs; `sh -l` so the image's login PATH finds claude
  const child = spawn('docker', [
    'exec', ...(tty ? ['-it'] : ['-i']),
    '-u', boot.remoteUser, '-w', boot.workspaceFolder,
    '-e', `CLAUDE_CONFIG_DIR=${C_CONFIG}`,
    boot.containerId,
    'sh', '-lc', 'exec claude "$@"', 'claude', ...claudeArgs.map(String),
  ], { stdio: 'inherit' });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  child.on('error', e => { console.error('✗ docker exec failed: ' + e.message); process.exit(1); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(e => { console.error('✗ ' + e.message); process.exit(1); });
}
