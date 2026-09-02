#!/usr/bin/env bash
# scripts/build/dist-compare.sh — whole-bundle hash probe (advisory).
#
# Builds the CURRENT tree with a PINNED stamp into a scratch outdir (oracle
# minify mode: identifiers preserved) and prints the bundle sha256.
#
# HONEST SEMANTICS — read before trusting:
#   equal hashes  => the bundles are identical: strong PROOF of no change.
#   differing     => INCONCLUSIVE. bun 1.3.11's bundler is not a pure function
#                    of its input (module-init wiring varies across identical
#                    inputs — verified), so a hash mismatch may be
#                    bundler noise, not a source change.

#
# Usage: dist-compare.sh hash -> builds once, prints <sha256> of mercury.mjs
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
