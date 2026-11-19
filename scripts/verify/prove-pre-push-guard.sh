#!/usr/bin/env bash
set -uo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo" || exit 1
guard="scripts/verify/pre-push-guard.sh"
bun="${BUN:-$HOME/.bun/bin/bun}"

fail=0
check() {
  if [ "$2" = "0" ]; then printf '  [PASS] %s%s\n' "$1" "${3:+ — $3}"
  else printf '  [FAIL] %s%s\n' "$1" "${3:+ — $3}"; fail=1; fi
}
section() { printf '\n%s\n%s\n%s\n' "$(printf '─%.0s' {1..76})" "$1" "$(printf '─%.0s' {1..76})"; }


section '§2 — the ledger fast path decides quickly'
start=$(date +%s)
decision="$(printf '' | bash "$guard" --dry-run 2>/dev/null | awk '/^decision /{print $3}' | tail -1)"
elapsed=$(( $(date +%s) - start ))
[ -n "$decision" ]; check 'the guard reports a decision for HEAD' $? "decision=${decision:-none}"
if "$bun" run scripts/gate/ledger.ts check >/dev/null 2>&1; then
  [ "$decision" = 'verified-by-ledger' ]; check 'a ledger-covered tree takes the fast path' $? "decision=$decision"
  [ "$elapsed" -le 10 ]; check 'the fast path is cheap' $? "${elapsed}s"
else
  case "$decision" in
    verify-scratch|refused-unclassified) r=0 ;;
    *) r=1 ;;
  esac
  check 'an unrecorded tree does not claim to be verified' $r "decision=$decision"
fi


section '§6 — the operator override is explicit'
MERCURY_PREPUSH_SKIP=1 bash "$guard" </dev/null >/dev/null 2>&1
check 'the override exits clean' $?

printf '\n'
if [ "$fail" = "0" ]; then echo "✅ prove-pre-push-guard — all checks pass"; else echo "❌ prove-pre-push-guard — checks failed"; fi
exit $fail
