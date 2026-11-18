#!/usr/bin/env bash
# gate-class: pure
# gate-watch: scripts/lib/seedTranscript.ts
# gate-watch: src/services/run/** src/services/workbench/** src/services/mission/** src/commands/run/** src/commands/diff/** src/commands/tasks/** src/components/prompts-panel/** src/screens/Chat.tsx
# gate-watch: scripts/lib/captureDriver.ts scripts/ui/vshot.py src/bootstrap/state.ts
# gate-watch: src/substrate/sourceState.ts src/utils/artifacts/reviewStore.ts
# gate-watch: src/guards/runStopAdapter.ts src/utils/sessionStoragePortable.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-current-work.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-current-work.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-delivery-artifact.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-delivery-artifact.ts" "$__t" "$__rc"
exit $fail
