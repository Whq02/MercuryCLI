#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/lib/seedTranscript.ts
# gate-watch: src/utils/sessionStoragePortable*
# gate-watch: src/utils/hooks/missionHook* src/services/mission/missionCard* src/utils/sessionRestore*
# gate-watch: src/services/providers/anthropic/** src/services/providers/toolEconomy.ts src/services/api/dumpPrompts.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

cd "$(dirname "$0")/../.." || exit 1
BUN="${BUN:-$HOME/.bun/bin/bun}"
fail=0
claimed=$(cat scripts/journey-*/members.txt 2>/dev/null | grep -v '^#' | grep -v '^$')
dupes=$(printf '%s\n' "$claimed" | sort | uniq -d)
if [ -n "$dupes" ]; then
  echo "❌ journey: prover(s) named by TWO sibling member lists (a double run across shards):"
  printf '%s\n' "$dupes" | sed 's/^/    /'
  fail=1
fi

for f in scripts/journey/prove-*.ts; do
  [ -e "$f" ] || continue
  name=$(basename "$f")
  if printf '%s\n' "$claimed" | grep -qx "$name"; then
    continue
  fi
  echo "▶ $f"
  __t=$SECONDS; if ! "$BUN" run "$f"; then fail=1; fi; prover_mark "$f" "$__t"
  echo
done
if [ "$fail" -eq 0 ]; then echo "✅ JOURNEY SUITE GREEN"; else echo "❌ JOURNEY SUITE RED"; fi
exit "$fail"
