#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ScriptedTurn } from '../lib/fixtureApi.ts'

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
type Answer = import('../../src/runner/wire/methods.ts').PermissionAnswer
const presenceOf = (asks as { operatorClientPresence?: (dir?: string, now?: number) => Presence }).operatorClientPresence
type PresenceTable = {
  noteClientPresence: (pid: number, kind: 'screen', now?: number) => void
  clientPresenceVerdict: (now?: number) => Presence
  resetClientPresenceForProofs: (opts?: { since?: number }) => void
  CLIENT_PRESENCE_STALE_MS: number
}
const presenceTable = (await import('../../src/daemon/clientPresence.ts').catch(() => null)) as PresenceTable | null
type ScreenBeat = {
  screenPresenceFrame: (pid?: number) => { op: string; clientPid: number; clientKind: string }
  startScreenPresenceBeat: () => boolean
  stopScreenPresenceBeat: () => void
  screenPresenceBeatArmed: () => boolean
}
const screenBeat = (await import('../../src/services/switchboard/screenPresence.ts').catch(() => null)) as ScreenBeat | null
const warmTable = (): void => presenceTable?.resetClientPresenceForProofs({ since: Date.now() - presenceTable.CLIENT_PRESENCE_STALE_MS - 1 })
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
const SESSION = 'sess-concourse-w1'
const hold = (tag: string, tool: string, presence: Presence): { id: string | undefined; answer: Answer | null; settled: Promise<Answer> } => {
  const h = asks.holdWorkerAsk('concourse-w1', { kind: 'tool', tool_use_id: `tu-${tag}`, tool_name: tool, input: { command: 'git push' } }, pureDaemonDir, 0, () => presence)
  const entry = { id: asks.listPendingPermissionAsks().filter(a => a.workerId === 'concourse-w1').at(-1)?.requestId, answer: null as Answer | null, settled: h.answer }
  void h.answer.then(a => {
    entry.answer = a
  })
  return entry
}
const isAskRow = (o: { ref?: string; sessionId?: string }): boolean => (o.ref?.startsWith('permission:') ?? false) && o.sessionId === SESSION
const parked = (id: string): boolean => asks.listPendingPermissionAsks().some(a => a.requestId === id)
type ReceiptRow = { ref?: string; sessionId?: string; status?: string; revision?: number; createdAtMs?: number; settledAtMs?: number; settlement?: { by?: string }; question?: string }
const rowWords = (o: ReceiptRow): string => `${o.ref ?? '?'} ${o.status ?? '?'} rev=${String(o.revision)} by=${j(o.settlement?.by ?? '')} created=${String(o.createdAtMs)} settled=${String(o.settledAtMs)}`
const { crewStoreRoot } = await import('../../src/services/crew/identity.ts')
const switchboardStorePath = (): string => join(crewStoreRoot(), 'obligations-switchboard.json')
const committedRows = (): ReceiptRow[] => {
  try {
    const file = JSON.parse(readFileSync(switchboardStorePath(), 'utf8')) as { obligations?: Record<string, ReceiptRow> }
    return Object.values(file.obligations ?? {})
  } catch {
    return []
  }
}

