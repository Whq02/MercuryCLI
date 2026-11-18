#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/utils/**
# gate-watch: src/cli/handlers/auth.ts
# gate-watch: src/daemon/*
# gate-watch: src/services/instructions/adapters/index.ts
# gate-watch: src/services/providers/local/tensorfoldState.ts
# gate-watch: src/cli/headless/*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
export MERCURY_CREDENTIAL_STORE="${MERCURY_CREDENTIAL_STORE:-file}"
echo "############################################################"
echo "# /health certificate — proof harness"
echo "############################################################"
shopt -s nullglob
claimed=$(members_cat scripts/health-*/members.txt)

for proof in "$here"/prove-*.ts; do
  if printf '%s\n' "$claimed" | grep -qx "$(basename "$proof")"; then continue; fi
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; __rc=0; "$bun" run "$proof" || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL HEALTH PROOFS PASS"; else echo "# ❌ SOME HEALTH PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
