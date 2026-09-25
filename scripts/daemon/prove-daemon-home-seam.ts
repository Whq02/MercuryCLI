#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'daemon-home-seam-')))
const HOME = join(SCRATCH, 'home')
const DAEMON_DIR = join(SCRATCH, 'daemon')
const PROJECT = join(SCRATCH, 'project')
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_DAEMON_DIR = DAEMON_DIR
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.GIT_CONFIG_GLOBAL = join(SCRATCH, 'gitconfig-empty')
process.env.GIT_CONFIG_SYSTEM = '/dev/null'
process.env.XDG_CONFIG_HOME = join(SCRATCH, 'xdg')
for (const key of ['MERCURY_HOME', 'MERCURY_FAULT_INJECT', 'MERCURY_DURABLE_FSYNC', 'MERCURY_WORKER_PARENT_PID', 'MERCURY_SPAWNED_BY', 'MERCURY_DAEMON_OWNER_PID', 'MERCURY_DAEMON_OWNER_FD']) delete process.env[key]
if (process.env.NODE_ENV === 'test') delete process.env.NODE_ENV
mkdirSync(HOME, { recursive: true })
mkdirSync(DAEMON_DIR, { recursive: true })
mkdirSync(PROJECT, { recursive: true })
writeFileSync(process.env.GIT_CONFIG_GLOBAL, '')
writeFileSync(join(PROJECT, 'package.json'), '{"name":"fixture"}\n')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const text = (v: unknown): string => JSON.stringify(v)
const listing = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).sort() : [])
const temps = (dir: string): string[] => listing(dir).filter(n => n.startsWith('.') && n.endsWith('.tmp'))
const readText = (path: string): string => (existsSync(path) ? readFileSync(path, 'utf8') : '')
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const errCode = (e: unknown): string | undefined => {
  const withCode = e as { fsCode?: string; code?: string } | undefined
  return withCode?.fsCode ?? withCode?.code
}
const errPhase = (e: unknown): string | undefined => (e as { phase?: string } | undefined)?.phase
const freshHome = (): void => {
  rmSync(DAEMON_DIR, { recursive: true, force: true })
  mkdirSync(DAEMON_DIR, { recursive: true })
}
const goneHome = (): void => rmSync(DAEMON_DIR, { recursive: true, force: true })

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const homeWatch = await import('../../src/daemon/daemonHome.ts')
const durable = await import('../../src/substrate/durablePublish.ts')
const control = await import('../../src/daemon/controlSocket.ts')
const sup = await import('../../src/daemon/concourseSupervisor.ts')
const dispatch = await import('../../src/daemon/concourseDispatch.ts')
const box = await import('../../src/daemon/saturnBoxSchedules.ts')
const asks = await import('../../src/daemon/permissionAsks.ts')

type Seam = (where: string, path: string, contents: string | Uint8Array, opts?: { dir?: string; mode?: number }) => 'published' | 'home-gone'
const seam: Seam | undefined = (homeWatch as { publishInDaemonHome?: Seam }).publishInDaemonHome
const DOOR = seam === undefined ? 'durableAtomicPublishSync straight from the writer (this tree exports no publishInDaemonHome)' : 'publishInDaemonHome'
const MUST_STAND = { parent: 'must-stand' } as const
const CREATE = { parent: 'create' } as const
type PublishOpts = Parameters<typeof durable.durableAtomicPublishSync>[2]
const mustStand = MUST_STAND as unknown as PublishOpts
const create = CREATE as unknown as PublishOpts

type Outcome = 'published' | 'home-gone' | { threw: string }
function road(where: string, file: string, bytes: string, between: () => void, dir: string = DAEMON_DIR): Outcome {
  if (!homeWatch.daemonHomeStands(where, dir)) return 'home-gone'
  between()
  const path = join(dir, file)
  try {
    if (seam === undefined) {
      durable.durableAtomicPublishSync(path, bytes)
      return 'published'
    }
    return seam(where, path, bytes, { dir })
  } catch (e) {
    return { threw: errText(e) }
  }
}

