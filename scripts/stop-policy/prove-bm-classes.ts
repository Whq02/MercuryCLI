#!/usr/bin/env bun
// ============================================================================
//  scripts/stop-policy/prove-bm-classes.ts
//  STAGE 2.0 — the SATURDAY rebind gate: the live BM
//  classes reproduced/pinned on CURRENT MAIN as deterministic fixtures,
//  joining the 0.6 corpus discipline:
//
//   · EXPECTED_RED legs assert the DESIRED law and are
//     REQUIRED TO FAIL here — each failure is a reproduced defect class.
//     The fixing stage moves its leg out of EXPECTED_RED in the same commit.
//   · GREEN legs are dispositions/floors: classes the Stage-1 tail already
//     closed or deliberate rulings (session-scoped
//     cache key), pinned so the record can't drift.
//
//  END-TO-END shape (the live -p "Run-state check" ×2 + the
//  +≈20K read-back jump) is additionally MEASURED by the Stage-2.0 baseline
//  battery (bench harness, real binary) — this prover pins the in-process
//  mechanisms those measurements ride on. stay QUESTION rows
//  (no current-main producer capture yet) — recorded in the 2.0 record,
//  deliberately absent here.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'speedster-bm-home-'))

// ── the expectation contract ────────────────────────────────────────────────
const EXPECTED_RED = new Set<string>([
  // FLIPPED GREEN at 2.2a: StopEvaluationInput carries surface/
  // terminalPolicy (InvocationContract), and a one-shot print with settled
  // effects COMPLETES — the legs stay below as regression floors.
  // FLIPPED GREEN at 2.2b: the revision tuple + prior-admission input
  // + the A04-A06 refusal in the evaluator (behavioral legs below).
  // + FLIPPED GREEN at 3.4: the MutationReceipt digest settles
  // at the publication owners (Write/Edit details.artifactDigest), the
  // observer discharges the read-back debt for digest-receipted paths, and
  // the evidence store relocated to the config-home project-keyed path
  // (workspace copy opt-in via MERCURY_WORKSPACE_EVIDENCE).
  // FLIPPED GREEN at 3.5 (settlement slice): the api-error settle
  // derives the error_during_execution envelope from the ONE isApiError
  // predicate (errors:[textResult]); the success yield sits behind the guard
  // with a literal is_error:false, and plain-text stderr keeps the cause.
  // FLIPPED GREEN at 3.5: the fold accumulates per-item argument
  // deltas and an argument-less done item falls back to them (a done item
  // with its own arguments always wins — spec trust).
])

