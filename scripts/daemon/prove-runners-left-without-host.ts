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
type TreeModule = typeof import('../../src/daemon/processTree.ts')
const tree = (await import('../../src/daemon/processTree.ts').catch(() => null)) as null | (Partial<TreeModule> & Pick<TreeModule, 'parseProcessTreeRows' | 'processTreeUnder' | 'readProcessTreeUnder'>)
const intoListingSecond = (): number => (process.platform === 'linux' ? Math.round((Number(readFileSync('/proc/uptime', 'utf8').trim().split(/\s+/)[0]) % 1) * 1000) : Date.now() % 1000)
const leftRunner = (name: string): { runner: ChildProcess; pidFile: string } => {
  const pidFile = join(SCRATCH, `${name}.pid`)
  const script = join(SCRATCH, `${name}.sh`)
  writeFileSync(script, `sh -c 'trap "" TERM; while :; do sleep 1; done' &\necho $! > "$1"\nwait\n`)
  const runner = spawn('sh', [script, pidFile], { detached: true, stdio: 'ignore' })
  children.push(runner)
  return { runner, pidFile }
}
const endIfStill = async (pid: number, birth: string | null): Promise<void> => {
  if (pid > 1 && isProcessAlive(pid) && typeof birth === 'string' && birth !== '' && (await getProcessStartTokenAsync(pid)) === birth) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
}

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
  const { runner, pidFile } = leftRunner('left-runner')
  const bystander = standIn()
  const staged = await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '', 3_000)
  const under = staged ? Number(readFileSync(pidFile, 'utf8').trim()) : -1
  const underBirth = staged ? await getProcessStartTokenAsync(under) : null
  await new Promise(resolve => setTimeout(resolve, 1_150))
  const runnerId = await seed('8', runner.pid!)
  const listed = ((await tree?.readProcessTreeUnder(runner.pid!)) ?? []) as Array<{ pid?: number; birth?: string }>
  const alone = tree?.readProcessBirth === undefined ? null : await tree.readProcessBirth(under)
  check('the listing carries the birth of each process under the runner, read with the row that names it: the birth a look at that pid alone answers', typeof alone === 'string' && alone !== '' && listed.find(member => member.pid === under)?.birth === alone, j({ listed, alone }))
  const ended = sweep === undefined ? [] : await sweep(id => id !== runnerId, dir, { graceMs: 400 })
  check('the scene stood: a runner that leads its own group, with a process under it that ignores the ask and was born before the second its tree is listed in', staged && under > 1 && typeof underBirth === 'string' && underBirth !== '', j({ staged, under, underBirth }))
  check('the runner left at the ask and is listed as ended', (await until(() => !isProcessAlive(runner.pid!), 2_000)) && ended.map(e => e.runnerId).join(',') === runnerId, j(ended))
  const underGone = await until(() => !isProcessAlive(under), 2_000)
  check('the process under it that ignored the ask is gone too (red before: it ran on with nothing left to end it)', underGone, `pid ${under} is still alive`)
  check('a process that was never under the runner is alive', isProcessAlive(bystander))
  if (!underGone) await endIfStill(under, underBirth)
}

console.log("R6 a process under the runner born in the second its tree is listed in is left by this pass: to the second, its birth could be a later process's")
{
  let scene: { staged: boolean; under: number; underBirth: string | null; runnerPid: number; ended: string[]; runnerId: string } | null = null
  for (let attempt = 0; attempt < 4 && (scene === null || !scene.staged); attempt++) {
    await until(() => intoListingSecond() < 120, 2_000)
    const began = intoListingSecond()
    const { runner, pidFile } = leftRunner(`young-runner-${attempt}`)
    const up = await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '', 3_000)
    const under = up ? Number(readFileSync(pidFile, 'utf8').trim()) : -1
    const runnerId = await seed(`2${attempt}`, runner.pid!)
    const underBirth = up ? await getProcessStartTokenAsync(under) : null
    const called = intoListingSecond()
    const ended = sweep === undefined ? [] : await sweep(id => id !== runnerId, dir, { graceMs: 400 })
    scene = { staged: up && under > 1 && called >= began && called < 900, under, underBirth, runnerPid: runner.pid!, ended: ended.map(e => e.runnerId), runnerId }
    if (!scene.staged) await endIfStill(under, underBirth)
  }
  check('the scene stood: the process under the runner was born, and the tree listed, inside one second of the clock its births are read on', scene !== null && scene.staged, j(scene))
  check('the runner left at the ask and is listed as ended', scene !== null && (await until(() => !isProcessAlive(scene!.runnerPid), 2_000)) && scene.ended.join(',') === scene.runnerId, j(scene))
  await new Promise(resolve => setTimeout(resolve, 300))
  check('the process under it is not struck after the grace (red before: killed on a birth that, to the second, was no later than the listing)', scene !== null && isProcessAlive(scene.under), j(scene))
  if (scene !== null) await endIfStill(scene.under, scene.underBirth)
}

