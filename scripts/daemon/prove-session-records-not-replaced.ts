#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const home = realpathSync(mkdtempSync(join(tmpdir(), 'session-records-kept-')))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = join(home, 'daemon')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
for (const key of [
  'MERCURY_HOME', 'MERCURY_DAEMON_PERSIST', 'MERCURY_DAEMON_OWNER_PID', 'MERCURY_DAEMON_OWNER_FD', 'MERCURY_WARM_RUNNER', 'MERCURY_SESSION_KIT',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'GOOGLE_OAUTH_TOKEN', 'MERCURY_GEMINI_OAUTH_TOKEN', 'MOONSHOT_API_KEY', 'MOONSHOT_TOKEN', 'HF_TOKEN', 'HF_OAUTH_TOKEN', 'MERCURY_COMPAT_API_KEY', 'MERCURY_COMPAT_BASE_URL', 'MERCURY_MODEL', 'MERCURY_OAUTH_TOKEN', 'CI',
]) delete process.env[key]
if (process.env.NODE_ENV === 'test') delete process.env.NODE_ENV
mkdirSync(process.env.MERCURY_DAEMON_DIR, { recursive: true })
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail: unknown = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}
const skip = (label: string, why: string): void => console.log(`  [SKIP] ${label} — ${why}`)
const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

const workers = await import('../../src/daemon/concourseWorkers.ts')
const recovery = await import('../../src/substrate/storeRecovery.ts')
type Rec = Parameters<Parameters<typeof workers.updateConcourseWorkers>[0]>[0][string]

const record = (n: number): Rec => ({ schema: 1, runnerId: `concourse-w${n}`, sessionId: `00000000-0000-4000-8000-00000000000${n}`, workspaceId: `/fixture/project-${n}`, isolation: 'exclusive', modelKey: 'fixture-model', spawnedAt: 1000 + n, lastLiveAt: 2000 + n, title: `session ${n}` }) as Rec
const THREE = `${JSON.stringify({ version: 1, workers: { 'concourse-w1': record(1), 'concourse-w2': record(2), 'concourse-w3': record(3) } }, null, 1)}\n`

const said: string[] = []
const realError = console.error
console.error = (...args: unknown[]) => void said.push(args.map(String).join(' '))

let scene = 0
const fresh = (): { dir: string; file: string } => {
  const dir = join(home, `scene-${++scene}`)
  mkdirSync(dir, { recursive: true })
  said.length = 0
  return { dir, file: workers.concourseWorkersPath(dir) }
}
const attempt = (run: () => unknown): { answered?: unknown; threw?: string } => {
  try {
    return { answered: run() }
  } catch (error) {
    return { threw: error instanceof Error ? error.message : String(error) }
  }
}
const sessionsOn = (file: string): string[] => {
  try {
    return Object.keys((JSON.parse(readFileSync(file, 'utf8')) as { workers?: Record<string, unknown> }).workers ?? {}).sort()
  } catch {
    return ['(the file does not read)']
  }
}
const asides = (file: string): string[] => readdirSync(dirname(file)).filter(name => name.startsWith('concourse-workers.json.corrupt.')).sort()
const keptLine = (file: string, why: string, aside: string): string => `[daemon] ${file}: the session records could not be used (${why}); they are kept aside at ${aside} with every session's record, and a new file is written`
const refusal = (file: string, why: string): string => `the session records at ${file} were not updated: the file is there and could not be read (${why}); nothing was written`
const spoken = (file: string, why: string): string => `[daemon] ${file}: the session records are there and could not be read (${why}), so changes to them are refused and the file is left as it stands — make it readable, or move it away and the next change writes a new one`

