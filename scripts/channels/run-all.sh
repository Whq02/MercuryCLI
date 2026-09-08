#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/mcp/channelAllowlist* src/services/mcp/localChannelBus* src/utils/teammateMailbox*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# Local channel bus — proof harness"
echo "############################################################"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-channel-bus.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-channel-bus.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-scoped-markread.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-scoped-markread.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0
live_out="$(mktemp -d)"
if "$bun" "$root/scripts/search/lib/bundle-for-node.ts" "$here/prove-channel-bus-live.ts" "$live_out/prove-channel-bus-live.mjs" \
  && node "$live_out/prove-channel-bus-live.mjs"; then :; else __rc=$?; fail=1; fi
rm -rf "$live_out"
prover_mark "$here/prove-channel-bus-live.ts" "$__t" "$__rc"
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL CHANNEL PROOFS PASS"; else echo "# ❌ SOME CHANNEL PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
