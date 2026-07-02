#!/usr/bin/env bash
# Launch the kiro-bridge live so OpenChamber can drive Kiro CLI.
#
# Usage:
#   ./run.sh                          # bridge only (default)
#   ./run.sh --with-openchamber       # also start OpenChamber (from source) pointed at the bridge
#   ./run.sh --with-openchamber --build  # ...and build the web UI first if it's missing (slow, opt-in)
#   ./run.sh --port 5000              # bridge port (default 4599)
#   ./run.sh --oc-port 3000           # OpenChamber web port (default 3000)
#   ./run.sh --cwd /path/to/project   # project Kiro operates in
#   ./run.sh --agent des-agent        # override the agent (see warning below)
#   KIRO_BRIDGE_AGENT=repo-writer ./run.sh
#
# NOTE: `openchamber` is not a global command in this setup. From this source
# repo it is run as: node packages/web/bin/cli.js serve. --with-openchamber does
# that for you. The web UI is NOT built implicitly: if packages/web/dist is
# missing, run.sh exits with instructions unless you pass --build (a slow, one-
# time Vite build). The bridge itself needs no build.
#
# Manual attach (if you start OpenChamber yourself), from the repo root:
#   OPENCODE_HOST=http://127.0.0.1:<bridge-port> OPENCODE_SKIP_START=true \
#     node packages/web/bin/cli.js serve --foreground
#
# ---------------------------------------------------------------------------
# AGENT / PERMISSIONS
#   The default agent is intentionally a NON-pre-trusting agent so that every
#   tool call surfaces a permission prompt in OpenChamber (no auto-approval).
#   Agents like "des-agent" pre-trust tools (shell/read/aws/...), which means
#   their tool calls run WITHOUT a prompt. You can select such an agent, but
#   run.sh will warn you, because it weakens the no-auto-approval guarantee.
# ---------------------------------------------------------------------------

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Repo root is two levels up from packages/kiro-bridge.
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# --- configurable defaults (env, overridable by flags) ---
PORT="${KIRO_BRIDGE_PORT:-4599}"
HOST="${KIRO_BRIDGE_HOST:-127.0.0.1}"
CWD="${KIRO_BRIDGE_CWD:-$PWD}"
OC_PORT="${OPENCHAMBER_PORT:-3000}"
AGENT="${KIRO_BRIDGE_AGENT:-kiro_default}"
WITH_OPENCHAMBER=0

# Agents known to pre-trust tools -> selecting one bypasses permission prompts.
PRETRUSTING_AGENTS=("des-agent" "repo-writer")

usage() {
  sed -n '2,31p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)  PORT="$2"; shift 2 ;;
    --host)  HOST="$2"; shift 2 ;;
    --cwd)   CWD="$2"; shift 2 ;;
    --agent) AGENT="$2"; shift 2 ;;
    --oc-port) OC_PORT="$2"; shift 2 ;;
    --with-openchamber) WITH_OPENCHAMBER=1; shift ;;
    --build) DO_BUILD=1; shift ;;
    -h|--help) usage ;;
    *) echo "Unknown argument: $1" >&2; echo "Try --help" >&2; exit 2 ;;
  esac
done

# --- sanity checks ---
if ! command -v node >/dev/null 2>&1; then
  echo "error: node not found on PATH" >&2; exit 1
fi
if ! command -v kiro-cli >/dev/null 2>&1 && [[ -z "${KIRO_BRIDGE_KIRO_BIN:-}" ]]; then
  echo "error: kiro-cli not found on PATH (set KIRO_BRIDGE_KIRO_BIN to override)" >&2; exit 1
fi

# --- warn if the selected agent pre-trusts tools ---
for a in "${PRETRUSTING_AGENTS[@]}"; do
  if [[ "$AGENT" == "$a" ]]; then
    echo "============================================================" >&2
    echo "WARNING: agent '$AGENT' pre-trusts tools." >&2
    echo "         Its tool calls may run WITHOUT a permission prompt" >&2
    echo "         in OpenChamber, weakening the no-auto-approval guard." >&2
    echo "         Use 'kiro_default' if you want a prompt for every tool." >&2
    echo "============================================================" >&2
  fi
done

BRIDGE_URL="http://$HOST:$PORT"
echo "[run.sh] agent=$AGENT  host=$HOST  bridge-port=$PORT  cwd=$CWD"

# ---------------------------------------------------------------------------
# Mode 1: bridge only
# ---------------------------------------------------------------------------
if [[ "$WITH_OPENCHAMBER" -eq 0 ]]; then
  echo "[run.sh] starting bridge only. To attach OpenChamber from source, run in another"
  echo "         terminal (from $REPO_ROOT):"
  echo "         OPENCODE_HOST=$BRIDGE_URL OPENCODE_SKIP_START=true node packages/web/bin/cli.js serve --foreground"
  echo "         NOTE: if you see 'Unable to locate the opencode CLI', that CLI still requires an"
  echo "         opencode binary to resolve even with SKIP_START. Add a placeholder, e.g.:"
  echo "         OPENCODE_BINARY=\"$SCRIPT_DIR/.stub-bin/opencode\" (create it, chmod +x, echo a version)."
  echo "         Easiest: just use ./run.sh --with-openchamber which handles this for you."
  echo
  exec node "$SCRIPT_DIR/bin/kiro-bridge.mjs" \
    --port "$PORT" --host "$HOST" --cwd "$CWD" --agent "$AGENT"
