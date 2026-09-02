#!/usr/bin/env bash
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

rm -rf "$runtime/dist.prev"
[ -d "$runtime/dist" ] && mv "$runtime/dist" "$runtime/dist.prev"
mv "$tmp" "$runtime/dist"

echo "deployed runtime → $runtime/dist (source $(git -C "$repo" rev-parse --short HEAD))"
[ -d "$runtime/dist.prev" ] && echo "previous kept   → $runtime/dist.prev (manual rollback only)"

bash "$repo/scripts/splash/deploy.sh"
