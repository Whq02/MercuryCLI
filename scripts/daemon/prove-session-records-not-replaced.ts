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
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)} — change: the unreadable-file refusal and the keep-aside of a file that cannot be used live in updateConcourseWorkers in src/daemon/concourse-workers/store.ts; the checks on a dispatched turn, an admission, a revive and the boot reconcile are answered by makeConcourseDispatchHandler in src/daemon/concourse-workers/concourseDispatch.ts, makeConcourseAdmitHandler and reviveConcourseWorker in src/daemon/concourse-workers/concourseWorkers.ts, and armReconcile in src/daemon/run/sweep.ts; compare the wording with refusal, spoken and keptLine at the top of this file` : ''}`)
}
const skip = (label: string, why: string): void => console.log(`  [SKIP] ${label} — ${why}`)
const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

const workers = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')
const recovery = await import('../../src/platform/substrate/storeRecovery.ts')
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
const keptLine = (file: string, why: string, aside: string): string => `[daemon] ${file}: the session records could not be used (${why}); the file is kept aside at ${aside} as it stood, and the new file starts with no session, no live session's record being held in memory; what the file held is in the kept file only`
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

  console.log('the session records — cut short while a session is live: the new file starts from that session, and it takes its next turn')
  {
    const dispatch = await import('../../src/daemon/concourse-workers/concourseDispatch.ts')
    const { dir, file } = fresh()
    const live = { ...record(1), pid: process.pid, effort: 'high', agentName: 'fixture', birthKey: 'born-live', title: 'the live one' } as Rec
    const parked = { ...record(2), parkedAt: 3000, parkedBy: 'operator', title: 'the parked one' } as Rec
    workers.updateConcourseWorkers(all => {
      all['concourse-w1'] = live
      all['concourse-w2'] = parked
    }, dir)
    const whole = readFileSync(file, 'utf8')
    const cut = whole.slice(0, Math.floor(whole.length / 2))
    const onDisk = (): Record<string, Rec> => {
      try {
        return (JSON.parse(readFileSync(file, 'utf8')) as { workers: Record<string, Rec> }).workers
      } catch {
        return {}
      }
    }
    const carriedWhole = (rec: Rec | undefined): boolean => rec !== undefined && rec.sessionId === live.sessionId && rec.pid === process.pid && rec.title === 'the live one' && rec.effort === 'high' && rec.agentName === 'fixture' && rec.birthKey === 'born-live'
    const startsFromLive = (copy: string): string => `[daemon] ${file}: the session records could not be used (it is not valid JSON); the file is kept aside at ${copy} as it stood, and the new file starts from the records held in memory of the 1 live session(s) (concourse-w1); what the file held of any other session is in the kept file only`

    writeFileSync(file, cut)
    said.length = 0
    const delivered: string[] = []
    const handler = dispatch.makeConcourseDispatchHandler({ admit: async () => ({ ok: false, code: 'invalid-request', error: 'the fixture admits nothing' }) as never, deliver: async runnerId => (delivered.push(runnerId), true), dir })
    const turn = await handler({ clientMessageId: 'the-next-turn', prompt: 'the next turn', workspaceDir: dir, targetSessionId: live.sessionId })
    await dispatch.flushDeferredDispatchPublishes()
    const kept = asides(file)
    const copy = kept.length === 1 ? join(dir, kept[0]!) : null
    check('the live session takes its next turn, the first thing asked after the cut: the prompt is delivered to its runner', turn.ok === true && delivered.join() === 'concourse-w1', turn.error ?? delivered)
    check('the new file holds the live session\'s record as it was', carriedWhole(onDisk()['concourse-w1']), `on disk now: ${sessionsOn(file).join(', ') || 'no session'}`)
    check('the session that is not live is in the kept file only, and the kept file is the cut file byte for byte', onDisk()['concourse-w2'] === undefined && copy !== null && readFileSync(copy, 'utf8') === cut, { ids: sessionsOn(file), kept })
    check('daemon.log says what the kept file is and what the new file starts from', copy !== null && said.filter(line => line === startsFromLive(copy)).length === 1, said)

    writeFileSync(file, cut)
    said.length = 0
    workers.markConcourseWorkerTurnSettled('concourse-w1', dir)
    const second = asides(file).filter(name => !kept.includes(name))
    check('cut a second time, a stamp on the live session finds its record: the new file holds it, with the stamp', carriedWhole(onDisk()['concourse-w1']) && typeof onDisk()['concourse-w1']?.lastTurnSettledAt === 'number' && second.length === 1 && said.filter(line => line === startsFromLive(join(dir, second[0] ?? ''))).length === 1, { ids: sessionsOn(file), second, said })
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
  const { enableConfigs, saveGlobalConfig } = await import('../../src/platform/config/globalConfig.ts')
  enableConfigs()
  saveGlobalConfig(c => ({ ...c, switchboardCapacity: { askedAt: Date.now(), allowed: true, recommendedSeats: 8 } }))
  const started: string[] = []
  const ended: string[] = []
  const roster = {
    has: () => ({ present: false, alive: false, ready: false }),
    list: () => started.map(short => ({ short })),
    registerLongLived: (short: string) => {
      started.push(short)
      return { ok: true, pid: process.pid }
    },
    control: () => true,
    kill: (short: string) => (ended.push(short), true),
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

  console.log('the session records — while they cannot be written no runner is started, and a runner whose record could not be written is ended')
  if (process.platform !== 'darwin' || !POSIX_MODES) skip('the rename that fails', 'a file that takes no rename is made here with the immutable flag of macOS')
  else {
    const unwritten = (file: string): string => `no session was started: the session records at ${file} were not updated: the file could not be used (it is not valid JSON) and could not be kept aside (EPERM); nothing was written`
    const held = fresh()
    started.length = 0
    writeFileSync(held.file, 'torn records {')
    spawnSync('/usr/bin/chflags', ['uchg', held.file])
    const first = await admitIn(held.dir, '7d0e3d7e-2a4c-4a0f-9c1b-000000000004')
    const second = await admitIn(held.dir, '7d0e3d7e-2a4c-4a0f-9c1b-000000000005')
    spawnSync('/usr/bin/chflags', ['nouchg', held.file])
    check('two admissions are refused before anything is started, each with the reason', [first, second].every(answer => 'ok' in answer && answer.ok === false && answer.code === 'not-ready' && answer.error === unwritten(held.file)) && started.length === 0, { first, second, started: `${started.length} runner(s) started with no record to hold them` })
    const whole = fresh()
    started.length = 0
    ended.length = 0
    workers.updateConcourseWorkers(all => void (all['concourse-w9'] = record(9)), whole.dir)
    spawnSync('/usr/bin/chflags', ['uchg', whole.file])
    const third = await admitIn(whole.dir, '7d0e3d7e-2a4c-4a0f-9c1b-000000000006')
    const afterThird = [started.length, ended.join()]
    const fourth = await admitIn(whole.dir, '7d0e3d7e-2a4c-4a0f-9c1b-000000000007')
    const afterFourth = [started.length, ended.join()]
    spawnSync('/usr/bin/chflags', ['nouchg', whole.file])
    const fifth = await admitIn(whole.dir, '7d0e3d7e-2a4c-4a0f-9c1b-000000000008')
    const unrecorded = (answer: Admitted): boolean => 'ok' in answer && answer.ok === false && answer.code === 'not-ready' && (answer.error ?? '').startsWith('no session was started: ') && (answer.error ?? '').includes(whole.file)
    check('a file that reads and takes no write: the runner whose record could not be written is ended, and the admission says no session was started', unrecorded(third) && JSON.stringify(afterThird) === JSON.stringify([1, started[0]]), { third, afterThird })
    check('…and the next admission is refused before anything is started', unrecorded(fourth) && JSON.stringify(afterFourth) === JSON.stringify(afterThird), { fourth, afterFourth })
    check('once the file takes a write again a session starts, beside the one that was on record', 'ok' in fifth && fifth.ok === true && started.length === 2 && ended.length === 1 && sessionsOn(whole.file).length === 2, { fifth, started, ended, ids: sessionsOn(whole.file) })
  }

  console.log('the session records — a runner that came back while they took no write: its new pid is stamped at the next change, and carried when the file is rebuilt')
  if (process.platform !== 'darwin' || !POSIX_MODES) skip('the rename that fails', 'a file that takes no rename is made here with the immutable flag of macOS')
  else {
    const gone = spawnSync(process.execPath, ['-e', '']).pid ?? 0
    const pidOn = (file: string): number | undefined => {
      try {
        return (JSON.parse(readFileSync(file, 'utf8')) as { workers: Record<string, Rec> }).workers['concourse-w1']?.pid
      } catch {
        return undefined
      }
    }
    const whole = fresh()
    workers.updateConcourseWorkers(all => void (all['concourse-w1'] = { ...record(1), pid: gone } as Rec), whole.dir)
    spawnSync('/usr/bin/chflags', ['uchg', whole.file])
    workers.markConcourseWorkerRespawn('concourse-w1', process.pid, whole.dir)
    spawnSync('/usr/bin/chflags', ['nouchg', whole.file])
    const namedMeanwhile = pidOn(whole.file)
    workers.markConcourseWorkerTurnSettled('concourse-w1', whole.dir)
    check('a file that reads and takes no write: the record names the runner that is gone until a change lands, then the one that lives', namedMeanwhile === gone && pidOn(whole.file) === process.pid, `the record named pid ${namedMeanwhile} meanwhile and names ${pidOn(whole.file)} after the next change; the runner that lives is ${process.pid}`)
    const cut = fresh()
    workers.updateConcourseWorkers(all => void (all['concourse-w1'] = { ...record(1), pid: gone } as Rec), cut.dir)
    writeFileSync(cut.file, readFileSync(cut.file, 'utf8').slice(0, 40))
    spawnSync('/usr/bin/chflags', ['uchg', cut.file])
    workers.markConcourseWorkerRespawn('concourse-w1', process.pid, cut.dir)
    spawnSync('/usr/bin/chflags', ['nouchg', cut.file])
    workers.markConcourseWorkerTurnSettled('concourse-w1', cut.dir)
    check('a file cut short that could not be kept aside meanwhile: the rebuilt file carries the session, under the pid of the runner that lives', pidOn(cut.file) === process.pid && asides(cut.file).length === 1, `on disk now: ${sessionsOn(cut.file).join(', ') || 'no session'} · pid ${pidOn(cut.file)}`)
  }

  console.log('the session records — a session brought back while they take no write: the runner started for it is ended, and the answer says why')
  if (process.platform !== 'darwin' || !POSIX_MODES) skip('the rename that fails', 'a file that takes no rename is made here with the immutable flag of macOS')
  else {
    const gone = spawnSync(process.execPath, ['-e', '']).pid ?? 0
    const { dir, file } = fresh()
    const rested = { ...record(1), workspaceId: workspace, pid: gone } as Rec
    workers.updateConcourseWorkers(all => void (all['concourse-w1'] = rested), dir)
    const transcript = workers.concourseTranscriptPath(rested)
    mkdirSync(dirname(transcript), { recursive: true })
    writeFileSync(transcript, '')
    started.length = 0
    ended.length = 0
    spawnSync('/usr/bin/chflags', ['uchg', file])
    const revived = attempt(() => workers.reviveConcourseWorker(rested.sessionId, 'operator', roster as never, {}, dir))
    spawnSync('/usr/bin/chflags', ['nouchg', file])
    const answer = revived.answered as { outcome?: string; reason?: string; detail?: string } | undefined
    check('the revive is refused with the reason, to its caller, and the runner it started is ended', revived.threw === undefined && answer?.outcome === 'refused' && answer.reason === 'respawn-failed' && (answer.detail ?? '').includes(file) && started.join() === 'concourse-w1' && ended.join() === 'concourse-w1', { revived, started, ended })
  }

  console.log('the session records — a turn sent to a live session while they cannot be read: the answer is the refusal, not a session with no runner')
  if (!POSIX_MODES) skip('the unreadable file', 'a mode-0200 file needs a POSIX process that is not root')
  else {
    const dispatch = await import('../../src/daemon/concourse-workers/concourseDispatch.ts')
    const { dir, file } = fresh()
    const live = { ...record(1), pid: process.pid } as Rec
    workers.updateConcourseWorkers(all => void (all['concourse-w1'] = live), dir)
    const before = readFileSync(file, 'utf8')
    chmodSync(file, 0o200)
    const delivered: string[] = []
    const handler = dispatch.makeConcourseDispatchHandler({ admit: async () => ({ ok: false, code: 'invalid-request', error: 'the fixture admits nothing' }) as never, deliver: async runnerId => (delivered.push(runnerId), true), dir })
    const turn = await handler({ clientMessageId: 'a-turn-while-unread', prompt: 'a turn', workspaceDir: dir, targetSessionId: live.sessionId })
    await dispatch.flushDeferredDispatchPublishes()
    chmodSync(file, 0o600)
    check('the turn is refused in the records\' own sentence, nothing is delivered and the file stands', turn.ok === false && turn.error === refusal(file, 'EACCES') && delivered.length === 0 && readFileSync(file, 'utf8') === before, turn.error ?? delivered)
  }

  console.log('the session records — a parked session resumed while they take no write: the admission answers the refusal and throws nothing')
  if (process.platform !== 'darwin' || !POSIX_MODES) skip('the rename that fails', 'a file that takes no rename is made here with the immutable flag of macOS')
  else {
    const gone = spawnSync(process.execPath, ['-e', '']).pid ?? 0
    for (const [title, fields] of [
      ['its record needs a change before any runner starts', {}],
      ['its runner is started, cannot be recorded and is ended', { isolation: 'shared', modelKey: 'choose-a-model', effort: 'high' }],
    ] as const) {
      const { dir, file } = fresh()
      const rested = { ...record(1), workspaceId: workspace, pid: gone, parkedAt: 3000, parkedBy: 'operator', keyless: true, ...fields } as Rec
      workers.updateConcourseWorkers(all => void (all['concourse-w1'] = rested), dir)
      const transcript = workers.concourseTranscriptPath(rested)
      mkdirSync(dirname(transcript), { recursive: true })
      writeFileSync(transcript, '')
      started.length = 0
      ended.length = 0
      spawnSync('/usr/bin/chflags', ['uchg', file])
      let resumed: Admitted
      try {
        resumed = await workers.makeConcourseAdmitHandler({ roster: () => roster as never, dir })({ workspaceDir: workspace, resumeSessionId: rested.sessionId })
      } catch (error) {
        resumed = { threw: error instanceof Error ? error.message : String(error) }
      }
      spawnSync('/usr/bin/chflags', ['nouchg', file])
      check(`${title}: the admission answers that no session was started, with the reason, and leaves no runner`, 'ok' in resumed && resumed.ok === false && resumed.code === 'not-ready' && (resumed.error ?? '').startsWith('no session was started: ') && (resumed.error ?? '').includes(file) && started.length === ended.length, { resumed, started, ended })
    }
  }

  console.log('the session records — the daemon boots while they cannot be read, says so at the boot, and its reconcile waits')
  if (!POSIX_MODES) skip('the unreadable file', 'a mode-0200 file needs a POSIX process that is not root')
  else {
    const sweep = await import('../../src/daemon/run/sweep.ts')
    const { makeDaemonRunState } = await import('../../src/daemon/run/state.ts')
    const { DaemonBreaker } = await import('../../src/daemon/control/daemonBreaker.ts')
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
