# dsh-cli-mode

[中文](README.md) | English

Turn [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) sessions into an **interactive terminal CLI** — chat with agents and write code right from the terminal instead of staring at the web page. Codex-like: **wherever you launch the CLI is your workspace**.

- **Plugin** (Cordis, Host-only): registers `/dsh-cli/*` routes on the harness web port, bridging sessions, event streams, permissions and approvals.
- **Client** (`dsh-cli`, pure Node, zero deps): token-by-token streaming, markdown rendering, vertical menus, session switching, mode/model/permission switching, approve/reject prompts.

## Features

| Capability | Description |
| --- | --- |
| Streaming + markdown rendering | Answers stream token-by-token with live markdown styling (headers/bold/code/tables); reasoning folded by default (`/think` to view) |
| Codex-style workspace | Launch directory = session workspace, bound via `workspaceRegistry` |
| Session management | `/open` `/resume` `/switch` `/attach` `/close`; `/sessions` filtered by workspace |
| Vertical menus | Type `/` to pop a menu (Claude-style: ↑↓ navigate, type to filter, alternate-screen rendering, zero main-screen scroll) |
| Mode / model / permission | `/mode` (agent preset), `/model`, `/permission` (read-only / workspace-write / danger-full-access) |
| Approval bridge | Terminal shows `🔐` when the agent needs approval; answer `y`/`n` (harness mux channel, same as the web UI) |
| Tool folding | Tool calls folded into a one-line summary by default (`/tools on` for details); `✓ 完成` marker when a turn finishes |
| Self-bootstrap install | On first run the CLI auto-installs the plugin into the harness (`session.prompt` + `cordis_define`/`cordis_run`) |
| Bottom status line | Current model + reasoning effort shown dimly above the prompt |

## Install

### Option A: mount as a composition plugin (recommended, auto-loads on restart)

Add a row to the harness `cordis.yml` (or an agent preset):

```yaml
- id: cli-mode
  name: 'dsh-cli-mode'
```

Or install via the `dsh` CLI:

```bash
dsh plugin --profile web add dsh-cli-mode
```

### Option B: client self-bootstrap (no config changes)

If the plugin is not active, `dsh-cli` **auto-installs and enables it** on first connect (needs a `cordis` preset session; creates one if none exists).

## Usage

```bash
npm install -g dsh-cli-mode   # or npx / run bin/dsh-cli.mjs locally
dsh-cli                        # first run asks for the web address, saved to ~/.dsh/cli.config
dsh-cli --resume [id]          # resume a historical session
dsh-cli --attach <id>          # attach to a live session
```

### Commands

```
/help  /sessions  /switch  /attach  /open  /resume  /close
/mode  /model  /permission  /tools  /think  /transcript  /cancel  /clear  /exit
```

Type `/` to open the command menu; end a line with `\` for multi-line input.

### Approval interaction

```
🔐 Approval required (bash)
  escalate sandbox to danger-full-access: target file ... is outside the session workspace...
  y = allow once | n = reject
```

## Configuration

- `~/.dsh/cli.config`: `{ "url": "http://127.0.0.1:3080" }` (web address; `--url` overrides and persists)
- **Base config such as API keys stays on the web page** — the CLI does not manage secrets.

## Architecture

```
┌─ dsh-cli (terminal) ────────────────────────┐
│  bin/dsh-cli.mjs                            │
│   · /dsh-cli/* HTTP calls (sessions/perms)  │
│   · /dsh-cli/stream SSE (conversation)      │
│   · /api/events.mux WebSocket (approvals)   │
│   · /api/respond (approval answers)         │
└──────────────┬──────────────────────────────┘
               │ http://127.0.0.1:3080
┌──────────────▼──────────────────────────────┐
│  harness (web process)                      │
│  lib/index.js — cli-mode plugin (Host)      │
│   · /dsh-cli/* routes (webServer)           │
│   · session/event → SSE stream              │
│   · permissionPresets switching             │
│  apiProxy — session/model/preset RPCs,      │
│             approval pending                │
└─────────────────────────────────────────────┘
```

- **Conversation**: input is injected via `agent.followup()` (same channel as the web UI); output is streamed from `session/event` as SSE.
- **Approvals**: the web answerer owns the `approval/request` waterfall; the client subscribes to the mux stream for `approval/requested` (with rpcId) and answers via `/api/respond`.
- **Bootstrap**: the client embeds `lib/plugin-source.txt` (the raw plugin body) in an install message; a cordis-preset session's agent runs `cordis_define` + `cordis_run`.

## Development

```bash
git clone <gitee repo url>
cd dsh-cli-mode
npm run check         # syntax check
npm test              # smoke tests
```

**Keep `lib/index.js` and `lib/plugin-source.txt` in sync**: self-bootstrap uses `plugin-source.txt` (raw function body text); mounted installs use `lib/index.js`. After changing plugin logic:

```bash
npm run sync-source   # regenerate plugin-source.txt from lib/index.js
```

## Publishing

The project is hosted on Gitee. To publish to npm (the package content is controlled by the `files` field in `package.json`):

```bash
npm version patch     # or minor / major
npm publish           # requires an npm account and the package name
```

CI / auto-publishing can be configured on Gitee (e.g., Gitee Go); this repo does not ship platform-specific workflow files.

## License

MIT
