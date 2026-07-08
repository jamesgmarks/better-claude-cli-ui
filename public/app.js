/* Amir Hates The Claude CLI UI — frontend */
'use strict';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const $ = s => document.querySelector(s);

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'title' || k === 'placeholder' || k === 'value' || k === 'type' || k === 'spellcheck') n[k] = v;
    else n.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null) continue;
    n.append(c.nodeType ? c : document.createTextNode(c));
  }
  return n;
}

// replaceChildren that tolerates nested arrays and nulls
function setChildren(node, ...kids) {
  node.replaceChildren(...kids.flat(Infinity).filter(Boolean));
}

// attrs that make a div/span a real keyboard-operable button
function press(handler, label) {
  return {
    role: 'button', tabindex: '0',
    onclick: handler,
    onkeydown: e => {
      if (e.target !== e.currentTarget) return; // don't hijack nested buttons
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(e); }
    },
    ...(label ? { 'aria-label': label } : {}),
  };
}

// disable a button while its async work runs (prevents double-submit)
async function busy(btn, fn) {
  if (btn.disabled) return;
  btn.disabled = true;
  try { await fn(); } finally { btn.disabled = false; }
}

// relative time for lists; absolute goes in the title attribute
function relTime(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ms).toLocaleDateString();
}

let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.className = '', isError ? 5000 : 2600);
}

// ---------------------------------------------------------------------------
// server connection — same-origin when served locally, or a local server
// reached from GitHub Pages via ?server=…&token=… (persisted after first use)
// ---------------------------------------------------------------------------
const bootParams = new URLSearchParams(location.search);
if (bootParams.get('server')) localStorage.setItem('deckServer', bootParams.get('server').replace(/\/$/, ''));
if (bootParams.get('token')) localStorage.setItem('deckToken', bootParams.get('token'));
const IS_STATIC_HOST = location.protocol === 'file:' || /github\.io$/.test(location.hostname);
const SERVER = localStorage.getItem('deckServer') || (IS_STATIC_HOST ? 'http://127.0.0.1:3456' : location.origin);
const TOKEN = localStorage.getItem('deckToken') || '';
const REMOTE = SERVER !== location.origin;