section('A1 the pure road: no operator client attached — the ask is denied at once on the runner\'s own request and never parks')
{
  const commits: string[] = []
  const unsubscribe = obligations.subscribeObligations(() => {
    const row = committedRows().find(isAskRow)
    commits.push(row === undefined ? 'absent' : `${row.status ?? '?'}@rev${String(row.revision)}`)
  }, { scope: 'switchboard' })
  const t0 = Date.now()
  const nobody = hold('nobody', 'Bash', 'absent')
  const answer = await Promise.race([nobody.settled, sleep(1_000).then(() => null)])
  const settledIn = Date.now() - t0
  const text = answer?.outcome === 'deny' ? (answer.message ?? '') : ''
  check("red on the base: a deny answer reached the runner's request at once (nothing parked)", answer !== null && nobody.id === undefined && asks.listPendingPermissionAsks().every(a => a.workerId !== 'concourse-w1'), `answer=${j(answer)} parked=${j(asks.listPendingPermissionAsks())}`)
  check('...settled under a second', settledIn < 1_000, `${settledIn}ms`)
  check('...its outcome is deny', answer?.outcome === 'deny', j(answer))
  check('...the words are the typed denial with the daemon\'s own cause', EXPECTED_LEAD('Bash').test(text), j(text))
  check('...one owner: byte-identical to UNANSWERED_ASK_REJECT_MESSAGE(tool, NO_CLIENT_ATTACHED_CAUSE) and to unattendedAskDenialMessage', denialOf !== undefined && CAUSE !== undefined && text === UNANSWERED_ASK_REJECT_MESSAGE('Bash', CAUSE) && text === denialOf('Bash'), denialOf === undefined ? 'no unattendedAskDenialMessage export (the base)' : j(text))
  check('...the classifier reads it as a denial (the crimson glyph, the stop guidance)', isDenialResultText(text), j(text))
  const receipt = await until(async () => {
    const rows = await obligations.listObligations({ scope: 'switchboard' } as never)
    return (rows as Array<{ ref?: string; sessionId?: string; status?: string; settlement?: { by?: string } }>).some(o => isAskRow(o) && o.status === 'withdrawn' && /denied at once/.test(o.settlement?.by ?? ''))
  }, 5_000)
  check('...the receipt: the obligation for the ask is recorded and settled withdrawn by the daemon with the cause (never a silent disappearance)', receipt)
  const openRows = (await obligations.openObligations({ scope: 'switchboard' })).filter(o => isAskRow(o))
  check('...no open needs-you row is left for it', openRows.length === 0, openRows.map(rowWords).join(' | '))
  await until(() => commits.length > 0, 5_000)
  unsubscribe()
  const receiptRow = (await obligations.listObligations({ scope: 'switchboard' } as never) as ReceiptRow[]).find(o => isAskRow(o))
  check('red on the base: the receipt is born settled — no commit of the needs-you store ever carried the row OPEN (the base mints it open and withdraws it in a second commit)', commits.length > 0 && commits.every(c => !c.startsWith('open')), `commits seen=${j(commits)}`)
  check('red on the base: ...one commit, one revision: the settled receipt carries revision 1', receiptRow?.revision === 1 && receiptRow.status === 'withdrawn', receiptRow === undefined ? 'no receipt row' : rowWords(receiptRow))
}

section('A2 the parking law stands with a client attached, and when presence cannot be read')
{
  const someone = hold('someone', 'Bash', 'attached')
  await sleep(20)
  check('with a client attached the session\'s own ask parks as before (no answer, no clock)', someone.id !== undefined && parked(someone.id) && someone.answer === null, `parked=${j(asks.listPendingPermissionAsks())} answer=${j(someone.answer)}`)
  await sleep(120)
  check('...and is still parked past a zero-clock wait', someone.id !== undefined && parked(someone.id))
  const answered = asks.answerPermissionAsk(someone.id ?? '', false, 'operator')
  await sleep(20)
  check('...the operator\'s answer lands where the ask waits', answered.outcome === 'applied' && someone.answer?.outcome === 'deny', j({ answered, answer: someone.answer }))
  const unknown = hold('unknown', 'Bash', 'unknown')
  await sleep(20)
  check('presence unknown (no daemon record to read) parks too — the daemon never denies on a fact it could not read', unknown.id !== undefined && parked(unknown.id) && unknown.answer === null)
  asks.answerPermissionAsk(unknown.id ?? '', false, 'operator')
}

