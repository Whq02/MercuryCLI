#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/**
# gate-watch: scripts/lib/*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1

here="$(cd "$(dirname "$0")" && pwd)"
root="$here/../.."
dist="$root/dist/mercury.mjs"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0

echo "############################################################"
echo "# Built-in roster: mercury-crew + mercury-scout; NEVER-Haiku"
echo "############################################################"

if [ -f "$dist" ]; then
  n=$(grep -cF "Mercury's crew agent, the default for delegated work" "$dist" 2>/dev/null || true)
  if [ "$n" -ge 1 ]; then echo "  ✓ mercury-crew ships naming Mercury (dist x$n)"; else echo "  ✗ mercury-crew's cue missing from dist"; fail=1; fi
  n=$(grep -cF "You are Mercury's repository scout" "$dist" 2>/dev/null || true)
  if [ "$n" -ge 1 ]; then echo "  ✓ mercury-scout ships naming Mercury (dist x$n)"; else echo "  ✗ mercury-scout's self-label missing from dist"; fail=1; fi
else
  echo "  ✗ dist not built — run: bun run build.ts"; fail=1
fi


roster=$("$bun" -e "import('$root/src/tools/crewmate/builtInAgents.ts').then(m=>console.log(m.getBuiltInAgents().map(a=>a.agentType).join(','))).catch(e=>console.log('ERR',(e&&e.message)||e));" 2>&1 | tail -1)
if [ "$roster" = "mercury-crew,mercury-scout" ]; then
  echo "  ✓ the built-in roster is mercury-crew, mercury-scout"
else
  echo "  ✗ the built-in roster reads '$roster'"; fail=1
fi

res=$("$bun" -e "import('$root/src/models/catalogue/agentModel.js').then(m=>{const p='claude-opus-4-8[1m]';const inh=m.getAgentModel('inherit',p);const hk=m.getAgentModel('haiku',p);const ok=inh===p&&/haiku/i.test(hk);console.log(ok?'OK':'BAD',inh,'|',hk);}).catch(e=>console.log('ERR',(e&&e.message)||e));" 2>&1 | tail -1)
case "$res" in
  OK*) echo "  ✓ resolver: inherit→the parent, raw-haiku→the haiku row (stamp-independent)  [$res]" ;;
  *)   echo "  ✗ resolver invariant failed: $res"; fail=1 ;;
esac

verify_str="Use memory, documentation and crewmate reports as context. Verify their material claims when accuracy or currency matters."
trust_str="The agent's outputs should generally be trusted"
if [ -f "$dist" ]; then
  if grep -qF "$verify_str" "$dist"; then echo "  ✓ verify-line ships (dist)"; else echo "  ✗ verify-line absent from dist"; fail=1; fi
  if ! grep -qF "$trust_str" "$dist"; then echo "  ✓ no blanket-trust sentence in dist"; else echo "  ✗ a blanket-trust sentence ships in dist"; fail=1; fi
else
  echo "  ✗ dist not built — run: bun run build.ts"; fail=1
fi

drive_members agents 'scripts/agents/$name' "$here/members.txt" || fail=1

echo "############################################################"
if [ "$fail" = 0 ]; then echo "# ✅ AGENTS SUITE OK"; else echo "# ❌ AGENTS SUITE FAILED"; fi
echo "############################################################"
exit "$fail"