function apiUrl(p) {
  const tok = REMOTE && TOKEN ? (p.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(TOKEN) : '';
  return SERVER + p + tok;
}
function wsUrl(p) {
  const tok = REMOTE && TOKEN ? '?token=' + encodeURIComponent(TOKEN) : '';
  return SERVER.replace(/^http/, 'ws') + p + tok;
}

async function api(method, url, body) {
  const res = await fetch(apiUrl(url), {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || res.statusText);
  return j;
}

// simple connect screen when the local server can't be reached from a static host
function showConnectHelp(err) {
  const srvIn = el('input', { type: 'text', value: SERVER, 'aria-label': 'Server URL', placeholder: 'http://127.0.0.1:3456' });
  const tokIn = el('input', { type: 'text', value: TOKEN, 'aria-label': 'Access token', placeholder: 'token printed by the server' });
  setChildren($('#tab-config'),
    el('div', { class: 'card open' },
      el('div', { class: 'card-head' }, '🔌 Connect to your machine'),
      el('div', { class: 'card-body' },
        el('div', { class: 'hint' }, `This page is static — it needs the Deck server on your machine. (${err})`),
        el('div', { class: 'subhead' }, 'Already installed?'),
        el('div', { class: 'row' }, el('a', { href: 'claude-deck://open', class: 'chip' }, '🚀 Open my Deck'),
          el('span', { class: 'hint' }, 'wakes the local server via the claude-deck:// handler')),
        el('div', { class: 'subhead' }, 'First time? One command installs it (service + one-click opens):'),
        el('pre', { class: 'mini' }, 'npx github:amirbukhari/better-claude-cli-ui install'),
        el('div', { class: 'hint' }, 'Uninstall just as easily: npx github:amirbukhari/better-claude-cli-ui uninstall'),
        el('div', { class: 'subhead' }, 'Then connect'),
        el('div', { class: 'hint' }, 'Copy the ?server=…&token=… URL the installer prints, or paste the values here:'),
        el('div', { class: 'row' }, el('label', {}, 'Server'), srvIn),
        el('div', { class: 'row' }, el('label', {}, 'Token'), tokIn),
        el('div', { class: 'row' }, el('button', {
          class: 'primary', onclick: () => {
            localStorage.setItem('deckServer', srvIn.value.trim().replace(/\/$/, ''));
            localStorage.setItem('deckToken', tokIn.value.trim());
            location.reload();
          },
        }, 'Connect')),
      ),
    ),
  );
}

// mutate + toast; the file watcher pushes a refresh, but refresh eagerly too
async function mutate(promise, okMsg = 'Saved') {
  try {
    await promise;
    toast(okMsg + ' — new sessions pick this up (restart Claude to apply now)');
    refreshState();
  } catch (e) {
    toast(e.message, true);
  }
}

// ---------------------------------------------------------------------------
// terminal
// ---------------------------------------------------------------------------
const TERM_OPTS = {
  fontFamily: '"JetBrains Mono", "SF Mono", Menlo, Consolas, monospace',
  fontSize: 13,
  cursorBlink: true,
  scrollback: 8000,
  allowProposedApi: true,
  theme: {
    background: '#0B1120', foreground: '#F8FAFC', cursor: '#22C55E',
    selectionBackground: '#334155',
    black: '#0B1120', red: '#EF4444', green: '#22C55E', yellow: '#EAB308',
    blue: '#60A5FA', magenta: '#C084FC', cyan: '#22D3EE', white: '#F8FAFC',
    brightBlack: '#64748B', brightRed: '#F87171', brightGreen: '#4ADE80',
    brightYellow: '#FACC15', brightBlue: '#93C5FD', brightMagenta: '#D8B4FE',
    brightCyan: '#67E8F9', brightWhite: '#FFFFFF',
  },
};

// Multiple concurrent sessions, one xterm instance per tab
let termWs = null;
const terms = new Map(); // sid -> { term, fit, div, info }
let activeSid = null;

function wsSend(m) { if (termWs?.readyState === 1) termWs.send(JSON.stringify(m)); }

// The one place that measures a terminal and tells its PTY the new size. Every
// resize trigger — tab activation, the per-terminal and panel ResizeObservers,
// divider drags, window resize — routes through here. No-ops for a hidden tab
// (zero-sized), so callers don't each need that guard.
function refit(sid) {
  const t = terms.get(sid);
  if (!t || !t.div.clientWidth || !t.div.clientHeight) return;
  t.fit.fit();
  if (t.term.cols > 0) wsSend({ type: 'resize', sid, cols: t.term.cols, rows: t.term.rows });
}

const shortDir = p => (p || '').split('/').pop() || p || '?';

// VS Code logo (simple-icons path), inlined so the CSP can't block a remote asset
const VSCODE_ICON_SVG = '<svg viewBox="0 0 24 24" fill="#0098FF" aria-hidden="true"><path d="M23.15 2.587L18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448v10.896z"/></svg>';

function ensureTerm(info) {
  const existing = terms.get(info.sid);
  if (existing) { existing.info = { ...existing.info, ...info }; return { t: existing, isNew: false }; }
  const div = el('div', { class: 'term-instance', style: 'display:none' });
  $('#terminal').append(div);
  const term = new Terminal(TERM_OPTS);
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(div);
  term.onData(d => {
    t.lastKeyAt = Date.now();
    if (d.includes('\r')) t.lastEnterAt = t.lastKeyAt;
    wsSend({ type: 'input', sid: info.sid, data: d });
  });
  const t = { term, fit, div, info };
  // Refit whenever THIS terminal's div gains a real size. A hidden tab has size
  // 0; activating it flips 0 -> real width, which fires this and fits at exactly
  // the moment the panel has laid out — fixing the "compressed to 1 column after
  // reload" case that the panel-level ResizeObserver misses (switching tabs
  // doesn't change #terminal's size, so it never refires).
  t.ro = new ResizeObserver(() => { if (activeSid === info.sid) refit(info.sid); });
  t.ro.observe(div);
  // Overlay a low-key "open this folder in VS Code" button in the corner.
  // tabindex=-1 so Tab (which goes to the terminal when active) can never land
  // on it; it stays faint until hovered so it doesn't hide terminal content.
  const vscodeBtn = el('button', {
    class: 'term-vscode', tabindex: '-1',
    title: 'Open this folder in VS Code', 'aria-label': 'Open this folder in VS Code',
    onclick: e => { e.stopPropagation(); openInEditor(t.info?.cwd); },
  });
  vscodeBtn.innerHTML = VSCODE_ICON_SVG;
  div.append(vscodeBtn);
  terms.set(info.sid, t);
  updateEmptyState();
  return { t, isNew: true };
}

// Open a session's working directory in VS Code (server shells out to `code`).
async function openInEditor(cwd) {
  if (!cwd) return;
  try {
    await api('POST', '/api/open-editor', { cwd });
    toast('Opening ' + shortDir(cwd) + ' in VS Code…');
  } catch (e) { toast(e.message, true); }
}

function removeTerm(sid) {
  const t = terms.get(sid);
  if (!t) return;
  t.ro?.disconnect();
  t.term.dispose();
  t.div.remove();
  terms.delete(sid);
  if (activeSid === sid) {
    activeSid = null;
    const rest = [...terms.keys()];
    if (rest.length) activateSession(rest[rest.length - 1]);
  }
  updateEmptyState();
  renderSessionTabs();
  setStatus();
}

function updateEmptyState() {
  $('#term-empty').style.display = terms.size ? 'none' : '';
}

function activateSession(sid) {
  const t = terms.get(sid);
  if (!t) return;
  activeSid = sid;
  for (const [id, other] of terms) other.div.style.display = id === sid ? '' : 'none';
  requestAnimationFrame(() => {
    refit(sid);
    // A tab that was display:none leaves xterm's renderer dormant; if the fit
    // didn't change dimensions there's no auto-redraw, so the just-shown tab can
    // paint a stale canvas until a manual resize forces it. Force the repaint.
    t.term.refresh(0, t.term.rows - 1);
    // A reconnected tab may still show stale/garbled scrollback: resizing the
    // PTY to a size it already has emits no SIGWINCH, so Claude never redraws
    // (this is why only a manual window "shimmy" fixed it). The first time such
    // a tab is shown, nudge the PTY by one row and back to guarantee a real
    // SIGWINCH and a full TUI repaint. Only the PTY is nudged, not xterm, so the
    // visible grid never reflows.
    if (t.needsRepaint) {
      t.needsRepaint = false;
      const { cols, rows } = t.term;
      if (cols > 0 && rows > 1) {
        wsSend({ type: 'resize', sid, cols, rows: rows - 1 });
        wsSend({ type: 'resize', sid, cols, rows });
      }
    }
    t.term.focus();
  });
  renderSessionTabs();
  setStatus();
  // the dashboard (config, git, "this project" chats) follows the active session:
  // both its project (cwd) and its profile (which Claude config/account it runs)
  const sync = [];
  if (t.info?.profile && state && t.info.profile !== state.activeProfileId)
    sync.push(api('POST', '/api/profile', { id: t.info.profile }));
  if (t.info?.cwd && state && t.info.cwd !== state.cwd)
    sync.push(api('POST', '/api/cwd', { cwd: t.info.cwd }));
  if (sync.length) Promise.all(sync).then(refreshState).catch(() => {});
}

// ---------------------------------------------------------------------------
// Tab-by-number shortcuts — browser convention: 1-8 select that tab, 9 = last.
// A browser tab reserves Cmd/Ctrl+number for its OWN tabs, so in a normal tab
// the tab-safe modifier does the work (Ctrl on Mac, Alt on Win/Linux); we also
// accept the native Cmd/Ctrl so it "just works" as a standalone/PWA window,
// where those accelerators actually reach the page. Matched on e.code so that
// Option+digit (which reports e.key "¡" etc. on Mac) still maps to its number.
// Numbering follows the on-screen order (orderedTerms), so it tracks auto-focus.
// ---------------------------------------------------------------------------
const IS_MAC = /Mac|iP(hone|ad|od)/.test(navigator.platform) || /Mac/.test(navigator.userAgent);
window.addEventListener('keydown', e => {
  const m = /^Digit([1-9])$/.exec(e.code);
  if (!m || e.shiftKey) return;
  const mod = IS_MAC ? (e.ctrlKey || e.metaKey) : (e.ctrlKey || e.altKey);
  if (!mod) return;
  const order = orderedTerms();
  if (!order.length) return;
  const n = Number(m[1]);
  const idx = n === 9 ? order.length - 1 : n - 1; // 9 always jumps to the last tab
  if (idx >= order.length) return;                // 1-8 past the tab count: no-op
  e.preventDefault();
  e.stopPropagation();
  activateSession(order[idx][0]);
}, true); // capture phase so we win before the terminal (xterm) sees the keys

// While that modifier is held, reveal each tab's number (like iTerm/browsers do).
function syncTabNumberHint(e) {
  const on = IS_MAC ? (e.ctrlKey || e.metaKey) : (e.ctrlKey || e.altKey);
  $('#session-tabs')?.classList.toggle('show-tab-numbers', on);
}
window.addEventListener('keydown', syncTabNumberHint);
window.addEventListener('keyup', syncTabNumberHint);
// releasing the key outside the window (blur/alt-tab) would strand the hint on
window.addEventListener('blur', () => $('#session-tabs')?.classList.remove('show-tab-numbers'));

// move the active tab left/right: Cmd/Ctrl+Shift+Arrow (capture, to beat xterm)
window.addEventListener('keydown', e => {
  const mod = IS_MAC ? e.metaKey : e.ctrlKey;
  if (!mod || !e.shiftKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
  // allow it over the terminal (xterm's hidden helper textarea) but not in real
  // form fields like rename / extra-args / the path box
  const ae = document.activeElement;
  const inField = ae && (ae.tagName === 'INPUT'
    || (ae.tagName === 'TEXTAREA' && !ae.classList.contains('xterm-helper-textarea')));
  if (inField || !activeSid) return;
  e.preventDefault(); e.stopPropagation();
  moveTab(activeSid, e.key === 'ArrowRight' ? 1 : -1);
}, true);

// new tab: Cmd/Ctrl+N (capture, to beat xterm). A browser tab reserves
// Cmd/Ctrl+N for a new window, so like the digit shortcuts we also take the
// tab-safe modifier (Ctrl on Mac, Alt on Win/Linux); the native one works in
// a standalone/PWA window.
window.addEventListener('keydown', e => {
  if (e.code !== 'KeyN' || e.shiftKey) return;
  const mod = IS_MAC ? (e.ctrlKey || e.metaKey) : (e.ctrlKey || e.altKey);
  if (!mod) return;
  const ae = document.activeElement;
  const inField = ae && (ae.tagName === 'INPUT'
    || (ae.tagName === 'TEXTAREA' && !ae.classList.contains('xterm-helper-textarea')));
  if (inField || !state || $('#dir-modal').open) return;
  e.preventDefault(); e.stopPropagation();
  openDirPicker('new-session');
}, true);

// ---------------------------------------------------------------------------
// auto-focus (opt-in): waiting tabs sort to the front; when the active
// session starts working, jump to whichever session is waiting on you
// ---------------------------------------------------------------------------
let autoFocus = localStorage.getItem('autoFocus') === '1';
let lastAutoSwitch = 0;

const ATTENTION_ORDER = { question: 0, ready: 1, working: 2, exited: 3 };

function orderedTerms() {
  const entries = [...terms.entries()];
  // auto-focus overrides manual order: waiting sessions sort to the front
  if (autoFocus) return entries.sort((a, b) =>
    (ATTENTION_ORDER[activityOf(a[1].info)] ?? 2) - (ATTENTION_ORDER[activityOf(b[1].info)] ?? 2)
    || (a[1].info?.createdAt || 0) - (b[1].info?.createdAt || 0));
  // otherwise the user's manual tab order (server-persisted) wins
  return entries.sort((a, b) => (a[1].info?.order ?? 1e9) - (b[1].info?.order ?? 1e9));
}

// typing echo makes an idle session look "working" — never yank the view
// mid-typing; do jump right after a submit (that's the "I answered, next" moment)
function typingGuardOk(t) {
  const now = Date.now();
  const sinceKey = now - (t.lastKeyAt || 0);
  const sinceEnter = now - (t.lastEnterAt || 0);
  return sinceEnter < 3000 || sinceKey > 5000;
}

function maybeAutoFocus() {
  if (!autoFocus) return;
  const active = terms.get(activeSid);
  if (!active || activityOf(active.info) !== 'working') return; // never leave a tab that needs you
  if (!typingGuardOk(active)) return;
  if (Date.now() - lastAutoSwitch < 2000) return;
  const next = orderedTerms().find(([sid, t]) =>
    sid !== activeSid && ['question', 'ready'].includes(activityOf(t.info)));
  if (next) {
    lastAutoSwitch = Date.now();
    activateSession(next[0]);
    toast(`🎯 ${shortDir(next[1].info?.cwd)} is waiting on you`);
  }
}

// agent state → how the tab signals it, at a glance
const ACTIVITY_UI = {
  working: { cls: 'working', label: 'working…', hint: 'Claude is working — no action needed' },
  ready: { cls: 'ready', label: 'your turn', hint: 'Claude is done / idle — waiting on you' },
  question: { cls: 'question', label: '❓ asking you', hint: 'Claude is asking a question or needs permission' },
  exited: { cls: 'off', label: 'exited', hint: 'Session ended — ✕ to remove the tab' },
};

function activityOf(info) {
  return info.status === 'exited' ? 'exited' : (info.activity || 'working');
}

function renderSessionTabs() {
  const bar = $('#session-tabs');
  const order = orderedTerms();
  const canReorder = !autoFocus && editingSid == null; // drag/keyboard only in manual mode
  const tabs = order.map(([sid, t], i) => {
    const info = t.info || {};
    const act = activityOf(info);
    const ui = ACTIVITY_UI[act] || ACTIVITY_UI.working;
    const flavor = info.args?.includes('--continue') ? '⏩ ' : info.args?.includes('--resume') ? '⟲ ' : '';
    const context = `${flavor}${shortDir(info.cwd)}`;
    // show which account a tab runs under, but only when more than one exists
    const prof = (state?.profiles?.length > 1) && state.profiles.find(p => p.id === info.profile);
    // number to press with the modifier held (revealed via #session-tabs.show-tab-numbers):
    // mirrors the shortcut — 1-8 by position, and 9 for the last tab beyond that.
    const kbdNum = i < 8 ? i + 1 : (i === order.length - 1 ? 9 : null);
    // a named tab shows the personal label on top with its folder/context below
    const labelNode = editingSid === sid
      ? el('input', {
          class: 'sess-rename', value: info.label || '', spellcheck: false, 'aria-label': 'Tab name',
          onkeydown: e => {
            e.stopPropagation();
            if (e.key === 'Enter') { e.preventDefault(); commitRename(sid, e.target.value); }
            else if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
          },
          onblur: e => commitRename(sid, e.target.value),
          onpointerdown: e => e.stopPropagation(),
          onclick: e => e.stopPropagation(),
        })
      : info.label
        ? el('span', { class: 'sess-named' },
            el('span', { class: 'sess-name' }, info.label),
            el('span', { class: 'sess-sub' }, context))
        : el('span', { class: 'sess-label' }, context);
    return el('div', {
      class: 'sess-tab' + (sid === activeSid ? ' active' : '') + (act === 'exited' ? ' dead' : '')
        + ' act-' + ui.cls + (canReorder ? ' draggable' : ''),
      title: `${info.label ? info.label + '\n' : ''}${ui.hint}\n${info.cwd || ''}${prof ? '\nprofile: ' + prof.label : ''}${info.args?.length ? '\nclaude ' + info.args.join(' ') : ''}`,
      draggable: canReorder ? 'true' : 'false',
      ondragstart: e => { dragSid = sid; e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', sid); } catch {} e.currentTarget.classList.add('dragging'); },
      ondragend: e => { dragSid = null; e.currentTarget.classList.remove('dragging'); clearDropMarks(); },
      ondragover: e => { if (!canReorder || !dragSid || dragSid === sid) return; e.preventDefault(); markDrop(e.currentTarget, e.clientX); },
      ondragleave: e => { e.currentTarget.classList.remove('drop-before', 'drop-after'); },
      ondrop: e => { if (!canReorder || !dragSid || dragSid === sid) return; e.preventDefault(); dropReorder(dragSid, sid, isAfter(e.currentTarget, e.clientX)); },
      oncontextmenu: e => { e.preventDefault(); showTabMenu(sid, e.clientX, e.clientY); },
      ondblclick: e => { e.preventDefault(); startRename(sid); },
      onmousedown: e => { if (e.button === 1) e.preventDefault(); }, // no middle-click autoscroll
      onauxclick: e => { if (e.button === 1) { e.preventDefault(); closeSession(sid); } }, // middle-click closes (with confirm)
      ...press(() => activateSession(sid), `Switch to session in ${shortDir(info.cwd)} (${ui.label})`),
    },
      kbdNum != null ? el('span', { class: 'sess-num', 'aria-hidden': 'true' }, String(kbdNum)) : null,
      el('span', { class: 'sess-dot ' + ui.cls, 'aria-hidden': 'true' }),
      prof ? el('span', { class: 'sess-prof' }, prof.label) : null,
      labelNode,
      act === 'question' ? el('span', { class: 'sess-ask' }, '?') : null,
      el('button', {
        class: 'sess-close', 'aria-label': 'Close session in ' + shortDir(info.cwd),
        title: act === 'exited' ? 'Remove tab' : 'Kill this session and close the tab',
        onclick: e => { e.stopPropagation(); closeSession(sid); },
      }, '✕'),
    );
  });
  setChildren(bar, tabs, el('button', {
    class: 'sess-new',
    title: 'Pick a folder, then start a new Claude session there',
    onclick: () => openDirPicker('new-session'),
  }, '+ New'));
  if (editingSid != null) { const inp = bar.querySelector('.sess-rename'); if (inp) { inp.focus(); inp.select(); } }
  updateDocTitle();
}

// ---- tab naming + manual reordering ----------------------------------------
let editingSid = null; // sid whose tab is being renamed inline
let dragSid = null;    // sid currently being dragged

const visibleSids = () => orderedTerms().map(([sid]) => sid);
const isAfter = (tabEl, x) => { const r = tabEl.getBoundingClientRect(); return x > r.left + r.width / 2; };
const clearDropMarks = () => $('#session-tabs')?.querySelectorAll('.drop-before,.drop-after').forEach(n => n.classList.remove('drop-before', 'drop-after'));
function markDrop(tabEl, x) { clearDropMarks(); tabEl.classList.toggle('drop-after', isAfter(tabEl, x)); tabEl.classList.toggle('drop-before', !isAfter(tabEl, x)); }

// persist a new order (optimistically reflect it locally; server echoes it back)
function applyOrder(sids) {
  sids.forEach((s, i) => { const t = terms.get(s); if (t?.info) t.info.order = i; });
  wsSend({ type: 'reorder', order: sids });
  renderSessionTabs();
}
function dropReorder(from, to, after) {
  const sids = visibleSids().filter(s => s !== from);
  let idx = sids.indexOf(to);
  idx = idx < 0 ? sids.length : after ? idx + 1 : idx;
  sids.splice(idx, 0, from);
  applyOrder(sids);
}
function moveTab(sid, delta) {
  if (autoFocus) { toast('Turn off 🎯 auto-focus to arrange tabs by hand'); return; }
  const sids = visibleSids();
  const i = sids.indexOf(sid), j = i + delta;
  if (i < 0 || j < 0 || j >= sids.length) return;
  sids.splice(j, 0, sids.splice(i, 1)[0]);
  applyOrder(sids);
}

function startRename(sid) { if (terms.has(sid)) { editingSid = sid; renderSessionTabs(); } }
function cancelRename() { editingSid = null; renderSessionTabs(); }
function commitRename(sid, val) {
  if (editingSid !== sid) return; // Enter already committed; ignore the trailing blur
  editingSid = null;
  const label = (val || '').trim();
  const t = terms.get(sid); if (t?.info) t.info.label = label || null; // optimistic
  wsSend({ type: 'label', sid, label });
  renderSessionTabs();
}

// right-click tab menu: rename / move / close
let tabMenu = null;
function closeTabMenu() {
  if (!tabMenu) return;
  tabMenu.remove(); tabMenu = null;
  document.removeEventListener('pointerdown', onMenuAway, true);
  document.removeEventListener('keydown', onMenuKey, true);
}
function onMenuAway(e) { if (tabMenu && !tabMenu.contains(e.target)) closeTabMenu(); }
function onMenuKey(e) { if (e.key === 'Escape') { e.preventDefault(); closeTabMenu(); } }
function showTabMenu(sid, x, y) {
  closeTabMenu();
  const sids = visibleSids();
  const i = sids.indexOf(sid);
  const exited = terms.get(sid)?.info?.status === 'exited';
  const item = (text, fn, disabled) => el('button', {
    class: 'menu-item', role: 'menuitem', ...(disabled ? { disabled: 'disabled' } : {}),
    onclick: () => { closeTabMenu(); if (!disabled) fn(); },
  }, text);
  tabMenu = el('div', { class: 'tab-menu', role: 'menu' },
    item('Rename…', () => startRename(sid)),
    item('Move left', () => moveTab(sid, -1), autoFocus || i <= 0),
    item('Move right', () => moveTab(sid, +1), autoFocus || i < 0 || i >= sids.length - 1),
    item(exited ? 'Remove tab' : 'Close', () => closeSession(sid)),
  );
  document.body.append(tabMenu);
  tabMenu.style.left = Math.max(6, Math.min(x, innerWidth - tabMenu.offsetWidth - 6)) + 'px';
  tabMenu.style.top = Math.max(6, Math.min(y, innerHeight - tabMenu.offsetHeight - 6)) + 'px';
  setTimeout(() => {
    document.addEventListener('pointerdown', onMenuAway, true);
    document.addEventListener('keydown', onMenuKey, true);
  }, 0);
}

// browser tab shows what needs you, even when the Deck isn't focused
function updateDocTitle() {
  let asking = 0, ready = 0, working = 0;
  for (const [, t] of terms) {
    const a = activityOf(t.info || {});
    if (a === 'question') asking++;
    else if (a === 'ready') ready++;
    else if (a === 'working') working++;
  }
  const parts = [];
  if (asking) parts.push(`❓${asking}`);
  if (ready) parts.push(`🟡${ready}`);
  if (working) parts.push(`⏳${working}`);
  document.title = (parts.length ? parts.join(' ') + ' · ' : '') + 'Claude Deck';
}

function closeSession(sid) {
  const t = terms.get(sid);
  if (!t) return;
  const running = t.info?.status !== 'exited';
  if (running && !confirm(`Kill the Claude session in ${shortDir(t.info?.cwd)}? Its conversation stays resumable from the Conversations tab.`)) return;
  wsSend({ type: 'close', sid });
  removeTerm(sid);
}

function connectTerm() {
  termWs = new WebSocket(wsUrl('/ws/term'));
  termWs.onmessage = ev => {
    const m = JSON.parse(ev.data);
    switch (m.type) {
      case 'sessions': {
        for (const info of m.sessions) {
          const { t, isNew } = ensureTerm(info);
          if (isNew) {
            // Match the terminal to the PTY's real size BEFORE replaying, so the
            // replayed TUI renders at the width Claude produced it at. Hidden
            // tabs can't self-measure (they'd sit at xterm's default 80 cols and
            // garble the replay), so we use the server-reported PTY dimensions
            // rather than racing a fit against the incoming replay data.
            if (info.cols > 0 && info.rows > 0) t.term.resize(info.cols, info.rows);
            wsSend({ type: 'replay', sid: info.sid });
            // Belt-and-suspenders: also force Claude to repaint the first time
            // this reconnected tab is shown, in case the replay still rendered
            // at the wrong width (e.g. the server couldn't report PTY dims).
            t.needsRepaint = true;
          }
        }
        if (!activeSid && m.sessions.length) activateSession(m.sessions[m.sessions.length - 1].sid);
        renderSessionTabs();
        setStatus();
        break;
      }
      case 'session-started':
        ensureTerm(m.session);
        activateSession(m.session.sid);
        break;
      case 'data':
        terms.get(m.sid)?.term.write(m.data);
        break;
      case 'exit': {
        const t = terms.get(m.sid);
        if (t) {
          t.info.status = 'exited';
          t.term.write(`\r\n\x1b[90m[claude exited${m.code != null ? ' with code ' + m.code : ''} — close the tab or resume from Conversations]\x1b[0m\r\n`);
          renderSessionTabs();
          setStatus();
        }
        break;
      }
      case 'activity': {
        const t = terms.get(m.sid);
        if (t && t.info.activity !== m.activity) {
          t.info.activity = m.activity;
          renderSessionTabs();
          setStatus();
          maybeAutoFocus();
        }
        break;
      }
      case 'error':
        toast(m.message, true);
        break;
    }
  };
  termWs.onclose = () => {
    setStatus();
    setTimeout(connectTerm, 1500);
  };
}
connectTerm();

// resize the active terminal (panel ResizeObserver, divider drag/keys, window)
function sendResize() { if (activeSid) refit(activeSid); }
new ResizeObserver(() => sendResize()).observe($('#terminal'));

function setStatus() {
  const live = [...terms.values()].filter(t => t.info?.status !== 'exited');
  const needsYou = live.filter(t => ['ready', 'question'].includes(t.info?.activity)).length;
  const n = live.length;
  $('#status-dot').className = 'dot ' + (n ? 'on' : 'off');
  $('#status-text').textContent = n
    ? `${n} session${n === 1 ? '' : 's'}${needsYou ? ` · ${needsYou} waiting on you` : ''}`
    : 'no sessions';
}

$('#flag-autofocus').checked = autoFocus;
$('#flag-autofocus').onchange = e => {
  autoFocus = e.target.checked;
  localStorage.setItem('autoFocus', autoFocus ? '1' : '0');
  renderSessionTabs();
  if (autoFocus) maybeAutoFocus();
  toast(autoFocus ? '🎯 Auto-focus on — sessions waiting on you come to the front' : 'Auto-focus off');
};

// start a NEW session tab; never touches the ones already running
function startClaude(extra = [], cwdOverride = null, profileOverride = null) {
  const args = [...extra];
  if ($('#flag-skip').checked) args.push('--dangerously-skip-permissions');
  const typed = $('#extra-args').value.trim();
  if (typed) args.push(...typed.split(/\s+/));
  wsSend({ type: 'start', cwd: cwdOverride || state?.cwd, args, cols: 120, rows: 32, profile: profileOverride || state?.activeProfileId });
}

$('#btn-start').onclick = () => openDirPicker('new-session');
$('#btn-continue').onclick = () => openDirPicker('new-session', ['--continue']);
$('#btn-stop').onclick = () => {
  const t = activeSid && terms.get(activeSid);
  if (!t || t.info?.status === 'exited') { toast('The active tab has no running session'); return; }
  if (confirm(`Kill the Claude session in ${shortDir(t.info?.cwd)}?`)) wsSend({ type: 'stop', sid: activeSid });
};

// type a command into the active session's prompt and press enter
let sendBusy = false;
function sendCommand(cmd) {
  const t = activeSid && terms.get(activeSid);
  if (!t || t.info?.status === 'exited') { toast('No running session in the active tab — press Start first', true); return; }
  if (sendBusy) { toast('One command at a time — wait a beat', true); return; }
  sendBusy = true;
  // Ctrl+U clears anything already typed so commands never concatenate
  wsSend({ type: 'input', sid: activeSid, data: '\x15' + cmd });
  setTimeout(() => {
    wsSend({ type: 'input', sid: activeSid, data: '\r' });
    sendBusy = false;
  }, 450);
  t.term.focus();
}

// ---------------------------------------------------------------------------
// divider drag
// ---------------------------------------------------------------------------
$('#divider').addEventListener('pointerdown', e => {
  e.preventDefault();
  const dash = $('#dash');
  const startX = e.clientX, startW = dash.offsetWidth;
  const move = ev => { dash.style.width = Math.max(320, startW + (ev.clientX - startX)) + 'px'; };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    sendResize();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
});

// keyboard resize on the divider (it's focusable, role=separator)
$('#divider').addEventListener('keydown', e => {
  const dash = $('#dash');
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    const delta = e.key === 'ArrowRight' ? 24 : -24;
    dash.style.width = Math.max(320, dash.offsetWidth + delta) + 'px';
    sendResize();
  }
});

// ---------------------------------------------------------------------------
// events websocket → live refresh
// ---------------------------------------------------------------------------
function connectEvents() {
  const ws = new WebSocket(wsUrl('/ws/events'));
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'state') refreshState();
  };
  ws.onclose = () => setTimeout(connectEvents, 2000);
}
connectEvents();

// ---------------------------------------------------------------------------
// state + dashboard rendering
// ---------------------------------------------------------------------------
let state = null;
let refreshQueued = false;

async function refreshState() {
  // don't clobber a form the user is typing in; retry shortly after
  if (document.activeElement && $('#dash').contains(document.activeElement)) {
    if (!refreshQueued) {
      refreshQueued = true;
      setTimeout(() => { refreshQueued = false; refreshState(); }, 2500);
    }
    return;
  }
  try {
    state = await api('GET', '/api/state');
  } catch (e) {
    if (REMOTE && !state) { showConnectHelp(e.message); return; }
    toast('Failed to load state: ' + e.message, true);
    return;
  }
  renderTopbar();
  renderDash();
  renderChats();
  if (activeTab === 'git') renderGit();
}

// ---------------------------------------------------------------------------
// tabs
// ---------------------------------------------------------------------------
let activeTab = new URLSearchParams(location.search).get('tab') || localStorage.getItem('activeTab') || 'config';
if (!['config', 'chats', 'git'].includes(activeTab)) activeTab = 'config';
function switchTab(tab) {
  activeTab = tab;
  localStorage.setItem('activeTab', tab);
  const url = new URL(location);
  url.searchParams.set('tab', tab);
  history.replaceState(null, '', url); // deep-linkable tabs
  for (const b of document.querySelectorAll('#tabs button')) {
    const active = b.dataset.tab === tab;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', String(active));
  }
  for (const t of ['config', 'chats', 'git']) {
    $('#tab-' + t).hidden = t !== tab;
  }
  if (tab === 'git') renderGit();
}
for (const b of document.querySelectorAll('#tabs button')) {
  b.addEventListener('click', () => switchTab(b.dataset.tab));
}
switchTab(activeTab);

function renderTopbar() {
  $('#version').textContent = state.claudeVersion || '';
  $('#acct').textContent = state.account ? `${state.account.email} · ${state.account.organization ?? ''}` : '';
  if (document.activeElement !== $('#cwd-input')) $('#cwd-input').value = state.cwd;
  renderProfiles();
  renderUpdateBanner();
  renderRestoreBanner();
}

// profile picker: hidden entirely for single-profile setups (the common case),
// so nothing changes for people who don't run multiple Claude accounts
function renderProfiles() {
  const box = $('#profile-box'), sel = $('#profile-select');
  const profs = state.profiles || [];
  box.hidden = profs.length < 2;
  if (box.hidden || document.activeElement === sel) return; // don't fight an open dropdown
  setChildren(sel, ...profs.map(p =>
    el('option', { value: p.id }, p.isDefault && p.label !== 'default' ? `${p.label} · default` : p.label)));
  sel.value = state.activeProfileId;
}

$('#profile-select').addEventListener('change', async e => {
  try {
    await api('POST', '/api/profile', { id: e.target.value });
    toast(`Dashboard now showing "${e.target.selectedOptions[0]?.textContent || e.target.value}" — new sessions use it too`);
    refreshState();
  } catch (err) { toast(err.message, true); }
});

// "new version pushed to the repo" banner — appears under the topbar
function renderUpdateBanner() {
  let banner = $('#update-banner');
  const u = state.update;
  if (!u?.available) { banner?.remove(); return; }
  if (!banner) {
    banner = el('div', { id: 'update-banner', role: 'status' });
    $('#topbar').after(banner);
  }
  setChildren(banner,
    el('span', {}, `⬆ Deck update available: ${u.local} → ${u.remote} (${u.behind} commit${u.behind === 1 ? '' : 's'} behind)`),
    el('button', {
      class: 'tiny primary', onclick: e => busy(e.currentTarget, () => applyDeckUpdate(false)),
    }, 'Update & restart server'),
    el('span', { class: 'hint' }, 'live sessions are killed but stay resumable from Conversations'),
  );
}

async function applyDeckUpdate(force) {
  try {
    const r = await api('POST', '/api/update', { force });
    if (r.restarting) toast('Updating — the server restarts itself; this page reconnects automatically');
  } catch (e) {
    if (/session\(s\) running/.test(e.message) && confirm(e.message + '\n\nApply anyway?')) {
      return applyDeckUpdate(true);
    }
    toast(e.message, true);
  }
}

// ---------------------------------------------------------------------------
// restore banner — offers to reopen sessions that were live before a restart
// ---------------------------------------------------------------------------
function renderRestoreBanner() {
  let banner = $('#restore-banner');
  const list = state.pendingRestore || [];
  if (!list.length) { banner?.remove(); return; }
  if (!banner) {
    banner = el('div', { id: 'restore-banner', role: 'status' });
    $('#topbar').after(banner);
  }
  const n = list.length;
  setChildren(banner,
    el('span', {}, `↻ ${n} session${n === 1 ? '' : 's'} were open before the last restart: ${list.map(s => shortDir(s.cwd)).join(', ')}`),
    el('button', { class: 'tiny primary', onclick: e => busy(e.currentTarget, restoreSessions) }, 'Restore all'),
    el('button', { class: 'tiny', onclick: e => busy(e.currentTarget, dismissRestore) }, 'Dismiss'),
    el('span', { class: 'hint' }, 'reopens each folder with --continue'),
  );
}

async function restoreSessions() {
  try {
    const r = await api('POST', '/api/sessions/restore');
    toast(`Restoring ${r.started} session${r.started === 1 ? '' : 's'}…`);
    refreshState();
  } catch (e) { toast(e.message, true); }
}

async function dismissRestore() {
  try { await api('POST', '/api/sessions/restore/dismiss'); refreshState(); }
  catch (e) { toast(e.message, true); }
}

// ---------------------------------------------------------------------------
// folder picker — the cwd field opens a real directory browser
// ---------------------------------------------------------------------------
let dirCurrent = null;
// 'cwd' just moves the dashboard's working dir; 'new-session' also starts a
// Claude session in the chosen folder (what the + New tab button uses)
let dirPickerMode = 'cwd';
let dirPickerArgs = [];

async function browseTo(p) {
  let r;
  try { r = await api('GET', '/api/browse?path=' + encodeURIComponent(p)); }
  catch (e) { toast(e.message, true); return; }
  dirCurrent = r.path;
  $('#dir-path').value = r.path;
  $('#dir-current').textContent = 'selected: ' + r.path.replace(state?.home || '', '~');
  const showHidden = $('#dir-hidden').checked;
  const dirs = r.dirs.filter(d => showHidden || !d.hidden);
  setChildren($('#dir-list'),
    r.parent ? el('div', { class: 'dir-item', ...press(() => browseTo(r.parent), 'Go up one folder') },
      el('span', { class: 'dir-icon' }, '⬆️'), '..') : null,
    dirs.map(d => el('div', { class: 'dir-item' + (d.hidden ? ' dim' : ''), ...press(() => browseTo(d.path), 'Open ' + d.name) },
      el('span', { class: 'dir-icon' }, '📁'), d.name)),
    !dirs.length && !r.parent ? el('div', { class: 'empty' }, 'No subfolders') : null,
    dirs.length ? null : el('div', { class: 'empty' }, 'No subfolders here — "Use this folder" to select it'),
  );
}

function openDirPicker(mode = 'cwd', startArgs = []) {
  dirPickerMode = mode;
  dirPickerArgs = startArgs;
  $('#dir-select').textContent = mode !== 'new-session' ? 'Use this folder'
    : startArgs.includes('--continue') ? '⏩ Use folder & continue' : '▶ Use folder & start';
  // On a multi-profile machine, let the new session pick its own account here,
  // independent of the dashboard's active profile. Hidden for plain cwd moves
  // and single-profile setups (the common case).
  const profSel = $('#dir-profile-select'), profs = state.profiles || [];
  const showProf = mode === 'new-session' && profs.length > 1;
  $('#dir-profile-row').hidden = !showProf;
  if (showProf) {
    setChildren(profSel, ...profs.map(p =>
      el('option', { value: p.id }, p.isDefault && p.label !== 'default' ? `${p.label} · default` : p.label)));
    profSel.value = state.activeProfileId;
  }
  $('#dir-modal').showModal();
  browseTo(state.cwd);
}

$('#cwd-input').addEventListener('click', openDirPicker);
$('#cwd-input').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDirPicker(); } });
$('#dir-close').onclick = () => $('#dir-modal').close();
$('#dir-modal').addEventListener('click', e => { if (e.target === e.currentTarget) $('#dir-modal').close(); });
$('#dir-go').onclick = () => browseTo($('#dir-path').value.trim());
$('#dir-path').addEventListener('keydown', e => { if (e.key === 'Enter') browseTo($('#dir-path').value.trim()); });
$('#dir-hidden').onchange = () => dirCurrent && browseTo(dirCurrent);
$('#dir-select').onclick = e => busy(e.currentTarget, async () => {
  const chosen = dirCurrent;
  const profileId = $('#dir-profile-row').hidden ? null : $('#dir-profile-select').value;
  try {
    await api('POST', '/api/cwd', { cwd: chosen });
    if (dirPickerMode === 'new-session') {
      // pass the folder (and profile) explicitly so the session starts there
      // regardless of when the cwd change propagates back through state
      startClaude(dirPickerArgs, chosen, profileId);
      const prof = profileId && profileId !== state.activeProfileId
        && (state.profiles || []).find(p => p.id === profileId);
      toast((dirPickerArgs.includes('--continue') ? 'Continuing in ' : 'New session in ')
        + chosen + (prof ? ` · ${prof.label}` : ''));
    } else {
      toast('Working directory: ' + chosen);
    }
    $('#dir-modal').close();
    refreshState();
  } catch (err) { toast(err.message, true); }
});

