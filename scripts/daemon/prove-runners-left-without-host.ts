#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConcourseWorkerRecordV1 } from '../../src/daemon/concourseWorkers.ts'

const SCRATCH = mkdtempSync(join(tmpdir(), 'runners-left-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
process.env.MERCURY_DAEMON_DIR = join(SCRATCH, 'daemon')
delete process.env.MERCURY_HOME
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
mkdirSync(process.env.MERCURY_DAEMON_DIR, { recursive: true })

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const j = (value: unknown): string => JSON.stringify(value)

const sup = await import('../../src/daemon/concourseWorkers.ts')
const { getProcessStartTokenAsync, isProcessAlive } = await import('../../src/daemon/ownerWatch.ts')
const snapshot = await import('../../src/services/concourse/concourseSnapshot.ts')

const dir = process.env.MERCURY_DAEMON_DIR!
const now = Date.now()
const sid = (tail: string): string => `00000000-dddd-4000-8000-${tail.padStart(12, '0')}`
const children: ChildProcess[] = []
const standIn = (): number => {
  const child = spawn('sleep', ['300'], { stdio: 'ignore' })
  children.push(child)
  return child.pid!
}
const until = async (pred: () => boolean, ms: number): Promise<boolean> => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (pred()) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return pred()
}
async function seed(n: string, pid: number, over: Partial<ConcourseWorkerRecordV1> = {}): Promise<string> {
  const runnerId = `concourse-w${n}`
  const procStart = await getProcessStartTokenAsync(pid)
  sup.updateConcourseWorkers(workers => {
    workers[runnerId] = {
      schema: 1,
      runnerId,
      sessionId: sid(n),
      workspaceId: SCRATCH,
      isolation: 'exclusive',
      modelKey: 'claude-sonnet-5',
      spawnedAt: now - 60_000,
      lastLiveAt: now - 60_000,
      pid,
      ...(procStart ? { procStart } : {}),
      lastDeliveryAt: now - 1_000,
      lastTurnSettledAt: now - 5_000,
      ...over,
    } as ConcourseWorkerRecordV1
  }, dir)
  return runnerId
}
const rec = (runnerId: string): ConcourseWorkerRecordV1 | undefined => sup.readSessionWorkers(dir)[runnerId]
const sweep = (sup as { endRunnersLeftWithoutHost?: typeof sup.endRunnersLeftWithoutHost }).endRunnersLeftWithoutHost

console.log('R1 a runner whose daemon died has no host: the daemon that comes after ends it, and the session waits for its next message')
{
  const left = standIn()
  const mine = standIn()
  const held = standIn()
  const withYou = standIn()
  const strangers = standIn()
  const unnamed = standIn()
  await new Promise(resolve => setTimeout(resolve, 150))
  const leftId = await seed('1', left)
  const mineId = await seed('2', mine)
  const heldId = await seed('3', held)
  const withYouId = await seed('4', withYou, { attachedAt: now - 10_000, attachedBy: `operator:${process.pid}` })
  const strangersId = await seed('5', strangers, { procStart: 'Thu Jan  1 00:00:00 2015' })
  const unnamedId = await seed('6', unnamed)
  sup.updateConcourseWorkers(workers => { delete workers[unnamedId]!.procStart }, dir)
  const parkedId = await seed('7', standIn(), { parkedAt: now - 30_000, parkedBy: 'operator:test' })
  const hosted = (runnerId: string): boolean => runnerId === mineId || runnerId === heldId
  check('before: the record of the left runner reads working, and a revive of its session answers already-live (nothing can reach it)', sup.concourseRecordState(rec(leftId)!, { needsYou: false, alive: true }) === 'working' && sup.reviveConcourseWorker(sid('1'), 'auto-revive', undefined, undefined, dir).outcome === 'noop')
  const ended = sweep === undefined ? [] : await sweep(hosted, dir, { graceMs: 1_500 })
  check('the runner nobody hosts is ended, and so is one left alive under a parked record', (await until(() => !isProcessAlive(left) && !isProcessAlive(rec(parkedId)!.pid!), 3_000)) && ended.map(e => e.runnerId).sort().join(',') === [leftId, parkedId].sort().join(','), j({ ended, leftAlive: isProcessAlive(left) }))
  check("a runner this daemon's roster holds, and one a living predecessor still hosts, are left alone", isProcessAlive(mine) && isProcessAlive(held))
  check('a session that is with the operator in his terminal is left alone', isProcessAlive(withYou))
  check('a pid that is not the recorded process any more, and a record with no start token, are left alone: only a proven runner of ours is ended', isProcessAlive(strangers) && isProcessAlive(unnamed))
  const after = rec(leftId)!
  check("the session is neither parked nor stopped nor ended by it; its row reads as it does when a runner's process is gone", after.parkedAt === undefined && after.stoppedAt === undefined && after.endedAt === undefined && sup.concourseRecordState(after, { needsYou: false, alive: false }) === 'needs-you' && snapshot.concourseNowLabel(after, { needsYou: false, alive: false }, Date.now()) === 'its process is gone', j({ state: sup.concourseRecordState(after, { needsYou: false, alive: false }), label: snapshot.concourseNowLabel(after, { needsYou: false, alive: false }, Date.now()) }))
  check('…and its next message can bring it back: the revive no longer answers already-live', sup.reviveConcourseWorker(sid('1'), 'auto-revive', undefined, undefined, dir).outcome !== 'noop', j(sup.reviveConcourseWorker(sid('1'), 'auto-revive', undefined, undefined, dir)))
  const again = sweep === undefined ? [] : await sweep(hosted, dir, { graceMs: 500 })
  check('a second pass ends nothing', again.length === 0, j(again))
}

console.log('R2 the daemon runs it as it takes the home, before it answers anyone')
{
  const main = readFileSync(join(import.meta.dir, '..', '..', 'src', 'daemon', 'main.ts'), 'utf8')
  const at = main.indexOf('await endRunnersLeftWithoutHost(')
  check('after the handover is known and before the control server starts', at !== -1 && main.indexOf('handover = handoverState(') < at && at < main.indexOf('controlServer = await startControlServer('))
  check("a runner the roster holds or a living predecessor hosts is not its to end", main.includes("endRunnersLeftWithoutHost(short => (rosterRef?.has(short).present ?? false) || (handoverRef?.holds(short) ?? false))"))
}

for (const child of children) {
  try {
    child.kill('SIGKILL')
  } catch {}
}
rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-runners-left-without-host: ALL LAWS HOLD' : `\nprove-runners-left-without-host: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
