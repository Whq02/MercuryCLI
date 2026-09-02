#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/bootstrap/state* src/commands/kill/**
# gate-watch: src/components/messages/nullRenderingAttachments* src/constants/** src/daemon/**
# gate-watch: src/hooks/useAgentStateClassifier* src/memdir/experienceCards*
# gate-watch: src/services/agentStateClassifier* src/services/agentStateHeuristic*
# gate-watch: src/services/analytics/config* src/services/compact/microCompactDigest*
# gate-watch: src/services/compact/verbatimTail* src/services/mcp/**
# gate-watch: src/utils/secrets/secretScanner* src/substrate/**
# gate-watch: src/tools/FileEditTool/constants* src/tools/FileReadTool/prompt*
# gate-watch: src/tools/FileWriteTool/prompt* src/tools/NotebookEditTool/constants*
# gate-watch: src/tools/ScheduleCronTool/prompt* src/tools/ToolSearchTool/prompt*
# gate-watch: src/tools/WorkflowTool/** src/tools/shared/spawnMultiAgent* src/utils/**
# Mercury substrate — wire-live proof harness. Non-zero exit on any fail.
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# Mercury substrate — wire-live proof harness"
echo "############################################################"
__t=$SECONDS; "$bun" run "$here/prove-git-cache-coldread.ts" || fail=1; prover_mark "$here/prove-git-cache-coldread.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-filestore.ts" || fail=1; prover_mark "$here/prove-filestore.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-filestore-ordering.ts" || fail=1; prover_mark "$here/prove-filestore-ordering.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-trace-chip-states.ts" || fail=1; prover_mark "$here/prove-trace-chip-states.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-prompt-draft.ts" || fail=1; prover_mark "$here/prove-prompt-draft.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-lead-team-identity.ts" || fail=1; prover_mark "$here/prove-lead-team-identity.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-classifier-prompt.ts" || fail=1; prover_mark "$here/prove-classifier-prompt.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-filestore-subscribe.ts" || fail=1; prover_mark "$here/prove-filestore-subscribe.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-gauge-owners.ts" || fail=1; prover_mark "$here/prove-gauge-owners.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-coordination-service.ts" || fail=1; prover_mark "$here/prove-coordination-service.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-pidlock.ts" || fail=1; prover_mark "$here/prove-pidlock.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-mailbox-reaper.ts" || fail=1; prover_mark "$here/prove-mailbox-reaper.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-flag-registry.ts" || fail=1; prover_mark "$here/prove-flag-registry.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-prompt-provenance.ts" || fail=1; prover_mark "$here/prove-prompt-provenance.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-runtime-posture.ts" || fail=1; prover_mark "$here/prove-runtime-posture.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-harness-map.ts" || fail=1; prover_mark "$here/prove-harness-map.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-mcp-policy-honest.ts" || fail=1; prover_mark "$here/prove-mcp-policy-honest.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-substrate-umbrella.ts" || fail=1; prover_mark "$here/prove-substrate-umbrella.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-agent-classifier.ts" || fail=1; prover_mark "$here/prove-agent-classifier.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-trace-rotation.ts" || fail=1; prover_mark "$here/prove-trace-rotation.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-capability-kill.ts" || fail=1; prover_mark "$here/prove-capability-kill.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-kill-command.ts" || fail=1; prover_mark "$here/prove-kill-command.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-daemon-breaker.ts" || fail=1; prover_mark "$here/prove-daemon-breaker.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-feature-toggles.ts" || fail=1; prover_mark "$here/prove-feature-toggles.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-breaker-timeout.ts" || fail=1; prover_mark "$here/prove-breaker-timeout.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-mcp-policy.ts" || fail=1; prover_mark "$here/prove-mcp-policy.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-mcp-instr-delta.ts" || fail=1; prover_mark "$here/prove-mcp-instr-delta.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-coordination-server.ts" || fail=1; prover_mark "$here/prove-coordination-server.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-lease-guard.ts" || fail=1; prover_mark "$here/prove-lease-guard.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-team-roster-lock.ts" || fail=1; prover_mark "$here/prove-team-roster-lock.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-mc-digest.ts" || fail=1; prover_mark "$here/prove-mc-digest.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-fgts-carve.ts" || fail=1; prover_mark "$here/prove-fgts-carve.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-glob-env-toggles.ts" || fail=1; prover_mark "$here/prove-glob-env-toggles.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-tool-defer-carve.ts" || fail=1; prover_mark "$here/prove-tool-defer-carve.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-verbatim-tail.ts" || fail=1; prover_mark "$here/prove-verbatim-tail.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-away-summary.ts" || fail=1; prover_mark "$here/prove-away-summary.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-cache-stability.ts" || fail=1; prover_mark "$here/prove-cache-stability.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-handoff-summary.ts" || fail=1; prover_mark "$here/prove-handoff-summary.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-artifacts-redaction.ts" || fail=1; prover_mark "$here/prove-artifacts-redaction.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-shutdown-authority.ts" || fail=1; prover_mark "$here/prove-shutdown-authority.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-compaction-trace.ts" || fail=1; prover_mark "$here/prove-compaction-trace.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-evolution-ledger.ts" || fail=1; prover_mark "$here/prove-evolution-ledger.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-daemon-snapshot.ts" || fail=1; prover_mark "$here/prove-daemon-snapshot.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-daemon-supervisor-view.ts" || fail=1; prover_mark "$here/prove-daemon-supervisor-view.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-daemon-reconcile.ts" || fail=1; prover_mark "$here/prove-daemon-reconcile.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-ledger-flush-death.ts" || fail=1; prover_mark "$here/prove-ledger-flush-death.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-pidlock-release.ts" || fail=1; prover_mark "$here/prove-pidlock-release.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-lifecycle-collector.ts" || fail=1; prover_mark "$here/prove-lifecycle-collector.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-no-telemetry-egress.ts" || fail=1; prover_mark "$here/prove-no-telemetry-egress.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-snapshot-contract.ts" || fail=1; prover_mark "$here/prove-snapshot-contract.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-wrapper.ts" || fail=1; prover_mark "$here/prove-wrapper.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-trace-once.ts" || fail=1; prover_mark "$here/prove-trace-once.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-schema-hint.ts" || fail=1; prover_mark "$here/prove-schema-hint.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-telemetry-absence.ts" || fail=1; prover_mark "$here/prove-telemetry-absence.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-identity-constants.ts" || fail=1; prover_mark "$here/prove-identity-constants.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-kill-target.ts" || fail=1; prover_mark "$here/prove-kill-target.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-presence-agent-ignored.ts" || fail=1; prover_mark "$here/prove-presence-agent-ignored.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-startup-menu.ts" || fail=1; prover_mark "$here/prove-startup-menu.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-boot-order.ts" || fail=1; prover_mark "$here/prove-boot-order.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-spawn-ledger.ts" || fail=1; prover_mark "$here/prove-spawn-ledger.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-live-e2e-hermetic.ts" || fail=1; prover_mark "$here/prove-live-e2e-hermetic.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-friction-stopwatch.ts" || fail=1; prover_mark "$here/prove-friction-stopwatch.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-health-self-recognition.ts" || fail=1; prover_mark "$here/prove-health-self-recognition.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-headless-one-shot-roster.ts" || fail=1; prover_mark "$here/prove-headless-one-shot-roster.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-bus-envelopes.ts" || fail=1; prover_mark "$here/prove-bus-envelopes.ts" "$__t"
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL SUBSTRATE PROOFS PASS"; else echo "# ❌ SOME SUBSTRATE PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