let noticed: string[] = []
const arm = (): void => {
  noticed = []
  homeWatch.armDaemonHomeWatch(control.daemonDir(), where => noticed.push(where))
}

console.log('============================================================')
console.log(' the daemon-home publish seam: a writer never recreates a home it was told is gone')
console.log('============================================================')
console.log(`the publish door under proof: ${DOOR}`)
console.log(`the daemon dir: ${DAEMON_DIR}`)
check('the fixture daemon dir is the one daemonDir() resolves', control.daemonDir() === DAEMON_DIR, control.daemonDir())

console.log('\nP1 the publish primitive: `parent` on the options, default-preserving')
{
  const p = join(DAEMON_DIR, 'p.json')
  goneHome()
  durable.durableAtomicPublishSync(p, 'a')
  check('P1 no option: the sync publish still creates a missing parent (every non-daemon caller keeps its shape)', readText(p) === 'a', text(listing(DAEMON_DIR)))
  goneHome()
  durable.durableAtomicPublishSync(p, 'b', create)
  check("P1 parent 'create': the sync publish creates the parent", readText(p) === 'b', text(listing(DAEMON_DIR)))
  goneHome()
  let refusal: unknown = null
  try {
    durable.durableAtomicPublishSync(p, 'c', mustStand)
  } catch (e) {
    refusal = e
  }
  check(
    "P1 parent 'must-stand', parent gone: the sync publish refuses with ENOENT at create-temp",
    refusal !== null && errCode(refusal) === 'ENOENT' && errPhase(refusal) === 'create-temp',
    refusal === null ? `no refusal: the publish landed ${text(listing(DAEMON_DIR))}` : `${errPhase(refusal)} ${errCode(refusal)}: ${errText(refusal)}`,
  )
  check("P1 parent 'must-stand', parent gone: nothing is recreated at the parent", !existsSync(DAEMON_DIR), text(listing(DAEMON_DIR)))
  freshHome()
  durable.durableAtomicPublishSync(p, 'd', mustStand)
  check("P1 parent 'must-stand', parent standing: the sync publish lands the bytes and leaves no temp", readText(p) === 'd' && temps(DAEMON_DIR).length === 0, text(listing(DAEMON_DIR)))
  goneHome()
  let asyncRefusal: unknown = null
  try {
    await durable.durableAtomicPublish(p, 'e', mustStand)
  } catch (e) {
    asyncRefusal = e
  }
  check(
    "P1 parent 'must-stand', parent gone: the async publish refuses with ENOENT and recreates nothing",
    asyncRefusal !== null && errCode(asyncRefusal) === 'ENOENT' && !existsSync(DAEMON_DIR),
    asyncRefusal === null ? `no refusal: the publish landed ${text(listing(DAEMON_DIR))}` : `${errCode(asyncRefusal)}; parent stands: ${existsSync(DAEMON_DIR)}`,
  )
  freshHome()
  await durable.durableAtomicPublish(p, 'f', mustStand)
  check("P1 parent 'must-stand', parent standing: the async publish lands", readText(p) === 'f', text(listing(DAEMON_DIR)))
  goneHome()
  await durable.durableAtomicPublish(p, 'g')
  check('P1 no option: the async publish still creates a missing parent', readText(p) === 'g', text(listing(DAEMON_DIR)))
}

console.log('\nU1 unarmed (the screen process): the writer road creates a missing home, as the creators proof pins')
{
  const out = road('the box schedules', 'saturn-box-schedules.json', '{"version":1}', goneHome)
  check('U1 with no watch armed the road publishes and the parent is created for it', out === 'published' && existsSync(join(DAEMON_DIR, 'saturn-box-schedules.json')), text({ out, files: listing(DAEMON_DIR) }))
}

