#!/usr/bin/env bun
// ============================================================================
//  scripts/stop-policy/prove-progress-model.ts —.1 (SP-2; laws
//  S1–S3, SS-19..SS-22): the typed progress/attempt model.
//
//    §1 fingerprint laws — digest equality, never prose: superficial diffs
//       (descriptions, key order, whitespace) never mint novelty; different
//       bytes/paths/commands always do.
//    §2 fold laws — progress derives ONLY from real events; repeats without
//       progress are barren; a changed prerequisite (progress) re-arms
//       retries; the phase machine walks productive → stagnant →
//       replan-required → handoff-required → terminal.
//    §3 kernel integration — the snapshot carries typed progress state end
//       to end; pre-2.1 sidecars hydrate and re-mint on the next fold.
//    §4 SS-21 — owners never cross-renew.
//    §5 SS-22 — the sidecar round-trips the progress state.
//    §6 wiring — the coordinator mints ONE attempt per settled call, BEFORE
//       its effect folds.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'speedster-progress-home-'))

const {
  commandHead,
  deriveProgressPhase,
  emptyProgressState,
  fingerprintKey,
  foldAttempt,
  foldEligibleProgress,
  foldStopDecision,
  makeAttemptFingerprint,
  MAX_ATTEMPT_LEDGER,
  REPLAN_AFTER_BARREN_REPEATS,
  STAGNANT_AFTER_BARREN_ATTEMPTS,
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

const CWD = '/Users/dev/project'

section('§1 FINGERPRINT LAWS — digest equality, never prose')
{
  const a = makeAttemptFingerprint({
    toolName: 'Write',
    input: { file_path: `${CWD}/src/a.ts`, content: 'body-1', description: 'first try' },
    cwd: CWD,
  })
  const b = makeAttemptFingerprint({
    toolName: 'Write',
    input: { description: 'RETRY with new wording!!', content: 'body-1', file_path: `${CWD}/src/a.ts` },
    cwd: CWD,
  })
  check('identical salient input ⇒ identical key (key order + description ignored)', fingerprintKey(a) === fingerprintKey(b))
  const c = makeAttemptFingerprint({ toolName: 'Write', input: { file_path: `${CWD}/src/a.ts`, content: 'body-2' }, cwd: CWD })
  check('changed content ⇒ different key', fingerprintKey(a) !== fingerprintKey(c))
  const d = makeAttemptFingerprint({ toolName: 'Write', input: { file_path: `${CWD}/src/b.ts`, content: 'body-1' }, cwd: CWD })
  check('changed path ⇒ different key', fingerprintKey(a) !== fingerprintKey(d))
  check('target normalizes cwd-relative posix', a.normalizedTarget === 'src/a.ts', a.normalizedTarget)

  const winPath = makeAttemptFingerprint({
    toolName: 'Edit',
    input: { file_path: 'C:\\proj\\src\\x.ts', old_string: 'p', new_string: 'q' },
    cwd: 'C:\\proj',
  })
  check('win32 separators normalize into the same posix law', winPath.normalizedTarget === 'src/x.ts', winPath.normalizedTarget)

  const s1 = makeAttemptFingerprint({ toolName: 'Bash', input: { command: 'bun   test src/  # again' }, cwd: CWD })
  const s2 = makeAttemptFingerprint({ toolName: 'Bash', input: { command: 'bun test src/' }, cwd: CWD })
  check('shell whitespace/comment diffs ⇒ same key', fingerprintKey(s1) === fingerprintKey(s2))
  const s3 = makeAttemptFingerprint({ toolName: 'Bash', input: { command: 'bun test src/other/' }, cwd: CWD })
  check('different command ⇒ different key', fingerprintKey(s1) !== fingerprintKey(s3))
  check('command head normalizes (env prefix + path + quotes)', commandHead('FOO=1 /usr/local/bin/PyTest -q') === 'pytest')
  const verify = makeAttemptFingerprint({ toolName: 'Bash', input: { command: 'pytest -q' }, cwd: CWD })
  check("verification heads classify evidence 'verification'", verify.expectedEvidenceClass === 'verification')
  const read1 = makeAttemptFingerprint({ toolName: 'Read', input: { file_path: `${CWD}/notes.md` }, cwd: CWD })
  const read2 = makeAttemptFingerprint({ toolName: 'Read', input: { file_path: `${CWD}/notes.md` }, cwd: CWD })
  check('reads are digest-receipted — a repeat Read carries the SAME key (visible repeat)', fingerprintKey(read1) === fingerprintKey(read2))
  check('purpose is the ONE self-claimed field and never enters the key', fingerprintKey({ ...a, purpose: 'hypothesis X' }) === fingerprintKey(a))
}

section('§2 FOLD LAWS — real-event progress; barren repeats; the phase machine')
{
  const fp = (n: number) =>
    makeAttemptFingerprint({ toolName: 'Bash', input: { command: `run-thing --case ${n}` }, cwd: CWD })
  // Distinct attempts, no progress: stagnant at the threshold.
  let s = emptyProgressState()
  for (let i = 1; i <= STAGNANT_AFTER_BARREN_ATTEMPTS; i++) s = foldAttempt(s, fp(i), i, false)
  check('distinct barren attempts reach STAGNANT at the threshold', s.phase === 'stagnant', s.phase)
  check('…without any repeat counted', s.repeatAttemptsSinceProgress === 0)

  // Identical repeats without progress: replan-required.
  let r = emptyProgressState()
  const same = fp(99)
  r = foldAttempt(r, same, 1, false)
  for (let i = 0; i < REPLAN_AFTER_BARREN_REPEATS; i++) r = foldAttempt(r, same, 2 + i, false)
  check('barren REPEATS reach REPLAN-REQUIRED', r.phase === 'replan-required', r.phase)
  check('the ledger row carries the barren-repeat count', (r.attempts.find(x => x.key === fingerprintKey(same))?.barrenRepeats ?? 0) >= REPLAN_AFTER_BARREN_REPEATS)

  // One replan consumed, repeats continue: handoff-required.
  let h = foldStopDecision(r, 'replan-directive issued', false)
  h = foldAttempt(h, same, 50, false)
  h = foldAttempt(h, same, 51, false)
  check('a consumed replan + continued barren repeats reach HANDOFF-REQUIRED', h.phase === 'handoff-required', h.phase)

  // Progress re-arms: the SAME fingerprint after eligible progress is NOT barren.
  let p = foldAttempt(emptyProgressState(), same, 1, false)
  p = foldEligibleProgress(p, 'prerequisite-change', 'installed the missing dep', 2, false)
  p = foldAttempt(p, same, 3, false)
  check('a changed prerequisite (eligible progress) re-arms the retry — repeat NOT barren', p.repeatAttemptsSinceProgress === 0 && p.phase === 'productive', `${p.phase} repeats=${p.repeatAttemptsSinceProgress}`)

  // Self-claims never count: only foldEligibleProgress moves progress, and its
  // callers are the kernel's REAL-event clauses (§3/§6 pin the wiring).
  check('progress counters move ONLY through eligible-progress folds', p.totalProgress === 1 && p.progressSinceDecision === 1)

  // Ledger boundedness.
  let big = emptyProgressState()
  for (let i = 0; i < MAX_ATTEMPT_LEDGER + 20; i++) big = foldAttempt(big, fp(i), i, false)
  check('the attempt ledger is bounded (LRU by lastAt)', big.attempts.length === MAX_ATTEMPT_LEDGER && big.totalAttempts === MAX_ATTEMPT_LEDGER + 20)

  check("terminal lifecycle wins the phase machine", deriveProgressPhase(emptyProgressState(), true) === 'terminal')
}

section('§3 KERNEL INTEGRATION — the snapshot carries typed progress end to end')
{
  const owner = ok.makeOwnerKey({ workspace: '/tmp/progress', sessionId: 'p1', lane: 'main' })
  const empty = kernel.emptyRunSnapshot({ runId: 'r1', owner, objective: 'ship it', rootMessageId: 'u1', at: 1 })
  check("emptyRunSnapshot mints the progress field (C12's flip)", 'progress' in empty && empty.progress?.phase === 'productive')

  const wfp = makeAttemptFingerprint({ toolName: 'Write', input: { file_path: '/tmp/progress/out.md', content: 'v1' }, cwd: '/tmp/progress' })
  let snap = kernel.reduceRunEvent(empty, { type: 'substantive', at: 2, reason: 'work' })
  snap = kernel.reduceRunEvent(snap, { type: 'attempt', at: 3, toolUseId: 't1', fingerprint: wfp })
  check('an attempt folds into the snapshot ledger', snap.progress?.totalAttempts === 1 && snap.progress.attemptsSinceProgress === 1)
  snap = kernel.reduceRunEvent(snap, {
    type: 'tool-effected', at: 4, toolName: 'Write', toolUseId: 't1', operation: 'write', outcome: 'succeeded', changedPaths: ['/tmp/progress/out.md'],
  })
  check('a PERSISTED artifact delta is eligible progress (attempt counters reset)', snap.progress?.totalProgress === 1 && snap.progress.attemptsSinceProgress === 0)
  snap = kernel.reduceRunEvent(snap, { type: 'evidence', at: 5, state: 'verified', detail: 'suite green' })
  check('a verification result is eligible progress', snap.progress?.totalProgress === 2)
  snap = kernel.reduceRunEvent(snap, { type: 'task-transition', at: 6, taskId: 'd1', title: 'deliver', state: 'done' })
  check('a task completing is eligible progress', snap.progress?.totalProgress === 3)
  snap = kernel.reduceRunEvent(snap, { type: 'stop-decision', at: 7, decision: 'complete', detail: 'objective met' })
  check('a stop decision closes the since-decision window', snap.progress?.progressSinceDecision === 0 && snap.progress.totalProgress === 3)
  snap = kernel.reduceRunEvent(snap, { type: 'completed', at: 8, satisfied: ['done'] })
  check('a terminal lifecycle parks the phase machine', snap.progress?.phase === 'terminal')

  // A failed/no-change effect is NOT progress (S1 eligibility).
  let s2 = kernel.reduceRunEvent(empty, { type: 'attempt', at: 2, toolUseId: 'x', fingerprint: wfp })
  s2 = kernel.reduceRunEvent(s2, {
    type: 'tool-effected', at: 3, toolName: 'Write', toolUseId: 'x', operation: 'write', outcome: 'failed', changedPaths: [],
  })
  check('a failed effect never counts as progress', s2.progress?.totalProgress === 0 && s2.progress.attemptsSinceProgress === 1)

  // Pre-2.1 sidecar tolerance: strip progress; the next fold re-mints it.
  const legacy = { ...empty } as Record<string, unknown>
  delete legacy.progress
  const rehydrated = kernel.reduceRunEvent(legacy as never, { type: 'substantive', at: 9, reason: 'legacy' })
  check('a pre-2.1 snapshot re-mints progress on its next fold', rehydrated.progress?.phase === 'productive')
}

section('§4 SS-21 — owners never cross-renew')
{
  const a = kernel.emptyRunSnapshot({ runId: 'ra', owner: ok.makeOwnerKey({ workspace: '/tmp/wa', sessionId: 'sa', lane: 'main' }), objective: 'A', rootMessageId: null, at: 1 })
  const b = kernel.emptyRunSnapshot({ runId: 'rb', owner: ok.makeOwnerKey({ workspace: '/tmp/wb', sessionId: 'sb', lane: 'agent:1' }), objective: 'B', rootMessageId: null, at: 1 })
  const fpA = makeAttemptFingerprint({ toolName: 'Bash', input: { command: 'build A' }, cwd: '/tmp/wa' })
  const foldedA = kernel.reduceRunEvent(a, { type: 'attempt', at: 2, toolUseId: 'a1', fingerprint: fpA })
  const effA = kernel.reduceRunEvent(foldedA, { type: 'tool-effected', at: 3, toolName: 'Write', toolUseId: 'a1', operation: 'write', outcome: 'succeeded', changedPaths: ['/tmp/wa/f'] })
  check("owner A's attempts/progress never appear on owner B (scope isolation by construction)", effA.progress?.totalProgress === 1 && b.progress?.totalProgress === 0 && b.progress.totalAttempts === 0)
}

section('§5 SS-22 — the sidecar round-trips typed progress')
{
  const sessionsHome = process.env.MERCURY_CONFIG_DIR!
  const owner = ok.makeOwnerKey({ workspace: '/tmp/progress-sidecar', sessionId: '00000000-0000-4000-8000-00000000c001', lane: 'main' })
  const sidecar = await import('../../src/services/run/runSidecar.ts')
  let snap = kernel.emptyRunSnapshot({ runId: 'rs', owner, objective: 'persist me', rootMessageId: null, at: 1 })
  snap = kernel.reduceRunEvent(snap, {
    type: 'attempt', at: 2, toolUseId: 's1',
    fingerprint: makeAttemptFingerprint({ toolName: 'Bash', input: { command: 'make thing' }, cwd: '/tmp/progress-sidecar' }),
  })
  snap = kernel.reduceRunEvent(snap, { type: 'tool-effected', at: 3, toolName: 'Write', toolUseId: 's1', operation: 'write', outcome: 'succeeded', changedPaths: ['/tmp/progress-sidecar/x'] })
  await sidecar.saveRunSidecar(owner, snap)
  const loaded = await sidecar.loadRunSidecar(owner)
  check(
    'publish → load preserves the progress state (compaction/resume/restart durability)',
    loaded.state === 'loaded' &&
      loaded.snapshot.progress?.totalProgress === 1 &&
      loaded.snapshot.progress.totalAttempts === 1 &&
      loaded.snapshot.progress.attempts.length === 1,
    loaded.state,
  )
}

section('§6 WIRING — one attempt per settled call, attempt before effect')
{
  const coordinator = src('src/services/run/runCoordinator.ts')
  const terminalBlock = coordinator.slice(coordinator.indexOf('subscribeToolTerminal'))
  const attemptAt = terminalBlock.indexOf("type: 'attempt'")
  const effectAt = terminalBlock.indexOf("type: 'tool-effected'")
  check('the coordinator mints the attempt INSIDE the terminal subscription', attemptAt > 0)
  check('…BEFORE the effect folds (progress re-arms repeats, never masks them)', attemptAt < effectAt)
  check('the fingerprint rides the shared normalization owner', terminalBlock.includes('makeAttemptFingerprint({'))
}

section('§7 2.2a — the invocation contract resolves ONCE and threads to the decision')
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
  check("the handoff settle records its evidence in the stop-decision detail", adapter.includes("decision.kind === 'handoff'") && adapter.includes('strategiesTried'))

  const evaluator = src('src/services/run/completionEvaluator.ts')
  check('the budget fuse is progress-aware (S2/C9), never progress-blind', evaluator.includes('progressSinceDecision') && evaluator.includes('freshProgress'))
  check('evidence-demand lanes are never escalated (the evidence bound preserved)', evaluator.includes("candidate.evidenceDemand === true) return candidate"))
}

