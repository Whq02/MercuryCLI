#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/journey/**
# gate-watch: scripts/lib/seedTranscript.ts
# gate-watch: src/utils/sessionStoragePortable*
# gate-watch: src/utils/hooks/missionHook* src/services/mission/missionCard* src/utils/sessionRestore*
# gate-watch: src/services/providers/anthropic/** src/services/providers/toolEconomy.ts src/services/api/dumpPrompts.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1
bun="${BUN:-$HOME/.bun/bin/bun}"
here="scripts/journey-11"
if [ ! -f dist/mercury.mjs ]; then
  echo "❌ journey-11: dist/mercury.mjs absent — every member boots the built bundle; build first (~/.bun/bin/bun run build.ts)"
  exit 1
fi

failed=0
while IFS= read -r name; do
  case "$name" in (''|'#'*) continue ;; esac
  f="scripts/journey/$name"
  if [ ! -e "$f" ]; then
    echo "❌ journey-11: member '$name' has no file at $f — a stale member row is a red, never a silent skip"
    failed=1
    continue
  fi
  echo "── journey-11: $name"
  __t=$SECONDS; __rc=0; if ! { "$bun" run "$f"; __rc=$?; [ "$__rc" -eq 0 ]; }; then failed=1; fi; prover_mark "$f" "$__t" "$__rc"
done < "$here/members.txt"

exit "$failed"
