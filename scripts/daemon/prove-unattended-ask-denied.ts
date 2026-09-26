#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'unattended-ask-')))
const pureDaemonDir = join(SCRATCH, 'pure-daemon')
mkdirSync(pureDaemonDir, { recursive: true })
process.env.MERCURY_DAEMON_DIR = pureDaemonDir
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'pure-home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
process.env.MERCURY_CONCOURSE = 'always'
process.env.ANTHROPIC_API_KEY = 'fixture-key-000'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v)
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const until = async (pred: () => Promise<boolean> | boolean, ms: number): Promise<boolean> => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      if (await pred()) return true
    } catch {
    }
    await sleep(50)
  }
  return false
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT: the unattended-ask laws exceeded 240s')
  process.exit(1)
}, 240_000)
guard.unref?.()

console.log('============================================================')
console.log(' the unattended permission ask: with no operator client attached the daemon denies it at once')
console.log(' the base parks every ask whoever is there (checks marked red on the base)')
console.log('============================================================')

const asks = await import('../../src/daemon/permissionAsks.ts')
const { concourseWorkersPath } = await import('../../src/daemon/concourseSupervisor.ts')
const { supervisorStatePath } = await import('../../src/daemon/controlSocket.ts')
const { isDenialResultText, UNANSWERED_ASK_REJECT_MESSAGE } = await import('../../src/utils/messages/rejectionText.ts')
const obligations = await import('../../src/services/crew/obligations.ts')
type Presence = 'attached' | 'absent' | 'unknown'
const onAsk = asks.onWorkerControlRequest as unknown as (
  short: string,
  frame: Record<string, unknown>,
  dir?: string,
  channel?: { control(short: string, frame: string): boolean },
  expiryMs?: number,
  presence?: (dir?: string) => Presence,
) => void
const presenceOf = (asks as { operatorClientPresence?: (dir?: string) => Presence }).operatorClientPresence
const denialOf = (asks as { unattendedAskDenialMessage?: (toolName: string) => string }).unattendedAskDenialMessage
const CAUSE = (asks as { NO_CLIENT_ATTACHED_CAUSE?: string }).NO_CLIENT_ATTACHED_CAUSE
const EXPECTED_LEAD = (tool: string): RegExp => new RegExp(`^Permission to use ${tool} has been denied: the operator's client was not there to answer \\(no operator client is attached to the switchboard\\), so the action was not run\\. `)

const record = (short: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  runnerId: short,
  sessionId: `sess-${short}`,
  workspaceId: join(SCRATCH, 'ws'),
  title: `t-${short}`,
  createdAt: Date.now(),
  startedAt: Date.now(),
  ...extra,
})
const writeWorkers = (workers: Record<string, unknown>): void => {
  writeFileSync(concourseWorkersPath(pureDaemonDir), JSON.stringify({ version: 1, workers }))
}
writeWorkers({ 'concourse-w1': record('concourse-w1') })
const sent: Array<{ short: string; frame: Record<string, unknown> }> = []
const channel = { control: (short: string, frame: string) => (sent.push({ short, frame: JSON.parse(frame) as Record<string, unknown> }), true) }
const askFrame = (id: string, tool: string): Record<string, unknown> => ({
  type: 'control_request',
  request_id: id,
  request: { subtype: 'can_use_tool', tool_name: tool, input: { command: 'git push' } },
})
const framesFor = (id: string): Array<Record<string, unknown>> =>
  sent.filter(s => (s.frame as { response?: { request_id?: string } }).response?.request_id === id).map(s => s.frame)
const denyTextOf = (frame: Record<string, unknown> | undefined): string =>
  String((frame as { response?: { response?: { message?: string } } } | undefined)?.response?.response?.message ?? '')
const parked = (id: string): boolean => asks.listPendingPermissionAsks().some(a => a.requestId === id)

