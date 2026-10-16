#!/bin/sh
# OpenRig herdr plugin entry point: startup | start | stop | tui | web
set -u

say() { printf 'openrig-herdr: %s\n' "$*" >&2; }

if ! command -v rig >/dev/null 2>&1; then
  say "the rig CLI is not on PATH; install OpenRig (npm i -g @openrig/cli) and restart herdr."
  exit 0
fi

# The daemon this plugin starts drives THIS herdr server: herdr gives plugin commands its socket.
export OPENRIG_TERMINAL_BACKEND=herdr
[ -n "${HERDR_SOCKET_PATH:-}" ] && export OPENRIG_HERDR_SOCKET="$HERDR_SOCKET_PATH"

config_value() {
  # Plugin settings live in $HERDR_PLUGIN_CONFIG_DIR/config (KEY=VALUE lines).
  file="${HERDR_PLUGIN_CONFIG_DIR:-}/config"
  [ -f "$file" ] || return 0
  sed -n "s/^$1=//p" "$file" | tail -n 1
}

running() { rig daemon status 2>/dev/null | grep -q '^Daemon running'; }

case "${1:-}" in
  startup)
    [ "$(config_value autostart)" = "off" ] && exit 0
    if running; then exit 0; fi
    say "starting the OpenRig daemon on herdr"
    rig daemon start >/dev/null 2>&1 || say "rig daemon start failed; see: rig daemon logs"
    ;;
  start)
    if running; then say "daemon already running"; exit 0; fi
    rig daemon start
    ;;
  stop)
    rig daemon stop
    ;;
  tui)
    exec rig tui
    ;;
  web)
    url="${OPENRIG_URL:-http://127.0.0.1:${OPENRIG_PORT:-7433}}"
    if command -v open >/dev/null 2>&1; then open "$url"; elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$url"; else say "$url"; fi
    ;;
  *)
    say "usage: openrig-herdr.sh startup|start|stop|tui|web"
    exit 2
    ;;
esac
