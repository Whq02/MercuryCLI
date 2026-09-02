#!/usr/bin/env bash
set -uo pipefail

REPO="${MERCURY_REPO:-$HOME/Developer/mercury}"
. "$(cd "$(dirname "$0")" && pwd)/lib/mercury-home.sh"
MERCURY_HOME="$(mercury_resolve_home)"
DEST_ROOT="$MERCURY_HOME/backups/workspace"
KEEP="${MERCURY_BACKUP_KEEP:-7}"
STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
DEST="$DEST_ROOT/$STAMP"

[ -d "$REPO/.git" ] || { echo "backup: no git repo at $REPO" >&2; exit 1; }
mkdir -p "$DEST"

git -C "$REPO" bundle create "$DEST/repo.bundle" --all >/dev/null 2>&1 \
  || { echo "backup: git bundle FAILED" >&2; exit 1; }
git -C "$REPO" rev-parse HEAD > "$DEST/HEAD"
git -C "$REPO" diff HEAD > "$DEST/working-diff.patch" 2>/dev/null || true
git -C "$REPO" ls-files --others --exclude-standard -z 2>/dev/null \
  | tar -C "$REPO" --null -T - -czf "$DEST/untracked.tgz" 2>/dev/null || true

tar -czf "$DEST/config.tgz" \
  --exclude file-history --exclude session-env --exclude paste-cache \
  --exclude cache --exclude debug --exclude backups --exclude archive \
  --exclude projects --exclude shell-snapshots --exclude telemetry \
  -C "$(dirname "$MERCURY_HOME")" "$(basename "$MERCURY_HOME")" 2>/dev/null || true
mem="$HOME/.claude/projects/$(printf '%s' "$REPO" | tr '/' '-')/memory"
if [ -d "$mem" ]; then
  tar -czf "$DEST/memory.tgz" -C "$(dirname "$mem")" memory 2>/dev/null || true
fi

tmutil localsnapshot >/dev/null 2>&1 || true

ls -1dt "$DEST_ROOT"/*/ 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r d; do
  case "$d" in
    "$DEST_ROOT"/2*Z/) rm -rf "$d" ;;
  esac
done

echo "backup: $DEST ($(du -sh "$DEST" 2>/dev/null | cut -f1))"