section('A1 the pure road: no operator client attached — the ask is denied at once through the child\'s control channel and never parks')
{
  const t0 = Date.now()
  onAsk('concourse-w1', askFrame('req-nobody', 'Bash'), pureDaemonDir, channel, 0, () => 'absent')
  const settledIn = Date.now() - t0
  const frame = framesFor('req-nobody')[0]
  const text = denyTextOf(frame)
  check('red on the base: a deny control_response reached the child at once (nothing parked)', frame !== undefined && !parked('req-nobody'), `frames=${framesFor('req-nobody').length} parked=${parked('req-nobody')}`)
  check('...settled under a second', settledIn < 1_000, `${settledIn}ms`)
  check('...its behavior is deny', (frame as { response?: { response?: { behavior?: string } } } | undefined)?.response?.response?.behavior === 'deny', j(frame))
  check('...the words are the typed denial with the daemon\'s own cause', EXPECTED_LEAD('Bash').test(text), j(text))
  check('...one owner: byte-identical to UNANSWERED_ASK_REJECT_MESSAGE(tool, NO_CLIENT_ATTACHED_CAUSE) and to unattendedAskDenialMessage', denialOf !== undefined && CAUSE !== undefined && text === UNANSWERED_ASK_REJECT_MESSAGE('Bash', CAUSE) && text === denialOf('Bash'), denialOf === undefined ? 'no unattendedAskDenialMessage export (the base)' : j(text))
  check('...the classifier reads it as a denial (the crimson glyph, the stop guidance)', isDenialResultText(text), j(text))
  const receipt = await until(async () => {
    const rows = await obligations.listObligations({ scope: 'switchboard' } as never)
    return (rows as Array<{ ref?: string; status?: string; settlement?: { by?: string } }>).some(o => o.ref === 'permission:req-nobody' && o.status === 'withdrawn' && /denied at once/.test(o.settlement?.by ?? ''))
  }, 5_000)
  check('...the receipt: the obligation for the ask is recorded and settled withdrawn by the daemon with the cause (never a silent disappearance)', receipt)
  check('...no open needs-you row is left for it', !(await obligations.openObligations({ scope: 'switchboard' })).some(o => o.ref === 'permission:req-nobody'))
}

section('A2 the parking law stands with a client attached, and when presence cannot be read')
{
  onAsk('concourse-w1', askFrame('req-someone', 'Bash'), pureDaemonDir, channel, 0, () => 'attached')
  check('with a client attached the session\'s own ask parks as before (no frame, no clock)', parked('req-someone') && framesFor('req-someone').length === 0, `parked=${parked('req-someone')} frames=${framesFor('req-someone').length}`)
  await sleep(120)
  check('...and is still parked past a zero-clock wait', parked('req-someone'))
  const answered = asks.answerPermissionAsk('req-someone', false, channel, 'operator')
  check('...the operator\'s answer lands where the ask waits', answered.outcome === 'applied' && framesFor('req-someone').length === 1)
  onAsk('concourse-w1', askFrame('req-unknown', 'Bash'), pureDaemonDir, channel, 0, () => 'unknown')
  check('presence unknown (no daemon record to read) parks too — the daemon never denies on a fact it could not read', parked('req-unknown') && framesFor('req-unknown').length === 0)
  asks.answerPermissionAsk('req-unknown', false, channel, 'operator')
}

section('A3 the production presence fact reads the daemon\'s own cockpit facts: the owner pid and the live focus/attach stamps')
{
  rmSync(supervisorStatePath(), { force: true })
  check('red on the base: operatorClientPresence exists', presenceOf !== undefined)
  if (presenceOf !== undefined) {
    check('no supervisor record → unknown', presenceOf(pureDaemonDir) === 'unknown', String(presenceOf(pureDaemonDir)))
    const supervisor = (ownerPid: number | null): void => writeFileSync(supervisorStatePath(), JSON.stringify({ pid: process.pid, version: '1.0.0', origin: 'transient', startedAt: Date.now(), dir: SCRATCH, controlSock: '', ownerPid }))
    supervisor(process.pid)
    check('an owned daemon whose owner terminal is alive → attached', presenceOf(pureDaemonDir) === 'attached', String(presenceOf(pureDaemonDir)))
    supervisor(null)
    writeWorkers({ 'concourse-w1': record('concourse-w1') })
    check('a persistent daemon (no owner) with no live focus or attach stamp → absent', presenceOf(pureDaemonDir) === 'absent', String(presenceOf(pureDaemonDir)))
    writeWorkers({ 'concourse-w1': record('concourse-w1', { focusedAt: Date.now(), focusedBy: `operator:${process.pid}` }) })
    check('...a live terminal\'s focus stamp on any live session → attached', presenceOf(pureDaemonDir) === 'attached', String(presenceOf(pureDaemonDir)))
    writeWorkers({ 'concourse-w1': record('concourse-w1', { attachedAt: Date.now(), attachedBy: 'operator:999999' }) })
    check('...a stamp naming a dead terminal counts for nothing → absent', presenceOf(pureDaemonDir) === 'absent', String(presenceOf(pureDaemonDir)))
    writeWorkers({ 'concourse-w1': record('concourse-w1', { endedAt: Date.now(), focusedAt: Date.now(), focusedBy: `operator:${process.pid}` }) })
    check('...a stamp on an ended record counts for nothing → absent', presenceOf(pureDaemonDir) === 'absent', String(presenceOf(pureDaemonDir)))
    supervisor(999999)
    check('an owned daemon whose owner is gone and no stamp → absent', presenceOf(pureDaemonDir) === 'absent', String(presenceOf(pureDaemonDir)))
    rmSync(supervisorStatePath(), { force: true })
  }
}