// --- card infrastructure (open/closed persisted) ---
const openCards = new Set(JSON.parse(localStorage.getItem('openCards') || '["quick","core","permissions","mcp"]'));
function card(id, title, count, ...body) {
  const open = openCards.has(id);
  const toggle = () => {
    const nowOpen = c.classList.toggle('open');
    nowOpen ? openCards.add(id) : openCards.delete(id);
    c.firstChild.setAttribute('aria-expanded', String(nowOpen));
    localStorage.setItem('openCards', JSON.stringify([...openCards]));
  };
  const c = el('div', { class: 'card' + (open ? ' open' : '') },
    el('div', { class: 'card-head', 'aria-expanded': String(open), ...press(toggle) },
      title, count != null ? el('span', { class: 'count' }, String(count)) : null, el('span', { class: 'chev', 'aria-hidden': 'true' }, '▶')),
    el('div', { class: 'card-body' }, ...body),
  );
  return c;
}

const badge = scope => el('span', { class: 'badge ' + scope }, scope);

// merged view over settings scopes (managed wins, then local > project > user)
function scopesOf(key) {
  const out = [];
  for (const scope of ['managed', 'local', 'project', 'user']) {
    const j = state.settings[scope]?.json;
    if (j && j[key] !== undefined) out.push([scope, j[key]]);
  }
  return out;
}
function effective(keyPath) {
  const keys = keyPath.split('.');
  for (const scope of ['managed', 'local', 'project', 'user']) {
    let v = state.settings[scope]?.json;
    for (const k of keys) v = v?.[k];
    if (v !== undefined) return [scope, v];
  }
  return [null, undefined];
}

