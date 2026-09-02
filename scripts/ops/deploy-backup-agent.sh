#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/lib/mercury-home.sh"

LABEL="com.mercury.workspace-backup"
MERCURY_HOME="$(mercury_resolve_home)"
script_dst="$MERCURY_HOME/bin/workspace-backup.sh"
log_dst="$MERCURY_HOME/backups/workspace/launchd.log"
agents_dir="${MERCURY_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
plist_dst="$agents_dir/$LABEL.plist"

render_plist() {
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$script_dst</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>4</integer><key>Minute</key><integer>30</integer></dict>
  <key>StandardOutPath</key><string>$log_dst</string>
  <key>StandardErrorPath</key><string>$log_dst</string>
</dict>
</plist>
EOF
}

mode="install"
for arg in "$@"; do
  case "$arg" in
    --print) mode="print" ;;
    --no-load) mode="no-load" ;;
    *) echo "deploy-backup-agent: unknown argument $arg (flags: --print, --no-load)" >&2; exit 2 ;;
  esac
done

if [ "$mode" = "print" ]; then
  render_plist
  exit 0
fi

if [ "$mode" = "install" ] && ! command -v launchctl >/dev/null 2>&1; then
  echo "deploy-backup-agent: launchctl not found — the LaunchAgent is macOS-only (use --no-load to stage the files)" >&2
  exit 1
fi

bash -n "$here/workspace-backup.sh"
bash -n "$here/lib/mercury-home.sh"
mkdir -p "$MERCURY_HOME/bin/lib" "$MERCURY_HOME/backups/workspace" "$agents_dir"
cp "$here/workspace-backup.sh" "$script_dst"
cp "$here/lib/mercury-home.sh" "$MERCURY_HOME/bin/lib/mercury-home.sh"
chmod 755 "$script_dst"
render_plist > "$plist_dst"
echo "deployed → $script_dst (+ bin/lib/mercury-home.sh)"
echo "rendered → $plist_dst (daily 04:30 · log $log_dst)"

if [ "$mode" = "no-load" ]; then
  echo "not loaded (--no-load)"
  exit 0
fi

domain="gui/$(id -u)"
launchctl bootout "$domain/$LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "$domain" "$plist_dst"
echo "loaded   → $domain/$LABEL"
