#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/Tool* src/bootstrap/state* src/services/compact/compact*
# gate-watch: src/tools/AgentTool/AgentTool* src/tools/AgentTool/built-in/generalPurposeAgent*
# gate-watch: src/tools/AgentTool/builtInAgents* src/tools/TeamCreateTool/TeamCreateTool*
# gate-watch: src/tools/TeamCreateTool/prompt* src/utils/**
# ============================================================================
#  scripts/agents/run-all.sh — built-in agent identity + NEVER-Haiku invariants.
#
#  #1: the guide agent self-identifies as Mercury and never labels THIS
#      product as another CLI tool. The genuine Anthropic-product references
#      (Claude Agent SDK, Claude API, provider docs) are PRESERVED — only a
#      foreign self-label is barred.
#  #2: the guide agent's model is 'inherit' (→ the parent) with no haiku arm:
#      the operator's NEVER-Haiku directive holds by construction.
#
#  Pure grep + a loadable-resolver unit test. Dist-grep requires a build first.
#  Auto-joins the green-gate via scripts/run-all-suites.sh (globs scripts/*/run-all.sh).
# ============================================================================
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

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

# #1 — the guide agent names Mercury; no foreign self-label ships.
if [ -f "$dist" ]; then
  n=$(grep -cF "You are Mercury's product and API guide" "$dist" 2>/dev/null || true)
  if [ "$n" -ge 1 ]; then echo "  ✓ guide agent names Mercury (dist x$n)"; else echo "  ✗ guide-agent self-label missing"; fail=1; fi
  self_label="Claude"" Code** (the CLI tool"
  n=$(grep -cF "$self_label" "$dist" 2>/dev/null || true)
  if [ "$n" = "0" ]; then echo "  ✓ no foreign self-label (dist x0)"; else echo "  ✗ self-contradiction self-label still ships (dist x$n)"; fail=1; fi
else
  echo "  ✗ dist not built — run: bun run build.ts"; fail=1
fi

# #2 — the guide agent model is 'inherit' unconditionally (never-Haiku holds
#      by construction).
if grep -qF "model: 'inherit'" "$guide" && ! grep -qF "'haiku'" "$guide"; then
  echo "  ✓ guide-agent model is inherit (no haiku arm)"
else
  echo "  ✗ guide-agent model wrong or a haiku arm resurfaced"; fail=1
fi

# #3 — the SLUG is 'mercury-guide' unconditionally; the ratchet holds the
#      old guide name absent from the agent module.
if grep -qF "'mercury-guide'" "$guide" && ! grep -qF "'claude-code-guide'" "$guide"; then
  echo "  ✓ guide-agent slug is mercury-guide (base name gone)"
else
  echo "  ✗ guide-agent slug wrong or the base name resurfaced"; fail=1
fi
slugres=$("$bun" -e "import('$root/src/tools/AgentTool/built-in/mercuryGuideAgent.ts').then(m=>console.log(m.MERCURY_GUIDE_AGENT_TYPE)).catch(e=>console.log('ERR',(e&&e.message)||e));" 2>&1 | tail -1)
if [ "$slugres" = "mercury-guide" ]; then
  echo "  ✓ stamp-sim resolver: the slug resolves to mercury-guide"
else
  echo "  ✗ stamp-sim slug resolution: got '$slugres'"; fail=1
fi

# #2 — the resolver invariant: 'inherit' → the (Opus) parent; a raw 'haiku' pin
#      is FLOORED to the never-Haiku fallback under ANY stamp.
res=$("$bun" -e "import('$root/src/utils/model/agent.js').then(m=>{const p='claude-opus-4-8[1m]';const inh=m.getAgentModel('inherit',p);const hk=m.getAgentModel('haiku',p);const ok=!/haiku/i.test(inh)&&hk==='claude-sonnet-5';console.log(ok?'OK':'BAD',inh,'|',hk);}).catch(e=>console.log('ERR',(e&&e.message)||e));" 2>&1 | tail -1)
case "$res" in
  OK*) echo "  ✓ resolver: inherit→non-Haiku, raw-haiku→FLOORED (stamp-independent)  [$res]" ;;
  *)   echo "  ✗ resolver invariant failed: $res"; fail=1 ;;
esac

# C3 — the Agent-tool trust→verify line is UNCONDITIONAL:
#   the model is always told to VERIFY load-bearing agent output; the retired
#   "should generally be trusted" line never ships.
verify_str="Treat the agent's output as a claim to verify, not a fact"
trust_str="The agent's outputs should generally be trusted"
if grep -qF "$verify_str" "$agentprompt" \
   && ! grep -qF "$trust_str" "$agentprompt"; then
  echo "  ✓ agent-prompt verify-line unconditional (the retired trust-line gone from source)"
else
  echo "  ✗ agent-prompt verify-line missing or the retired trust-line resurfaced"; fail=1
fi
if [ -f "$dist" ]; then
  if grep -qF "$verify_str" "$dist"; then echo "  ✓ verify-line ships (dist)"; else echo "  ✗ verify-line absent from dist"; fail=1; fi
  if ! grep -qF "$trust_str" "$dist"; then echo "  ✓ retired trust-line gone from dist"; else echo "  ✗ retired trust-line still ships in dist"; fail=1; fi
else
  echo "  ✗ dist not built — run: bun run build.ts"; fail=1
fi

# ── the proof harnesses (globbed — new prove-*.ts auto-join) ────────────────────
#  prove-teammate-parity:  ONE role resolver across every launch backend
#  prove-team-charter:     chartered, atomic TeamCreate
#  prove-runner-lifecycle: the in-process runner's lifecycle laws
#                          (core-ownership Phase 7.1)
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo "── $(basename "$proof") ──"
  __t=$SECONDS; "$bun" run "$proof" || fail=1; prover_mark "$proof" "$__t"
done

echo "############################################################"
if [ "$fail" = 0 ]; then echo "# ✅ AGENTS SUITE OK"; else echo "# ❌ AGENTS SUITE FAILED"; fi
echo "############################################################"
exit "$fail"
