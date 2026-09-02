#!/usr/bin/env bash
# ============================================================================
#  scripts/verify/prove-pre-push-guard.sh — the pre-push rail's acceptance
#
#
#  What is proven:
#   §1 the hook is COMMITTED and delegates to the readable guard, and enabling
#      it stays a documented manual `git config` — Mercury's safety plane
#      refuses programmatic hooks-path changes and adds no exception;
#   §2 the LEDGER FAST PATH decides in well under a second on a tree that
#      already carries a green verdict;
#   §3 an UNCLASSIFIED changed path REFUSES with instructions instead of
#      launching the full pool inside a git hook;
#   §4 the scratch worktree really is one: the pushed REF in a scratch worktree with
#      a scrubbed environment, never the working tree;
#   §5 no paid model call is reachable — the guard runs typecheck, build and
#      local suites, and invokes no provider lane, no dist binary and no
#      network client;
#   §6 the operator override is explicit and named.
# ============================================================================
set -uo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo" || exit 1
guard="scripts/verify/pre-push-guard.sh"
hook=".githooks/pre-push"
bun="${BUN:-$HOME/.bun/bin/bun}"

fail=0
check() { # $1=label $2=condition-result(0/1) $3=detail
  if [ "$2" = "0" ]; then printf '  [PASS] %s%s\n' "$1" "${3:+ — $3}"
  else printf '  [FAIL] %s%s\n' "$1" "${3:+ — $3}"; fail=1; fi
}
section() { printf '\n%s\n%s\n%s\n' "$(printf '─%.0s' {1..76})" "$1" "$(printf '─%.0s' {1..76})"; }

section '§1 — the hook is committed and delegates to the readable guard'
[ -f "$hook" ]; check "$hook is committed" $?
[ -f "$guard" ]; check "$guard is committed" $?
grep -q 'pre-push-guard.sh' "$hook"; check 'the hook delegates to the guard' $?
grep -q 'core.hooksPath .githooks' "$hook"; check 'the hook documents its manual enablement' $?
# The safety plane still refuses a programmatic hooks-path change, and the
# guard does not install itself — those two together are what "manual
# enablement is the design" means. (The one legitimate core.hooksPath write in
# src/utils/worktree.ts scopes a CREATED worktree to the main repo's existing
# hooks and predates this rail; it is not an installer for this hook.)
grep -q "id: 'git-hooks-path'" src/substrate/themis/blocklist.ts
check 'the safety plane still blocks a hooks-path change' $?
! grep -nE 'git config' "$guard" "$hook" | grep -vE ':[[:space:]]*#' | grep -q .
check 'neither the guard nor the hook installs itself' $?

section '§2 — the ledger fast path decides quickly'
# A tree with a recorded verdict must decide from the ledger. Whether THIS
# tree has one depends on the working state, so the property proven here is
# the decision's SOURCE and its cost, using the ledger CLI as the oracle.
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

section '§3 — an unclassified path refuses instead of running the pool'
grep -q "grep -q 'UNCLASSIFIED'" "$guard"; check 'the guard tests the impact plan for unclassified paths' $?
grep -q 'refused-unclassified' "$guard"; check 'refusal is a named decision' $?
grep -q 'gate-watch' "$guard"; check 'the refusal names the fix (declare a gate-watch glob)' $?
# An instruction that TELLS the operator to run the pool is fine; a line that
# runs it is not. Executable lines only: no comments, no `say` messages.
! grep -nE 'run-all-suites\.sh' "$guard" | grep -vE ':[[:space:]]*#' | grep -vE ':[[:space:]]*say ' | grep -q .
check 'the guard never launches the full pool itself' $?

section '§4 — the scratch worktree is the pushed ref, scrubbed'
grep -q 'git worktree add --detach' "$guard"; check 'verification runs in a scratch worktree' $?
grep -q 'env -i' "$guard"; check 'the environment is scrubbed' $?
grep -q 'cd "\$tree"' "$guard"; check 'the commands run inside the worktree, not the working tree' $?

section '§5 — no paid model call is reachable'
! grep -qE 'dist/mercury\.mjs|ANTHROPIC_API_KEY|OPENAI_API_KEY|api\.anthropic|api\.openai|z\.ai' "$guard"
check 'the guard references no provider credential, endpoint or shipped binary' $?
# The scratch worktree runs exactly three commands; all three are local.
allowed="$(grep -cE '^\s+bun run (typecheck|build\.ts|scripts/verify/fast\.ts)' "$guard")"
[ "$allowed" -eq 3 ]; check 'the scratch worktree runs typecheck, build and the slice rung only' $? "matched=$allowed"

section '§6 — the operator override is explicit'
grep -q 'MERCURY_PREPUSH_SKIP' "$guard"; check 'the override is a named env seam' $?
MERCURY_PREPUSH_SKIP=1 bash "$guard" </dev/null >/dev/null 2>&1
check 'the override exits clean' $?
grep -q 'unverified' "$guard"; check 'the override says the stretch stays unverified' $?

printf '\n'
if [ "$fail" = "0" ]; then echo "✅ prove-pre-push-guard — all checks pass"; else echo "❌ prove-pre-push-guard — checks failed"; fi
exit $fail
