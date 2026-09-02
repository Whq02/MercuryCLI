#!/usr/bin/env bash
# scripts/node-runtime/qualify-artifact.sh <dist/mercury.mjs> expect-supported|expect-refusal
#
# The compact real-process runtime qualification: drive the
# BUILT artifact with whatever `node` is first on PATH and assert the entry
# gate's decision. Used by gate.yml (calibration Node → expect-supported;
# real Node 22 → expect-refusal) and runnable locally (the refusal leg needs
# an older node on PATH — the node-runtime suite discovers one or loud-skips).
set -uo pipefail
dist="${1:-dist/mercury.mjs}"
mode="${2:-expect-supported}"
fail() { echo "  [FAIL] $1" >&2; exit 1; }
ok() { echo "  [PASS] $1"; }

command -v node >/dev/null 2>&1 || fail "no node on PATH"
nodev="$(node --version 2>/dev/null || echo none)"
echo "  · qualifying with node $nodev ($mode)"
[ -f "$dist" ] || fail "artifact missing: $dist"

run_leg() { # args...
  out=$(node "$dist" "$@" </dev/null 2>&1)
  rc=$?
}

case "$mode" in
  expect-supported)
    run_leg --version
    [ "$rc" -eq 0 ] || fail "--version exited $rc on a supported runtime: $out"
    printf '%s' "$out" | grep -q "Mercury" || fail "--version output missing the identity banner: $out"
    ok "--version → $out"
    run_leg --help
    [ "$rc" -eq 0 ] || fail "--help exited $rc on a supported runtime"
    ok "--help exits 0"
    ;;
  expect-refusal)
    run_leg --version
    [ "$rc" -ne 0 ] || fail "--version exited 0 — an unsupported runtime must refuse (node $nodev)"
    printf '%s' "$out" | grep -q "Node 24 LTS" || fail "refusal must name the supported label; got: $out"
    printf '%s' "$out" | grep -q "24.20.0" || fail "refusal must name the full range incl. the bound; got: $out"
    printf '%s' "$out" | grep -qE '^[[:space:]]+at ' && fail "refusal contains a stack trace: $out"
    ok "--version refused non-zero with the concise message"
    run_leg --help
    [ "$rc" -ne 0 ] || fail "--help exited 0 — the gate must precede every route"
    ok "--help refused non-zero"
    ;;
  *)
    fail "unknown mode '$mode' (expect-supported|expect-refusal)"
    ;;
esac
echo "✅ artifact qualification ($mode) under node $nodev"