try {
  console.log('the session records — there and unreadable: one session\'s change does not drop every other session')
  if (!POSIX_MODES) skip('the unreadable file', 'a mode-0200 file needs a POSIX process that is not root')
  else {
    const { dir, file } = fresh()
    writeFileSync(file, THREE, { mode: 0o600 })
    chmodSync(file, 0o200)
    const add = attempt(() => workers.updateConcourseWorkers(all => void (all['concourse-w4'] = record(4)), dir))
    const again = attempt(() => workers.updateConcourseWorkers(all => void (all['concourse-w5'] = record(5)), dir))
    workers.markConcourseWorkerTurnSettled('concourse-w1', dir)
    const whileUnread = [...said]
    chmodSync(file, 0o600)
    const same = readFileSync(file, 'utf8') === THREE
    check('the change is refused, to the caller', add.threw === refusal(file, 'EACCES'), add.threw ?? `it answered ${JSON.stringify(Object.keys((add.answered ?? {}) as object))} as if it had published`)
    check('the file stands byte for byte: the three sessions are on disk', same, `on disk now: ${sessionsOn(file).join(', ')}`)
    check('daemon.log is told once what is refused, why, and what to do', whileUnread.filter(line => line === spoken(file, 'EACCES')).length === 1, whileUnread)
    check('a second refused change says it to its caller and not a second time to the log', again.threw === refusal(file, 'EACCES') && whileUnread.filter(line => line.includes('the session records are there and could not be read')).length === 1, whileUnread)
    check('a session\'s own change that was not published is named in the log by the caller that made it', whileUnread.some(line => line === `[daemon] concourse-w1: the settled turn was not stamped on its session record, it reads as working until a later turn settles: ${refusal(file, 'EACCES')}`), whileUnread)
    said.length = 0
    const later = attempt(() => workers.updateConcourseWorkers(all => void (all['concourse-w4'] = record(4)), dir))
    check('once the file reads again a change lands and keeps every session', later.threw === undefined && sessionsOn(file).join() === 'concourse-w1,concourse-w2,concourse-w3,concourse-w4', `${later.threw ?? ''} ${sessionsOn(file).join(', ')}`)
    check('…and the log says how many changes were refused meanwhile', said.includes(`[daemon] ${file}: the session records read again; changes to them were refused 3 time(s) meanwhile`), said)
  }

  for (const [title, bytes, why] of [
    ['cut short', THREE.slice(0, Math.floor(THREE.length * 0.6)), 'it is not valid JSON'],
    ['of another version', THREE.replace('"version": 1', '"version": 2'), 'it is not a version 1 session file'],
    ['holding a list where the sessions should be', '{"version":1,"workers":[]}\n', 'it is not a version 1 session file'],
    ['holding a record that is no record beside two whole ones', THREE.replace(/"concourse-w1": \{[^}]*\}/, '"concourse-w1": null'), 'it is not a version 1 session file'],
    ['holding a number where a record should be', '{"version":1,"workers":{"concourse-w1":7}}\n', 'it is not a version 1 session file'],
  ] as const) {
    console.log(`the session records — there, read and ${title}: kept aside first, then the change is written`)
    const { dir, file } = fresh()
    writeFileSync(file, bytes, { mode: 0o600 })
    const add = attempt(() => workers.updateConcourseWorkers(all => void (all['concourse-w4'] = record(4)), dir))
    const kept = asides(file)
    const copy = kept.length === 1 ? join(dir, kept[0]!) : null
    check('the change lands in a new file that holds it alone', add.threw === undefined && sessionsOn(file).join() === 'concourse-w4', add.threw ?? sessionsOn(file))
    check('the file that could not be used is kept beside it, byte for byte, under a name of its own', copy !== null && /^concourse-workers\.json\.corrupt\.\d+$/.test(kept[0]!) && readFileSync(copy, 'utf8') === bytes, `kept ${JSON.stringify(kept)} — the three sessions' records are on disk nowhere`)
    check('daemon.log is told once, with the reason and the path of the copy', copy !== null && said.filter(line => line === keptLine(file, why, copy)).length === 1, said)
    const last = ((await recovery.readStoreRecoveryEvents()) as Array<{ store?: string; kind?: string; quarantinePath?: string | null; reason?: string }>).at(-1)
    check('the recovery ledger, which the Health Check prints, names the store, the reason and where the copy is', last !== undefined && last.store === 'concourse-workers' && last.reason === why && last.quarantinePath === copy, last ?? null)
    said.length = 0
    const next = attempt(() => workers.updateConcourseWorkers(all => void (all['concourse-w5'] = record(5)), dir))
    check('the change after it keeps the first and keeps nothing more aside', next.threw === undefined && sessionsOn(file).join() === 'concourse-w4,concourse-w5' && asides(file).length === 1 && said.length === 0, { ids: sessionsOn(file), asides: asides(file), said })
  }

  console.log('the session records — two files that cannot be used in one millisecond: the second copy never clobbers the first')
  {
    const { dir, file } = fresh()
    const realNow = Date.now
    Date.now = () => 1763580000000
    writeFileSync(file, 'first torn records {')
    const first = attempt(() => workers.updateConcourseWorkers(all => void (all['concourse-w1'] = record(1)), dir))
    writeFileSync(file, 'second torn records {')
    const second = attempt(() => workers.updateConcourseWorkers(all => void (all['concourse-w2'] = record(2)), dir))
    Date.now = realNow
    const held = asides(file).map(name => readFileSync(join(dir, name), 'utf8')).sort()
    check('both are kept, each under its own name', first.threw === undefined && second.threw === undefined && JSON.stringify(held) === JSON.stringify(['first torn records {', 'second torn records {']), held)
  }

  console.log('the session records — a file that cannot be used and cannot be kept aside: that change is refused, with the reason')
  if (process.platform !== 'darwin' || !POSIX_MODES) skip('the rename that fails', 'a file that takes no rename is made here with the immutable flag of macOS')
  else {
    const { dir, file } = fresh()
    writeFileSync(file, 'torn records {')
    spawnSync('/usr/bin/chflags', ['uchg', file])
    const add = attempt(() => workers.updateConcourseWorkers(all => void (all['concourse-w4'] = record(4)), dir))
    spawnSync('/usr/bin/chflags', ['nouchg', file])
    check('the change is refused, to the caller, with both reasons', add.threw === `the session records at ${file} were not updated: the file could not be used (it is not valid JSON) and could not be kept aside (EPERM); nothing was written`, add.threw ?? 'it answered as if it had published')
    check('the file stands as it was and nothing is kept aside', readFileSync(file, 'utf8') === 'torn records {' && asides(file).length === 0, asides(file))
  }

  console.log('the session records — controls: no file is a first write, and a file that reads keeps every session')
  {
    const { dir, file } = fresh()
    const first = attempt(() => workers.updateConcourseWorkers(all => void (all['concourse-w1'] = record(1)), dir))
    check('with no file the first change writes it', first.threw === undefined && existsSync(file) && sessionsOn(file).join() === 'concourse-w1', first.threw ?? sessionsOn(file))
    const second = attempt(() => workers.updateConcourseWorkers(all => void (all['concourse-w2'] = record(2)), dir))
    check('a second change keeps the first session', second.threw === undefined && sessionsOn(file).join() === 'concourse-w1,concourse-w2', second.threw ?? sessionsOn(file))
    check('and the log is told nothing', said.length === 0, said)
  }

  const OTHER_VERSION = THREE.replace('"version": 1', '"version": 2')
  const { enableConfigs, saveGlobalConfig } = await import('../../src/utils/config/globalConfig.ts')
  enableConfigs()
  saveGlobalConfig(c => ({ ...c, switchboardCapacity: { askedAt: Date.now(), allowed: true, recommendedSeats: 8 } }))
  const started: string[] = []
  const roster = {
    has: () => ({ present: false, alive: false, ready: false }),
    list: () => started.map(short => ({ short })),
    registerLongLived: (short: string) => {
      started.push(short)
      return { ok: true, pid: process.pid }
    },
    control: () => true,
    kill: () => true,
  }
  const workspace = realpathSync(mkdtempSync(join(home, 'workspace-')))
  type Admitted = { ok: boolean; code?: string; error?: string } | { threw: string }
  const admitIn = async (dir: string, birthKey: string): Promise<Admitted> => {
    try {
      return await workers.makeConcourseAdmitHandler({ roster: () => roster as never, dir })({ workspaceDir: workspace, isolation: 'shared', bornBlank: true, birthKey })
    } catch (error) {
      return { threw: error instanceof Error ? error.message : String(error) }
    }
  }

  console.log('the session records — an admission while they cannot be read starts no runner')
  if (!POSIX_MODES) skip('the unreadable file', 'a mode-0200 file needs a POSIX process that is not root')
  else {
    const { dir, file } = fresh()
    writeFileSync(file, THREE, { mode: 0o600 })
    chmodSync(file, 0o200)
    const refused = await admitIn(dir, '7d0e3d7e-2a4c-4a0f-9c1b-000000000001')
    chmodSync(file, 0o600)
    check('the admission is refused before anything is started, with the reason', 'ok' in refused && refused.ok === false && refused.code === 'not-ready' && refused.error === `no session was started: ${refusal(file, 'EACCES')}`, refused)
    check('no runner was started and the file stands byte for byte', started.length === 0 && readFileSync(file, 'utf8') === THREE, `${started.length} runner(s) started with no record to hold them; on disk now: ${sessionsOn(file).join(', ')}`)
  }

  console.log('the session records — an admission onto a file that was read and cannot be used: the first writer keeps it aside and the session starts')
  {
    const { dir, file } = fresh()
    started.length = 0
    writeFileSync(file, OTHER_VERSION, { mode: 0o600 })
    const admitted = await admitIn(dir, '7d0e3d7e-2a4c-4a0f-9c1b-000000000002')
    const kept = asides(file)
    check('the admission lands: one runner, one record, and the old file kept aside byte for byte', 'ok' in admitted && admitted.ok === true && started.length === 1 && sessionsOn(file).length === 1 && kept.length === 1 && readFileSync(join(dir, kept[0]!), 'utf8') === OTHER_VERSION, { admitted, started, kept })
    unlinkSync(file)
    const again = await admitIn(dir, '7d0e3d7e-2a4c-4a0f-9c1b-000000000003')
    check('control: with no file the admission lands and nothing more is kept aside', 'ok' in again && again.ok === true && sessionsOn(file).length === 1 && asides(file).length === 1, again)
  }

  console.log('the session records — the daemon boots while they cannot be read, says so at the boot, and its reconcile waits')
  if (!POSIX_MODES) skip('the unreadable file', 'a mode-0200 file needs a POSIX process that is not root')
  else {
    const sweep = await import('../../src/daemon/run/sweep.ts')
    const { makeDaemonRunState } = await import('../../src/daemon/run/state.ts')
    const { DaemonBreaker } = await import('../../src/utils/daemonBreaker.ts')
    const file = workers.concourseWorkersPath()
    writeFileSync(file, THREE, { mode: 0o600 })
    chmodSync(file, 0o200)
    said.length = 0
    const state = makeDaemonRunState({ dir: home, bootBuildTree: 'aaaaaaaaaaaa', foreground: false, breaker: new DaemonBreaker(), maxInflight: 1, controlEnabled: true })
    state.roster = { list: () => [], liveWorkerFacts: () => [], kill: () => false } as never
    let tick: (() => void) | null = null
    const armed = attempt(() =>
      sweep.armReconcile(state, {
        warmDeps: { roster: () => undefined },
        armPeriodic: ((_name: string, work: () => void) => {
          tick = work
          return {} as never
        }) as never,
      }),
    )
    check('the boot reconcile does not end the boot', armed.threw === undefined, armed.threw ?? '')
    check('the boot itself tells daemon.log, before any beat, what is refused, why, and what to do', said.filter(row => row === spoken(file, 'EACCES')).length === 1, said)
    ;(tick as (() => void) | null)?.()
    ;(tick as (() => void) | null)?.()
    const line = `[daemon] the reconcile tick failed, so the records of ended sessions are not corrected and idle retirement does not run until it succeeds: ${refusal(file, 'EACCES')}`
    check('two beats: the reconcile says once why the records are not corrected', said.filter(row => row === line).length === 1, said)
    chmodSync(file, 0o600)
    check('and the file stands byte for byte through the boot and both beats', readFileSync(file, 'utf8') === THREE, `on disk now: ${sessionsOn(file).join(', ') || 'no session'}`)
    ;(tick as (() => void) | null)?.()
    check('once the file reads again the beat reconciles it and says how often a change was refused', sessionsOn(file).join() === 'concourse-w1,concourse-w2,concourse-w3' && said.some(row => row === `[daemon] ${file}: the session records read again; changes to them were refused 3 time(s) meanwhile`), said)
    unlinkSync(file)
    writeFileSync(file, OTHER_VERSION, { mode: 0o600 })
    said.length = 0
    const healed = attempt(() =>
      sweep.armReconcile(state, {
        warmDeps: { roster: () => undefined },
        armPeriodic: (() => ({}) as never) as never,
      }),
    )
    const kept = asides(file)
    check('a boot onto a file that was read and cannot be used: its reconcile keeps the file aside and writes a new one', healed.threw === undefined && kept.length === 1 && readFileSync(join(dirname(file), kept[0]!), 'utf8') === OTHER_VERSION && sessionsOn(file).length === 0 && said.some(row => row === keptLine(file, 'it is not a version 1 session file', join(dirname(file), kept[0]!))), { threw: healed.threw, kept, said })
  }
} finally {
  console.error = realError
  rmSync(home, { recursive: true, force: true })
}

console.log(`\nprove-session-records-not-replaced: ${failures === 0 ? 'green' : `${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)
