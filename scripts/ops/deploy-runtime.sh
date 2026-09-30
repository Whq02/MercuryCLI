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
build_tree="$(python3 -c "import json;print(json.load(open('$dist/manifest.json')).get('buildTree') or '')")"
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

runtime_folder_in_use() {
  local dir="$1" real f pid
  real="$(cd "$dir" 2>/dev/null && pwd -P)" || return 1
  if ps -axo command= 2>/dev/null | grep -F -- "$real/" | grep -qv 'grep -F'; then return 0; fi
  if command -v lsof >/dev/null 2>&1; then
    local files=()
    for f in "$real/manifest.json" "$real/mercury.mjs" "$real/vendor/node/bin/node" "$real/vendor/node/node.exe"; do
      [ -f "$f" ] && files+=("$f")
    done
    if [ "${#files[@]}" -gt 0 ] && lsof -t -- "${files[@]}" 2>/dev/null | grep -q .; then return 0; fi
  elif [ -d /proc ]; then
    for pid in /proc/[0-9]*; do
      case "$(readlink "$pid/exe" 2>/dev/null || true)" in "$real/"*) return 0 ;; esac
      for f in "$pid"/fd/*; do
        case "$(readlink "$f" 2>/dev/null || true)" in "$real/"*) return 0 ;; esac
      done
    done
  fi
  return 1
}

switch_pointer() {
  local link="$1" target="$2" tmp
  tmp="$link.new.$$"
  rm -f "$tmp"
  ln -s "$target" "$tmp"
  python3 -c 'import os,sys; os.rename(sys.argv[1], sys.argv[2])' "$tmp" "$link"
}

builds="$runtime/builds"
mkdir -p "$builds"
name="${build_tree:-nogit}"
name="${name:0:12}-${actual_bundle_sha:0:8}"
target="$builds/$name"
staging="$builds/.staging-$name.$$"
rm -rf "$staging"
cp -R "$dist" "$staging"

cat > "$staging/runtime-manifest.json" <<EOF
{
  "schema": 1,
  "sourceSha": "$head_sha",
  "sourceTree": "$head_tree",
  "dirty": $([ "$allow_dirty" = "1" ] && [ -n "$dirty" ] && echo true || echo false),
  "bundleSha256": "$actual_bundle_sha",
  "deployedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

if [ -e "$target" ]; then
  if runtime_folder_in_use "$target"; then
    n=2
    while [ -e "$target-$n" ] && runtime_folder_in_use "$target-$n"; do n=$((n + 1)); done
    target="$target-$n"
    rm -rf "$target"
  else
    rm -rf "$target"
  fi
fi
mv "$staging" "$target"
name="$(basename "$target")"

switch_pointer "$runtime/current" "builds/$name"

if [ -d "$runtime/dist" ] && [ ! -L "$runtime/dist" ]; then
  if runtime_folder_in_use "$runtime/dist"; then
    echo "runtime/dist is a folder a running daemon lives in — left in place untouched; runtime/current names the new build until that daemon is gone"
  else
    rm -rf "$runtime/dist"
    switch_pointer "$runtime/dist" "builds/$name"
  fi
else
  switch_pointer "$runtime/dist" "builds/$name"
fi

if [ -d "$runtime/dist.prev" ] && [ ! -L "$runtime/dist.prev" ]; then
  if runtime_folder_in_use "$runtime/dist.prev"; then
    echo "runtime/dist.prev still has a process running from it — left until a later deploy finds it free"
  else
    rm -rf "$runtime/dist.prev"
  fi
fi
for b in "$builds"/*/; do
  b="${b%/}"
  [ -d "$b" ] || continue
  [ "$(basename "$b")" = "$name" ] && continue
  case "$(basename "$b")" in .staging-*) rm -rf "$b"; continue ;; esac
  if runtime_folder_in_use "$b"; then
    echo "kept            → $b (a daemon or session still runs from it)"
  else
    rm -rf "$b"
  fi
done

echo "deployed runtime → $runtime/current → builds/$name (source $(git -C "$repo" rev-parse --short HEAD))"

bash "$repo/scripts/ops/deploy-launcher.sh"
bash "$repo/scripts/splash/deploy.sh"
