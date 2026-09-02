#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/ui/vshot.py src/daemon/** src/utils/crew/crewClient*
# gate-watch: src/utils/daemonBreaker* src/utils/swarm/teamHelpers*
# gate-watch: src/utils/teammateMailbox*
# Mercury crew teammates (/teammates) — proof harness. Runs every
# scripts/crew/prove-*.ts via bun run; render-*.ts (PTY-booting, ~30s each)
# join only under UI_RENDER=1 (the ui-suite convention). Non-zero exit on any
# failure. New proofs are picked up by the glob.
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
# SUITE-LEVEL ISOLATION: no proof may touch the real config home (team files,
# control keys, daemon state) or the live evolution ledger even on a proof
# bug — each proof still mints its own scratch MERCURY_CONFIG_DIR before
# importing store modules (the set-first idiom); this is the backstop.
export MERCURY_EVOLUTION_LEDGER=0
scratch_home="$(mktemp -d "${TMPDIR:-/tmp}/crew-proof-home.XXXXXX")"
export MERCURY_CONFIG_DIR="$scratch_home"
# Host-env hygiene: an operator's crew/role/posture env must not skew the
# polarity matrices these proofs assert.
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
