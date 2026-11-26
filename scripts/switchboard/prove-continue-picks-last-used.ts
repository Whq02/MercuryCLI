#!/usr/bin/env bun
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'continue-last-used-')))
const HOME = join(SCRATCH, 'home')
const DAEMON_DIR = join(HOME, 'daemon')
const P_CRASH = join(SCRATCH, 'proj-crash')
const P_NOCRA = join(SCRATCH, 'proj-nocrash')
const P_ADV = join(SCRATCH, 'proj-adv')
const P_HUNDRED = join(SCRATCH, 'proj-hundred')
const P_BURST = join(SCRATCH, 'proj-burst')
const P_SLACK = join(SCRATCH, 'proj-slack')
for (const d of [HOME, DAEMON_DIR, P_CRASH, P_NOCRA, P_ADV, P_HUNDRED, P_BURST, P_SLACK]) mkdirSync(d, { recursive: true })
for (const dir of [P_CRASH, P_NOCRA]) {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=proof@invalid', '-c', 'user.name=proof', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir })
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
}

process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_DAEMON_DIR = DAEMON_DIR
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'fixture-key-000'
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV
delete process.env.CI
delete process.env.MERCURY_CONCOURSE

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')
if (!existsSync(BIN)) {
  console.error(`dist/mercury.mjs missing — run bun run build.ts first`)
  process.exit(1)
}

let failures = 0
let checks = 0
const HINT = 'order by lastConversationActivityMs / compareSessionRecency in src/sessions/transcripts/sessionIndex.ts across sessionListings.ts, transcriptEntries.ts, listedSessions.ts, sessionPickerModel.ts, bootCardFacts.ts and concourseSnapshot.ts'
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — ${[detail, HINT].filter(Boolean).join('; ')}` : detail ? ` — ${detail}` : ''}`)
}

const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const { encodeSeedTranscript } = await import('../lib/seedTranscript.ts')
const { daemonControlRpc } = await import('../../src/daemon/control/controlSocket.ts')
const { setCwdState, setOriginalCwd, setProjectRoot } = await import('../../src/boot/process-state/processState.ts')
const paths = await import('../../src/sessions/transcripts/paths.ts')
const { lastConversationActivityMs, readSessionLastUsedMsCachedSync } = await import('../../src/sessions/transcripts/sessionIndex.ts')
const { lastSession, listProjectSessions, listRepoSessions, listSessions, sessionAtIndex, invalidateSessionListingMemo } = await import('../../src/sessions/transcripts/sessionListings.ts')
const { readListedSessions } = await import('../../src/sessions/transcripts/listedSessions.ts')
const { resumableNewestFirst, projectSessionPickerRows } = await import('../../src/screen/widgets/faces/sessionPickerModel.ts')
const { scanBootCardFacts, parkedSessionsOf, projectIdentity, PARKED_WEEK_MS } = await import('../../src/screen/boot-face/bootCardFacts.ts')
const { olderChatsCensus, buildConcourseSnapshot } = await import('../../src/screen/concourse-model/concourseSnapshot.ts')
const { nodeTranscriptReaderIo, setTranscriptReaderIoForTesting } = await import('../../src/sessions/transcripts/transcriptReader.ts')
const { flipToSession } = await import('../../src/engine/connector/sessionFlip.ts')
const { formatListingMetadata } = await import('../../src/platform/text/format.ts')
const { sessionsListCli } = await import('../../src/commands/verbs/sessionsVerb.ts')
const { groupListings } = await import('../../src/screen/session-chooser/SessionBrowser.tsx')
seedFirstRun(HOME, [P_CRASH, P_NOCRA, P_ADV, P_HUNDRED, P_BURST, P_SLACK])

const api = await startFixtureApi([
  { kind: 'text', text: 'ALPHA_REPLY', whenBody: 'alpha prompt' },
  { kind: 'text', text: 'BRAVO_REPLY', whenBody: 'bravo prompt' },
  { kind: 'text', text: 'CONTINUED_REPLY', whenBody: 'continue probe' },
  { kind: 'text', text: 'OLDER_REPLY', whenBody: 'older window prompt' },
  { kind: 'text', text: 'NEWER_REPLY', whenBody: 'newer window prompt' },
  { kind: 'text', text: 'SPARE_REPLY' },
])

const worldEnv: Record<string, string> = {
  MERCURY_CONFIG_DIR: HOME,
  MERCURY_DAEMON_DIR: DAEMON_DIR,
  MERCURY_CREDENTIAL_STORE: 'file',
  ANTHROPIC_API_KEY: 'fixture-key-000',
  ANTHROPIC_BASE_URL: api.url,
  MERCURY_WARM_RUNNER: '0',
  MERCURY_CACHE_CLOCK: '0',
  MERCURY_PARTY: '0',
  MERCURY_BOOT_PREFLIGHT: '0',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  BROWSER: '/usr/bin/true',
}

const logFd = openSync(join(SCRATCH, 'daemon.log'), 'a')
const daemon = spawn('node', [BIN, 'daemon', 'run', P_CRASH], {
  cwd: P_CRASH,
  env: { ...process.env, ...worldEnv },
  stdio: ['ignore', logFd, logFd],
})

type WorkerRec = { runnerId: string; sessionId: string; workspaceId: string; pid?: number; parkedAt?: number; endedAt?: number }
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const readWorkers = (): WorkerRec[] => {
  try {
    return Object.values((JSON.parse(readFileSync(join(DAEMON_DIR, 'concourse-workers.json'), 'utf8')) as { workers: Record<string, WorkerRec> }).workers)
  } catch {
    return []
  }
}
const isAlive = (pid: number | undefined): boolean => {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const until = async (pred: () => Promise<boolean> | boolean, ms: number, step = 120): Promise<boolean> => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      if (await pred()) return true
    } catch {
    }
    await sleep(step)
  }
  return false
}
const rpc = (body: Record<string, unknown>, timeoutMs = 15_000): Promise<Record<string, unknown>> =>
  daemonControlRpc(body as Parameters<typeof daemonControlRpc>[0], { timeoutMs }) as Promise<Record<string, unknown>>

function reap(): void {
  for (const w of readWorkers()) {
    if (w.pid !== undefined) {
      try {
        process.kill(w.pid, 'SIGKILL')
      } catch {
      }
    }
  }
  if (daemon.pid !== undefined) {
    try {
      process.kill(daemon.pid, 'SIGKILL')
    } catch {
    }
  }
}

