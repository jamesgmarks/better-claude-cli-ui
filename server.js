import express from 'express';
import { WebSocketServer } from 'ws';
import * as pty from 'node-pty';
import { execFile, spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import { fileURLToPath } from 'url';
import { detectSandbox, projectDevcontainerConfig, SANDBOX_READY_MARK } from './bin/sandbox-launch.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const PORT = Number(process.env.PORT || 3456);

// The directory Claude runs in. Defaults to where you launched this server.
let cwd = process.env.CLAUDE_UI_CWD || process.cwd();

// ---------------------------------------------------------------------------
// Claude config profiles
//
// A "profile" is one Claude Code config environment: a config directory (what
// `claude` reads as CLAUDE_CONFIG_DIR) plus the .claude.json inside it. The
// DEFAULT profile is exactly what plain `claude` uses here — $CLAUDE_CONFIG_DIR
// if set, otherwise ~/.claude — so anyone with a single setup sees no change
// and nothing needs configuring.
//
// People who run several accounts (e.g. ~/.claude + ~/.claude-work) get each
// one as a selectable profile, discovered automatically from sibling ~/.claude*
// config dirs, or listed explicitly via CLAUDE_UI_PROFILES ("work:~/.claude-work,
// ~/.claude-test"). Every terminal session runs under its profile's
// CLAUDE_CONFIG_DIR, so personal and work sessions can run side by side.
// ---------------------------------------------------------------------------
const expandHome = p => p.replace(/^~(?=\/|$)/, HOME);
const DEFAULT_CONFIG_DIR = path.resolve(
  process.env.CLAUDE_CONFIG_DIR ? expandHome(process.env.CLAUDE_CONFIG_DIR) : path.join(HOME, '.claude'));

// Current Claude keeps .claude.json inside the config dir; older setups kept the
// default one at ~/.claude.json. Prefer the inner file, fall back to the legacy
// location for the default dir only — so existing single-profile users are
// unaffected while relocated profiles resolve correctly.
function claudeJsonFor(configDir) {
  const inner = path.join(configDir, '.claude.json');
  if (fs.existsSync(inner)) return inner;
  const legacy = path.join(HOME, '.claude.json');
  if (configDir === path.join(HOME, '.claude') && fs.existsSync(legacy)) return legacy;
  return inner; // not created yet — this is where Claude will write it
}

// Does a directory look like a Claude config dir? Used for auto-discovery, so
// shared-scaffolding dirs (e.g. ~/.claude-shared with only skills/hooks and no
// real config) are skipped rather than mistaken for accounts.
function isConfigDir(dir) {
  try {
    if (fs.existsSync(path.join(dir, '.claude.json'))) return true;
    return fs.existsSync(path.join(dir, 'settings.json'))
      && fs.statSync(path.join(dir, 'projects')).isDirectory();
  } catch { return false; }
}

// ".claude" -> "default", ".claude-work" -> "work", ".config-x" -> "config-x"
const labelForDir = dir => (path.basename(dir).replace(/^\.claude-?/, '').replace(/^\./, '') || 'default');

function discoverProfiles() {
  const byDir = new Map(); // configDir -> { configDir, label, claudeJson }
  const add = (dir, label) => {
    const resolved = path.resolve(expandHome(dir));
    if (byDir.has(resolved)) { if (label) byDir.get(resolved).label = label; return; }
    byDir.set(resolved, { configDir: resolved, label: label || labelForDir(resolved), claudeJson: claudeJsonFor(resolved) });
  };
  // 1) the default always exists and sorts first
  add(DEFAULT_CONFIG_DIR);
  // 2) explicit list wins for naming — "label:path" or a bare path, comma/;-separated
  for (const spec of (process.env.CLAUDE_UI_PROFILES || '').split(/[,;]/).map(s => s.trim()).filter(Boolean)) {
    const m = spec.match(/^([^:/~][^:]*):(.+)$/); // label:path (a bare /… or ~/… path has no label)
    if (m) add(m[2].trim(), m[1].trim()); else add(spec);
  }
  // 3) auto-discover sibling ~/.claude* config dirs (e.g. ~/.claude-work)
  const parent = path.dirname(DEFAULT_CONFIG_DIR);
  try {
    for (const e of fs.readdirSync(parent, { withFileTypes: true })) {
      const dir = path.join(parent, e.name);
      if (e.isDirectory() && e.name.startsWith('.claude') && dir !== DEFAULT_CONFIG_DIR && isConfigDir(dir)) add(dir);
    }
  } catch {}
  // stable, unique, url-safe ids derived from the label
  const used = new Set();
  return [...byDir.values()].map(p => {
    const base = (p.label || 'default').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'p';
    let id = base, n = 2;
    while (used.has(id)) id = `${base}-${n++}`;
    used.add(id);
    return { ...p, id, isDefault: p.configDir === DEFAULT_CONFIG_DIR };
  });
}

let profiles = discoverProfiles();
let activeProfileId = profiles[0].id;
const profileById = id => profiles.find(p => p.id === id) || profiles[0];
const activeProfile = () => profileById(activeProfileId);

// ---------------------------------------------------------------------------
// Config file locations (relative to the active profile)
// ---------------------------------------------------------------------------
const paths = () => {
  const dir = activeProfile().configDir;
  return {
    userSettings: path.join(dir, 'settings.json'),
    projectSettings: path.join(cwd, '.claude', 'settings.json'),
    localSettings: path.join(cwd, '.claude', 'settings.local.json'),
    managedSettings: '/etc/claude-code/managed-settings.json',
    claudeJson: activeProfile().claudeJson,
    projectMcp: path.join(cwd, '.mcp.json'),
    keybindings: path.join(dir, 'keybindings.json'),
    userMemory: path.join(dir, 'CLAUDE.md'),
    projectMemory: path.join(cwd, 'CLAUDE.md'),
    localMemory: path.join(cwd, 'CLAUDE.local.md'),
  };
};

const SETTINGS_SCOPES = {
  user: () => paths().userSettings,
  project: () => paths().projectSettings,
  local: () => paths().localSettings,
};

function readJsonFile(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    try {
      return { exists: true, raw, json: JSON.parse(raw) };
    } catch (e) {
      return { exists: true, raw, json: null, parseError: String(e.message) };
    }
  } catch {
    return { exists: false, raw: null, json: null };
  }
}

function readTextFile(file, maxBytes = 200_000) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return { exists: true, raw: raw.slice(0, maxBytes), truncated: raw.length > maxBytes };
  } catch {
    return { exists: false, raw: null };
  }
}

function writeFileSafe(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    // one-deep backup so a bad write is never fatal
    fs.copyFileSync(file, file + '.bak');
  }
  fs.writeFileSync(file, content, 'utf8');
}

