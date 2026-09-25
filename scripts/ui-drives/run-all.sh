#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/components/messages/TurnReceiptRow.tsx src/components/KitMenuScreen.tsx src/services/kitMenu/** src/utils/cockpit/turnReceipt.ts src/ink/** src/services/engine-connector/daemonConnector.ts src/services/engine-connector/queuedNotices.ts src/components/Messages.tsx src/components/LiveStreamingTail.tsx src/screens/REPL.tsx
# gate-watch: src/components/StructuredDiff.tsx src/components/StructuredDiff/** src/components/StructuredDiffList.tsx src/components/FileEditToolUpdatedMessage.tsx src/native-ts/color-diff/** src/tools/FileWriteTool/UI.tsx
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1
bun="${BUN:-$HOME/.bun/bin/bun}"
here="scripts/ui-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'ui-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

failed=0
while IFS= read -r name; do
  case "$name" in (''|'#'*) continue ;; esac
  f="scripts/ui/$name"
  if [ ! -f "$f" ]; then
    printf 'ui-drives: member %s has no file at %s\n' "$name" "$f"
    failed=1
    continue
  fi
  printf '── ui-drives: %s\n' "$name"
  __t=$SECONDS; __rc=0
  "$bun" "$f" || { __rc=$?; failed=1; }
  prover_mark "$f" "$__t" "$__rc"
done < "$here/members.txt"
exit "$failed"
