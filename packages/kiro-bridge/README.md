# @openchamber/kiro-bridge

A protocol bridge that lets **OpenChamber** drive **Kiro CLI**.

OpenChamber only knows how to talk to an **OpenCode server** (REST + SSE). Kiro CLI
is not OpenCode, but `kiro-cli acp` implements the **Agent Client Protocol (ACP)**.
This bridge presents Kiro *as if it were an OpenCode server*:

```
OpenChamber  ──OpenCode HTTP (REST + SSE)──►  kiro-bridge  ──ACP (JSON-RPC/stdio)──►  kiro-cli acp
```

## Constraint: no auto-approval of tools

The bridge launches Kiro as `kiro-cli acp --agent kiro_default --trust-tools=`. With a
non-pre-trusting agent, Kiro emits a real ACP `session/request_permission` for every
tool call. The bridge turns that into an OpenCode `permission.updated` event, waits for
OpenChamber's answer (`POST /session/:id/permissions/:permissionID`), and only then
replies to Kiro. **Nothing is auto-approved.** `--trust-all-tools` is never used.

> Do not point the bridge at an agent that pre-trusts tools (e.g. `des-agent`), or tool
> calls will run without a prompt. `kiro_default` is the safe default.

## Run

```bash
# 1. start the bridge (defaults: port 4599, cwd = current dir, agent kiro_default)
node packages/kiro-bridge/bin/kiro-bridge.mjs --port 4599 --cwd /path/to/project

# 2. point OpenChamber at it (host must include the port and have NO path)
OPENCODE_HOST=http://127.0.0.1:4599 OPENCODE_SKIP_START=true openchamber
```

Options: `--port`, `--cwd`, `--agent`, `--host`. Override the Kiro binary with
`KIRO_BRIDGE_KIRO_BIN`, or the default agent with `KIRO_BRIDGE_AGENT`.

## What works (M1 + permission core)

- `GET /global/health` → `{ healthy, version }`
- `GET /global/event`, `GET /event` → SSE bus (`server.connected` first, then events, heartbeats < 20s)
- `GET /config`, `/config/providers`, `/provider`, `/agent` (Kiro modes → OpenCode agents), `/project`, `/path`
- `GET/POST /session`, `GET/PATCH/DELETE /session/:id`, `GET /session/status`
- `GET /session/:id/message` (history with parts)
- `POST /session/:id/message` (prompt; streams text + tool parts via SSE; resolves at end of turn)
- `POST /session/:id/prompt_async`, `POST /session/:id/abort`
- `POST /session/:id/permissions/:permissionID` — permission answer (`once` | `always` | `reject`)
- Streaming translation: `agent_message_chunk` → text parts; `tool_call`/`tool_call_update` → tool parts
  (`pending`/`running`/`completed`/`error`)
- `fs/read_text_file` / `fs/write_text_file` ACP client requests

## Tests

```bash
node packages/kiro-bridge/test/e2e.mjs        # reject path: rejected command must NOT run
node packages/kiro-bridge/test/e2e-allow.mjs  # allow path: approved command runs, turn completes
```

Both run against the real `kiro-cli acp`.

## Not yet implemented (roadmap)

- Fork / revert / branch timeline, `session/load` (resume) history hydration
- Cost/token readout from `_kiro.dev/metadata`
- Slash commands, MCP/LSP status panels, shell mode, file browser (`/find*`, `/file*`) beyond fs client calls
- Multi-session concurrency isolation (one ACP process currently hosts all sessions)

See `~/kiro/swap/openchamber-kiro-adapter.md` for the full design and `~/kiro/swap/kiro-bridge-notes.md`
for verified protocol shapes.
