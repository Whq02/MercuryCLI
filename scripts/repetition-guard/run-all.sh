#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/repetition-guard/**
# gate-watch: src/services/changeTransaction/repetitionPolicy.ts
# gate-watch: src/tools/FileEditTool/** src/tools/FileWriteTool/** src/tools/ChangeSetTool/**
# gate-watch: scripts/mission-runner/live/runner.ts
# ============================================================================
#  scripts/repetition-guard/run-all.sh — truthful no-change
#  outcomes + bounded repetition recovery. Members (globbed — new proofs
#  auto-join):
#
#    prove-nochange-edit.ts        FileEdit: exact old===new stays refused ·
#                                  quote/style normalization cannot fake a
#                                  successful mutation · an identical hunk
#                                  result ⇒ ZERO writes, truthful no-change,
#                                  never "updated" · CRLF bytes untouched ·
#                                  real edits keep every current behavior
#    prove-nochange-write.ts       FileWrite: byte-identical overwrites on
#                                  non-empty AND empty files ⇒ ZERO writes,
#                                  zero notifications, never "created"/
#                                  "updated", truthful "content already
#                                  matches" · create/update lanes unchanged
#    prove-repetition-policy.ts    the ONE bounded owner-scoped repetition
#                                  policy: 1st/2nd recoverable · 3rd bounded
#                                  (model-visible error, internal outcome
#                                  stays truthful no-change) · intent/
#                                  revision/mutation resets · path + owner
#                                  isolation · bounded entries · verification
#                                  evidence never invalidated
#    prove-changeset-repetition.ts the set-level no-change joins the policy
#                                  (plan digest = serialized intent; min
#                                  member streak; replay stays out)
#    prove-runner-mining.ts        runner additive mutation-honesty
#                                  fields mined deterministically from a
#                                  synthetic transcript
#    render-nochange-cards.ts      the honest no-change result cards on the
#                                  BUILT artifact at 80 + 120 (the render law)
#
#  Deterministic throughout: fs digests + mtime write counters, no sleeps;
#  hermetic MERCURY_CONFIG_DIR/MERCURY_CHANGESET_DIR pins (the F6 law).
# ============================================================================
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# MERCURY repetition-guard — truthful no-change + bounded repetition"
echo "############################################################"
for f in "$here"/prove-*.ts "$here"/render-*.ts; do
  [ -e "$f" ] || continue
  name="$(basename "$f")"
  echo ""
  echo "== $name =="
  __t=$SECONDS; if ! "$bun" "$f"; then
    echo "RED: $name"
    fail=1
  fi
  prover_mark "$f" "$__t"
done
exit "$fail"
