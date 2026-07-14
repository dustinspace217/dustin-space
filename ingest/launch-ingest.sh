#!/usr/bin/env bash
# launch-ingest.sh — desktop launcher for the ingest tool.
#
# Invoked by the "dustin.space Image Ingest" KDE menu entry
# (~/.local/share/applications/dustin-space-ingest.desktop), so it must work
# WITHOUT a login shell: .desktop Exec lines don't source ~/.bashrc, which is
# why every binary below is an absolute path (/usr/bin/node etc.) instead of
# relying on PATH.
#
# Behavior: if the server is already up, just open the browser (clicking the
# menu entry twice must not start a second server — the port would collide).
# Otherwise start the server detached, wait for it to answer, then open the
# browser. The server keeps running quietly after the browser closes (so the
# next click is instant) and exits with your session at logout/reboot.
set -u

PORT=3333
URL="http://127.0.0.1:${PORT}"
INGEST_DIR="$(cd "$(dirname "$0")" && pwd)"
# Log to XDG state (not /tmp): survives reboots, so a crashed run's log is
# still there to read the morning after.
LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}"
LOG_FILE="${LOG_DIR}/dustin-space-ingest.log"
mkdir -p "$LOG_DIR"

# Readiness probe. --max-time keeps a wedged server from hanging the launcher.
is_up() {
	/usr/bin/curl -s -o /dev/null --max-time 2 "$URL"
}

if is_up; then
	/usr/bin/xdg-open "$URL"
	exit 0
fi

# Not running — start it detached. setsid + nohup + closed stdin fully detach
# the server from this script's lifetime, so the launcher can exit while the
# server keeps serving.
cd "$INGEST_DIR" || exit 1
/usr/bin/setsid /usr/bin/nohup /usr/bin/node server.js >> "$LOG_FILE" 2>&1 < /dev/null &

# Wait for readiness — bounded (Power-of-Ten rule 2): 30 x 0.5s = 15s max.
# Startup is normally <1s; the headroom covers a cold disk or npm doctor checks.
for _ in $(seq 1 30); do
	if is_up; then
		/usr/bin/xdg-open "$URL"
		exit 0
	fi
	sleep 0.5
done

# Startup failed — say so visibly (never fail silently) and point at the log,
# which holds the server's own error (missing vips/git, port conflict, ...).
/usr/bin/notify-send --app-name="dustin.space Ingest" --icon=dialog-error \
	"Ingest server failed to start" \
	"It didn't answer on port ${PORT} within 15s. See ${LOG_FILE} for the error."
exit 1
