#!/usr/bin/env bash
# drive capture-contracts.ts over the posture matrix for ONE tree.
# Usage: capture-all.sh <repo-root> <out-dir>
# Pins the ambient environment (F6 law): fresh MERCURY_CONFIG_DIR + fixture cwd
# outside any repo; per-posture env set here (module-load reads need a fresh
# process per posture).
set -u
ROOT="${1:?repo root}"
OUT="${2:?out dir}"
BUN="${HOME}/.bun/bin/bun"
mkdir -p "$OUT"
FIXHOME="$(mktemp -d)/home"; mkdir -p "$FIXHOME"
FIXCWD="$(mktemp -d)/cwd"; mkdir -p "$FIXCWD"

run() { # name extra-env...
  local name="$1"; shift
  ( cd "$FIXCWD" && env -i \
      HOME="$HOME" PATH="$PATH" SHELL="/bin/zsh" TERM=dumb \
      MERCURY_CONFIG_DIR="$FIXHOME" NODE_ENV=test \
      ANTHROPIC_API_KEY="sk-ant-proof-capture" \
      "$@" \
      "$BUN" run "$ROOT/scripts/behaviour-laws/capture-contracts.ts" "$name" \
  ) > "$OUT/$name.json" 2> "$OUT/$name.err"
  if [ -s "$OUT/$name.json" ]; then echo "  ok  $name"; else echo "  ERR $name ($(tail -1 "$OUT/$name.err" 2>/dev/null | cut -c1-120))"; fi
}

run fable-default
run opus-default
run sonnet-default
run gpt
run autopilot MERCURY_AUTOPILOT=1
run headless
run subagent-normal
run subagent-fixed
echo "captures → $OUT"
