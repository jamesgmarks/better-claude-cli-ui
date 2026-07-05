# CLAUDE.md

Guidance for AI agents working in this repo. Read the README first — it's the user-facing tour. This file covers *how the code is put together* and *how to work in it*.

## What this is

**Claude Deck** (repo `better-claude-cli-ui`, product name "Amir Hates The Claude CLI UI") is a two-pane local web UI wrapping the real `claude` CLI:

- **Left pane** — a live dashboard over your entire Claude setup (settings, permissions, MCP servers, hooks, env vars, agents/commands/skills, memory, conversations, git). Everything visible and clickable.
- **Right pane** — real `claude` processes in xterm terminals, one per **session tab**. Multiple sessions run concurrently, in different projects and under different profiles.

The dashboard follows whichever session tab is active, and file watchers keep it live-synced with `~/.claude` in both directions over a WebSocket.

## Architecture

Small, dependency-light, no build step. Three source files carry the whole app:

| File | ~LOC | Role |
|---|---|---|
| `server.js` | 1150 | **The whole backend.** Express REST + two WebSocket servers + PTY session management + file watching + config read/write + git + self-update. Start here for almost anything. |
| `public/app.js` | 1440 | **The whole frontend.** Vanilla JS, no framework, hand-rolled DOM helpers (`el`, `setChildren`). Renders the dashboard and drives xterm terminals. |
| `public/style.css` | 460 | All styling. Slate-dark IDE palette, JetBrains Mono. |
| `bin/deck.js` | 360 | Cross-platform installer/uninstaller/status (systemd user service on Linux, LaunchAgent on macOS, VBS/startup on Windows) + `claude-deck://` URL handler + self-update. |
| `bin/tray.py` | 110 | Optional GTK/system tray helper. |

**Stack:** Node ESM (`"type": "module"`), Express, `ws`, `node-pty` (optional native dep). xterm + fit addon are **vendored** in `public/vendor/` (not loaded from a CDN). Deps are intentionally minimal — keep it that way.

### Key backend concepts (all in `server.js`)

- **Profiles** (`discoverProfiles`, ~line 64) — a "profile" is one Claude config environment (`CLAUDE_CONFIG_DIR` + its `.claude.json`). The default is plain `claude`'s dir; sibling `~/.claude*` dirs (e.g. `~/.claude-work`) are auto-discovered, and `CLAUDE_UI_PROFILES` can name more. Every session runs under its profile's `CLAUDE_CONFIG_DIR`, so accounts run side by side. `paths()` and `SETTINGS_SCOPES` resolve config-file locations relative to the *active* profile — never hardcode `~/.claude`.
- **Sessions** (`sessions` Map, `startSession`/`killSession`, ~line 553+) — `sid -> { pty, cwd, args, scrollback, status, profile, ... }`. The server owns the PTYs; scrollback is buffered (capped at `SCROLLBACK_MAX`) so reconnecting clients can `replay`.
- **Session restore across restarts** (~line 564) — the server owns the PTYs, so a restart (e.g. from self-update) kills them. A snapshot of the live set is written to `~/.claude-deck-sessions.json` on every change; on next boot those sessions are *offered* back via a one-click banner using `--continue` (`restoreArgs` strips prior continue/resume flags). Never auto-spawned.
- **Two WebSockets** — `/ws/term` (terminal I/O + session lifecycle; `broadcastTerm`) and `/ws/events` (dashboard state-changed pings; `broadcastEvent`). Both go through the same token gate as REST.
- **File watching** (`setupWatchers`, ~line 700) — watches the active profile's config dir, `.claude.json`, and the project's `.claude/`; debounced `broadcastEvent({type:'state'})` drives live dashboard refresh.
- **Activity classification** (`classifyActivity` + `QUESTION_RE`, ~line 626) — scrapes terminal output to tell whether a session is `working` / `ready` / `question`, which powers tab badges and opt-in auto-focus.
- **Self-update** (`checkForUpdates`/`applyUpdate`, ~line 506) — checks `origin/main` periodically; applies only when no sessions are live, otherwise surfaces a banner.

### Config writes are scoped

Settings edits go through `updateSettings(scope, mutate)` with scope `user | project | local`. The raw-file API (`/api/file`) is gated by `isAllowedFile` — an allowlist of settings files, `.mcp.json`, `CLAUDE.md`, keybindings, and the agents/skills/commands dirs. Respect that allowlist; don't broaden file access casually.

## Security model

The server **binds to `127.0.0.1` only**. All `/api/*` and both WebSockets require a token (`.deck-token`, gitignored) — enforced for WS at the HTTP upgrade, since CORS doesn't cover WebSockets. The GitHub Pages frontend can drive a local Deck by passing `?server=...&token=...`. Keep every new endpoint behind the same `authorized()` gate, and never log or commit the token.

## Working in this repo

- **Run locally:** `npm install` then `npm start` → http://127.0.0.1:3456. `PORT=` and `CLAUDE_UI_CWD=` override port and initial cwd.
- **No build, no framework, no test runner, no linter.** Match the existing hand-rolled style: DOM via the `el`/`setChildren` helpers on the frontend; small pure functions on the backend. New deps need a real justification.
- **Verify before calling a change done:** boot the server and smoke-check the affected endpoints (this is exactly what CI does — see below), e.g. `curl -sf http://127.0.0.1:3456/api/state`. For frontend/UI changes, load the page and exercise the affected flow in the browser; hold to a high bar on the UI (pixel-level polish, keyboard operability, focus states — the README's accessibility section is the standard to maintain).
- **Two source files do most of the work.** Prefer editing `server.js` / `app.js` over adding new files.

## CI

`.github/workflows/test.yml` runs on push to `main` across Linux/macOS/Windows: `npm install` (asserts `node-pty` loads), boots `server.js` and hits `/api/state` + `/api/update/check`, then runs a full `deck.js install → status → uninstall` cycle asserting the platform artifacts appear and are fully removed. `.github/workflows/pages.yml` deploys the frontend to GitHub Pages. If you touch the installer, the server boot path, or endpoints, make sure this stays green.

## Repo / workflow

`origin` is `github.com/amirbukhari/better-claude-cli-ui` (upstream). Work on feature branches and open PRs to `main`; don't push directly to `main`. (Per global instructions: never commit or push without explicit approval.)