section('§8 2.2c — one continuation per attempt across families; wording demoted; drains batch')
{
  // The mission hook claims through the SHARED latch: the same stop attempt
  // yields at most one mission block; a new attempt re-arms.
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
  check('2.2c: the mission BLOCKS once per stop attempt (the claim)', first === false)
  check('2.2c: a second claimant on the SAME attempt defers (one continuation per attempt across families)', second === true)
  const grown = [...transcript, { type: 'assistant', message: { content: [{ type: 'text', text: 'try again' }] } }]
  const third = cb ? await cb(grown) : null
  check('2.2c: a NEW attempt (grown transcript) re-arms the claim', third === false)
  latch._resetContinuationLatchesForTesting()

  // SS-25/29: wording never overrules a typed terminal — a substantive
  // one-shot with settled effects completes even when the tail "sounds"
  // unfinished.
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

  // coalescing half (disposition pin): the mid-turn drain passes the
  // WHOLE snapshot into one attachment production — never one provider call
  // per queued item.
  const turnMachine = src('src/run-core/turn-machine.ts')
  check(
    'BM-02 coalesce: the drain snapshot folds into ONE attachment production (single call window)',
    turnMachine.includes('getDrainableCommands(sleepRan)') && turnMachine.includes('queuedCommandsSnapshot,'),
  )
}

