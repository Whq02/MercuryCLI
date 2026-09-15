#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'speedster-progress-home-'))

const {
  actionFingerprint,
  emptyProgressState,
  foldEligibleProgress,
  foldStopDecision,
} = await import('../../src/services/run/progressModel.ts')
const kernel = await import('../../src/services/run/runKernel.ts')
const ok = await import('../../src/services/run/ownerKey.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const src = (p: string): string => readFileSync(join(import.meta.dir, '../../', p), 'utf8')

section('§1 THE ACTION DIGEST — case and whitespace never mint novelty')
{
  check('the same words in another case and spacing digest alike', actionFingerprint('Work the  Open Deliverable') === actionFingerprint('work the open deliverable'))
  check('different words digest apart', actionFingerprint('work the open deliverable') !== actionFingerprint('run the verification'))
  check('the digest is the sixteen-hex prefix', /^[0-9a-f]{16}$/.test(actionFingerprint('x')))
}

section('§2 FOLD LAWS — real-event progress; the since-decision window')
{
  let s = emptyProgressState()
  check('the empty state opens with a zero window', s.progressSinceDecision === 0)
  s = foldEligibleProgress(s)
  s = foldEligibleProgress(s)
  check('eligible progress moves the window ONLY through the eligible-progress fold', s.progressSinceDecision === 2)
  s = foldStopDecision(s)
  check('a stop decision closes the window', s.progressSinceDecision === 0)
  check('the state carries no attempt ledger, no phase and no barren counters', Object.keys(s).join(',') === 'progressSinceDecision', Object.keys(s).join(','))
}

section('§3 KERNEL INTEGRATION — the snapshot carries the progress window end to end')
{
  const owner = ok.makeOwnerKey({ workspace: '/tmp/progress', sessionId: 'p1', lane: 'main' })
  const empty = kernel.emptyRunSnapshot({ runId: 'r1', owner, objective: 'ship it', rootMessageId: 'u1', at: 1 })
  check("emptyRunSnapshot mints the progress field (C12's flip)", 'progress' in empty && empty.progress?.progressSinceDecision === 0)

  let snap = kernel.reduceRunEvent(empty, { type: 'substantive', at: 2, reason: 'work' })
  snap = kernel.reduceRunEvent(snap, {
    type: 'tool-effected', at: 4, toolName: 'Write', toolUseId: 't1', operation: 'write', outcome: 'succeeded', changedPaths: ['/tmp/progress/out.md'],
  })
  check('a PERSISTED artifact delta is eligible progress', snap.progress?.progressSinceDecision === 1)
  snap = kernel.reduceRunEvent(snap, { type: 'evidence', at: 5, state: 'verified', detail: 'suite green' })
  check('a verification result is eligible progress', snap.progress?.progressSinceDecision === 2)
  snap = kernel.reduceRunEvent(snap, { type: 'task-transition', at: 6, taskId: 'd1', title: 'deliver', state: 'done' })
  check('a task completing is eligible progress', snap.progress?.progressSinceDecision === 3)
  snap = kernel.reduceRunEvent(snap, { type: 'stop-decision', at: 7, decision: 'complete', detail: 'objective met' })
  check('a stop decision closes the since-decision window', snap.progress?.progressSinceDecision === 0)
  snap = kernel.reduceRunEvent(snap, { type: 'completed', at: 8, satisfied: ['done'] })
  check('a terminal lifecycle keeps the window as it was', snap.lifecycle === 'completed' && snap.progress?.progressSinceDecision === 0)

  let s2 = kernel.reduceRunEvent(empty, { type: 'substantive', at: 2, reason: 'work' })
  s2 = kernel.reduceRunEvent(s2, {
    type: 'tool-effected', at: 3, toolName: 'Write', toolUseId: 'x', operation: 'write', outcome: 'failed', changedPaths: [],
  })
  check('a failed effect never counts as progress', s2.progress?.progressSinceDecision === 0)
  let s3 = kernel.reduceRunEvent(empty, { type: 'substantive', at: 2, reason: 'work' })
  for (let i = 0; i < 12; i++) {
    s3 = kernel.reduceRunEvent(s3, { type: 'tool-started', at: 10 + i, toolName: 'Read', toolUseId: `r${i}` })
    s3 = kernel.reduceRunEvent(s3, { type: 'tool-effected', at: 11 + i, toolName: 'Read', toolUseId: `r${i}`, operation: 'read', outcome: 'no-change', changedPaths: [] })
  }
  check('twelve repeated reads of one path leave the snapshot without a repeat count of any kind', JSON.stringify(s3.progress) === JSON.stringify({ progressSinceDecision: 0 }) && !JSON.stringify(s3).includes('barren'), JSON.stringify(s3.progress))

  const legacy = { ...empty } as Record<string, unknown>
  delete legacy.progress
  const rehydrated = kernel.reduceRunEvent(legacy as never, { type: 'substantive', at: 9, reason: 'legacy' })
  check('a pre-2.1 snapshot re-mints progress on its next fold', rehydrated.progress?.progressSinceDecision === 0)
}

section('§4 SS-21 — owners never cross-renew')
{
  const a = kernel.emptyRunSnapshot({ runId: 'ra', owner: ok.makeOwnerKey({ workspace: '/tmp/wa', sessionId: 'sa', lane: 'main' }), objective: 'A', rootMessageId: null, at: 1 })
  const b = kernel.emptyRunSnapshot({ runId: 'rb', owner: ok.makeOwnerKey({ workspace: '/tmp/wb', sessionId: 'sb', lane: 'agent:1' }), objective: 'B', rootMessageId: null, at: 1 })
  const effA = kernel.reduceRunEvent(a, { type: 'tool-effected', at: 3, toolName: 'Write', toolUseId: 'a1', operation: 'write', outcome: 'succeeded', changedPaths: ['/tmp/wa/f'] })
  check("owner A's progress never appears on owner B (scope isolation by construction)", effA.progress?.progressSinceDecision === 1 && b.progress?.progressSinceDecision === 0)
}

section('§5 SS-22 — the sidecar round-trips the progress window')
{
  const owner = ok.makeOwnerKey({ workspace: '/tmp/progress-sidecar', sessionId: '00000000-0000-4000-8000-00000000c001', lane: 'main' })
  const sidecar = await import('../../src/services/run/runSidecar.ts')
  let snap = kernel.emptyRunSnapshot({ runId: 'rs', owner, objective: 'persist me', rootMessageId: null, at: 1 })
  snap = kernel.reduceRunEvent(snap, { type: 'tool-effected', at: 3, toolName: 'Write', toolUseId: 's1', operation: 'write', outcome: 'succeeded', changedPaths: ['/tmp/progress-sidecar/x'] })
  await sidecar.saveRunSidecar(owner, snap)
  const loaded = await sidecar.loadRunSidecar(owner)
  check(
    'publish → load preserves the progress window (compaction/resume/restart durability)',
    loaded.state === 'loaded' && loaded.snapshot.progress?.progressSinceDecision === 1,
    loaded.state,
  )
}

section('§6 the invocation contract resolves ONCE and threads to the decision')
{
  const { resolveInvocationContract } = await import('../../src/services/run/invocationContract.ts')
  const t = (facts: Parameters<typeof resolveInvocationContract>[0]) => resolveInvocationContract(facts)
  check('interactive ⇒ operator-led', JSON.stringify(t({ interactive: true, missionArmed: false })) === JSON.stringify({ surface: 'interactive', terminalPolicy: 'operator-led' }))
  check('interactive + mission ⇒ mission-led', t({ interactive: true, missionArmed: true }).terminalPolicy === 'mission-led')
  check('plain print ⇒ ONE-SHOT (the BM-01 law)', JSON.stringify(t({ interactive: false, missionArmed: false })) === JSON.stringify({ surface: 'print', terminalPolicy: 'one-shot' }))
  check('print + declared mission ⇒ mission-led (never one-shot)', t({ interactive: false, missionArmed: true }).terminalPolicy === 'mission-led')
  check('sdk ⇒ client-led', t({ interactive: false, missionArmed: false, querySource: 'sdk' }).terminalPolicy === 'client-led')
  check('agent lanes ⇒ worker one-shot', JSON.stringify(t({ interactive: false, missionArmed: false, querySource: 'agent:7' })) === JSON.stringify({ surface: 'worker', terminalPolicy: 'one-shot' }))

  const adapter = src('src/utils/hooks/runStopAdapter.ts')
  check('the adapter resolves the contract at the evaluation seam', adapter.includes('resolveInvocationContract({'))
  check('…and threads surface + terminalPolicy into evaluateStop', adapter.includes('surface: contract.surface') && adapter.includes('terminalPolicy: contract.terminalPolicy'))
  check('the adapter records the continuation reason as the evaluator gave it, with no admission receipt', adapter.includes("noteRunEvent(owner, { type: 'continuation', at, reason: decision.reason })") && !adapter.includes('admission'))

  const evaluator = src('src/services/run/completionEvaluator.ts')
  check('the budget fuse is progress-aware (S2/C9), never progress-blind', evaluator.includes('progressSinceDecision') && evaluator.includes('freshProgress'))
  check('the evaluator knows no strategy flag, no revision tuple and no re-plan', !/strategyRepeated|priorAdmission|runRevision|REPLAN/.test(evaluator))
}

section('§7 one continuation per attempt across families; wording demoted; drains batch')
{
  const latch = await import('../../src/services/run/continuationLatch.ts')
  latch._resetContinuationLatchesForTesting()
  const mission = await import('../../src/utils/hooks/missionHook.ts')
  type AppStateish = { sessionHooks: Map<string, unknown> }
  const state: AppStateish = { sessionHooks: new Map() }
  const setAppState = (updater: (prev: AppStateish) => AppStateish): void => {
    const next = updater(state)
    state.sessionHooks = next.sessionHooks
  }
  mission.setActiveMission(setAppState as never, 'a mission that is not yet met', { sessionId: 'latch-arb' })
  type StopCb = (m: unknown[]) => boolean | Promise<boolean>
  type HookStore = { hooks: Record<string, Array<{ hooks: Array<{ hook: { callback: StopCb } }> }>> }
  const hooks = (state.sessionHooks.get('latch-arb') as HookStore | undefined)?.hooks['Stop'] ?? []
  const cb = hooks[0]?.hooks[0]?.hook.callback
  const transcript = [
    { type: 'user', message: { content: 'go' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } },
  ]
  const first = cb ? await cb(transcript) : null
  const second = cb ? await cb(transcript) : null
  check('the mission BLOCKS once per stop attempt (the claim)', first === false)
  check('a second claimant on the SAME attempt defers (one continuation per attempt across families)', second === true)
  const grown = [...transcript, { type: 'assistant', message: { content: [{ type: 'text', text: 'try again' }] } }]
  const third = cb ? await cb(grown) : null
  check('a NEW attempt (grown transcript) re-arms the claim', third === false)
  latch._resetContinuationLatchesForTesting()
  check('the latch keeps no admission record', !src('src/services/run/continuationLatch.ts').includes('Admission'))

  const { evaluateStop } = await import('../../src/services/run/completionEvaluator.ts')
  const settled = kernel.reduceRunEvent(
    kernel.reduceRunEvent(
      kernel.emptyRunSnapshot({ runId: 'w1', owner: ok.makeOwnerKey({ workspace: '/tmp/w', sessionId: 'w', lane: 'main' }), objective: 'one write', rootMessageId: null, at: 1 }),
      { type: 'substantive', at: 2, reason: 'work' },
    ),
    { type: 'tool-effected', at: 3, toolName: 'Write', toolUseId: 'w1', operation: 'write', outcome: 'succeeded', changedPaths: ['/tmp/w/x'] },
  )
  const worded = evaluateStop({
    snapshot: settled, wordingUnfinished: true, continuationsThisTurn: 0, maxContinuationsPerTurn: 3,
    aborted: false, apiError: false, verification: null, pendingIdeFeedback: false,
    surface: 'print', terminalPolicy: 'one-shot',
  } as never)
  check('SS-25/29: wording never overrules a typed one-shot terminal', worded.kind === 'complete', worded.kind)

  const turnMachine = src('src/run-core/turn-machine.ts')
  check(
    'BM-02 coalesce: the drain snapshot folds into ONE attachment production (single call window)',
    turnMachine.includes('getDrainableCommands(sleepRan)') && turnMachine.includes('queuedCommandsSnapshot,'),
  )
}

section('§8 ONE persistence law, spliced at every surface (SS-08/10/11)')
{
  const { PERSISTENCE_LAW, MERCURY_DOCTRINE } = await import(
    '../../src/prompt/mercuryContract.ts'
  )
  check('the law suggests and never counts (keep going while evidence advances · when a road stalls, take another · the blocked ask names what changed, what was tried, what blocks, the smallest input)',
    /Keep going while evidence advances/.test(PERSISTENCE_LAW) && /when a road stalls, take another/.test(PERSISTENCE_LAW) && /smallest input you need/.test(PERSISTENCE_LAW) && !/strategy once|stop looping|handoff|strateg/.test(PERSISTENCE_LAW))
  check('the sufficiency clause on verification loops stays', /sufficiency, not exhaustion/.test(PERSISTENCE_LAW))
  check('the doctrine (native surface) carries the law VERBATIM', MERCURY_DOCTRINE.includes(PERSISTENCE_LAW))
  const doctrineSrc = src('src/constants/subagentDoctrine.ts')
  check('the subagent doctrine splices the law in its one register', (doctrineSrc.match(/\$\{PERSISTENCE_LAW\}/g) ?? []).length === 1)
  const contract = src('src/prompt/mercuryContract.ts')
  check('exactly ONE law definition exists (SS-11: one canonical owner)', (contract.match(/export const PERSISTENCE_LAW/g) ?? []).length === 1)
  check('the retired GPT overlay is GONE (one content for every family)', !contract.includes('agentic_persistence'))
}

rmSync(process.env.MERCURY_CONFIG_DIR!, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-progress-model: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-progress-model: all green')
