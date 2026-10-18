#!/usr/bin/env bun
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const REPO = resolve(import.meta.dir, '..', '..')
const TREE = resolve(argAfter('--tree') ?? REPO)
const SCRIPT = import.meta.path
const STALE_MS = 10_000
const flagPath = (world: string, name: string): string => join(world, 'flags', name)
const raise = (name: string, world: string, body = 'yes'): void => writeFileSync(flagPath(world, name), body)
const raised = (name: string, world: string): boolean => existsSync(flagPath(world, name))
const readFlag = (name: string, world: string): string => readFileSync(flagPath(world, name), 'utf8')
const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}
const awaitFlagSync = (name: string, world: string, ms: number): void => {
  const deadline = Date.now() + ms
  while (!raised(name, world)) {
    if (Date.now() > deadline) throw new Error(`fixture: ${name} never rose within ${ms} ms`)
    sleepSync(5)
  }
}
const row = (name: string, world: string): Record<string, unknown> => ({
  schema: 1,
  runnerId: name,
  sessionId: `${name}-session`,
  workspaceId: world,
  isolation: 'shared',
  modelKey: 'fixture',
  effort: 'high',
  spawnedAt: Date.now(),
  lastLiveAt: Date.now(),
  pid: process.pid,
  activity: { state: 'idle', subagents: 0, description: 'idle', lastTurnAt: null },
})

type Store = {
  updateConcourseWorkers: (mutate: (workers: Record<string, Record<string, unknown>>) => void, dir?: string) => Record<string, Record<string, unknown>>
  readSessionWorkers: (dir?: string) => Record<string, Record<string, unknown>>
  concourseWorkersPath: (dir?: string) => string
}
const loadStore = async (): Promise<Store> => {
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  return (await import(pathToFileURL(join(TREE, 'src', 'daemon', 'concourseWorkers.ts')).href)) as Store
}
const loadHome = async (): Promise<{ armDaemonHomeWatch: (dir: string, onGone: (where: string) => void) => void }> =>
  (await import(pathToFileURL(join(TREE, 'src', 'daemon', 'daemonHome.ts')).href)) as never