function renderDash() {
  setChildren($('#tab-config'),
    cardQuick(),
    cardCore(),
    cardPermissions(),
    cardMcp(),
    cardHooks(),
    cardEnv(),
    cardCatalog('agents', '🤖 Agents'),
    cardCatalog('commands', '⚡ Slash commands'),
    cardCatalog('skills', '🎯 Skills'),
    cardMemory(),
    cardProject(),
    cardServer(),
    cardRaw(),
  );
}

// --- the Deck itself: where it runs, restart/stop/uninstall ---
function cardServer() {
  const srv = state.server || {};
  const kv = (k, v) => el('div', { class: 'kv' }, el('span', { class: 'k' }, k + ' '), String(v ?? '—'));
  const act = (path, body, okMsg) => e => busy(e.currentTarget, async () => {
    try { const r = await api('POST', path, body); toast(r.note || okMsg); }
    catch (err) { toast(err.message, true); }
  });
  return card('server', '🖥️ App (this Deck)', null,
    el('div', { class: 'row' },
      el('span', { class: 'badge ' + (srv.installed ? 'allow' : 'ask') },
        srv.installed ? 'installed service' : 'dev checkout'),
      state.update?.available ? el('span', { class: 'badge deny' }, `update: ${state.update.behind} behind`) : null,
    ),
    kv('app dir', srv.appDir),
    kv('server', `pid ${srv.pid} · port ${srv.port} · node ${srv.node}`),
    el('div', { class: 'row', style: 'margin-top:10px' },
      el('button', {
        class: 'tiny', title: 'Sessions end but stay resumable from the Conversations tab',
        onclick: e => { if (confirm('Restart the Deck server? Running Claude sessions end (they stay resumable).')) act('/api/server/restart', {}, 'Restarting…')(e); },
      }, '↻ Restart server'),
      el('button', {
        class: 'tiny', title: 'Stops the server; start it again from the tray icon or `systemctl --user start claude-deck`',
        onclick: e => { if (confirm('Stop the Deck server? This page will go dead until you start it again (tray icon or systemctl).')) act('/api/server/stop', {}, 'Stopping…')(e); },
      }, '■ Stop server'),
      srv.platform === 'linux' ? el('button', {
        class: 'tiny', title: 'Kills duplicate tray icons and starts exactly one',
        onclick: act('/api/server/fix-tray', {}, 'Tray fixed'),
      }, '🧹 Fix tray icons') : null,
      el('button', {
        class: 'tiny danger', title: 'Removes the service, tray, URL handler, and the installed app. Your Claude config and conversations are untouched.',
        onclick: e => {
          const typed = prompt('This removes the Claude Deck service, tray icon, and installed app.\nYour Claude config and conversations are NOT touched.\n\nType UNINSTALL to confirm:');
          if (typed === null) return;
          if (typed !== 'UNINSTALL') { toast('Not uninstalled — confirmation text did not match', true); return; }
          act('/api/server/uninstall', { confirm: 'UNINSTALL' }, 'Uninstalling…')(e);
        },
      }, '🗑 Uninstall…'),
    ),
    el('div', { class: 'hint' }, 'Uninstalling removes the Deck itself only — ~/.claude, your settings, and every conversation stay on disk.'),
  );
}

