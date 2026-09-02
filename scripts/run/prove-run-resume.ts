#!/usr/bin/env bun
// ============================================================================
//  scripts/run/prove-run-resume.ts
//  ORACLE: conversation-level implementation runs are DURABLE — a schema-
//  versioned atomic sidecar that survives interruption and reconciles on
//  resume (slice-2 invariants, flipped from the slice-0 absence pins).
//
//  Proven here:
//   · sidecar round trip (atomic write → load → identical snapshot);
//   · corrupt bytes → explicit recoverable state, never a fabricated run;
//   · newer schema → recoverable, never misread;
//   · reconcile: interruption marked, pending tools become uncertainty
//     markers, next action chosen, snapshot persisted BEFORE continuing;
//   · a terminal (completed) run is a receipt — resume never reactivates it
//     and never replays its effects;
//   · crash-after-effect-before-flush: the reconciled fold never invents a
//     completion for the interrupted call.
//
//  Hermetic: MERCURY_CONFIG_DIR is pinned to a temp dir BEFORE any src import
//  so sidecars land in the fixture, never the operator's home.
// ============================================================================

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
    // Crash happened while tu2 was in flight: started, never terminal.
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
    writeFileSync(file, '{"schema":1,"snapsho', 'utf8') // torn write
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
      // The reconciled snapshot was PERSISTED before continuing.
      const persisted = JSON.parse(readFileSync(sidecar.runSidecarPath(owner), 'utf8')) as {
        snapshot: { lifecycle: string }
      }
      check('reconciled snapshot persisted before continuing', persisted.snapshot.lifecycle === 'active')
    }
  }

  section('4. a terminal run is a receipt — never reactivated')
  {
    const done = kernel.reduceRunEvent(snapshot, {
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
    // Print mode and an interactive resume must produce the SAME folded
    // snapshot from byte-identical sidecar input. The launcher's road is
    // foldResumedRunForBoot; the print road calls reconcileOnResume
    // directly — feed both the same bytes under sibling owners and compare
    // the owner-independent projection (timestamps excluded by design).
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
    // The one-shot notice latch: the fold with pending tools latches the
    // count; consuming it empties it.
    const notice = coordinator.takeResumeFoldNotice()
    check('the boot fold latched its notice (1 interrupted tool, no blocker)', notice !== null && notice.interruptedTools === 1 && notice.blocker === null, JSON.stringify(notice))
    check('the notice is one-shot', coordinator.takeResumeFoldNotice() === null)

    // A blocked sidecar re-surfaces its blocker through the fold AND the notice.
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

    // A terminal sidecar is a receipt on the boot road too; no notice latches.
    const terminalBootOwner = ok.makeOwnerKey({ workspace: '/tmp/w', sessionId: 'agree-done', lane: 'main' })
    const doneAgain = kernel.reduceRunEvent(snapshot, { type: 'completed', at: 9, satisfied: ['done'] })
    mkdirSync(dirname(sidecar.runSidecarPath(terminalBootOwner)), { recursive: true })
    await sidecar.saveRunSidecar(terminalBootOwner, { ...doneAgain, owner: terminalBootOwner })
    const foldedDone = await coordinator.foldResumedRunForBoot(terminalBootOwner, process.cwd())
    check('a terminal sidecar is not reactivated on the boot road', foldedDone.state === 'terminal')
    check('a terminal fold latches no notice', coordinator.takeResumeFoldNotice() === null)

    // A fresh owner (no sidecar — the fresh-launch shape) folds nothing.
    const freshOwner = ok.makeOwnerKey({ workspace: '/tmp/w', sessionId: 'agree-fresh', lane: 'main' })
    const foldedFresh = await coordinator.foldResumedRunForBoot(freshOwner, process.cwd())
    check('a fresh launch runs no fold (no sidecar → none)', foldedFresh.state === 'none')
    check('…and latches no notice', coordinator.takeResumeFoldNotice() === null)

    // The wiring, structural: the interactive launcher awaits the fold on
    // the same block that awaits boot recovery, and the REPL boot effect
    // consumes the latch.
    const launcherSrc = readFileSync(join(import.meta.dir, '../../src/replLauncher.tsx'), 'utf8')
    check('replLauncher awaits foldResumedRunForBoot', /foldResumedRunForBoot\(processMainOwner\(\), getCwd\(\)\)/.test(launcherSrc))
    check('…after runBootRecovery in the same launch', launcherSrc.includes('runBootRecovery') && launcherSrc.indexOf('runBootRecovery') < launcherSrc.indexOf('foldResumedRunForBoot'))
    const replSrc = readFileSync(join(import.meta.dir, '../../src/screens/REPL.tsx'), 'utf8')
    check('the REPL boot effect consumes takeResumeFoldNotice', /takeResumeFoldNotice\(\)/.test(replSrc))
  }

  rmSync(HOME, { recursive: true, force: true })
  console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