const watchdog = setTimeout(() => {
  console.error('watchdog expired — failing loud')
  reap()
  process.exit(124)
}, 120_000)
watchdog.unref()

const setGround = (dir: string): void => {
  setOriginalCwd(dir)
  setCwdState(dir)
}

try {
  if (!(await until(async () => (await rpc({ op: 'ping' })).ok === true, 20_000))) {
    throw new Error('daemon never served')
  }

  console.log('\n§1 crash + park-all (deterministic mtime inversion): every door and listing picks B (last used)')
  {
    const aAdmit = await rpc({ op: 'sessionAdmit', workspaceDir: P_CRASH, isolation: 'shared', model: 'claude-sonnet-5', permissionMode: 'default' })
    const sidA = String(aAdmit.sessionId)
    const fileA = join(paths.getProjectDir(P_CRASH), `${sidA}.jsonl`)
    await rpc({ op: 'sessionDispatch', clientMessageId: 'msg-a', prompt: 'alpha prompt', workspaceDir: P_CRASH, targetSessionId: sidA, by: 'operator:111' })
    const aDone = await until(() => existsSync(fileA) && readFileSync(fileA, 'utf8').includes('turn-end'), 30_000)
    check('§1 session A answered and wrote turn-end', aDone, fileA)

    await sleep(1100)

    const bAdmit = await rpc({ op: 'sessionAdmit', workspaceDir: P_CRASH, isolation: 'shared', model: 'claude-sonnet-5', permissionMode: 'default' })
    const sidB = String(bAdmit.sessionId)
    const fileB = join(paths.getProjectDir(P_CRASH), `${sidB}.jsonl`)
    await rpc({ op: 'sessionDispatch', clientMessageId: 'msg-b', prompt: 'bravo prompt', workspaceDir: P_CRASH, targetSessionId: sidB, by: 'operator:222' })
    const bDone = await until(() => existsSync(fileB) && readFileSync(fileB, 'utf8').includes('turn-end'), 30_000)
    check('§1 session B answered later and wrote turn-end', bDone, fileB)

    await rpc({ op: 'sessionControl', action: 'park-all', sessionId: 'all', by: 'operator:222' })
    const bothDown = await until(() => {
      const ws = readWorkers().filter(w => w.workspaceId === P_CRASH && w.endedAt === undefined)
      return ws.length >= 2 && ws.every(w => w.parkedAt !== undefined && !isAlive(w.pid))
    }, 15_000)
    check('§1 park-all parked both A and B and both workers exited', bothDown)

    const bMtime = statSync(fileB).mtimeMs
    const later = new Date(bMtime + 5_000)
    utimesSync(fileA, later, later)
    check('§1 dead session A now has the strictly newer file mtime (+5s)', statSync(fileA).mtimeMs > statSync(fileB).mtimeMs)

    setGround(P_CRASH)
    const idx0 = await sessionAtIndex(0)
    check('§1 mercury -c door (sessionAtIndex(0)) picks B', idx0?.sessionId === sidB, `got ${idx0?.sessionId ?? 'null'} want ${sidB}`)

    const boot = scanBootCardFacts(P_CRASH)
    check('§1 Boot face Continue Last Session (scanBootCardFacts) picks B', boot.cwdProject?.sessionId === sidB, `got ${boot.cwdProject?.sessionId ?? 'null'} want ${sidB}`)
    check('§1 both continue doors agree on B', idx0?.sessionId === boot.cwdProject?.sessionId && idx0?.sessionId === sidB)

    const repoLogs = await listRepoSessions([P_CRASH])
    check('§1 /sessions (listRepoSessions) puts B first', repoLogs[0]?.sessionId === sidB, `got ${repoLogs[0]?.sessionId ?? 'null'}`)

    const cliListed = await readListedSessions(await listSessions(), 10)
    check('§1 mercury sessions / ACP session/list (readListedSessions) puts B first', cliListed[0]?.sessionId === sidB, `got ${cliListed[0]?.sessionId ?? 'null'}`)

    const pickerOrder = resumableNewestFirst(await listProjectSessions(), '')
    check('§1 session picker (resumableNewestFirst) puts B first', pickerOrder[0]?.sessionId === sidB, `got ${pickerOrder[0]?.sessionId ?? 'null'}`)

    const parked = parkedSessionsOf(P_CRASH)
    check('§1 Session Manager parkedSessionsOf puts B first', parked[0]?.sessionId === sidB, `got ${parked[0]?.sessionId ?? 'null'}`)

    const older = olderChatsCensus(P_CRASH, new Set(), Date.now(), { entryCap: 10 })
    check('§1 Session Manager olderChatsCensus puts B first', older.entries[0]?.sessionId === sidB, `got ${older.entries[0]?.sessionId ?? 'null'}`)

    const emptyDaemon = join(SCRATCH, 'empty-daemon')
    mkdirSync(emptyDaemon, { recursive: true })
    const snap = await buildConcourseSnapshot({
      recordsDir: emptyDaemon,
      crewDir: emptyDaemon,
      draftDir: emptyDaemon,
      nowMs: Date.now(),
      project: projectIdentity(P_CRASH),
    })
    const parkedRows = snap.groups.find(g => g.id === 'parked')?.rows ?? []
    check('§1 Session Manager board parked group puts B first', parkedRows[0]?.sessionId === sidB, `got ${parkedRows[0]?.sessionId ?? 'null'}`)

    const reqBefore = api.messageRequests().length
    const runResult = spawn('node', [BIN, 'run', '-c', 'continue probe', '--model', 'claude-sonnet-5', '--format', 'json'], {
      cwd: P_CRASH,
      env: { ...process.env, ...worldEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let runOut = ''
    runResult.stdout.on('data', d => { runOut += String(d) })
    const exitCode = await new Promise<number>(resolve => runResult.on('close', code => resolve(code ?? 1)))
    const continueReq = api.messageRequests().slice(reqBefore).find(r => r.raw.includes('continue probe'))
    const carriedBravo = continueReq?.raw.includes('bravo prompt') === true && continueReq?.raw.includes('alpha prompt') !== true
    check('§1 built product `mercury run -c` continues session B (carries bravo, not alpha)', exitCode === 0 && carriedBravo, `rc=${exitCode} carriedBravo=${carriedBravo} out=${runOut.slice(0, 120)}`)
  }

  console.log('\n§2 no crash (two live sessions; older window closed last): real exit restamp makes A newer on disk, doors pick B')
  {
    const aAdmit = await rpc({ op: 'sessionAdmit', workspaceDir: P_NOCRA, isolation: 'shared', model: 'claude-sonnet-5', permissionMode: 'default' })
    const sidA = String(aAdmit.sessionId)
    const fileA = join(paths.getProjectDir(P_NOCRA), `${sidA}.jsonl`)
    await rpc({ op: 'sessionDispatch', clientMessageId: 'nc-a', prompt: 'older window prompt', workspaceDir: P_NOCRA, targetSessionId: sidA, by: 'operator:333' })
    await until(() => existsSync(fileA) && readFileSync(fileA, 'utf8').includes('turn-end'), 30_000)

    await sleep(1100)

    const bAdmit = await rpc({ op: 'sessionAdmit', workspaceDir: P_NOCRA, isolation: 'shared', model: 'claude-sonnet-5', permissionMode: 'default' })
    const sidB = String(bAdmit.sessionId)
    const fileB = join(paths.getProjectDir(P_NOCRA), `${sidB}.jsonl`)
    await rpc({ op: 'sessionDispatch', clientMessageId: 'nc-b', prompt: 'newer window prompt', workspaceDir: P_NOCRA, targetSessionId: sidB, by: 'operator:444' })
    await until(() => existsSync(fileB) && readFileSync(fileB, 'utf8').includes('turn-end'), 30_000)

    await rpc({ op: 'sessionControl', action: 'park', sessionId: sidB, by: 'operator:444' })
    await until(() => {
      const w = readWorkers().find(r => r.sessionId === sidB && r.endedAt === undefined)
      return w !== undefined && w.parkedAt !== undefined && !isAlive(w.pid)
    }, 15_000)

    await sleep(1100)

    await rpc({ op: 'sessionControl', action: 'park', sessionId: sidA, by: 'operator:333' })
    await until(() => {
      const w = readWorkers().find(r => r.sessionId === sidA && r.endedAt === undefined)
      return w !== undefined && w.parkedAt !== undefined && !isAlive(w.pid)
    }, 15_000)

    check('§2 closing older window A last naturally gave A a newer file mtime than B', statSync(fileA).mtimeMs > statSync(fileB).mtimeMs)

    setGround(P_NOCRA)
    const idx0 = await sessionAtIndex(0)
    const boot = scanBootCardFacts(P_NOCRA)
    const parked = parkedSessionsOf(P_NOCRA)
    check('§2 mercury -c (sessionAtIndex(0)) picks B even when older window A closed last', idx0?.sessionId === sidB, `got ${idx0?.sessionId ?? 'null'}`)
    check('§2 Boot face Continue Last Session picks B even when older window A closed last', boot.cwdProject?.sessionId === sidB, `got ${boot.cwdProject?.sessionId ?? 'null'}`)
    check('§2 parkedSessionsOf puts B first even when older window A closed last', parked[0]?.sessionId === sidB, `got ${parked[0]?.sessionId ?? 'null'}`)
    const limitOne = await readListedSessions(await listSessions(), 1)
    check('§2 readListedSessions(lite, 1) picks B even when older A closed >1s after B', limitOne.length === 1 && limitOne[0]?.sessionId === sidB, `got ${limitOne[0]?.sessionId ?? 'null'}`)
  }

  console.log('\n§3 adversarial tail cases and bounded file reads on a large folder')
  {
    const base = Date.now() - 60_000
    const sid = (tail: string): string => `00000000-d490-4000-8000-${tail.padStart(12, '0')}`
    const dir = paths.getProjectDir(P_ADV)
    mkdirSync(dir, { recursive: true })
    const makeRow = (sessionId: string, atMs: number, extra: Record<string, unknown>): Record<string, unknown> => ({
      isSidechain: false,
      entrypoint: 'cli',
      cwd: P_ADV,
      sessionId,
      version: '1.1.0',
      gitBranch: 'main',
      parentUuid: null,
      uuid: `00000000-0000-4000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`,
      timestamp: new Date(atMs).toISOString(),
      ...extra,
    })

    const sidPr = sid('01')
    const fPr = join(dir, `${sidPr}.jsonl`)
    writeFileSync(
      fPr,
      encodeSeedTranscript(
        [
          makeRow(sidPr, base - 30_000, { type: 'user', message: { role: 'user', content: 'paste with "timestamp":"2099-01-01T00:00:00.000Z" inside' } }),
          makeRow(sidPr, base - 29_000, {
            type: 'assistant',
            message: { id: 'm1', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'reply 1' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
          }),
          makeRow(sidPr, base + 20_000, { type: 'user', isMeta: true, message: { role: 'user', content: 'meta injection later' } }),
          { type: 'pr-link', sessionId: sidPr, prNumber: 7, prUrl: 'https://example.invalid/pr/7', prRepository: 'o/r', timestamp: new Date(base + 30_000).toISOString() },
        ] as Parameters<typeof encodeSeedTranscript>[0],
        sidPr,
      ),
    )
    const prTime = new Date(base + 30_000)
    utimesSync(fPr, prTime, prTime)

    const sidReal = sid('02')
    const fReal = join(dir, `${sidReal}.jsonl`)
    writeFileSync(
      fReal,
      encodeSeedTranscript(
        [
          makeRow(sidReal, base - 5_000, { type: 'user', message: { role: 'user', content: 'actual latest prompt' } }),
          makeRow(sidReal, base - 4_000, {
            type: 'assistant',
            message: { id: 'm2', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'actual latest reply' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
          }),
        ] as Parameters<typeof encodeSeedTranscript>[0],
        sidReal,
      ),
    )
    const realTime = new Date(base - 4_000)
    utimesSync(fReal, realTime, realTime)

    const sidFallback = sid('03')
    const fFallback = join(dir, `${sidFallback}.jsonl`)
    appendFileSync(fFallback, encodeSeedTranscript([{ type: 'last-prompt', lastPrompt: 'metadata only newer', sessionId: sidFallback }] as Parameters<typeof encodeSeedTranscript>[0], sidFallback))
    const fallbackTime = new Date(base + 40_000)
    utimesSync(fFallback, fallbackTime, fallbackTime)

    const sidFallbackOlder = sid('04')
    const fFallbackOlder = join(dir, `${sidFallbackOlder}.jsonl`)
    appendFileSync(fFallbackOlder, encodeSeedTranscript([{ type: 'last-prompt', lastPrompt: 'metadata only older', sessionId: sidFallbackOlder }] as Parameters<typeof encodeSeedTranscript>[0], sidFallbackOlder))
    const fallbackOlderTime = new Date(base - 50_000)
    utimesSync(fFallbackOlder, fallbackOlderTime, fallbackOlderTime)

    const sidFuture = sid('05')
    const fFuture = join(dir, `${sidFuture}.jsonl`)
    const futureAt = Date.now() + 86_400_000
    writeFileSync(
      fFuture,
      encodeSeedTranscript(
        [
          makeRow(sidFuture, futureAt, { type: 'user', message: { role: 'user', content: 'wrong future clock prompt' } }),
          makeRow(sidFuture, futureAt + 1_000, {
            type: 'assistant',
            message: { id: 'm_fut', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'future reply' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
          }),
        ] as Parameters<typeof encodeSeedTranscript>[0],
        sidFuture,
      ),
    )
    const futureDate = new Date(futureAt + 1_000)
    utimesSync(fFuture, futureDate, futureDate)

    const sidBigTail = sid('06')
    const fBigTail = join(dir, `${sidBigTail}.jsonl`)
    writeFileSync(
      fBigTail,
      encodeSeedTranscript(
        [
          makeRow(sidBigTail, base - 2_000, { type: 'user', message: { role: 'user', content: 'latest prompt before huge tail' } }),
          makeRow(sidBigTail, base - 1_000, {
            type: 'assistant',
            message: { id: 'm_big', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'latest reply before huge tail' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
          }),
          makeRow(sidBigTail, base + 5_000, { type: 'attachment', attachment: { type: 'file', body: 'y'.repeat(70_000) } }),
        ] as Parameters<typeof encodeSeedTranscript>[0],
        sidBigTail,
      ),
    )
    const bigTailDate = new Date(base + 5_000)
    utimesSync(fBigTail, bigTailDate, bigTailDate)

    setGround(P_ADV)
    const advIdx0 = await sessionAtIndex(0)
    const advBoot = scanBootCardFacts(P_ADV)
    check('§3 future-clock, metadata-only, and restamped pr-link never beat latest real turn (-c; >64 KiB tail still finds real turn)', advIdx0?.sessionId === sidBigTail, `got ${advIdx0?.sessionId ?? 'null'}`)
    check('§3 Boot face agrees on future-clock, metadata-only, and >64 KiB tail', advBoot.cwdProject?.sessionId === sidBigTail, `got ${advBoot.cwdProject?.sessionId ?? 'null'}`)
    const advAll = await listProjectSessions()
    check('§3 real turns strictly outrank metadata-only/future sessions; null-activity sessions fall back to mtime', advAll.map(l => l.sessionId).join(',') === [sidBigTail, sidReal, sidPr, sidFuture, sidFallback, sidFallbackOlder].join(','), advAll.map(l => l.sessionId?.slice(-2)).join(','))
    const hundredDir = paths.getProjectDir(P_HUNDRED)
    mkdirSync(hundredDir, { recursive: true })
    const bigPayload = 'x'.repeat(68_000)
    for (let i = 0; i < 40; i++) {
      const s = sid(String(100 + i))
      const f = join(hundredDir, `${s}.jsonl`)
      const at = base - (40 - i) * 10_000
      writeFileSync(
        f,
        encodeSeedTranscript(
          [
            makeRow(s, at - 200, { cwd: P_HUNDRED, type: 'user', message: { role: 'user', content: `session ${i} prompt` } }),
            makeRow(s, at - 100, { cwd: P_HUNDRED, type: 'attachment', attachment: { type: 'file', body: bigPayload } }),
            makeRow(s, at, {
              cwd: P_HUNDRED,
              type: 'assistant',
              message: { id: `mh_${i}`, type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: `reply ${i}` }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
            }),
          ] as Parameters<typeof encodeSeedTranscript>[0],
          s,
        ),
      )
      const d = new Date(at)
      utimesSync(f, d, d)
    }
    check('§3 lastConversationActivityMs parses occurredAt from real records and returns null for metadata-only tails', lastConversationActivityMs(readFileSync(fPr, 'utf8')) === base - 29_000 && lastConversationActivityMs(readFileSync(fFallback, 'utf8')) === null)

    const futSt = statSync(fFuture)
    const futBefore = readSessionLastUsedMsCachedSync(fFuture, futSt.mtimeMs, futSt.size, undefined, Date.now())
    const futAfter = readSessionLastUsedMsCachedSync(fFuture, futSt.mtimeMs, futSt.size, undefined, futureAt + 2_000)
    check('§3 future-clock null in lastUsedCache recovers once nowMs passes occurredAt (never pinned forever)', futBefore === null && futAfter === futureAt + 1_000, `before=${String(futBefore)} after=${String(futAfter)}`)

    const fGrace = join(SCRATCH, 'grace-clamped.jsonl')
    const graceNow = Date.now()
    const graceAt = graceNow + 3_000
    writeFileSync(
      fGrace,
      encodeSeedTranscript(
        [
          makeRow(sid('98'), graceAt, { type: 'user', message: { role: 'user', content: 'within 5s grace' } }),
        ] as Parameters<typeof encodeSeedTranscript>[0],
        sid('98'),
      ),
    )
    const graceSt = statSync(fGrace)
    const graceClamped = readSessionLastUsedMsCachedSync(fGrace, graceSt.mtimeMs, graceSt.size, undefined, graceNow)
    const graceMid = readSessionLastUsedMsCachedSync(fGrace, graceSt.mtimeMs, graceSt.size, undefined, graceNow + 2_000)
    const graceExact = readSessionLastUsedMsCachedSync(fGrace, graceSt.mtimeMs, graceSt.size, undefined, graceNow + 4_000)
    check('§3 time clamped inside 5s grace advances with nowMs on cache hits and returns exact occurredAt after grace', graceClamped === graceNow && graceMid === graceNow + 2_000 && graceExact === graceAt, `clamped=${String(graceClamped)} mid=${String(graceMid)} exact=${String(graceExact)} want=${graceAt}`)

    const pOlderGrace = join(SCRATCH, 'proj-older-grace')
    mkdirSync(pOlderGrace, { recursive: true })
    const olderGraceDir = paths.getProjectDir(pOlderGrace)
    mkdirSync(olderGraceDir, { recursive: true })
    const sidFast = sid('96')
    const sidNorm = sid('97')
    const fFast = join(olderGraceDir, `${sidFast}.jsonl`)
    const fNorm = join(olderGraceDir, `${sidNorm}.jsonl`)
    const ogBase = Date.now()
    writeFileSync(
      fFast,
      encodeSeedTranscript(
        [
          makeRow(sidFast, ogBase - 400_000, { cwd: pOlderGrace, type: 'user', message: { role: 'user', content: 'fast old prompt' } }),
          makeRow(sidFast, ogBase + 60_000, {
            cwd: pOlderGrace,
            type: 'assistant',
            message: { id: 'm_fg', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'fast reply' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
          }),
        ] as Parameters<typeof encodeSeedTranscript>[0],
        sidFast,
      ),
    )
    utimesSync(fFast, new Date(ogBase + 60_000), new Date(ogBase + 60_000))
    writeFileSync(
      fNorm,
      encodeSeedTranscript(
        [
          makeRow(sidNorm, ogBase - 300_000, { cwd: pOlderGrace, type: 'user', message: { role: 'user', content: 'normal prompt' } }),
          makeRow(sidNorm, ogBase - 15_000, {
            cwd: pOlderGrace,
            type: 'assistant',
            message: { id: 'm_ng', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'normal reply' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
          }),
        ] as Parameters<typeof encodeSeedTranscript>[0],
        sidNorm,
      ),
    )
    utimesSync(fNorm, new Date(ogBase - 12_000), new Date(ogBase - 12_000))
    const olderBefore = olderChatsCensus(pOlderGrace, new Set(), ogBase, { entryCap: 2 }).entries
    const olderAfter = olderChatsCensus(pOlderGrace, new Set(), ogBase + 60_500, { entryCap: 2 }).entries
    check('§3 olderChatsCensus shares clock-aware expiry and recovers once future clock catches up without file writes', olderBefore[0]?.sessionId === sidNorm && olderAfter[0]?.sessionId === sidFast && olderAfter[0]?.ageMs === 500, `before=${olderBefore[0]?.sessionId?.slice(-2)} after=${olderAfter[0]?.sessionId?.slice(-2)} age=${olderAfter[0]?.ageMs}`)

    const fSingle7M = join(SCRATCH, 'single-7m.jsonl')
    writeFileSync(
      fSingle7M,
      encodeSeedTranscript(
        [
          makeRow(sid('94'), base - 90_000, { type: 'user', message: { role: 'user', content: 'early before 7m row' } }),
          makeRow(sid('94'), base - 4_000, { type: 'attachment', attachment: { type: 'file', body: 'x'.repeat(7 * 1024 * 1024) } }),
        ] as Parameters<typeof encodeSeedTranscript>[0],
        sid('94'),
      ),
    )
    const fMultiByte = join(SCRATCH, 'multibyte-7m.jsonl')
    const mbHead = encodeSeedTranscript(
      [makeRow(sid('95'), base - 90_000, { type: 'user', message: { role: 'user', content: 'early before multibyte' } })] as Parameters<typeof encodeSeedTranscript>[0],
      sid('95'),
    )
    const mbLine = encodeSeedTranscript(
      [makeRow(sid('95'), base - 4_000, { type: 'attachment', attachment: { type: 'file', body: '記'.repeat(64_000) } })] as Parameters<typeof encodeSeedTranscript>[0],
      sid('95'),
    ).split('\n').filter(Boolean).pop()! + '\n'
    writeFileSync(fMultiByte, mbHead + mbLine.repeat(40))
    const st7m = statSync(fSingle7M)
    const stMb = statSync(fMultiByte)
    let bytes7m = 0
    let bytesMb = 0
    setTranscriptReaderIoForTesting({
      ...nodeTranscriptReaderIo,
      readRangeSync(path, start, end) {
        const buf = nodeTranscriptReaderIo.readRangeSync(path, start, end)
        if (path === fSingle7M) bytes7m += buf.length
        if (path === fMultiByte) bytesMb += buf.length
        return buf
      },
    })
    try {
      const r7m = readSessionLastUsedMsCachedSync(fSingle7M, st7m.mtimeMs, st7m.size)
      const rMb = readSessionLastUsedMsCachedSync(fMultiByte, stMb.mtimeMs, stMb.size)
      check('§3 actual-byte 2 MiB budget bounds single 7 MiB row and 3-byte UTF-8 multibyte rows (<= 2.5 MiB each)', r7m === null && rMb === null && bytes7m <= 2_600_000 && bytesMb <= 2_600_000, `single=${bytes7m}/${st7m.size} multibyte=${bytesMb}/${stMb.size}`)
    } finally {
      setTranscriptReaderIoForTesting(nodeTranscriptReaderIo)
    }

    const fHuge = join(SCRATCH, 'huge-no-tail-turn.jsonl')
    const hugeHeader = encodeSeedTranscript(
      [
        makeRow(sid('99'), base - 10_000, { type: 'user', message: { role: 'user', content: 'early turn' } }),
      ] as Parameters<typeof encodeSeedTranscript>[0],
      sid('99'),
    )
    const bigAttachmentLine = encodeSeedTranscript(
      [
        makeRow(sid('99'), base - 5_000, { type: 'attachment', attachment: { type: 'file', body: 'z'.repeat(120_000) } }),
      ] as Parameters<typeof encodeSeedTranscript>[0],
      sid('99'),
    ).split('\n').filter(Boolean).pop()! + '\n'
    writeFileSync(fHuge, hugeHeader + bigAttachmentLine.repeat(30))
    const hugeSt = statSync(fHuge)
    let hugeBytes1 = 0
    let hugeBytes2 = 0
    let activePass = 1
    setTranscriptReaderIoForTesting({
      ...nodeTranscriptReaderIo,
      readRangeSync(path, start, end) {
        const buf = nodeTranscriptReaderIo.readRangeSync(path, start, end)
        if (path === fHuge) {
          if (activePass === 1) hugeBytes1 += buf.length
          else hugeBytes2 += buf.length
        }
        return buf
      },
    })
    try {
      const res1 = readSessionLastUsedMsCachedSync(fHuge, hugeSt.mtimeMs, hugeSt.size)
      activePass = 2
      const res2 = readSessionLastUsedMsCachedSync(fHuge, hugeSt.mtimeMs, hugeSt.size)
      check('§3 backward scan caps bytes read (<= 2.5 MiB on a 3.6 MiB file), falls back to null, and caches by (path, mtime, size) so repeat reads cost 0 bytes', res1 === null && res2 === null && hugeBytes1 <= 2_600_000 && hugeBytes2 === 0, `fileBytes=${hugeSt.size} pass1Bytes=${hugeBytes1} pass2Bytes=${hugeBytes2} res1=${String(res1)}`)
    } finally {
      setTranscriptReaderIoForTesting(nodeTranscriptReaderIo)
    }
    const readFiles = new Set<string>()
    let readCount = 0
    setTranscriptReaderIoForTesting({
      ...nodeTranscriptReaderIo,
      readRangeSync(path, start, end) {
        if (path.startsWith(hundredDir)) {
          readFiles.add(path)
          readCount++
        }
        return nodeTranscriptReaderIo.readRangeSync(path, start, end)
      },
    })
    try {
      const hundredBoot = scanBootCardFacts(P_HUNDRED)
      const coldBootReads = readCount
      readCount = 0
      const warmBoot = scanBootCardFacts(P_HUNDRED)
      const warmBootReads = readCount
      check('§3 40-session >64 KiB folder: cold scanBootCardFacts reads 1 file (early stop), warm reads 0 (lastUsedCache)', hundredBoot.cwdProject?.sessionId === sid('139') && warmBoot.cwdProject?.sessionId === sid('139') && coldBootReads === 1 && warmBootReads === 0, `coldReads=${coldBootReads} warmReads=${warmBootReads} files=${readFiles.size}`)

      readCount = 0
      parkedSessionsOf(P_HUNDRED)
      const coldParkedReads = readCount
      readCount = 0
      parkedSessionsOf(P_HUNDRED)
      const warmParkedReads = readCount
      check('§3 >64 KiB parkedSessionsOf: cold reads remaining 9 of top 10 (never all 40), warm reads 0 (lastUsedCache)', coldParkedReads === 9 && warmParkedReads === 0, `coldReads=${coldParkedReads} warmReads=${warmParkedReads}`)

      olderChatsCensus(P_HUNDRED, new Set(), Date.now(), { entryCap: 0 })
      readCount = 0
      const warmOlder = olderChatsCensus(P_HUNDRED, new Set(), Date.now(), { entryCap: 10 })
      check('§3 warm olderChatsCensus browse (entryCap=10 after board paint entryCap=0) does 0 tail reads', warmOlder.entries.length === 10 && readCount === 0, `warmReads=${readCount}`)
    } finally {
      setTranscriptReaderIoForTesting(nodeTranscriptReaderIo)
    }

    const slackDir = paths.getProjectDir(P_SLACK)
    mkdirSync(slackDir, { recursive: true })
    const slackT = Date.now() - 10_000
    const sidSlackA = sid('401')
    const fSlackA = join(slackDir, `${sidSlackA}.jsonl`)
    writeFileSync(
      fSlackA,
      encodeSeedTranscript(
        [
          makeRow(sidSlackA, slackT - 1_500, { cwd: P_SLACK, type: 'user', message: { role: 'user', content: 'slack older A' } }),
        ] as Parameters<typeof encodeSeedTranscript>[0],
        sidSlackA,
      ),
    )
    utimesSync(fSlackA, new Date(slackT - 1_500), new Date(slackT - 1_500))

    for (let i = 1; i <= 33; i++) {
      const junkId = sid(String(500 + i))
      const fJunk = join(slackDir, `${junkId}.jsonl`)
      writeFileSync(
        fJunk,
        encodeSeedTranscript(
          [
            makeRow(junkId, slackT - 2_500, { cwd: P_SLACK, type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } }),
            makeRow(junkId, slackT - 2_490, {
              cwd: P_SLACK,
              error: 'authentication_failed',
              isApiErrorMessage: true,
              type: 'assistant',
              message: { id: `mhusk_${i}`, type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'auth failed' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
            }),
          ] as Parameters<typeof encodeSeedTranscript>[0],
          junkId,
        ),
      )
      utimesSync(fJunk, new Date(slackT - 2_500), new Date(slackT - 2_500))
    }

    const sidSlackB = sid('402')
    const fSlackB = join(slackDir, `${sidSlackB}.jsonl`)
    writeFileSync(
      fSlackB,
      encodeSeedTranscript(
        [
          makeRow(sidSlackB, slackT - 1_000, { cwd: P_SLACK, type: 'user', message: { role: 'user', content: 'slack newer B with 2s FAT mtime lag' } }),
        ] as Parameters<typeof encodeSeedTranscript>[0],
        sidSlackB,
      ),
    )
    utimesSync(fSlackB, new Date(slackT - 3_000), new Date(slackT - 3_000))

    setGround(P_SLACK)
    const slackBoot = scanBootCardFacts(P_SLACK)
    const slackListedOne = await readListedSessions(await listSessions(), 1)
    check('§3 2s FAT/exFAT mtime lag + 33 filtered husks between A and B: Boot face early-stop slack (>= 5s) counts only kept rows and finds B', slackBoot.cwdProject?.sessionId === sidSlackB, `got ${slackBoot.cwdProject?.sessionId?.slice(-3) ?? 'null'}`)
    check('§3 2s mtime lag + 33 filtered command-only rows between A and B: readListedSessions(lite, 1) counts only kept rows and finds B', slackListedOne[0]?.sessionId === sidSlackB, `got ${slackListedOne[0]?.sessionId?.slice(-3) ?? 'null'}`)

    const burstDir = paths.getProjectDir(P_BURST)
    mkdirSync(burstDir, { recursive: true })
    const burstNow = Date.now() - 2_000
    for (let i = 1; i <= 5; i++) {
      const deadId = sid(`20${i}`)
      const f = join(burstDir, `${deadId}.jsonl`)
      writeFileSync(
        f,
        encodeSeedTranscript(
          [
            makeRow(deadId, burstNow - 600_000 - i * 1_000, { cwd: P_BURST, type: 'user', message: { role: 'user', content: `dead burst ${i}` } }),
            makeRow(deadId, burstNow - 599_000 - i * 1_000, {
              cwd: P_BURST,
              type: 'assistant',
              message: { id: `mb_${i}`, type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: `dead reply ${i}` }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
            }),
          ] as Parameters<typeof encodeSeedTranscript>[0],
          deadId,
        ),
      )
      const restamp = new Date(burstNow + i * 20)
      utimesSync(f, restamp, restamp)
    }
    const sidBurstReal = sid('206')
    const fBurstReal = join(burstDir, `${sidBurstReal}.jsonl`)
    writeFileSync(
      fBurstReal,
      encodeSeedTranscript(
        [
          makeRow(sidBurstReal, burstNow - 5_000, { cwd: P_BURST, type: 'user', message: { role: 'user', content: 'real 6th-mtime session' } }),
          makeRow(sidBurstReal, burstNow - 4_000, {
            cwd: P_BURST,
            type: 'assistant',
            message: { id: 'mb_real', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'real reply 6' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
          }),
        ] as Parameters<typeof encodeSeedTranscript>[0],
        sidBurstReal,
      ),
    )
    const realRestamp = new Date(burstNow)
    utimesSync(fBurstReal, realRestamp, realRestamp)

    setGround(P_BURST)
    const burstIdx0 = await sessionAtIndex(0)
    const burstBoot = scanBootCardFacts(P_BURST)
    check('§3 6-session restamp burst (real session stands 6th by mtime): Boot face Continue Last Session picks real session and agrees with -c', burstIdx0?.sessionId === sidBurstReal && burstBoot.cwdProject?.sessionId === sidBurstReal, `cli=${burstIdx0?.sessionId?.slice(-3) ?? 'null'} boot=${burstBoot.cwdProject?.sessionId?.slice(-3) ?? 'null'}`)

    console.log('\n§4 remaining surfaces (sessionFlip) and consistent age/timestamp labels')
    setProjectRoot(P_BURST)
    invalidateSessionListingMemo()
    let flippedId = ''
    await flipToSession(async id => { flippedId = id })
    check('§4 sessionFlip (flipToSession) picks real last-used session, not a restamped dead burst session', flippedId === sidBurstReal, `got ${flippedId.slice(-3) || 'none'}`)

    const burstLogs = await listProjectSessions()
    const grouped = groupListings(burstLogs, true)
    check('§4 SessionBrowser groupListings (/sessions & --resume) keeps real last-used session first', grouped[0]?.listing.sessionId === sidBurstReal, `got ${grouped[0]?.listing.sessionId?.slice(-3) ?? 'null'}`)

    const pickerRows = projectSessionPickerRows(burstLogs, {
      scope: 'project',
      projectDir: P_BURST,
      boardHomed: new Set(),
      isCleared: () => false,
      nowMs: burstNow + 10_000,
    }).flat
    const seen0 = pickerRows[0]?.row.seen ?? ''
    const seen1 = pickerRows[1]?.row.seen ?? ''
    check('§4 session picker seen label matches last-used order (row 0 seconds, row 1 ~10m ago — never inverted)', /seconds? ago$|s ago$/.test(seen0) && /minutes? ago$|m ago$/.test(seen1), `row0=${seen0} row1=${seen1}`)

    const deadLog = burstLogs.find(l => l.sessionId === sid('201'))!
    const deadMeta = formatListingMetadata(deadLog)
    check('§4 /sessions formatListingMetadata labels restamped dead session by last use (~10m ago), not file mtime', /\b(?:9|10|11)\s*(?:minutes?|m) ago\b/.test(deadMeta), deadMeta)

    const cliLines: string[] = []
    await sessionsListCli({ limit: 6 }, { out: (l: string) => cliLines.push(l), err: (l: string) => cliLines.push(l), interactive: false, ask: async () => false })
    check('§4 mercury sessions CLI header names last used instead of modified', cliLines[0]?.includes('(id · last used · size · title):') === true, cliLines[0] ?? '')
    const rowStamps = cliLines
      .filter(l => /^00000000-d490/.test(l))
      .map(l => Date.parse(l.split(/\s+/)[1] ?? ''))
    check('§4 mercury sessions CLI prints ISO timestamps in descending order matching its sort order', rowStamps.length >= 2 && rowStamps[0]! > rowStamps[1]!, rowStamps.map(t => new Date(t).toISOString()).slice(0, 2).join(' vs '))

    const burstParked = parkedSessionsOf(P_BURST)
    check('§4 Session Manager parkedSessionsOf ageMs reflects last use (real <1m, restamped dead ~10m)', burstParked.length >= 2 && burstParked[0]!.ageMs < burstParked[1]!.ageMs && burstParked[1]!.ageMs >= 500_000, `row0=${Math.round(burstParked[0]?.ageMs ?? -1)} row1=${Math.round(burstParked[1]?.ageMs ?? -1)}`)

    const burstOlder = olderChatsCensus(P_BURST, new Set(), Date.now(), { entryCap: 6 })
    check('§4 Session Manager olderChatsCensus ageMs reflects last use (real <1m, restamped dead ~10m)', burstOlder.entries.length >= 2 && burstOlder.entries[0]!.ageMs < burstOlder.entries[1]!.ageMs && burstOlder.entries[1]!.ageMs >= 500_000, `row0=${Math.round(burstOlder.entries[0]?.ageMs ?? -1)} row1=${Math.round(burstOlder.entries[1]?.ageMs ?? -1)}`)

    const sidAncientRestamped = sid('209')
    const fAncient = join(burstDir, `${sidAncientRestamped}.jsonl`)
    const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60_000
    writeFileSync(
      fAncient,
      encodeSeedTranscript(
        [
          makeRow(sidAncientRestamped, tenDaysAgo, { cwd: P_BURST, type: 'user', message: { role: 'user', content: 'ancient prompt restamped today' } }),
          makeRow(sidAncientRestamped, tenDaysAgo + 1_000, {
            cwd: P_BURST,
            type: 'assistant',
            message: { id: 'm_anc', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'ancient reply' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
          }),
        ] as Parameters<typeof encodeSeedTranscript>[0],
        sidAncientRestamped,
      ),
    )
    const todayRestamp = new Date(Date.now() - 500)
    utimesSync(fAncient, todayRestamp, todayRestamp)
    const weekParked = parkedSessionsOf(P_BURST, { withinMs: PARKED_WEEK_MS })
    check('§4 Session Manager 7-day parkedSessionsOf filter excludes a 10-day-old session restamped today', !weekParked.some(s => s.sessionId === sidAncientRestamped) && weekParked[0]?.sessionId === sidBurstReal, weekParked.map(s => s.sessionId.slice(-3)).join(','))

    const deadOnlyDir = join(SCRATCH, 'proj-dead-only')
    mkdirSync(deadOnlyDir, { recursive: true })
    const deadOnlyStore = paths.getProjectDir(deadOnlyDir)
    mkdirSync(deadOnlyStore, { recursive: true })
    const sidDeadOnly = sid('301')
    const fDeadOnly = join(deadOnlyStore, `${sidDeadOnly}.jsonl`)
    writeFileSync(
      fDeadOnly,
      encodeSeedTranscript(
        [
          makeRow(sidDeadOnly, burstNow - 600_000, { cwd: deadOnlyDir, type: 'user', message: { role: 'user', content: 'old project prompt' } }),
          makeRow(sidDeadOnly, burstNow - 599_000, {
            cwd: deadOnlyDir,
            type: 'assistant',
            message: { id: 'm_do', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'old reply' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
          }),
        ] as Parameters<typeof encodeSeedTranscript>[0],
        sidDeadOnly,
      ),
    )
    const laterRestamp = new Date(burstNow + 500)
    utimesSync(fDeadOnly, laterRestamp, laterRestamp)
    const idBurst = projectIdentity(P_BURST)
    const idOld = projectIdentity(deadOnlyDir)
    check('§4 Boot face projectIdentity ageMs reflects last use (newer project has smaller ageMs than older restamped project)', (idBurst.newestChat?.ageMs ?? Infinity) < (idOld.newestChat?.ageMs ?? 0), `burst=${idBurst.newestChat?.ageMs} old=${idOld.newestChat?.ageMs}`)

    const pHusk = join(SCRATCH, 'proj-husk-align')
    mkdirSync(pHusk, { recursive: true })
    const huskDir = paths.getProjectDir(pHusk)
    mkdirSync(huskDir, { recursive: true })
    const sidAnswered = sid('701')
    const sidHusk = sid('702')
    const fAns = join(huskDir, `${sidAnswered}.jsonl`)
    const fHsk = join(huskDir, `${sidHusk}.jsonl`)
    const hT = Date.now()
    writeFileSync(
      fAns,
      encodeSeedTranscript(
        [
          makeRow(sidAnswered, hT - 90_000, { cwd: pHusk, type: 'user', message: { role: 'user', content: 'answered prompt' } }),
          makeRow(sidAnswered, hT - 85_000, {
            cwd: pHusk,
            type: 'assistant',
            message: { id: 'm_ans', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'real answer' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
          }),
        ] as Parameters<typeof encodeSeedTranscript>[0],
        sidAnswered,
      ),
    )
    utimesSync(fAns, new Date(hT - 84_000), new Date(hT - 84_000))
    writeFileSync(
      fHsk,
      encodeSeedTranscript(
        [
          makeRow(sidHusk, hT - 5_000, { cwd: pHusk, type: 'user', message: { role: 'user', content: 'failed sign in prompt' } }),
          makeRow(sidHusk, hT - 3_000, {
            cwd: pHusk,
            isApiErrorMessage: true,
            error: 'authentication_failed',
            type: 'assistant',
            message: { id: 'm_hsk', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'Please sign in' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
          }),
        ] as Parameters<typeof encodeSeedTranscript>[0],
        sidHusk,
      ),
    )
    utimesSync(fHsk, new Date(hT - 2_000), new Date(hT - 2_000))
    setGround(pHusk)
    const huskCli0 = await sessionAtIndex(0)
    const huskBoot = scanBootCardFacts(pHusk)
    const huskRepo = await listRepoSessions([pHusk])
    const huskExplicit = await lastSession(sidHusk as Parameters<typeof lastSession>[0])
    check('§4 auth-failure husk ranks below answered session across all implicit doors while explicit resume keeps husk', huskCli0?.sessionId === sidAnswered && huskBoot.cwdProject?.sessionId === sidAnswered && huskRepo[0]?.sessionId === sidAnswered && huskExplicit?.sessionId === sidHusk, `cli=${huskCli0?.sessionId?.slice(-3)} boot=${huskBoot.cwdProject?.sessionId?.slice(-3)} explicit=${huskExplicit?.sessionId?.slice(-3)}`)

    const pBulk = join(SCRATCH, 'proj-bulk-51')
    mkdirSync(pBulk, { recursive: true })
    const bulkDir = paths.getProjectDir(pBulk)
    mkdirSync(bulkDir, { recursive: true })
    const bT = Date.now()
    const sidBulkWin = sid('800')
    const fBulkWin = join(bulkDir, `${sidBulkWin}.jsonl`)
    writeFileSync(
      fBulkWin,
      encodeSeedTranscript(
        [
          makeRow(sidBulkWin, bT - 21_000, { cwd: pBulk, type: 'user', message: { role: 'user', content: 'bulk winner prompt' } }),
          makeRow(sidBulkWin, bT - 20_000, {
            cwd: pBulk,
            type: 'assistant',
            message: { id: 'm_bw', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'bulk winner reply' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
          }),
        ] as Parameters<typeof encodeSeedTranscript>[0],
        sidBulkWin,
      ),
    )
    utimesSync(fBulkWin, new Date(bT - 19_000), new Date(bT - 19_000))
    for (let i = 0; i < 51; i++) {
      const idleId = sid(String(801 + i))
      const fIdle = join(bulkDir, `${idleId}.jsonl`)
      writeFileSync(
        fIdle,
        encodeSeedTranscript(
          [
            makeRow(idleId, bT - 240_000 - i * 1_000, { cwd: pBulk, type: 'user', message: { role: 'user', content: `bulk idle ${i}` } }),
            makeRow(idleId, bT - 200_000 - i * 1_000, {
              cwd: pBulk,
              type: 'assistant',
              message: { id: `m_bi_${i}`, type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: `idle reply ${i}` }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
            }),
          ] as Parameters<typeof encodeSeedTranscript>[0],
          idleId,
        ),
      )
      utimesSync(fIdle, new Date(bT - 8_000 + i), new Date(bT - 8_000 + i))
    }
    setGround(pBulk)
    const bulkBoot = scanBootCardFacts(pBulk)
    const bulkParked = parkedSessionsOf(pBulk, { withinMs: PARKED_WEEK_MS, cap: 10 })
    const bulkRepo = await listRepoSessions([pBulk])
    const bulkCli1 = await readListedSessions(await listSessions(), 1)
    check('§4 51 restamped old chats ahead of winner (52nd by mtime): Boot, parked, /sessions page 1, and CLI --limit 1 all find winner', bulkBoot.cwdProject?.sessionId === sidBulkWin && bulkParked[0]?.sessionId === sidBulkWin && bulkRepo[0]?.sessionId === sidBulkWin && bulkCli1[0]?.sessionId === sidBulkWin, `boot=${bulkBoot.cwdProject?.sessionId?.slice(-3)} parked=${bulkParked[0]?.sessionId?.slice(-3)} repo=${bulkRepo[0]?.sessionId?.slice(-3)} cli1=${bulkCli1[0]?.sessionId?.slice(-3)}`)
  }
} finally {
  clearTimeout(watchdog)
  reap()
  try {
    await api.close()
  } catch {
  }
  removeScratch(SCRATCH)
}

console.log(failures === 0 ? `\nprove-continue-picks-last-used: ALL ${checks} CHECKS HOLD` : `\nprove-continue-picks-last-used: ${failures} FAILURE(S) of ${checks}`)
process.exit(failures === 0 ? 0 : 1)