section('A3 the production presence fact reads the daemon\'s own cockpit facts: the owner pid and the live focus/attach stamps')
{
  warmTable()
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


section('A4 the screen-presence beat: a live client that keeps beating is attached whatever chat it shows; a dead or silent one is not')
{
  check('red on the base: the daemon keeps a client-presence table (clientPresence.ts) and the screen has a beat (screenPresence.ts)', presenceTable !== null && screenBeat !== null && presenceOf !== undefined)
  if (presenceTable !== null && screenBeat !== null && presenceOf !== undefined) {
    const beatModule = presenceTable
    const screen = screenBeat
    const stale = beatModule.CLIENT_PRESENCE_STALE_MS
    const now = Date.now()
    writeFileSync(supervisorStatePath(), JSON.stringify({ pid: process.pid, version: '1.0.0', origin: 'transient', startedAt: now - 3_600_000, dir: SCRATCH, controlSock: '', ownerPid: null }))
    writeWorkers({ 'concourse-w1': record('concourse-w1') })
    beatModule.resetClientPresenceForProofs({ since: now - stale - 1 })
    check('a persistent daemon, no owner, no stamp, a warm table with no beat → absent', presenceOf(pureDaemonDir, now) === 'absent', String(presenceOf(pureDaemonDir, now)))
    beatModule.noteClientPresence(process.pid, 'screen', now)
    check('...a live screen beating (this process) → attached, no stamp needed (the blank chat)', presenceOf(pureDaemonDir, now) === 'attached', String(presenceOf(pureDaemonDir, now)))
    rmSync(supervisorStatePath(), { force: true })
    check('...the beat wins even when the daemon record cannot be read', presenceOf(pureDaemonDir, now) === 'attached', String(presenceOf(pureDaemonDir, now)))
    writeFileSync(supervisorStatePath(), JSON.stringify({ pid: process.pid, version: '1.0.0', origin: 'transient', startedAt: now - 3_600_000, dir: SCRATCH, controlSock: '', ownerPid: null }))
    check('...a beat older than the stale window counts for nothing → absent', presenceOf(pureDaemonDir, now + stale + 1) === 'absent', String(presenceOf(pureDaemonDir, now + stale + 1)))
    beatModule.resetClientPresenceForProofs({ since: now - stale - 1 })
    beatModule.noteClientPresence(999999, 'screen', now)
    check('...a beat from a dead pid is dropped → absent', presenceOf(pureDaemonDir, now) === 'absent', String(presenceOf(pureDaemonDir, now)))
    beatModule.resetClientPresenceForProofs({ since: now })
    check('a daemon younger than one stale window that has heard no client yet → unknown (parks: a client may still be announcing itself)', presenceOf(pureDaemonDir, now) === 'unknown', String(presenceOf(pureDaemonDir, now)))
    check('...and absent once the window has passed with nobody heard', presenceOf(pureDaemonDir, now + stale + 1) === 'absent', String(presenceOf(pureDaemonDir, now + stale + 1)))
    beatModule.resetClientPresenceForProofs({ since: now - stale - 1 })
    rmSync(supervisorStatePath(), { force: true })
    const frame = screen.screenPresenceFrame(4242)
    check('the screen\'s beat is a keyless hello naming its pid and kind', frame.op === 'hello' && frame.clientPid === 4242 && frame.clientKind === 'screen', j(frame))
    const bootstrap = await import('../../src/bootstrap/state.ts')
    bootstrap.setIsInteractive(false)
    check('a non-interactive process (a headless seat, a daemon child) never beats', screen.startScreenPresenceBeat() === false && !screen.screenPresenceBeatArmed())
    bootstrap.setIsInteractive(true)
    check('the interactive screen arms the beat once, idempotently', screen.startScreenPresenceBeat() === true && screen.startScreenPresenceBeat() === true && screen.screenPresenceBeatArmed())
    screen.stopScreenPresenceBeat()
    bootstrap.setIsInteractive(false)
    check('...and disarms', !screen.screenPresenceBeatArmed())
    const door = readFileSync(join(REPO, 'src', 'services', 'switchboard', 'ensureDaemon.ts'), 'utf8')
    check('the screen\'s daemon door starts the beat on every usable daemon (ensureOwnedDaemon)', /if \(usableNow\) startScreenPresenceBeat\(\)/.test(door))
    const server = readFileSync(join(REPO, 'src', 'daemon', 'controlServer.ts'), 'utf8')
    check('the daemon notes a client\'s hello (screen or client kind, its pid) in the presence table', server.includes("const presenceKind = clientPresenceKindOf(raw.clientKind)") && server.includes("if (presenceKind !== undefined && typeof raw.clientPid === 'number') noteClientPresence(raw.clientPid, presenceKind)"))
  }
}

type Row = { occurredAt?: string; payload?: { kind?: string; content?: Array<{ kind?: string; callId?: string; body?: unknown; text?: string }> } }
type Session = { sessionId: string; transcript: () => Row[]; rawTranscript: () => string }
type SeatWorld = { root: string; daemonDir: string; work2: string; dispatch: (tag: string, prompt: string, folder?: string) => Promise<Session | null>; daemonLog: () => string; requests: () => number; close: () => Promise<void> }
type Turn = ScriptedTurn
const askTurn = (extra: Record<string, unknown> = {}): Turn => ({ kind: 'tool_use', whenModel: 'opus', name: 'AskUserQuestion', input: { questions: [{ question: 'Which one?', header: 'Pick', options: [{ label: 'a', description: 'first' }, { label: 'b', description: 'second' }], multiSelect: false }] }, preText: 'let me ask. ', ...extra }) as Turn
const doneTurn = (extra: Record<string, unknown> = {}): Turn => ({ kind: 'text', whenModel: 'opus', text: 'carried on without the answer.', ...extra }) as Turn

async function bootSeatWorld(label: string, owned: boolean, turns: Turn[]): Promise<SeatWorld | null> {
  const root = realpathSync(mkdtempSync(join(SCRATCH, `${label}-`)))
  const home = join(root, 'home')
  const daemonDir = join(root, 'daemon')
  const work = join(root, 'work')
  const work2 = join(root, 'work-two')
  for (const d of [home, daemonDir, work, work2]) mkdirSync(d, { recursive: true })
  const { ALL_MODEL_CONFIGS, newestGenerationKey } = await import('../../src/utils/model/configs.ts')
  const modelKey = ALL_MODEL_CONFIGS[newestGenerationKey('opus')].firstParty
  const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
  seedFirstRun(home, [work, work2])
  writeFileSync(join(work, 'README.md'), '# fixture\n')
  writeFileSync(join(work2, 'README.md'), '# fixture two\n')
  const { startFixtureApi } = await import('../lib/fixtureApi.ts')
  const api = await startFixtureApi([...turns, { kind: 'text', text: 'Spare.' }, { kind: 'text', text: 'Spare.' }])
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
  check(`${label}: the daemon serves from the source (${owned ? 'owned by this process' : 'ownerless'})`, serves)
  if (!serves) {
    await close()
    return null
  }
  const dispatch = async (tag: string, prompt: string, folder: string = work): Promise<Session | null> => {
    const d = (await daemonControlRpc({ op: 'concourseDispatch', clientMessageId: `${label}-${tag}`, prompt, workspaceDir: folder, title: `Ask probe ${tag}`, modelKey, effort: 'high' } as never)) as { ok?: boolean; sessionId?: string; error?: string }
    check(`${label}: session ${tag} dispatched`, d.ok === true && typeof d.sessionId === 'string', j(d))
    if (d.ok !== true || typeof d.sessionId !== 'string') return null
    const sessionId = d.sessionId
    const file = join(paths.getProjectDir(folder), `${sessionId}.jsonl`)
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
    return { sessionId, transcript, rawTranscript }
  }
  return { root, daemonDir, work2, dispatch, daemonLog: () => (existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''), requests: () => api.messageRequests().length, close }
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
const openAskRowsFor = async (sessionId: string): Promise<ReceiptRow[]> => (await obligations.openObligations({ scope: 'switchboard' })).filter(o => o.sessionId === sessionId && (o.ref ?? '').startsWith('permission:'))
const openAsksFor = async (sessionId: string): Promise<number> => (await openAskRowsFor(sessionId)).length
const receiptRowFor = async (sessionId: string): Promise<ReceiptRow | undefined> =>
  ((await obligations.listObligations({ scope: 'switchboard' } as never)) as ReceiptRow[]).find(o => o.sessionId === sessionId && (o.ref ?? '').startsWith('permission:'))
const TYPED_DENIAL = /<tool_use_error>Permission to use AskUserQuestion has been denied: the operator's client was not there to answer \(no operator client is attached to the switchboard\)/

async function expectDeniedAtOnce(label: string, world: SeatWorld, session: Session): Promise<void> {
  const asked = await until(() => rowAt(session.transcript(), 'tool-use') !== undefined, 40_000)
  check(`${label}: the seat raised its ask (the tool-use row landed)`, asked)
  const denied = await until(() => /was not there to answer/.test(bodyText(rowAt(session.transcript(), 'tool-result'))), 8_000)
  const rows = session.transcript()
  const askRow = rowAt(rows, 'tool-use')
  const resultRow = rowAt(rows, 'tool-result')
  const text = bodyText(resultRow)
  check(`${label}: red on the base: the ask's tool_result is the typed denial (the base parks it and no result comes)`, denied && TYPED_DENIAL.test(text), `open asks=${await openAsksFor(session.sessionId)} result=${j(text).slice(0, 200)}`)
  const gapMs = askRow?.occurredAt !== undefined && resultRow?.occurredAt !== undefined ? Date.parse(resultRow.occurredAt) - Date.parse(askRow.occurredAt) : Number.NaN
  check(`${label}: ...landing within a second of the ask (the transcript's own clocks)`, Number.isFinite(gapMs) && gapMs >= 0 && gapMs < 1_000, `${gapMs}ms`)
  check(`${label}: ...the turn carried on: the model's next request was issued and its reply landed`, await until(() => session.rawTranscript().includes('carried on without the answer.'), 15_000), `requests=${world.requests()}`)
  const openRows = await openAskRowsFor(session.sessionId)
  check(`${label}: ...nothing parked: no open needs-you row for the session`, openRows.length === 0, `open rows read: ${openRows.map(rowWords).join(' | ')}`)
  const receipt = await until(async () => {
    const row = await receiptRowFor(session.sessionId)
    return row !== undefined && row.status === 'withdrawn' && /denied at once/.test(row.settlement?.by ?? '')
  }, 5_000)
  check(`${label}: ...the receipt row is settled withdrawn by the daemon with the cause`, receipt)
  const receiptRow = await receiptRowFor(session.sessionId)
  check(`${label}: red on the base: ...born settled in one commit (revision 1) — the base mints the receipt OPEN and withdraws it in a second commit, an open needs-you row for as long as the second takes`, receiptRow?.revision === 1 && receiptRow.status === 'withdrawn', receiptRow === undefined ? 'no receipt row' : rowWords(receiptRow))
  check(`${label}: ...the daemon log names it`, /permission ask [0-9a-f-]+ \([A-Za-z]+ for concourse-w\d+\) denied at once — no operator client is attached to the switchboard/.test(world.daemonLog()), world.daemonLog().split('\n').filter(l => /permission ask/.test(l)).slice(-2).join(' | ').slice(0, 300))
}

async function expectParked(label: string, world: SeatWorld, session: Session, requestsBefore: number): Promise<void> {
  const parkedRow = await until(async () => (await openAsksFor(session.sessionId)) > 0, 40_000)
  check(`${label}: the ask parks: an open needs-you row for the session`, parkedRow, `open asks=0 · transcript result=${j(bodyText(rowAt(session.transcript(), 'tool-result'))).slice(0, 160)}`)
  await sleep(3_000)
  check(`${label}: ...still parked after 3 s, no denial reached the seat, the turn waits`, (await openAsksFor(session.sessionId)) > 0 && !/was not there to answer/.test(session.rawTranscript()) && world.requests() === requestsBefore + 1, `requests=${world.requests()}`)
}

section('B the seat under the real daemon, from the source, nobody attached and nobody ever beating: the ask is denied at once and the turn goes on')
{
  const world = await bootSeatWorld('unattended', false, [askTurn(), doneTurn()])
  if (world !== null) {
    try {
      await sleep(31_000)
      const session = await world.dispatch('ask', 'probe: ask the operator a question')
      if (session !== null) await expectDeniedAtOnce('B', world, session)
    } finally {
      await world.close()
    }
  }
}

section('C the same seat with the daemon owned by a live terminal: the ask parks as before, no clock')
{
  const world = await bootSeatWorld('attended', true, [askTurn(), doneTurn()])
  if (world !== null) {
    try {
      const session = await world.dispatch('ask', 'probe: ask the operator a question')
      if (session !== null) await expectParked('C', world, session, 0)
    } finally {
      await world.close()
    }
  }
}

section('D the blank-chat row: a persistent, ownerless daemon with a live screen attached on a blank chat PARKS the ask; the same daemon once that screen\'s pid is dead denies at once')
{
  const world = await bootSeatWorld('blank-chat', false, [askTurn({ whenBody: 'probe one' }), askTurn({ whenBody: 'probe two' }), doneTurn({ whenBody: 'probe two' })])
  if (world !== null) {
    const screenScript = join(world.root, 'screen.ts')
    writeFileSync(
      screenScript,
      `;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }\n` +
        `const { daemonControlRpc } = await import(${j(join(REPO, 'src', 'daemon', 'controlSocket.ts'))})\n` +
        `const { screenPresenceFrame } = await import(${j(join(REPO, 'src', 'services', 'switchboard', 'screenPresence.ts'))})\n` +
        `const beat = async (): Promise<void> => { try { await daemonControlRpc(screenPresenceFrame(), { timeoutMs: 1000, protoRetry: false }) } catch {} }\n` +
        `await beat()\nconsole.log('BEATING ' + process.pid)\nsetInterval(() => void beat(), 2000)\n`,
    )
    const screen = spawn(process.execPath, ['run', screenScript], { env: { ...process.env, MERCURY_DAEMON_DIR: world.daemonDir }, stdio: ['ignore', 'pipe', 'pipe'] })
    let screenOut = ''
    screen.stdout.on('data', (c: Buffer) => (screenOut += c.toString('utf8')))
    const screenExited = new Promise<void>(resolve => screen.on('exit', () => resolve()))
    try {
      check('D: a screen process is attached to the daemon and beating (a blank chat: no session focused, nothing owned)', await until(() => /BEATING \d+/.test(screenOut), 20_000), screenOut.slice(0, 200))
      await sleep(31_000)
      const first = await world.dispatch('one', 'probe one: ask the operator a question')
      if (first !== null) await expectParked('D1 (screen alive)', world, first, 0)
      screen.kill('SIGKILL')
      await screenExited
      check('D: the screen\'s pid is dead (killed and reaped)', screen.exitCode !== null || screen.signalCode !== null, `exit=${String(screen.exitCode)} signal=${String(screen.signalCode)}`)
      const second = await world.dispatch('two', 'probe two: ask the operator a question', world.work2)
      if (second !== null) await expectDeniedAtOnce('D2 (screen dead)', world, second)
      if (first !== null) check('D: the first ask, parked while the screen lived, still waits for the operator (the daemon never re-judges a parked ask)', (await openAsksFor(first.sessionId)) > 0)
    } finally {
      try {
        screen.kill('SIGKILL')
      } catch {
      }
      await world.close()
    }
  }
}

if (failures === 0) rmSync(SCRATCH, { recursive: true, force: true })
else console.log(`[forensics] world kept: ${SCRATCH}`)
console.log(failures === 0 ? '\nprove-unattended-ask-denied: ALL LAWS HOLD' : `\nprove-unattended-ask-denied: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
