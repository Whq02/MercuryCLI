#!/usr/bin/env bash
# ============================================================================
#  dist-cache-check.sh — may the gate REUSE dist instead of rebuilding?
#
#
#  REUSE (exit 0, prints "HIT <tree>") iff ALL of:
#    · dist/mercury.mjs + dist/manifest.json exist,
#    · manifest.degraded is empty (a degraded artifact is never silently
#      reused — a fresh prebuild would have vendored or failed loudly),
#    · manifest.buildTree is non-null and equals the CURRENT working-content
#      tree — the same content-binding idiom build.ts stamps and the gate
#      verdict records: a temp index seeded from HEAD, `git add -A`,
#      `git write-tree`. Content-bound, not commit-bound: any content change
#      (tracked-dirty included) misses; identical content hits regardless of
#      when the commit landed. Equals `git rev-parse HEAD^{tree}` on a clean
#      tree.
#  Anything else — no git, unborn HEAD, missing/degraded/torn manifest —
#  is a MISS (exit 1, prints "MISS <reason>"): fail-closed to a rebuild,
#  never a stale or degraded artifact under the gate.
#
#  Usage: dist-cache-check.sh [repo-root]   (default: cwd; the prover's seam)
# ============================================================================
set -u
root="${1:-.}"
cd "$root" || { echo "MISS bad-root"; exit 1; }

[ -f dist/mercury.mjs ] || { echo "MISS no-bundle"; exit 1; }
[ -f dist/manifest.json ] || { echo "MISS no-manifest"; exit 1; }

build_tree=$(python3 -c '
import json, sys
try:
    m = json.load(open("dist/manifest.json"))
except Exception:
    sys.exit(1)
if m.get("degraded"):
    print("DEGRADED"); sys.exit(0)
t = m.get("buildTree")
print(t if t else "")
' 2>/dev/null) || { echo "MISS torn-manifest"; exit 1; }
[ "$build_tree" = "DEGRADED" ] && { echo "MISS degraded-artifact"; exit 1; }
[ -n "$build_tree" ] && [ "${#build_tree}" -eq 40 ] || { echo "MISS no-buildTree"; exit 1; }

git rev-parse HEAD >/dev/null 2>&1 || { echo "MISS no-git"; exit 1; }
_ti=$(mktemp)
cur_tree=""
if GIT_INDEX_FILE="$_ti" git read-tree HEAD 2>/dev/null \
   && GIT_INDEX_FILE="$_ti" git add -A 2>/dev/null; then
  cur_tree=$(GIT_INDEX_FILE="$_ti" git write-tree 2>/dev/null || echo "")
fi
rm -f "$_ti"
[ -n "$cur_tree" ] || { echo "MISS tree-unresolvable"; exit 1; }

if [ "$cur_tree" = "$build_tree" ]; then
  echo "HIT $cur_tree"
  exit 0
fi
echo "MISS tree-changed (dist $build_tree ≠ working $cur_tree)"
exit 1
