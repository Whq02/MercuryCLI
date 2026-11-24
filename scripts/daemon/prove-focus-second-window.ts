#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO ??= { VERSION: '0.0.0-probe' }
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'focus-second-window-')))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
delete process.env.MERCURY_HOME
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
const dir = join(SCRATCH, 'daemon')
mkdirSync(dir, { recursive: true })
const workersFile = join(dir, 'concourse-workers.json')

const workers = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')
const { evaluateLaunchAuthority } = await import('../../src/daemon/switchboard/launchAuthority.ts')
const { anotherLiveCockpitHoldsDaemon } = await import('../../src/daemon/control/ownedDaemon.ts')
const { sweepRunnerRecord } = await import('../../src/daemon/process-sweep/processSweepRun.ts')

const HINT = 'check focusConcourseSession, blurConcourseSession and terminalsFocusing in src/daemon/concourse-workers/focus.ts, launchAuthority.ts, ownedDaemon.ts and processSweepRun.ts'
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — ${[detail, HINT].filter(Boolean).join('; ')}` : ''}`)
}
const terminal = (): { pid: number; end: () => Promise<void> } => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' })
  let ended = false
  return {
    pid: child.pid!,
    end: () => {
      if (ended) return Promise.resolve()
      ended = true
      return new Promise(resolve => {
        child.once('exit', () => resolve())
        child.kill('SIGKILL')
      })
    },
  }
}

const S = '00000000-aaaa-4000-8000-000000000001'
const OTHER = '00000000-aaaa-4000-8000-000000000002'
const record = (runnerId: string, sessionId: string): Record<string, unknown> => ({ schema: 1, runnerId, sessionId, workspaceId: SCRATCH, isolation: 'exclusive', modelKey: 'fable', spawnedAt: Date.now() - 60_000, lastLiveAt: Date.now(), pid: 999_999_999 })
const seed = (): void => writeFileSync(workersFile, `${JSON.stringify({ version: 1, workers: { 'concourse-w1': record('concourse-w1', S), 'concourse-w2': record('concourse-w2', OTHER) } }, null, 1)}\n`)
const rec = (runnerId = 'concourse-w1'): { focusedBy?: string; focusedAt?: number; focusedAlso?: Array<{ by: string }>; parkedAt?: number } => (JSON.parse(readFileSync(workersFile, 'utf8')) as { workers: Record<string, never> }).workers[runnerId]!
const crewmates = (sessionId = S): string => {
  const verdict = evaluateLaunchAuthority('subagents', { dir, sessionId, roleEnvOn: true, settingOn: false, spawnSwitch: { on: true, source: 'default' } as never })
  return verdict.allowed ? verdict.posture : verdict.cause
}
const A = `operator:${process.pid}`
const second = terminal()
const third = terminal()
const B = `operator:${second.pid}`
const C = `operator:${third.pid}`

