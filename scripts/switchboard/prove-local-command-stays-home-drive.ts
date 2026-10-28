#!/usr/bin/env bun
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { startDaemonClientBeat } from '../lib/daemonClientBeat.ts'
import { ALL_MODEL_CONFIGS, newestGenerationKey } from '../../src/utils/model/configs.ts'

const DEFAULT_OPUS = ALL_MODEL_CONFIGS[newestGenerationKey('opus')].firstParty
const REPO = join(new URL('.', import.meta.url).pathname, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')
const VSHOT = join(REPO, 'scripts', 'ui', 'vshot.py')
if (!existsSync(BIN)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'stays-home-drive-')))
const home = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const ground = join(SCRATCH, 'ground')
const sandbox = join(SCRATCH, 'sandbox')
for (const d of [home, daemonDir, ground, sandbox]) mkdirSync(d, { recursive: true })
for (const d of [ground, sandbox]) {
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: d })
  spawnSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@x', 'commit', '-q', '--allow-empty', '-m', 'base'], { cwd: d })
}
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
process.env.MERCURY_CONCOURSE = 'always'
process.env.ANTHROPIC_API_KEY = 'fixture-key-000'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const OUT_DIR = process.env.CONCFLOW_CAPTURE_DIR ?? join(SCRATCH, 'captures')
mkdirSync(OUT_DIR, { recursive: true })

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const untilAsync = async (pred: () => Promise<boolean> | boolean, ms: number): Promise<boolean> => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      if (await pred()) return true
    } catch {
    }
    await new Promise(r => setTimeout(r, 250))
  }
  return false
}

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(home, [ground, sandbox])
{
  const cfgPath = join(home, '.mercury.json')
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
  cfg['switchboardCapacity'] = { askedAt: 1754000000000, allowed: true, recommendedSeats: 5 }
  cfg['customApiKeyResponses'] = { approved: ['fixture-key-000'], rejected: [] }
  writeFileSync(cfgPath, JSON.stringify(cfg))
}
writeFileSync(join(home, 'settings.json'), JSON.stringify({}))
const FOLD_REFUSAL = 'the composed request cannot fit the served context window (fixture)'
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const api = await startFixtureApi([
  { kind: 'error', status: 400, errorType: 'invalid_request_error', message: FOLD_REFUSAL, whenBody: 'running record of this conversation' },
  { kind: 'error', status: 400, errorType: 'invalid_request_error', message: FOLD_REFUSAL, whenBody: 'running record of this conversation' },
  { kind: 'error', status: 400, errorType: 'invalid_request_error', message: FOLD_REFUSAL, whenBody: 'running record of this conversation' },
  { kind: 'text', text: 'alpha is ready.', whenModel: 'opus', whenBody: 'say alpha' },
  { kind: 'text', text: 'beta is ready.', whenModel: 'opus', whenBody: 'say beta' },
  { kind: 'text', text: 'Spare one.', whenModel: 'opus' },
  { kind: 'text', text: 'Spare two.', whenModel: 'opus' },
  { kind: 'text', text: 'Spare three.', whenModel: 'opus' },
])

const logFd = openSync(join(SCRATCH, 'daemon.log'), 'a')
const childEnv: Record<string, string | undefined> = {
  ...process.env,
  MERCURY_CONFIG_DIR: home,
  MERCURY_DAEMON_DIR: daemonDir,
  ANTHROPIC_API_KEY: 'fixture-key-000',
  ANTHROPIC_BASE_URL: api.url,
  MERCURY_CACHE_CLOCK: '0',
  MERCURY_PARTY: '0',
  MERCURY_AWAY_SUMMARY: '0',
  MERCURY_LIVE_GLYPHS: '0',
  MERCURY_LIVE_CLOCK: '0',
  MERCURY_CRITTER_GAZE: '0',
  MERCURY_CRITTER_IDLE: '0',
  MERCURY_CRITTER_SLEEP: '0',
  MERCURY_TURN_RECEIPT: '0',
  MERCURY_TERMINAL_TITLE: '0',
  MERCURY_OPERATOR: 'sam',
}
delete childEnv.NODE_ENV
delete childEnv.MERCURY_HOME
const daemon = spawn('node', [BIN, 'daemon', 'run', ground], { cwd: ground, env: childEnv as NodeJS.ProcessEnv, stdio: ['ignore', logFd, logFd] })
const clientBeat = startDaemonClientBeat()

