#!/usr/bin/env bun
// ============================================================================
//  scripts/stop-policy/prove-persistence-corpus.ts
//  THE EXPECT-RED CORPUS (SP-0.6) — deterministic reproductions of
//  the persistence defect classes, pinned BOTH ways:
//
//   · GREEN legs are regression floors that must stay green (the #52
//     impossible-terminal, read-only finish, the typed operator blocker,
//     compaction-fold survival).
//   · EXPECTED_RED legs assert the DESIRED evidence-gated-persistence law
//     (laws S1–S8) and are REQUIRED TO FAIL on the bound tree — each failure
//     is a reproduced defect. When a Stage-2 slice lands its fix, its leg
//     moves OUT of EXPECTED_RED in the same commit (the expectation flip IS
//     the proof of behavior change). A red leg that unexpectedly PASSES
//     fails this gate too: the defect is not reproduced and the
//     disposition table must be updated before proceeding.
//
//  Fake clocks: event `at` fields span synthetic hours — the 3-hour class
//  proves in milliseconds (pure folds, no wall-clock waits).
//
//  Run:  ~/.bun/bin/bun run scripts/stop-policy/prove-persistence-corpus.ts
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

// ── the expectation contract ────────────────────────────────────────────────
// Leg labels expected RED on the bound defect tree. Stage-2 slices flip
// legs out of this set as their owners land the law.
const EXPECTED_RED = new Set<string>([
  // classes 1/4/5/9/11 FLIPPED GREEN at 2.2a (the stagnation escalation +
  // progress-aware budget + strategy/precondition inputs at evaluateStop);
  // class 12 flipped at 2.1. Their legs stay below as regression floors.
  // class 3 FLIPPED GREEN at 2.3 (the cycle guard: evaluateCycleLease over
  // the folded attempt ledger — replan on the first barren repeat, settle
  // after the spent replan, re-arm on eligible progress).
  // classes 6/7 FLIPPED GREEN at 2.5 (compileMissionContract: preflight
  // feasibility — unobservable/contradictory ⇒ ONE bounded feasibility
  // block then disarm; the file-exists grammar ⇒ already-met at compile,
  // zero burned continuations). THE CORPUS IS FULLY GREEN: every defect
  // class the 0.6 bind reproduced is closed on current main.
])

