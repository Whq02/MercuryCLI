#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
if [ "$#" -ne 1 ]; then printf '%s\n' 'Usage: bash scripts/media/vendor.sh /path/to/built-engine' >&2; exit 2; fi
node "$root/scripts/media/vendor.mjs" "$1/dist/vendor" "$root/src/extensions/bundled/mercury-media/server"
cd "$root"
bun scripts/extensions/gen-bundled.ts