// Only these files/dirs may be read or written through the raw file API.
function isAllowedFile(file) {
  const p = paths();
  const dir = activeProfile().configDir;
  const resolved = path.resolve(file);
  const exact = [
    p.userSettings, p.projectSettings, p.localSettings, p.projectMcp,
    p.keybindings, p.userMemory, p.projectMemory, p.localMemory,
  ];
  if (exact.includes(resolved)) return true;
  const roots = [
    path.join(dir, 'agents'),
    path.join(dir, 'skills'),
    path.join(dir, 'commands'),
    path.join(cwd, '.claude', 'agents'),
    path.join(cwd, '.claude', 'skills'),
    path.join(cwd, '.claude', 'commands'),
  ];
  return roots.some(r => resolved.startsWith(r + path.sep));
}

// ---------------------------------------------------------------------------
// Agents / skills / commands discovery
// ---------------------------------------------------------------------------
function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const out = {};
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^(\w[\w-]*):\s*(.+)$/);
      if (kv) out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return out;
}

function listMarkdownDir(dir, scope, kind) {
  const items = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return items; }
  for (const e of entries) {
    let file = null;
    if (kind === 'skill' && e.isDirectory()) {
      const skillFile = path.join(dir, e.name, 'SKILL.md');
      if (fs.existsSync(skillFile)) file = skillFile;
    } else if (e.isFile() && e.name.endsWith('.md')) {
      file = path.join(dir, e.name);
    }
    if (!file) continue;
    let fm = {};
    try { fm = parseFrontmatter(fs.readFileSync(file, 'utf8').slice(0, 4000)); } catch {}
    items.push({
      name: fm.name || e.name.replace(/\.md$/, ''),
      description: fm.description || '',
      scope, file,
    });
  }
  return items;
}

function discover() {
  const both = (sub, kind) => [
    ...listMarkdownDir(path.join(activeProfile().configDir, sub), 'user', kind),
    ...listMarkdownDir(path.join(cwd, '.claude', sub), 'project', kind),
  ];
  return {
    agents: both('agents', 'agent'),
    skills: both('skills', 'skill'),
    commands: both('commands', 'command'),
  };
}

// ---------------------------------------------------------------------------
// Session history for the current project
// ---------------------------------------------------------------------------
function sessionDirFor(projectPath, configDir = activeProfile().configDir) {
  const encoded = projectPath.replace(/[^a-zA-Z0-9-]/g, '-');
  return path.join(configDir, 'projects', encoded);
}
function projectSessionDir() { return sessionDirFor(cwd); }

function knownProjectPaths() {
  const cj = readJsonFile(paths().claudeJson).json || {};
  const set = new Set(Object.keys(cj.projects || {}));
  set.add(cwd);
  return set;
}

// sessions across every project Claude knows about, newest first
function listAllSessions(perProject = 20, total = 80) {
  const out = [];
  for (const proj of knownProjectPaths()) {
    const dir = sessionDirFor(proj);
    let entries;
    try { entries = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch { continue; }
    const sessions = entries.map(f => {
      const full = path.join(dir, f);
      const st = fs.statSync(full);
      return { id: f.replace(/\.jsonl$/, ''), mtime: st.mtimeMs, size: st.size, project: proj, file: full };
    }).sort((a, b) => b.mtime - a.mtime).slice(0, perProject);
    for (const s of sessions) out.push({ ...s, summary: sessionSummary(s.file), file: undefined });
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, total);
}

function sessionSummary(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(16384);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    for (const line of buf.toString('utf8', 0, n).split('\n')) {
      try {
        const j = JSON.parse(line);
        if (j.type === 'summary' && j.summary) return j.summary;
        const c = j.message?.content;
        if (j.type === 'user' && typeof c === 'string' && c.trim()) return c.slice(0, 120);
        if (j.type === 'user' && Array.isArray(c)) {
          const t = c.find(x => x.type === 'text')?.text;
          if (t) return t.slice(0, 120);
        }
      } catch {}
    }
  } catch {}
  return '';
}

function readTranscript(id, projectPath = cwd) {
  const file = path.join(sessionDirFor(projectPath), id + '.jsonl');
  const raw = fs.readFileSync(file, 'utf8');
  const messages = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (j.type !== 'user' && j.type !== 'assistant') continue;
    const c = j.message?.content;
    let text = '';
    const tools = [];
    if (typeof c === 'string') text = c;
    else if (Array.isArray(c)) {
      for (const b of c) {
        if (b.type === 'text') text += (text ? '\n' : '') + b.text;
        else if (b.type === 'tool_use') tools.push(b.name);
        else if (b.type === 'tool_result') tools.push('result');
      }
    }
    if (j.isMeta) continue;
    if (!text && !tools.length) continue;
    // skip pure tool_result user turns to keep the transcript readable
    if (j.type === 'user' && !text) continue;
    messages.push({
      role: j.type,
      text: text.slice(0, 4000),
      tools: tools.filter(t => t !== 'result'),
      ts: j.timestamp || null,
    });
    if (messages.length >= 400) break;
  }
  return messages;
}

