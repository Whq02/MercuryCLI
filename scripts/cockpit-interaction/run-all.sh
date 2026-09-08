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
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

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
  __t=$SECONDS; __rc=0; if ! { "$bun" run "$proof"; __rc=$?; [ "$__rc" -eq 0 ]; }; then
    fail=1
  fi
  prover_mark "$proof" "$__t" "$__rc"
done

exit "$fail"
