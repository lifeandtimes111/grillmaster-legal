#!/usr/bin/env bash
# Install exec-agent as a launchd user agent so it starts at login and restarts
# if it crashes. Re-run this after moving the project directory.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.execagent"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/$LABEL.plist"
TEMPLATE="$PROJECT_DIR/launchd/$LABEL.plist.template"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "launchd is macOS only. On Linux, run 'npm start' under systemd or a process manager." >&2
  exit 1
fi

if [[ ! -f "$PROJECT_DIR/.env" ]]; then
  echo "No .env found at $PROJECT_DIR/.env — copy .env.example and fill it in first." >&2
  exit 1
fi

NODE_BIN="$(command -v node)"
if [[ -z "$NODE_BIN" ]]; then
  echo "node is not on PATH." >&2
  exit 1
fi

mkdir -p "$PLIST_DIR" "$HOME/.exec-agent/logs"

# launchd gives the job a minimal PATH, so bake in the one this shell has.
sed -e "s|__NODE__|$NODE_BIN|g" \
    -e "s|__PROJECT__|$PROJECT_DIR|g" \
    -e "s|__HOME__|$HOME|g" \
    -e "s|__PATH__|$PATH|g" \
    "$TEMPLATE" > "$PLIST_PATH"

# bootout first so a re-run reloads cleanly; ignore the error when not loaded.
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST_PATH"
launchctl enable "gui/$UID/$LABEL"

echo "Installed $PLIST_PATH"
echo
echo "  status:  launchctl print gui/$UID/$LABEL | head -20"
echo "  logs:    tail -f ~/.exec-agent/logs/daemon.err.log"
echo "  stop:    launchctl bootout gui/$UID/$LABEL"
echo "  start:   launchctl bootstrap gui/$UID $PLIST_PATH"
