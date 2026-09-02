#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/utils/settings/types*
# ============================================================================
#  scripts/ownership/run-all.sh — the ownership contract suite. Pins the
#  eight control planes' public contracts (export inventory + vocabulary
#  needles + settings keys) and the
#  real-artifact golden runtime journeys (hermetic dist runs against the
#  deterministic fixture API). Globs prove-*.ts so the per-domain oracles the
#  cutover phases add auto-join; the suite auto-joins the green gate via
#  scripts/run-all-suites.sh's scripts/*/run-all.sh glob.
#  NOTE: prove-runtime-journeys needs the prebuilt dist (the pooled gate
#  prebuilds it in Phase 0; standalone runs must `bun run build.ts` first).
# ============================================================================
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# ownership — core-ownership contract + journey harness"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo "── $(basename "$proof") ──"
  __t=$SECONDS; "$bun" run "$proof" || fail=1; prover_mark "$proof" "$__t"
done
exit $fail