section('§9 2.3 — the cycle lease is wired at the re-entry seam')
{
  const tm = src('src/run-core/turn-machine.ts')
  check('the turn machine consults the lease BEFORE the next provider call', tm.includes('evaluateCycleLease('))
  check('…one replan per turn (cycleReplanInjected threads through TurnState)', tm.includes('cycleReplanInjected') && tm.includes('cycleDirectiveMessages'))
  check("…the settle yields the typed attachment + terminal (never a silent drop)", tm.includes("type: 'cycle_handoff'") && tm.includes("reason: 'cycle_handoff'"))
  check('…and folds the honest stop-decision run event', tm.includes("decision: 'handoff',"))
  const qe = src('src/QueryEngine.ts')
  check(
    'the -p result derives the handoff truthfully (deliberate settle, never an error, HANDOFF-prefixed text)',
    qe.includes("attachmentType === 'cycle_handoff'") &&
      qe.includes('`HANDOFF: ${') &&
      /cycle_handoff'\)[\s\S]{0,600}?is_error: false/.test(qe),
  )
  // The bounded no-useful-event interval (S-law's stall watchdog) is
  // MEASUREMENT-GATED: its p95 denominator comes from the Stage-2.0/4
  // battery, which is blocked on the bench-home re-auth — recorded, not
  // silently skipped.
  console.log('  [GATED] no-useful-event interval: p95 denominator awaits the baseline battery (recorded in speedster-STAGE2-0.md §4)')
}

