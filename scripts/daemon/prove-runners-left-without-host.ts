#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

console.log("R3 a process under the runner that outlives the ask is ended with it, and nothing outside the runner's tree is touched")
{
  const pidFile = join(SCRATCH, 'under-the-runner.pid')
  const script = join(SCRATCH, 'left-runner.sh')
  writeFileSync(script, `sh -c 'trap "" TERM; while :; do sleep 1; done' &\necho $! > "$1"\nwait\n`)
  const runner = spawn('sh', [script, pidFile], { detached: true, stdio: 'ignore' })
  children.push(runner)
  const bystander = standIn()
  const staged = await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '', 3_000)
  const under = staged ? Number(readFileSync(pidFile, 'utf8').trim()) : -1
  const underBirth = staged ? await getProcessStartTokenAsync(under) : null
  await new Promise(resolve => setTimeout(resolve, 150))
  const runnerId = await seed('8', runner.pid!)
  const ended = sweep === undefined ? [] : await sweep(id => id !== runnerId, dir, { graceMs: 400 })
  check('the scene stood: a runner that leads its own group, with a process under it that ignores the ask', staged && under > 1 && typeof underBirth === 'string' && underBirth !== '', j({ staged, under, underBirth }))
  check('the runner left at the ask and is listed as ended', (await until(() => !isProcessAlive(runner.pid!), 2_000)) && ended.map(e => e.runnerId).join(',') === runnerId, j(ended))
  const underGone = await until(() => !isProcessAlive(under), 2_000)
  check('the process under it that ignored the ask is gone too (red before: it ran on with nothing left to end it)', underGone, `pid ${under} is still alive`)
  check('a process that was never under the runner is alive', isProcessAlive(bystander))
  if (!underGone && typeof underBirth === 'string' && underBirth !== '' && (await getProcessStartTokenAsync(under)) === underBirth) {
    try {
      process.kill(under, 'SIGKILL')
    } catch {}
  }
}

console.log('R4 what stands under a runner: its descendants at any depth, and its group only when it leads one')
{
  const tree = (await import('../../src/daemon/processTree.ts').catch(() => null)) as null | typeof import('../../src/daemon/processTree.ts')
  const table = ['   10     1    10', '   11    10    10', '   12    11    12', '   13     1    10', '   14     1    14', '   20     1     7', '   21    20     7', '   22     1     7', '    1     0     1', 'not a row of the table'].join('\n')
  const rows = tree === null ? [] : tree.parseProcessTreeRows(table)
  const under = (pid: number, more: typeof rows = []): number[] => (tree === null ? [-1] : tree.processTreeUnder([...rows, ...more], pid).sort((a, b) => a - b))
  check('the table is read row by row, and a line that is no row is skipped', rows.length === 9, j(rows.length))
  check('a runner that leads its group: its child, its grandchild in a group of its own, and a member of its group that init has adopted — never itself', j(under(10)) === j([11, 12, 13]), j(under(10)))
  check("a runner that does not lead its group takes its descendants only: the rest of that group is not its to end", j(under(20)) === j([21]), j(under(20)))
  check('a pid the table does not hold has nothing under it', under(99).length === 0, j(under(99)))
  check('pid 1 is never listed, whatever the table says of it', j(under(10, [{ pid: 1, ppid: 0, pgid: 10 }])) === j([11, 12, 13]), j(under(10, [{ pid: 1, ppid: 0, pgid: 10 }])))
  const mine = [{ pid: process.pid, ppid: 11, pgid: 12 }, { pid: 40, ppid: process.pid, pgid: 40 }, { pid: 41, ppid: 40, pgid: 10 }]
  check('a runner above this process, or one whose group this process stands in, has no tree for this process to end: nothing of it is listed', under(10, mine).length === 0 && under(10, [{ pid: process.pid, ppid: 1, pgid: 10 }]).length === 0, j([under(10, mine), under(10, [{ pid: process.pid, ppid: 1, pgid: 10 }])]))
  check('this process and pid 1 have no tree to end, whatever stands under them', under(process.pid, mine).length === 0 && under(1).length === 0 && under(0).length === 0, j([under(process.pid, mine), under(1), under(0)]))
}

console.log('R5 a record that names this process is no runner left without a host: nothing it started is touched')
{
  const child = standIn()
  await new Promise(resolve => setTimeout(resolve, 150))
  const selfId = await seed('9', process.pid)
  const ended = sweep === undefined ? [] : await sweep(id => id !== selfId, dir, { graceMs: 300 })
  check('the sweep lists nothing and the process this proof started is alive (red before: killed as a process under a runner)', ended.length === 0 && isProcessAlive(child), j({ ended, childAlive: isProcessAlive(child) }))
}

for (const child of children) {
  try {
    child.kill('SIGKILL')
  } catch {}
}
rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-runners-left-without-host: ALL LAWS HOLD' : `\nprove-runners-left-without-host: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
