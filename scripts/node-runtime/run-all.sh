#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/release/** .github/workflows/**
# gate-watch: src/**
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1
root="$PWD"
here="scripts/node-runtime"
fail=0

echo "── Node 24 LTS runtime-contract proofs ──"
drive_members node-runtime 'scripts/node-runtime/$name' "$here/members.txt" || fail=1

if [[ -f "$root/dist/mercury.mjs" ]]; then
  echo ""
  echo "▶ qualify-artifact (expect-supported, ambient node)"
  __t=$SECONDS; __rc=0; bash "$here/qualify-artifact.sh" "$root/dist/mercury.mjs" expect-supported || { __rc=$?; fail=1; }; prover_mark "$here/qualify-artifact.sh" "$__t" "$__rc"
else
  echo "  [SKIP] dist/mercury.mjs absent — the pooled gate prebuilds it"
fi

if [[ "$fail" == "0" ]]; then
  echo ""
  echo "✅ node-runtime suite pass"
  exit 0
fi
echo ""
echo "❌ node-runtime suite FAILED"
exit 1