console.log('\nS1 armed: the home is removed BETWEEN the presence read and the publish (the loaded-box interleave, deterministic)')
{
  freshHome()
  arm()
  check('S1 the watch stands while the directory stands', homeWatch.daemonHomeStands('the fixture', DAEMON_DIR) && noticed.length === 0, text(noticed))
  const out = road('the delta stamp', 'concourse-delta.json', '{"version":1,"revision":1}\n', goneHome)
  check(
    'S1 the publish refuses instead of recreating the home: the road answers home-gone and nothing stands at the daemon dir',
    out === 'home-gone' && !existsSync(DAEMON_DIR),
    `road: ${text(out)}; daemon dir stands: ${existsSync(DAEMON_DIR)} ${text(listing(DAEMON_DIR))}`,
  )
  check('S1 the latch trips at once, at the writer that met ENOENT', noticed.length === 1 && noticed[0] === 'the delta stamp', text(noticed))
  check('S1 the presence read afterwards is false (the latch), not true (a recreated home)', !homeWatch.daemonHomeStands('after the publish', DAEMON_DIR), `stands: true; noticed: ${text(noticed)}`)
  const again = road('the session records', 'concourse-workers.json', '{"version":1,"workers":{}}\n', () => {})
  check(
    'S1 a later publish answers home-gone from the latch: no disk touched, no second callback',
    again === 'home-gone' && !existsSync(DAEMON_DIR) && noticed.length === 1,
    `road: ${text(again)}; daemon dir stands: ${existsSync(DAEMON_DIR)} ${text(listing(DAEMON_DIR))}; noticed: ${text(noticed)}`,
  )
}

console.log('\nF1 armed: a publish into a directory that is not the daemon home keeps creating its parent')
{
  const foreign = join(SCRATCH, 'foreign')
  freshHome()
  arm()
  const out = road('the fixture', 'x.json', 'x', () => {}, foreign)
  check('F1 the foreign publish lands under a created parent and the daemon watch stays quiet', out === 'published' && readText(join(foreign, 'x.json')) === 'x' && noticed.length === 0, text({ out, noticed }))
}

