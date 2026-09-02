#!/usr/bin/env bash
# ============================================================================
#  prove-dist-cache.sh — the Phase-0 dist cache decision is itself gated
# Exercises scripts/gate/dist-cache-check.sh against a
#  SCRATCH git repo (never the real dist):
#    1. content-match           → HIT
#    2. tracked edit (dirty)    → MISS tree-changed   (fail-closed)
#    3. dirty-content stamp     → HIT (content-bound, not commit-bound);
#       a further edit          → MISS again
#    4. degraded artifact       → MISS degraded-artifact (never reused)
#    5. missing manifest/bundle → MISS
#    6. null buildTree          → MISS
#    7. not a git repo          → MISS no-git
# ============================================================================
set -u
here="$(cd "$(dirname "$0")" && pwd)"
check="$here/dist-cache-check.sh"
fail=0
work=$(mktemp -d "${TMPDIR:-/tmp}/dist-cache-proof.XXXXXX")
trap 'rm -rf "$work"' EXIT

repo="$work/repo"
mkdir -p "$repo/dist"
git -C . rev-parse --git-dir >/dev/null 2>&1 || true
(
  # dist/ is IGNORED, as in the real repo — the content tree must be stable
  # while dist artifacts are written (build.ts stamps buildTree mid-build on
  # exactly this invariant).
  cd "$repo" \
    && git init -q \
    && git config user.email proof@local && git config user.name proof \
    && printf 'dist/\n' >.gitignore \
    && echo v1 >src.txt && git add -A && git commit -qm one
)

content_tree() { # of $repo's working content (the build.ts / verdict idiom)
  local ti t
  ti=$(mktemp)
  t=$(cd "$repo" \
    && GIT_INDEX_FILE="$ti" git read-tree HEAD 2>/dev/null \
    && GIT_INDEX_FILE="$ti" git add -A 2>/dev/null \
    && GIT_INDEX_FILE="$ti" git write-tree 2>/dev/null)
  rm -f "$ti"
  printf '%s' "$t"
}
stamp() { # $1=buildTree|null  $2=degraded-json
  python3 - "$repo/dist/manifest.json" "$1" "$2" <<'PY'
import json, sys
tree = None if sys.argv[2] == 'null' else sys.argv[2]
json.dump({'schema': 1, 'buildTree': tree, 'degraded': json.loads(sys.argv[3])},
          open(sys.argv[1], 'w'))
PY
}
expect() { # $1=label $2=want-rc $3=want-prefix
  local out rc
  out=$(bash "$check" "$repo" 2>&1); rc=$?
  if [ "$rc" = "$2" ] && printf '%s' "$out" | grep -q "^$3"; then
    echo "  ✓ $1 → $out"
  else
    echo "  ✗ $1 broken: rc=$rc (want $2), out='$out' (want $3…)"; fail=1
  fi
}

echo bundle >"$repo/dist/mercury.mjs"
stamp "$(content_tree)" '[]'
expect 'content-match' 0 'HIT'

echo v2 >"$repo/src.txt"
expect 'tracked edit (dirty)' 1 'MISS tree-changed'

stamp "$(content_tree)" '[]'
expect 'dirty-content stamp (content-bound)' 0 'HIT'
echo v3 >"$repo/src.txt"
expect 'further edit after dirty stamp' 1 'MISS tree-changed'

stamp "$(content_tree)" '["python-debugger"]'
expect 'degraded artifact' 1 'MISS degraded-artifact'

stamp null '[]'
expect 'null buildTree' 1 'MISS no-buildTree'

rm "$repo/dist/manifest.json"
expect 'missing manifest' 1 'MISS no-manifest'
stamp "$(content_tree)" '[]'
rm "$repo/dist/mercury.mjs"
expect 'missing bundle' 1 'MISS no-bundle'

mkdir -p "$work/norepo/dist"
echo bundle >"$work/norepo/dist/mercury.mjs"
cp "$repo/dist/manifest.json" "$work/norepo/dist/manifest.json"
out=$(cd "$work" && bash "$check" "$work/norepo" 2>&1); rc=$?
if [ "$rc" = "1" ] && printf '%s' "$out" | grep -q 'MISS'; then
  echo "  ✓ not-a-git-repo → $out"
else
  echo "  ✗ not-a-git-repo broken: rc=$rc out='$out'"; fail=1
fi

exit "$fail"
