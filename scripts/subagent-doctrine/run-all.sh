#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/constants/** src/tools/AgentTool/built-in/** src/tools/AgentTool/loadAgentsDir*
# gate-watch: src/tools/WorkflowTool/agentHooks*
# gate-watch: src/utils/crew/crewmatePromptAddendum*
# gate-watch: src/prompt/mercuryContract.ts
# gate-watch: src/mneme/mnemeFrontPage.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
dist="$root/dist/mercury.mjs"
fail=0
echo "############################################################"
echo "# Subagent/agent doctrine — proof harness"
echo "############################################################"

__t=$SECONDS; __rc=0; "$bun" run "$here/prove-subagent-doctrine.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-subagent-doctrine.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-crewmate-addendum.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-crewmate-addendum.ts" "$__t" "$__rc"

echo ""
echo "── dist-grep: the doctrine ships in the built product (string literals) ──"
if [ ! -f "$dist" ]; then
  echo "  [WARN] $dist not built — run 'bun run build.ts' first; skipping dist-greps"
else
  grep_ship() { # label, fixed-string
    local n; n=$(grep -Fc -- "$2" "$dist" 2>/dev/null || true)
    if [ "${n:-0}" -ge 1 ]; then echo "  [PASS] $1 (x$n)"; else echo "  [FAIL] $1 — not found in dist"; fail=1; fi
  }
  grep_ship "NORMAL subagent doctrine ships"            "one of Mercury's agents, "
  grep_ship "the seat word slots in (sub-agent)"        "a sub-agent"
  grep_ship "the clause after the seat ships"           ", spawned for one assignment, whose caller reads only the output you return"
  grep_ship "the seat word slots in (crewmate)"         "a crewmate"
  grep_ship "multipurpose workflow preamble ships"      'Mercury workflow subagent'
  grep_ship "workflow TEXT return-contract preserved"   'returned **verbatim**'
  grep_ship "workflow SCHEMA return-contract preserved" 'exactly once to return your final answer'
  grep_ship "crewmate tactical callouts ship"           'Tactical callouts (Mercury crew register)'
fi

echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL SUBAGENT-DOCTRINE PROOFS PASS"; else echo "# ❌ SOME PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
