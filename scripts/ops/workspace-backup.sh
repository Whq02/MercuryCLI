#!/usr/bin/env bash
# ============================================================================
#  workspace-backup.sh — the nightly disaster net (post-incident:
#  the repo was DELETED from disk; git-on-GitHub saved commits, but every
#  untracked file died). Bundles the FULL repo (all refs) + tars untracked
#  files + snapshots the working diff into
#      <config-home>/backups/workspace/<utc-stamp>/
#  rotates to the newest 7, and takes an APFS local snapshot when Time
#  Machine allows one. Scheduled by ~/Library/LaunchAgents/
#  com.mercury.workspace-backup.plist (daily 04:30, installed by
#  scripts/ops/deploy-backup-agent.sh); safe to run by hand.
#  Source of truth: scripts/ops/ (repo); deployed copy: <config-home>/bin/.
# ============================================================================
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
# Untracked-but-not-ignored files (bench results, scratch notes, local
# settings) — the exact class the incident actually destroyed.
git -C "$REPO" ls-files --others --exclude-standard -z 2>/dev/null \
  | tar -C "$REPO" --null -T - -czf "$DEST/untracked.tgz" 2>/dev/null || true

# Config home core (settings/hooks/bin/teams/boot-env/wrapper/splash) + the
# project memory index — the other irreplaceable state. Bulk caches excluded.
tar -czf "$DEST/config.tgz" \
  --exclude file-history --exclude session-env --exclude paste-cache \
  --exclude cache --exclude debug --exclude backups --exclude archive \
  --exclude projects --exclude shell-snapshots --exclude telemetry \
  -C "$(dirname "$MERCURY_HOME")" "$(basename "$MERCURY_HOME")" 2>/dev/null || true
mem="$HOME/.claude/projects/$(printf '%s' "$REPO" | tr '/' '-')/memory"
if [ -d "$mem" ]; then
  tar -czf "$DEST/memory.tgz" -C "$(dirname "$mem")" memory 2>/dev/null || true
fi

# APFS local snapshot (whole-volume, point-in-time; verified to work on this
# machine WITHOUT a Time Machine destination — snapshots are purgeable under
# disk pressure, so the tarballs above remain the durable layer).
tmutil localsnapshot >/dev/null 2>&1 || true

# Rotate: keep the newest $KEEP stamped dirs. Deletion is guarded to stamped
# children of DEST_ROOT only.
ls -1dt "$DEST_ROOT"/*/ 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r d; do
  case "$d" in
    "$DEST_ROOT"/2*Z/) rm -rf "$d" ;;
  esac
done

echo "backup: $DEST ($(du -sh "$DEST" 2>/dev/null | cut -f1))"
