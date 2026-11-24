#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'speedster-progress-home-'))

const {
  actionFingerprint,
  emptyProgressState,
  foldEligibleProgress,
  foldStopDecision,
} = await import('../../src/engine/run/progressModel.ts')
const kernel = await import('../../src/engine/run/runKernel.ts')
const ok = await import('../../src/engine/run-owner/ownerKey.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

section('§1 THE ACTION DIGEST — case and whitespace never mint novelty')
{
  check('the same words in another case and spacing digest alike', actionFingerprint('Work the  Open Deliverable') === actionFingerprint('work the open deliverable'), 'actionFingerprint in src/engine/run/progressModel.ts must lowercase and collapse whitespace before it digests')
  check('different words digest apart', actionFingerprint('work the open deliverable') !== actionFingerprint('run the verification'), 'actionFingerprint in src/engine/run/progressModel.ts must digest different words to different values')
  check('the digest is the sixteen-hex prefix', /^[0-9a-f]{16}$/.test(actionFingerprint('x')), `got ${actionFingerprint('x')}; actionFingerprint in src/engine/run/progressModel.ts must return a 16 character lowercase hex prefix`)
}

section('§2 FOLD LAWS — real-event progress; the since-decision window')
{
  let s = emptyProgressState()
  check('the empty state opens with a zero window', s.progressSinceDecision === 0, 'emptyProgressState in src/engine/run/progressModel.ts must start progressSinceDecision at 0')
  s = foldEligibleProgress(s)
  s = foldEligibleProgress(s)
  check('eligible progress moves the window ONLY through the eligible-progress fold', s.progressSinceDecision === 2, `got ${s.progressSinceDecision}; foldEligibleProgress in src/engine/run/progressModel.ts must add one to progressSinceDecision per call`)
  s = foldStopDecision(s)
  check('a stop decision closes the window', s.progressSinceDecision === 0, `got ${s.progressSinceDecision}; foldStopDecision in src/engine/run/progressModel.ts must reset progressSinceDecision to 0`)
  check('the state carries no attempt ledger, no phase and no barren counters', Object.keys(s).join(',') === 'progressSinceDecision', Object.keys(s).join(','))
}

section('§3 KERNEL INTEGRATION — the snapshot carries the progress window end to end')
{
  const owner = ok.makeOwnerKey({ workspace: '/tmp/progress', sessionId: 'p1', lane: 'main' })
  const empty = kernel.emptyRunSnapshot({ runId: 'r1', owner, objective: 'ship it', rootMessageId: 'u1', at: 1 })
  check("emptyRunSnapshot mints the progress field (C12's flip)", 'progress' in empty && empty.progress?.progressSinceDecision === 0, `got ${JSON.stringify(empty.progress)}; emptyRunSnapshot in src/engine/run/runKernel.ts must set progress from emptyProgressState`)

  let snap = kernel.reduceRunEvent(empty, { type: 'substantive', at: 2, reason: 'work' })
  snap = kernel.reduceRunEvent(snap, {
    type: 'tool-effected', at: 4, toolName: 'Write', toolUseId: 't1', operation: 'write', outcome: 'succeeded', changedPaths: ['/tmp/progress/out.md'],
  })
  check('a PERSISTED artifact delta is eligible progress', snap.progress?.progressSinceDecision === 1, `got ${JSON.stringify(snap.progress)}; reduceRunEvent in src/engine/run/runKernel.ts must fold eligible progress on a succeeded tool-effected event with changedPaths`)
  snap = kernel.reduceRunEvent(snap, { type: 'evidence', at: 5, state: 'verified', detail: 'suite green' })
  check('a verification result is eligible progress', snap.progress?.progressSinceDecision === 2, `got ${JSON.stringify(snap.progress)}; reduceRunEvent in src/engine/run/runKernel.ts must fold eligible progress on an evidence event in state verified`)
  snap = kernel.reduceRunEvent(snap, { type: 'task-transition', at: 6, taskId: 'd1', title: 'deliver', state: 'done' })
  check('a task completing is eligible progress', snap.progress?.progressSinceDecision === 3, `got ${JSON.stringify(snap.progress)}; reduceRunEvent in src/engine/run/runKernel.ts must fold eligible progress on a task-transition event to done`)
  snap = kernel.reduceRunEvent(snap, { type: 'stop-decision', at: 7, decision: 'complete', detail: 'objective met' })
  check('a stop decision closes the since-decision window', snap.progress?.progressSinceDecision === 0, `got ${JSON.stringify(snap.progress)}; reduceRunEvent in src/engine/run/runKernel.ts must fold a stop-decision event through foldStopDecision`)
  snap = kernel.reduceRunEvent(snap, { type: 'completed', at: 8, satisfied: ['done'] })
  check('a terminal lifecycle keeps the window as it was', snap.lifecycle === 'completed' && snap.progress?.progressSinceDecision === 0, `lifecycle ${snap.lifecycle} progress ${JSON.stringify(snap.progress)}; the completed event in reduceRunEvent (src/engine/run/runKernel.ts) must leave progress alone`)

  let s2 = kernel.reduceRunEvent(empty, { type: 'substantive', at: 2, reason: 'work' })
  s2 = kernel.reduceRunEvent(s2, {
    type: 'tool-effected', at: 3, toolName: 'Write', toolUseId: 'x', operation: 'write', outcome: 'failed', changedPaths: [],
  })
  check('a failed effect never counts as progress', s2.progress?.progressSinceDecision === 0, `got ${JSON.stringify(s2.progress)}; reduceRunEvent in src/engine/run/runKernel.ts must fold progress only when a tool-effected outcome is succeeded`)
  let s3 = kernel.reduceRunEvent(empty, { type: 'substantive', at: 2, reason: 'work' })
  for (let i = 0; i < 12; i++) {
    s3 = kernel.reduceRunEvent(s3, { type: 'tool-started', at: 10 + i, toolName: 'Read', toolUseId: `r${i}` })
    s3 = kernel.reduceRunEvent(s3, { type: 'tool-effected', at: 11 + i, toolName: 'Read', toolUseId: `r${i}`, operation: 'read', outcome: 'no-change', changedPaths: [] })
  }
  check('twelve repeated reads of one path leave the snapshot without a repeat count of any kind', JSON.stringify(s3.progress) === JSON.stringify({ progressSinceDecision: 0 }) && !JSON.stringify(s3).includes('barren'), JSON.stringify(s3.progress))

  const legacy = { ...empty } as Record<string, unknown>
  delete legacy.progress
  const rehydrated = kernel.reduceRunEvent(legacy as never, { type: 'substantive', at: 9, reason: 'legacy' })
  check('a pre-2.1 snapshot re-mints progress on its next fold', rehydrated.progress?.progressSinceDecision === 0, `got ${JSON.stringify(rehydrated.progress)}; reduceRunEvent in src/engine/run/runKernel.ts must create progress when a stored snapshot has none`)
}

section('§4 SS-21 — owners never cross-renew')
{
  const a = kernel.emptyRunSnapshot({ runId: 'ra', owner: ok.makeOwnerKey({ workspace: '/tmp/wa', sessionId: 'sa', lane: 'main' }), objective: 'A', rootMessageId: null, at: 1 })
  const b = kernel.emptyRunSnapshot({ runId: 'rb', owner: ok.makeOwnerKey({ workspace: '/tmp/wb', sessionId: 'sb', lane: 'agent:1' }), objective: 'B', rootMessageId: null, at: 1 })
  const effA = kernel.reduceRunEvent(a, { type: 'tool-effected', at: 3, toolName: 'Write', toolUseId: 'a1', operation: 'write', outcome: 'succeeded', changedPaths: ['/tmp/wa/f'] })
  check("owner A's progress never appears on owner B (scope isolation by construction)", effA.progress?.progressSinceDecision === 1 && b.progress?.progressSinceDecision === 0, `A ${JSON.stringify(effA.progress)} B ${JSON.stringify(b.progress)}; progress must live on each run snapshot and not in shared state, see src/engine/run/runKernel.ts`)
}

section('§5 SS-22 — the sidecar round-trips the progress window')
{
  const owner = ok.makeOwnerKey({ workspace: '/tmp/progress-sidecar', sessionId: '00000000-0000-4000-8000-00000000c001', lane: 'main' })
  const sidecar = await import('../../src/engine/run/runSidecar.ts')
  let snap = kernel.emptyRunSnapshot({ runId: 'rs', owner, objective: 'persist me', rootMessageId: null, at: 1 })
  snap = kernel.reduceRunEvent(snap, { type: 'tool-effected', at: 3, toolName: 'Write', toolUseId: 's1', operation: 'write', outcome: 'succeeded', changedPaths: ['/tmp/progress-sidecar/x'] })
  await sidecar.saveRunSidecar(owner, snap)
  const loaded = await sidecar.loadRunSidecar(owner)
  check(
    'publish → load preserves the progress window (compaction/resume/restart durability)',
    loaded.state === 'loaded' && loaded.snapshot.progress?.progressSinceDecision === 1,
    `${loaded.state}; saveRunSidecar and loadRunSidecar in src/engine/run/runSidecar.ts must write and read the progress field of the snapshot`,
  )
}

section('§6 the invocation contract resolves ONCE and threads to the decision')
{
  const { resolveInvocationContract } = await import('../../src/engine/run/invocationContract.ts')
  const t = (facts: Parameters<typeof resolveInvocationContract>[0]) => resolveInvocationContract(facts)
  check('interactive ⇒ operator-led', JSON.stringify(t({ interactive: true, missionArmed: false })) === JSON.stringify({ surface: 'interactive', terminalPolicy: 'operator-led' }), 'resolveInvocationContract in src/engine/run/invocationContract.ts must resolve an interactive run without a mission to surface interactive, terminalPolicy operator-led')
  check('interactive + mission ⇒ mission-led', t({ interactive: true, missionArmed: true }).terminalPolicy === 'mission-led', 'resolveInvocationContract in src/engine/run/invocationContract.ts must return mission-led when interactive and missionArmed')
  check('plain print ⇒ ONE-SHOT (the BM-01 law)', JSON.stringify(t({ interactive: false, missionArmed: false })) === JSON.stringify({ surface: 'print', terminalPolicy: 'one-shot' }), 'resolveInvocationContract in src/engine/run/invocationContract.ts must resolve a non-interactive run without a mission to surface print, terminalPolicy one-shot')
  check('print + declared mission ⇒ mission-led (never one-shot)', t({ interactive: false, missionArmed: true }).terminalPolicy === 'mission-led', 'resolveInvocationContract in src/engine/run/invocationContract.ts must return mission-led when missionArmed, even when not interactive')
  check('sdk ⇒ client-led', t({ interactive: false, missionArmed: false, querySource: 'sdk' }).terminalPolicy === 'client-led', 'resolveInvocationContract in src/engine/run/invocationContract.ts must return client-led for querySource sdk')
  check('agent lanes ⇒ worker one-shot', JSON.stringify(t({ interactive: false, missionArmed: false, querySource: 'agent:7' })) === JSON.stringify({ surface: 'worker', terminalPolicy: 'one-shot' }), 'resolveInvocationContract in src/engine/run/invocationContract.ts must resolve an agent:<n> querySource to surface worker, terminalPolicy one-shot')

}

section('§7 one continuation per attempt across families; wording demoted; drains batch')
{
  const latch = await import('../../src/engine/run/continuationLatch.ts')
  latch._resetContinuationLatchesForTesting()
  const mission = await import('../../src/permissions/guards/mission.ts')
  const { judgeTurnEnd } = await import('../../src/permissions/guards/guards.ts')
  const { _setMissionJudgeForTesting } = await import('../../src/sessions/mission/goalJudge.ts')
  _setMissionJudgeForTesting(null)
  mission.setActiveMission('a mission that is not yet met', { sessionId: 'latch-arb' })
  const cb = async (messages: unknown[]): Promise<boolean> => (await judgeTurnEnd('latch-arb', { messages: messages as never })).length === 0
  const transcript = [
    { type: 'user', message: { content: 'go' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } },
  ]
  const first = cb ? await cb(transcript) : null
  const second = cb ? await cb(transcript) : null
  check('the mission BLOCKS the stop attempt and claims the continuation', first === false, 'judgeTurnEnd in src/permissions/guards/guards.ts must return a blocking result while the active mission in src/permissions/guards/mission.ts is unmet')
  check("the mission's hold outranks the latch: judged again on the SAME attempt it holds again instead of deferring a round to the earlier claimant", second === false, 'the mission hold in judgeTurnEnd (src/permissions/guards/guards.ts) must not be deferred by the continuation latch in src/engine/run/continuationLatch.ts on a repeat of the same attempt')
  const grown = [
    ...transcript,
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'latch-read', name: 'Read', input: { file_path: '/tmp/x' } }] } },
    { type: 'user', toolUseResult: { ok: true }, message: { content: [{ type: 'tool_result', tool_use_id: 'latch-read', content: 'ok' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'try again' }] } },
  ]
  const third = cb ? await cb(grown) : null
  check('a NEW attempt (grown transcript, a tool call in it so the idle brake stays off) re-arms the claim', third === false, 'a grown transcript must count as a new attempt in src/engine/run/continuationLatch.ts so judgeTurnEnd in src/permissions/guards/guards.ts blocks again')
  latch._resetContinuationLatchesForTesting()

  const { evaluateStop } = await import('../../src/engine/run/completionEvaluator.ts')
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
  check('SS-25/29: wording never overrules a typed one-shot terminal', worded.kind === 'complete', `${worded.kind}; evaluateStop in src/engine/run/completionEvaluator.ts must return complete for terminalPolicy one-shot even when wordingUnfinished is true`)

  const t = await import('../core-runtime/turnScenarios.ts')
  const queue = await import('../../src/daemon/runner/messageQueueManager.ts')
  const NOTES = [
    { value: 'steer note one', uuid: '11111111-1111-4111-8111-111111111111' },
    { value: 'steer note two', uuid: '22222222-2222-4222-8222-222222222222' },
    { value: 'steer note three', uuid: '33333333-3333-4333-8333-333333333333' },
  ]
  const drained = await t.runScripted({
    before: () => {
      for (const note of NOTES) queue.enqueue({ ...note, mode: 'prompt' } as never)
    },
    script: [t.fixtures.yields(t.fixtures.calls('toolu_round', 'EchoTool', { text: 'x' })), t.fixtures.yields(t.fixtures.says('all three notes are read.'))],
  })
  type Queued = { type?: string; attachment?: { type?: string; prompt?: unknown; source_uuid?: unknown } }
  const queuedIn = (rows: unknown[] | undefined): string => ((rows ?? []) as Queued[]).filter(row => row.type === 'attachment' && row.attachment?.type === 'queued_command').map(row => `${String(row.attachment?.prompt)} (${String(row.attachment?.source_uuid)})`).join(' | ') || 'none'
  const window = drained.events.slice(drained.events.findIndex(event => event.kind === 'tool_settled') + 1, Math.max(drained.events.findIndex(event => event.kind === 'turn_settled'), 0))
  const produced = queuedIn(window.filter(event => event.kind === 'attachment').map(event => event.message))
  const acknowledged = window.filter(event => event.kind === 'followup_drained').map(event => String(event.uuid)).join(',')
  const all = NOTES.map(note => `${note.value} (${note.uuid})`).join(' | ')
  const uuids = NOTES.map(note => note.uuid).join(',')
  check(
    'BM-02 coalesce: the drain snapshot folds into ONE attachment production (single call window)',
    drained.requests.length === 2 && drained.transitions.join(',') === 'next_turn' && queuedIn(drained.requests[0]?.messages) === 'none' && produced === all && queuedIn(drained.requests[1]?.messages) === all && acknowledged === uuids && drained.consumed.join(',') === uuids,
    `afterTools (src/engine/loop/turn/afterTools.ts) must take one snapshot of the drainable queue after a tool round, hand it whole to one getAttachmentMessages and consume it, so every queued prompt rides the next request together; with three prompts queued the run made ${drained.requests.length} model calls over [${drained.transitions.join(',')}], produced after the tools [${produced}], sent the second request [${queuedIn(drained.requests[1]?.messages)}], acknowledged [${acknowledged}] and consumed [${drained.consumed.join(',')}]`,
  )
}