function listSessions(limit = 50) {
  const dir = projectSessionDir();
  let entries;
  try { entries = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch { return []; }
  return entries
    .map(f => {
      const full = path.join(dir, f);
      const st = fs.statSync(full);
      return { id: f.replace(/\.jsonl$/, ''), mtime: st.mtimeMs, size: st.size, file: full };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map(s => ({ ...s, summary: sessionSummary(s.file), file: undefined }));
}

// ---------------------------------------------------------------------------
// Aggregated state
// ---------------------------------------------------------------------------
let claudeVersion = '';
execFile('claude', ['--version'], (err, stdout) => { if (!err) claudeVersion = stdout.trim(); });

// ---------------------------------------------------------------------------
// Built-in slash commands, extracted from the installed claude binary itself.
// A hardcoded list would hide anything added in updates; the binary is truth.
// Cached per binary version+mtime because the scan reads ~250MB once.
// ---------------------------------------------------------------------------
const CMD_CACHE_FILE = path.join(__dirname, '.command-cache.json');
let builtinCommands = [];

async function extractBuiltinCommands() {
  try {
    const which = await new Promise((res, rej) =>
      execFile('bash', ['-c', 'command -v claude'], (e, so) => e ? rej(e) : res(so.trim())));
    const binPath = fs.realpathSync(which);
    const st = fs.statSync(binPath);
    const key = `${binPath}:${st.size}:${Math.round(st.mtimeMs)}`;
    try {
      const cached = JSON.parse(fs.readFileSync(CMD_CACHE_FILE, 'utf8'));
      if (cached.key === key && cached.commands?.length) { builtinCommands = cached.commands; return; }
    } catch {}
    console.log('scanning claude binary for slash commands…');
    const src = (await fs.promises.readFile(binPath)).toString('latin1');
    const D = '"((?:[^"\\\\]|\\\\.){5,400})"';
    const NAME = '([a-z][a-z0-9-]{1,30})';
    const FIELDS = '(?:,(?:aliases:\\[[^\\]]{0,80}\\]|[a-zA-Z$_]+:(?:"[^"]{0,120}"|!0|!1|[0-9]+)))*';
    const GETTER = 'get description\\(\\)\\{return[^}]{0,150}?';
    // command objects appear in several minified shapes; union of all passes
    const passes = [
      { re: `type:"(?:local|local-jsx|prompt)",name:"${NAME}"${FIELDS},description:${D}` },
      { re: `[{,]name:"${NAME}",description:${D},(?:argumentHint|isEnabled|aliases|load|call|getPromptForCommand|supportsNonInteractive|progressMessage)` },
      { re: `[{,]description:${D}${FIELDS},name:"${NAME}",(?:aliases|argumentHint|progressMessage|type|source|supportsNonInteractive|load|call)`, swap: true },
      { re: `type:"(?:local|local-jsx|prompt)",name:"${NAME}",(?:aliases:\\[[^\\]]{0,80}\\],)?${GETTER}${D}` },
      { re: `[{,]name:"${NAME}",(?:aliases:\\[[^\\]]{0,80}\\],)?${GETTER}${D}` },
    ];
    const best = new Map();
    for (const { re, swap } of passes) {
      for (const m of src.matchAll(new RegExp(re, 'g'))) {
        const name = swap ? m[2] : m[1];
        let desc = swap ? m[1] : m[2];
        try { desc = JSON.parse('"' + desc + '"'); } catch {}
        if (!best.has(name) || desc.length > best.get(name).length) best.set(name, desc);
      }
    }
    // commands whose descriptions are computed at runtime still deserve a row
    for (const m of src.matchAll(new RegExp(`name:"${NAME}",(?:aliases:\\[[^\\]]{0,80}\\],)?get description\\(\\)\\{`, 'g'))) {
      if (!best.has(m[1])) best.set(m[1], '(description is dynamic — run it to see)');
    }
    builtinCommands = [...best.entries()]
      .map(([name, description]) => ({ name, description }))
      .sort((a, b) => a.name.localeCompare(b.name));
    fs.writeFileSync(CMD_CACHE_FILE, JSON.stringify({ key, commands: builtinCommands }, null, 1));
    console.log(`extracted ${builtinCommands.length} built-in commands from ${path.basename(binPath)}`);
  } catch (e) {
    console.error('command extraction failed:', e.message);
  }
}
extractBuiltinCommands();

// Projects previously opened in ANY profile — the union of every profile's
// .claude.json project keys, dead paths dropped, most recently used first.
// Recency is the mtime of the profile's projects/<munged-path>/ transcript
// dir (touched whenever a session writes there); never-used entries sort last.
function recentProjects() {
  const out = [];
  for (const prof of profiles) {
    const cj = readJsonFile(prof.claudeJson).json || {};
    for (const dir of Object.keys(cj.projects || {})) {
      if (!fs.existsSync(dir)) continue;
      let lastUsed = 0;
      try { lastUsed = fs.statSync(path.join(prof.configDir, 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-'))).mtimeMs; } catch {}
      out.push({ path: dir, profile: prof.id, lastUsed });
    }
  }
  return out.sort((a, b) => b.lastUsed - a.lastUsed);
}

function getState() {
  const p = paths();
  const claudeJson = readJsonFile(p.claudeJson);
  const cj = claudeJson.json || {};
  const projectEntry = (cj.projects || {})[cwd] || null;

  return {
    cwd,
    home: HOME,
    claudeVersion,
    profiles: profiles.map(({ id, label, configDir, isDefault }) => ({ id, label, configDir, isDefault })),
    activeProfileId,
    terminal: { sessions: sessionList() },
    // sessions that were live before the last restart, offered for one-click restore
    pendingRestore: pendingRestore.map(s => ({ cwd: s.cwd, profile: s.profile, sandbox: !!s.sandbox })),
    sandbox: sandboxInfo,
    account: cj.oauthAccount ? {
      email: cj.oauthAccount.emailAddress,
      organization: cj.oauthAccount.organizationName,
    } : null,
    settings: {
      user: { path: p.userSettings, ...readJsonFile(p.userSettings) },
      project: { path: p.projectSettings, ...readJsonFile(p.projectSettings) },
      local: { path: p.localSettings, ...readJsonFile(p.localSettings) },
      managed: { path: p.managedSettings, ...readJsonFile(p.managedSettings) },
    },
    mcp: {
      user: cj.mcpServers || {},
      project: readJsonFile(p.projectMcp).json?.mcpServers || {},
      local: projectEntry?.mcpServers || {},
      projectMcpPath: p.projectMcp,
    },
    projectEntry: projectEntry ? {
      allowedTools: projectEntry.allowedTools || [],
      enabledMcpjsonServers: projectEntry.enabledMcpjsonServers || [],
      disabledMcpjsonServers: projectEntry.disabledMcpjsonServers || [],
      hasTrustDialogAccepted: projectEntry.hasTrustDialogAccepted ?? null,
      lastSessionId: projectEntry.lastSessionId || null,
    } : null,
    knownProjects: Object.keys(cj.projects || {}),
    recentProjects: recentProjects(),
    memory: {
      user: { path: p.userMemory, ...readTextFile(p.userMemory) },
      project: { path: p.projectMemory, ...readTextFile(p.projectMemory) },
      local: { path: p.localMemory, ...readTextFile(p.localMemory) },
    },
    keybindings: { path: p.keybindings, ...readJsonFile(p.keybindings) },
    ...discover(),
    builtinCommands,
    update: updateInfo,
    server: {
      installed: process.env.DECK_INSTALLED === '1',
      appDir: __dirname,
      pid: process.pid,
      port: PORT,
      node: process.version,
      platform: process.platform,
    },
    sessions: listSessions(),
    allSessions: listAllSessions(),
    meta: {
      autoUpdates: cj.autoUpdates ?? null,
      installMethod: cj.installMethod ?? null,
      numStartups: cj.numStartups ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Settings mutation helpers
// ---------------------------------------------------------------------------
function deepSet(obj, keyPath, value) {
  const keys = keyPath.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (typeof cur[keys[i]] !== 'object' || cur[keys[i]] === null) cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  const last = keys[keys.length - 1];
  if (value === null || value === undefined) delete cur[last];
  else cur[last] = value;
}

function updateSettings(scope, mutate) {
  const fileFn = SETTINGS_SCOPES[scope];
  if (!fileFn) throw new Error(`unknown scope: ${scope}`);
  const file = fileFn();
  const cur = readJsonFile(file);
  if (cur.exists && cur.json === null) throw new Error(`${file} contains invalid JSON — fix it in Raw Files first`);
  const json = cur.json || {};
  mutate(json);
  writeFileSafe(file, JSON.stringify(json, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Self-update: this checkout is a git clone, so an update is just git pull.
// We check origin/main periodically and expose the result in /api/state.
// Installed copies (DECK_INSTALLED=1, run under systemd Restart=always)
// auto-apply ONLY when no claude sessions are running; otherwise the UI
// shows an "update ready" banner and the user applies it with one click.
// ---------------------------------------------------------------------------
let updateInfo = { available: false, local: null, remote: null, behind: 0, checkedAt: null };

function gitHere(args) {
  return new Promise(resolve => {
    execFile('git', args, { cwd: __dirname, timeout: 30_000 }, (err, stdout) =>
      resolve(err ? null : stdout.trim()));
  });
}

async function checkForUpdates() {
  if (await gitHere(['rev-parse', '--is-inside-work-tree']) !== 'true') return;
  if (await gitHere(['fetch', '--quiet', 'origin', 'main']) === null) return; // offline is fine
  const [local, remote, behind] = await Promise.all([
    gitHere(['rev-parse', '--short', 'HEAD']),
    gitHere(['rev-parse', '--short', 'origin/main']),
    gitHere(['rev-list', '--count', 'HEAD..origin/main']),
  ]);
  updateInfo = {
    available: !!local && !!remote && local !== remote && Number(behind) > 0,
    local, remote, behind: Number(behind) || 0,
    checkedAt: Date.now(),
  };
  if (updateInfo.available) {
    console.log(`update available: ${local} -> ${remote} (${behind} commit(s) behind)`);
    broadcastEvent({ type: 'state' });
    // installed + idle -> apply silently; systemd restarts us on the new code
    if (process.env.DECK_INSTALLED === '1' && sessions.size === 0) applyUpdate();
  }
}

let updating = false;
async function applyUpdate() {
  if (updating) return { ok: false, error: 'update already in progress' };
  updating = true;
  console.log('applying update: git pull + npm install…');
  if (await gitHere(['pull', '--ff-only', 'origin', 'main']) === null) {
    updating = false;
    return { ok: false, error: 'git pull failed — check the server log' };
  }
  await new Promise(resolve => {
    const shim = path.join(__dirname, 'tools', 'g++20-shim');
    const env = fs.existsSync(shim) ? { ...process.env, CXX: shim } : process.env;
    // npm is a .cmd on Windows — needs a shell to spawn (EINVAL otherwise)
    execFile('npm', ['install', '--omit=dev', '--no-fund', '--no-audit'],
      { cwd: __dirname, timeout: 300_000, env, shell: process.platform === 'win32' }, () => resolve());
  });
  console.log('update applied — exiting so the service manager restarts on the new code');
  setTimeout(() => process.exit(0), 400); // under systemd Restart=always this is a relaunch
  return { ok: true, restarting: true };
}

setTimeout(checkForUpdates, 15_000);            // shortly after boot
setInterval(checkForUpdates, 6 * 3600 * 1000);  // then every 6 hours

// ---------------------------------------------------------------------------
// Sandboxed sessions — capability detection + per-project devcontainer trust.
// A sandboxed session runs `claude` inside a devcontainer via
// bin/sandbox-launch.js; without Docker everything else works unchanged and
// sandboxInfo.reason tells the UI what's missing.
// ---------------------------------------------------------------------------
let sandboxInfo = { available: false, reason: 'checking…', checkedAt: null };

async function checkSandbox() {
  const r = await detectSandbox();
  const changed = r.available !== sandboxInfo.available || r.reason !== sandboxInfo.reason;
  sandboxInfo = { ...r, checkedAt: Date.now() };
  if (changed) broadcastEvent({ type: 'state' });
  return sandboxInfo;
}
checkSandbox();

// Once-per-project decision for repos that ship their own .devcontainer/
// (their config can mount arbitrary host paths, so first use needs explicit
// confirmation): 'project' = use the repo's config, 'bundled' = use Deck's.
const SANDBOX_TRUST_FILE = path.join(HOME, '.claude-deck-sandbox-trust.json');

function sandboxTrust() {
  return readJsonFile(SANDBOX_TRUST_FILE).json || {};
}

function setSandboxTrust(project, decision) {
  const all = sandboxTrust();
  all[project] = { decision, decidedAt: Date.now() };
  fs.writeFileSync(SANDBOX_TRUST_FILE, JSON.stringify(all, null, 2));
}

// ---------------------------------------------------------------------------
// PTY sessions — multiple concurrent claude processes, one per tab in the UI
// ---------------------------------------------------------------------------
const SCROLLBACK_MAX = 400_000;
const sessions = new Map(); // sid -> { pty, cwd, args, scrollback, status, pid, createdAt, label }
let sessionOrder = [];       // sids in the user's chosen tab order (drag / keyboard reorder)
let sidCounter = 0;
const termClients = new Set();

// ---------------------------------------------------------------------------
// Session restore across restarts. The server owns the PTYs, so a restart kills
// them — but Claude persists each conversation, so we can re-open them with
// --continue. We keep a snapshot of the live set on disk (rewritten on every
// change, since a kill -9 gives no shutdown hook) and, on the next startup,
// offer them back via a one-click banner (never auto-spawned).
// ---------------------------------------------------------------------------
const SESSION_SNAPSHOT_FILE = path.join(HOME, '.claude-deck-sessions.json');
let pendingRestore = []; // [{ cwd, profile, args }] from the previous run, offered to the UI

function saveSessionSnapshot() {
  try {
    const live = orderedSids().map(sid => sessions.get(sid))
      .filter(s => s && s.status !== 'exited')
      .map(s => ({ cwd: s.cwd, profile: s.profile, args: s.args, label: s.label || null, sandbox: !!s.sandbox }));
    fs.writeFileSync(SESSION_SNAPSHOT_FILE, JSON.stringify({ savedAt: Date.now(), sessions: live }));
  } catch {}
}

// read once at startup — the sessions that were live before this process began
function loadPendingRestore() {
  try {
    const snap = JSON.parse(fs.readFileSync(SESSION_SNAPSHOT_FILE, 'utf8'));
    pendingRestore = (Array.isArray(snap?.sessions) ? snap.sessions : [])
      .filter(s => s && s.cwd && fs.existsSync(s.cwd));
  } catch { pendingRestore = []; }
}

// force a resume regardless of the original flags: drop any continue/resume/
// session-id (and its value), keep the rest (e.g. --dangerously-skip-permissions)
function restoreArgs(args = []) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-c' || a === '--continue') continue;
    if (a === '-r' || a === '--resume' || a === '--session-id') {
      if (args[i + 1] && !args[i + 1].startsWith('-')) i++; // skip its value too
      continue;
    }
    out.push(a);
  }
  return ['--continue', ...out];
}
const eventClients = new Set();

function broadcastTerm(msg) {
  const s = JSON.stringify(msg);
  for (const ws of termClients) if (ws.readyState === 1) ws.send(s);
}
function broadcastEvent(msg) {
  const s = JSON.stringify(msg);
  for (const ws of eventClients) if (ws.readyState === 1) ws.send(s);
}

// live sids in the user's chosen order; any not yet placed fall to the end
const orderedSids = () => {
  const known = sessionOrder.filter(sid => sessions.has(sid));
  const extra = [...sessions.keys()].filter(sid => !known.includes(sid));
  return [...known, ...extra];
};
const sessionInfo = (sid, s) => ({ sid, pid: s.pid, cwd: s.cwd, args: s.args, status: s.status, activity: s.activity || 'working', createdAt: s.createdAt, profile: s.profile, sandbox: !!s.sandbox, cols: s.pty?.cols, rows: s.pty?.rows, label: s.label ?? null, order: orderedSids().indexOf(sid) });
const sessionList = () => orderedSids().map(sid => sessionInfo(sid, sessions.get(sid)));

// ---------------------------------------------------------------------------
// Activity detection: is the agent working, or waiting on the human?
// Claude's spinner streams output continuously while it works, so a quiet
// PTY means the ball is in your court. The last visible screen tells us
// whether it's a question/permission prompt or just an idle prompt.
// ---------------------------------------------------------------------------
const stripAnsi = s => s
  .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')   // OSC (titles etc.)
  .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')            // CSI
  .replace(/\x1b[()][0-9A-B]/g, '');                 // charset selects

const QUESTION_RE = /(Do you want|Would you like|Allow this|Allow \w+|Grant access|don't ask again|\(y\/n\)|❯\s*1\.|Choose an option|Press Enter to|Esc to go back|awaiting your|Waiting for your)/i;

function classifyActivity(s) {
  if (s.status === 'exited') return 'exited';
  // a sandboxed session is "booting" until the launcher hands the TTY to
  // claude — image builds pause for long stretches (downloads) and must not
  // read as "your turn"
  if (s.sandbox && !s.sandboxReady) {
    if (s.scrollback.includes(SANDBOX_READY_MARK)) s.sandboxReady = true;
    else return 'booting';
  }
  const quiet = Date.now() - (s.lastDataAt || s.createdAt);
  if (quiet < 2500) return 'working';
  // only the latest paint burst — TUIs repaint with cursor moves, not appends,
  // so a fixed scrollback window keeps long-gone text (a stale "Press Enter to
  // continue…" would read as a question forever)
  const tail = stripAnsi(s.recentOut || '');
  return QUESTION_RE.test(tail.slice(-1200)) ? 'question' : 'ready';
}

setInterval(() => {
  for (const [sid, s] of sessions) {
    const a = classifyActivity(s);
    if (a !== s.activity) {
      s.activity = a;
      broadcastTerm({ type: 'activity', sid, activity: a });
    }
  }
}, 1000);

function startSession({ cwd: dir, args = [], cols = 120, rows = 32, profile: profileId, label, sandbox = false } = {}) {
  const resolved = path.resolve(String(dir || cwd).replace(/^~(?=\/|$)/, HOME));
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error('not a directory: ' + resolved);
  }
  const prof = profileById(profileId || activeProfileId);
  const sid = 's' + (++sidCounter);
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  // Non-default profiles run under their own CLAUDE_CONFIG_DIR so accounts can
  // run concurrently; the default passes the environment through untouched, so
  // single-profile behaviour is byte-for-byte what it was before.
  if (!prof.isDefault) env.CLAUDE_CONFIG_DIR = prof.configDir;
  const claudeArgs = (Array.isArray(args) ? args : []).map(String);
  let file = 'claude', spawnArgs = claudeArgs;
  if (sandbox) {
    // jail the session in a devcontainer: the launcher becomes the PTY process
    if (!sandboxInfo.available) throw new Error('sandbox unavailable: ' + sandboxInfo.reason);
    // a repo's own .devcontainer/ is used only after explicit per-project
    // confirmation; undecided or declined falls back to the bundled config
    const useProjectDc = !!projectDevcontainerConfig(resolved)
      && sandboxTrust()[resolved]?.decision === 'project';
    file = process.execPath;
    spawnArgs = [
      path.join(__dirname, 'bin', 'sandbox-launch.js'),
      '--config-dir', prof.configDir, '--claude-json', prof.claudeJson,
      ...(useProjectDc ? ['--project-devcontainer'] : []),
      '--', ...claudeArgs,
    ];
  }
  const proc = pty.spawn(file, spawnArgs, {
    name: 'xterm-256color',
    cols: cols > 0 ? cols : 120, rows: rows > 0 ? rows : 32,
    cwd: resolved,
    env,
  });
  const sess = { pty: proc, cwd: resolved, args, scrollback: '', status: 'running', pid: proc.pid, createdAt: Date.now(), profile: prof.id, sandbox: !!sandbox, label: (typeof label === 'string' && label.trim()) ? label.trim().slice(0, 60) : null };
  sessions.set(sid, sess);
  sessionOrder.push(sid);
  saveSessionSnapshot();
  proc.onData(d => {
    sess.scrollback = (sess.scrollback + d).slice(-SCROLLBACK_MAX);
    // a >2.5s gap starts a new paint burst (see classifyActivity)
    const gap = Date.now() - (sess.lastDataAt || 0);
    sess.recentOut = ((gap > 2500 ? '' : sess.recentOut || '') + d).slice(-4000);
    sess.lastDataAt = Date.now();
    broadcastTerm({ type: 'data', sid, data: d });
  });
  proc.onExit(({ exitCode }) => {
    sess.status = 'exited';
    saveSessionSnapshot();
    broadcastTerm({ type: 'exit', sid, code: exitCode });
    broadcastEvent({ type: 'state' });
  });
  broadcastTerm({ type: 'session-started', session: sessionInfo(sid, sess) });
  broadcastEvent({ type: 'state' });
  return sid;
}

function killSession(sid, remove = false) {
  const s = sessions.get(sid);
  if (!s) return;
  if (s.status === 'running') {
    try { s.pty.kill(); } catch {}
    s.status = 'exited';
  }
  if (remove) { sessions.delete(sid); sessionOrder = sessionOrder.filter(x => x !== sid); }
  saveSessionSnapshot();
}

// ---------------------------------------------------------------------------
// File watching → live dashboard refresh
// ---------------------------------------------------------------------------
const watchers = [];
let watchDebounce = null;
function setupWatchers() {
  for (const w of watchers.splice(0)) { try { w.close(); } catch {} }
  const p = paths();
  const dir = activeProfile().configDir;
  const targets = [
    dir,
    path.join(cwd, '.claude'),
    p.claudeJson, p.projectMcp, p.projectMemory, p.localMemory,
    path.join(dir, 'agents'), path.join(dir, 'skills'), path.join(dir, 'commands'),
    path.join(cwd, '.claude', 'agents'), path.join(cwd, '.claude', 'skills'), path.join(cwd, '.claude', 'commands'),
  ];
  for (const t of targets) {
    try {
      const w = fs.watch(t, () => {
        clearTimeout(watchDebounce);
        watchDebounce = setTimeout(() => broadcastEvent({ type: 'state' }), 300);
      });
      watchers.push(w);
    } catch {}
  }
}
setupWatchers();

// ---------------------------------------------------------------------------
// Remote access (GitHub Pages frontend → this local server)
// A cross-origin page may only talk to this server with the access token.
// Without this gate, ANY website you visit could read your Claude config and
// drive your terminal via ws://127.0.0.1.
// ---------------------------------------------------------------------------
const TOKEN_FILE = path.join(__dirname, '.deck-token');
let accessToken;
try { accessToken = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch {}
if (!accessToken) {
  accessToken = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(TOKEN_FILE, accessToken + '\n', { mode: 0o600 });
}

function isLocalOrigin(origin) {
  if (!origin) return true; // same-origin navigation / curl send no Origin
  try {
    const u = new URL(origin);
    return ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  } catch { return false; }
}

function requestToken(req) {
  const url = new URL(req.url, 'http://x');
  return url.searchParams.get('token')
    || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
}

function authorized(req) {
  return isLocalOrigin(req.headers.origin) || requestToken(req) === accessToken;
}

// ---------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// CORS + auth gate for every /api route
app.use('/api', (req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    // Chrome Private Network Access: https pages need this on the preflight
    // to be allowed to reach a localhost server at all
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  if (!authorized(req)) return res.status(403).json({ error: 'missing or wrong access token — copy the connect URL printed when the server starts' });
  next();
});

app.get('/api/state', (req, res) => {
  try { res.json(getState()); } catch (e) { res.status(500).json({ error: String(e.message) }); }
});

app.post('/api/setting', (req, res) => {
  const { scope, keyPath, value } = req.body || {};
  try {
    if (!keyPath || /(^|\.)__proto__(\.|$)|(^|\.)constructor(\.|$)|(^|\.)prototype(\.|$)/.test(keyPath)) {
      throw new Error('invalid keyPath');
    }
    updateSettings(scope, json => deepSet(json, keyPath, value ?? null));
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: String(e.message) }); }
});

app.post('/api/permission-rule', (req, res) => {
  const { scope, list, action, rule } = req.body || {};
  try {
    if (!['allow', 'deny', 'ask'].includes(list)) throw new Error('list must be allow/deny/ask');
    if (!rule || typeof rule !== 'string') throw new Error('rule required');
    updateSettings(scope, json => {
      json.permissions = json.permissions || {};
      const arr = json.permissions[list] = json.permissions[list] || [];
      if (action === 'add' && !arr.includes(rule)) arr.push(rule);
      if (action === 'remove') json.permissions[list] = arr.filter(r => r !== rule);
    });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: String(e.message) }); }
});

app.post('/api/env-var', (req, res) => {
  const { scope, key, value, action } = req.body || {};
  try {
    if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('invalid env var name');
    updateSettings(scope, json => {
      json.env = json.env || {};
      if (action === 'remove') delete json.env[key];
      else json.env[key] = String(value ?? '');
      if (Object.keys(json.env).length === 0) delete json.env;
    });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: String(e.message) }); }
});

app.get('/api/file', (req, res) => {
  const file = String(req.query.path || '');
  if (!isAllowedFile(file)) return res.status(403).json({ error: 'path not allowed' });
  res.json(readTextFile(file, 500_000));
});

app.post('/api/file', (req, res) => {
  const { file, content } = req.body || {};
  try {
    if (!isAllowedFile(file)) throw new Error('path not allowed');
    if (file.endsWith('.json')) JSON.parse(content); // refuse to save broken JSON
    writeFileSafe(file, content);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: String(e.message) }); }
});

app.post('/api/mcp', (req, res) => {
  const { action, name, scope, transport, commandOrUrl, args = [], envPairs = [] } = req.body || {};
  const safe = s => /^[\w@.\/:~-]+$/.test(s);
  try {
    if (!name || !/^[\w-]+$/.test(name)) throw new Error('invalid server name');
    const cliArgs = ['mcp'];
    if (action === 'remove') {
      cliArgs.push('remove', name);
      if (scope) cliArgs.push('-s', scope);
    } else if (action === 'add') {
      cliArgs.push('add', name, '-s', scope || 'local');
      if (transport && transport !== 'stdio') cliArgs.push('-t', transport);
      for (const pair of envPairs) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*=.*$/.test(pair)) throw new Error('bad env pair');
        cliArgs.push('-e', pair);
      }
      if (!commandOrUrl) throw new Error('command or URL required');
      cliArgs.push('--', commandOrUrl, ...args.filter(a => typeof a === 'string'));
    } else throw new Error('unknown action');
    if (!safe(name)) throw new Error('invalid name');
    execFile('claude', cliArgs, { cwd, timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) return res.status(400).json({ error: (stderr || stdout || String(err)).trim() });
      broadcastEvent({ type: 'state' });
      res.json({ ok: true, output: (stdout || '').trim() });
    });
  } catch (e) { res.status(400).json({ error: String(e.message) }); }
});

