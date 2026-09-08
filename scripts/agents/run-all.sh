#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/Tool* src/bootstrap/state* src/services/compact/compact*
# gate-watch: src/tools/AgentTool/AgentTool* src/tools/AgentTool/built-in/generalPurposeAgent*
# gate-watch: src/tools/AgentTool/builtInAgents* src/tools/TeamCreateTool/TeamCreateTool*
# gate-watch: src/tools/AgentTool/reviewerPolicy.ts src/tools/AgentTool/runAgent.ts src/tools/AgentTool/built-in/mercuryReviewerAgent.ts
# gate-watch: src/tools/TeamCreateTool/prompt* src/utils/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
root="$here/../.."
dist="$root/dist/mercury.mjs"
guide="$root/src/tools/AgentTool/built-in/mercuryGuideAgent.ts"
agentprompt="$root/src/tools/AgentTool/prompt.ts"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0

echo "############################################################"
echo "# Built-in agent identity + NEVER-Haiku"
echo "############################################################"

if [ -f "$dist" ]; then
  n=$(grep -cF "You are Mercury's product and API guide" "$dist" 2>/dev/null || true)
  if [ "$n" -ge 1 ]; then echo "  ✓ guide agent names Mercury (dist x$n)"; else echo "  ✗ guide-agent self-label missing"; fail=1; fi
else
  echo "  ✗ dist not built — run: bun run build.ts"; fail=1
fi

if grep -qF "model: 'inherit'" "$guide" && ! grep -qF "'haiku'" "$guide"; then
  echo "  ✓ guide-agent model is inherit (no haiku arm)"
else
  echo "  ✗ guide-agent model wrong or a haiku arm resurfaced"; fail=1
fi

if grep -qF "'mercury-guide'" "$guide"; then
  echo "  ✓ guide-agent slug is mercury-guide"
else
  echo "  ✗ guide-agent slug wrong"; fail=1
fi
slugres=$("$bun" -e "import('$root/src/tools/AgentTool/built-in/mercuryGuideAgent.ts').then(m=>console.log(m.MERCURY_GUIDE_AGENT_TYPE)).catch(e=>console.log('ERR',(e&&e.message)||e));" 2>&1 | tail -1)
if [ "$slugres" = "mercury-guide" ]; then
  echo "  ✓ stamp-sim resolver: the slug resolves to mercury-guide"
else
  echo "  ✗ stamp-sim slug resolution: got '$slugres'"; fail=1
fi

res=$("$bun" -e "import('$root/src/utils/model/agent.js').then(m=>{const p='claude-opus-4-8[1m]';const inh=m.getAgentModel('inherit',p);const hk=m.getAgentModel('haiku',p);const ok=!/haiku/i.test(inh)&&hk==='claude-sonnet-5';console.log(ok?'OK':'BAD',inh,'|',hk);}).catch(e=>console.log('ERR',(e&&e.message)||e));" 2>&1 | tail -1)
case "$res" in
  OK*) echo "  ✓ resolver: inherit→non-Haiku, raw-haiku→FLOORED (stamp-independent)  [$res]" ;;
  *)   echo "  ✗ resolver invariant failed: $res"; fail=1 ;;
esac

verify_str="Treat the agent's output as a claim to verify, not a fact"
trust_str="The agent's outputs should generally be trusted"
if grep -qF "$verify_str" "$agentprompt" \
   && ! grep -qF "$trust_str" "$agentprompt"; then
  echo "  ✓ agent-prompt verify-line unconditional (no blanket-trust sentence in source)"
else
  echo "  ✗ agent-prompt verify-line missing or a blanket-trust sentence present"; fail=1
fi
if [ -f "$dist" ]; then
  if grep -qF "$verify_str" "$dist"; then echo "  ✓ verify-line ships (dist)"; else echo "  ✗ verify-line absent from dist"; fail=1; fi
  if ! grep -qF "$trust_str" "$dist"; then echo "  ✓ no blanket-trust sentence in dist"; else echo "  ✗ a blanket-trust sentence ships in dist"; fail=1; fi
else
  echo "  ✗ dist not built — run: bun run build.ts"; fail=1
fi

shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo "── $(basename "$proof") ──"
  __t=$SECONDS; __rc=0; "$bun" run "$proof" || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done

echo "############################################################"
if [ "$fail" = 0 ]; then echo "# ✅ AGENTS SUITE OK"; else echo "# ❌ AGENTS SUITE FAILED"; fi
echo "############################################################"
exit "$fail"
