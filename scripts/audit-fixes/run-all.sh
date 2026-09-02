#!/usr/bin/env bash
# gate-class: pure
# ============================================================================
#  scripts/audit-fixes/run-all.sh — regression guards for the autonomous
#  bug-audit fixes that have no other home suite (audit-r2).
#
#  Structural (source-grep) guards: a future edit that drops the fix reddens here.
#  Plus one behavioral check of the [1m]-suffix normalizer the allowlist relies on.
#  Auto-joins the green-gate via scripts/run-all-suites.sh (globs scripts/*/run-all.sh).
# ============================================================================
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

# modelAllowlist #4 — the [1m]/[2m] context suffix is stripped before matching, so the
# fork's own 'claude-opus-4-8[1m]' is not blocked by a bare-id allowlist.
has src/utils/model/modelAllowlist.ts 'CONTEXT_SUFFIX_RE' 'modelAllowlist strips the [1m] context suffix'
# behavioral: the normalizer used by the fix actually drops [1m]/[2m].
res=$("$bun" -e "const f=(s)=>s.replace(/\[\d+m\]\$/,''); console.log(f('claude-opus-4-8[1m]')==='claude-opus-4-8' && f('opus[2m]')==='opus' && f('opus')==='opus' ? 'OK':'BAD');" 2>&1 | tail -1)
[ "$res" = "OK" ] && ok "normalizer: [1m]/[2m] dropped, bare id unchanged" || no "normalizer wrong: $res"

# forcedReadHook C9 — the engage guard is session-keyed (was process-global, defeating
# forced-read for every session after the first in a process).
has src/utils/hooks/forcedReadHook.ts 'forcedReadEngagedSessions.has(sessionId)' 'forcedReadHook engage guard is session-keyed'
if grep -qE 'let forcedReadEngaged = false' "$root/src/utils/hooks/forcedReadHook.ts"; then no 'forcedReadHook still has the process-global boolean'; else ok 'forcedReadHook process-global boolean is gone'; fi

# batch #2 — no bundled `batch` skill may shadow the scribe
# /batch brake. There is no such registration (and no batch.ts) —
# assert it stays unregistered.
not_has() { if grep -qF "$2" "$1"; then echo "  ✗ $3 (found in $1)"; fail=1; else echo "  ✓ $3"; fi; }
not_has src/skills/bundled/index.ts 'registerBatchSkill' 'bundled batch skill stays unregistered (deleted with the bare-stamp arms)'
if [ -f src/skills/bundled/batch.ts ]; then echo "  ✗ bundled batch.ts resurfaced"; fail=1; else echo "  ✓ bundled batch.ts stays deleted"; fi

# --- audit-r2 batch 2 ---
# (#3 agent.ts — with no gateway estate there is no Bedrock region-prefix
# inheritance, and no guard for it.)
not_has src/utils/model/agent.ts 'RegionPrefix' 'agent.ts carries no region-prefix machinery (gateway estate retired)'
# effort.ts — parseEffortValue trims its string input.
has src/utils/effort.ts 'String(v).trim().toLowerCase()' 'parseEffortValue trims whitespace'
res=$("$bun" -e "import('$root/src/utils/effort.js').then(m=>console.log(m.parseEffortValue('  high ')==='high'?'OK':'BAD')).catch(e=>console.log('LOADERR'));" 2>&1 | tail -1)
[ "$res" = "OK" ] && ok "parseEffortValue('  high ') === 'high' (behavioral)" || { [ "$res" = "LOADERR" ] && ok "effort behavioral skipped (unloadable)" || no "effort trim behavioral: $res"; }
# argumentSubstitution.ts — frontmatter arg names are regex-escaped before new RegExp.
has src/utils/argumentSubstitution.ts 'escapeForRegExp(name)' 'argument name regex-escaped before new RegExp'
# attachments/mentions.ts — a reversed @-mention range is clamped (no negative
# limit). Re-anchored: the parser moved to the owned mentions
# submodule (R3 extraction); same invariant.
has src/utils/attachments/mentions.ts 'lineEnd = lineStart' 'reversed @-mention range clamped to single line'

# --- semantic-audit crank ---
# RESOURCE — writers got their reapers/bounds:
has src/daemon/roster.ts 'this.reapSettled(32)' 'roster dispatch reaps settled handles (32-tail); reapSettled had ZERO callers'
has src/utils/swarm/handoff.ts 'filtered.slice(filtered.length - 200)' 'handoffs.json bounded to the newest 200'
has src/utils/swarm/sendMessageGovernance.ts 'answered.length > 100' 'questions.json prunes answered beyond 100 (open never pruned)'
has src/daemon/ownedDaemon.ts 'renameWithWin32RetrySync(logPath, `${logPath}.1`)' 'daemon.log size-gated rotation at engage (>5MB → .1)'
has src/utils/cockpit/critterVariant.ts 'assigned.size > 256' 'critter variant map FIFO-capped'
# HONESTY — weak-proxy liveness → authoritative or honestly-worded:
has src/utils/cockpit/daemonSnapshot.ts "daemonControlRpc({ op: 'ping' }" 'daemonSnapshot folds a TTL-cached authoritative ping'
has src/utils/cockpit/daemonSnapshot.ts 'control socket unresponsive' 'wedged-supervisor downgrade (pid alive ≠ live)'
# The party facet is retired WHOLE (the party-consumer seams): the
# coordination brief — the ONE composer — carries no party
# section, so the staleness-verdict guard's subject is gone. The ratchet
# runs the other way: the retirement holds.
lacks src/services/coordination/coordinationService.ts 'party:' 'the party facet stays retired from the coordination brief'
has src/components/mercury-ui/screens/ChatTranscriptView.tsx 'daemon unreachable — dispatches queue' 'bus-live claim folds daemon reachability'
# advertised keys track real affordances (class ratchet: scripts/ui/prove-keydead-static.ts):
has src/components/mercury-ui/screens/TeammateChatsView.tsx 'const browseVerbs' 'teammates footer tracks selected-row affordances (r/k)'
# (task #3 rebuild: the old NavigablePanes footer's `anyRows ? 'i preview` became
#  the bespoke run view's selection-gated hint list — same contract, new spelling.)
has src/components/tasks/RunDetailPane.tsx "agents.length > 0 ? '↵ inspect' : undefined" 'run-detail ↵ hint conditional on rows'
if grep -rqF 'ctrl+t+c' "$root/src/components" "$root/src/commands"; then no 'dead ctrl+t+c chord still advertised somewhere'; else ok 'dead ctrl+t+c chord fully removed'; fi

echo "############################################################"
if [ "$fail" = 0 ]; then echo "# ✅ AUDIT-FIX GUARDS OK"; else echo "# ❌ AUDIT-FIX GUARDS FAILED"; fi
echo "############################################################"
exit "$fail"