type Grid = { grid: { c: string }[][] }
const linesOf = (g: Grid): string[] => g.grid.map(r => r.map(c => c.c || ' ').join('').replace(/\s+$/, ''))
interface Send { atTick?: number; afterPrevTicks?: number; data: string; awaitText?: string; minTick?: number; awaitSettleTicks?: number; mark?: string }
const marks = new Map<string, string[]>()
const runScreen = (tag: string, cwd: string, sends: Send[], total: number): { child: ChildProcess; out: string; done: Promise<number | null> } => {
  const out = join(OUT_DIR, `${tag}.json`)
  const cfgPath = join(SCRATCH, `${tag}-cfg.json`)
  writeFileSync(cfgPath, JSON.stringify({ argv: ['node', BIN], cwd, sends, total, cols: 120, rows: 40, out }))
  const child = spawn('/usr/bin/python3', [VSHOT, cfgPath], {
    env: { ...childEnv, MERCURY_CONCOURSE: 'always', MERCURY_SUBMIT_TRACE: join(SCRATCH, `${tag}-submit-trace.jsonl`) } as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const killer = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(300_000))
  const done = new Promise<number | null>(resolve => child.on('exit', code => { clearTimeout(killer); resolve(code) }))
  return { child, out, done }
}
const readMarks = (tag: string, out: string): void => {
  if (!existsSync(out)) return
  const payload = JSON.parse(readFileSync(out, 'utf8')) as Grid & { marks?: ({ label: string } & Grid)[] }
  for (const m of payload.marks ?? []) {
    marks.set(`${tag}:${m.label}`, linesOf(m))
    writeFileSync(join(OUT_DIR, `${tag}-mark-${m.label}.txt`), linesOf(m).join('\n') + '\n')
  }
  marks.set(`${tag}:final`, linesOf(payload))
  writeFileSync(join(OUT_DIR, `${tag}-final.txt`), linesOf(payload).join('\n') + '\n')
}
const frame = (key: string): string => (marks.get(key) ?? []).join('\n')
const records = (path: string): Array<{ kind: string; text: string; at: string }> => {
  if (!existsSync(path)) return []
  const out: Array<{ kind: string; text: string; at: string }> = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const r = JSON.parse(line) as { occurredAt?: string; timestamp?: string; payload?: { kind?: string; content?: unknown; text?: unknown } }
      const kind = r.payload?.kind ?? ''
      const content = r.payload?.content ?? r.payload?.text ?? ''
      out.push({ kind, text: typeof content === 'string' ? content : JSON.stringify(content), at: r.occurredAt ?? r.timestamp ?? '' })
    } catch {
    }
  }
  return out
}
const COMPACT_ECHO = '<command-name>/compact</command-name>'
const CAVEAT = '<local-command-caveat>'
const HELP_SENTENCE = 'Commands are in the form'
const HELLO = 'hello from the beta screen'

