#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/utils/messages/noticeRows.ts
# gate-watch: src/types/message.ts
# gate-watch: src/services/engine-connector/**
# gate-watch: src/rows/*
# gate-watch: src/utils/health/sections/crew.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# Mercury /rewind — proof harness"
echo "############################################################"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-rewind-capture.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-rewind-capture.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-rewind-row-counts.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-rewind-row-counts.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-rewind-wire.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-rewind-wire.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-rewind-restore.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-rewind-restore.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-rewind-cockpit.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-rewind-cockpit.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/../../scripts/prompts-panel/prove-notice-free-prompts.ts" || { __rc=$?; fail=1; }; prover_mark "$here/../../scripts/prompts-panel/prove-notice-free-prompts.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-checkpoint-sweep-economy.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-checkpoint-sweep-economy.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-rewind-damaged-blob.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-rewind-damaged-blob.ts" "$__t" "$__rc"

__t=$SECONDS; __rc=0; "$bun" run "$here/prove-rewind-safety-net.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-rewind-safety-net.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-rewind-safety-frames.tsx" || { __rc=$?; fail=1; }; prover_mark "$here/prove-rewind-safety-frames.tsx" "$__t" "$__rc"

echo
if [ "$fail" -eq 0 ]; then
  echo "✅ REWIND SUITE: ALL PASS"
else
  echo "❌ REWIND SUITE: FAILURES"
fi
exit "$fail"