type Leg = { label: string; pass: boolean; detail: string }
const legs: Leg[] = []
function check(label: string, cond: boolean, detail = ''): void {
  legs.push({ label, pass: cond, detail })
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const src = (p: string): string => readFileSync(join(import.meta.dir, '../../', p), 'utf8')

async function main(): Promise<void> {
  const ok = await import('../../src/services/run/ownerKey.js')
  const kernel = await import('../../src/services/run/runKernel.js')
  const { evaluateStop } = await import('../../src/services/run/completionEvaluator.js')

  const owner = ok.makeOwnerKey({ workspace: '/tmp/speedster-bm', sessionId: 'bm', lane: 'main' })
  const base = (objective: string) =>
    kernel.emptyRunSnapshot({ runId: 'bm-classes', owner, objective, rootMessageId: 'u1', at: 1 })
  const fold = (objective: string, events: Parameters<typeof kernel.reduceRunEvent>[1][]) =>
    events.reduce((s, e) => kernel.reduceRunEvent(s, e), base(objective))
  const defaults = {
    wordingUnfinished: false,
    continuationsThisTurn: 0,
    maxContinuationsPerTurn: 3,
    aborted: false,
    apiError: false,
    verification: null,
    pendingIdeFeedback: false,
  }

  // ══ · invocation-blind stop decisions ═══════════════════════════════
  section('BM-01 — a settled print one-shot must not earn a run-state continuation')
  {
    const evaluator = src('src/services/run/completionEvaluator.ts')
    check(
      'BM-01: the stop decision input can EXPRESS a one-shot print surface (invocation contract field)',
      /^\s*(surface|invocation\w*)\??:/m.test(
        evaluator.slice(evaluator.indexOf('interface StopEvaluationInput'), evaluator.indexOf('export function evaluateStop')),
      ),
    )
    // The field shape: -p asks for one Write; the Write settles; the final
    // text exists; nothing requested verification. Today the evidence gap
    // demands a continuation ("Run-state check" ×2, 8/8 field runs).
    const settledWrite = fold('write the report file', [
      { type: 'substantive', at: 2, reason: 'mutation landed' },
      {
        type: 'tool-effected',
        at: 3,
        toolName: 'Write',
        toolUseId: 'w1',
        operation: 'write',
        outcome: 'update',
        changedPaths: ['/tmp/speedster-bm/report.md'],
      },
    ] as never[])
    const d = evaluateStop({
      ...defaults,
      snapshot: settledWrite,
      verification: { state: 'stale', mutationsSinceEvidence: 1, workspaceVerifiable: true },
      surface: 'print',
      terminalPolicy: 'one-shot',
    } as never)
    check(
      'BM-01: a settled print one-shot (effects landed, no verification requested) stops without an evidence continuation',
      d.kind === 'complete',
      d.kind,
    )
    // The interactive posture is UNCHANGED: the same snapshot without the
    // contract still earns the evidence continuation (the floor the field's
    // interactive sessions rely on).
    const interactive = evaluateStop({
      ...defaults,
      snapshot: settledWrite,
      verification: { state: 'stale', mutationsSinceEvidence: 1, workspaceVerifiable: true },
    } as never)
    check('BM-01 floor: the surface-less (interactive) posture still demands evidence', interactive.kind === 'continue', interactive.kind)
  }

  // ══ · attempt-counted admission ═════════════════════════════════════
  section('BM-02 — admission by revision key, not elapsed attempts')
  {
    const evaluator = src('src/services/run/completionEvaluator.ts')
    check(
      'BM-02: continuation admission is revision-keyed (runRevision/evidenceRevision/nextActionFingerprint in the decision input)',
      /runRevision|evidenceRevision|nextActionFingerprint/.test(evaluator),
    )
  }

  // ══ · admission by revision, behavioral (2.2b floors) ═══════════════
  section('BM-02 — the same tuple + action may not open another provider call')
  {
    const { actionFingerprint } = await import('../../src/services/run/progressModel.js')
    const open = fold('churny run', [
      { type: 'substantive', at: 2, reason: 'work' },
      { type: 'task-transition', at: 3, taskId: 't1', title: 'the work', state: 'open' },
    ] as never[])
    const tuple = { runRevision: 3, effectRevision: 0, evidenceRevision: 0, externalRevision: 0 }
    const first = evaluateStop({ ...defaults, snapshot: open, revision: tuple, priorAdmission: null } as never)
    check('BM-02: the FIRST admission continues (nothing admitted yet)', first.kind === 'continue', first.kind)
    const prior = first.kind === 'continue'
      ? { revision: tuple, nextActionFingerprint: actionFingerprint(first.nextAction) }
      : { revision: tuple, nextActionFingerprint: '' }
    const identical = evaluateStop({ ...defaults, snapshot: open, continuationsThisTurn: 1, revision: tuple, priorAdmission: prior } as never)
    check(
      'BM-02: an UNCHANGED tuple + the same action is refused with the typed handoff (A04-A06)',
      identical.kind === 'handoff',
      identical.kind,
    )
    const moved = evaluateStop({
      ...defaults,
      snapshot: open,
      continuationsThisTurn: 1,
      revision: { ...tuple, evidenceRevision: 31 },
      priorAdmission: prior,
    } as never)
    check('BM-02: a MOVED evidence revision re-arms admission (the world changed)', moved.kind === 'continue', moved.kind)
  }

  // ══ · read-back debt + evidence into the checkout ═════════════
  section('BM-03/BM-09 — receipts over read-back; evidence outside the checkout')
  {
    const v = await import('../../src/utils/verification/verificationState.js')
    const { observeToolTerminal } = await import('../../src/services/run/effectObserver.js')
    v._resetVerificationStateForTesting()
    const cwd = mkdtempSync(join(tmpdir(), 'speedster-bm-proj-'))
    const vOwner = ok.makeOwnerKey({ workspace: cwd, sessionId: 'bm-v', lane: 'main' })
    const target = join(cwd, 'lib.py')
    // A Mercury-published Write settles WITH its MutationReceipt digest
    // (the 3.4 publication-owner contract) — proven bytes, no read-back debt.
    observeToolTerminal({
      owner: vOwner,
      toolName: 'Write',
      toolUseId: 'w1',
      input: { file_path: target, content: 'x = 1\n' },
      ok: true,
      durationMs: 5,
      effect: {
        outcome: 'succeeded',
        operation: 'file.write',
        changedPaths: [target],
        evidence: 'created lib.py (7 bytes)',
        startedAt: 1,
        completedAt: 2,
        details: { artifactDigest: 'ab12cd34ef56ab78', byteCount: 7 },
      },
      cwd,
    })
    const demanded = v.demandedReadBackPaths(cwd, vOwner)
    check(
      'BM-09: a Mercury-published Write is dischargeable by receipt — no full-file read-back demand',
      demanded.size === 0,
      `demanded: ${[...demanded].join(', ') || 'none'}`,
    )
    // A digest-LESS legacy mutation still mints the debt (the receipt is the
    // discharge, never a blanket amnesty).
    v.observeCompletedToolCall('Write', { file_path: join(cwd, 'legacy.py'), content: 'y\n' }, true, cwd, vOwner)
    check(
      'BM-09 contrast: a digest-less legacy mutation KEEPS the read-back debt',
      v.demandedReadBackPaths(cwd, vOwner).size === 1,
    )
    // A verification command completing persists evidence — OUTSIDE the
    // checkout (config-home project-keyed store; workspace copy is opt-in).
    v.observeCompletedToolCall('Bash', { command: 'python -m pytest -q' }, true, cwd, vOwner)
    const insideMercury = join(cwd, '.mercury', 'verify')
    const insideClaude = join(cwd, '.claude', 'verify')
    const wroteInside = existsSync(insideMercury) || existsSync(insideClaude)
    check(
      'BM-03: runtime verification evidence lands OUTSIDE the checkout by default',
      !wroteInside,
      wroteInside ? `wrote ${existsSync(insideMercury) ? insideMercury : insideClaude}` : 'checkout clean',
    )
    check(
      'BM-03: the config-home project-keyed store carries it instead',
      existsSync(join(process.env.MERCURY_CONFIG_DIR!, 'verify')),
    )
    rmSync(cwd, { recursive: true, force: true })
  }

  // ══ · one typed terminal outcome (FLIPPED at 3.5) ═══════════════════
  section('BM-14 — subtype/is_error/exit derive from one typed outcome')
  {
    const engine = src('src/QueryEngine.ts')
    // The api-error settle mints the ERROR envelope from the ONE isApiError
    // predicate — subtype/is_error/errors agree by construction, and the
    // success yield is reachable only through the guard with a literal
    // is_error:false. The live specimen (subtype success + is_error true
    // after 10× 401) is unmintable in this shape.
    const guardAt = engine.indexOf('if (isApiError) {')
    const errorMintAt = engine.indexOf("subtype: 'error_during_execution',\n        is_error: true", guardAt)
    const errorsCarryText = engine.indexOf('errors: [textResult],', guardAt)
    check(
      'BM-14: the print result derives from ONE typed terminal outcome (no unguarded success yield)',
      guardAt > 0 &&
        errorMintAt > guardAt &&
        errorsCarryText > guardAt &&
        !engine.includes('is_error: isApiError'),
      `guard=${guardAt} mint=${errorMintAt} errors=${errorsCarryText}`,
    )
  }

  // ══ · truthful lock release ═════════
  section('BM-16 — clean claim→release leaves zero debris + a truthful receipt')
  {
    const lock = await import('../../src/substrate/pidLock.js')
    const dir = mkdtempSync(join(tmpdir(), 'speedster-bm-lock-'))
    const lockPath = join(dir, 'test.lock')
    const got = await lock.acquirePidLock(lockPath, 'bm16-owner', { liveness: 'live' as never })
    const receipt = await lock.releasePidLock(lockPath, 'bm16-owner')
    const debris = existsSync(lockPath)
    check(
      'BM-16: a clean claim→release cycle settles a truthful removed receipt and zero debris (floor)',
      got.held === true && receipt.outcome === 'removed' && !debris,
      `held=${got.held} outcome=${receipt.outcome} debris=${debris}`,
    )
    rmSync(dir, { recursive: true, force: true })
  }

  // ══+ · the cache-domain key (3.5.2 — the ruling UPGRADED) ══════
  section('BM-08/06 — one cache-domain owner; fresh compatible processes REUSE (E01-E04)')
  {
    const { mintCacheDomainKey } = await import('../../src/utils/cache/cacheDomain.js')
    const base = {
      providerScope: 'openai:chatgpt-subscription',
      servedModel: 'gpt-5.6-sol',
      projectPath: '/Users/dev/project',
      behaviorContractDigest: 'aabbccdd11223344',
      toolSchemaDigest: '5566778899aabbcc',
    }
    const k1 = mintCacheDomainKey(base)
    const k2 = mintCacheDomainKey({ ...base })
    check('E01/E02: two fresh compatible processes mint the SAME key (reuse by construction)', k1 === k2 && k1.startsWith('mercury-domain:'))
    check('E03: a model change moves the key', mintCacheDomainKey({ ...base, servedModel: 'gpt-5.6-luna' }) !== k1)
    check('E03: a project change moves the key', mintCacheDomainKey({ ...base, projectPath: '/other' }) !== k1)
    check('E04: a contract/tool change moves the key', mintCacheDomainKey({ ...base, toolSchemaDigest: 'ffffffffffffffff' }) !== k1)
    check('the key NEVER carries session/raw-path/raw-account material', !k1.includes('session') && !k1.includes('/Users') && k1.length < 48)
    const callModel = src('src/services/providers/openai/openaiCallModel.ts')
    check('the openai lane mints through the ONE domain owner (the session-scoped spelling is GONE)',
      callModel.includes('mintCacheDomainKey({') && !callModel.includes('promptCacheKey: `mercury:${'))
  }

  // ══ E08-E12 · Cache Clock cross-process cadence + honest reporting ════════
  section('E08-E12 — the cadence prior is cross-process; TTL policy + reporting honest')
  {
    const core = await import('../../src/utils/cache/cacheClockCore.js')
    const clock = src('src/utils/cache/cacheClock.ts')
    // E08: the prior is PROJECT-keyed runtime bookkeeping (projects/<key>/
    // cache-clock/sessions), scanned across OTHER sessions' rollups — a fresh
    // compatible process inherits the cadence with zero session coupling.
    // ADJUDICATED: cadence is a WORKFLOW property, so project scope is the
    // right prior key; the cache-domain key (E01-E04) governs the REQUEST
    // layer only — the cadence prior is never domain-keyed.
    check(
      'E08: rollups live in the global per-project store (cross-process by construction)',
      clock.includes("'cache-clock', 'sessions'") && clock.includes('getProjectsDir()'),
    )
    check(
      'E08: readPrior scans OTHER sessions (own rollup excluded) for the first-choice TTL',
      clock.includes('f !== own') && clock.includes('priorFromRollups'),
    )
    check(
      'E08 adjudication: the cadence prior is NEVER domain-keyed (workflow property, project scope)',
      !clock.includes('mintCacheDomainKey'),
    )
    // E09: the ONE decision table (cacheClockCore.decideInitialTtl).
    const gapPrior = { sessions: 5, gapSessions: 3 }
    check(
      'E09: disabled ⇒ null (default path byte-identical); an operator pin wins over eligibility',
      core.decideInitialTtl({ enabled: false, pin: null, eligible: true, cls: 'interactive', prior: gapPrior }) === null &&
        core.decideInitialTtl({ enabled: true, pin: '1h', eligible: false, cls: 'interactive', prior: gapPrior })?.ttl === '1h',
    )
    check(
      'E09: worker ⇒ upfront 1h; gap-heavy interactive prior ⇒ upfront 1h; thin prior ⇒ 5m+escalation',
      core.decideInitialTtl({ enabled: true, pin: null, eligible: true, cls: 'worker', prior: { sessions: 0, gapSessions: 0 } })?.ttl === '1h' &&
        core.decideInitialTtl({ enabled: true, pin: null, eligible: true, cls: 'interactive', prior: gapPrior })?.ttl === '1h' &&
        JSON.stringify(core.decideInitialTtl({ enabled: true, pin: null, eligible: true, cls: 'interactive', prior: { sessions: 1, gapSessions: 1 } })) ===
          JSON.stringify({ ttl: '5m', escalation: true }),
    )
    // E10: TTL-FLIP-AT-COLD-ONLY + the standing benchmark verdict.
    const fiveM = { ttl: '5m', escalation: true } as const
    check(
      'E10: escalation fires ONLY at a cold boundary the 1h TTL would have survived ((5m,1h])',
      !core.shouldEscalate(fiveM, core.TTL_MS['5m'] - 1) &&
        core.shouldEscalate(fiveM, core.TTL_MS['5m'] + 1) &&
        !core.shouldEscalate(fiveM, core.TTL_MS['1h'] + 1) &&
        !core.shouldEscalate({ ttl: '1h', escalation: false }, core.TTL_MS['5m'] + 1),
    )
    const verdict = JSON.parse(src('scripts/cache/fixtures/verdict.json'))
    check(
      'E10: the benchmark verdict stands green (≥9% saved, cold rewrites collapsed, on the 82-session corpus)',
      verdict.green === true &&
        verdict.result.savingsPct >= 9 &&
        verdict.result.coldRewrites.clock < verdict.result.coldRewrites.baseline5m,
      `green=${verdict.green} savings=${verdict.result.savingsPct}% cold=${verdict.result.coldRewrites.baseline5m}→${verdict.result.coldRewrites.clock}`,
    )
    // E11: fail-open at every layer — junk rollups, unreadable dirs, and the
    // disabled path all fall through to default behaviour.
    check(
      'E11: junk rollups fail OPEN (priorFromRollups tolerates garbage; readPrior catch ⇒ empty prior)',
      JSON.stringify(core.priorFromRollups([null, 42, 'junk', {}])) === JSON.stringify({ sessions: 0, gapSessions: 0 }) &&
        JSON.stringify(core.priorFromRollups([{ v: 1, requests: 10, gapsOver5m: 2 }, 'junk'])) === JSON.stringify({ sessions: 1, gapSessions: 1 }) &&
        clock.includes('return { sessions: 0, gapSessions: 0 }'),
    )
    // E12: honest reporting — provider-reported hits and the LOCAL prefix
    // instrument stay separate by construction: the fingerprint never reads
    // usage, and its token figure is a labeled estimate, never a billing claim.
    const fp = src('src/services/api/prefixFingerprint.ts')
    check(
      'E12: prefixFingerprint is pure/local (no usage/cache_read reads; estimate labeled, never a billing claim)',
      fp.includes('never a billing claim') && !fp.includes('cache_read') && fp.includes("from 'node:crypto'"),
    )
  }

  // ══ · function_call_arguments carried ONLY by deltas ════════════════
  section('BM-04 — the SSE fold vs delta-only tool-call arguments')
  {
    const { ResponsesStreamFold } = await import('../../src/services/providers/openai/openaiWire.js')
    const fold04 = new ResponsesStreamFold()
    const events = [
      { type: 'response.created', response: { id: 'resp_bm04' } },
      {
        type: 'response.output_item.added',
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_bm04', name: 'EchoTool', arguments: '' },
      },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"text":' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '"four"}' },
      // The pathological stream: the done item arrives WITHOUT arguments.
      {
        type: 'response.output_item.done',
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_bm04', name: 'EchoTool' },
      },
      { type: 'response.completed', response: { id: 'resp_bm04', usage: { input_tokens: 10, output_tokens: 2 } } },
    ]
    const out = events.flatMap(e => fold04.fold(e))
    const toolEvent = out.find(e => JSON.stringify(e).includes('call_bm04')) as
      | { toolCalls?: Array<{ arguments?: string }> }
      | Record<string, unknown>
      | undefined
    const flat = JSON.stringify(out)
    const argumentsSurvived = flat.includes('{\\"text\\":\\"four\\"}') || flat.includes('"{\\"text\\":\\"four\\"}"')
    check(
      'BM-04: the fold settles tool-call arguments carried ONLY by deltas (done item argument-less)',
      argumentsSurvived,
      toolEvent ? JSON.stringify(toolEvent).slice(0, 200) : `no tool event — ${flat.slice(0, 160)}`,
    )
  }

  // ══ N-03/H-13 · agent notices reach the model promptly (A07 — 2.2b floor) ═
  section('N-03 — agent terminal notices are NOT Sleep-gated (workflow parity)')
  {
    const q = await import('../../src/input-core/command-queue.js')
    q.resetCommandQueue()
    q.enqueuePendingNotification({ value: '<task-notification>agent done</task-notification>', mode: 'task-notification', priority: 'next' } as never)
    const midTurn = q.getDrainableCommands(false)
    check(
      "N-03: a 'next'-priority agent notice drains at EVERY mid-turn boundary (no Sleep needed)",
      midTurn.some(c => String(c.value).includes('agent done')),
    )
    q.resetCommandQueue()
    q.enqueuePendingNotification({ value: '<task-notification>legacy later</task-notification>', mode: 'task-notification' } as never)
    const withoutSleep = q.getDrainableCommands(false)
    const withSleep = q.getDrainableCommands(true)
    check(
      "N-03 contrast: the default 'later' band stays Sleep-gated (the starvation mechanism, pinned)",
      !withoutSleep.some(c => String(c.value).includes('legacy later')) &&
        withSleep.some(c => String(c.value).includes('legacy later')),
    )
    q.resetCommandQueue()
    const agentTask = src('src/tasks/LocalAgentTask/LocalAgentTask.tsx')
    const enqueueBlock = agentTask.slice(agentTask.indexOf('enqueuePendingNotification({'))
    check(
      "N-03 wiring: LocalAgentTask enqueues terminal notices at priority 'next' (the workflow precedent)",
      enqueueBlock.slice(0, 200).includes("priority: 'next'"),
    )
  }

  // ══ · headless activity is visible (3.5.4 floors) ══════════════
  section('BM-15 — numStartups stays interactive-only; headless activity has its ledger')
  {
    process.env.NODE_ENV = 'test'
    const { noteHeadlessActivity, getHeadlessActivity } = await import('../../src/utils/activityLedger.js')
    const before = getHeadlessActivity()
    noteHeadlessActivity('print')
    noteHeadlessActivity('sdk')
    noteHeadlessActivity('verb:doctor')
    const after = getHeadlessActivity()
    check(
      'BM-15: print/sdk/verb counters advance with last-activity stamps',
      after.print === before.print + 1 && after.sdk === before.sdk + 1 && (after.verbs['doctor'] ?? 0) === (before.verbs['doctor'] ?? 0) + 1 && after.lastAt > 0,
      JSON.stringify(after),
    )
    const printSrc = src('src/cli/print.ts')
    check('BM-15: runHeadless notes its activity at entry (one deferred merge, no hot-path write)', printSrc.includes('noteHeadlessActivity('))
    const mainSrc = src('src/main.tsx')
    // The "no ledger call in main.tsx" clause predates the verbs producer
    // (FC-137): main.tsx's commander preAction stamps every subcommand as
    // verb:<name>, and that is its ONE ledger call. numStartups stays the
    // interactive boot's increment alone; the print/sdk kinds are stamped
    // in print.ts, never here.
    check(
      "BM-15: numStartups semantics UNTOUCHED (interactive increment only; main.tsx's one ledger call is the verb stamp, never print/sdk)",
      mainSrc.includes('numStartups: (current.numStartups ?? 0) + 1') &&
        (mainSrc.match(/noteHeadlessActivity\(/g) ?? []).length === 1 &&
        mainSrc.includes("noteHeadlessActivity(`verb:${names.join(':')}`)") &&
        !/noteHeadlessActivity\(\s*'(?:print|sdk)'/.test(mainSrc),
    )
    check("BM-15: /health carries the activity row (wedge detection reads BOTH)", src('src/utils/healthReport.ts').includes("id: 'activity'"))
  }

  // ══ · dispatch capability preflight (WK-01..08 floors) ══════════════
  section('WK — the worktree preflight refuses BEFORE allocation, deterministically')
  {
    const w = await import('../../src/utils/worktree.js')
    w._resetWorktreeRefusalCountsForTesting()
    const bare = mkdtempSync(join(tmpdir(), 'speedster-wk-'))
    const first = w.preflightWorktreeCapability(bare)
    check(
      'WK-01/02/03: a non-git hookless dir preflights UNAVAILABLE with the exact prerequisite (typed, before any allocation)',
      first.available === false && first.prerequisite === 'git-repository-or-worktree-create-hook',
    )
    check('WK-06/07: the receipt names the cwd + the mechanical retry (strip isolation / move to the repo)', first.detail.includes(bare) && first.detail.includes('WITHOUT the isolation parameter'))
    const second = w.preflightWorktreeCapability(bare)
    check('WK-08: an identical relaunch is SURFACED as a repeat refusal', second.repeatCount === 2 && second.detail.includes('repeat refusal #2'))
    const repo = w.preflightWorktreeCapability(join(import.meta.dir, '../../'))
    check('WK floor: a real git repository preflights AVAILABLE', repo.available === true)
    const agentTool = src('src/tools/AgentTool/AgentTool.tsx')
    const preflightAt = agentTool.indexOf('preflightWorktreeCapability()')
    const mintAt = agentTool.indexOf("const earlyAgentId = generateTaskId('local_agent')")
    check('WK-03 wiring: the preflight runs BEFORE the agent id mints (nothing allocates on a refusal)', preflightAt > 0 && preflightAt < mintAt)
    check("WK-05: createAgentWorktree's own throw stays the FLOOR (isolation never silently downgraded)", src('src/utils/worktree.ts').includes('Worktree isolation is unavailable here'))
    rmSync(bare, { recursive: true, force: true })
  }

  // ── verdict: greens must pass, expected reds must fail ─────────────────────
  section('verdict')
  let unexpectedFailures = 0
  let unexpectedPasses = 0
  for (const leg of legs) {
    const expectedRed = EXPECTED_RED.has(leg.label)
    if (!expectedRed && !leg.pass) {
      unexpectedFailures++
      console.log(`  [REGRESSION] green leg failed: ${leg.label}${leg.detail ? ` — ${leg.detail}` : ''}`)
    } else if (expectedRed && leg.pass) {
      unexpectedPasses++
      console.log(`  [NOT-REPRODUCED] expected-red leg passed: ${leg.label}`)
    } else if (expectedRed) {
      console.log(`  [RED-as-expected] ${leg.label}${leg.detail ? ` — ${leg.detail}` : ''}`)
    } else {
      console.log(`  [PASS] ${leg.label}`)
    }
  }
  const redCount = legs.filter(l => EXPECTED_RED.has(l.label)).length
  console.log(
    `\n${legs.length} legs: ${legs.length - redCount} green floors/dispositions, ${redCount} expected-red defect pins` +
      ` — ${unexpectedFailures} regression(s), ${unexpectedPasses} not-reproduced`,
  )
  if (EXPECTED_RED.size !== redCount) {
    console.log(`  [HARNESS] EXPECTED_RED names ${EXPECTED_RED.size} legs but ${redCount} matched — label drift`)
    process.exit(1)
  }
  process.exit(unexpectedFailures + unexpectedPasses > 0 ? 1 : 0)
}

main().catch(err => {
  console.error(`[speedster-bm-classes] ${err?.stack ?? err}`)
  process.exit(1)
})
