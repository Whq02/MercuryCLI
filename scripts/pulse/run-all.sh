#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/components/Spinner/** src/ink/** src/utils/pulse/**
# gate-watch: src/utils/router/providers/**
# scripts/pulse/run-all.sh — the proof suite
#
# Auto-joins the pooled green gate via the scripts/*/run-all.sh glob.
#
# Two sub-suites, explicit order (fast unit laws first, then the scenes):
#   spinner/  —-UI/3: stall honesty · display dwell · byline priority
#               (+ the render leg under UI_RENDER=1, the ui-suite convention)
#   matrix/   —/6: trace/phase unit laws + the deterministic scene
#               matrix provers over fixtureApi + the built artifact.
#
# Provers glob in per sub-suite (the orphaned-prover lesson); run-matrix.ts
# is the operator-facing scene explorer, NOT a gate prover.
set -uo pipefail
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUN="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "── MERCURY PULSE proofs ──"

bash "$here/spinner/run-all.sh" || fail=1

for f in "$here"/matrix/prove-*.ts; do
  [ -e "$f" ] || continue
  __t=$SECONDS; "$BUN" run "$f" || fail=1; prover_mark "$f" "$__t"
done

if [[ "$fail" == "0" ]]; then echo "✅ PULSE SUITE GREEN"; exit 0; else
  echo "❌ PULSE SUITE RED"; exit 1; fi