fi

# ---------------------------------------------------------------------------
# Mode 2: bridge + OpenChamber (from source)
# ---------------------------------------------------------------------------
OC_CLI="$REPO_ROOT/packages/web/bin/cli.js"
if [[ ! -f "$OC_CLI" ]]; then
  echo "error: OpenChamber CLI not found at $OC_CLI" >&2; exit 1
fi

# The web UI must be built once before it can be served. We DO NOT build it
# implicitly: `bun run build:web` is a slow Vite production build and should be
# an explicit, visible step. Pass --build to run it, or run it yourself.
if [[ ! -d "$REPO_ROOT/packages/web/dist" ]]; then
  if [[ "${DO_BUILD:-0}" -eq 1 ]]; then
    echo "[run.sh] --build given: building web UI once (bun run build:web). This can take a few minutes..."
    ( cd "$REPO_ROOT" && bun run build:web )
  else
    echo "error: web UI is not built (packages/web/dist missing)." >&2
    echo "       Build it once (slow, a few minutes):" >&2
    echo "         cd $REPO_ROOT && bun run build:web" >&2
    echo "       Then re-run with --with-openchamber. Or pass --build to build now." >&2
    echo "       (Tip: use --api-only style is not needed; the bridge itself does not require the UI build.)" >&2
    exit 1
  fi
fi

BRIDGE_PID=""
OC_PID=""
cleanup() {
  echo
  echo "[run.sh] shutting down..."
  [[ -n "$OC_PID" ]] && kill "$OC_PID" 2>/dev/null || true
  [[ -n "$BRIDGE_PID" ]] && kill "$BRIDGE_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "[run.sh] starting bridge on $BRIDGE_URL ..."
node "$SCRIPT_DIR/bin/kiro-bridge.mjs" \
  --port "$PORT" --host "$HOST" --cwd "$CWD" --agent "$AGENT" &
BRIDGE_PID=$!

# Wait for the bridge health endpoint before launching OpenChamber.
echo "[run.sh] waiting for bridge to become healthy..."
for i in $(seq 1 50); do
  if curl -sf "$BRIDGE_URL/global/health" >/dev/null 2>&1; then
    echo "[run.sh] bridge healthy."
    break
  fi
  if ! kill -0 "$BRIDGE_PID" 2>/dev/null; then
    echo "error: bridge exited during startup" >&2; exit 1
  fi
  sleep 0.2
done

echo "[run.sh] starting OpenChamber (from source) on http://$HOST:$OC_PORT ..."
echo "[run.sh] starting OpenChamber (from source) on http://$HOST:$OC_PORT ..."

# OpenChamber's `serve` CLI hard-requires an `opencode` binary to resolve on PATH
# (or via OPENCODE_BINARY) even when OPENCODE_SKIP_START=true — it resolves it up
# front, before the server checks skip-start. Since we attach to our bridge and
# never launch OpenCode, provide a harmless placeholder if no real opencode exists.
# With OPENCODE_SKIP_START=true this placeholder is NEVER executed.
OPENCODE_BINARY_OVERRIDE=""
if command -v opencode >/dev/null 2>&1; then
  OPENCODE_BINARY_OVERRIDE="$(command -v opencode)"
else
  STUB_DIR="$SCRIPT_DIR/.stub-bin"
  STUB="$STUB_DIR/opencode"
  mkdir -p "$STUB_DIR"
  if [[ ! -x "$STUB" ]]; then
    cat > "$STUB" <<'STUBEOF'
#!/usr/bin/env bash
# Placeholder opencode binary for kiro-bridge. OpenChamber is run with
# OPENCODE_SKIP_START=true, so this is never actually used to serve. It only
# satisfies the CLI's up-front binary-resolution guard.
echo "opencode 0.0.0-kiro-bridge-placeholder"
exit 0
STUBEOF
    chmod +x "$STUB"
  fi
  OPENCODE_BINARY_OVERRIDE="$STUB"
  echo "[run.sh] no real 'opencode' on PATH; using placeholder $STUB (never launched due to SKIP_START)"
fi

( cd "$REPO_ROOT" && \
  OPENCODE_HOST="$BRIDGE_URL" OPENCODE_SKIP_START=true OPENCODE_BINARY="$OPENCODE_BINARY_OVERRIDE" \
  node "$OC_CLI" serve --foreground --host "$HOST" --port "$OC_PORT" ) &
OC_PID=$!

echo
echo "[run.sh] ---------------------------------------------------------------"
echo "[run.sh] Bridge:      $BRIDGE_URL"
echo "[run.sh] OpenChamber: http://$HOST:$OC_PORT"
echo "[run.sh] Permissions routed to OpenChamber; nothing is auto-approved."
echo "[run.sh] Ctrl-C to stop both."
echo "[run.sh] ---------------------------------------------------------------"

# Exit when either process exits.
wait -n "$BRIDGE_PID" "$OC_PID"
