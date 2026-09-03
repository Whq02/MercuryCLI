#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/screens/REPL.tsx src/components/PromptInput/**
# gate-watch: src/input-core/** src/components/mercury-ui/useInteractiveList.ts
# gate-watch: src/components/mercury-ui/parity/RealmsView.tsx src/utils/promptDraft.ts
# gate-watch: src/components/InlineChangeView.tsx src/tools/StructureTool/**
# gate-watch: src/services/structure/** src/tools/LSPTool/**
# gate-watch: src/utils/Cursor.ts src/utils/inputRange.ts
# gate-watch: src/hooks/fileSuggestions.ts src/hooks/useTypeahead.tsx src/utils/suggestions/directoryCompletion.ts
# gate-watch: src/hooks/useHistorySearch.ts
# gate-watch: src/components/ScrollKeybindingHandler.tsx src/components/MercuryModelPicker.tsx
# gate-watch: src/utils/tabula/** src/components/HelmLanesRail.tsx
#
# decisive Crush interaction closure.
# Built-artifact journeys: the session-switch fence (epoch supersede +
# typing-wins) · the probe-shaped AsyncListNote action grammar · the ONE
# inline change view · chip atomicity · the polyglot symbol lane.
set -uo pipefail
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

cd "$(dirname "$0")/../.." || exit 1

BUN="${BUN:-$HOME/.bun/bin/bun}"
overall=0
for p in \
  scripts/prompt-input/prove-prompt-input-switch-fence.ts \
  scripts/prompt-input/prove-prompt-input-async-note.ts \
  scripts/prompt-input/prove-prompt-input-change-view.ts \
  scripts/prompt-input/prove-prompt-input-chip-atomicity.ts \
  scripts/prompt-input/prove-prompt-input-symbol-lane.ts \
  scripts/prompt-input/prove-prompt-input-paste-prune.ts \
  scripts/prompt-input/prove-newline-hint-latch.ts \
  scripts/prompt-input/prove-backslash-path-enter.ts \
  scripts/prompt-input/prove-suggestion-platform-and-project.ts \
  scripts/prompt-input/prove-name-anchored-enter.ts \
  scripts/prompt-input/prove-history-scan-debounce.ts \
  scripts/prompt-input/prove-typing-survives-rekey.ts \
; do
  echo "── $p"
  __t=$SECONDS; "$BUN" run "$p" || overall=1; prover_mark "$p" "$__t"
done
exit $overall
