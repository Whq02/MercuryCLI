#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/lib/seedTranscript.ts
# gate-watch: src/services/run/** src/services/workbench/** src/services/mission/** src/commands/run/** src/commands/diff/** src/commands/tasks/** src/components/prompts-panel/** src/screens/REPL.tsx
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
rm -f "${TMPDIR:-/tmp}"/momentum-report-*.json
__t=$SECONDS; "$bun" run "$here/prove-current-work.ts" || fail=1; prover_mark "$here/prove-current-work.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-delivery-artifact.ts" || fail=1; prover_mark "$here/prove-delivery-artifact.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-brief.ts" || fail=1; prover_mark "$here/prove-brief.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-parity.ts" || fail=1; prover_mark "$here/prove-parity.ts" "$__t"
"$bun" run "$here/journey-j1.ts" || fail=1
"$bun" run "$here/journey-j2.ts" || fail=1
"$bun" run "$here/journey-j3.ts" || fail=1
"$bun" run "$here/journey-j4.ts" || fail=1
"$bun" run "$here/journey-j5.ts" || fail=1
for j in J1 J2 J3 J4 J5; do
  r="${TMPDIR:-/tmp}/momentum-report-${j}.json"
  if [ ! -s "$r" ]; then
    echo "❌ ${j}: no report written this run (${r})"
    fail=1
  fi
done
exit $fail
