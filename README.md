# Amir Hates The Claude CLI UI 🎛️

A two-pane web UI for Claude Code: a **live dashboard** on the left, the **real `claude` CLI** in a terminal on the right. Everything about your Claude setup is visible and clickable.

The left pane has three tabs:

- **⚙️ Config** — the full dashboard (below)
- **💬 Conversations** — every past session in the current project, with readable transcripts and one-click Resume
- **🌿 Git** — branch, remote, working-tree status, and commit history with click-to-view diffs

![layout](docs/layout.png)

Design follows the [ui-ux-pro-max](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) *Developer Tool / IDE* profile: slate-dark palette (#0F172A family), green accent, blue focus rings, JetBrains Mono throughout.

## Run it

**Install as a service (Linux)** — one command, no clone needed:

```bash
npx github:amirbukhari/better-claude-cli-ui install
```

This clones the app to `~/.local/share/claude-deck/app`, runs it as a `systemd --user` service (auto-restarts), and registers the `claude-deck://` URL scheme so the [GitHub Pages frontend](https://amirbukhari.github.io/better-claude-cli-ui/) can wake it with one click ("🚀 Open my Deck").

```bash
npx github:amirbukhari/better-claude-cli-ui uninstall   # removes service, URL handler, app dir — nothing else
npx github:amirbukhari/better-claude-cli-ui status
```

**Updates:** the server checks `origin/main` every 6 hours (and on boot). When you push to the repo, installed copies auto-update and restart **only if no Claude sessions are running**; otherwise the UI shows an "Update available" banner with a one-click apply (sessions are killed but stay resumable).

**Or run from a checkout:**

```bash
npm install        # see "old GCC" note below if node-pty fails to build
npm start          # http://127.0.0.1:3456
```

Options:

- `PORT=4000 npm start` — different port (binds to 127.0.0.1 only).
- `CLAUDE_UI_CWD=~/some/project npm start` — which directory Claude runs in (defaults to where you launch the server; changeable in the top bar).

## What's in the dashboard

| Section | Shows | Click actions |
|---|---|---|
| Commands | **All ~44 built-in slash commands** grouped by category, plus your custom commands and skills, with a filter box | Click any to run it in the live session (input is cleared first so commands never concatenate); send Esc / Ctrl+C / Shift+Tab |
| Core settings | Model, permission mode, theme, voice, etc. with a badge showing **which settings file wins** | Change any value; pick which scope (user / project / local) to write to |
| Permissions | Every allow/ask/deny rule across all settings files, default mode, additional directories | Add / remove rules per scope |
| MCP servers | Servers from `~/.claude.json`, project `.mcp.json`, and project-local config | Add / remove via `claude mcp` |
| Hooks | All hooks across scopes | (edit via Raw files) |
| Env vars | `settings.env` per scope | Add / remove |
| Agents / Commands / Skills | Everything in `~/.claude/{agents,commands,skills}` and the project's `.claude/` | Click to view & edit the file |
| Memory | `~/.claude/CLAUDE.md`, project `CLAUDE.md` / `CLAUDE.local.md`, keybindings | Click to edit (creates if missing) |
| Conversations tab | Past sessions with summaries and full readable transcripts | Click to read, one-click `--resume <id>` |
| Git tab | Branch, remote, working-tree status, last 60 commits | Click a commit to view its diff |
| Project | Trust status, known projects | Click a project to switch cwd |
| Raw files | Every settings file, with invalid-JSON warnings | Full-file editor; a `.bak` is kept on every save |

The panel is **live**: file watchers on `~/.claude`, `~/.claude.json`, and the project's `.claude/` push updates over a WebSocket, so changes made from inside Claude (e.g. `/config`, `/permissions`) show up in the dashboard immediately, and vice versa.

**Concurrent sessions:** every Start / Continue / Resume opens a new **session tab** — multiple Claude processes run at once, in different projects, and switching tabs never kills anything. Resume from the Conversations tab opens that conversation in a new tab in its own project. The dashboard (config, git, sessions) follows whichever tab is active. Stop / ✕ kill only that tab's session, always with confirmation, and the conversation stays resumable from disk.

Terminal toolbar: Start / Continue (`--continue`) / Stop, a `--dangerously-skip-permissions` toggle, and a free-form extra-args field.

> Settings file edits apply to **new** Claude sessions — open a new tab to pick them up. Commands like `/model` affect the running session directly.

## Sandboxed sessions 🛡

The new-session dialog has a **sandboxed** toggle: that session's `claude` runs inside a locked-down Linux [devcontainer](https://containers.dev) (adapted from [Anthropic's reference config](https://github.com/anthropics/claude-code/tree/main/.devcontainer)), making `--dangerously-skip-permissions` safe to use — it's offered as a pre-checked checkbox when you enable the toggle (uncheck it to keep permission prompts).

What the jail enforces:

- **Read-only config** — your profile's whole config dir (settings, hooks, `CLAUDE.md`, skills, commands, agents, plugins) is visible to the sandboxed Claude but not writable, so it can't plant anything a future *unsandboxed* session would execute or obey. `.claude.json` (which carries MCP server definitions) is copied in at boot and never synced back, closing the MCP-injection escape route.
- **Sessions still persist to the host** — transcripts (`projects/`), todos, and shell snapshots are read-write, so after the sandbox exits, plain `claude --continue` on your machine resumes the conversation. Credentials are shared read-write so long sessions can refresh OAuth tokens; if a refresh-write ever fails inside the container, the worst case is logging in again — the host copy can't be silently replaced.
- **Egress firewall** — default-deny iptables inside the container; only the Anthropic API, npm, GitHub, and Sentry/Statsig are reachable.
- **The project folder is the only writable host path** besides those session dirs.

Requirements & honest caveats:

- **Needs a running Docker engine** — Docker Desktop ([macOS](https://docs.docker.com/desktop/setup/install/mac-install/) / [Windows](https://docs.docker.com/desktop/setup/install/windows-install/)), OrbStack, Colima, or [Docker Engine on Linux](https://docs.docker.com/engine/install/) all work; the container is Linux on every host, so the firewall behaves identically everywhere. **No Docker ⇒ no sandbox toggle** (it's disabled with the reason and an install pointer); everything else about Deck is unchanged.
- The first boot per project builds the image (a few minutes, logs stream into the tab); later sessions reuse the container and start fast. Containers aren't auto-removed — `docker ps` shows them, `docker rm -f` cleans up.
- If a repo ships its own `.devcontainer/`, Deck asks once per project whether to use it (a repo's config can mount arbitrary host paths, and its image has **no egress firewall** unless the repo provides one — only accept for repos you trust) or Deck's bundled config.
- On Windows hosts the project mounts at `/workspaces/<name>` inside the container, so host-side `claude --continue` can't see sandboxed transcripts for that project (re-opening a *sandboxed* session still resumes fine).

## Accessibility & UX

Audited against ui-ux-pro-max's 99 UX guidelines: full keyboard operability (cards, list rows, deletes, tabs, and the panel divider are all focusable and Enter/Space-operable), ARIA roles/labels/`aria-live` announcements, visible blue focus rings, ≥4.5:1 text contrast, confirmation on destructive actions, disabled-while-pending buttons, empty/loading/no-results states everywhere, `prefers-reduced-motion` support, 44px touch targets on coarse pointers, deep-linkable tabs (`?tab=git`), and non-blocking font loading with `display=swap`.

## Notes

- The server binds to localhost only and whitelists which files the raw file API may touch (settings, `.mcp.json`, `CLAUDE.md`, keybindings, agents/skills/commands dirs).
- **Old GCC (Ubuntu 20.04):** Node ≥20 native addons pass `-std=gnu++20`, which GCC 9 doesn't accept. Build with the included shim:
  ```bash
  CXX=$PWD/tools/g++20-shim npm install
  ```