console.log('\nW1 armed, home standing: each daemon writer meets an ENOENT from its publish (the fault seam) and the latch trips at the writer')
{
  const held = {
    scheduleId: '0badf00d',
    dueAt: Date.parse('2026-03-01T09:00:00Z'),
    reason: 'signed-out' as const,
    heldAt: Date.parse('2026-03-01T09:00:01Z'),
    envelope: { scheduleId: '0badf00d', kind: 'birth' as const, dueAt: Date.parse('2026-03-01T09:00:00Z'), birth: { workspaceId: PROJECT, modelKey: 'claude-fable-5', presence: 'headless' as const } },
  }
  const supervisor = (): Parameters<typeof control.writeSupervisorState>[0] =>
    ({ pid: process.pid, version: '1.0.0', origin: 'transient', startedAt: Date.now(), dir: PROJECT, controlSock: control.controlSockPath() }) as Parameters<typeof control.writeSupervisorState>[0]
  const evidence = { schema: 1, kind: 'authored-work-retained', workspaceId: PROJECT, holders: [{ workerId: 'w1' }], observedAt: Date.now() } as unknown as Parameters<typeof sup.recordCollisionEvidence>[0]
  const op = { clientOpId: 'op1', action: 'park', sessionId: 's1', outcome: 'applied', atMs: Date.now() } as unknown as Parameters<typeof dispatch.recordConcourseControlOp>[0]
  type Writer = { n: string; where: string; file: string; phase: string; seed?: () => void; act: () => void | Promise<void>; landed: () => boolean }
  const writers: Writer[] = [
    { n: 'W1.1', where: 'the collision evidence', file: 'concourse-collisions.json', phase: 'create-temp', act: () => sup.recordCollisionEvidence(evidence, DAEMON_DIR), landed: () => existsSync(join(DAEMON_DIR, 'concourse-collisions.json')) },
    { n: 'W1.2', where: 'the collision evidence', file: 'concourse-collisions.json', phase: 'create-temp', act: () => sup.markCollisionEvidenceConsumed(PROJECT, ['w1'], DAEMON_DIR), landed: () => existsSync(join(DAEMON_DIR, 'concourse-collisions.json')) },
    { n: 'W1.3', where: 'the delta stamp', file: 'concourse-delta.json', phase: 'create-temp', act: () => void sup.updateConcourseWorkers(() => {}, DAEMON_DIR), landed: () => existsSync(join(DAEMON_DIR, 'concourse-delta.json')) },
    { n: 'W1.4', where: 'the session records', file: 'concourse-workers.json', phase: 'create-temp', act: () => void sup.updateConcourseWorkers(() => {}, DAEMON_DIR), landed: () => existsSync(join(DAEMON_DIR, 'concourse-workers.json')) },
    { n: 'W1.5', where: 'the box schedules', file: 'saturn-box-schedules.json', phase: 'create-temp', act: () => void box.holdBoxFire(held, DAEMON_DIR), landed: () => existsSync(join(DAEMON_DIR, 'saturn-box-schedules.json')) },
    {
      n: 'W1.6',
      where: 'the dispatch ledger',
      file: 'concourse-dispatches.json',
      phase: 'create-temp',
      seed: () => writeFileSync(join(DAEMON_DIR, 'concourse-dispatches.json'), `${JSON.stringify({ version: 1, dispatches: { m1: { clientMessageId: 'm1', state: 'queued', acceptedAt: Date.now() } } }, null, 1)}\n`),
      act: () => void dispatch.withdrawConcourseDispatch('m1', DAEMON_DIR),
      landed: () => !readText(join(DAEMON_DIR, 'concourse-dispatches.json')).includes('"queued"'),
    },
    { n: 'W1.7', where: 'the control-op ledger', file: 'concourse-control-ops.json', phase: 'create-temp', act: () => dispatch.recordConcourseControlOp(op, DAEMON_DIR), landed: () => existsSync(join(DAEMON_DIR, 'concourse-control-ops.json')) },
    { n: 'W1.8', where: 'the supervisor record', file: 'supervisor.json', phase: 'create-temp', act: () => control.writeSupervisorState(supervisor()), landed: () => existsSync(join(DAEMON_DIR, 'supervisor.json')) },
    {
      n: 'W1.9',
      where: 'the supervisor record',
      file: 'supervisor.json',
      phase: 'create-temp',
      seed: () => writeFileSync(join(DAEMON_DIR, 'supervisor.json'), JSON.stringify(supervisor(), null, 2)),
      act: () => void control.markSupervisorStoppingSync(),
      landed: () => readText(join(DAEMON_DIR, 'supervisor.json')).includes('"stopping"'),
    },
    { n: 'W1.10', where: 'the control key', file: 'control.key', phase: 'create-temp', act: () => control.reassertControlKey('k'.repeat(64)), landed: () => existsSync(join(DAEMON_DIR, 'control.key')) },
    { n: 'W1.11', where: 'the git-init asks', file: 'git-init-asks.json', phase: 'rename', act: () => void asks.mintGitInitAsk(PROJECT), landed: () => existsSync(join(DAEMON_DIR, 'git-init-asks.json')) },
  ]
  for (const w of writers) {
    freshHome()
    w.seed?.()
    arm()
    process.env.MERCURY_FAULT_INJECT = `${w.phase}@${w.file}:enoent`
    let threw = ''
    try {
      await w.act()
    } catch (e) {
      threw = errText(e)
    }
    delete process.env.MERCURY_FAULT_INJECT
    check(
      `${w.n} ${w.where}: the ENOENT from the publish trips the latch once, at the writer, and the writer does not throw`,
      noticed.length === 1 && noticed[0] === w.where && threw === '',
      `noticed: ${text(noticed)}; threw: ${threw || 'nothing'}`,
    )
    check(
      `${w.n} ${w.where}: nothing landed at ${w.file} and no temp is left beside it (a private write road would have landed it)`,
      !w.landed() && temps(DAEMON_DIR).length === 0,
      `landed: ${w.landed()}; files: ${text(listing(DAEMON_DIR))}`,
    )
    check(`${w.n} ${w.where}: the presence read afterwards answers the latch, not the disk`, !homeWatch.daemonHomeStands('after the writer', DAEMON_DIR) && noticed.length === 1, `stands: true; noticed: ${text(noticed)}`)
  }
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-daemon-home-seam: ALL LAWS HOLD' : `\nprove-daemon-home-seam: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