section('§8 ONE persistence law on the seat that works a task for a caller; the session\'s finishing clause is the constitution\'s (SS-08/10/11)')
{
  const { MERCURY_CONSTITUTION, MERCURY_CREWMATE_CONTRACT } = await import(
    '../../src/engine/system-prompt/mercuryContract.ts'
  )
  const PERSIST = 'keep going while evidence advances the outcome'
  check('sub-agent: the law suggests and never counts (keep going while evidence advances; no repetition count, no strategy switch)', MERCURY_CREWMATE_CONTRACT.includes(PERSIST) && !/strategy once|stop looping|handoff|strateg/.test(MERCURY_CREWMATE_CONTRACT), 'MERCURY_SUBAGENT_CONTRACT in src/engine/system-prompt/mercuryContract.ts must contain the persistence sentence and no repetition count, handoff or strategy switch wording')
  check('sub-agent: a block stops for what only the caller can give, named', /returning blocked, with what you need named/.test(MERCURY_CREWMATE_CONTRACT), 'MERCURY_SUBAGENT_CONTRACT in src/engine/system-prompt/mercuryContract.ts must say a block returns blocked, with what you need named')
  check('session: the constitution asks only when a necessary fact, consequential decision or required permission cannot be resolved, and carries a given task through without asking again (no repetition count, no strategy switch)', MERCURY_CONSTITUTION.includes('ask only when a necessary fact, consequential decision or required permission cannot be resolved from the available context.') && MERCURY_CONSTITUTION.includes('Once a task is given, carry it through investigation, execution and proportionate verification.') && MERCURY_CONSTITUTION.includes('Do not ask again for routine steps already covered.') && !/strategy once|stop looping|strateg/.test(MERCURY_CONSTITUTION), 'MERCURY_CONSTITUTION in src/engine/system-prompt/mercuryContract.ts must keep its three sentences about asking only when needed, carrying a given task through and not asking again for covered steps, and no strategy switch wording')
}

rmSync(process.env.MERCURY_CONFIG_DIR!, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-progress-model: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-progress-model: all green')
