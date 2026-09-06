#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/journey/**
# gate-watch: scripts/lib/seedTranscript.ts
# gate-watch: src/utils/sessionStoragePortable*
# gate-watch: src/utils/hooks/missionHook* src/services/mission/missionCard* src/utils/sessionRestore*
# gate-watch: src/services/providers/anthropic/** src/services/providers/toolEconomy.ts src/services/api/dumpPrompts.ts
set -u
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

cd "$(dirname "$0")/../.." || exit 1
bun="${BUN:-$HOME/.bun/bin/bun}"
here="scripts/journey-6"
if [ ! -f dist/mercury.mjs ]; then
  echo "❌ journey-6: dist/mercury.mjs absent — every member boots the built bundle; build first (~/.bun/bin/bun run build.ts)"
  exit 1
fi

failed=0
while IFS= read -r name; do
  case "$name" in (''|'#'*) continue ;; esac
  f="scripts/journey/$name"
  if [ ! -e "$f" ]; then
    echo "❌ journey-6: member '$name' has no file at $f — a stale member row is a red, never a silent skip"
    failed=1
    continue
  fi
  echo "── journey-6: $name"
  __t=$SECONDS; if ! "$bun" run "$f"; then failed=1; fi; prover_mark "$f" "$__t"
done < "$here/members.txt"

exit "$failed"