if (process.argv[2] === 'child') {
  const [role, world, ...rest] = process.argv.slice(3) as [string, string, ...string[]]
  const dir = join(world, 'home', 'daemon')
  const store = await loadStore()
  const keysNow = (): string[] => Object.keys(store.readSessionWorkers(dir)).sort()
  if (role === 'hold') {
    const [kind, name, field, value] = rest as [string, string, string | undefined, string | undefined]
    store.updateConcourseWorkers(workers => {
      raise('hold-in', world, JSON.stringify(Object.keys(workers).sort()))
      awaitFlagSync('hold-go', world, 8_000)
      if (kind === 'add') workers[name] = row(name, world)
      else {
        workers[name] ??= row(name, world)
        workers[name][field!] = value
      }
    }, dir)
    raise('hold-done', world, JSON.stringify(keysNow()))
  } else if (role === 'add') {
    const [name] = rest as [string]
    const startedAt = Date.now()
    let seen: string[] = []
    raise(`${name}-entering`, world)
    store.updateConcourseWorkers(workers => {
      seen = Object.keys(workers).sort()
      workers[name] = row(name, world)
    }, dir)
    raise(`${name}-published`, world, JSON.stringify({ seen, after: keysNow(), waitedMs: Date.now() - startedAt }))
  } else if (role === 'field') {
    const [name, field, value] = rest as [string, string, string]
    let before: unknown
    raise(`${field}-entering`, world)
    store.updateConcourseWorkers(workers => {
      before = workers[name]?.[field === 'title' ? 'effort' : 'title']
      workers[name] ??= row(name, world)
      workers[name][field] = value
    }, dir)
    raise(`${field}-published`, world, JSON.stringify({ before, record: store.readSessionWorkers(dir)[name] }))
  } else if (role === 'stress') {
    const [name, count] = rest as [string, string]
    for (let i = 1; i <= Number(count); i++) {
      const key = `${name}-${i}`
      store.updateConcourseWorkers(workers => { workers[key] = row(key, world) }, dir)
      store.updateConcourseWorkers(workers => { workers[key]!.title = `${key} titled` }, dir)
      if (i % 3 === 0) store.updateConcourseWorkers(workers => { delete workers[key] }, dir)
    }
    raise(`${name}-stressed`, world)
  } else if (role === 'die') {
    store.updateConcourseWorkers(workers => {
      workers['never'] = row('never', world)
      raise('die-in', world)
      process.kill(process.pid, 'SIGKILL')
    }, dir)
  } else if (role === 'nest') {
    let innerReturn: Record<string, unknown> | null = null
    let outerSawInner = false
    const outer = store.updateConcourseWorkers(workers => {
      workers['outer'] = row('outer', world)
      innerReturn = store.updateConcourseWorkers(inner => { inner['inner'] = row('inner', world) }, dir)
      outerSawInner = workers['inner'] !== undefined
    }, dir)
    raise('nest-done', world, JSON.stringify({ sameObject: innerReturn === outer, outerSawInner, after: keysNow(), lockLeft: existsSync(`${store.concourseWorkersPath(dir)}.lock`) }))
  } else if (role === 'armed-gone') {
    const home = await loadHome()
    const gone: string[] = []
    home.armDaemonHomeWatch(dir, where => gone.push(where))
    store.updateConcourseWorkers(workers => { workers['before-gone'] = row('before-gone', world) }, dir)
    const published = keysNow()
    rmSync(dir, { recursive: true, force: true })
    const returned = store.updateConcourseWorkers(workers => { workers['ghost'] = row('ghost', world) }, dir)
    const again = store.updateConcourseWorkers(workers => { workers['ghost-2'] = row('ghost-2', world) }, dir)
    raise('armed-gone-done', world, JSON.stringify({ published, gone, returned: Object.keys(returned).sort(), again: Object.keys(again).sort(), dirExists: existsSync(dir), homeExists: existsSync(join(world, 'home')) }))
  } else throw new Error(`unknown child role ${role}`)
  process.exit(0)
}

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail: unknown = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`)
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'session-records-')))
const KEEP = process.argv.includes('--keep')
console.log(`tree under proof: ${TREE}`)
console.log(`scratch: ${scratch}`)
for (const key of ['MERCURY_HOME', 'MERCURY_DAEMON_DIR', 'MERCURY_DAEMON_OWNER_PID', 'MERCURY_DAEMON_OWNER_FD', 'MERCURY_FAULT_INJECT']) delete process.env[key]

type Child = { proc: ChildProcess; exit: Promise<number | null>; out: () => string }
const children: Child[] = []
const world = (name: string): string => {
  const w = join(scratch, name)
  mkdirSync(join(w, 'flags'), { recursive: true })
  mkdirSync(join(w, 'home', 'daemon'), { recursive: true })
  return w
}
const dirOf = (w: string): string => join(w, 'home', 'daemon')
const start = (role: string, w: string, args: string[], env: Record<string, string> = {}): Child => {
  const proc = spawn(process.execPath, [SCRIPT, 'child', role, w, ...args, ...(argAfter('--tree') ? ['--tree', TREE] : [])], {
    env: { ...process.env, MERCURY_CONFIG_DIR: join(w, 'home'), MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let text = ''
  proc.stdout?.on('data', d => { text += d })
  proc.stderr?.on('data', d => { text += d })
  const child: Child = { proc, exit: new Promise(r => proc.once('exit', code => r(code))), out: () => text }
  children.push(child)
  return child
}
const until = async (predicate: () => boolean, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) return false
    await sleep(10)
  }
  return true
}
const store = await loadStore()
const keysIn = (w: string): string[] => Object.keys(store.readSessionWorkers(dirOf(w))).sort()
const listing = (w: string): string[] => (existsSync(dirOf(w)) ? readdirSync(dirOf(w)).sort() : [])
const lockDirOf = (w: string): string => `${store.concourseWorkersPath(dirOf(w))}.lock`
const ownerOf = (w: string): string => `${lockDirOf(w)}.owner`
const parse = (text: string): Record<string, unknown> => JSON.parse(text) as Record<string, unknown>

try {
  section('§1 the lost-update law: a writer inside its section is not overtaken, and the overtaker reads what it published')
  {
    const w = world('law')
    store.updateConcourseWorkers(workers => { workers['seed'] = row('seed', w) }, dirOf(w))
    const a = start('hold', w, ['add', 'concourse-a'])
    check('writer A entered its section', await until(() => raised('hold-in', w), 15_000), a.out())
    const b = start('add', w, ['concourse-b'])
    check('writer B reached its own update call while A holds the section', await until(() => raised('concourse-b-entering', w), 15_000), b.out())
    await sleep(400)
    const bWaited = !raised('concourse-b-published', w)
    check('writer B has not published while A holds the section (B is serialized behind A)', bWaited, { listing: listing(w), b: b.out() })
    const readStartedAt = Date.now()
    const readDuringHold = keysIn(w)
    check('a read during the held section does not block and reads the last publication', Date.now() - readStartedAt < 1_000 && readDuringHold.join() === 'seed', readDuringHold)
    raise('hold-go', w)
    const codes = await Promise.all([a.exit, b.exit])
    check('both writers exit 0', codes.every(c => c === 0), { codes, a: a.out(), b: b.out() })
    const final = keysIn(w)
    check('the session list carries the seed and BOTH records', final.join() === 'concourse-a,concourse-b,seed', final)
    const bReceipt = raised('concourse-b-published', w) ? parse(readFlag('concourse-b-published', w)) : null
    check("B's own read inside its section already carried A's record (sequential, never a stale snapshot)", bReceipt !== null && (bReceipt.seen as string[]).join() === 'concourse-a,seed', bReceipt)
    check('no lock directory lingers after the writers leave', !existsSync(lockDirOf(w)), listing(w))
    check('the daemon directory carries only the records and the delta stamp', listing(w).join() === 'concourse-delta.json,concourse-workers.json', listing(w))
  }

  section('§2 the file on disk keeps its bytes: version 1, the same JSON shape every build reads')
  {
    const w = world('bytes')
    rmSync(dirOf(w), { recursive: true, force: true })
    const c = start('add', w, ['concourse-one'])
    check('the writer exits 0', (await c.exit) === 0, c.out())
    check('a fresh home: the first update creates the daemon directory and the file (no armed watch)', existsSync(store.concourseWorkersPath(dirOf(w))), listing(w))
    const text = existsSync(store.concourseWorkersPath(dirOf(w))) ? readFileSync(store.concourseWorkersPath(dirOf(w)), 'utf8') : ''
    const expected = `${JSON.stringify({ version: 1, workers: store.readSessionWorkers(dirOf(w)) }, null, 1)}\n`
    check('the published bytes are exactly the version-1 document the reader hands back', text === expected, { head: text.slice(0, 80) })
    check('no lock directory lingers', !existsSync(lockDirOf(w)), listing(w))
  }

  section('§3 many processes create, update and delete their own records at once; nothing is lost')
  {
    const w = world('stress')
    const names = ['p1', 'p2', 'p3', 'p4']
    const per = 12
    const stressers = names.map(name => start('stress', w, [name, String(per)]))
    const codes = await Promise.all(stressers.map(s => s.exit))
    check('every stress writer exits 0', codes.every(c => c === 0), { codes, out: stressers.map(s => s.out()) })
    const expected: string[] = []
    for (const name of names) for (let i = 1; i <= per; i++) if (i % 3 !== 0) expected.push(`${name}-${i}`)
    const final = store.readSessionWorkers(dirOf(w))
    const keys = Object.keys(final).sort()
    check(`the surviving set is exactly the ${expected.length} records every writer created and did not delete`, keys.join() === expected.sort().join(), { missing: expected.filter(k => !keys.includes(k)), extra: keys.filter(k => !expected.includes(k)) })
    check('every surviving record carries its last update', expected.every(k => final[k]?.title === `${k} titled`), expected.filter(k => final[k]?.title !== `${k} titled`))
    check('no lock directory lingers', !existsSync(lockDirOf(w)), listing(w))
  }

  section('§4 the same record from two processes: each field lands, and the later writer reads the earlier publish')
  {
    const w = world('shared')
    const a = start('hold', w, ['field', 'shared', 'title', 'named by A'])
    check('writer A entered its section', await until(() => raised('hold-in', w), 15_000), a.out())
    const b = start('field', w, ['shared', 'effort', 'low'])
    check('writer B reached its own update call while A holds the section', await until(() => raised('effort-entering', w), 15_000), b.out())
    await sleep(400)
    check('writer B has not published while A holds the section', !raised('effort-published', w), b.out())
    raise('hold-go', w)
    const codes = await Promise.all([a.exit, b.exit])
    check('both writers exit 0', codes.every(c => c === 0), { codes, a: a.out(), b: b.out() })
    const rec = store.readSessionWorkers(dirOf(w))['shared']
    check("the record carries A's title AND B's effort", rec?.title === 'named by A' && rec?.effort === 'low', rec)
    const bReceipt = raised('effort-published', w) ? parse(readFlag('effort-published', w)) : null
    check("B's mutate saw A's title already on the record", bReceipt?.before === 'named by A', bReceipt)
  }

  section('§5 same-process nesting joins the outer transaction: one publish, both records, no self-deadlock')
  {
    const w = world('nest')
    const c = start('nest', w, [])
    check('the nesting writer exits 0', (await c.exit) === 0, c.out())
    const receipt = raised('nest-done', w) ? parse(readFlag('nest-done', w)) : null
    check('the inner update returned the outer transaction object and the outer saw the inner record', receipt?.sameObject === true && receipt?.outerSawInner === true, receipt)
    check('both records are on disk', (receipt?.after as string[] | undefined)?.join() === 'inner,outer', receipt)
    check('no lock directory lingered at the end of the nested update', receipt?.lockLeft === false, receipt)
  }

  section('§6 an interrupted writer: killed inside its section, the file stays old-complete and the next writer reclaims the dead holder at once')
  {
    const w = world('die')
    store.updateConcourseWorkers(workers => { workers['kept'] = row('kept', w) }, dirOf(w))
    const bytesBefore = readFileSync(store.concourseWorkersPath(dirOf(w)), 'utf8')
    const d = start('die', w, [])
    check('the doomed writer entered its section', await until(() => raised('die-in', w), 15_000), d.out())
    const code = await d.exit
    check('it was killed (SIGKILL, no exit code)', code === null, { code, out: d.out() })
    check('its lock directory and its owner record (its pid) are left behind', existsSync(lockDirOf(w)) && existsSync(ownerOf(w)) && Number(readFileSync(ownerOf(w), 'utf8').trim()) === d.proc.pid, listing(w))
    check('the file is unchanged and readable (old-complete)', readFileSync(store.concourseWorkersPath(dirOf(w)), 'utf8') === bytesBefore && keysIn(w).join() === 'kept', keysIn(w))
    const startedAt = Date.now()
    const next = start('add', w, ['after-death'])
    check('the next writer exits 0', (await next.exit) === 0, next.out())
    const waitedMs = Date.now() - startedAt
    const receipt = raised('after-death-published', w) ? parse(readFlag('after-death-published', w)) : null
    check('it read the dead owner and reclaimed the lock without waiting the stale law out', waitedMs < STALE_MS / 2, { waitedMs, receipt })
    check('its record landed beside the kept one; the never-published record is absent', keysIn(w).join() === 'after-death,kept', keysIn(w))
    check('the abandoned lock and its owner record are gone', !existsSync(lockDirOf(w)) && !existsSync(ownerOf(w)), listing(w))
  }

  section(`§6b a lock with no owner record falls back to the stale law: the next writer waits the ${STALE_MS / 1000} s out rather than publishing over it`)
  {
    const w = world('die-unowned')
    store.updateConcourseWorkers(workers => { workers['kept'] = row('kept', w) }, dirOf(w))
    const d = start('die', w, [])
    check('the doomed writer entered its section', await until(() => raised('die-in', w), 15_000), d.out())
    check('it was killed (SIGKILL, no exit code)', (await d.exit) === null, d.out())
    rmSync(ownerOf(w), { force: true })
    check('its lock directory stands with no owner record', existsSync(lockDirOf(w)) && !existsSync(ownerOf(w)), listing(w))
    const startedAt = Date.now()
    const next = start('add', w, ['after-stale'])
    check('the next writer exits 0', (await next.exit) === 0, next.out())
    const waitedMs = Date.now() - startedAt
    check('it waited the stale law out before taking the lock', waitedMs >= STALE_MS - 1_500 && waitedMs < STALE_MS + 7_000, { waitedMs })
    check('its record landed beside the kept one', keysIn(w).join() === 'after-stale,kept', keysIn(w))
    check('the lock is gone', !existsSync(lockDirOf(w)), listing(w))
  }

  section('§6c a lock whose owner is alive is never taken from it: the writer waits until the owner lets go')
  {
    const w = world('live-owner')
    store.updateConcourseWorkers(workers => { workers['kept'] = row('kept', w) }, dirOf(w))
    mkdirSync(lockDirOf(w))
    writeFileSync(ownerOf(w), `${process.pid}\n`)
    const startedAt = Date.now()
    const next = start('add', w, ['after-owner'])
    check('the writer reached its update call', await until(() => raised('after-owner-entering', w), 15_000), next.out())
    await sleep(1_500)
    check('the writer has not published while the live owner holds the lock', !raised('after-owner-published', w) && existsSync(lockDirOf(w)) && existsSync(ownerOf(w)), listing(w))
    rmSync(ownerOf(w), { force: true })
    rmSync(lockDirOf(w), { recursive: true, force: true })
    check('the writer exits 0 once the owner let go', (await next.exit) === 0, next.out())
    check('it published only after the owner let go', Date.now() - startedAt >= 1_500 && keysIn(w).join() === 'after-owner,kept', { waitedMs: Date.now() - startedAt, keys: keysIn(w) })
  }

  section('§7 an interrupted publication: killed at the flush, the destination is untouched and the next writer reclaims the dead holder')
  {
    const w = world('flush-kill')
    store.updateConcourseWorkers(workers => { workers['kept'] = row('kept', w) }, dirOf(w))
    const bytesBefore = readFileSync(store.concourseWorkersPath(dirOf(w)), 'utf8')
    const d = start('add', w, ['torn'], { MERCURY_FAULT_INJECT: 'flush-file@concourse-workers.json:kill' })
    const code = await d.exit
    check('the writer was killed at the flush (no exit code)', code === null, { code, out: d.out() })
    check('the destination is byte-identical and readable', readFileSync(store.concourseWorkersPath(dirOf(w)), 'utf8') === bytesBefore && keysIn(w).join() === 'kept', keysIn(w))
    const left = listing(w)
    check('its lock directory, its owner record and its own temp were left behind (the orphan sweep owns the temp)', existsSync(lockDirOf(w)) && existsSync(ownerOf(w)) && left.some(n => /^\.concourse-workers\.json\.\d+\.[0-9a-f]{8}\.tmp$/.test(n)), left)
    const startedAt = Date.now()
    const next = start('add', w, ['after-flush'])
    check('the next writer exits 0', (await next.exit) === 0, next.out())
    check('it reclaimed the dead holder without waiting the stale law out', Date.now() - startedAt < STALE_MS / 2, { waitedMs: Date.now() - startedAt })
    check('its record landed; the torn record never did', keysIn(w).join() === 'after-flush,kept', keysIn(w))
    check('the reclaimed lock and its owner record are released', !existsSync(lockDirOf(w)) && !existsSync(ownerOf(w)), listing(w))
  }

  section('§8 ownership loss: a lock removed or re-held under a writer refuses its publish, and never removes the new holder')
  {
    const w = world('lost')
    store.updateConcourseWorkers(workers => { workers['kept'] = row('kept', w) }, dirOf(w))
    const bytesBefore = readFileSync(store.concourseWorkersPath(dirOf(w)), 'utf8')
    const a = start('hold', w, ['add', 'orphaned'])
    check('writer A entered its section', await until(() => raised('hold-in', w), 15_000), a.out())
    rmSync(lockDirOf(w), { recursive: true, force: true })
    raise('hold-go', w)
    const codeA = await a.exit
    check('A exits non-zero with the typed refusal', codeA !== 0 && a.out().includes('SessionRecordsLockError') && a.out().includes('lock was lost'), { codeA, out: a.out() })
    check('the file is byte-identical: nothing was published over the lost lock', readFileSync(store.concourseWorkersPath(dirOf(w)), 'utf8') === bytesBefore, keysIn(w))
    rmSync(join(w, 'flags'), { recursive: true, force: true })
    mkdirSync(join(w, 'flags'))
    const b = start('hold', w, ['add', 'stolen'])
    check('writer B entered its section', await until(() => raised('hold-in', w), 15_000), b.out())
    rmSync(lockDirOf(w), { recursive: true, force: true })
    mkdirSync(lockDirOf(w))
    writeFileSync(join(lockDirOf(w), 'holder'), 'another process')
    raise('hold-go', w)
    const codeB = await b.exit
    check('B exits non-zero with the typed refusal', codeB !== 0 && b.out().includes('SessionRecordsLockError'), { codeB, out: b.out() })
    check("the new holder's lock directory is still standing (B did not release what it no longer owned)", existsSync(join(lockDirOf(w), 'holder')), listing(w))
    check('the file is still byte-identical', readFileSync(store.concourseWorkersPath(dirOf(w)), 'utf8') === bytesBefore, keysIn(w))
    rmSync(lockDirOf(w), { recursive: true, force: true })
  }

  section('§9 the daemon-home-gone law: under an armed watch a removed home gets no lock, no file, no directory back')
  {
    const w = world('gone')
    const c = start('armed-gone', w, [])
    check('the armed writer exits 0 (an update after the removal returns, it never throws)', (await c.exit) === 0, c.out())
    const receipt = raised('armed-gone-done', w) ? parse(readFlag('armed-gone-done', w)) : null
    check('the first update published under the standing home', (receipt?.published as string[] | undefined)?.join() === 'before-gone', receipt)
    check('the watch tripped exactly once, at the session records', Array.isArray(receipt?.gone) && (receipt!.gone as string[]).length === 1 && (receipt!.gone as string[])[0] === 'the session records', receipt)
    check('the mutations still ran in memory and were handed back', (receipt?.returned as string[] | undefined)?.join() === 'ghost' && (receipt?.again as string[] | undefined)?.join() === 'ghost-2', receipt)
    check('nothing was resurrected: no daemon directory, no lock, no file', receipt?.dirExists === false && !existsSync(dirOf(w)) && !existsSync(lockDirOf(w)), { receipt, listing: listing(w) })
  }

  section('§10 unreadable bytes keep the declared fail-soft law: the next update reads them as empty and republishes')
  {
    const w = world('garbage')
    writeFileSync(store.concourseWorkersPath(dirOf(w)), '{"version":1,"workers":{"half":{"runnerId":"ha')
    const c = start('add', w, ['fresh'])
    check('the writer exits 0', (await c.exit) === 0, c.out())
    const receipt = raised('fresh-published', w) ? parse(readFlag('fresh-published', w)) : null
    check('the mutate saw an empty list and the file now carries the fresh record alone', (receipt?.seen as string[] | undefined)?.length === 0 && keysIn(w).join() === 'fresh', { receipt, keys: keysIn(w) })
  }
} finally {
  for (const child of children) {
    if (child.proc.exitCode === null && child.proc.signalCode === null) {
      try {
        child.proc.kill('SIGKILL')
      } catch {
      }
    }
  }
}

console.log(`\n${checks} checks, ${failures} failures`)
if (failures === 0 && !KEEP) rmSync(scratch, { recursive: true, force: true })
else console.log(`scratch kept: ${scratch}`)
console.log(failures === 0 ? 'prove-session-records-serialized: ALL LAWS HOLD' : `prove-session-records-serialized: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