section('§10 2.4 — ONE persistence law, spliced at every surface (SS-08/10/11)')
{
  const { PERSISTENCE_LAW, MERCURY_DOCTRINE } = await import(
    '../../src/prompt/mercuryContract.ts'
  )
  check('the law reads as the provider-neutral lease (advance → one strategy change → evidence-backed handoff)',
    /Continue while evidence advances/.test(PERSISTENCE_LAW) && /change strategy once/.test(PERSISTENCE_LAW) && /evidence-backed handoff/.test(PERSISTENCE_LAW))
  check('the doctrine (native surface) carries the law VERBATIM', MERCURY_DOCTRINE.includes(PERSISTENCE_LAW))
  const doctrine = await import('../../src/constants/subagentDoctrine.ts')
  const doctrineSrc = src('src/constants/subagentDoctrine.ts')
  check('the subagent doctrine splices the law in its one register (SS-10 stagnation terminal)', (doctrineSrc.match(/\$\{PERSISTENCE_LAW\}/g) ?? []).length === 1)
  const contract = src('src/prompt/mercuryContract.ts')
  check('exactly ONE law definition exists (SS-11: one canonical owner)', (contract.match(/export const PERSISTENCE_LAW/g) ?? []).length === 1)
  check('the retired GPT overlay is GONE (one content for every family)', !contract.includes('agentic_persistence'))
  void doctrine
}

