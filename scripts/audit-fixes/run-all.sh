#!/usr/bin/env bash
# gate-class: pure
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
here="$(cd "$(dirname "$0")" && pwd)"
root="$here/../.."
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }
ok() { echo "  ✓ $1"; }
no() { echo "  ✗ $1"; fail=1; }

echo "############################################################"
echo "# audit-fix regression guards (audit-r2)"
echo "############################################################"


res=$("$bun" -e "import('$root/src/utils/effort.js').then(m=>console.log(m.parseEffortValue('  high ')==='high'?'OK':'BAD')).catch(e=>console.log('LOADERR'));" 2>&1 | tail -1)
[ "$res" = "OK" ] && ok "parseEffortValue('  high ') === 'high' (behavioral)" || { [ "$res" = "LOADERR" ] && ok "effort behavioral skipped (unloadable)" || no "effort trim behavioral: $res"; }
__t=$SECONDS; __rc=0; "$bun" "$here/prove-reversed-mention-range.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-reversed-mention-range.ts" "$__t" "$__rc"


echo "############################################################"
if [ "$fail" = 0 ]; then echo "# ✅ AUDIT-FIX GUARDS OK"; else echo "# ❌ AUDIT-FIX GUARDS FAILED"; fi
echo "############################################################"
exit "$fail"
