#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/lib/seedTranscript.ts scripts/identity/forbidden-file-tool.ts
# gate-watch: src/ink/** src/utils/cockpit/** src/tools/ScheduleCronTool/** src/state/** src/utils/config/** src/bootstrap/state.ts
# gate-watch: docs/TERMINAL-PROFILE.md scripts/ui/motion-menu-stills.ts
# gate-watch: src/rows/* src/runner/wire/*
# gate-watch: src/Tool.ts src/tools.ts src/commands.ts src/context.ts src/history.ts src/ink.ts
# gate-watch: src/components/** src/utils/** src/tools/** src/services/** src/cli/** src/daemon/** src/input-core/** src/tasks/** src/fabric/**
# gate-watch: src/substrate/flagRegistry.ts src/substrate/startupMenu.ts src/screens/Chat.tsx src/constants/figures.ts
# gate-watch: scripts/lib/hermetic.ts scripts/lib/rows.ts scripts/lib/scriptedTurn.ts scripts/daemon/dupline-world.ts
# gate-watch: src/components/Messages.tsx src/components/messages/TurnReceiptRow.tsx src/components/messages/ResumeRecapCard.tsx
# gate-watch: src/utils/messages.ts src/utils/messages/normalize.ts src/utils/messages/text.ts src/utils/staticRender.tsx src/services/compact/compact.ts src/types/message.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail=0
echo "── transcript-rows proofs ──"
claimed=$(cat scripts/transcript-rows-*/members.txt 2>/dev/null | grep -v '^#' | grep -v '^$')

for f in "$here"/prove-*.ts; do
  if printf '%s\n' "$claimed" | grep -qx "$(basename "$f")"; then continue; fi
  [ -e "$f" ] || continue
  __t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$f" || { __rc=$?; fail=1; }; prover_mark "$f" "$__t" "$__rc"
done
if [[ "$fail" == "0" ]]; then echo "✅ TRANSCRIPT-ROWS SUITE GREEN"; exit 0; else
  echo "❌ TRANSCRIPT-ROWS SUITE RED"; exit 1; fi
