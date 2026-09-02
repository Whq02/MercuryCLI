#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/model-transition/**
# gate-watch: src/utils/model/modelTransition.ts src/services/run/requestContextPlan.ts
# gate-watch: src/fabric/** src/utils/sessionStorage/** src/services/providers/**
# gate-watch: src/services/branches/** src/services/run/contextSelection.ts
# model-transition suite — portable sessions, deterministic time, adaptive
# context, incremental surfaces, cap survival.
# Provers are glob-run so every landed prove-*.ts joins the gate
# automatically. Reproducers live as repro-* (expect-red drivers, run
# manually — never part of the green gate).
# Owners exercised: the transition/settlement owner (modelTransition.ts) ·
# the context-plan owner (requestContextPlan.ts) · the record fabric
# (src/fabric/record.ts — the identity law pinned by
# prove-transition-g05-recordid-law.ts) · limit truth (claudeAiLimits.ts) ·
# the transition-preview owners (src/services/providers/transitionPreview.ts;
# src/components/TransitionPreviewCard.tsx — the needs_choice card;
# src/components/CapOfferCard.tsx — the cap offer/way-home card;
# src/services/providers/providerUsability.ts — THE provider-usability
# resolver + openaiOnlyBootNotice) ·
# the replay/branch owners (src/utils/sessionStorage/materialize.ts —
# the canonical materialization fold + digest; src/services/branches/
# branchManifest.ts — branch creation with immutable lineage;
# src/components/MessageSelector.tsx — the timeline triad
# View only / Create branch / Rerun from here) ·
# the selection stage (src/services/run/contextSelection.ts — policy
# classes, required closure, the bounded incremental candidate index,
# accountable exclusions; joined to the ONE builder in requestContextPlan.ts
# at planVersion 2) ·
# src/services/run/contextCalibration.ts — the epoch-keyed token
# calibration store, reconciled by the turn machine's first-call settle ·
# src/services/crew/activity.ts — the ONE semantic activity vocabulary +
# the continuity classifiers and the additive model field, surfaced
# by src/components/workbench/WorkbenchBoard.tsx ·
# the reconnect contract — the transcript resumeSnapshot store and
# the room hot-tail cursor under ONE snapshot+proven-suffix law ·
# scale/encode/switch-class/context-benefit receipts are written by the
# MANUAL bench drivers (bench-resume.ts · inventory-*.ts); the corpus itself
# is never committed — its identity is digest-pinned by
# prove-transition-g07-corpus.ts.
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

cd "$(dirname "$0")/../.." || exit 1
bun="${BUN:-$HOME/.bun/bin/bun}"

failed=0
shopt -s nullglob
for f in scripts/model-transition/prove-*.ts; do
  echo "── model-transition: $(basename "$f")"
  __t=$SECONDS; if ! "$bun" "$f"; then
    failed=1
  fi
  prover_mark "$f" "$__t"
done

exit "$failed"
