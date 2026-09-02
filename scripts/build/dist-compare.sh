#!/usr/bin/env bash

set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
BUN="${BUN:-$HOME/.bun/bin/bun}"
STAMP='2026-01-01T00:00:00.000Z'

case "${1:-hash}" in
  hash)
    d="$(mktemp -d)"
    trap 'rm -rf "$d"' EXIT
    log="$(mktemp)"
    if ! MERCURY_BUILD_TIME="$STAMP" MERCURY_BUILD_OUTDIR="$d" MERCURY_BUILD_MINIFY=oracle \
        "$BUN" run "$root/build.ts" >"$log" 2>&1; then
      echo "dist-compare: build FAILED — log follows" >&2
      cat "$log" >&2; rm -f "$log"; exit 1
    fi
    rm -f "$log"
    shasum -a 256 "$d/mercury.mjs" | awk '{print $1}'
    ;;
  *)
    echo "usage: dist-compare.sh hash" >&2
    exit 2
    ;;
esac