try {
  const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
  const sup = await import('../../src/daemon/concourseWorkers.ts')
  const paths = await import('../../src/utils/sessionStorage/paths.ts')
  const dispatch = await import('../../src/daemon/concourseDispatch.ts')
  check('the scratch daemon serves', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000))
  const admit = async (title: string, cmid: string, prompt: string, workspaceDir: string): Promise<string> => {
    const d = (await daemonControlRpc({ op: 'concourseDispatch', clientMessageId: cmid, prompt, workspaceDir, title, model: DEFAULT_OPUS, effort: 'high' } as never, { timeoutMs: 15_000 })) as { ok?: boolean; sessionId?: string }
    check(`${title} admitted`, d.ok === true && typeof d.sessionId === 'string', JSON.stringify(d))
    return d.sessionId ?? ''
  }
  const sidB = await admit('beta probe', 'stays-home-beta', 'say beta is ready', ground)
  const sidA = await admit('alpha probe', 'stays-home-alpha', 'say alpha is ready', sandbox)
  const liveIds = (): string[] => Object.values(sup.readSessionWorkers(daemonDir)).filter(r => r.endedAt === undefined).map(r => r.sessionId)
  check('both sessions live on the one daemon, in two folders', await untilAsync(() => liveIds().includes(sidA) && liveIds().includes(sidB), 30_000), liveIds().join(','))
  await untilAsync(() => api.requests.length >= 2, 40_000)
  await new Promise(r => setTimeout(r, 4000))
  const tA = join(paths.getProjectDir(sandbox), `${sidA}.jsonl`)
  const tB = join(paths.getProjectDir(ground), `${sidB}.jsonl`)
  check('both transcripts stand, each in its own project folder', existsSync(tA) && existsSync(tB) && paths.getProjectDir(sandbox) !== paths.getProjectDir(ground))

  const screen1 = runScreen('beta-screen', ground, [
    { atTick: 999, awaitText: 'beta probe', minTick: 5, awaitSettleTicks: 3, data: '\t', mark: 'boot' },
    { afterPrevTicks: 3, data: '\r', mark: 'list' },
    { afterPrevTicks: 3, data: '\r', mark: 'armed' },
    { atTick: 999, awaitText: '? for shortcuts', minTick: 3, awaitSettleTicks: 2, data: '', mark: 'chat-b' },
    { afterPrevTicks: 150, data: '', mark: 'b-after-alpha-compact' },
    { afterPrevTicks: 5, data: HELLO, mark: 'typed' },
    { afterPrevTicks: 3, data: '\r', mark: 'sent' },
    { atTick: 999, awaitText: 'Spare', minTick: 3, awaitSettleTicks: 10, data: '', mark: 'end' },
  ], 400)
  await new Promise(r => setTimeout(r, 12_000))
  const screen2 = runScreen('alpha-screen', sandbox, [
    { atTick: 999, awaitText: 'alpha probe', minTick: 5, awaitSettleTicks: 3, data: '\t', mark: 'boot' },
    { afterPrevTicks: 3, data: '\r', mark: 'list' },
    { afterPrevTicks: 3, data: '\r', mark: 'armed' },
    { atTick: 999, awaitText: '? for shortcuts', minTick: 3, awaitSettleTicks: 2, data: '/compact', mark: 'chat-a' },
    { afterPrevTicks: 3, data: '\r', mark: 'typed-compact' },
    { atTick: 999, awaitText: 'Error during compaction', minTick: 3, awaitSettleTicks: 4, data: '', mark: 'after-compact' },
    { afterPrevTicks: 120, data: '', mark: 'end' },
  ], 320)
  const [s1, s2] = await Promise.all([screen1.done, screen2.done])
  check('both screens ran their journeys to the end', s1 === 0 && s2 === 0, `${s1}/${s2}`)
  readMarks('beta-screen', screen1.out)
  readMarks('alpha-screen', screen2.out)

  section('L1 the slash command ran where it was typed, and its rows landed there')
  const a = records(tA)
  const b = records(tB)
  const aCompactAt = a.findIndex(r => r.kind === 'input' && r.text.includes(COMPACT_ECHO))
  check("alpha's transcript carries the caveat, the /compact echo and its stderr, in that order", aCompactAt > 0 && a[aCompactAt - 1]!.text.startsWith(CAVEAT) && a.slice(aCompactAt + 1).some(r => r.text.includes(FOLD_REFUSAL)), JSON.stringify(a.map(r => `${r.kind}:${r.text.slice(0, 40)}`)))
  check("alpha's screen painted the command and its error under the operator's own chat", frame('alpha-screen:end').includes('/compact') && frame('alpha-screen:end').includes('Error during compaction'))

  section("L2 the other session never received a byte of it — not the caveat, not the echo, not the error, not a bare help sentence")
  const leaked = b.filter(r => r.text.includes(CAVEAT) || r.text.includes(COMPACT_ECHO) || r.text.includes(FOLD_REFUSAL) || r.text.includes(HELP_SENTENCE) || r.text.includes('Error during compaction'))
  check("beta's transcript carries none of alpha's rows", leaked.length === 0, JSON.stringify(leaked.map(r => r.text.slice(0, 80))))
  const helloAt = b.findIndex(r => r.kind === 'input' && r.text.includes(HELLO))
  check("beta's own line landed and was answered", helloAt >= 0 && b.slice(helloAt + 1).some(r => r.kind === 'output'), JSON.stringify(b.map(r => `${r.kind}:${r.text.slice(0, 40)}`)))
  const betaWire = api.requests.filter(r => r.raw.includes(HELLO))
  check("beta's next request on the wire carries its own words and none of alpha's rows", betaWire.length >= 1 && betaWire.every(r => !r.raw.includes(COMPACT_ECHO) && !r.raw.includes(FOLD_REFUSAL) && !r.raw.includes(CAVEAT)), `${betaWire.length} request(s)`)
  const betaFrame = frame('beta-screen:end')
  check("beta's screen paints its own chat only — no /compact row, no foreign error, nothing painted as the operator's that the operator did not type", betaFrame.includes(HELLO) && !betaFrame.includes('/compact') && !betaFrame.includes('Error during compaction') && !betaFrame.includes(HELP_SENTENCE), betaFrame.split('\n').slice(-16).join('\n'))

  section('L3 the dispatch ledger keys every line by the session it was typed for')
  const ledger = Object.values(dispatch.readConcourseDispatches(daemonDir))
  const compactDigest = createHash('sha256').update('/compact', 'utf8').digest('hex')
  const compactRows = ledger.filter(r => r.promptDigest === compactDigest)
  check('the /compact dispatch rode to alpha alone', compactRows.length === 1 && compactRows[0]!.sessionId === sidA, JSON.stringify(compactRows.map(r => [r.sessionId, r.state])))
  const helloDigest = createHash('sha256').update(HELLO, 'utf8').digest('hex')
  check("beta's line rode to beta alone", ledger.filter(r => r.promptDigest === helloDigest).every(r => r.sessionId === sidB) && ledger.some(r => r.promptDigest === helloDigest))
  const bareDigest = createHash('sha256').update('/', 'utf8').digest('hex')
  check('no bare slash was ever dispatched to either session', !ledger.some(r => r.promptDigest === bareDigest))
} finally {
  clientBeat.stop()
  try {
    const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
    await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never)
  } catch {
  }
  daemon.kill('SIGTERM')
  await api.close()
  if (failures === 0 && process.env.CONCFLOW_CAPTURE_DIR === undefined) rmSync(SCRATCH, { recursive: true, force: true })
  else console.log(`captures and transcripts kept at ${SCRATCH}`)
}

console.log(failures === 0 ? `\n✅ A LOCAL COMMAND STAYS HOME — ${checks} checks` : `\n❌ ${failures} of ${checks} checks failed`)
process.exit(failures === 0 ? 0 : 1)