section('§11 2.6 — the handoff carries its full evidence payload')
{
  const { buildHandoffReport, renderHandoffReport } = await import('../../src/services/run/cycleLease.ts')
  const { makeAttemptFingerprint } = await import('../../src/services/run/progressModel.ts')
  const owner = ok.makeOwnerKey({ workspace: '/tmp/handoff', sessionId: 'h1', lane: 'main' })
  let snap = kernel.emptyRunSnapshot({ runId: 'run-h1', owner, objective: 'ship the widget', rootMessageId: null, at: 1 })
  snap = kernel.reduceRunEvent(snap, { type: 'substantive', at: 2, reason: 'work' })
  const fpA = makeAttemptFingerprint({ toolName: 'Bash', input: { command: 'make widget' }, cwd: '/tmp/handoff' })
  snap = kernel.reduceRunEvent(snap, { type: 'attempt', at: 3, toolUseId: 'a', fingerprint: fpA })
  snap = kernel.reduceRunEvent(snap, { type: 'attempt', at: 4, toolUseId: 'b', fingerprint: fpA })
  const r = buildHandoffReport(snap, 'stagnation')
  check("2.6: a run with zero changed paths says 'no files changed' PLAINLY", r.changed === 'no files changed')
  check('2.6: strategies deduplicate (one row for the repeated command)', r.strategiesTried.length === 1 && r.strategiesTried[0]!.includes('execute:shell'))
  check('2.6: resume identifiers ride the report', r.resume.runId === 'run-h1')
  check('2.6: why-repeat-fails names the barren strategy + count', /repeated 2×/.test(r.whyRepeatFails))
  const rendered = renderHandoffReport(r)
  check('2.6: the rendering carries every field', ['requested outcome:', 'materially changed:', 'strategies tried:', 'newest evidence:', 'why another cycle repeats:', 'smallest reopening input:', 'resume: run'].every(k => rendered.includes(k)))

  const withChange = kernel.reduceRunEvent(snap, { type: 'tool-effected', at: 5, toolName: 'Write', toolUseId: 'w', operation: 'write', outcome: 'succeeded', changedPaths: ['/tmp/handoff/x'] })
  check('2.6: changed paths report truthfully when they exist', buildHandoffReport(withChange, 'x').changed.includes('1 file(s) changed'))

  // The evaluator's handoff decisions carry the SAME rendered payload.
  const { evaluateStop } = await import('../../src/services/run/completionEvaluator.ts')
  const open = kernel.reduceRunEvent(snap, { type: 'task-transition', at: 6, taskId: 't', title: 'the widget', state: 'open' })
  const d = evaluateStop({
    snapshot: open, wordingUnfinished: false, continuationsThisTurn: 2, maxContinuationsPerTurn: 3,
    aborted: false, apiError: false, verification: null, pendingIdeFeedback: false,
  } as never)
  check('2.6: the stop-authority handoff carries the rendered report', d.kind === 'handoff' && d.report.includes('requested outcome: ship the widget'), d.kind)
  const tm = src('src/run-core/turn-machine.ts')
  check('2.6: the cycle settle threads the rendered report into the attachment', tm.includes('renderHandoffReport(lease.report)'))
  check(
    '2.6: the -p result appends the report',
    src('src/QueryEngine.ts').includes("(attachment as { report?: string }).report ?? ''") &&
      src('src/QueryEngine.ts').includes('${openClause}\\n${report}`'),
  )
}

rmSync(process.env.MERCURY_CONFIG_DIR!, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-progress-model: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-progress-model: all green')
