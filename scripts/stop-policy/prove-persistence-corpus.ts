#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const EXPECTED_RED = new Set<string>([
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
      'C12: the run snapshot carries the typed progress window',
      'progress' in run,
      'Stage-2 schema: the progress window on the snapshot',
    )
  }

  section('class 1 — an unattainable objective settles only at the operator budget, never on a repetition count')
  {
    const grind = fold('produce a photo of the finished UI', [
      { type: 'substantive', at: 2, reason: 'attempting the ask' },
      { type: 'task-transition', at: 3, taskId: 't1', title: 'produce the photo', state: 'open' },
    ])
    const d3 = evaluateStop({ ...defaults, snapshot: grind, continuationsThisTurn: 2 })
    check(
      'C1: the third zero-progress continuation is issued like the first — nothing counts repetition',
      d3.kind === 'continue' && !d3.nextAction.includes('REPLAN'),
      `third zero-progress stop attempt → ${d3.kind}`,
    )
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
      'C1: the zero-progress run settles on the operator budget, and only there',
      finalKind === 'budget-exhausted' && issued === defaults.maxContinuationsPerTurn,
      `settled as ${finalKind || 'never'} after ${issued} continuation(s)`,
    )
  }

  section('class 4 — an open task earning nothing keeps every budgeted continuation (S1)')
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
      'C4: a zero-progress open task issues exactly the budgeted continuations, none refused early',
      issued === defaults.maxContinuationsPerTurn,
      `issued ${issued}`,
    )
  }

  section('class 3 — repeating the same failed operation is never a reason to end the turn')
  {
    let repeat = fold('make the suite green', [
      { type: 'substantive', at: 2, reason: 'implementation' },
      { type: 'task-transition', at: 3, taskId: 't1', title: 'the suite', state: 'open' },
    ])
    for (let n = 1; n <= 4; n++) {
      repeat = kernel.reduceRunEvent(repeat, { type: 'tool-started', at: n * HOUR, toolName: 'Bash', toolUseId: `b${n}` })
      repeat = kernel.reduceRunEvent(repeat, { type: 'tool-effected', at: n * HOUR + 1, toolName: 'Bash', toolUseId: `b${n}`, operation: 'bash: npm test', outcome: 'failed', changedPaths: [] })
    }
    const afterFour = evaluateStop({ ...defaults, snapshot: repeat, continuationsThisTurn: 1 })
    check(
      'C3: four identical failed runs of one command earn the next continuation like any other, with no re-plan directive',
      afterFour.kind === 'continue' && !afterFour.nextAction.includes('REPLAN'),
      afterFour.kind,
    )
    check('C3: the snapshot keeps no attempt ledger, no phase and no repeat count', JSON.stringify(repeat.progress) === JSON.stringify({ progressSinceDecision: 0 }), JSON.stringify(repeat.progress))
  }

  section('interruption/kill/resume — progress state survives; nothing mints false success (2.3)')
  {
    let irun = fold('long build', [{ type: 'substantive', at: 2, reason: 'implementation' }])
    irun = kernel.reduceRunEvent(irun, {
      type: 'tool-effected', at: 3, toolName: 'Write', toolUseId: 'w1', operation: 'write', outcome: 'succeeded', changedPaths: ['/tmp/x'],
    })
    irun = kernel.reduceRunEvent(irun, { type: 'interrupted', at: 4, reason: 'operator interrupt' })
    check('interruption preserves progress and never mints completion', irun.lifecycle === 'interrupted' && irun.progress?.progressSinceDecision === 1)
    irun = kernel.reduceRunEvent(irun, { type: 'resumed', at: 5, reason: 'reconnect' })
    check('resume restores the active run with the progress window intact', irun.lifecycle === 'active' && irun.progress?.progressSinceDecision === 1)
  }

  section('class 9 — progress renews the lease; the fuse is not progress-blind (S2)')
  {
    const productiveEvents: Parameters<typeof kernel.reduceRunEvent>[1][] = [
      { type: 'substantive', at: 2, reason: 'implementation' },
      { type: 'task-transition', at: 3, taskId: 't1', title: 'land the refactor', state: 'open' },
    ]
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

  section('classes 5/11 — no strategy watcher: the evaluator takes no repetition flag and refuses nothing for it')
  {
    const run = fold('fix the build', [
      { type: 'substantive', at: 2, reason: 'implementation' },
      { type: 'task-transition', at: 3, taskId: 't1', title: 'fix the build', state: 'open' },
    ])
    const second = evaluateStop({ ...defaults, snapshot: run, continuationsThisTurn: 1 })
    check(
      'C5: a second continuation with nothing new earns the same continue as the first',
      second.kind === 'continue',
      `second continuation → ${second.kind}`,
    )
    const withFlag = evaluateStop({ ...defaults, snapshot: run, continuationsThisTurn: 1, strategyRepeated: true } as never)
    check(
      'C11: a stray repetition flag changes nothing (the evaluator has no such input)',
      JSON.stringify(withFlag) === JSON.stringify(second),
      `${withFlag.kind} vs ${second.kind}`,
    )
  }

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

    const { _resetContinuationLatchesForTesting } = await import(
      '../../src/services/run/continuationLatch.js'
    )

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
          transcript6.push({ type: 'assistant', message: { content: [{ type: 'text', text: `try ${i}` }] } })
        } else break
      }
    }
    check(
      'C6: a contradictory/unobservable mission never arms a blind block loop (at most one feasibility block)',
      blocks6 <= 1,
      `blocked ${blocks6} times before disarm`,
    )

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
