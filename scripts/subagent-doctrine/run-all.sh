#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/constants/** src/tools/AgentTool/built-in/** src/tools/AgentTool/loadAgentsDir*
# gate-watch: src/tools/WorkflowTool/agentHooks*
# gate-watch: src/utils/swarm/teammatePromptAddendum*
# Subagent/agent doctrine — proof harness. Non-zero exit on any fail.
# Covers: the bun proofs (doctrine layer + teammate addendum) AND dist-greps that
# confirm the shipped strings — incl. the workflow-agent prompts whose builders live
# in agentHooks.ts (a feature()-macro module not bun-loadable, so verified at the
# bundle level per the host-harness-vs-built-binary memory: string literals, not names).
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
dist="$root/dist/mercury.mjs"
fail=0
echo "############################################################"
echo "# Subagent/agent doctrine — proof harness"
echo "############################################################"

__t=$SECONDS; "$bun" run "$here/prove-subagent-doctrine.ts" || fail=1; prover_mark "$here/prove-subagent-doctrine.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-teammate-addendum.ts" || fail=1; prover_mark "$here/prove-teammate-addendum.ts" "$__t"

echo ""
echo "── dist-grep: the doctrine ships in the built product (string literals) ──"
if [ ! -f "$dist" ]; then
  echo "  [WARN] $dist not built — run 'bun run build.ts' first; skipping dist-greps"
else
  grep_ship() { # label, fixed-string
    local n; n=$(grep -Fc -- "$2" "$dist" 2>/dev/null || true)
    if [ "${n:-0}" -ge 1 ]; then echo "  [PASS] $1 (x$n)"; else echo "  [FAIL] $1 — not found in dist"; fail=1; fi
  }
  grep_ship "NORMAL subagent doctrine ships"            'subagent OF Mercury'
  grep_ship "multipurpose workflow preamble ships"      'Mercury workflow subagent'
  grep_ship "workflow TEXT return-contract preserved"   'returned **verbatim**'
  grep_ship "workflow SCHEMA return-contract preserved" 'exactly once to return your final answer'
  grep_ship "teammate tactical callouts ship"           'Tactical callouts (Mercury team register)'
fi

echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL SUBAGENT-DOCTRINE PROOFS PASS"; else echo "# ❌ SOME PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