// --- commands: extracted live from your installed claude binary ---
function cardQuick() {
  const builtins = state.builtinCommands || [];
  const custom = (state.commands || []).map(c => ({ name: c.name, description: c.description || 'custom command', source: c.scope }));
  const skills = (state.skills || []).map(c => ({ name: c.name, description: c.description || 'skill', source: 'skill' }));

  const filter = el('input', {
    type: 'search', placeholder: '🔍 filter commands…', 'aria-label': 'Filter commands',
    oninput: () => applyFilter(filter.value.trim().toLowerCase()),
  });

  const row = (name, desc, source) => el('div', {
    class: 'cmd-row', 'data-cmd': (name + ' ' + desc).toLowerCase(),
    ...press(() => sendCommand('/' + name), `Run /${name}`),
  },
    el('code', { class: 'cmd-name' }, '/' + name),
    el('span', { class: 'cmd-desc' }, desc),
    source ? el('span', { class: 'badge ' + (source === 'skill' ? 'local' : source) }, source) : null,
  );

  const sections = [
    ['Built-in · from your claude ' + (state.claudeVersion || '').split(' ')[0], builtins.map(c => row(c.name, c.description))],
    custom.length ? ['Your commands', custom.map(c => row(c.name, c.description, c.source))] : null,
    skills.length ? ['Your skills', skills.map(c => row(c.name, c.description, 'skill'))] : null,
  ].filter(Boolean);

  const noResults = el('div', { class: 'empty', style: 'display:none' },
    'No matching commands — try a shorter word, or run it directly in the terminal');

  const keys = el('div', { class: 'chips' },
    el('button', { class: 'chip', title: 'Send Escape key', onclick: () => termWs.send(JSON.stringify({ type: 'input', data: '\x1b' })) }, 'Esc'),
    el('button', { class: 'chip', title: 'Send Ctrl+C', onclick: () => termWs.send(JSON.stringify({ type: 'input', data: '\x03' })) }, 'Ctrl+C'),
    el('button', { class: 'chip', title: 'Cycle permission modes', onclick: () => termWs.send(JSON.stringify({ type: 'input', data: '\x1b[Z' })) }, 'Shift+Tab'),
  );

  const wrap = card('quick', '⚡ Commands', builtins.length + custom.length + skills.length,
    el('div', { class: 'hint' }, 'Everything your Claude can do, extracted from the binary itself — click to run it in the live session'),
    builtins.length ? null : el('div', { class: 'empty' }, 'Command list not extracted yet — the server scans the claude binary shortly after startup; this fills in automatically'),
    el('div', { class: 'row' }, filter),
    sections.map(([g, rows]) => [el('div', { class: 'subhead', 'data-group': '' }, g), el('div', { class: 'cmd-list' }, rows)]),
    noResults, el('div', { class: 'subhead' }, 'Keys'), keys,
  );

  function applyFilter(q) {
    let shown = 0;
    for (const r of wrap.querySelectorAll('.cmd-row')) {
      const vis = !q || r.getAttribute('data-cmd').includes(q);
      r.style.display = vis ? '' : 'none';
      if (vis) shown++;
    }
    for (const h of wrap.querySelectorAll('[data-group]')) {
      const list = h.nextElementSibling;
      const any = [...list.children].some(c => c.style.display !== 'none');
      h.style.display = list.style.display = any ? '' : 'none';
    }
    noResults.style.display = shown ? 'none' : '';
  }
  return wrap;
}