type Row = { occurredAt?: string; payload?: { kind?: string; content?: Array<{ kind?: string; callId?: string; body?: unknown; text?: string }> } }
type SeatWorld = { transcript: () => Row[]; rawTranscript: () => string; sessionId: string; daemonLog: () => string; requests: () => number; close: () => Promise<void> }

async function bootSeatWorld(label: string, owned: boolean): Promise<SeatWorld | null> {
  const root = realpathSync(mkdtempSync(join(SCRATCH, `${label}-`)))
  const home = join(root, 'home')
  const daemonDir = join(root, 'daemon')
  const work = join(root, 'work')
  for (const d of [home, daemonDir, work]) mkdirSync(d, { recursive: true })
  const { ALL_MODEL_CONFIGS, newestGenerationKey } = await import('../../src/utils/model/configs.ts')
  const modelKey = ALL_MODEL_CONFIGS[newestGenerationKey('opus')].firstParty
  const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
  seedFirstRun(home, [work])
  writeFileSync(join(work, 'README.md'), '# fixture\n')
  const { startFixtureApi } = await import('../lib/fixtureApi.ts')
  const api = await startFixtureApi([
    { kind: 'tool_use', whenModel: 'opus', name: 'AskUserQuestion', input: { questions: [{ question: 'Which one?', header: 'Pick', options: [{ label: 'a', description: 'first' }, { label: 'b', description: 'second' }], multiSelect: false }] }, preText: 'let me ask. ' },
    { kind: 'text', whenModel: 'opus', text: 'carried on without the answer.' },
    { kind: 'text', text: 'Spare.' },
    { kind: 'text', text: 'Spare.' },
  ])
  const launcher = join(root, 'launcher.ts')
  writeFileSync(launcher, `;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }\ndelete process.env.NODE_ENV\nawait import(${j(join(REPO, 'src', 'entrypoints', 'cli.tsx'))})\n`)
  const logPath = join(root, 'daemon.log')
  const logFd = openSync(logPath, 'a')
  const daemon = spawn(process.execPath, ['run', launcher, 'daemon', 'run', work], {
    cwd: work,
    env: {
      ...process.env,
      MERCURY_CONFIG_DIR: home,
      MERCURY_DAEMON_DIR: daemonDir,
      ANTHROPIC_API_KEY: 'fixture-key-000',
      ANTHROPIC_BASE_URL: api.url,
      MERCURY_CACHE_CLOCK: '0',
      MERCURY_PARTY: '0',
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      ...(owned ? { MERCURY_DAEMON_OWNER_PID: String(process.pid), MERCURY_DAEMON_NO_SELF_WARM: '1' } : {}),
    },
    stdio: ['ignore', logFd, logFd],
  })
  process.env.MERCURY_DAEMON_DIR = daemonDir
  process.env.MERCURY_CONFIG_DIR = home
  const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
  const paths = await import('../../src/utils/sessionStorage/paths.ts')
  const close = async (): Promise<void> => {
    try {
      await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never)
    } catch {
    }
    try {
      daemon.kill('SIGTERM')
    } catch {
    }
    await api.close()
  }
  const serves = await until(async () => ((await daemonControlRpc({ op: 'ping' } as never)) as { ok?: boolean }).ok === true, 60_000)
  check(`${label}: the daemon serves from the source (${owned ? 'owned by this process' : 'ownerless, no screen ever attached'})`, serves)
  if (!serves) {
    await close()
    return null
  }
  const d = (await daemonControlRpc({ op: 'concourseDispatch', clientMessageId: `${label}-ask`, prompt: 'probe: ask the operator a question', workspaceDir: work, title: 'Ask probe', modelKey, effort: 'high' } as never)) as { ok?: boolean; sessionId?: string; error?: string }
  check(`${label}: the session dispatched`, d.ok === true && typeof d.sessionId === 'string', j(d))
  const sessionId = d.sessionId ?? ''
  const file = join(paths.getProjectDir(work), `${sessionId}.jsonl`)
  const rawTranscript = (): string => (existsSync(file) ? readFileSync(file, 'utf8') : '')
  const transcript = (): Row[] =>
    rawTranscript()
      .split('\n')
      .filter(l => l.trim() !== '')
      .map(l => {
        try {
          return JSON.parse(l) as Row
        } catch {
          return {}
        }
      })
  return { transcript, rawTranscript, sessionId, daemonLog: () => (existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''), requests: () => api.messageRequests().length, close }
}
const partsOf = (row: Row | undefined): Array<{ kind?: string; callId?: string; body?: unknown; text?: string }> => {
  const content = row?.payload?.content
  return Array.isArray(content) ? content : []
}
const rowAt = (rows: Row[], kind: 'tool-use' | 'tool-result'): Row | undefined => rows.find(r => partsOf(r).some(c => c.kind === kind))
const bodyText = (row: Row | undefined): string => {
  const part = partsOf(row).find(c => c.kind === 'tool-result')
  const body = part?.body
  return typeof body === 'string' ? body : Array.isArray(body) ? (body as Array<{ text?: string }>).map(b => b.text ?? '').join('') : j(body ?? '')
}
const openAsksFor = async (sessionId: string): Promise<number> => (await obligations.openObligations({ scope: 'switchboard' })).filter(o => o.sessionId === sessionId && (o.ref ?? '').startsWith('permission:')).length

