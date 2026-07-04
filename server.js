import express from 'express';
import { WebSocketServer } from 'ws';
import * as pty from 'node-pty';
import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const PORT = Number(process.env.PORT || 3456);

// The directory Claude runs in. Defaults to where you launched this server.
let cwd = process.env.CLAUDE_UI_CWD || process.cwd();

// ---------------------------------------------------------------------------
// Config file locations
// ---------------------------------------------------------------------------
const paths = () => ({
  userSettings: path.join(HOME, '.claude', 'settings.json'),
  projectSettings: path.join(cwd, '.claude', 'settings.json'),
  localSettings: path.join(cwd, '.claude', 'settings.local.json'),
  managedSettings: '/etc/claude-code/managed-settings.json',
  claudeJson: path.join(HOME, '.claude.json'),
  projectMcp: path.join(cwd, '.mcp.json'),
  keybindings: path.join(HOME, '.claude', 'keybindings.json'),
  userMemory: path.join(HOME, '.claude', 'CLAUDE.md'),
  projectMemory: path.join(cwd, 'CLAUDE.md'),
  localMemory: path.join(cwd, 'CLAUDE.local.md'),
});

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
  const resolved = path.resolve(file);
  const exact = [
    p.userSettings, p.projectSettings, p.localSettings, p.projectMcp,
    p.keybindings, p.userMemory, p.projectMemory, p.localMemory,
  ];
  if (exact.includes(resolved)) return true;
  const roots = [
    path.join(HOME, '.claude', 'agents'),
    path.join(HOME, '.claude', 'skills'),
    path.join(HOME, '.claude', 'commands'),
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
    ...listMarkdownDir(path.join(HOME, '.claude', sub), 'user', kind),
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
function sessionDirFor(projectPath) {
  const encoded = projectPath.replace(/[^a-zA-Z0-9-]/g, '-');
  return path.join(HOME, '.claude', 'projects', encoded);
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

function getState() {
  const p = paths();
  const claudeJson = readJsonFile(p.claudeJson);
  const cj = claudeJson.json || {};
  const projectEntry = (cj.projects || {})[cwd] || null;

  return {
    cwd,
    home: HOME,
    claudeVersion,
    terminal: { sessions: sessionList() },
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
    memory: {
      user: { path: p.userMemory, ...readTextFile(p.userMemory) },
      project: { path: p.projectMemory, ...readTextFile(p.projectMemory) },
      local: { path: p.localMemory, ...readTextFile(p.localMemory) },
    },
    keybindings: { path: p.keybindings, ...readJsonFile(p.keybindings) },
    ...discover(),
    builtinCommands,
    update: updateInfo,
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
    execFile('npm', ['install', '--omit=dev', '--no-fund', '--no-audit'],
      { cwd: __dirname, timeout: 300_000, env }, () => resolve());
  });
  console.log('update applied — exiting so the service manager restarts on the new code');
  setTimeout(() => process.exit(0), 400); // under systemd Restart=always this is a relaunch
  return { ok: true, restarting: true };
}

setTimeout(checkForUpdates, 15_000);            // shortly after boot
setInterval(checkForUpdates, 6 * 3600 * 1000);  // then every 6 hours

// ---------------------------------------------------------------------------
// PTY sessions — multiple concurrent claude processes, one per tab in the UI
// ---------------------------------------------------------------------------
const SCROLLBACK_MAX = 400_000;
const sessions = new Map(); // sid -> { pty, cwd, args, scrollback, status, pid, createdAt }
let sidCounter = 0;
const termClients = new Set();
const eventClients = new Set();

function broadcastTerm(msg) {
  const s = JSON.stringify(msg);
  for (const ws of termClients) if (ws.readyState === 1) ws.send(s);
}
function broadcastEvent(msg) {
  const s = JSON.stringify(msg);
  for (const ws of eventClients) if (ws.readyState === 1) ws.send(s);
}

const sessionInfo = (sid, s) => ({ sid, pid: s.pid, cwd: s.cwd, args: s.args, status: s.status, createdAt: s.createdAt });
const sessionList = () => [...sessions.entries()].map(([sid, s]) => sessionInfo(sid, s));

function startSession({ cwd: dir, args = [], cols = 120, rows = 32 } = {}) {
  const resolved = path.resolve(String(dir || cwd).replace(/^~(?=\/|$)/, HOME));
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error('not a directory: ' + resolved);
  }
  const sid = 's' + (++sidCounter);
  const proc = pty.spawn('claude', (Array.isArray(args) ? args : []).map(String), {
    name: 'xterm-256color',
    cols: cols > 0 ? cols : 120, rows: rows > 0 ? rows : 32,
    cwd: resolved,
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  });
  const sess = { pty: proc, cwd: resolved, args, scrollback: '', status: 'running', pid: proc.pid, createdAt: Date.now() };
  sessions.set(sid, sess);
  proc.onData(d => {
    sess.scrollback = (sess.scrollback + d).slice(-SCROLLBACK_MAX);
    broadcastTerm({ type: 'data', sid, data: d });
  });
  proc.onExit(({ exitCode }) => {
    sess.status = 'exited';
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
  if (remove) sessions.delete(sid);
}

// ---------------------------------------------------------------------------
// File watching → live dashboard refresh
// ---------------------------------------------------------------------------
const watchers = [];
let watchDebounce = null;
function setupWatchers() {
  for (const w of watchers.splice(0)) { try { w.close(); } catch {} }
  const p = paths();
  const targets = [
    path.join(HOME, '.claude'),
    path.join(cwd, '.claude'),
    p.claudeJson, p.projectMcp, p.projectMemory, p.localMemory,
    path.join(HOME, '.claude', 'agents'), path.join(HOME, '.claude', 'skills'), path.join(HOME, '.claude', 'commands'),
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
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Amir Hates The Claude CLI UI — running locally at http://127.0.0.1:${PORT}  (cwd: ${cwd})`);
  console.log(`From GitHub Pages, open:\n  ${PAGES_URL}?server=http://127.0.0.1:${PORT}&token=${accessToken}`);
});
