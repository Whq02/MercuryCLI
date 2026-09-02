#!/usr/bin/env bash
# ============================================================================
# deploy-runtime.sh — publish the built artifact to the operator's launcher
# runtime (deploy-on-green).
#
# WHY: the launcher would otherwise boot the repo's
# live dist/mercury.mjs directly, so every mid- `bun run build.ts`
# hot-swapped the production binary with unverified WIP — a WIP bundle
# crashed a live operator session. The launcher now boots ONLY the deployed
# copy under <config-home>/runtime/dist; this script is the ONE way bits get
# there, and it refuses anything that is not exactly a committed tree's
# build:
#   · the working tree must be CLEAN (git status --porcelain empty), and
#   · dist/manifest.json .buildTree must equal `git rev-parse HEAD^{tree}`
#     (the bundle was built from exactly the committed tree), and
#   · sha256(dist/mercury.mjs) must equal manifest .bundleSha256 (the
#     candidate-tuple byte bind — a tampered/torn bundle on a clean tree
#     would otherwise deploy silently; phase-2 tuple-chain).
# --allow-dirty skips the two TREE checks LOUDLY (dev machines only; the
# runtime manifest records dirty=true so /doctor and the launcher can say
# so). The byte bind is never skipped.
#
# The doctrine holds: a missing runtime is a LOUD launcher
# failure, never a silent fallback. One previous runtime is kept beside the
# live one as runtime/dist.prev for MANUAL rollback — nothing auto-boots it.
# ============================================================================
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
. "$here/lib/mercury-home.sh"
MERCURY_HOME="$(mercury_resolve_home)"
runtime="$MERCURY_HOME/runtime"
allow_dirty=0
[ "${1:-}" = "--allow-dirty" ] && allow_dirty=1

dist="$repo/dist"
[ -f "$dist/mercury.mjs" ] || { echo "deploy-runtime: no build at $dist/mercury.mjs — run \`bun run build.ts\` first" >&2; exit 66; }
[ -f "$dist/manifest.json" ] || { echo "deploy-runtime: $dist/manifest.json missing — rebuild" >&2; exit 66; }

dirty="$(git -C "$repo" status --porcelain)"
head_sha="$(git -C "$repo" rev-parse HEAD)"
head_tree="$(git -C "$repo" rev-parse 'HEAD^{tree}')"
build_tree="$(python3 -c "import json;print(json.load(open('$dist/manifest.json'))['buildTree'])")"
manifest_bundle_sha="$(python3 -c "import json;print(json.load(open('$dist/manifest.json')).get('bundleSha256',''))")"

# BUNDLE-BYTE BIND: buildTree proves which
# SOURCE the manifest claims, not which BYTES sit in mercury.mjs — dist/ is
# gitignored, so a tampered/torn bundle on a clean tree would otherwise deploy
# silently. The manifest now carries bundleSha256 (build.ts writes it on the
# same successful build); recompute and refuse ANY mismatch, in every mode —
# --allow-dirty overrides tree provenance, never byte integrity.
if [ -z "$manifest_bundle_sha" ]; then
  echo "deploy-runtime: REFUSED — dist/manifest.json carries no bundleSha256 (pre-bind build) — rebuild (\`bun run build.ts\`)" >&2
  exit 75
fi
actual_bundle_sha="$(shasum -a 256 "$dist/mercury.mjs" | awk '{print $1}')"
if [ "$actual_bundle_sha" != "$manifest_bundle_sha" ]; then
  echo "deploy-runtime: REFUSED — dist/mercury.mjs bytes do not match the manifest's bundleSha256:" >&2
  echo "  manifest.bundleSha256 : $manifest_bundle_sha" >&2
  echo "  sha256(mercury.mjs)   : $actual_bundle_sha" >&2
  echo "  the bundle was modified after the build — rebuild (\`bun run build.ts\`) and retry." >&2
  exit 75
fi

if [ "$allow_dirty" = "0" ]; then
  if [ -n "$dirty" ]; then
    echo "deploy-runtime: REFUSED — the working tree is dirty (deploy-on-green only):" >&2
    echo "$dirty" | head -12 >&2
    echo "  commit (green) first, or --allow-dirty to override loudly." >&2
    exit 75
  fi
  if [ "$build_tree" != "$head_tree" ]; then
    echo "deploy-runtime: REFUSED — dist was not built from the committed tree:" >&2
    echo "  manifest.buildTree : $build_tree" >&2
    echo "  HEAD^{tree}        : $head_tree" >&2
    echo "  rebuild on the clean tree (\`bun run build.ts\`) and retry." >&2
    exit 75
  fi
else
  echo "deploy-runtime: --allow-dirty — publishing an UNVERIFIED tree (recorded in the runtime manifest)" >&2
fi

mkdir -p "$runtime"
tmp="$runtime/dist.tmp.$$"
rm -rf "$tmp"
cp -R "$dist" "$tmp"

cat > "$tmp/runtime-manifest.json" <<EOF
{
  "schema": 1,
  "sourceSha": "$head_sha",
  "sourceTree": "$head_tree",
  "dirty": $([ "$allow_dirty" = "1" ] && [ -n "$dirty" ] && echo true || echo false),
  "bundleSha256": "$actual_bundle_sha",
  "deployedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

# swap: keep exactly one previous runtime for MANUAL rollback
rm -rf "$runtime/dist.prev"
[ -d "$runtime/dist" ] && mv "$runtime/dist" "$runtime/dist.prev"
mv "$tmp" "$runtime/dist"

echo "deployed runtime → $runtime/dist (source $(git -C "$repo" rev-parse --short HEAD))"
[ -d "$runtime/dist.prev" ] && echo "previous kept   → $runtime/dist.prev (manual rollback only)"

# The enter screen ships WITH the runtime (operator ruling: one
# deploy, one estate — a splash parked on a separate step goes stale against
# the runtime it fronts). Same repo-canonical source, same idempotent
# launcher-block injection; a splash failure fails the deploy loudly.
bash "$repo/scripts/splash/deploy.sh"