// --- core settings ---
const MODELS = ['fable', 'opus', 'sonnet', 'haiku', 'opusplan', 'sonnet[1m]', 'default'];
const PERM_MODES = ['default', 'auto', 'acceptEdits', 'plan', 'bypassPermissions'];
const THEMES = ['dark', 'light', 'dark-daltonized', 'light-daltonized', 'dark-ansi', 'light-ansi'];

function settingRow(label, keyPath, options, { allowCustom = false, isBool = false } = {}) {
  const [scope, value] = effective(keyPath);
  const scopeSel = el('select', { title: 'Which settings file to write to' },
    ['user', 'project', 'local'].map(s =>
      el('option', { value: s, ...(s === (scope === 'managed' || !scope ? 'user' : scope) ? { selected: '' } : {}) }, s)),
  );
  let valueCtl;
  const save = v => mutate(api('POST', '/api/setting', { scope: scopeSel.value, keyPath, value: v }), `${label} → ${v}`);
  if (isBool) {
    valueCtl = el('input', { type: 'checkbox', onchange: e => save(e.target.checked) });
    valueCtl.checked = !!value;
  } else {
    valueCtl = el('select', { onchange: e => {
      if (e.target.value === '__custom__') {
        const v = prompt(`Custom value for ${keyPath}:`, value ?? '');
        if (v) save(v); else refreshState();
      } else save(e.target.value);
    }},
      value !== undefined && !options.includes(value) ? el('option', { value, selected: '' }, `${value} (current)`) : null,
      options.map(o => el('option', { value: o, ...(o === value ? { selected: '' } : {}) }, o)),
      value === undefined ? el('option', { value: '', selected: '', disabled: '' }, '(not set)') : null,
      allowCustom ? el('option', { value: '__custom__' }, 'custom…') : null,
    );
  }
  return el('div', { class: 'row' },
    el('label', {}, label),
    valueCtl,
    scope ? badge(scope) : el('span', { class: 'badge' }, 'unset'),
    scopeSel,
  );
}

function cardCore() {
  return card('core', '🎚️ Core settings', null,
    settingRow('Model', 'model', MODELS, { allowCustom: true }),
    settingRow('Permission mode', 'permissions.defaultMode', PERM_MODES),
    settingRow('Theme', 'theme', THEMES),
    settingRow('Voice', 'voiceEnabled', [], { isBool: true }),
    settingRow('Co-authored-by', 'includeCoAuthoredBy', [], { isBool: true }),
    settingRow('Verbose', 'verbose', [], { isBool: true }),
    settingRow('Auto-compact', 'autoCompactEnabled', [], { isBool: true }),
    settingRow('Todos', 'todoFeatureEnabled', [], { isBool: true }),
    el('div', { class: 'hint' }, 'The badge shows which settings file currently wins. Pick a scope on the right, then change the value to write it there.'),
  );
}

// --- permissions ---
function cardPermissions() {
  const rows = [];
  for (const scope of ['managed', 'user', 'project', 'local']) {
    const perms = state.settings[scope]?.json?.permissions;
    if (!perms) continue;
    for (const list of ['allow', 'ask', 'deny']) {
      for (const rule of perms[list] || []) {
        rows.push(el('div', { class: 'list-item' },
          el('span', { class: 'badge ' + list }, list),
          el('span', { class: 'grow' }, rule),
          badge(scope),
          scope !== 'managed' ? el('button', {
            class: 'del', title: 'Remove rule', 'aria-label': `Remove ${list} rule ${rule}`,
            onclick: () => {
              if (!confirm(`Remove ${list} rule "${rule}" from ${scope} settings?`)) return;
              mutate(api('POST', '/api/permission-rule', { scope, list, action: 'remove', rule }), 'Rule removed');
            },
          }, '✕') : null,
        ));
      }
    }
  }
  const [modeScope, mode] = effective('permissions.defaultMode');
  const ruleInput = el('input', { type: 'text', placeholder: 'e.g. Bash(npm run *) or WebFetch(domain:github.com)' });
  const listSel = el('select', {}, ['allow', 'ask', 'deny'].map(l => el('option', { value: l }, l)));
  const scopeSel = el('select', {}, ['user', 'project', 'local'].map(s => el('option', { value: s, ...(s === 'project' ? { selected: '' } : {}) }, s)));
  const addDirs = scopesOf('permissions').flatMap(([scope, p]) =>
    (p.additionalDirectories || []).map(d => el('div', { class: 'list-item' }, el('span', { class: 'grow' }, d), badge(scope))));

  return card('permissions', '🔐 Permissions', rows.length,
    el('div', { class: 'row' }, el('label', {}, 'Default mode'), el('span', { class: 'kv' }, String(mode ?? 'default')), modeScope ? badge(modeScope) : null),
    rows.length ? rows : el('div', { class: 'empty' }, 'No permission rules in any settings file'),
    el('div', { class: 'subhead' }, 'Add rule'),
    el('div', { class: 'row' }, listSel, ruleInput),
    el('div', { class: 'row' },
      el('label', {}, 'save to'), scopeSel,
      el('button', { class: 'tiny primary', onclick: e => {
        if (!ruleInput.value.trim()) return toast('Enter a rule first', true);
        busy(e.currentTarget, () => mutate(api('POST', '/api/permission-rule', { scope: scopeSel.value, list: listSel.value, action: 'add', rule: ruleInput.value.trim() }), 'Rule added'));
      }}, 'Add'),
    ),
    addDirs.length ? [el('div', { class: 'subhead' }, 'Additional directories'), ...addDirs] : null,
  );
}

