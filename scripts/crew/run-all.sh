#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/ui/vshot.py src/daemon/** src/utils/crew/crewClient*
# gate-watch: src/utils/daemonBreaker* src/utils/scribe/scribeGates* src/utils/swarm/teamHelpers*
# gate-watch: src/utils/teammateMailbox*
set -u
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
export MERCURY_EVOLUTION_LEDGER=0
scratch_home="$(mktemp -d "${TMPDIR:-/tmp}/crew-proof-home.XXXXXX")"
export MERCURY_CONFIG_DIR="$scratch_home"
unset MERCURY_CREW MERCURY_CREW_AGENT MERCURY_DAEMON_CREW MERCURY_DAEMON_PERMISSION_MODE MERCURY_PARTY_RECON_ALLOW 2>/dev/null || true
trap 'rm -rf "$scratch_home"' EXIT
echo "############################################################"
echo "# Crew teammates — proof harness"
echo "############################################################"
shopt -s nullglob
globs=("$here"/prove-*.ts)
[ "${UI_RENDER:-0}" = "1" ] && globs+=("$here"/render-*.ts)
for proof in "${globs[@]}"; do
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; "$bun" run "$proof" || fail=1; prover_mark "$proof" "$__t"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL CREW PROOFS PASS"; else echo "# ❌ SOME CREW PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
