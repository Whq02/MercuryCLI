#!/usr/bin/env bun
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'

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
for (const key of ['MERCURY_HOME', 'MERCURY_FAULT_INJECT', 'MERCURY_DURABLE_FSYNC', 'MERCURY_WORKER_PARENT_PID', 'MERCURY_SPAWNED_BY', 'MERCURY_SPAWN_LEDGER', 'MERCURY_SPAWN_AUDIT', 'MERCURY_DAEMON_OWNER_PID', 'MERCURY_DAEMON_OWNER_FD']) delete process.env[key]
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
const led = await import('../../src/utils/spawnLedger.ts')
const seatFiles = await import('../../src/services/engine-connector/seatProjections.ts')
const store = await import('../../src/substrate/fileStore.ts')

type Seam = (where: string, path: string, contents: string | Uint8Array, opts?: { dir?: string; mode?: number }) => 'published' | 'home-gone'
const seam: Seam | undefined = (homeWatch as { publishInDaemonHome?: Seam }).publishInDaemonHome
const DOOR = seam === undefined ? 'durableAtomicPublishSync straight from the writer (this tree exports no publishInDaemonHome)' : 'publishInDaemonHome'
type AppendDoor = (where: string, path: string, line: string, opts?: { dir?: string; parent?: 'create' | 'must-stand' }) => 'appended' | 'home-gone'
type TransientDoor = (where: string, path: string, contents: string, dir?: string) => 'published' | 'home-gone'
type DirDoor = (where: string, path: string, dir?: string) => boolean
const appendDoor: AppendDoor | undefined = (homeWatch as { appendInDaemonHome?: AppendDoor }).appendInDaemonHome
const transientDoor: TransientDoor | undefined = (homeWatch as { publishTransientInDaemonHome?: TransientDoor }).publishTransientInDaemonHome
const dirDoor: DirDoor | undefined = (homeWatch as { ensureDirInDaemonHome?: DirDoor }).ensureDirInDaemonHome
const ROUTED = appendDoor !== undefined && transientDoor !== undefined && dirDoor !== undefined
const OUTER_DOOR = ROUTED ? 'the daemon-home doors (appendInDaemonHome; ensureDirInDaemonHome + publishTransientInDaemonHome)' : 'their private roads: mkdir -p, then appendFileSync / publishAtomic / temp + rename (this tree exports no appendInDaemonHome or publishTransientInDaemonHome)'
const MUST_STAND = { parent: 'must-stand' } as const
const CREATE = { parent: 'create' } as const
type PublishOpts = Parameters<typeof durable.durableAtomicPublishSync>[2]
const mustStand = MUST_STAND as unknown as PublishOpts
const create = CREATE as unknown as PublishOpts

type Outcome = 'published' | 'appended' | 'home-gone' | { threw: string }
async function interleave(where: string, write: () => Outcome | Promise<Outcome>): Promise<Outcome> {
  if (!homeWatch.daemonHomeStands(where, DAEMON_DIR)) return 'home-gone'
  goneHome()
  try {
    return await write()
  } catch (e) {
    return { threw: errText(e) }
  }
}
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
console.log(`the road of the five writers outside src/daemon under proof: ${OUTER_DOOR}`)
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