// --- MCP ---
function cardMcp() {
  const items = [];
  const scopeLabel = { user: 'user', project: 'project', local: 'local' };
  for (const scope of ['user', 'project', 'local']) {
    for (const [name, cfg] of Object.entries(state.mcp[scope] || {})) {
      const desc = cfg.url || [cfg.command, ...(cfg.args || [])].filter(Boolean).join(' ');
      items.push(el('div', { class: 'list-item' },
        el('span', { class: 'grow' }, el('div', {}, name), el('div', { class: 'sub' }, `${cfg.type || 'stdio'} · ${desc}`)),
        badge(scopeLabel[scope]),
        el('button', {
          class: 'del', title: 'Remove server (claude mcp remove)', 'aria-label': `Remove MCP server ${name}`,
          onclick: e => {
            if (!confirm(`Remove MCP server "${name}" (${scope})?`)) return;
            busy(e.currentTarget, () => mutate(api('POST', '/api/mcp', { action: 'remove', name, scope }), 'MCP server removed'));
          },
        }, '✕'),
      ));
    }
  }
  const nameIn = el('input', { type: 'text', placeholder: 'name' });
  const cmdIn = el('input', { type: 'text', placeholder: 'command or URL' });
  const typeSel = el('select', {}, ['stdio', 'http', 'sse'].map(t => el('option', { value: t }, t)));
  const scopeSel = el('select', {}, ['local', 'project', 'user'].map(s => el('option', { value: s }, s)));

  return card('mcp', '🔌 MCP servers', items.length,
    items.length ? items : el('div', { class: 'empty' }, 'No MCP servers configured'),
    el('div', { class: 'subhead' }, 'Add server'),
    el('div', { class: 'row' }, nameIn, typeSel, scopeSel),
    el('div', { class: 'row' }, cmdIn,
      el('button', { class: 'tiny primary', onclick: e => {
        const [command, ...args] = cmdIn.value.trim().split(/\s+/);
        if (!nameIn.value.trim() || !command) return toast('Name and command/URL required', true);
        busy(e.currentTarget, () => mutate(api('POST', '/api/mcp', {
          action: 'add', name: nameIn.value.trim(), scope: scopeSel.value,
          transport: typeSel.value, commandOrUrl: command, args,
        }), 'MCP server added'));
      }}, 'Add'),
    ),
    state.projectEntry ? el('div', { class: 'hint' },
      `Project .mcp.json approvals — enabled: ${state.projectEntry.enabledMcpjsonServers.length}, disabled: ${state.projectEntry.disabledMcpjsonServers.length}`) : null,
  );
}

// --- hooks ---
function cardHooks() {
  const rows = [];
  for (const scope of ['managed', 'user', 'project', 'local']) {
    const hooks = state.settings[scope]?.json?.hooks;
    if (!hooks) continue;
    for (const [event, matchers] of Object.entries(hooks)) {
      for (const m of matchers || []) {
        for (const h of m.hooks || []) {
          rows.push(el('div', { class: 'list-item' },
            el('span', { class: 'grow' },
              el('div', {}, `${event}${m.matcher ? ` · ${m.matcher}` : ''}`),
              el('div', { class: 'sub' }, h.command || h.type)),
            badge(scope),
          ));
        }
      }
    }
  }
  return card('hooks', '🪝 Hooks', rows.length,
    rows.length ? rows : el('div', { class: 'empty' }, 'No hooks configured'),
    el('div', { class: 'hint' }, 'Edit hooks via Raw files below, or ask Claude to run /update-config'),
  );
}

// --- env vars ---
function cardEnv() {
  const rows = [];
  for (const [scope, env] of scopesOf('env')) {
    for (const [k, v] of Object.entries(env)) {
      rows.push(el('div', { class: 'list-item' },
        el('span', { class: 'grow' }, el('span', { class: 'kv' }, el('span', { class: 'k' }, k), ' = ', String(v))),
        badge(scope),
        el('button', {
          class: 'del', title: 'Remove env var', 'aria-label': `Remove env var ${k}`,
          onclick: () => {
            if (!confirm(`Remove env var ${k} from ${scope} settings?`)) return;
            mutate(api('POST', '/api/env-var', { scope, key: k, action: 'remove' }), 'Env var removed');
          },
        }, '✕'),
      ));
    }
  }
  const kIn = el('input', { type: 'text', placeholder: 'NAME' });
  const vIn = el('input', { type: 'text', placeholder: 'value' });
  const scopeSel = el('select', {}, ['user', 'project', 'local'].map(s => el('option', { value: s }, s)));
  return card('env', '🌱 Env vars (settings.env)', rows.length,
    rows.length ? rows : el('div', { class: 'empty' }, 'No env vars set in settings files'),
    el('div', { class: 'row' }, kIn, vIn, scopeSel,
      el('button', { class: 'tiny primary', onclick: e => {
        if (!kIn.value.trim()) return toast('Name required', true);
        busy(e.currentTarget, () => mutate(api('POST', '/api/env-var', { scope: scopeSel.value, key: kIn.value.trim(), value: vIn.value }), 'Env var set'));
      }}, 'Set'),
    ),
  );
}

// --- agents / commands / skills ---
function cardCatalog(kind, title) {
  const items = state[kind] || [];
  return card(kind, title, items.length,
    items.length ? items.map(it => el('div', {
      class: 'list-item clickable', title: it.file,
      ...press(() => openFileModal(it.file), `Edit ${it.name}`),
    },
      el('span', { class: 'grow' }, el('div', {}, it.name), it.description ? el('div', { class: 'sub' }, it.description) : null),
      badge(it.scope),
    )) : el('div', { class: 'empty' }, `No ${kind} found in ~/.claude/${kind} or .claude/${kind}`),
  );
}

// --- memory (CLAUDE.md) ---
function cardMemory() {
  const rows = ['user', 'project', 'local'].map(scope => {
    const m = state.memory[scope];
    return el('div', { class: 'list-item clickable', ...press(() => openFileModal(m.path, !m.exists), `Edit ${m.path}`) },
      el('span', { class: 'grow' },
        el('div', {}, m.path.replace(state.home, '~')),
        el('div', { class: 'sub' }, m.exists ? `${m.raw.length} chars — click to edit` : 'not created — click to create')),
      badge(scope),
    );
  });
  const kb = state.keybindings;
  rows.push(el('div', { class: 'list-item clickable', ...press(() => openFileModal(kb.path, !kb.exists), 'Edit keybindings') },
    el('span', { class: 'grow' }, el('div', {}, '~/.claude/keybindings.json'), el('div', { class: 'sub' }, kb.exists ? `${(kb.json?.bindings || []).length} binding group(s)` : 'not created')),
    badge('user'),
  ));
  return card('memory', '📝 Memory & keybindings', null, rows);
}

// ---------------------------------------------------------------------------
// Conversations tab — across all your projects
// ---------------------------------------------------------------------------
let openTranscriptId = null;
let chatScope = localStorage.getItem('chatScope') || 'all';

const projName = p => p === state.home ? '~' : p.split('/').pop();

function resumeSession(s) {
  // opens in a NEW tab in that project; running sessions are untouched
  startClaude(['--resume', s.id], s.project || state.cwd);
}

function renderChats() {
  const pane = $('#tab-chats');
  if (openTranscriptId) return; // don't clobber an open transcript on refresh
  const all = chatScope === 'all';
  const sessions = (all ? state?.allSessions || state?.sessions : state?.sessions) || [];

  const scopeBtn = (key, label) => el('button', {
    class: 'seg' + (chatScope === key ? ' active' : ''),
    'aria-pressed': String(chatScope === key),
    onclick: () => { chatScope = key; localStorage.setItem('chatScope', key); renderChats(); },
  }, label);

  // one group per project, projects ordered by most recent activity
  const ordered = all
    ? [...sessions].sort((a, b) => {
        const pa = a.project || state.cwd, pb = b.project || state.cwd;
        if (pa === pb) return b.mtime - a.mtime;
        const newest = p => Math.max(...sessions.filter(s => (s.project || state.cwd) === p).map(s => s.mtime));
        return newest(pb) - newest(pa);
      })
    : sessions;

  const rows = [];
  let lastProj = null;
  for (const s of ordered) {
    const proj = s.project || state.cwd;
    if (all && proj !== lastProj) {
      lastProj = proj;
      rows.push(el('div', { class: 'subhead proj-head' },
        `📁 ${projName(proj)}`,
        el('span', { class: 'proj-path' }, ' ' + proj.replace(state.home, '~')),
        proj === state.cwd ? el('span', { class: 'badge project' }, 'current') : null,
      ));
    }
    rows.push(el('div', {
      class: 'list-item clickable',
      ...press(() => openTranscript(s), `Read conversation: ${s.summary || s.id}`),
    },
      el('span', { class: 'grow' },
        el('div', {}, s.summary || s.id.slice(0, 8)),
        el('div', { class: 'sub', title: new Date(s.mtime).toLocaleString() },
          `${relTime(s.mtime)} · ${(s.size / 1024).toFixed(0)} KB · ${s.id.slice(0, 8)}`)),
      el('button', {
        class: 'tiny', title: (s.project && s.project !== state.cwd ? `Switches cwd to ${projName(s.project)}, then ` : '') + 'claude --resume ' + s.id,
        onclick: ev => { ev.stopPropagation(); resumeSession(s); },
      }, 'Resume'),
    ));
  }

  setChildren(pane,
    el('div', { class: 'seg-row' }, scopeBtn('all', '🌍 All projects'), scopeBtn('this', '📁 This project')),
    el('div', { class: 'hint' }, all
      ? 'Every conversation Claude knows about, newest first — Resume jumps projects for you'
      : `Conversations in ${state.cwd.replace(state.home, '~')}`),
    rows.length ? rows : el('div', { class: 'empty' }, 'No sessions found — start one with ▶ Start'),
  );
}

