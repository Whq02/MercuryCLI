#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/streaming/ptydrive.py scripts/ui/render-tui.ts scripts/ui/vshot.py
# gate-watch: src/components/mercury-ui/** src/context/overlayStack* src/ink/events/input-event*
# gate-watch: src/ink/input/input-decoder* src/ink/stringWidth*
# gate-watch: src/components/Mercury*.tsx src/components/ScrollKeybindingHandler.tsx src/components/LogSelector.tsx
# gate-watch: src/components/CritterSelect.tsx src/components/FleetMonitor.tsx src/components/BaseTextInput.tsx src/components/FullscreenLayout.tsx
# gate-watch: src/components/tabula/MinervaRoom.tsx src/components/prompts-panel/PromptsPanel.tsx src/components/tasks/RunDetailPane.tsx src/components/teams/TeamsDialog.tsx
# gate-watch: src/components/CustomSelect/use-select-navigation.ts src/components/permissions/AskUserQuestionPermissionRequest/QuestionView.tsx
# gate-watch: src/commands/console/console.tsx src/commands/effort/effort.tsx src/hooks/useTextInput.ts
# gate-watch: src/components/concourse/ConcourseRoute.tsx src/ink/session/capabilities.ts src/ink/root/screen-session.ts
# The navigation real-terminal drives. The provers LIVE in scripts/navigation/ —
# this runner executes exactly the members named in members.txt, each a
# capture that boots the built bundle in a pseudo-terminal, so the
# deterministic provers stay in the navigation suite (the release verdict)
# while these report with the drives (their wall follows the runner). The
# parent runs every prover NOT named by a sibling member list; membership
# moves only by editing member lists, and the suite-class census
# (scripts/gate/prove-suite-class-census.ts) reds any drive left behind.
set -u
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

cd "$(dirname "$0")/../.." || exit 1
bun="${BUN:-$HOME/.bun/bin/bun}"
here="scripts/navigation-drives"
if [ ! -f dist/mercury.mjs ]; then
  echo "❌ navigation-drives: dist/mercury.mjs absent — every member boots the built bundle; build first (~/.bun/bin/bun run build.ts)"
  exit 1
fi

failed=0
while IFS= read -r name; do
  case "$name" in (''|'#'*) continue ;; esac
  f="scripts/navigation/$name"
  if [ ! -e "$f" ]; then
    echo "❌ navigation-drives: member '$name' has no file at $f — a stale member row is a red, never a silent skip"
    failed=1
    continue
  fi
  echo "── navigation-drives: $name"
  __t=$SECONDS
  case "$name" in
    (*.py) /usr/bin/python3 "$f" || failed=1 ;;
    (*.sh) bash "$f" || failed=1 ;;
    (*) "$bun" "$f" || failed=1 ;;
  esac
  prover_mark "$f" "$__t"
done < "$here/members.txt"

exit "$failed"
