#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'run-resume-home-'))
process.env.MERCURY_CONFIG_DIR = HOME

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
  const sidecar = await import('../../src/services/run/runSidecar.js')
  const coordinator = await import('../../src/services/run/runCoordinator.js')

  const owner = ok.makeOwnerKey({ workspace: '/tmp/w', sessionId: 'resume-sess', lane: 'main' })

  const interrupted = [
    { type: 'substantive', at: 2, reason: 'edits landed' } as const,
    { type: 'task-transition', at: 3, taskId: 't1', title: 'parser', state: 'done' } as const,
    { type: 'task-transition', at: 4, taskId: 't2', title: 'emitter', state: 'open' } as const,
    {
      type: 'tool-effected',
      at: 5,
      toolName: 'Edit',
      toolUseId: 'tu1',
      operation: 'edit',
      outcome: 'succeeded',
      changedPaths: ['/tmp/w/parser.ts'],
    } as const,
    { type: 'tool-started', at: 6, toolName: 'Bash', toolUseId: 'tu2' } as const,
  ]
  const snapshot = interrupted.reduce(
    (s, e) => kernel.reduceRunEvent(s, e as never),
    kernel.emptyRunSnapshot({
      runId: 'run-1',
      owner,
      objective: 'build the compiler',
      rootMessageId: 'u1',
      at: 1,
    }),
  )

  section('1. sidecar round trip is atomic and faithful')
  {
    await sidecar.saveRunSidecar(owner, snapshot)
    const loaded = await sidecar.loadRunSidecar(owner)
    check('load state = loaded', loaded.state === 'loaded')
    check(
      'snapshot round-trips byte-faithfully',
      loaded.state === 'loaded' && JSON.stringify(loaded.snapshot) === JSON.stringify(snapshot),
    )
  }

  section('2. corruption and newer schemas are explicit recoverable states')
  {
    const file = sidecar.runSidecarPath(owner)
    writeFileSync(file, '{"schema":1,"snapsho', 'utf8')
    const torn = await sidecar.loadRunSidecar(owner)
    check('torn bytes → recoverable, never a fabricated run', torn.state === 'recoverable')
    writeFileSync(file, JSON.stringify({ schema: 999, snapshot: {} }), 'utf8')
    const newer = await sidecar.loadRunSidecar(owner)
    check(
      'newer schema → recoverable with the reason named',
      newer.state === 'recoverable' && /newer/.test((newer as { reason: string }).reason),
    )
    const missingOwner = ok.makeOwnerKey({ workspace: '/tmp/w', sessionId: 'nobody', lane: 'main' })
    const none = await sidecar.loadRunSidecar(missingOwner)
    check('absent sidecar → none', none.state === 'none')
    const rec = await coordinator.reconcileOnResume(owner, process.cwd())
    check('coordinator surfaces recoverable (no fake run)', rec.state === 'recoverable')
    writeFileSync(
      file,
      JSON.stringify({ schema: 1, writeSeq: 3, snapshot: { ...snapshot, pendingTools: null, deliverables: [null] } }),
      'utf8',
    )
    const malformed = await sidecar.loadRunSidecar(owner)
    check(
      'a whole envelope over a malformed snapshot → recoverable, the snapshot named in the reason',
      malformed.state === 'recoverable' && /snapshot/.test((malformed as { reason: string }).reason),
      JSON.stringify(malformed),
    )
    let recMalformed: { state: string }
    try {
      recMalformed = await coordinator.reconcileOnResume(owner, process.cwd())
    } catch (e) {
      recMalformed = { state: `threw: ${e}` }
    }
    check(
      'the coordinator surfaces the malformed snapshot as recoverable, never a throw',
      recMalformed.state === 'recoverable',
      recMalformed.state,
    )
    const olderOwner = ok.makeOwnerKey({ workspace: '/tmp/w', sessionId: 'resume-older', lane: 'main' })
    const older = {
      schema: 1,
      runId: 'older-run',
      owner: olderOwner,
      rootMessageId: null,
      objective: 'a run recorded by an older build',
      startedAt: 1,
      updatedAt: 2,
      lifecycle: 'active',
      substantive: true,
      phase: 'implementation',
      phaseReason: 'seeded',
      deliverables: [],
      lastAction: '',
      nextAction: 'keep going',
      blocker: null,
      changedPaths: [],
      totalChangedPaths: 0,
      recentEvents: [],
      verification: { state: 'unknown', detail: '' },
    }
    const olderFile = sidecar.runSidecarPath(olderOwner)
    mkdirSync(dirname(olderFile), { recursive: true })
    writeFileSync(
      olderFile,
      JSON.stringify({ schema: 1, writeSeq: 4, operationId: 'older-op', committedAt: '2026-07-01T00:00:00.000Z', snapshot: older }),
      'utf8',
    )
    const loadedOlder = await sidecar.loadRunSidecar(olderOwner)
    check(
      "an older build's snapshot loads whole, its absent tails read as empty",
      loadedOlder.state === 'loaded' &&
        Array.isArray(loadedOlder.snapshot.pendingTools) &&
        loadedOlder.snapshot.pendingTools.length === 0 &&
        Array.isArray(loadedOlder.snapshot.recentEffects) &&
        loadedOlder.snapshot.recentEffects.length === 0 &&
        loadedOlder.snapshot.totalEvents === 0,
      JSON.stringify(loadedOlder),
    )
    let recOlder: { state: string }
    try {
      recOlder = await coordinator.reconcileOnResume(olderOwner, process.cwd())
    } catch (e) {
      recOlder = { state: `threw: ${e}` }
    }
    check("an older build's run reconciles on resume without a throw", recOlder.state === 'reconciled', recOlder.state)
  }

  section('3. resume reconciliation (interrupted run)')
  {
    await sidecar.saveRunSidecar(owner, snapshot)
    const rec = await coordinator.reconcileOnResume(owner, process.cwd())
    check('reconciled', rec.state === 'reconciled')
    if (rec.state === 'reconciled') {
      const s = rec.snapshot
      check('the run is ACTIVE again (interrupted → resumed)', s.lifecycle === 'active')
      check(
        'the interruption is recorded in the event tail',
        s.recentEvents.some(e => e.type === 'interrupted'),
      )
      check(
        'the in-flight tool survives as an uncertainty marker',
        s.pendingTools.some(p => p.toolUseId === 'tu2'),
      )
      check(
        'completed work is NOT replayed (t1 stays done, its effect count intact)',
        s.deliverables.find(d => d.id === 't1')?.state === 'done' &&
          s.totalChangedPaths === 1,
      )
      check(
        'the next action inspects the interrupted call first',
        /inspect the interrupted/.test(s.nextAction),
        s.nextAction,
      )
      const persisted = JSON.parse(readFileSync(sidecar.runSidecarPath(owner), 'utf8')) as {
        snapshot: { lifecycle: string }
      }
      check('reconciled snapshot persisted before continuing', persisted.snapshot.lifecycle === 'active')
    }
  }

  section('4. a terminal run is a receipt — never reactivated')
  {
    const finished = kernel.reduceRunEvent(snapshot, { type: 'task-transition', at: 8, taskId: 't2', title: 'emitter', state: 'done' })
    const done = kernel.reduceRunEvent(finished, {
      type: 'completed',
      at: 9,
      satisfied: ['all deliverables closed'],
    })
    const doneOwner = ok.makeOwnerKey({ workspace: '/tmp/w', sessionId: 'done-sess', lane: 'main' })
    mkdirSync(dirname(sidecar.runSidecarPath(doneOwner)), { recursive: true })
    await sidecar.saveRunSidecar(doneOwner, { ...done, owner: doneOwner })
    const rec = await coordinator.reconcileOnResume(doneOwner, process.cwd())
    check('terminal sidecar loads as terminal', rec.state === 'terminal')
    if (rec.state === 'terminal') {
      check('lifecycle untouched (completed stays completed)', rec.snapshot.lifecycle === 'completed')
    }
  }

  section('4b. a record that reads complete with open deliverables resumes reopened, as the same run')
  {
    const contradiction = { ...snapshot, lifecycle: 'completed' as const, phase: 'done', phaseReason: 'UNSATISFIED: 1 open', nextAction: '', pendingTools: [] }
    const stuckOwner = ok.makeOwnerKey({ workspace: '/tmp/w', sessionId: 'stuck-sess', lane: 'main' })
    mkdirSync(dirname(sidecar.runSidecarPath(stuckOwner)), { recursive: true })
    await sidecar.saveRunSidecar(stuckOwner, { ...contradiction, owner: stuckOwner })
    const rec = await coordinator.reconcileOnResume(stuckOwner, process.cwd())
    check('the contradiction loads as reconciled, not as a terminal receipt', rec.state === 'reconciled', rec.state)
    if (rec.state === 'reconciled') {
      check('the run is active with the deliverable still open', rec.snapshot.lifecycle === 'active' && rec.snapshot.deliverables.some(d => d.id === 't2' && d.state === 'open'), rec.snapshot.lifecycle)
      check('the same run continues (run id kept)', rec.snapshot.runId === snapshot.runId, rec.snapshot.runId)
      check('the next action names the open deliverable', /continue the open deliverable: emitter/.test(rec.snapshot.nextAction), rec.snapshot.nextAction)
      check('the reopen is on the timeline', rec.snapshot.recentEvents.some(e => e.type === 'resumed'), JSON.stringify(rec.snapshot.recentEvents.map(e => e.type)))
    }
    const persisted = JSON.parse(readFileSync(sidecar.runSidecarPath(stuckOwner), 'utf8')) as { snapshot: { lifecycle: string } }
    check('the reopened record is persisted before continuing', persisted.snapshot.lifecycle === 'active', persisted.snapshot.lifecycle)
  }

  section('5. agent lanes never persist sidecars (workflow manifests own that lane)')
  {
    const agentOwner = ok.makeOwnerKey({
      workspace: '/tmp/w',
      sessionId: 'resume-sess',
      lane: 'agent:sub7',
    })
    coordinator.acceptUserRequest(agentOwner, { objective: 'sub work', rootMessageId: null })
    coordinator.noteRunEvent(agentOwner, { type: 'substantive', at: 2, reason: 'edit' })
    await coordinator.flushRun(agentOwner)
    const load = await sidecar.loadRunSidecar(agentOwner)
    check('agent-lane run stays in-memory (no sidecar file)', load.state === 'none')
  }

  section('6. the interactive boot fold (FN-013 CRASH-02) — same fold, one notice')
  {
    const projection = (s: {
      lifecycle: string
      phaseReason?: string
      nextAction: string
      pendingTools: Array<{ toolName: string; toolUseId: string | undefined }>
      blocker: { description: string } | null
    }): string =>
      JSON.stringify({
        lifecycle: s.lifecycle,
        phaseReason: s.phaseReason,
        nextAction: s.nextAction,
        pending: s.pendingTools.map(p => `${p.toolName}#${p.toolUseId}`),
        blocker: s.blocker?.description ?? null,
      })
    const printOwner = ok.makeOwnerKey({ workspace: '/tmp/w', sessionId: 'agree-print', lane: 'main' })
    const bootOwner = ok.makeOwnerKey({ workspace: '/tmp/w', sessionId: 'agree-boot', lane: 'main' })
    for (const o of [printOwner, bootOwner]) {
      mkdirSync(dirname(sidecar.runSidecarPath(o)), { recursive: true })
      await sidecar.saveRunSidecar(o, { ...snapshot, owner: o })
    }
    const viaPrint = await coordinator.reconcileOnResume(printOwner, process.cwd())
    const viaBoot = await coordinator.foldResumedRunForBoot(bootOwner, process.cwd())
    check('both roads reconcile', viaPrint.state === 'reconciled' && viaBoot.state === 'reconciled')
    if (viaPrint.state === 'reconciled' && viaBoot.state === 'reconciled') {
      check(
        'byte-identical input folds to the same snapshot on both roads',
        projection(viaPrint.snapshot) === projection(viaBoot.snapshot),
        `print=${projection(viaPrint.snapshot)} boot=${projection(viaBoot.snapshot)}`,
      )
      check(
        'the interrupted event carries the in-flight count',
        viaBoot.snapshot.recentEvents.some(
          e => e.type === 'interrupted' && /1 tool call\(s\) interrupted mid-flight/.test((e as { reason?: string }).reason ?? ''),
        ),
      )
    }
    const notice = coordinator.takeResumeFoldNotice()
    check('the boot fold latched its notice (1 interrupted tool, no blocker)', notice !== null && notice.interruptedTools === 1 && notice.blocker === null, JSON.stringify(notice))
    check('the notice is one-shot', coordinator.takeResumeFoldNotice() === null)

    const blocked = kernel.reduceRunEvent(snapshot, {
      type: 'blocked',
      at: 7,
      blocker: { description: 'needs the API key decision', ownedBy: 'operator', resumeCondition: 'operator answers the key question', at: 7 },
    })
    const blockedOwner = ok.makeOwnerKey({ workspace: '/tmp/w', sessionId: 'agree-blocked', lane: 'main' })
    mkdirSync(dirname(sidecar.runSidecarPath(blockedOwner)), { recursive: true })
    await sidecar.saveRunSidecar(blockedOwner, { ...blocked, owner: blockedOwner })
    const foldedBlocked = await coordinator.foldResumedRunForBoot(blockedOwner, process.cwd())
    check(
      'a blocked sidecar re-surfaces its blocker on the boot road',
      foldedBlocked.state === 'reconciled' && foldedBlocked.snapshot.lifecycle === 'blocked' && foldedBlocked.snapshot.blocker?.description === 'needs the API key decision',
    )
    const blockedNotice = coordinator.takeResumeFoldNotice()
    check('the notice carries the re-emitted blocker', blockedNotice?.blocker?.description === 'needs the API key decision', JSON.stringify(blockedNotice))

    const terminalBootOwner = ok.makeOwnerKey({ workspace: '/tmp/w', sessionId: 'agree-done', lane: 'main' })
    const doneAgain = kernel.reduceRunEvent(
      kernel.reduceRunEvent(snapshot, { type: 'task-transition', at: 8, taskId: 't2', title: 'emitter', state: 'done' }),
      { type: 'completed', at: 9, satisfied: ['done'] },
    )
    mkdirSync(dirname(sidecar.runSidecarPath(terminalBootOwner)), { recursive: true })
    await sidecar.saveRunSidecar(terminalBootOwner, { ...doneAgain, owner: terminalBootOwner })
    const foldedDone = await coordinator.foldResumedRunForBoot(terminalBootOwner, process.cwd())
    check('a terminal sidecar is not reactivated on the boot road', foldedDone.state === 'terminal')
    check('a terminal fold latches no notice', coordinator.takeResumeFoldNotice() === null)

    const freshOwner = ok.makeOwnerKey({ workspace: '/tmp/w', sessionId: 'agree-fresh', lane: 'main' })
    const foldedFresh = await coordinator.foldResumedRunForBoot(freshOwner, process.cwd())
    check('a fresh launch runs no fold (no sidecar → none)', foldedFresh.state === 'none')
    check('…and latches no notice', coordinator.takeResumeFoldNotice() === null)

    const launcherSrc = readFileSync(join(import.meta.dir, '../../src/replLauncher.tsx'), 'utf8')
    const recoveryCallAt = launcherSrc.search(/const recovery = runBootRecovery\(\{/)
    const recoveryRaceAt = launcherSrc.search(/const report = await Promise\.race\(\[\s*recovery,/)
    const foldCallAt = launcherSrc.search(/foldResumedRunForBoot\(processMainOwner\(\), getCwd\(\)\)/)
    const foldRaceAt = launcherSrc.search(/await Promise\.race\(\[\s*foldResumedRunForBoot\(processMainOwner\(\), getCwd\(\)\),/)
    check('replLauncher awaits foldResumedRunForBoot inside its own bounded race', foldCallAt !== -1 && foldRaceAt !== -1 && foldRaceAt < foldCallAt && launcherSrc.slice(foldRaceAt, foldCallAt + 400).includes('BOOT_RECOVERY_BUDGET_MS'))
    check('the launcher INVOKES runBootRecovery and awaits it inside a bounded race (the late-completion contract, not a full wait)', recoveryCallAt !== -1 && recoveryRaceAt !== -1 && recoveryCallAt < recoveryRaceAt && launcherSrc.slice(recoveryRaceAt, recoveryRaceAt + 300).includes('BOOT_RECOVERY_BUDGET_MS'))
    check('…and that recovery invocation and its race both precede the resume-fold invocation', recoveryCallAt !== -1 && recoveryRaceAt !== -1 && foldCallAt !== -1 && recoveryRaceAt < foldCallAt)
    const replSrc = readFileSync(join(import.meta.dir, '../../src/screens/REPL.tsx'), 'utf8')
    check('the REPL boot effect consumes takeResumeFoldNotice', /takeResumeFoldNotice\(\)/.test(replSrc))
  }

  rmSync(HOME, { recursive: true, force: true })
  console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
