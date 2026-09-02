#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/harness-profiles/**
# gate-watch: src/services/mission/harnessProfiles.ts src/services/mission/policyProfiles.ts
# gate-watch: src/services/mission/harnessApplication.ts src/substrate/flagRegistry.ts
# gate-watch: src/utils/profile/mercuryProfile.ts src/utils/model/modelTransition.ts
# Owner artifacts exercised by these provers: the HarnessProfile vocabulary
# owner (src/services/mission/harnessProfiles.ts) · the gated application
# layer (src/services/mission/harnessApplication.ts — flag family
# MERCURY_HARNESS_PROFILE / MERCURY_HARNESS_PROFILE_PIN, registered in
# src/substrate/flagRegistry.ts) ·
# the session-profile fold (src/utils/profile/mercuryProfile.ts) · the CH-3
# operator surface (src/components/mercury-ui/parity/HarnessView.tsx — the
# /harness drill-in; src/components/mercury-ui/HarnessChip.tsx — the
# statusline chip; src/services/run/runKernel.ts modelState.harnessProfile —
# the ACP projection; src/services/crew/capabilities.ts 'harness-profile' —
# the external-seat honesty kind; captures harness-view/harness-chip 80+120
# via scripts/ui/renderScenarios.ts) · the CH-4 context-axis application
# (src/services/run/contextSelection.ts resolveSelectionPolicy — the flag
# outranks the profile request; src/services/run/requestContextPlan.ts
# harnessContextPolicy threaded by the turn machine AND /context for C09
# parity) · the CH-4 retained evidence (the campaign envelope and its manifest,
# written by a manual, billed batch run) ·
# the gate verdict rows (scripts/gate/gate-ledger.jsonl — the ledger commit
# for the exact SHA; recorded via scripts/gate/ledger.ts).
# Harness profiles — evidence-gated model–harness fit: one named,
# versioned, digest-bound HarnessProfile catalogue + pure resolver +
# application layer. Provers are glob-run so every landed
# prove-*.ts joins the gate automatically. Reproducers live as repro-*
# (expect-red drivers, run manually — never part of the green gate).
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

cd "$(dirname "$0")/../.." || exit 1
bun="${BUN:-$HOME/.bun/bin/bun}"

failed=0
shopt -s nullglob
for f in scripts/harness-profiles/prove-*.ts; do
  echo "── harness-profiles: $(basename "$f")"
  __t=$SECONDS; if ! "$bun" "$f"; then
    failed=1
  fi
  prover_mark "$f" "$__t"
done

exit "$failed"