console.log('\nU2 unarmed (an operator session, an unmarked spawned child): the trail and the live feed still create a missing home, as the creators proof pins')
{
  goneHome()
  led.recordSpawn({ kind: 'headless', id: 'u2', cwd: PROJECT })
  const ledger = join(DAEMON_DIR, 'spawn-ledger.jsonl')
  check('U2 the spawn ledger row lands under a created forensics directory (the client process keeps its shape)', readText(ledger).includes('"id":"u2"'), text(listing(DAEMON_DIR)))
  goneHome()
  seatFiles.publishSessionTail({ schema: 1, sessionId: 'u2', atMs: 1, text: 'u2' }, DAEMON_DIR)
  check('U2 the session tail lands under a created subdirectory', readText(seatFiles.sessionTailPath('u2', DAEMON_DIR)).includes('"text":"u2"'), text(listing(DAEMON_DIR)))
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

console.log("\nS2-S4 armed: the roads of the writers outside src/daemon — the home is removed BETWEEN the presence read and the write")
{
  const ledgerPath = join(DAEMON_DIR, 'spawn-ledger.jsonl')
  const ledgerRow = '{"kind":"headless","id":"s2"}\n'
  const tailPath = seatFiles.sessionTailPath('s3', DAEMON_DIR)
  const tailBytes = '{"schema":1,"sessionId":"s3","atMs":1,"text":"s3"}\n'
  const factsPath = seatFiles.sessionFactsPath('s4', DAEMON_DIR)
  const factsBytes = '{"schema":1,"sessionId":"s4"}\n'
  type Row = { n: string; where: string; what: string; file: string; write: () => Outcome | Promise<Outcome> }
  const rows: Row[] = [
    {
      n: 'S2',
      where: 'the spawn ledger',
      what: 'the append',
      file: ledgerPath,
      write: () => {
        if (!ROUTED) {
          mkdirSync(dirname(ledgerPath), { recursive: true })
          appendFileSync(ledgerPath, ledgerRow)
          return 'appended'
        }
        return appendDoor!('the spawn ledger', ledgerPath, ledgerRow, { parent: 'create' })
      },
    },
    {
      n: 'S3',
      where: 'the session tail',
      what: 'the live-feed rename',
      file: tailPath,
      write: () => {
        if (!ROUTED) {
          mkdirSync(dirname(tailPath), { recursive: true })
          const tmp = `${tailPath}.${process.pid}.tmp`
          writeFileSync(tmp, tailBytes)
          renameSync(tmp, tailPath)
          return 'published'
        }
        if (!dirDoor!('the session tail', dirname(tailPath), DAEMON_DIR)) return 'home-gone'
        return transientDoor!('the session tail', tailPath, tailBytes, DAEMON_DIR)
      },
    },
    {
      n: 'S4',
      where: 'the session facts',
      what: 'the projection rename (the base chained the durable publish here)',
      file: factsPath,
      write: async () => {
        if (!ROUTED) {
          mkdirSync(dirname(factsPath), { recursive: true })
          await store.publishAtomic(factsPath, factsBytes)
          return 'published'
        }
        if (!dirDoor!('the session facts', dirname(factsPath), DAEMON_DIR)) return 'home-gone'
        return transientDoor!('the session facts', factsPath, factsBytes, DAEMON_DIR)
      },
    },
  ]
  for (const r of rows) {
    freshHome()
    arm()
    const out = await interleave(r.where, r.write)
    check(
      `${r.n} ${r.where}: ${r.what} refuses instead of recreating the home — the road answers home-gone and nothing stands at the daemon dir`,
      out === 'home-gone' && !existsSync(DAEMON_DIR),
      `road: ${text(out)}; daemon dir stands: ${existsSync(DAEMON_DIR)} ${text(listing(DAEMON_DIR))}; landed: ${existsSync(r.file)}`,
    )
    check(`${r.n} ${r.where}: the latch trips at once, at the writer that met ENOENT`, noticed.length === 1 && noticed[0] === r.where, text(noticed))
    check(`${r.n} ${r.where}: the presence read afterwards is false (the latch), not true (a recreated home)`, !homeWatch.daemonHomeStands('after the write', DAEMON_DIR), `stands: true; noticed: ${text(noticed)}`)
  }
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

console.log('\nW2 armed, home standing: each writer outside src/daemon meets an ENOENT from its write and the latch trips at the writer')
{
  const dangling = (at: string): void => symlinkSync(join(SCRATCH, 'nowhere', 'gone'), at)
  const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
  const facts = { schema: 1, sessionId: 's1', model: { effective: 'm', setting: null }, usage: {}, queue: [] } as unknown as Parameters<typeof seatFiles.publishSessionFacts>[0]
  const tail = { schema: 1, sessionId: 's1', atMs: 1, text: 's1' } as const
  const progress = { schema: 1, sessionId: 's1', atMs: 1, tools: {} } as const
  const factsPath = seatFiles.sessionFactsPath('s1', DAEMON_DIR)
  const asksPath = seatFiles.sessionAsksPath('s1', DAEMON_DIR)
  const tailPath = seatFiles.sessionTailPath('s1', DAEMON_DIR)
  const progressPath = seatFiles.sessionProgressPath('s1', DAEMON_DIR)
  type Writer = { n: string; where: string; file: string; how: string; seed: () => string[]; fault?: string; act: () => void }
  const writers: Writer[] = [
    {
      n: 'W2.1',
      where: 'the spawn ledger',
      file: join(DAEMON_DIR, 'spawn-ledger.jsonl'),
      how: 'the trail name is a dangling link, so the append opens into nothing',
      seed: () => {
        dangling(join(DAEMON_DIR, 'spawn-ledger.jsonl'))
        return ['spawn-ledger.jsonl']
      },
      act: () => led.recordSpawn({ kind: 'headless', id: 'w2', cwd: PROJECT }),
    },
    {
      n: 'W2.2',
      where: 'the session facts',
      file: factsPath,
      how: 'the temp name is a dangling link, so the write opens into nothing; the fault seam stands beside it for a tree still on the durable road',
      seed: () => {
        mkdirSync(dirname(factsPath))
        dangling(`${factsPath}.${process.pid}.tmp`)
        return [`s1.json.${process.pid}.tmp`]
      },
      fault: 'create-temp@session-facts/s1.json:enoent',
      act: () => seatFiles.publishSessionFacts(facts, DAEMON_DIR),
    },
    {
      n: 'W2.3',
      where: 'the session asks',
      file: asksPath,
      how: 'the temp name is a dangling link, so the write opens into nothing; the fault seam stands beside it for a tree still on the durable road',
      seed: () => {
        mkdirSync(dirname(asksPath))
        dangling(`${asksPath}.${process.pid}.tmp`)
        return [`s1.json.${process.pid}.tmp`]
      },
      fault: 'create-temp@session-asks/s1.json:enoent',
      act: () => seatFiles.publishSessionAsks({ schema: 1, sessionId: 's1', asks: [] }, DAEMON_DIR),
    },
    {
      n: 'W2.4',
      where: 'the session tail',
      file: tailPath,
      how: 'the temp name is a dangling link, so the write opens into nothing',
      seed: () => {
        mkdirSync(dirname(tailPath))
        dangling(`${tailPath}.${process.pid}.tmp`)
        return [`s1.json.${process.pid}.tmp`]
      },
      act: () => seatFiles.publishSessionTail(tail, DAEMON_DIR),
    },
    {
      n: 'W2.5',
      where: 'the session progress',
      file: progressPath,
      how: 'the temp name is a dangling link, so the write opens into nothing',
      seed: () => {
        mkdirSync(dirname(progressPath))
        dangling(`${progressPath}.${process.pid}.tmp`)
        return [`s1.json.${process.pid}.tmp`]
      },
      act: () => seatFiles.publishSessionProgress(progress, DAEMON_DIR),
    },
  ]
  for (const w of writers) {
    freshHome()
    const seeded = w.seed()
    arm()
    if (w.fault !== undefined) process.env.MERCURY_FAULT_INJECT = w.fault
    let threw = ''
    try {
      w.act()
    } catch (e) {
      threw = errText(e)
    }
    await sleep(150)
    delete process.env.MERCURY_FAULT_INJECT
    const beside = listing(dirname(w.file)).filter(name => !seeded.includes(name))
    check(
      `${w.n} ${w.where} (${w.how}): the ENOENT from the write trips the latch once, at the writer, and the writer does not throw`,
      noticed.length === 1 && noticed[0] === w.where && threw === '',
      `noticed: ${text(noticed)}; threw: ${threw || 'nothing'}`,
    )
    check(`${w.n} ${w.where}: nothing landed at ${relative(DAEMON_DIR, w.file)} and nothing else appeared beside it`, !existsSync(w.file) && beside.length === 0, `landed: ${existsSync(w.file)}; beside: ${text(beside)}`)
    check(`${w.n} ${w.where}: the presence read afterwards answers the latch, not the disk`, !homeWatch.daemonHomeStands('after the writer', DAEMON_DIR) && noticed.length === 1, `stands: true; noticed: ${text(noticed)}`)
  }
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-daemon-home-seam: ALL LAWS HOLD' : `\nprove-daemon-home-seam: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