type Leg = { label: string; pass: boolean; detail: string }
const legs: Leg[] = []
function check(label: string, cond: boolean, detail = ''): void {
  legs.push({ label, pass: cond, detail })
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

async function main(): Promise<void> {
  const ok = await import('../../src/services/run/ownerKey.js')
  const kernel = await import('../../src/services/run/runKernel.js')
  const { evaluateStop } = await import('../../src/services/run/completionEvaluator.js')
  const { parseBlockerDeclaration } = await import('../../src/services/run/blockerDeclaration.js')
  const mission = await import('../../src/utils/hooks/missionHook.js')

  const owner = ok.makeOwnerKey({ workspace: '/tmp/speedster', sessionId: 'corpus', lane: 'main' })
  const HOUR = 3_600_000
  const base = (objective: string) =>
    kernel.emptyRunSnapshot({
      runId: 'speedster-corpus',
      owner,
      objective,
      rootMessageId: 'u1',
      at: 1,
    })
  const fold = (
    objective: string,
    events: Parameters<typeof kernel.reduceRunEvent>[1][],
  ) => events.reduce((s, e) => kernel.reduceRunEvent(s, e), base(objective))

  const defaults = {
    wordingUnfinished: false,
    continuationsThisTurn: 0,
    maxContinuationsPerTurn: 3,
    aborted: false,
    apiError: false,
    verification: null,
    pendingIdeFeedback: false,
  }

  // ══ class 8 · read-only correct finish (regression floor) ═════════════════
  section('class 8 — read-only / assessment work finishes without manufacturing a mutation')
  {
    const light = evaluateStop({ ...defaults, snapshot: null })
    check('C8: lightweight turn with finished tail completes', light.kind === 'complete', light.kind)
    const readOnly = fold('diagnose the flaky test', [
      { type: 'substantive', at: 2, reason: 'investigation started' },
      { type: 'task-transition', at: 3, taskId: 't1', title: 'diagnose flake', state: 'open' },
      { type: 'tool-effected', at: HOUR, toolName: 'Read', toolUseId: 'r1', operation: 'read', outcome: 'no-change', changedPaths: [] },
      { type: 'task-transition', at: 2 * HOUR, taskId: 't1', title: 'diagnose flake', state: 'done' },
    ])
    const d = evaluateStop({ ...defaults, snapshot: readOnly })
    check('C8: substantive read-only run with closed deliverables completes', d.kind === 'complete', d.kind)
  }

  // ══ class 10 · needs one operator answer (regression floor) ═══════════════
  section('class 10 — the typed operator blocker terminates the loop honestly')
  {
    const declared = parseBlockerDeclaration(
      'I need the staging API key to continue.\nBLOCKED ON OPERATOR: the staging API key\nRESUME WHEN: the key is provided in the environment',
    )
    check('C10: well-formed declaration parses as declared', declared.kind === 'declared')
    const malformed = parseBlockerDeclaration('BLOCKED ON OPERATOR: everything is hard')
    check('C10: malformed declaration (no RESUME WHEN) is refused with a reason', malformed.kind === 'refused')
    const blockedRun = fold('ship the widget', [
      { type: 'substantive', at: 2, reason: 'implementation' },
      { type: 'task-transition', at: 3, taskId: 't1', title: 'wire the API', state: 'open' },
      {
        type: 'blocked',
        at: HOUR,
        blocker: { description: 'staging API key', ownedBy: 'operator', resumeCondition: 'key provided', at: HOUR },
      },
    ])
    const d1 = evaluateStop({ ...defaults, snapshot: blockedRun })
    check('C10: operator blocker → blocked decision', d1.kind === 'blocked')
    const d2 = evaluateStop({ ...defaults, snapshot: blockedRun, continuationsThisTurn: 1 })
    check(
      'C10: a blocked run is never converted back to continue by re-evaluation',
      d2.kind !== 'continue',
      d2.kind,
    )
  }

  // ══ class 12 · compaction/restart survival (pure-fold floor + Stage-2 stub)
  section('class 12 — state survives compaction folds; progress state is typed (Stage-2)')
  {
    const run = fold('long refactor', [
      { type: 'substantive', at: 2, reason: 'implementation' },
      { type: 'task-transition', at: 3, taskId: 't1', title: 'phase 1', state: 'open' },
      { type: 'tool-effected', at: HOUR, toolName: 'Edit', toolUseId: 'e1', operation: 'edit', outcome: 'succeeded', changedPaths: ['src/a.ts'] },
      { type: 'context-epoch', at: 2 * HOUR, epoch: 2, kind: 'auto-compact', reason: 'context full' },
    ])
    check('C12: compaction fold preserves lifecycle', run.lifecycle === 'active', run.lifecycle)
    check('C12: compaction fold preserves deliverables', run.deliverables.length === 1)
    check('C12: compaction fold preserves changed-path truth', run.totalChangedPaths === 1)
    check(
      'C12: the run snapshot carries typed progress/attempt state',
      'progress' in run,
      'Stage-2 schema: progress record + attempt fingerprints on the snapshot',
    )
  }

  // ══ class 1 · unattainable objective — the 3-hour grind, in milliseconds ══
  section('class 1 — an unattainable objective settles after one changed strategy (S1/S3/S4)')
  {
    // "produce a photo": open deliverable, hours of stop attempts, ZERO
    // progress events between decisions — the field shape of.
    const grind = fold('produce a photo of the finished UI', [
      { type: 'substantive', at: 2, reason: 'attempting the ask' },
      { type: 'task-transition', at: 3, taskId: 't1', title: 'produce the photo', state: 'open' },
    ])
    const d3 = evaluateStop({ ...defaults, snapshot: grind, continuationsThisTurn: 2 })
    check(
      'C1: stagnation settles by the second no-progress continuation (one replan max)',
      d3.kind !== 'continue',
      `third zero-progress stop attempt → ${d3.kind}`,
    )
    // Walk the full loop the adapter would drive: count continues to settle.
    let issued = 0
    let finalKind = ''
    for (let attempt = 0; attempt < 10; attempt++) {
      const d = evaluateStop({ ...defaults, snapshot: grind, continuationsThisTurn: issued })
      if (d.kind === 'continue') {
        issued++
        continue
      }
      finalKind = d.kind
      break
    }
    check(
      'C1: zero-progress settle is a typed stagnation handoff, not the raw budget fuse',
      finalKind !== 'budget-exhausted' && finalKind !== '',
      `settled as ${finalKind || 'never'} after ${issued} continuation(s)`,
    )
  }

  // ══ class 4 · open task, no artifact, no evidence ═════════════════════════
  section('class 4 — an open task earning nothing stops earning continuations (S1)')
  {
    const idle = fold('improve the docs', [
      { type: 'substantive', at: 2, reason: 'task created' },
      { type: 'task-transition', at: 3, taskId: 't1', title: 'improve the docs', state: 'open' },
    ])
    let issued = 0
    for (let attempt = 0; attempt < 10; attempt++) {
      const d = evaluateStop({ ...defaults, snapshot: idle, continuationsThisTurn: issued })
      if (d.kind !== 'continue') break
      issued++
    }
    check(
      'C4: a zero-progress open task issues at most 2 automatic continuations',
      issued <= 2,
      `issued ${issued}`,
    )
  }

  // ══ class 3 · same command repeated against unchanged input ═══════════════
  section('class 3 — repeating the same failed operation is not a strategy (S3 · the 2.3 cycle guard)')
  {
    const { evaluateCycleLease } = await import('../../src/services/run/cycleLease.js')
    const { makeAttemptFingerprint } = await import('../../src/services/run/progressModel.js')
    const fpTest = makeAttemptFingerprint({ toolName: 'Bash', input: { command: 'npm test' }, cwd: '/tmp/speedster' })
    let repeat = fold('make the suite green', [{ type: 'substantive', at: 2, reason: 'implementation' }])
    repeat = kernel.reduceRunEvent(repeat, { type: 'attempt', at: HOUR, toolUseId: 'b1', fingerprint: fpTest })
    repeat = kernel.reduceRunEvent(repeat, { type: 'tool-effected', at: HOUR + 1, toolName: 'Bash', toolUseId: 'b1', operation: 'bash: npm test', outcome: 'failed', changedPaths: [] })
    const afterFirst = evaluateCycleLease(repeat, false)
    repeat = kernel.reduceRunEvent(repeat, { type: 'attempt', at: 2 * HOUR, toolUseId: 'b2', fingerprint: fpTest })
    repeat = kernel.reduceRunEvent(repeat, { type: 'tool-effected', at: 2 * HOUR + 1, toolName: 'Bash', toolUseId: 'b2', operation: 'bash: npm test', outcome: 'failed', changedPaths: [] })
    const afterSecond = evaluateCycleLease(repeat, false)
    check(
      'C3: a second identical failure without new evidence changes strategy (replan directive) instead of repeating the same next action',
      afterFirst.action === 'proceed' && afterSecond.action === 'replan',
      `first=${afterFirst.action} second=${afterSecond.action}`,
    )
    const spent = evaluateCycleLease(repeat, true)
    check('C3 floor: the next stagnant cycle after the spent replan SETTLES (no third provider call)', spent.action === 'settle', spent.action)
    const progressed = kernel.reduceRunEvent(repeat, {
      type: 'tool-effected', at: 3 * HOUR, toolName: 'Edit', toolUseId: 'e1', operation: 'edit', outcome: 'succeeded', changedPaths: ['src/fix.ts'],
    })
    check('C3 floor: eligible progress re-arms the cycle (proceed again)', evaluateCycleLease(progressed, true).action === 'proceed')
  }

  // ══ interruption/recovery · progress state survives, no false success ═════
  section('interruption/kill/resume — progress state survives; nothing mints false success (2.3)')
  {
    let irun = fold('long build', [{ type: 'substantive', at: 2, reason: 'implementation' }])
    irun = kernel.reduceRunEvent(irun, {
      type: 'tool-effected', at: 3, toolName: 'Write', toolUseId: 'w1', operation: 'write', outcome: 'succeeded', changedPaths: ['/tmp/x'],
    })
    irun = kernel.reduceRunEvent(irun, { type: 'interrupted', at: 4, reason: 'operator interrupt' })
    check('interruption preserves progress and never mints completion', irun.lifecycle === 'interrupted' && irun.progress?.totalProgress === 1)
    irun = kernel.reduceRunEvent(irun, { type: 'resumed', at: 5, reason: 'reconnect' })
    check('resume restores the active run with the ledger intact', irun.lifecycle === 'active' && irun.progress?.totalProgress === 1)
  }

  // ══ class 9 · long productive work keeps its lease (S2) ═══════════════════
  section('class 9 — progress renews the lease; the fuse is not progress-blind (S2)')
  {
    const productiveEvents: Parameters<typeof kernel.reduceRunEvent>[1][] = [
      { type: 'substantive', at: 2, reason: 'implementation' },
      { type: 'task-transition', at: 3, taskId: 't1', title: 'land the refactor', state: 'open' },
    ]
    // Six synthetic hours of REAL progress: each hour lands a distinct change
    // + green evidence (the lease-renewal signal classes 1 and 2).
    for (let h = 1; h <= 6; h++) {
      productiveEvents.push(
        { type: 'tool-effected', at: h * HOUR, toolName: 'Edit', toolUseId: `e${h}`, operation: 'edit', outcome: 'succeeded', changedPaths: [`src/slice${h}.ts`] },
        { type: 'evidence', at: h * HOUR + 1, state: 'verified', detail: `slice ${h} prover green` },
      )
    }
    const productive = fold('land the refactor', productiveEvents)
    const mid = evaluateStop({ ...defaults, snapshot: productive, continuationsThisTurn: 1 })
    check(
      'C9 floor: productive work below the budget continues (no false early-stop)',
      mid.kind === 'continue',
      mid.kind,
    )
    const boundary = evaluateStop({ ...defaults, snapshot: productive, continuationsThisTurn: 3 })
    check(
      'C9: real progress since the last decision renews the lease at the budget boundary (no progress-blind fuse)',
      boundary.kind !== 'budget-exhausted',
      `at the ceiling with fresh progress → ${boundary.kind}`,
    )
  }

  // ══ class 5 + 11 · strategy novelty + precondition-changed retry ══════════
  section('classes 5/11 — strategy fingerprints: repeats stop, changed preconditions re-arm (S3)')
  {
    const run = fold('fix the build', [
      { type: 'substantive', at: 2, reason: 'implementation' },
      { type: 'task-transition', at: 3, taskId: 't1', title: 'fix the build', state: 'open' },
    ])
    const repeated = evaluateStop({
      ...defaults,
      snapshot: run,
      continuationsThisTurn: 1,
      strategyRepeated: true,
    } as never)
    check(
      'C5: the evaluator is strategy-aware — a repeated normalized strategy without new evidence does not earn another continuation',
      repeated.kind !== 'continue',
      `repeated strategy → ${repeated.kind}`,
    )
    const rearmed = evaluateStop({
      ...defaults,
      snapshot: run,
      continuationsThisTurn: 1,
      strategyRepeated: true,
      preconditionChanged: true,
    } as never)
    check(
      'C11: a changed precondition re-arms a retry that a bare repeat does not (the pair must differ)',
      rearmed.kind !== repeated.kind,
      `repeat=${repeated.kind} vs precondition-changed=${rearmed.kind}`,
    )
  }

  // ══ classes 6/7 · the mission hook: blind loops and already-met conditions ═══
  section('classes 6/7 — /mission: contradictory conditions and already-met missions (S5)')
  {
    type HookCallback = (m: unknown[]) => boolean | Promise<boolean>
    type HookEntry = { hook: { type: string; id: string; callback: HookCallback } }
    type MatcherEntry = { matcher: string; hooks: HookEntry[] }
    type HookStore = { hooks: Record<string, MatcherEntry[]> }
    type AppStateish = { sessionHooks: Map<string, HookStore> }
    const state: AppStateish = { sessionHooks: new Map() }
    const setAppState = (updater: (prev: AppStateish) => AppStateish): void => {
      const next = updater(state)
      state.sessionHooks = next.sessionHooks
    }
    const messagesNoSentinel = [
      { type: 'user', message: { content: 'go' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'still working on it' }] } },
    ]

    // 2.2c: the mission hook claims through the SHARED continuation latch — the
    // fixtures model the REAL loop (each blocked attempt grows the
    // transcript, minting a NEW stop attempt) and reset the latch between
    // classes so claims never cross-contaminate.
    const { _resetContinuationLatchesForTesting } = await import(
      '../../src/services/run/continuationLatch.js'
    )

    // class 6: contradictory / unobservable condition
    _resetContinuationLatchesForTesting()
    mission.setActiveMission(setAppState as never, 'ensure X is simultaneously enabled and disabled with no observable check', {
      sessionId: 'speedster-c6',
    })
    const stopHooks6 = state.sessionHooks.get('speedster-c6')?.hooks['Stop'] ?? []
    const cb6 = stopHooks6[0]?.hooks[0]?.hook.callback
    check('C6 harness: the mission hook registered', typeof cb6 === 'function')
    let blocks6 = 0
    if (cb6) {
      const transcript6: unknown[] = [...messagesNoSentinel]
      for (let i = 0; i < 14; i++) {
        const allow = await cb6(transcript6)
        if (allow === false) {
          blocks6++
          // The model's next try after a block: the transcript grows.
          transcript6.push({ type: 'assistant', message: { content: [{ type: 'text', text: `try ${i}` }] } })
        } else break
      }
    }
    check(
      'C6: a contradictory/unobservable mission never arms a blind block loop (at most one feasibility block)',
      blocks6 <= 1,
      `blocked ${blocks6} times before disarm`,
    )

    // class 7: already-satisfied condition
    _resetContinuationLatchesForTesting()
    mission.setActiveMission(setAppState as never, 'the file scripts/stop-policy/prove-persistence-corpus.ts exists in the repository', {
      sessionId: 'speedster-c7',
    })
    const cb7 = state.sessionHooks.get('speedster-c7')?.hooks['Stop']?.[0]?.hooks[0]?.hook.callback
    check('C7 harness: the mission hook registered', typeof cb7 === 'function')
    const firstEval = cb7 ? await cb7(messagesNoSentinel) : null
    check(
      'C7: an already-satisfied mission finishes immediately (no burned continuation)',
      firstEval === true,
      `first evaluation → ${firstEval === true ? 'allowed stop' : 'blocked'}`,
    )
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
    `\n${legs.length} legs: ${legs.length - redCount} green floors, ${redCount} expected-red defect pins` +
      ` — ${unexpectedFailures} regression(s), ${unexpectedPasses} not-reproduced`,
  )
  if (EXPECTED_RED.size !== redCount) {
    console.log(`  [HARNESS] EXPECTED_RED names ${EXPECTED_RED.size} legs but ${redCount} matched — label drift`)
    process.exit(1)
  }
  process.exit(unexpectedFailures + unexpectedPasses > 0 ? 1 : 0)
}

main().catch(err => {
  console.error(`[speedster-corpus] ${err?.stack ?? err}`)
  process.exit(1)
})
