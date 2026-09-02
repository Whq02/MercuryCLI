#!/usr/bin/env bun
// ============================================================================
//  scripts/run/prove-run-completion.ts
//  ORACLE: stop/continue decisions are EVIDENCE-BASED (deliverables, tool
//  effects, verification), not wording-first — the slice-2 invariants,
//  flipped from the slice-0 FAILURE-CLASS pins in the fixing commit.
//
//  Proven here (the slice-2 acceptance list):
//   · "done" prose + an open deliverable → CONTINUE;
//   · "I'll…" prose + everything complete → COMPLETE (no wasted turn);
//   · mutation after green evidence → CONTINUE to verification;
//   · failed/indeterminate mutating effect → cannot complete;
//   · operator-owned blocker → BLOCKED once, loop terminated;
//   · continuation budget exhausted → honest budget-exhausted;
//   · abort/API error → never continue;
//   · no active run → wording-hint compatibility behavior unchanged;
//   · the continuation LATCH: many hooks, ONE continuation per stop attempt.
//
//  Run:  ~/.bun/bin/bun run scripts/run/prove-run-completion.ts
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
// these fixtures exercise the
// INTERACTIVE ask-and-continue semantics — declare the posture explicitly
// (a bare proof context reads non-interactive, which the InvocationContract
// now resolves to print/one-shot).
{
  const { setIsInteractive } = await import('../../src/bootstrap/state.js')
  setIsInteractive(true)
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

async function main(): Promise<void> {
  const ok = await import('../../src/services/run/ownerKey.js')
  const kernel = await import('../../src/services/run/runKernel.js')
  const { evaluateStop } = await import('../../src/services/run/completionEvaluator.js')
  const latch = await import('../../src/services/run/continuationLatch.js')
  const { isUnfinishedTail } = await import('../../src/utils/hooks/unfinishedTail.js')

  const owner = ok.makeOwnerKey({ workspace: '/tmp/w', sessionId: 'run-x', lane: 'main' })
  const base = () =>
    kernel.emptyRunSnapshot({
      runId: 'r1',
      owner,
      objective: 'ship the widget',
      rootMessageId: 'u1',
      at: 1,
    })
  const fold = (events: Parameters<typeof kernel.reduceRunEvent>[1][]) =>
    events.reduce((s, e) => kernel.reduceRunEvent(s, e), base())

  const defaults = {
    wordingUnfinished: false,
    continuationsThisTurn: 0,
    maxContinuationsPerTurn: 3,
    aborted: false,
    apiError: false,
    verification: { state: 'verified' as const, mutationsSinceEvidence: 0 },
    pendingIdeFeedback: false,
  }

  section('1. deliverables outrank wording')
  {
    const openRun = fold([
      { type: 'substantive', at: 2, reason: 'created tasks' },
      { type: 'task-transition', at: 3, taskId: 't1', title: 'write the parser', state: 'open' },
    ])
    // The model SAYS it's done, but a deliverable is open → continue.
    const d1 = evaluateStop({ ...defaults, snapshot: openRun, wordingUnfinished: false })
    check('"done" prose + open deliverable → continue', d1.kind === 'continue', d1.kind)
    check(
      'the continue names the concrete deliverable',
      d1.kind === 'continue' && d1.nextAction.includes('write the parser'),
    )
    // Everything closed, prose promises more work → complete, no extra turn.
    const doneRun = fold([
      { type: 'substantive', at: 2, reason: 'created tasks' },
      { type: 'task-transition', at: 3, taskId: 't1', title: 'write the parser', state: 'done' },
    ])
    check(
      'unfinished wording is still unfinished wording (hint intact)',
      isUnfinishedTail("I'll run the full gate next to be safe.") === true,
    )
    const d2 = evaluateStop({ ...defaults, snapshot: doneRun, wordingUnfinished: true })
    check('"I\'ll…" prose + complete run → complete (wording overridden)', d2.kind === 'complete', d2.kind)
  }

  section('2. effects and evidence gate completion')
  {
    const afterGreen = fold([
      { type: 'substantive', at: 2, reason: 'edit landed' },
      { type: 'task-transition', at: 3, taskId: 't1', title: 'parser', state: 'done' },
    ])
    const d3 = evaluateStop({
      ...defaults,
      snapshot: afterGreen,
      verification: { state: 'stale', mutationsSinceEvidence: 2 },
    })
    check(
      'mutation after green evidence → continue to verification',
      d3.kind === 'continue' && /verif/i.test(d3.nextAction),
      d3.kind,
    )
    const withBadEffect = fold([
      { type: 'substantive', at: 2, reason: 'edit landed' },
      {
        type: 'tool-effected',
        at: 4,
        toolName: 'LSP',
        toolUseId: 'tu9',
        operation: 'lsp.rename.apply',
        outcome: 'indeterminate',
        changedPaths: ['/tmp/a.ts'],
      },
    ])
    const d4 = evaluateStop({ ...defaults, snapshot: withBadEffect })
    check('indeterminate mutating effect → cannot complete', d4.kind === 'continue', d4.kind)
    const failedEffect = fold([
      { type: 'substantive', at: 2, reason: 'edit landed' },
      {
        type: 'tool-effected',
        at: 4,
        toolName: 'LSP',
        toolUseId: 'tu9',
        operation: 'lsp.codeaction.apply',
        outcome: 'failed',
        changedPaths: [],
      },
    ])
    const d5 = evaluateStop({ ...defaults, snapshot: failedEffect })
    check('failed mutating effect → cannot complete', d5.kind === 'continue', d5.kind)
    // A later SUCCEEDED mutating effect supersedes the bad attempts.
    const healed = kernel.reduceRunEvent(failedEffect, {
      type: 'tool-effected',
      at: 5,
      toolName: 'LSP',
      toolUseId: 'tu10',
      operation: 'lsp.codeaction.apply',
      outcome: 'succeeded',
      changedPaths: ['/tmp/a.ts'],
    })
    const d6 = evaluateStop({ ...defaults, snapshot: healed })
    check('a green mutating effect supersedes the failure → complete', d6.kind === 'complete', d6.kind)
  }

  section('3. blockers, budget, and hard outs')
  {
    const blocked = kernel.reduceRunEvent(fold([{ type: 'substantive', at: 2, reason: 'x' }]), {
      type: 'blocked',
      at: 3,
      blocker: {
        description: 'schema choice: flat vs nested',
        ownedBy: 'operator',
        resumeCondition: 'operator picks a schema',
        at: 3,
      },
    })
    const d7 = evaluateStop({ ...defaults, snapshot: blocked })
    check('operator-owned blocker → blocked (loop terminates)', d7.kind === 'blocked', d7.kind)
    const open = fold([
      { type: 'substantive', at: 2, reason: 'x' },
      { type: 'task-transition', at: 3, taskId: 't1', title: 'parser', state: 'open' },
    ])
    const d8 = evaluateStop({ ...defaults, snapshot: open, continuationsThisTurn: 3 })
    check(
      'budget exhausted → honest budget-exhausted naming the unfinished work',
      d8.kind === 'budget-exhausted' && d8.unfinished.some(u => u.includes('parser')),
      d8.kind,
    )
    check(
      'abort → cancel, never continue',
      evaluateStop({ ...defaults, snapshot: open, aborted: true }).kind === 'cancel',
    )
    check(
      'API error → fail, never continue',
      evaluateStop({ ...defaults, snapshot: open, apiError: true }).kind === 'fail',
    )
  }

  section('4. no active run → compatibility behavior')
  {
    const d9 = evaluateStop({ ...defaults, snapshot: null, wordingUnfinished: true })
    check('no run + unfinished wording → continue (compat hint)', d9.kind === 'continue')
    const d10 = evaluateStop({ ...defaults, snapshot: null, wordingUnfinished: false })
    check('no run + finished wording → complete (conversation unchanged)', d10.kind === 'complete')
    const lightweight = base() // never substantive
    const d11 = evaluateStop({ ...defaults, snapshot: lightweight, wordingUnfinished: false })
    check('non-substantive run behaves as a lightweight turn', d11.kind === 'complete')
  }

  section('5. the continuation latch: one continuation per stop attempt')
  {
    latch._resetContinuationLatchesForTesting()
    const first = latch.claimContinuation(owner, 5, 42)
    const second = latch.claimContinuation(owner, 5, 42)
    const third = latch.claimContinuation(owner, 5, 42)
    check('first hook claims', first === true)
    check('every later hook is refused for the SAME attempt', !second && !third)
    const nextAttempt = latch.claimContinuation(owner, 5, 44)
    check('a NEW stop attempt (longer transcript) re-arms the latch', nextAttempt === true)
    check('the pooled per-turn count reflects both claims', latch.continuationsThisTurn(owner, 5) === 2)
    const freshTurn = latch.continuationsThisTurn(owner, 6)
    check('a real user-turn boundary resets the pooled budget', freshTurn === 0)
    latch._resetContinuationLatchesForTesting()
  }

  section('6. vanished task → deliverable DROPS (the field "orphaned task #6" wedge)')
  {
    // a task that vanishes from the ledger between syncs (the
    // all-completed hide-timer reset, a model delete) froze its deliverable
    // open FOREVER — the evaluator demanded work no tool could reach and the
    // continuation capsule re-injected the phantom across compaction. The
    // reverse pass in syncDeliverablesFromTasks settles it as 'dropped'.
    // Hermetic per the ambient-state law: scratch config home + explicit
    // task-list id, env set BEFORE the modules under test resolve paths.
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const scratch = mkdtempSync(join(tmpdir(), 'run-orphan-proof-'))
    const prevConfig = process.env.MERCURY_CONFIG_DIR
    process.env.MERCURY_CONFIG_DIR = scratch
    try {
      const coord = await import('../../src/services/run/runCoordinator.js')
      const tasksMod = await import('../../src/utils/tasks.js')
      const orphanOwner = ok.makeOwnerKey({
        workspace: scratch,
        sessionId: 'run-orphan',
        lane: 'main',
      })
      coord.acceptUserRequest(orphanOwner, { objective: 'verify the widget', rootMessageId: 'u1' })
      const listId = tasksMod.getTaskListId()
      const tid = await tasksMod.createTask(listId, {
        subject: 'verify the widget',
        description: 'the verification task',
        status: 'pending',
        blocks: [],
        blockedBy: [],
      })
      await coord.syncDeliverablesFromTasks(orphanOwner)
      const opened = coord.getRunSnapshot(orphanOwner)
      check(
        'forward pass records the live task as an open deliverable',
        opened?.deliverables.some(d => d.id === tid && d.state === 'open') === true,
      )
      // The wipe (exactly what the hide-timer / a model delete does).
      await tasksMod.resetTaskList(listId)
      await coord.syncDeliverablesFromTasks(orphanOwner)
      const after = coord.getRunSnapshot(orphanOwner)
      const droppedD = after?.deliverables.find(d => d.id === tid)
      check('vanished task → deliverable transitions to dropped', droppedD?.state === 'dropped', String(droppedD?.state))
      const dAfter = evaluateStop({ ...defaults, snapshot: after!, wordingUnfinished: false })
      check('evaluator completes — no phantom deliverable demanded', dAfter.kind === 'complete', dAfter.kind)
      // Negative: a task still LIVE and open is never dropped by the pass.
      const tid2 = await tasksMod.createTask(listId, {
        subject: 'still live',
        description: 'must not be dropped',
        status: 'pending',
        blocks: [],
        blockedBy: [],
      })
      await coord.syncDeliverablesFromTasks(orphanOwner)
      const live2 = coord.getRunSnapshot(orphanOwner)
      check(
        'negative: a live open task is NOT dropped by the reverse pass',
        live2?.deliverables.some(d => d.id === tid2 && d.state === 'open') === true,
      )
    } finally {
      if (prevConfig === undefined) delete process.env.MERCURY_CONFIG_DIR
      else process.env.MERCURY_CONFIG_DIR = prevConfig
      rmSync(scratch, { recursive: true, force: true })
    }
  }

  section('7. the typed blocker declaration grammar (task #74 — the reachable escape)')
  {
    const { parseBlockerDeclaration, MAX_FIELD_CHARS } = await import(
      '../../src/services/run/blockerDeclaration.js'
    )
    const good = parseBlockerDeclaration(
      'Tried the migration; the staging credentials are not in the repo.\n\n' +
        'BLOCKED ON OPERATOR: need the staging DB password\n' +
        'RESUME WHEN: operator provides the password',
    )
    check(
      'well-formed declaration → declared with both fields',
      good.kind === 'declared' &&
        good.description === 'need the staging DB password' &&
        good.resumeCondition === 'operator provides the password',
      good.kind,
    )
    const decorated = parseBlockerDeclaration(
      'status\n\n- **Blocked on operator: need your API key choice**\n- **Resume when: operator names the key**',
    )
    check(
      'bulleted/bolded/case-insensitive declaration still parses',
      decorated.kind === 'declared' && decorated.description.includes('API key choice'),
      decorated.kind,
    )
    const noResume = parseBlockerDeclaration('BLOCKED ON OPERATOR: need the staging DB password')
    check(
      'missing RESUME WHEN line → refused, reason names the line',
      noResume.kind === 'refused' && /RESUME WHEN/.test(noResume.reason),
      noResume.kind,
    )
    const wrongSecond = parseBlockerDeclaration(
      'BLOCKED ON OPERATOR: need the staging DB password\nI will wait here.',
    )
    check('wrong second line → refused', wrongSecond.kind === 'refused', wrongSecond.kind)
    const trailing = parseBlockerDeclaration(
      'BLOCKED ON OPERATOR: need the staging DB password\nRESUME WHEN: operator provides the password\n\nMeanwhile I could also refactor the parser.',
    )
    check(
      'content after the declaration → refused (must end the message)',
      trailing.kind === 'refused' && /final lines/.test(trailing.reason),
      trailing.kind,
    )
    const thin = parseBlockerDeclaration('BLOCKED ON OPERATOR: stuck\nRESUME WHEN: operator provides the password')
    check(
      'no-substance description → refused (the lazy-exit bound)',
      thin.kind === 'refused' && /substance/.test(thin.reason),
      thin.kind,
    )
    const thinResume = parseBlockerDeclaration(
      'BLOCKED ON OPERATOR: need the staging DB password\nRESUME WHEN: operator answers',
    )
    check('no-substance resume condition → refused', thinResume.kind === 'refused', thinResume.kind)
    check(
      'plain prose (no marker) → none',
      parseBlockerDeclaration('All done — the gate is green and pushed.').kind === 'none',
    )
    const long = parseBlockerDeclaration(
      `BLOCKED ON OPERATOR: ${'need the thing '.repeat(40)}\nRESUME WHEN: operator provides the thing`,
    )
    check(
      'oversized field is clamped (bounded fold)',
      long.kind === 'declared' && long.description.length <= MAX_FIELD_CHARS,
    )
    // The evaluator ORDER pin: a declared blocker on the last budgeted
    // continuation reports blocked, never budget-exhausted.
    const blockedAtBudget = kernel.reduceRunEvent(
      fold([{ type: 'substantive', at: 2, reason: 'x' }]),
      {
        type: 'blocked',
        at: 3,
        blocker: {
          description: 'need the staging DB password',
          ownedBy: 'operator',
          resumeCondition: 'operator provides the password',
          at: 3,
        },
      },
    )
    const dOrder = evaluateStop({ ...defaults, snapshot: blockedAtBudget, continuationsThisTurn: 3 })
    check('blocker outranks the budget brake → blocked', dOrder.kind === 'blocked', dOrder.kind)
  }

  section('8. the escape END-TO-END: declare → blocked once → surfaced → cleared on the answer')
  {
    // Hermetic per the ambient-state law (same shape as §6): scratch config
    // home + explicit task-list id BEFORE the adapter path touches the store.
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const scratch = mkdtempSync(join(tmpdir(), 'run-blocker-proof-'))
    const prevConfig = process.env.MERCURY_CONFIG_DIR
    process.env.MERCURY_CONFIG_DIR = scratch
    try {
      const coord = await import('../../src/services/run/runCoordinator.js')
      const tasksMod = await import('../../src/utils/tasks.js')
      const adapter = await import('../../src/utils/hooks/runStopAdapter.js')
      const { buildRunCapsuleLine, buildRunRows } = await import(
        '../../src/commands/run/runInspectorModel.js'
      )
      type Msg = Parameters<typeof adapter.evaluateStopAttempt>[0]
      const mkMessages = (frames: Array<{ role: 'user' | 'assistant'; text: string }>): Msg =>
        frames.map(f =>
          f.role === 'user'
            ? { type: 'user', message: { content: f.text }, isMeta: false }
            : { type: 'assistant', message: { content: [{ type: 'text', text: f.text }] } },
        ) as unknown as Msg
      const listId = tasksMod.getTaskListId()
      const mkOwner = (sessionId: string) =>
        ok.makeOwnerKey({ workspace: scratch, sessionId, lane: 'main' })

      // ABUSE FIRST (isolated owner): a no-substance declaration is refused —
      // no blocked event, the loop continues, and the refusal reason reaches
      // BOTH the re-prompt and the /run stop-decision detail.
      const abuseOwner = mkOwner('run-blocker-abuse')
      coord.acceptUserRequest(abuseOwner, { objective: 'ship the widget', rootMessageId: 'u1' })
      const tid = await tasksMod.createTask(listId, {
        subject: 'wire the escape',
        description: 'the deliverable',
        status: 'pending',
        blocks: [],
        blockedBy: [],
      })
      const abuseVerdict = await adapter.evaluateStopAttempt(
        mkMessages([
          { role: 'user', text: 'ship the widget' },
          { role: 'assistant', text: 'BLOCKED ON OPERATOR: stuck\nRESUME WHEN: operator provides the password' },
        ]),
        { maxBlocks: 3, wordingUnfinished: false, owner: abuseOwner },
      )
      check(
        'abuse: no-substance declaration does NOT block — the loop continues',
        abuseVerdict.decision.kind === 'continue' && abuseVerdict.allowStop === false,
        abuseVerdict.decision.kind,
      )
      const abuseSnap = coord.getRunSnapshot(abuseOwner)
      check(
        'abuse: no blocked event minted, lifecycle stays active',
        abuseSnap?.lifecycle === 'active' && abuseSnap.blocker === null,
        String(abuseSnap?.lifecycle),
      )
      check(
        'abuse: the refusal reason reaches the continue re-prompt',
        abuseVerdict.decision.kind === 'continue' &&
          /blocker declaration refused/.test(abuseVerdict.decision.reason) &&
          /substance/.test(abuseVerdict.decision.reason),
      )
      check(
        'abuse: the refusal is recorded on the /run timeline (stop-decision detail)',
        /blocker declaration refused/.test(abuseSnap?.lastStopDecision?.detail ?? ''),
      )
      const reprompt = adapter.repromptWithNextAction('Keep working.', abuseVerdict.decision)
      check(
        'the continue re-prompt teaches the exact grammar',
        /BLOCKED ON OPERATOR/.test(reprompt) && /RESUME WHEN/.test(reprompt),
      )

      // THE REAL ESCAPE (fresh owner, same open task): a well-formed
      // declaration ends the loop ONCE, surfaces on /run + the capsule, and
      // the operator's next message clears it.
      const escOwner = mkOwner('run-blocker-esc')
      coord.acceptUserRequest(escOwner, { objective: 'ship the widget', rootMessageId: 'u1' })
      const declTail =
        'Tried the migration; the credentials are operator-held.\n\n' +
        'BLOCKED ON OPERATOR: need the staging DB password\n' +
        'RESUME WHEN: operator provides the password'
      const escMessages = mkMessages([
        { role: 'user', text: 'ship the widget' },
        { role: 'assistant', text: declTail },
      ])
      const escVerdict = await adapter.evaluateStopAttempt(escMessages, {
        maxBlocks: 3,
        wordingUnfinished: false,
        owner: escOwner,
      })
      check(
        'declared → the evaluator answers blocked and the stop is ALLOWED (loop terminated)',
        escVerdict.decision.kind === 'blocked' && escVerdict.allowStop === true,
        escVerdict.decision.kind,
      )
      const escSnap = coord.getRunSnapshot(escOwner)
      check(
        'the run is in the blocked lifecycle with the operator-owned blocker folded',
        escSnap?.lifecycle === 'blocked' &&
          escSnap.blocker?.ownedBy === 'operator' &&
          escSnap.blocker?.description === 'need the staging DB password' &&
          escSnap.blocker?.resumeCondition === 'operator provides the password',
        String(escSnap?.lifecycle),
      )
      check(
        'the blocker SURFACES: frame capsule names BLOCKED',
        /BLOCKED/.test(buildRunCapsuleLine(escSnap!, Date.now()) ?? ''),
      )
      check(
        'the blocker SURFACES: /run rows carry the description + resume condition',
        buildRunRows(escSnap!, Date.now()).some(
          r => r.line.includes('need the staging DB password') &&
            r.detail.some(d => d.includes('operator provides the password')),
        ),
      )
      // Terminates ONCE: a second stop attempt stays blocked-allowed and does
      // NOT mint a duplicate blocked event.
      const escVerdict2 = await adapter.evaluateStopAttempt(escMessages, {
        maxBlocks: 3,
        wordingUnfinished: false,
        owner: escOwner,
      })
      const blockedEvents =
        coord.getRunSnapshot(escOwner)?.recentEvents.filter(e => e.type === 'blocked').length ?? 0
      check(
        'a second stop attempt stays allowed with exactly ONE blocked event',
        escVerdict2.decision.kind === 'blocked' && escVerdict2.allowStop === true && blockedEvents === 1,
        `events=${blockedEvents}`,
      )
      // The operator answers → request-accepted clears the blocker and the
      // evidence loop resumes on the still-open deliverable.
      coord.acceptUserRequest(escOwner, { objective: '', rootMessageId: 'u2' })
      const cleared = coord.getRunSnapshot(escOwner)
      check(
        "the operator's next message clears the blocker (active, blocker null)",
        cleared?.lifecycle === 'active' && cleared.blocker === null,
        String(cleared?.lifecycle),
      )
      const resumedVerdict = await adapter.evaluateStopAttempt(
        mkMessages([
          { role: 'user', text: 'ship the widget' },
          { role: 'assistant', text: declTail },
          { role: 'user', text: 'password is in your env now' },
          { role: 'assistant', text: 'Resuming the migration.' },
        ]),
        { maxBlocks: 3, wordingUnfinished: false, owner: escOwner },
      )
      check(
        'after the answer the evidence loop resumes (open deliverable → continue)',
        resumedVerdict.decision.kind === 'continue' && resumedVerdict.allowStop === false,
        resumedVerdict.decision.kind,
      )
      // Housekeeping: close the task so later sections never see it.
      await tasksMod.resetTaskList(listId)
      void tid
    } finally {
      if (prevConfig === undefined) delete process.env.MERCURY_CONFIG_DIR
      else process.env.MERCURY_CONFIG_DIR = prevConfig
      rmSync(scratch, { recursive: true, force: true })
    }
  }

  section('9. the mutation-ledger loop is bounded, applicable, and settleable')
  {
    // The unsatisfiable field loop: a Desktop docs session (no verification
    // machinery) wrote files; ls/Read/shasum/cmp could never mint evidence;
    // the demand re-fired every stop attempt until the operator interrupted.
    const run = fold([
      { type: 'substantive', at: 2, reason: 'wrote the report' },
      { type: 'task-transition', at: 3, taskId: 't1', title: 'report', state: 'done' },
    ])

    // (a) APPLICABILITY: a non-verifiable workspace gets the READ-BACK
    // demand, never the gate demand.
    const d1 = evaluateStop({
      ...defaults,
      snapshot: run,
      verification: {
        state: 'stale',
        mutationsSinceEvidence: 1,
        workspaceVerifiable: false,
        priorEvidenceDemands: 0,
      },
    })
    check(
      'non-verifiable workspace → the demand asks for READ-BACK, not a gate',
      d1.kind === 'continue' && /read.*back|Read/i.test(d1.nextAction) && d1.evidenceDemand === true,
      JSON.stringify(d1),
    )

    // (b) BOUNDED RE-ARM: after two produced-nothing demands the gate
    // settles honestly with the unresolved mutations NAMED — the four-round
    // spiral is structurally unreachable.
    const d2 = evaluateStop({
      ...defaults,
      snapshot: run,
      verification: {
        state: 'stale',
        mutationsSinceEvidence: 1,
        workspaceVerifiable: false,
        priorEvidenceDemands: 2,
      },
    })
    check(
      'two produced-nothing demands → complete with the UNSETTLED note',
      d2.kind === 'complete' && d2.satisfied.some(s => s.includes('UNSETTLED')),
      JSON.stringify(d2),
    )
    // Same bound in a VERIFIABLE workspace (a stubborn code session ends
    // honestly too — the receipt carries the unverified count).
    const d2v = evaluateStop({
      ...defaults,
      snapshot: run,
      verification: {
        state: 'stale',
        mutationsSinceEvidence: 3,
        workspaceVerifiable: true,
        priorEvidenceDemands: 2,
      },
    })
    check(
      'the bound holds for verifiable workspaces too (UNSETTLED, named count)',
      d2v.kind === 'complete' && d2v.satisfied.some(s => s.includes('3 mutation(s)')),
      JSON.stringify(d2v),
    )

    // (c) THE NAG SURVIVES where it should: a verifiable workspace with an
    // unverified mutation and budget left still gets the gate demand.
    const d3 = evaluateStop({
      ...defaults,
      snapshot: run,
      verification: {
        state: 'stale',
        mutationsSinceEvidence: 1,
        workspaceVerifiable: true,
        priorEvidenceDemands: 1,
      },
    })
    check(
      'verifiable workspace + budget left → the gate demand still fires',
      d3.kind === 'continue' && /verification/.test(d3.nextAction) && d3.evidenceDemand === true,
      JSON.stringify(d3),
    )

    // (d) THE STATE LAYER: read-back settlement mints the evidence row in a
    // non-verifiable workspace and clears the counter; a verifiable
    // workspace NEVER mints from read-backs; a new mutation re-arms the
    // demand budget.
    const { mkdtempSync: mkScratch, writeFileSync: writeScratch, mkdirSync: mkdirScratch } = await import('node:fs')
    const { tmpdir: osTmp } = await import('node:os')
    const pathMod = await import('node:path')
    const vs = await import('../../src/utils/verification/verificationState.js')

    const docOwner = ok.makeOwnerKey({ workspace: '/tmp/w', sessionId: 'concord-doc', lane: 'main' })
    const docCwd = mkScratch(pathMod.join(osTmp(), 'concord-docs-'))
    const docFile = pathMod.join(docCwd, 'BUG-REPORT.md')
    writeScratch(docFile, 'report')
    vs.observeCompletedToolCall('Write', { file_path: docFile, content: 'report' }, true, docCwd, docOwner)
    let sum = vs.verificationSummary(docCwd, { skipDigest: true, owner: docOwner })
    check('docs workspace: the write marks a mutation', sum.mutationsSinceEvidence === 1, String(sum.mutationsSinceEvidence))
    check('docs workspace probes NON-verifiable', vs.workspaceVerifiable(docCwd, docOwner) === false)
    vs.observeCompletedToolCall('Read', { file_path: docFile }, true, docCwd, docOwner)
    sum = vs.verificationSummary(docCwd, { skipDigest: true, owner: docOwner })
    check(
      'read-back settles: evidence row minted, counter cleared',
      sum.mutationsSinceEvidence === 0 && sum.lastEvidence?.scope === 'read-back',
      JSON.stringify({ n: sum.mutationsSinceEvidence, scope: sum.lastEvidence?.scope }),
    )
    check('settled state reads verified (read-back coverage named)', sum.state === 'verified' && sum.detail.includes('read back'), sum.detail)

    // demand budget: two demands, then a NEW mutation re-arms it.
    vs.noteEvidenceDemandIssued(docOwner)
    vs.noteEvidenceDemandIssued(docOwner)
    check('demand counter counts', vs.evidenceDemandCount(docOwner) === 2)
    vs.observeCompletedToolCall('Write', { file_path: docFile, content: 'v2' }, true, docCwd, docOwner)
    check('a NEW mutation re-arms the demand budget', vs.evidenceDemandCount(docOwner) === 0)

    // Verifiable workspace: read-backs never mint.
    const codeOwner = ok.makeOwnerKey({ workspace: '/tmp/w', sessionId: 'concord-code', lane: 'main' })
    const codeCwd = mkScratch(pathMod.join(osTmp(), 'concord-code-'))
    writeScratch(pathMod.join(codeCwd, 'package.json'), JSON.stringify({ scripts: { test: 'bun test' } }))
    mkdirScratch(pathMod.join(codeCwd, 'src'), { recursive: true })
    const codeFile = pathMod.join(codeCwd, 'src', 'a.ts')
    writeScratch(codeFile, 'export {}')
    check('code workspace probes VERIFIABLE', vs.workspaceVerifiable(codeCwd, codeOwner) === true)
    vs.observeCompletedToolCall('Write', { file_path: codeFile, content: 'export {}' }, true, codeCwd, codeOwner)
    vs.observeCompletedToolCall('Read', { file_path: codeFile }, true, codeCwd, codeOwner)
    const codeSum = vs.verificationSummary(codeCwd, { skipDigest: true, owner: codeOwner })
    check(
      'code workspace: a read-back NEVER mints evidence (the nag survives)',
      codeSum.mutationsSinceEvidence === 1 && codeSum.lastEvidence?.scope !== 'read-back',
      JSON.stringify({ n: codeSum.mutationsSinceEvidence, scope: codeSum.lastEvidence?.scope ?? null }),
    )
    vs.disposeVerificationOwner(docOwner)
    vs.disposeVerificationOwner(codeOwner)
  }

  console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
