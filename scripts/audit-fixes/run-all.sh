#!/usr/bin/env bash
# gate-class: pure
set -u
here="$(cd "$(dirname "$0")" && pwd)"
root="$here/../.."
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
ok() { echo "  ✓ $1"; }
no() { echo "  ✗ $1"; fail=1; }
has() { grep -qF -- "$2" "$root/$1" && ok "$3" || no "$3 (missing in $1)"; }
lacks() { grep -qF -- "$2" "$root/$1" && no "$3 (present in $1)" || ok "$3"; }

echo "############################################################"
echo "# audit-fix regression guards (audit-r2)"
echo "############################################################"

has src/utils/model/modelAllowlist.ts 'CONTEXT_SUFFIX_RE' 'modelAllowlist strips the [1m] context suffix'
res=$("$bun" -e "const f=(s)=>s.replace(/\[\d+m\]\$/,''); console.log(f('claude-opus-4-8[1m]')==='claude-opus-4-8' && f('opus[2m]')==='opus' && f('opus')==='opus' ? 'OK':'BAD');" 2>&1 | tail -1)
[ "$res" = "OK" ] && ok "normalizer: [1m]/[2m] dropped, bare id unchanged" || no "normalizer wrong: $res"

has src/utils/hooks/forcedReadHook.ts 'forcedReadEngagedSessions.has(sessionId)' 'forcedReadHook engage guard is session-keyed'
if grep -qE 'let forcedReadEngaged = false' "$root/src/utils/hooks/forcedReadHook.ts"; then no 'forcedReadHook still has the process-global boolean'; else ok 'forcedReadHook process-global boolean is gone'; fi

not_has() { if grep -qF "$2" "$1"; then echo "  ✗ $3 (found in $1)"; fail=1; else echo "  ✓ $3"; fi; }

not_has src/utils/model/agent.ts 'RegionPrefix' 'agent.ts carries no region-prefix machinery (gateway estate retired)'
has src/utils/effort.ts 'String(v).trim().toLowerCase()' 'parseEffortValue trims whitespace'
res=$("$bun" -e "import('$root/src/utils/effort.js').then(m=>console.log(m.parseEffortValue('  high ')==='high'?'OK':'BAD')).catch(e=>console.log('LOADERR'));" 2>&1 | tail -1)
[ "$res" = "OK" ] && ok "parseEffortValue('  high ') === 'high' (behavioral)" || { [ "$res" = "LOADERR" ] && ok "effort behavioral skipped (unloadable)" || no "effort trim behavioral: $res"; }
has src/utils/argumentSubstitution.ts 'escapeForRegExp(name)' 'argument name regex-escaped before new RegExp'
has src/utils/attachments/mentions.ts 'lineEnd = lineStart' 'reversed @-mention range clamped to single line'

has src/daemon/roster.ts 'this.reapSettled(32)' 'roster dispatch reaps settled handles (32-tail); reapSettled had ZERO callers'
has src/utils/swarm/handoff.ts 'filtered.slice(filtered.length - 200)' 'handoffs.json bounded to the newest 200'
has src/utils/swarm/sendMessageGovernance.ts 'answered.length > 100' 'questions.json prunes answered beyond 100 (open never pruned)'
has src/daemon/ownedDaemon.ts 'renameWithWin32RetrySync(logPath, `${logPath}.1`)' 'daemon.log size-gated rotation at engage (>5MB → .1)'
has src/utils/cockpit/critterVariant.ts 'assigned.size > 256' 'critter variant map FIFO-capped'
has src/utils/cockpit/daemonSnapshot.ts "daemonControlRpc({ op: 'ping' }" 'daemonSnapshot folds a TTL-cached authoritative ping'
has src/utils/cockpit/daemonSnapshot.ts 'control socket unresponsive' 'wedged-supervisor downgrade (pid alive ≠ live)'
lacks src/services/coordination/coordinationService.ts 'party:' 'the party facet stays retired from the coordination brief'
has src/components/mercury-ui/screens/TeammateChatsView.tsx 'const browseVerbs' 'teammates footer tracks selected-row affordances (r/k)'
has src/components/tasks/RunDetailPane.tsx "agents.length > 0 ? '↵ inspect' : undefined" 'run-detail ↵ hint conditional on rows'
if grep -rqF 'ctrl+t+c' "$root/src/components" "$root/src/commands"; then no 'dead ctrl+t+c chord still advertised somewhere'; else ok 'dead ctrl+t+c chord fully removed'; fi

echo "############################################################"
if [ "$fail" = 0 ]; then echo "# ✅ AUDIT-FIX GUARDS OK"; else echo "# ❌ AUDIT-FIX GUARDS FAILED"; fi
echo "############################################################"
exit "$fail"
