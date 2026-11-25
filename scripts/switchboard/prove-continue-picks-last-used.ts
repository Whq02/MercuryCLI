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
for (const d of [HOME, DAEMON_DIR, P_CRASH, P_NOCRA, P_ADV, P_HUNDRED]) mkdirSync(d, { recursive: true })
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
const { setCwdState, setOriginalCwd } = await import('../../src/boot/process-state/processState.ts')
const paths = await import('../../src/sessions/transcripts/paths.ts')
const { lastConversationActivityMs } = await import('../../src/sessions/transcripts/sessionIndex.ts')
const { listProjectSessions, listRepoSessions, listSessions, sessionAtIndex } = await import('../../src/sessions/transcripts/sessionListings.ts')
const { readListedSessions } = await import('../../src/sessions/transcripts/listedSessions.ts')
const { resumableNewestFirst } = await import('../../src/screen/widgets/faces/sessionPickerModel.ts')
const { scanBootCardFacts, parkedSessionsOf, projectIdentity } = await import('../../src/screen/boot-face/bootCardFacts.ts')
const { olderChatsCensus, buildConcourseSnapshot } = await import('../../src/screen/concourse-model/concourseSnapshot.ts')
const { nodeTranscriptReaderIo, setTranscriptReaderIoForTesting } = await import('../../src/sessions/transcripts/transcriptReader.ts')
seedFirstRun(HOME, [P_CRASH, P_NOCRA, P_ADV, P_HUNDRED])

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
    const payloadBytes = 200
    for (let i = 0; i < 40; i++) {
      const s = sid(String(100 + i))
      const f = join(hundredDir, `${s}.jsonl`)
      const at = base - (40 - i) * 1000
      writeFileSync(
        f,
        encodeSeedTranscript(
          [
            makeRow(s, at, { cwd: P_HUNDRED, type: 'user', message: { role: 'user', content: `session ${i} ${'x'.repeat(payloadBytes)}` } }),
          ] as Parameters<typeof encodeSeedTranscript>[0],
          s,
        ),
      )
      const d = new Date(at)
      utimesSync(f, d, d)
    }
    check('§3 lastConversationActivityMs parses occurredAt from real records and returns null for metadata-only tails', lastConversationActivityMs(readFileSync(fPr, 'utf8')) === base - 29_000 && lastConversationActivityMs(readFileSync(fFallback, 'utf8')) === null)
    const readFiles = new Set<string>()
    setTranscriptReaderIoForTesting({
      ...nodeTranscriptReaderIo,
      readRangeSync(path, start, end) {
        if (path.startsWith(hundredDir)) readFiles.add(path)
        return nodeTranscriptReaderIo.readRangeSync(path, start, end)
      },
    })
    try {
      const hundredBoot = scanBootCardFacts(P_HUNDRED)
      check('§3 40-session folder: scanBootCardFacts reads at most 4 files in that folder, never all 40', hundredBoot.cwdProject?.sessionId === sid('139') && readFiles.size <= 4, `filesRead=${readFiles.size}`)
    } finally {
      setTranscriptReaderIoForTesting(nodeTranscriptReaderIo)
    }
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