console.log('R4 what stands under a runner: its descendants at any depth, and its group only when it leads one')
{
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
  const born = tree === null ? [] : tree.parseProcessTreeRows(['  392     1   392 Sat Nov  7 15:29:31 2026    ', '  393   392   392 Sat Nov  7 15:29:32 2026', '  394   392   392 no birth here', '  395   392   392'].join('\n'))
  const at = Math.floor(new Date(2026, 10, 7, 15, 29, 31).getTime() / 1000)
  check('a row of the table carries its own birth, to the second, and a row without one is still a row', j(born) === j([{ pid: 392, ppid: 1, pgid: 392, birth: 'Sat Nov  7 15:29:31 2026', bornSecond: at }, { pid: 393, ppid: 392, pgid: 392, birth: 'Sat Nov  7 15:29:32 2026', bornSecond: at + 1 }, { pid: 394, ppid: 392, pgid: 392 }, { pid: 395, ppid: 392, pgid: 392 }]), j(born))
  const here = { pid: process.pid, ppid: 1, pgid: process.pid }
  const members = (noted: number, rows: unknown[] = [...born, here]): unknown => (tree?.processTreeMembers === undefined ? 'no rule' : tree.processTreeMembers(rows as Parameters<NonNullable<TreeModule['processTreeMembers']>>[0], 392, noted))
  check('only a process born strictly before the second noted before the listing is kept for the kill: one born in that second, or with no birth in the table, is not', j(members(at + 2)) === j([{ pid: 393, birth: 'Sat Nov  7 15:29:32 2026' }]) && j(members(at + 1)) === '[]' && j(members(at + 3600)) === j([{ pid: 393, birth: 'Sat Nov  7 15:29:32 2026' }]), j([members(at + 2), members(at + 1)]))
  check('a table that does not hold this process, or a tree this process stands in, answers that nothing can be said: no list at all', members(at + 2, born) === null && members(at + 2, [...born, { pid: process.pid, ppid: 393, pgid: process.pid }]) === null, j([members(at + 2, born), members(at + 2, [...born, { pid: process.pid, ppid: 393, pgid: process.pid }])]))
  const stat = (pid: number, comm: string, ppid: number, pgid: number, ticks: number): string => `${pid} (${comm}) S ${ppid} ${pgid} ${pgid} 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 ${ticks} 1000000 100 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0`
  const proc: Record<string, string> = { '/proc/uptime': '2000.50 1500.00\n', '/proc/10/stat': stat(10, 'runner', 1, 10, 150_000), '/proc/11/stat': stat(11, 'a (b) c d', 10, 10, 199_999), '/proc/12/stat': stat(12, 'young', 10, 10, 200_000), [`/proc/${process.pid}/stat`]: stat(process.pid, 'bun', 1, process.pid, 100) }
  const linux = tree?.readLinuxProcessTree === undefined ? null : tree.readLinuxProcessTree(() => ['10', '11', '12', '13', String(process.pid), 'self', 'uptime'], path => {
    if (proc[path] === undefined) throw Object.assign(new Error('gone'), { code: 'ENOENT' })
    return proc[path]!
  })
  check('on Linux the table is one pass over /proc, each process whole on its own line: its parent, its group and its birth in raw ticks, whatever its name holds; a process that left meanwhile is no row, and the second is noted on the clock the ticks count', linux !== null && linux.notedSecond === 2000 && j(linux.rows.filter(row => row.pid !== process.pid)) === j([{ pid: 10, ppid: 1, pgid: 10, birth: '150000', bornSecond: 1500 }, { pid: 11, ppid: 10, pgid: 10, birth: '199999', bornSecond: 1999 }, { pid: 12, ppid: 10, pgid: 10, birth: '200000', bornSecond: 2000 }]), j(linux))
  check('…and there too only a process born before that second is kept', linux !== null && j(tree!.processTreeMembers!(linux.rows, 10, linux.notedSecond)) === j([{ pid: 11, birth: '199999' }]), linux === null ? '' : j(tree!.processTreeMembers!(linux.rows, 10, linux.notedSecond)))
  check('a table that cannot be read answers that nothing can be said', tree?.readLinuxProcessTree !== undefined && tree.readLinuxProcessTree(() => ['10'], () => { throw new Error('no /proc') }) === null)
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