try {
  console.log('1. a second window enters a session the first still shows, and leaves')
  seed()
  workers.focusConcourseSession(S, A, dir)
  check('the first window in the session: crewmates may be launched', crewmates() === 'focused', crewmates())
  workers.focusConcourseSession(S, B, dir)
  check('the second window enters: still so, and the stamp is its own', crewmates() === 'focused' && rec().focusedBy === B, `${crewmates()} ${rec().focusedBy}`)
  const left = workers.blurConcourseSession(S, B, dir)
  check('the second window leaves: the first still shows the session, so crewmates may still be launched', crewmates() === 'focused', crewmates())
  check("the stamp is the first window's again and nothing else is kept", left.outcome === 'applied' && rec().focusedBy === A && rec().focusedAlso === undefined, JSON.stringify(rec()))
  workers.blurConcourseSession(S, A, dir)
  check('the first window leaves too: nobody shows it, the session is backgrounded', crewmates() === 'backgrounded' && rec().focusedBy === undefined, `${crewmates()} ${JSON.stringify(rec())}`)

  console.log('2. the first window leaves while the second stays')
  seed()
  workers.focusConcourseSession(S, A, dir)
  workers.focusConcourseSession(S, B, dir)
  const early = workers.blurConcourseSession(S, A, dir)
  check("the stamp stays the second window's and the first is forgotten", early.outcome === 'applied' && rec().focusedBy === B && rec().focusedAlso === undefined && crewmates() === 'focused', JSON.stringify(rec()))
  workers.blurConcourseSession(S, B, dir)
  check('then the second leaves: backgrounded', crewmates() === 'backgrounded')

  console.log('3. the second window moves on to another session')
  seed()
  workers.focusConcourseSession(S, A, dir)
  workers.focusConcourseSession(S, B, dir)
  const moved = workers.focusConcourseSession(OTHER, B, dir)
  check("the session it left is the first window's again; the other is the second's", moved.outcome === 'applied' && rec().focusedBy === A && rec('concourse-w2').focusedBy === B && crewmates() === 'focused' && crewmates(OTHER) === 'focused', `${JSON.stringify(rec())} ${JSON.stringify(rec('concourse-w2'))}`)

  console.log('4. three windows on one session')
  seed()
  workers.focusConcourseSession(S, A, dir)
  workers.focusConcourseSession(S, B, dir)
  workers.focusConcourseSession(S, C, dir)
  workers.blurConcourseSession(S, B, dir)
  check("the middle one leaves: the stamp stays the third's, the first is still kept", rec().focusedBy === C && JSON.stringify(rec().focusedAlso?.map(stamp => stamp.by)) === JSON.stringify([A]), JSON.stringify(rec()))
  workers.blurConcourseSession(S, C, dir)
  check('the third leaves: the first holds the stamp', rec().focusedBy === A && crewmates() === 'focused', JSON.stringify(rec()))

  console.log('5. a quitting window asks to park every session but those another live window shows')
  seed()
  workers.focusConcourseSession(S, A, dir)
  workers.focusConcourseSession(S, B, dir)
  const receipt = workers.parkAllConcourseSessions(B, undefined, dir, { exceptFocusedByLiveTerminal: true })
  check('the session the first window still shows is passed over', receipt.skipped.includes('concourse-w1') && rec().parkedAt === undefined, JSON.stringify(receipt))

  console.log('5b. the second window quits while the first still shows the session: who holds the daemon, and what the sweep is told')
  seed()
  workers.focusConcourseSession(S, A, dir)
  workers.focusConcourseSession(S, B, dir)
  check("the second window's own test: another live cockpit holds the daemon", anotherLiveCockpitHoldsDaemon(second.pid, workersFile) === true)
  check("the first window's own test: the second holds it too", anotherLiveCockpitHoldsDaemon(process.pid, workersFile) === true)
  const held = sweepRunnerRecord(rec() as never, 999_999_999, false).seatHolders.map((holder: { stamp: string }) => holder.stamp).sort()
  check('the sweep is told of both terminals', JSON.stringify(held) === JSON.stringify([A, B].sort()), JSON.stringify(held))
  workers.blurConcourseSession(S, B, dir)
  check('after the second window has left, its test still names the first', anotherLiveCockpitHoldsDaemon(second.pid, workersFile) === true)
  workers.blurConcourseSession(S, A, dir)
  check('nobody shows the session: no other cockpit holds the daemon', anotherLiveCockpitHoldsDaemon(second.pid, workersFile) === false && anotherLiveCockpitHoldsDaemon(process.pid, workersFile) === false)

  console.log('6. the second window ends without a word')
  seed()
  workers.focusConcourseSession(S, A, dir)
  workers.focusConcourseSession(S, B, dir)
  await second.end()
  check('at once, before any tidy: the first still shows the session, crewmates may be launched', crewmates() === 'focused', crewmates())
  workers.reconcileConcourseWorkers(new Set(['concourse-w1', 'concourse-w2']), dir)
  check('the tidy hands the stamp back to the first window', rec().focusedBy === A && rec().focusedAlso === undefined && crewmates() === 'focused', JSON.stringify(rec()))
} finally {
  await second.end()
  await third.end()
  rmSync(SCRATCH, { recursive: true, force: true })
}
console.log(failures === 0 ? '\nprove-focus-second-window: green' : `\nprove-focus-second-window: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
