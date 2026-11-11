#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConcourseWorkerRecordV1 } from '../../src/daemon/concourseWorkers.ts'

const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const role = argAfter('--role') ?? 'world'
const SELF = import.meta.path
const j = (value: unknown): string => JSON.stringify(value)
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const alive = (pid: number | undefined): boolean => {
  if (pid === undefined || !(pid > 1)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const until = async (pred: () => boolean, ms: number): Promise<boolean> => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (pred()) return true
    await sleep(40)
  }
  return pred()
}
const readJson = (path: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}
const recordOf = (runnerId: string, pid: number, procStart: string | null, workspaceId: string): ConcourseWorkerRecordV1 => {
  const now = Date.now()
  return {
    schema: 1,
    runnerId,
    sessionId: `00000000-dddd-4000-8000-${String(pid).padStart(12, '0')}`,
    workspaceId,
    isolation: 'exclusive',
    modelKey: 'claude-sonnet-5',
    spawnedAt: now - 60_000,
    lastLiveAt: now - 60_000,
    pid,
    ...(procStart ? { procStart } : {}),
    lastDeliveryAt: now - 1_000,
    lastTurnSettledAt: now - 5_000,
  } as ConcourseWorkerRecordV1
}

if (role === 'launcher') {
  const world = argAfter('--world')!
  const child = spawn(process.execPath, [SELF, '--role', 'sweeper', '--world', world, '--runner', argAfter('--runner')!, '--act', argAfter('--act')!], { detached: true, stdio: 'ignore' })
  writeFileSync(join(world, 'launcher.json'), j({ pid: process.pid, sweeper: child.pid }))
  process.on('SIGTERM', () => appendFileSync(join(world, 'launcher-asked.txt'), `${Date.now()}\n`))
  setInterval(() => {}, 1_000)
  await new Promise(() => {})
}

if (role === 'sweeper') {
  const world = argAfter('--world')!
  const runnerPid = Number(argAfter('--runner'))
  const act = argAfter('--act') ?? 'sweep'
  const dir = join(world, 'daemon')
  mkdirSync(dir, { recursive: true })
  process.env.MERCURY_DAEMON_DIR = dir
  const signals: string[] = []
  for (const name of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) {
    process.on(name, () => {
      signals.push(name)
      appendFileSync(join(world, 'sweeper-signals.txt'), `${name}\n`)
    })
  }
  const sup = await import('../../src/daemon/concourseWorkers.ts')
  const { getProcessStartTokenAsync } = await import('../../src/daemon/ownerWatch.ts')
  const { endProcessTree } = await import('../../src/utils/processGroup.ts')
  const mine = spawn('/bin/sleep', ['611'], { stdio: 'ignore' })
  const mineApart = spawn('/bin/sleep', ['612'], { stdio: 'ignore', detached: true })
  await sleep(200)
  const births = {
    runner: await getProcessStartTokenAsync(runnerPid),
    mine: await getProcessStartTokenAsync(mine.pid!),
    mineApart: await getProcessStartTokenAsync(mineApart.pid!),
  }
  writeFileSync(join(world, 'sweeper-started.json'), j({ pid: process.pid, ppid: process.ppid, mine: mine.pid, mineApart: mineApart.pid, births }))
  await until(() => existsSync(join(world, 'go')), 30_000)
  let ended: unknown = null
  let receipt: unknown = null
  let threw: string | null = null
  try {
    if (act === 'tree') {
      receipt = await endProcessTree(runnerPid, 'SIGTERM')
    } else {
      sup.updateConcourseWorkers(workers => {
        workers['concourse-w1'] = recordOf('concourse-w1', runnerPid, births.runner, world)
      }, dir)
      const sweep = (sup as { endRunnersLeftWithoutHost?: typeof sup.endRunnersLeftWithoutHost }).endRunnersLeftWithoutHost
      ended = sweep === undefined ? 'no sweep' : await sweep(() => false, dir, { graceMs: 1_200 })
    }
  } catch (error) {
    threw = String(error)
  }
  await sleep(300)
  writeFileSync(join(world, 'sweeper.json'), j({ signals, ended, receipt, threw, runnerAlive: alive(runnerPid), mineAlive: alive(mine.pid), mineApartAlive: alive(mineApart.pid), done: true }))
  for (const [child, birth] of [[mine, births.mine], [mineApart, births.mineApart]] as Array<[ChildProcess, string | null]>) {
    if (alive(child.pid) && birth && (await getProcessStartTokenAsync(child.pid!)) === birth) child.kill('SIGKILL')
  }
  process.exit(0)
}

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'sweep-own-tree-')))
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const lstart = (pid: number): string => (spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }).stdout ?? '').trim()
const parentOf = (pid: number): number => Number((spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).stdout ?? '').trim())
const groupOf = (pid: number): number => Number((spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).stdout ?? '').trim())
const started = new Map<number, string>()
const note = (pid: number | undefined): void => {
  if (pid !== undefined && pid > 1 && alive(pid)) started.set(pid, lstart(pid))
}
const endWhatThisProofStarted = async (): Promise<number[]> => {
  for (const [pid, birth] of started) {
    if (alive(pid) && birth !== '' && lstart(pid) === birth) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
  }
  await sleep(250)
  return [...started.keys()].filter(pid => alive(pid) && lstart(pid) === started.get(pid))
}

