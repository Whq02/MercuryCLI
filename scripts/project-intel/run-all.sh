#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/project-intel/**
# gate-watch: src/services/projectIntel/** src/services/resources/adapters/project.ts
# gate-watch: src/utils/cockpit/repoSurfaceMap*
set -u
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# Project intelligence — proof suite"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; "$bun" run "$proof" || fail=1; prover_mark "$proof" "$__t"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL PROJECT-INTEL PROOFS PASS"; else echo "# ❌ SOME PROJECT-INTEL PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
