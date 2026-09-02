#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/consistency-census/** src/constants/systemPromptSections.ts
# gate-watch: src/utils/worktree.ts src/utils/cache/cacheClock.ts scripts/release/payloadContract.mjs
# gate-watch: scripts/lib/git.ts scripts/lib/executionProfile.ts scripts/lib/captureDriver.ts
# canonical truth, lifecycle settlement, interface
# coherence. Provers are glob-run so every
# landed prove-*.ts joins the gate automatically. Reproducers live as repro-*
# (expect-red drivers, run manually — never part of the green gate).
# Owner artifacts exercised by these provers: scripts/lib/git.ts ·
# scripts/lib/executionProfile.ts · scripts/lib/captureDriver.ts ·
# lockup-census.json · shellstring-census.json.
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

cd "$(dirname "$0")/../.."
bun="${BUN:-$HOME/.bun/bin/bun}"

failed=0
shopt -s nullglob
for f in scripts/consistency-census/prove-*.ts; do
  echo "── consistency-census: $(basename "$f")"
  __t=$SECONDS; if ! "$bun" "$f"; then
    failed=1
  fi
  prover_mark "$f" "$__t"
done

exit "$failed"