const SHAPES = {
  'same group': "under the runner, in the runner's own group",
  'own group': 'under the runner, in a group of its own behind a launcher',
  'orphan in group': "in a group of its own, started by a member of the runner's group that the runner's tree no longer holds",
} as const
const above = (pid: number): number[] => {
  const chain: number[] = []
  for (let at = parentOf(pid); at > 1 && chain.length < 64; at = parentOf(at)) chain.push(at)
  return chain
}

async function standUnderRunner(name: string, shape: keyof typeof SHAPES, act: 'sweep' | 'tree'): Promise<void> {
  const world = join(SCRATCH, name)
  mkdirSync(world, { recursive: true })
  const stand = `"${process.execPath}" "${SELF}" --role ${shape === 'same group' ? 'sweeper' : 'launcher'} --world "${world}" --runner $$ --act ${act} &`
  const script = join(world, 'runner.sh')
  writeFileSync(script, ['/bin/sleep 613 &', `echo $! > "${world}/tool.pid"`, shape === 'orphan in group' ? `( ${stand} )` : stand, 'wait', ''].join('\n'))
  const bystander = spawn('/bin/sleep', ['614'], { stdio: 'ignore', detached: true })
  const runner = spawn('/bin/sh', [script], { detached: true, stdio: 'ignore' })
  await sleep(150)
  note(runner.pid)
  note(bystander.pid)
  const staged = await until(() => readJson(join(world, 'sweeper-started.json')) !== null && existsSync(join(world, 'tool.pid')), 30_000)
  const facts = readJson(join(world, 'sweeper-started.json')) ?? {}
  const sweeperPid = Number(facts.pid ?? -1)
  const toolPid = existsSync(join(world, 'tool.pid')) ? Number(readFileSync(join(world, 'tool.pid'), 'utf8').trim()) : -1
  const launcherPid = shape === 'same group' ? -1 : Number((readJson(join(world, 'launcher.json')) ?? {}).pid ?? -1)
  for (const pid of [sweeperPid, toolPid, launcherPid, Number(facts.mine ?? -1), Number(facts.mineApart ?? -1)]) note(pid)
  const placed =
    shape === 'same group'
      ? parentOf(sweeperPid) === runner.pid
      : parentOf(sweeperPid) === launcherPid && (shape === 'own group' ? parentOf(launcherPid) === runner.pid : !above(launcherPid).includes(runner.pid!) && groupOf(launcherPid) === runner.pid)
  const grouped = shape === 'same group' ? groupOf(sweeperPid) === runner.pid : groupOf(sweeperPid) === sweeperPid
  check(`${name}: the scene stood — the sweeping process ${SHAPES[shape]}`, staged && placed && grouped, j({ staged, runner: runner.pid, sweeperPid, launcherPid, parent: parentOf(sweeperPid), group: groupOf(sweeperPid), launcherAbove: above(launcherPid), launcherGroup: groupOf(launcherPid) }))
  writeFileSync(join(world, 'go'), '')
  await until(() => readJson(join(world, 'sweeper.json'))?.done === true || !alive(sweeperPid), 30_000)
  await sleep(200)
  const told = readJson(join(world, 'sweeper.json'))
  const asked = existsSync(join(world, 'sweeper-signals.txt')) ? readFileSync(join(world, 'sweeper-signals.txt'), 'utf8').trim().split('\n') : []
  check(`${name}: the sweeping process was sent no signal by its own ${act === 'tree' ? 'call' : 'sweep'}`, told?.done === true && asked.length === 0, j({ reported: told?.done === true, asked }))
  check(`${name}: what the sweeping process started lives on, in its group and out of it`, told?.mineAlive === true && told?.mineApartAlive === true, j({ mineAlive: told?.mineAlive, mineApartAlive: told?.mineApartAlive }))
  check(`${name}: the runner it stands under and the runner's other child are left alone`, alive(runner.pid) && alive(toolPid), j({ runnerAlive: alive(runner.pid), toolAlive: alive(toolPid) }))
  if (shape !== 'same group') check(`${name}: the process that launched it was not asked to leave`, alive(launcherPid) && !existsSync(join(world, 'launcher-asked.txt')), j({ launcherAlive: alive(launcherPid) }))
  if (act === 'sweep') check(`${name}: the record is passed over, not claimed as ended`, Array.isArray(told?.ended) && (told!.ended as unknown[]).length === 0 && told?.threw === null, j({ ended: told?.ended, threw: told?.threw }))
  else check(`${name}: the tree's end answers that nothing was ended and the root lives`, j(told?.receipt) === j({ ended: 0, survivors: [runner.pid] }) && told?.threw === null, j({ receipt: told?.receipt, threw: told?.threw }))
  check(`${name}: a process that was never under the runner is alive`, alive(bystander.pid))
  const left = await endWhatThisProofStarted()
  check(`${name}: every stand-in this scene started is gone again`, left.length === 0, j(left))
  started.clear()
}

