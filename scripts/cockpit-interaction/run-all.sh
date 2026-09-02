#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/components/** src/keybindings/**
# gate-watch: src/utils/mercuryTokens* src/utils/helmDensity* src/utils/helmGeometry*
# gate-watch: src/utils/transcriptSearch* src/utils/cockpit/cockpitActivity*
# gate-watch: src/input-core/command-queue* src/run-core/attachment-drain*
# gate-watch: src/run-core/turn-machine* src/utils/pulse/turnPhase*
# gate-watch: src/tools/SleepTool/** src/services/providers/zai/** src/utils/router/providers/zai*
# gate-watch: src/screens/REPL* design-system/readme.md src/tools.ts src/tools/**
# gate-watch: src/services/workbench/** src/utils/artifacts/** src/commands/diff/**
# ============================================================================
#  scripts/cockpit-interaction/run-all.sh —.
#
#  Every prover here either validates the acceptance record itself or pins a
#  once-red reproducer class. The suite
#  permits no expect-red lane and no deferred rows: a reproducer lands
#  in the same commit as its fix, promoted to a standing proof.
#
#  Auto-joins scripts/run-all-suites.sh via its scripts/*/run-all.sh glob.
# ============================================================================
set -uo pipefail
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0

echo "############################################################"
echo "# cockpit-interaction — UI fluency, adaptive cockpit, platform parity"
echo "############################################################"

for proof in "$here"/prove-*.ts; do
  [ -e "$proof" ] || continue
  name="$(basename "$proof")"
  case "$name" in _*) continue ;; esac
  echo ""
  echo "── $name"
  __t=$SECONDS; if ! "$bun" run "$proof"; then
    fail=1
  fi
  prover_mark "$proof" "$__t"
done

exit "$fail"