app.get('/api/session', (req, res) => {
  const id = String(req.query.id || '');
  const project = String(req.query.project || cwd);
  if (!/^[\w-]+$/.test(id)) return res.status(400).json({ error: 'bad session id' });
  if (!knownProjectPaths().has(project)) return res.status(403).json({ error: 'unknown project' });
  try { res.json({ messages: readTranscript(id, project) }); }
  catch (e) { res.status(404).json({ error: String(e.message) }); }
});

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------
function git(args) {
  return new Promise(resolve => {
    execFile('git', args, { cwd, timeout: 15_000, maxBuffer: 4_000_000 }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

app.get('/api/git', async (req, res) => {
  const inside = await git(['rev-parse', '--is-inside-work-tree']);
  if (!inside || !inside.trim().startsWith('true')) return res.json({ isRepo: false });
  const SEP = '\x1f';
  const [branch, statusRaw, logRaw, remote] = await Promise.all([
    git(['branch', '--show-current']).then(b => b?.trim() ? b : git(['symbolic-ref', '--short', 'HEAD'])),
    git(['status', '--porcelain']),
    git(['log', '--max-count=60', `--pretty=format:%h${SEP}%s${SEP}%an${SEP}%ar${SEP}%D`]),
    git(['remote', 'get-url', 'origin']),
  ]);
  const log = (logRaw || '').split('\n').filter(Boolean).map(l => {
    const [hash, subject, author, date, refs] = l.split(SEP);
    return { hash, subject, author, date, refs: refs || '' };
  });
  const status = (statusRaw || '').split('\n').filter(Boolean).map(l => ({
    code: l.slice(0, 2), file: l.slice(3),
  }));
  res.json({
    isRepo: true,
    branch: (branch || '').trim(),
    remote: (remote || '').trim() || null,
    status,
    log,
  });
});

app.get('/api/git/show', async (req, res) => {
  const hash = String(req.query.hash || '');
  if (!/^[0-9a-f]{4,40}$/i.test(hash)) return res.status(400).json({ error: 'bad hash' });
  const out = await git(['show', '--stat', '--patch', '--no-color', hash]);
  if (out === null) return res.status(404).json({ error: 'git show failed' });
  res.json({ text: out.slice(0, 200_000), truncated: out.length > 200_000 });
});

// lets the CLI/tray stop the server on platforms without a service manager
app.post('/api/shutdown', (req, res) => {
  res.json({ ok: true });
  console.log('shutdown requested via API');
  setTimeout(() => process.exit(0), 300);
});

// ---------------------------------------------------------------------------
// Server self-management (the "App" card in the UI)
// ---------------------------------------------------------------------------
const INSTALLED = process.env.DECK_INSTALLED === '1';

app.post('/api/server/restart', (req, res) => {
  if (INSTALLED) {
    // exit(0) is enough: systemd (Restart=always) brings us back on new code
    res.json({ ok: true, note: 'restarting — back in a few seconds' });
    console.log('restart requested via API');
    setTimeout(() => process.exit(0), 300);
  } else {
    res.status(400).json({ error: 'running from a checkout (no service manager) — restart it from your terminal' });
  }
});

app.post('/api/server/stop', (req, res) => {
  res.json({ ok: true, note: 'stopping' });
  console.log('stop requested via API');
  if (INSTALLED && process.platform === 'linux') {
    // must go through systemd or Restart=always would just respawn us
    const p = spawn('systemctl', ['--user', 'stop', 'claude-deck.service'], { detached: true, stdio: 'ignore' });
    p.unref();
  } else {
    setTimeout(() => process.exit(0), 300);
  }
});

// kill duplicate tray icons and (when installed) start exactly one
app.post('/api/server/fix-tray', (req, res) => {
  if (process.platform !== 'linux') return res.status(400).json({ error: 'tray is linux-only right now' });
  execFile('pkill', ['-f', 'claude-deck/app/bin/tray.py'], () => {
    if (INSTALLED) {
      setTimeout(() => {
        const p = spawn('python3', [path.join(__dirname, 'bin', 'tray.py')], { detached: true, stdio: 'ignore' });
        p.unref();
      }, 500);
    }
    res.json({ ok: true, note: INSTALLED ? 'trays cleared; one fresh tray started' : 'trays cleared' });
  });
});

app.post('/api/server/uninstall', (req, res) => {
  if (String(req.body?.confirm) !== 'UNINSTALL') {
    return res.status(400).json({ error: 'confirmation text mismatch — type UNINSTALL exactly' });
  }
  console.log('uninstall requested via API');
  // detached child with cwd outside the app dir: it survives our shutdown and
  // can delete the install directory out from under itself safely on POSIX
  const p = spawn(process.execPath, [path.join(__dirname, 'bin', 'deck.js'), 'uninstall', '--yes'],
    { detached: true, stdio: 'ignore', cwd: os.tmpdir() });
  p.unref();
  res.json({ ok: true, note: 'uninstalling — this page will stop responding' });
});

app.post('/api/update', async (req, res) => {
  if (!updateInfo.available) return res.status(400).json({ error: 'no update available' });
  if (sessions.size > 0 && !req.body?.force) {
    return res.status(409).json({ error: `${sessions.size} claude session(s) running — applying restarts them (they stay resumable)`, needsForce: true });
  }
  const r = await applyUpdate();
  res.status(r.ok ? 200 : 500).json(r);
});

app.post('/api/update/check', async (req, res) => {
  await checkForUpdates();
  res.json(updateInfo);
});

// directory listing for the folder picker (dirs only)
app.get('/api/browse', (req, res) => {
  const target = path.resolve(String(req.query.path || HOME).replace(/^~(?=\/|$)/, HOME));
  try {
    if (!fs.statSync(target).isDirectory()) throw new Error('not a directory');
    const dirs = fs.readdirSync(target, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => ({ name: e.name, path: path.join(target, e.name), hidden: e.name.startsWith('.') }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const parent = path.dirname(target);
    res.json({ path: target, parent: parent !== target ? parent : null, dirs });
  } catch (e) { res.status(400).json({ error: String(e.message) }); }
});

app.post('/api/cwd', (req, res) => {
  const dir = String(req.body?.cwd || '');
  try {
    const resolved = path.resolve(dir.replace(/^~(?=\/|$)/, HOME));
    if (!fs.statSync(resolved).isDirectory()) throw new Error('not a directory');
    cwd = resolved;
    setupWatchers();
    broadcastEvent({ type: 'state' });
    res.json({ ok: true, cwd });
  } catch (e) { res.status(400).json({ error: String(e.message) }); }
});

// open a session's folder in VS Code. Tries the `code` CLI; on macOS falls back
// to `open -a` if `code` isn't on PATH. Fire-and-forget / detached.
app.post('/api/open-editor', (req, res) => {
  const raw = String(req.body?.cwd || '');
  if (!raw) return res.status(400).json({ error: 'cwd required' });
  let resolved;
  try {
    resolved = path.resolve(raw.replace(/^~(?=\/|$)/, HOME));
    if (!fs.statSync(resolved).isDirectory()) throw new Error('not a directory');
  } catch (e) { return res.status(400).json({ error: String(e.message) }); }
  const launch = (cmd, args) => {
    const p = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    p.unref();
    return p;
  };
  const p = launch('code', [resolved]);
  p.on('error', () => {
    if (process.platform === 'darwin') launch('open', ['-a', 'Visual Studio Code', resolved]).on('error', () => {});
  });
  res.json({ ok: true, cwd: resolved });
});

// bring back the sessions that were live before the last restart (one-click, from
// the banner). Re-opens each folder with --continue; skips any already running.
app.post('/api/sessions/restore', (req, res) => {
  const live = new Set([...sessions.values()]
    .filter(s => s.status !== 'exited').map(s => s.profile + '\0' + s.cwd));
  let started = 0;
  for (const item of pendingRestore) {
    if (live.has((item.profile || '') + '\0' + item.cwd)) continue;
    try { startSession({ cwd: item.cwd, profile: item.profile, args: restoreArgs(item.args), label: item.label, sandbox: item.sandbox }); started++; }
    catch {}
  }
  pendingRestore = [];
  broadcastEvent({ type: 'state' });
  res.json({ ok: true, started });
});

// dismiss the restore offer without re-opening anything
app.post('/api/sessions/restore/dismiss', (req, res) => {
  pendingRestore = [];
  broadcastEvent({ type: 'state' });
  res.json({ ok: true });
});

// switch which profile the dashboard reflects (config, memory, chats, account).
// re-discovers first so profiles created since startup show up.
app.post('/api/profile', (req, res) => {
  const id = String(req.body?.id || '');
  profiles = discoverProfiles();
  if (!profiles.some(p => p.id === activeProfileId)) activeProfileId = profiles[0].id;
  const prof = profiles.find(p => p.id === id);
  if (!prof) return res.status(400).json({ error: 'unknown profile' });
  activeProfileId = prof.id;
  setupWatchers();
  broadcastEvent({ type: 'state' });
  res.json({ ok: true, profile: { id: prof.id, label: prof.label, configDir: prof.configDir } });
});

// re-run sandbox capability detection (e.g. after the user starts Docker)
app.post('/api/sandbox/check', async (req, res) => {
  res.json(await checkSandbox());
});

// does this project ship its own .devcontainer/, and what did the user decide?
app.get('/api/sandbox/project', (req, res) => {
  const project = path.resolve(String(req.query.path || cwd).replace(/^~(?=\/|$)/, HOME));
  res.json({
    hasDevcontainer: !!projectDevcontainerConfig(project),
    decision: sandboxTrust()[project]?.decision ?? null,
  });
});

// record the once-per-project choice for a repo with its own .devcontainer/
app.post('/api/sandbox/trust', (req, res) => {
  const { path: p, decision } = req.body || {};
  try {
    if (!['project', 'bundled'].includes(decision)) throw new Error('decision must be "project" or "bundled"');
    const project = path.resolve(String(p || '').replace(/^~(?=\/|$)/, HOME));
    if (!fs.statSync(project).isDirectory()) throw new Error('not a directory');
    setSandboxTrust(project, decision);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: String(e.message) }); }
});

// ---------------------------------------------------------------------------
// WebSockets
// ---------------------------------------------------------------------------
const server = http.createServer(app);
const wssTerm = new WebSocketServer({ noServer: true });
const wssEvents = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  // WebSockets are NOT protected by CORS — enforce the same token gate here
  if (!authorized(req)) { socket.destroy(); return; }
  const pathname = req.url.split('?')[0];
  if (pathname === '/ws/term') wssTerm.handleUpgrade(req, socket, head, ws => wssTerm.emit('connection', ws));
  else if (pathname === '/ws/events') wssEvents.handleUpgrade(req, socket, head, ws => wssEvents.emit('connection', ws));
  else socket.destroy();
});

wssTerm.on('connection', ws => {
  termClients.add(ws);
  ws.on('close', () => termClients.delete(ws));
  // tell the new client what's alive; it asks for replay per session it doesn't have
  ws.send(JSON.stringify({ type: 'sessions', sessions: sessionList() }));
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const s = msg.sid ? sessions.get(msg.sid) : null;
    switch (msg.type) {
      case 'start':
        try { startSession(msg); }
        catch (e) { ws.send(JSON.stringify({ type: 'error', message: String(e.message) })); }
        break;
      case 'replay':
        if (s) ws.send(JSON.stringify({ type: 'data', sid: msg.sid, data: s.scrollback }));
        break;
      case 'input':
        if (s?.status === 'running') s.pty.write(msg.data);
        break;
      case 'resize':
        if (s?.status === 'running' && msg.cols > 0 && msg.rows > 0) {
          try { s.pty.resize(msg.cols, msg.rows); } catch {}
        }
        break;
      case 'label':
        // personal name for a tab; '' clears it back to the auto label
        if (s) {
          s.label = (typeof msg.label === 'string' && msg.label.trim()) ? msg.label.trim().slice(0, 60) : null;
          saveSessionSnapshot();
          broadcastTerm({ type: 'sessions', sessions: sessionList() });
        }
        break;
      case 'reorder':
        // client sends the full sid order; unknown sids dropped, missing appended
        if (Array.isArray(msg.order)) {
          const known = msg.order.filter(sid => sessions.has(sid));
          sessionOrder = [...known, ...[...sessions.keys()].filter(sid => !known.includes(sid))];
          saveSessionSnapshot();
          broadcastTerm({ type: 'sessions', sessions: sessionList() });
        }
        break;
      case 'stop':
        killSession(msg.sid);
        break;
      case 'close':
        killSession(msg.sid, true);
        broadcastEvent({ type: 'state' });
        break;
    }
  });
});

wssEvents.on('connection', ws => {
  eventClients.add(ws);
  ws.on('close', () => eventClients.delete(ws));
});

const PAGES_URL = process.env.DECK_PAGES_URL || 'https://amirbukhari.github.io/better-claude-cli-ui/';
loadPendingRestore(); // offer any sessions that were live before this restart
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Amir Hates The Claude CLI UI — running locally at http://127.0.0.1:${PORT}  (cwd: ${cwd})`);
  if (pendingRestore.length) console.log(`${pendingRestore.length} session(s) can be restored from the previous run`);
  if (profiles.length > 1) {
    console.log(`profiles: ${profiles.map(p => p.label + (p.isDefault ? ' (default)' : '')).join(', ')}`);
  }
  console.log(`From GitHub Pages, open:\n  ${PAGES_URL}?server=http://127.0.0.1:${PORT}&token=${accessToken}`);
});