console.log('U1 a daemon that stands under a runner left without a host passes that record over: the sweep signals neither its own group nor anything it started')
await standUnderRunner('U1a', 'same group', 'sweep')
await standUnderRunner('U1b', 'own group', 'sweep')
await standUnderRunner('U1c', 'orphan in group', 'sweep')

console.log("U2 the tree's end itself refuses a tree or a group the calling process stands in")
await standUnderRunner('U2a', 'same group', 'tree')
await standUnderRunner('U2b', 'own group', 'tree')
await standUnderRunner('U2c', 'orphan in group', 'tree')

console.log('U3 the control: a runner this process does not stand under is still ended, with what stands under it')
{
  const world = join(SCRATCH, 'U3')
  const dir = join(world, 'daemon')
  mkdirSync(dir, { recursive: true })
  process.env.MERCURY_DAEMON_DIR = dir
  const sup = await import('../../src/daemon/concourseWorkers.ts')
  const { getProcessStartTokenAsync } = await import('../../src/daemon/ownerWatch.ts')
  const script = join(world, 'runner.sh')
  writeFileSync(script, ['/bin/sleep 615 &', `echo $! > "${world}/tool.pid"`, 'wait', ''].join('\n'))
  const runner = spawn('/bin/sh', [script], { detached: true, stdio: 'ignore' })
  const bystander = spawn('/bin/sleep', ['616'], { stdio: 'ignore', detached: true })
  await until(() => existsSync(join(world, 'tool.pid')) && readFileSync(join(world, 'tool.pid'), 'utf8').trim() !== '', 5_000)
  const toolPid = Number(readFileSync(join(world, 'tool.pid'), 'utf8').trim())
  await sleep(150)
  for (const pid of [runner.pid, bystander.pid, toolPid]) note(pid)
  const birth = await getProcessStartTokenAsync(runner.pid!)
  sup.updateConcourseWorkers(workers => {
    workers['concourse-w2'] = recordOf('concourse-w2', runner.pid!, birth, world)
  }, dir)
  const sweep = (sup as { endRunnersLeftWithoutHost?: typeof sup.endRunnersLeftWithoutHost }).endRunnersLeftWithoutHost
  const ended = sweep === undefined ? [] : await sweep(() => false, dir, { graceMs: 1_200 })
  const gone = await until(() => !alive(runner.pid) && !alive(toolPid), 3_000)
  check('the runner and its child are gone and the runner is listed as ended', gone && ended.map(e => e.runnerId).join(',') === 'concourse-w2', j({ ended, runnerAlive: alive(runner.pid), toolAlive: alive(toolPid) }))
  check('a process that was never under it is alive', alive(bystander.pid))
  const left = await endWhatThisProofStarted()
  check('every stand-in this scene started is gone again', left.length === 0, j(left))
  started.clear()
}