async function openTranscript(s) {
  const pane = $('#tab-chats');
  openTranscriptId = s.id;
  pane.replaceChildren(el('div', { class: 'empty' }, 'Loading transcript…'));
  let messages;
  try {
    const q = '/api/session?id=' + encodeURIComponent(s.id) + (s.project ? '&project=' + encodeURIComponent(s.project) : '');
    ({ messages } = await api('GET', q));
  } catch (e) {
    toast(e.message, true);
    openTranscriptId = null;
    renderChats();
    return;
  }
  setChildren(pane,
    el('div', { class: 'back-row' },
      el('button', { class: 'tiny', onclick: () => { openTranscriptId = null; renderChats(); } }, '← Back'),
      el('span', { class: 'grow sub' }, (s.project ? projName(s.project) + ' · ' : '') + (s.summary || s.id.slice(0, 8))),
      el('button', { class: 'tiny primary', onclick: () => resumeSession(s) }, 'Resume'),
    ),
    messages.length ? messages.map(m => el('div', { class: 'msg ' + m.role },
      el('div', { class: 'who' }, m.role === 'user' ? 'You' : 'Claude'),
      m.text + (m.text.length >= 4000 ? ' …' : ''),
      m.tools?.length ? el('div', { class: 'tools' }, '🔧 ' + m.tools.join(', ')) : null,
    )) : el('div', { class: 'empty' }, 'No readable messages in this session'),
  );
}

// ---------------------------------------------------------------------------
// Git tab
// ---------------------------------------------------------------------------
const GIT_STATUS_LABEL = { M: ['mod', 'yellow'], A: ['new', 'green'], D: ['del', 'red'], R: ['ren', 'blue'], C: ['cpy', 'blue'], U: ['conflict', 'red'], '?': ['new', 'green'] };

function statusChip(code) {
  const c = code.trim()[0] || 'M';
  const [label, color] = GIT_STATUS_LABEL[c] || ['?', 'muted'];
  return el('span', { class: 'git-chip git-' + color, title: `status: ${code}` }, label);
}

async function renderGit() {
  const pane = $('#tab-git');
  if (!pane.children.length) pane.replaceChildren(el('div', { class: 'empty' }, 'Reading git…'));
  let g;
  try { g = await api('GET', '/api/git'); }
  catch (e) { pane.replaceChildren(el('div', { class: 'empty' }, 'Failed to read git: ' + e.message)); return; }
  if (!g.isRepo) {
    pane.replaceChildren(el('div', { class: 'empty' }, `${state?.cwd || 'cwd'} is not a git repository`));
    return;
  }
  setChildren(pane,
    el('div', { class: 'git-header' },
      el('span', { class: 'git-branch' }, ' ', g.branch || '(no branch)'),
      g.status.length
        ? el('span', { class: 'badge ask' }, `${g.status.length} changed`)
        : el('span', { class: 'badge allow' }, 'clean'),
      el('span', { class: 'spacer' }),
      el('button', { class: 'tiny', onclick: renderGit }, '↻ Refresh'),
    ),
    g.remote ? el('div', { class: 'git-remote', title: g.remote }, g.remote) : null,

    g.status.length ? [
      el('div', { class: 'subhead' }, 'Working tree'),
      el('div', { class: 'git-files' }, g.status.map(f => el('div', { class: 'git-file' },
        statusChip(f.code),
        el('span', { class: 'git-filename', title: f.file }, f.file),
      ))),
    ] : null,

    el('div', { class: 'subhead' }, `History · ${g.log.length} commit${g.log.length === 1 ? '' : 's'}`),
    g.log.length ? el('div', { class: 'git-commits' }, g.log.map(c => el('div', {
      class: 'commit',
      ...press(() => openCommit(c), `Show diff for ${c.hash} ${c.subject}`),
    },
      el('div', { class: 'commit-line' },
        el('code', { class: 'hash' }, c.hash),
        el('span', { class: 'commit-subject' }, c.subject),
      ),
      el('div', { class: 'commit-meta' },
        `${c.author} · ${c.date}`,
        c.refs ? c.refs.split(',').map(r => el('span', { class: 'ref-pill' }, r.trim())) : null,
      ),
    ))) : el('div', { class: 'empty' }, 'No commits yet — ask Claude to make the first one'),
  );
}

async function openCommit(c) {
  try {
    const r = await api('GET', '/api/git/show?hash=' + encodeURIComponent(c.hash));
    openTextModal(`${c.hash} — ${c.subject}`, r.text + (r.truncated ? '\n… [truncated]' : ''));
  } catch (e) { toast(e.message, true); }
}

// --- project info ---
function cardProject() {
  const pe = state.projectEntry;
  return card('project', '📁 Project', null,
    el('div', { class: 'kv' }, el('span', { class: 'k' }, 'cwd '), state.cwd),
    pe ? [
      el('div', { class: 'kv' }, el('span', { class: 'k' }, 'trusted '), String(pe.hasTrustDialogAccepted ?? 'unknown')),
      el('div', { class: 'kv' }, el('span', { class: 'k' }, 'last session '), pe.lastSessionId ? pe.lastSessionId.slice(0, 8) : '—'),
    ] : el('div', { class: 'empty' }, 'Claude has not been run in this directory yet'),
    el('div', { class: 'subhead' }, 'Known projects — click to switch'),
    (state.knownProjects || []).map(p => el('div', {
      class: 'list-item clickable',
      ...press(() => mutate(api('POST', '/api/cwd', { cwd: p }), 'Switched project (Start to launch Claude here)'), `Switch to ${p}`),
    }, el('span', { class: 'grow' }, p.replace(state.home, '~')))),
    el('div', { class: 'kv' }, el('span', { class: 'k' }, 'installMethod '), String(state.meta.installMethod ?? '?'),
      '  ', el('span', { class: 'k' }, 'autoUpdates '), String(state.meta.autoUpdates ?? '?'),
      '  ', el('span', { class: 'k' }, 'startups '), String(state.meta.numStartups ?? '?')),
  );
}

// --- raw files ---
function cardRaw() {
  const files = [
    ...['user', 'project', 'local', 'managed'].map(s => ({ label: `settings (${s})`, ...state.settings[s], scope: s })),
    { label: '.mcp.json (project)', path: state.mcp.projectMcpPath, exists: !!Object.keys(state.mcp.project).length, scope: 'project' },
  ];
  return card('raw', '🗄️ Raw files', null,
    files.map(f => el('div', {
      class: 'list-item' + (f.scope === 'managed' ? '' : ' clickable'),
      ...(f.scope === 'managed' ? {} : press(() => openFileModal(f.path, !f.exists), `Edit ${f.label}`)),
    },
      el('span', { class: 'grow' },
        el('div', {}, f.label),
        el('div', { class: 'sub' }, f.path.replace(state.home, '~') + (f.exists ? '' : ' — not created') + (f.parseError ? ' — ⚠ INVALID JSON' : ''))),
      badge(f.scope),
    )),
    el('div', { class: 'hint' }, 'Every save keeps a .bak of the previous version next to the file.'),
  );
}

// ---------------------------------------------------------------------------
// file modal
// ---------------------------------------------------------------------------
let modalFile = null;

function openTextModal(title, text) {
  modalFile = null;
  $('#modal-title').textContent = title;
  $('#modal-save').style.display = 'none';
  $('#modal-text').value = text;
  $('#modal-text').readOnly = true;
  $('#file-modal').showModal();
}

async function openFileModal(file, isNew = false) {
  modalFile = file;
  $('#modal-save').style.display = '';
  $('#modal-text').readOnly = false;
  $('#modal-title').textContent = file;
  let content = '';
  if (!isNew) {
    try {
      const r = await api('GET', '/api/file?path=' + encodeURIComponent(file));
      content = r.exists ? r.raw : '';
    } catch (e) { toast(e.message, true); return; }
  }
  if (!content && file.endsWith('.json')) content = '{\n}\n';
  $('#modal-text').value = content;
  modalBaseline = content;
  $('#file-modal').showModal();
}
let modalBaseline = '';
const modalDirty = () => !$('#modal-text').readOnly && $('#modal-text').value !== modalBaseline;
const confirmDiscard = () => !modalDirty() || confirm('Discard unsaved changes?');

$('#modal-close').onclick = () => { if (confirmDiscard()) $('#file-modal').close(); };
// Esc key fires 'cancel' on <dialog>; guard unsaved edits there too
$('#file-modal').addEventListener('cancel', e => { if (!confirmDiscard()) e.preventDefault(); });
// click on the backdrop closes (with the same guard)
$('#file-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget && confirmDiscard()) $('#file-modal').close();
});
$('#modal-save').onclick = e => busy(e.currentTarget, async () => {
  try {
    await api('POST', '/api/file', { file: modalFile, content: $('#modal-text').value });
    toast('Saved ' + modalFile);
    $('#file-modal').close();
    refreshState();
  } catch (e2) { toast(e2.message, true); }
});

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
refreshState();
setInterval(refreshState, 15000); // safety net if a watcher misses something
window.addEventListener('resize', sendResize);