section('B the seat under the real daemon, from the source, nobody attached: the ask is denied at once and the turn goes on')
{
  const world = await bootSeatWorld('unattended', false)
  if (world !== null) {
    try {
      const asked = await until(() => rowAt(world.transcript(), 'tool-use') !== undefined, 40_000)
      check('the seat raised its ask (the tool-use row landed)', asked)
      const denied = await until(() => /was not there to answer/.test(bodyText(rowAt(world.transcript(), 'tool-result'))), 8_000)
      const rows = world.transcript()
      const askRow = rowAt(rows, 'tool-use')
      const resultRow = rowAt(rows, 'tool-result')
      const text = bodyText(resultRow)
      check('red on the base: the ask\'s tool_result is the typed denial (the base parks it and no result comes)', denied && /<tool_use_error>Permission to use AskUserQuestion has been denied: the operator's client was not there to answer \(no operator client is attached to the switchboard\)/.test(text), `open asks=${await openAsksFor(world.sessionId)} result=${j(text).slice(0, 200)}`)
      const gapMs = askRow?.occurredAt !== undefined && resultRow?.occurredAt !== undefined ? Date.parse(resultRow.occurredAt) - Date.parse(askRow.occurredAt) : Number.NaN
      check('...landing within a second of the ask (the transcript\'s own clocks)', Number.isFinite(gapMs) && gapMs >= 0 && gapMs < 1_000, `${gapMs}ms`)
      check('...the turn carried on: the model\'s next request was issued and its reply landed', await until(() => world.rawTranscript().includes('carried on without the answer.'), 15_000) && world.requests() >= 2, `requests=${world.requests()}`)
      check('...nothing parked: no open needs-you row for the session', (await openAsksFor(world.sessionId)) === 0)
      const receipt = await until(async () => {
        const rows2 = (await obligations.listObligations({ scope: 'switchboard' } as never)) as Array<{ sessionId?: string; ref?: string; status?: string; settlement?: { by?: string } }>
        return rows2.some(o => o.sessionId === world.sessionId && (o.ref ?? '').startsWith('permission:') && o.status === 'withdrawn' && /denied at once/.test(o.settlement?.by ?? ''))
      }, 5_000)
      check('...the receipt row is settled withdrawn by the daemon with the cause', receipt)
      check('...the daemon log names it', /denied at once — no operator client is attached to the switchboard — the child was told/.test(world.daemonLog()), world.daemonLog().split('\n').filter(l => /permission ask/.test(l)).slice(-2).join(' | ').slice(0, 300))
    } finally {
      await world.close()
    }
  }
}

section('C the same seat with a client attached (the daemon owned by a live terminal): the ask parks as before, no clock')
{
  const world = await bootSeatWorld('attended', true)
  if (world !== null) {
    try {
      const parkedRow = await until(async () => (await openAsksFor(world.sessionId)) > 0, 40_000)
      check('the ask parks: an open needs-you row for the session', parkedRow)
      await sleep(3_000)
      check('...still parked after 3 s, no denial reached the seat, the turn waits', (await openAsksFor(world.sessionId)) > 0 && !/was not there to answer/.test(world.rawTranscript()) && world.requests() === 1, `requests=${world.requests()}`)
    } finally {
      await world.close()
    }
  }
}

if (failures === 0) rmSync(SCRATCH, { recursive: true, force: true })
else console.log(`[forensics] world kept: ${SCRATCH}`)
console.log(failures === 0 ? '\nprove-unattended-ask-denied: ALL LAWS HOLD' : `\nprove-unattended-ask-denied: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