console.log('U4 where this process stands, read from the table')
{
  const tree = await import('../../src/daemon/processTree.ts')
  const rule = ((await import('../../src/utils/processGroup.ts')) as { processStandsInTree?: (rows: Array<{ pid: number; ppid: number; pgid: number }>, rootPid: number) => boolean }).processStandsInTree
  const me = process.pid
  const rows = [
    { pid: 10, ppid: 1, pgid: 10 },
    { pid: 11, ppid: 10, pgid: 10 },
    { pid: 12, ppid: 11, pgid: 12 },
    { pid: 20, ppid: 1, pgid: 20 },
    { pid: 21, ppid: 20, pgid: 20 },
  ]
  const stands = (more: typeof rows, root: number): boolean | undefined => rule?.([...rows, ...more], root)
  check('a child of the runner, at any depth and in any group, stands in its tree', stands([{ pid: me, ppid: 10, pgid: me }], 10) === true && stands([{ pid: me, ppid: 12, pgid: me }], 10) === true, j([stands([{ pid: me, ppid: 10, pgid: me }], 10), stands([{ pid: me, ppid: 12, pgid: me }], 10)]))
  check("a member of the runner's group stands in it, whoever its parent is", stands([{ pid: me, ppid: 1, pgid: 10 }], 10) === true, j(stands([{ pid: me, ppid: 1, pgid: 10 }], 10)))
  check('a process beside the runner stands in neither, and the runner is listed as before', stands([{ pid: me, ppid: 1, pgid: me }], 10) === false && j(tree.processTreeUnder([...rows, { pid: me, ppid: 1, pgid: me }], 10).sort((a, b) => a - b)) === j([11, 12]), j(stands([{ pid: me, ppid: 1, pgid: me }], 10)))
  const orphaned = [{ pid: 30, ppid: 1, pgid: 10 }, { pid: 31, ppid: 30, pgid: 31 }, { pid: me, ppid: 31, pgid: me }]
  check("a process started, at any depth, by a member of the runner's group stands in it though the runner's tree no longer holds that member", stands(orphaned, 10) === true && stands(orphaned, 20) === false, j([stands(orphaned, 10), stands(orphaned, 20)]))
  check('a tree this process stands in lists nothing for it to end', tree.processTreeUnder([...rows, { pid: me, ppid: 11, pgid: me }, { pid: 40, ppid: me, pgid: 40 }], 10).length === 0 && tree.processTreeUnder([...rows, ...orphaned], 10).length === 0, j([tree.processTreeUnder([...rows, { pid: me, ppid: 11, pgid: me }, { pid: 40, ppid: me, pgid: 40 }], 10), tree.processTreeUnder([...rows, ...orphaned], 10)]))
}

console.log('U5 on Windows, where no table is read, a runner that is the parent of this process is passed over all the same')
{
  const tree = await import('../../src/daemon/processTree.ts')
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
  let answers: unknown[] = []
  try {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    answers = [await tree.readProcessTreeUnder(process.ppid), await tree.readProcessTreeUnder(2_147_000_003)]
  } finally {
    Object.defineProperty(process, 'platform', realPlatform)
  }
  check('its parent has no tree for it to end, and any other runner is listed with nothing under it, as before', answers[0] === null && j(answers[1]) === '[]', j(answers))
}

console.log(failures === 0 ? '\nprove-sweep-spares-own-tree: ALL LAWS HOLD' : `\nprove-sweep-spares-own-tree: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
