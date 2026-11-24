#!/usr/bin/env bun
import { proofHome } from '../lib/hermetic.ts'
import { rmSync } from 'node:fs'

let failures = 0
let checks = 0
const WHERE_BY_SECTION: Record<string, string> = {
  '1': 'change scrubbedSessionEnvNotice in src/tools/kit/sessionEnvNotice.ts',
  '2': 'change shortScrubbedSessionEnvNotice or sessionEnvNoticeForResult in src/tools/kit/sessionEnvNotice.ts',
  '3': 'change the per-owner latch in sessionEnvNoticeForResult and resetSessionEnvNoticeOnCompaction in src/tools/kit/sessionEnvNotice.ts, or the owner disposal in src/engine/run-owner/ownerLifecycle.ts',
  '4': 'change the per-owner latch in sessionEnvNoticeForResult and resetSessionEnvNoticeOnCompaction in src/tools/kit/sessionEnvNotice.ts so a worktree move neither repeats nor loses the full notice',
  '5': 'change the retain rule of the session-env-notice store (sessionEnvNoticeShown) in src/tools/kit/sessionEnvNotice.ts so active-session lanes are never evicted',
}
let sectionKey = ''
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ` — ${detail ? `${detail} — ` : ''}to fix: ${WHERE_BY_SECTION[sectionKey] ?? ''}` : ''}`)
}
const section = (t: string): void => {
  sectionKey = /^§(\d+)/.exec(t)?.[1] ?? sectionKey
  console.log('\n' + '─'.repeat(72) + '\n' + t)
}

const { scrubbedSessionEnvNotice, shortScrubbedSessionEnvNotice, sessionEnvNoticeForResult, resetSessionEnvNoticeOnFold } = await import('../../src/tools/kit/sessionEnvNotice.ts')
const { getOriginalCwd, setOriginalCwd } = await import('../../src/boot/process-state/processState.ts')
const { runWithAgentContext } = await import('../../src/crew/agents/agentContext.ts')
const { disposeOwner, disposeOwnerProcesses, ownerLifecycleCounts } = await import('../../src/engine/run-owner/ownerLifecycle.ts')
const { currentOwner, processMainOwner, processOwnerForLane } = await import('../../src/engine/run-owner/resolveOwner.ts')

const MEASURED = ['MERCURY_BOOT_ENV_APPLIED', 'MERCURY_ENTRYPOINT', 'MERCURY_SAMPLES', 'MERCURY_SKIP_PERMISSIONS', 'NODE_COMPILE_CACHE']
const EXPECTED = "[session env scrubbed: MERCURY_BOOT_ENV_APPLIED, MERCURY_ENTRYPOINT, MERCURY_SAMPLES, MERCURY_SKIP_PERMISSIONS, NODE_COMPILE_CACHE — Mercury's own stamps, not the operator's; inherit_session_env: true keeps them]"

section('§1 the full notice for the five measured names is the 214-byte form')
const full = scrubbedSessionEnvNotice(MEASURED)
check('the notice is the expected text, byte for byte', full === EXPECTED, JSON.stringify(full))
check('it is 214 bytes', Buffer.byteLength(full, 'utf8') === 214, `${Buffer.byteLength(full, 'utf8')} bytes`)
check('it names every scrubbed variable in order', full.includes(MEASURED.join(', ')))
check('it still names inherit_session_env', full.includes('inherit_session_env'))
check('it says whose the values are', full.includes("Mercury's own stamps, not the operator's"))
check('it is one line', !full.includes('\n'))

section('§2 the short form and the once-per-session latch are unchanged')
check('the short later form is byte-identical to before', shortScrubbedSessionEnvNotice(['MERCURY_MODEL']) === '[session env scrubbed: MERCURY_MODEL]')
await disposeOwner(processMainOwner())
const first = sessionEnvNoticeForResult({ scrubbed: MEASURED, commandText: 'ls' })
const second = sessionEnvNoticeForResult({ scrubbed: MEASURED, commandText: 'ls' })
const third = sessionEnvNoticeForResult({ scrubbed: MEASURED, commandText: 'echo $MERCURY_SAMPLES' })
check('the first result of a session carries the full notice', first === EXPECTED, JSON.stringify(first))
check('a later result that names no stamp carries nothing', second === '')
check('a later result that names a stamp carries the short line for it alone', third === '[session env scrubbed: MERCURY_SAMPLES]', JSON.stringify(third))
check('the full notice and the short line share one opening, so a reader that strips `[session env scrubbed…]` strips both', first.startsWith('[session env scrubbed: ') && third.startsWith('[session env scrubbed: '))

section('§3 two agents and main keep independent notice latches, compaction and owner end stay scoped')
const SYNTH = ['SYNTH_STAMP_A', 'SYNTH_STAMP_B']
const SYNTH_FULL = scrubbedSessionEnvNotice(SYNTH)
const agentA = { agentType: 'subagent' as const, agentId: 'synth-agent-a' }
const agentB = { agentType: 'subagent' as const, agentId: 'synth-agent-b' }
const ownerA = processOwnerForLane(agentA.agentId)
const ownerB = processOwnerForLane(agentB.agentId)
await disposeOwner(processMainOwner())
await disposeOwner(ownerA)
await disposeOwner(ownerB)
const aFirst = runWithAgentContext(agentA, () => sessionEnvNoticeForResult({ scrubbed: SYNTH, commandText: 'ls' }))
const bFirst = runWithAgentContext(agentB, () => sessionEnvNoticeForResult({ scrubbed: SYNTH, commandText: 'ls' }))
const mFirst = sessionEnvNoticeForResult({ scrubbed: SYNTH, commandText: 'ls' })
check('agent A, agent B and main each receive the full notice once without cross-owner bleed', aFirst === SYNTH_FULL && bFirst === SYNTH_FULL && mFirst === SYNTH_FULL)
runWithAgentContext(agentA, () => resetSessionEnvNoticeOnFold())
const bAfterCompactA = runWithAgentContext(agentB, () => sessionEnvNoticeForResult({ scrubbed: SYNTH, commandText: 'ls' }))
const mAfterCompactA = sessionEnvNoticeForResult({ scrubbed: SYNTH, commandText: 'ls' })
const aAfterCompactA = runWithAgentContext(agentA, () => sessionEnvNoticeForResult({ scrubbed: SYNTH, commandText: 'ls' }))
check('compaction resets only the compacting owner latch', bAfterCompactA === '' && mAfterCompactA === '' && aAfterCompactA === SYNTH_FULL)
const countBeforeEnd = ownerLifecycleCounts().stores['session-env-notice'] ?? 0
await disposeOwnerProcesses(ownerA)
const countAfterProcessEndA = ownerLifecycleCounts().stores['session-env-notice'] ?? 0
const aAfterResumeWithoutCompact = runWithAgentContext(agentA, () => sessionEnvNoticeForResult({ scrubbed: SYNTH, commandText: 'ls' }))
const aNamedAfterResume = runWithAgentContext(agentA, () => sessionEnvNoticeForResult({ scrubbed: SYNTH, commandText: 'echo $SYNTH_STAMP_A' }))
check('ordinary completion preserves notice latch for ResumeCrewmate without compaction', countBeforeEnd === 3 && countAfterProcessEndA === 3 && aAfterResumeWithoutCompact === '' && aNamedAfterResume === '[session env scrubbed: SYNTH_STAMP_A]', JSON.stringify({ countBeforeEnd, countAfterProcessEndA, aAfterResumeWithoutCompact, aNamedAfterResume }))
await disposeOwner(ownerA)
const countAfterFullEndA = ownerLifecycleCounts().stores['session-env-notice'] ?? 0
const bAfterEndA = runWithAgentContext(agentB, () => sessionEnvNoticeForResult({ scrubbed: SYNTH, commandText: 'ls' }))
const aAfterEndA = runWithAgentContext(agentA, () => sessionEnvNoticeForResult({ scrubbed: SYNTH, commandText: 'ls' }))
check('full owner disposal releases an agent entry without disturbing siblings', countAfterFullEndA === 2 && bAfterEndA === '' && aAfterEndA === SYNTH_FULL, JSON.stringify({ countAfterFullEndA }))
await disposeOwner(ownerA)
await disposeOwner(ownerB)
await disposeOwner(processMainOwner())
check('ending all fixture owners leaves zero notice entries', (ownerLifecycleCounts().stores['session-env-notice'] ?? 0) === 0)
check('currentOwner resolves to processMainOwner outside agent context and processOwnerForLane inside', currentOwner() === processMainOwner() && runWithAgentContext(agentA, () => currentOwner()) === processOwnerForLane(agentA.agentId))

section('§4 worktree enter and exit keep notice continuity with no duplicate first notice or silent loss')
const savedOriginalCwd = getOriginalCwd()
const worktreeCwd = `${savedOriginalCwd}-worktree-synth`
try {
  await disposeOwner(processMainOwner())
  const beforeWt = sessionEnvNoticeForResult({ scrubbed: SYNTH, commandText: 'ls' })
  setOriginalCwd(worktreeCwd)
  const insideWtRepeat = sessionEnvNoticeForResult({ scrubbed: SYNTH, commandText: 'ls' })
  const insideWtShort = sessionEnvNoticeForResult({ scrubbed: SYNTH, commandText: 'echo $SYNTH_STAMP_A' })
  setOriginalCwd(savedOriginalCwd)
  const afterExitRepeat = sessionEnvNoticeForResult({ scrubbed: SYNTH, commandText: 'ls' })
  check('entering and leaving a worktree does not emit a duplicate first notice and keeps short stamps', beforeWt === SYNTH_FULL && insideWtRepeat === '' && insideWtShort === '[session env scrubbed: SYNTH_STAMP_A]' && afterExitRepeat === '')

  setOriginalCwd(worktreeCwd)
  resetSessionEnvNoticeOnFold()
  setOriginalCwd(savedOriginalCwd)
  const afterCompactAcrossExit = sessionEnvNoticeForResult({ scrubbed: SYNTH, commandText: 'ls' })
  check('compacting inside a worktree and exiting does not silently lose the post-compaction full notice', afterCompactAcrossExit === SYNTH_FULL)

  await disposeOwner(processMainOwner())
  setOriginalCwd(worktreeCwd)
  const firstInsideWt = sessionEnvNoticeForResult({ scrubbed: SYNTH, commandText: 'ls' })
  setOriginalCwd(savedOriginalCwd)
  const afterExitFromFirst = sessionEnvNoticeForResult({ scrubbed: SYNTH, commandText: 'ls' })
  check('first notice inside a worktree is not duplicated after exiting', firstInsideWt === SYNTH_FULL && afterExitFromFirst === '')

  const subBeforeWt = runWithAgentContext(agentA, () => sessionEnvNoticeForResult({ scrubbed: SYNTH, commandText: 'ls' }))
  setOriginalCwd(worktreeCwd)
  const subDuringWt = runWithAgentContext(agentA, () => sessionEnvNoticeForResult({ scrubbed: SYNTH, commandText: 'ls' }))
  await disposeOwner(processOwnerForLane(agentA.agentId))
  const countAfterSubEndInWt = ownerLifecycleCounts().stores['session-env-notice'] ?? 0
  check('subagent notice keeps continuity and disposes cleanly across a worktree move', subBeforeWt === SYNTH_FULL && subDuringWt === '' && countAfterSubEndInWt === 1, JSON.stringify({ countAfterSubEndInWt }))
} finally {
  setOriginalCwd(savedOriginalCwd)
  await disposeOwner(processOwnerForLane(agentA.agentId))
  await disposeOwner(processMainOwner())
}

section('§5 active-session resumable lanes are never evicted by the default store cap')
await disposeOwner(processMainOwner())
const liveMainFirst = sessionEnvNoticeForResult({ scrubbed: SYNTH, commandText: 'ls' })
const manyAgents = Array.from({ length: 70 }, (_, idx) => ({ agentType: 'subagent' as const, agentId: `synth-cap-agent-${idx}` }))
const allAgentsFirst = manyAgents.every(agent => runWithAgentContext(agent, () => sessionEnvNoticeForResult({ scrubbed: SYNTH, commandText: 'ls' })) === SYNTH_FULL)
const countAfterMany = ownerLifecycleCounts().stores['session-env-notice'] ?? 0
const liveMainAfterMany = sessionEnvNoticeForResult({ scrubbed: SYNTH, commandText: 'ls' })
const firstAgentAfterMany = runWithAgentContext(manyAgents[0]!, () => sessionEnvNoticeForResult({ scrubbed: SYNTH, commandText: 'ls' }))
check('70 resumable agents in the active session do not evict main or the first agent', liveMainFirst === SYNTH_FULL && allAgentsFirst && countAfterMany === 71 && liveMainAfterMany === '' && firstAgentAfterMany === '', JSON.stringify({ countAfterMany, liveMainAfterMany, firstAgentAfterMany }))
for (const agent of manyAgents) await disposeOwner(processOwnerForLane(agent.agentId))
const countAfterManyEnd = ownerLifecycleCounts().stores['session-env-notice'] ?? 0
await disposeOwner(processMainOwner())
check('disposing all agents returns store count to main only, then zero on main end', countAfterManyEnd === 1 && (ownerLifecycleCounts().stores['session-env-notice'] ?? 0) === 0, JSON.stringify({ countAfterManyEnd }))

try {
  rmSync(proofHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
} catch {
}
console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
