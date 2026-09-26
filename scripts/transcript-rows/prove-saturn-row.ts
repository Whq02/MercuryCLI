#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'saturn-row-home-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_OPERATOR = 'sam'
const ROOT = resolve(import.meta.dir, '..', '..')
const frameDir = ((): string | null => {
  const at = process.argv.indexOf('--frames')
  return at >= 0 && process.argv[at + 1] !== undefined ? resolve(process.argv[at + 1]!) : null
})()
let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)

const { setIsInteractive } = await import(join(ROOT, 'src/bootstrap/state.ts'))
setIsInteractive(false)
const { enableConfigs } = await import(join(ROOT, 'src/utils/config/globalConfig.ts'))
enableConfigs()
const React = (await import('react')).default
const { render, Box } = await import(join(ROOT, 'src/ink.ts'))
const { AppStateProvider } = await import(join(ROOT, 'src/state/AppState.tsx'))
const { getDefaultAppState } = await import(join(ROOT, 'src/state/AppStateStore.ts'))
const { UserTextMessage } = await import(join(ROOT, 'src/components/messages/UserTextMessage.tsx'))
const { Message } = await import(join(ROOT, 'src/components/Message.tsx'))
const { MessageMetaProvider, attachedPlateName, formatClock } = await import(join(ROOT, 'src/components/messages/TranscriptNameplate.tsx'))
const { normalizeMessages } = await import(join(ROOT, 'src/utils/messages/normalize.ts'))
const { buildMessageLookups } = await import(join(ROOT, 'src/utils/messages/lookups.ts'))
const { createUserMessage, createAssistantMessage } = await import(join(ROOT, 'src/utils/messages/factories.ts'))
const { entryToRecord, recordToEntry } = await import(join(ROOT, 'src/fabric/entryCodec.ts'))
const { processUserInput } = await import(join(ROOT, 'src/utils/processUserInput/processUserInput.ts'))
const queue = await import(join(ROOT, 'src/input-core/command-queue.ts'))
const { recordTranscript } = await import(join(ROOT, 'src/utils/sessionStorage.ts'))
const { queueLogRows, undeliveredLines } = await import(join(ROOT, 'src/tasks/LocalAgentTask/launchReceipts.ts'))
const { requeueUndeliveredLines } = await import(join(ROOT, 'src/cli/headless/restartCarry.ts'))
const { shouldShowUserMessage } = await import(join(ROOT, 'src/utils/messages/systemMessages.ts'))
const { queuedCommandHistoryEntry } = await import(join(ROOT, 'src/history.ts'))
const { localWakeStep } = await import(join(ROOT, 'src/tools/ScheduleWakeupTool/localWake.ts'))
const saturn = await import(join(ROOT, 'src/daemon/saturn.ts'))
const { CronListTool } = await import(join(ROOT, 'src/tools/ScheduleCronTool/CronListTool.ts'))
const { CronCreateTool } = await import(join(ROOT, 'src/tools/ScheduleCronTool/CronCreateTool.ts'))
const rows = await import(join(ROOT, 'src/utils/messages/noticeRows.ts'))
const figures = (await import('figures')).default

type Raw = Record<string, unknown>
const h = React.createElement as (...a: unknown[]) => React.ReactElement
const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
const settle = (ms = 200): Promise<void> => new Promise(r => setTimeout(r, ms))
const oneLine = (s: string): string => strip(s).replace(/\s+/g, ' ').trim()
const HANDLE = '[sam]'
const SATURN = '[Saturn]'
const DOT = '●'
const CARET = figures.pointer
const FIRED_AT = '2026-06-19T09:00:00.000Z'
const ROW_AT = '2026-06-19T09:00:04.000Z'
const LATE_ROW_AT = '2026-06-19T09:03:10.000Z'
const HELD_SINCE = '2026-06-19T08:53:36.000Z'
const clock = (iso: string): string => formatClock(iso)!
const REASON = 'the row-2 build is running; RUN-OK follows it'
const WAKE_BODY = 'Check the build log, then answer with the three things that need a ruling, shortest first.'
const WAKE_TEXT = `[self-paced wake — why you woke: ${REASON}]\n\n${WAKE_BODY}`
const CRON_BODY = 'Read the overnight notes under records/ and give me the three things that need my ruling, shortest first.'
const OPERATOR_LINE = 'take the first two as my defaults'
const REPLY = 'Three rulings wait, shortest first.'
const TITLE = 'morning brief'
const CRON_ID = '3f9a2c1d'
const CRON_SPELLING = 'Every weekday at 09:00'
const wakeOrigin = (extra: Raw = {}): Raw => ({ kind: 'saturn', fire: 'wake', firedAt: FIRED_AT, spelling: 'in ~900s', reason: REASON, ...extra })
const cronOrigin = (extra: Raw = {}): Raw => ({ kind: 'saturn', fire: 'cron', firedAt: FIRED_AT, scheduleId: CRON_ID, spelling: CRON_SPELLING, ...extra })
const titledOrigin = (extra: Raw = {}): Raw => cronOrigin({ title: TITLE, ...extra })
const SIZES: Array<[number, number]> = [
  [178, 51],
  [80, 21],
]

function fakeIo(columns: number, rowCount = 51): { stdout: NodeJS.WriteStream; stdin: NodeJS.ReadStream } {
  const stdout = Object.assign(new Writable({ write(_chunk, _enc, cb) { cb() } }), { columns, rows: rowCount, isTTY: false }) as unknown as NodeJS.WriteStream
  const stdin = Object.assign(new Readable({ read() {} }), { isTTY: true, setRawMode() {}, ref() {}, unref() {} }) as unknown as NodeJS.ReadStream
  return { stdout, stdin }
}

async function paintText(props: Raw, meta: Raw, columns = 178): Promise<string> {
  const io = fakeIo(columns)
  const body = h(UserTextMessage as never, { addMargin: false, verbose: false, ...props })
  const instance = await render(
    h(AppStateProvider as never, { initialState: getDefaultAppState() }, h(MessageMetaProvider as never, { message: meta }, body)),
    { stdout: io.stdout, stdin: io.stdin, exitOnCtrlC: false, patchConsole: false },
  )
  await settle()
  const frame = instance.lastFrame()
  instance.unmount?.()
  await settle(50)
  return oneLine(frame)
}

async function paintChat(messages: Raw[], columns: number, rowCount = 51): Promise<string[]> {
  const normalized = normalizeMessages([...(messages as never[])])
  const lookups = buildMessageLookups(normalized, [...(messages as never[])])
  const io = fakeIo(columns, rowCount)
  const body = h(
    Box as never,
    { flexDirection: 'column' },
    ...normalized.map(message =>
      h(Message as never, {
        key: message.uuid,
        message,
        messages: normalized,
        tools: [],
        commands: [],
        verbose: false,
        addMargin: false,
        shouldAnimate: false,
        shouldShowDot: false,
        isTranscriptMode: false,
        isStatic: true,
        inProgressToolUseIDs: new Set<string>(),
        progressMessagesForMessage: [],
        lookups,
        width: columns,
      }),
    ),
  )
  const instance = await render(h(AppStateProvider as never, { initialState: getDefaultAppState() }, body), { stdout: io.stdout, stdin: io.stdin, exitOnCtrlC: false, patchConsole: false })
  instance.unmount()
  await instance.waitUntilExit()
  return strip(instance.lastFrame()).split('\n').map(line => line.trimEnd()).filter(line => line.trim() !== '')
}

const userRow = (text: string, uuid: string, at: string, origin?: Raw): Raw => ({ ...createUserMessage({ content: text, uuid: uuid as never, ...(origin !== undefined ? { origin: origin as never } : {}) }), timestamp: at })
const replyRow = (at: string): Raw => ({ ...createAssistantMessage({ content: REPLY }), timestamp: at })
const U1 = 'a5b6c7d8-0000-4000-8000-000000000010'
const U2 = 'a5b6c7d8-0000-4000-8000-000000000011'
const U3 = 'a5b6c7d8-0000-4000-8000-000000000012'
const U4 = 'a5b6c7d8-0000-4000-8000-000000000013'
const U5 = 'a5b6c7d8-0000-4000-8000-000000000014'
const U6 = 'a5b6c7d8-0000-4000-8000-000000000015'
const SLASH_WORDS = '/no-such-words-here stand as words'
const RUNNER = readFileSync(join(ROOT, 'src/cli/print.ts'), 'utf8')

function sinkFlagsOfRunner(): Raw {
  const sinkAt = RUNNER.indexOf('const deliverLocalWake = ')
  const enqueueAt = sinkAt >= 0 ? RUNNER.indexOf('enqueue({', sinkAt) : -1
  const block = enqueueAt >= 0 ? RUNNER.slice(enqueueAt, RUNNER.indexOf('})', enqueueAt)) : ''
  const flags: Raw = {}
  for (const [, key, value] of block.matchAll(/^\s*(\w+): ([^,\n]+),?$/gm)) {
    if (value === 'true') flags[key!] = true
    else if (/^'[^']*'$/.test(value!)) flags[key!] = value!.slice(1, -1)
  }
  return flags
}

function forwardedByTurnRoad(): { isMeta: boolean; origin: boolean; skipSlashCommands: boolean } {
  const askAt = RUNNER.indexOf('for await (const message of ask({')
  const block = askAt >= 0 ? RUNNER.slice(askAt, RUNNER.indexOf('cwd: getCwd()', askAt)) : ''
  return { isMeta: block.includes('isMeta: command.isMeta'), origin: block.includes('command.origin'), skipSlashCommands: block.includes('command.skipSlashCommands') }
}

function askOptionsOf(command: Raw): Raw {
  const forwarded = forwardedByTurnRoad()
  return {
    ...(forwarded.isMeta ? { isMeta: command.isMeta } : {}),
    ...(forwarded.origin && command.origin !== undefined ? { origin: command.origin } : {}),
    ...(forwarded.skipSlashCommands && command.skipSlashCommands === true ? { skipSlashCommands: true } : {}),
  }
}

function sinkSpreadsStamp(): boolean {
  const sinkAt = RUNNER.indexOf('const deliverLocalWake = ')
  return sinkAt >= 0 && RUNNER.slice(sinkAt, RUNNER.indexOf('driver.kick()', sinkAt)).includes('...saturnQueueStamp(next.origin)')
}

function seatlessWakeCommand(value: string, uuid: string): Raw {
  const step = localWakeStep({ closed: false }, Date.parse(ROW_AT), FIRED_AT, undefined, { spelling: 'in ~900s', reason: REASON })
  const origin = step.step === 'deliver' ? step.origin : undefined
  return { value, uuid, ...sinkFlagsOfRunner(), ...(sinkSpreadsStamp() ? (rows.saturnQueueStamp as (origin: unknown) => Raw)(origin) : { origin }) }
}

function seatedFireCommand(value: string, uuid: string): Raw {
  return { value, mode: 'prompt', sentAt: ROW_AT, uuid, priority: 'later', origin: cronOrigin() }
}

const visibleRows = (messages: Raw[]): Raw[] => messages.filter(message => message.type !== 'user' || shouldShowUserMessage(message as never, false))

function journalLines(): string[] {
  const lines: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (name.endsWith('.jsonl')) lines.push(...readFileSync(path, 'utf8').split('\n'))
    }
  }
  try {
    walk(join(process.env.MERCURY_CONFIG_DIR!, 'projects'))
  } catch {
    return []
  }
  return lines
}

async function carriedAcrossRestart(): Promise<Raw[]> {
  queue.resetCommandQueue()
  queue.enqueue({ value: OPERATOR_LINE, mode: 'prompt', uuid: U1 as never, sentAt: ROW_AT })
  queue.enqueue({ value: WAKE_TEXT, mode: 'prompt', uuid: U4 as never, priority: 'later', sentAt: ROW_AT, origin: wakeOrigin() as never })
  await recordTranscript([createUserMessage({ content: 'a real message materializes the file' })])
  const deadline = Date.now() + 5000
  let lines: string[] = []
  while (Date.now() < deadline) {
    lines = journalLines()
    if (queueLogRows(lines).filter(row => row.operation === 'enqueue').length >= 2) break
    await settle(100)
  }
  queue.resetCommandQueue()
  requeueUndeliveredLines(lines)
  const carried = queue.getCommandQueue().map(command => ({ ...command })) as Raw[]
  queue.resetCommandQueue()
  return carried
}

function turnContext(): Raw {
  const appState: Raw = {
    toolPermissionContext: { mode: 'default', additionalWorkingDirectories: new Map(), alwaysAllowRules: {}, alwaysDenyRules: {} },
    sessionHooks: new Map(),
    tasks: {},
    mcp: { clients: [], tools: [], commands: [], resources: {} },
    todos: {},
  }
  return {
    options: { commands: [], tools: [], mcpClients: [], isNonInteractiveSession: true },
    getAppState: () => appState,
    setAppState: (f: (prev: Raw) => Raw): void => {
      Object.assign(appState, f(appState))
    },
    messages: [],
    abortController: new AbortController(),
    readFileState: new Map(),
    setToolJSX: () => {},
  }
}

async function batchedTurn(head: string, tail: string, tailOrigin: Raw): Promise<Raw[]> {
  const out = await processUserInput({
    input: head,
    mode: 'prompt',
    setToolJSX: () => {},
    context: turnContext() as never,
    messages: [],
    querySource: 'sdk',
    uuid: U1,
    skipAttachments: true,
    batchUuids: [U1, U2],
    batchTail: [{ value: tail, uuid: U2 as never, origin: tailOrigin as never }],
  })
  return (out.messages as Raw[]).filter(m => m.type === 'user').map(m => ({ ...m, timestamp: ROW_AT }))
}

async function drainedTurn(command: Raw): Promise<{ shouldQuery: boolean; row: Raw | undefined; text: string }> {
  try {
    const out = await processUserInput({
      input: command.value as string,
      mode: command.mode as never,
      setToolJSX: () => {},
      context: turnContext() as never,
      messages: [],
      querySource: 'sdk',
      uuid: command.uuid as never,
      skipAttachments: true,
      ...askOptionsOf(command),
    } as never)
    const row = (out.messages as Raw[]).find(m => m.type === 'user' && m.uuid === command.uuid)
    const text = (out.messages as Raw[]).filter(m => m.type === 'user').map(m => String((m.message as Raw).content)).join(' | ')
    return { shouldQuery: out.shouldQuery, row: row === undefined ? undefined : { ...row, timestamp: ROW_AT }, text: out.resultText === undefined ? text : String(out.resultText) }
  } catch (error) {
    return { shouldQuery: false, row: undefined, text: String(error) }
  }
}

const rowShape = (row: Raw | undefined): string => JSON.stringify(row === undefined ? null : { ...row, uuid: null, timestamp: null, origin: null, message: { ...(row.message as Raw), content: null } })

section('§0 the words: the first line the schedule composes from its own facts')
try {
  check("the plate name is Saturn, one home", attachedPlateName('saturn' as never) === 'Saturn' && rows.SATURN_PLATE_NAME === 'Saturn')
  check('a 900 s wake reads fifteen-minute cadence', rows.cadenceWords(900) === 'fifteen-minute cadence')
  check('a 120 s wake reads two-minute cadence, 1800 s thirty-minute, 3600 s sixty-minute', rows.cadenceWords(120) === 'two-minute cadence' && rows.cadenceWords(1800) === 'thirty-minute cadence' && rows.cadenceWords(3600) === 'sixty-minute cadence')
  check('a 25-minute wake reads with digits, a 90 s wake in seconds', rows.cadenceWords(1500) === '25-minute cadence' && rows.cadenceWords(90) === '90-second cadence')
  check("the wake's own spelling round-trips", rows.wakeDelaySpelling(900) === 'in ~900s' && rows.wakeDelayOfSpelling('in ~900s') === 900 && rows.wakeDelayOfSpelling(CRON_SPELLING) === null && rows.wakeDelayOfSpelling(undefined) === null)
  const wakeLine = rows.saturnFirstLine(wakeOrigin(), ROW_AT)
  check('a self-paced wake: the word, the cadence, the reason', wakeLine === `self-paced wake · fifteen-minute cadence · reason: ${REASON}`, wakeLine)
  const bare = rows.saturnFirstLine(wakeOrigin({ reason: undefined, spelling: undefined }), ROW_AT)
  check('a wake with no reason and no spelling is the word alone', bare === 'self-paced wake', bare)
  const cronLine = rows.saturnFirstLine(cronOrigin(), ROW_AT)
  check("a cron fire without a title: the schedule's id and its own spelling, lowercased into the line", cronLine === `schedule ${CRON_ID} · every weekday at 09:00`, cronLine)
  const titledLine = rows.saturnFirstLine(titledOrigin(), ROW_AT)
  check("a cron fire with a title: the title in place of the id, then the schedule's own spelling (red on the base: the id)", titledLine === `${TITLE} · every weekday at 09:00`, titledLine)
  const blankTitle = rows.saturnFirstLine(titledOrigin({ title: '   ' }), ROW_AT)
  check('a blank title falls back to the id', blankTitle === `schedule ${CRON_ID} · every weekday at 09:00`, blankTitle)
  const titledWake = rows.saturnFirstLine(wakeOrigin({ title: TITLE }), ROW_AT)
  check('a self-paced wake keeps its own word whatever a title says', titledWake.startsWith('self-paced wake · '), titledWake)
  const late = rows.saturnFirstLine(wakeOrigin(), LATE_ROW_AT)
  check('delivery a minute or more after the fire names the fire time on the row', late.endsWith(` · fired ${clock(FIRED_AT)}`), late)
  const prompt = rows.saturnFirstLine(wakeOrigin(), ROW_AT)
  check('delivery within the minute names no second time', !prompt.includes('fired'), prompt)
  const held = rows.saturnFirstLine(wakeOrigin({ heldSince: HELD_SINCE, heldWhy: 'window' }), LATE_ROW_AT)
  check('a wake that waited says since when and why, the wait standing in for the fire clause', held.endsWith(`reason: ${REASON} · held since ${clock(HELD_SINCE)} · the usage window was closed`) && !held.includes('fired'), held)
  const parked = rows.saturnFirstLine(cronOrigin({ heldSince: HELD_SINCE, heldWhy: 'parked' }), ROW_AT)
  check('a fire held for a parked session says so', parked.endsWith(`held since ${clock(HELD_SINCE)} · the session was parked`), parked)
  check("the prompt's own words drop the reason line and keep the rest", JSON.stringify(rows.saturnPromptLines(WAKE_TEXT)) === JSON.stringify([WAKE_BODY]), JSON.stringify(rows.saturnPromptLines(WAKE_TEXT)))
  check('a prompt without the reason line is kept whole', JSON.stringify(rows.saturnPromptLines(CRON_BODY)) === JSON.stringify([CRON_BODY]))
  check('the guard admits a saturn origin and refuses the others', rows.isSaturnOrigin(wakeOrigin()) && rows.isSaturnOrigin(cronOrigin()) && rows.isSaturnOrigin(titledOrigin()) && !rows.isSaturnOrigin({ kind: 'channel', server: 'x' }) && !rows.isSaturnOrigin(undefined) && !rows.isSaturnOrigin({ kind: 'saturn' }))
  const plate = rows.noticePlate({ kind: 'saturn', origin: wakeOrigin(), lines: [] } as never, ROW_AT)
  check('the notice plate of a saturn block opens with the Saturn name', plate === `[Saturn] · self-paced wake · fifteen-minute cadence · reason: ${REASON}`, plate)
  check("the held rows' plates are untouched", rows.noticePlate({ kind: 'notice', lines: [] } as never) === 'notice' && rows.noticePlate({ kind: 'monitor', taskId: 't', name: 'the build watch', lines: [] } as never) === 'monitor · the build watch')
} catch (error) {
  check('the Saturn word home stands (saturnFirstLine, cadenceWords, saturnPromptLines, isSaturnOrigin)', false, String(error))
}

section("§1 the row: a wake's row with the saturn origin paints the muted Saturn row, never the operator's line; a titled cron fire reads its title")
for (const [columns] of SIZES) {
  const frame = await paintText({ param: { type: 'text', text: WAKE_TEXT }, origin: wakeOrigin() }, { type: 'user', timestamp: ROW_AT }, columns)
  check(`${columns} columns: the clock stays, then the dim [Saturn] plate and the schedule's own words`, frame.includes(`${clock(ROW_AT)} ${SATURN} · self-paced wake · fifteen-minute cadence · reason: ${REASON}`), frame.slice(0, 260))
  check(`${columns} columns: no accent dot on the row`, !frame.includes(DOT), frame.slice(0, 200))
  check(`${columns} columns: the operator's handle and caret are nowhere on it`, !frame.includes(HANDLE) && !frame.includes(CARET), frame.slice(0, 200))
  check(`${columns} columns: the prompt's own words stand beneath, without the reason line`, frame.includes(WAKE_BODY) && !frame.includes('[self-paced wake — why you woke'), frame.slice(0, 300))
  const titled = await paintText({ param: { type: 'text', text: CRON_BODY }, origin: titledOrigin() }, { type: 'user', timestamp: ROW_AT }, columns)
  check(`${columns} columns: a cron fire with a title paints the Saturn plate, the title, the spelling, the prompt dim beneath (red on the base: the id)`, titled.includes(`${clock(ROW_AT)} ${SATURN} · ${TITLE} · every weekday at 09:00`) && titled.includes(CRON_BODY) && !titled.includes(HANDLE) && !titled.includes(DOT) && !titled.includes(`schedule ${CRON_ID}`), titled.slice(0, 260))
}
{
  const cron = await paintText({ param: { type: 'text', text: CRON_BODY }, origin: cronOrigin() }, { type: 'user', timestamp: ROW_AT })
  check("a cron fire without a title: the same plate, the schedule's id and spelling on the first line, the prompt dim beneath", cron.includes(`${clock(ROW_AT)} ${SATURN} · schedule ${CRON_ID} · every weekday at 09:00`) && cron.includes(CRON_BODY) && !cron.includes(HANDLE) && !cron.includes(DOT), cron.slice(0, 260))
  const late = await paintText({ param: { type: 'text', text: WAKE_TEXT }, origin: wakeOrigin() }, { type: 'user', timestamp: LATE_ROW_AT })
  check('a wake delivered later keeps its delivery stamp and names the fire time on the first line', late.startsWith(`${clock(LATE_ROW_AT)} ${SATURN}`) && late.includes(` · fired ${clock(FIRED_AT)}`), late.slice(0, 260))
  const held = await paintText({ param: { type: 'text', text: WAKE_TEXT }, origin: wakeOrigin({ heldSince: HELD_SINCE, heldWhy: 'window' }) }, { type: 'user', timestamp: LATE_ROW_AT })
  check('a wake that met a closed usage window says so in the same row', held.includes(`held since ${clock(HELD_SINCE)} · the usage window was closed`), held.slice(0, 300))
  const record = entryToRecord(
    { type: 'user', message: { role: 'user', content: CRON_BODY }, uuid: 'a5b6c7d8-0000-4000-8000-000000000001', timestamp: ROW_AT, origin: titledOrigin() },
    { sessionId: 'sess-saturn' as never, nextOrdinal: () => 1 as never, observedAt: ROW_AT, source: { channel: 'sdk' } as never },
  )
  const restored = recordToEntry(record) as Raw
  check('the transcript keeps the origin whole through the codec, the title with it', JSON.stringify(restored.origin) === JSON.stringify(titledOrigin()) && (restored.message as Raw).content === CRON_BODY, JSON.stringify(restored.origin))
  const resumed = await paintText({ param: { type: 'text', text: String((restored.message as Raw).content) }, origin: restored.origin }, { type: 'user', timestamp: String(restored.timestamp) })
  const fresh = await paintText({ param: { type: 'text', text: CRON_BODY }, origin: titledOrigin() }, { type: 'user', timestamp: ROW_AT })
  check('a resumed record paints the same Saturn row as the live one', resumed === fresh && resumed.includes(`${SATURN} · ${TITLE}`), resumed.slice(0, 200))
  const stray = await paintText({ param: { type: 'text', text: OPERATOR_LINE }, origin: { kind: 'channel', server: 'x' } }, { type: 'user', timestamp: ROW_AT })
  check('another origin is not plated Saturn', !stray.includes(SATURN), stray.slice(0, 120))
}

section("§2 the neighbours are byte-identical (a guard, green on both trees): the operator's line, Mercury's reply, the held rows")
{
  const line = await paintText({ param: { type: 'text', text: OPERATOR_LINE } }, { type: 'user', timestamp: ROW_AT })
  check("the operator's typed line keeps the handle and the caret exactly", line === `${clock(ROW_AT)} ${HANDLE} ${CARET} ${OPERATOR_LINE}`, line)
  const notice = await paintText({ param: { type: 'text', text: 'Stop hook blocking error from command "lint": 3 errors' }, notice: true }, { type: 'user', timestamp: ROW_AT })
  check("a held notice keeps its dot and its plate exactly", notice === `${clock(ROW_AT)} ${DOT} notice Stop hook blocking error from command "lint": 3 errors`, notice)
  const monitor = await paintText({ param: { type: 'text', text: '<monitor task="bk1" name="the build watch">\nbuilt\n</monitor>' } }, { type: 'user', timestamp: ROW_AT })
  check('a monitor notice keeps its dot and its watch exactly', monitor === `${clock(ROW_AT)} ${DOT} monitor · the build watch built`, monitor)
  const completed = await paintText({ param: { type: 'text', text: 'the saved work is ready' }, notice: true, noticeSentAt: HELD_SINCE }, { type: 'user', timestamp: ROW_AT })
  check('a notice delivered later keeps its completed clock exactly', completed === `${clock(ROW_AT)} ${DOT} notice · completed ${clock(HELD_SINCE)} the saved work is ready`, completed)
}
for (const [columns, rowCount] of SIZES) {
  const frame = await paintChat([userRow(OPERATOR_LINE, U1, ROW_AT), replyRow(LATE_ROW_AT)], columns, rowCount)
  const operatorRows = frame.filter(l => l === `${clock(ROW_AT)} ${HANDLE} ${CARET} ${OPERATOR_LINE}`)
  check(`${columns} columns: the chat around the row paints the operator's line once, handle and caret as today, and the reply beneath it without a handle`, operatorRows.length === 1 && frame.some(l => l.includes(REPLY) && !l.includes(HANDLE)), frame.join('\n'))
  check(`${columns} columns: no Saturn plate where no origin says so`, !frame.some(l => l.includes(SATURN)), frame.join('\n'))
}

section("§3 THE BATCHED WAKE (red on the base): a fire taken into the operator's turn keeps its own origin, so its row is the Saturn row, never the operator's line")
{
  const turn = await batchedTurn(OPERATOR_LINE, WAKE_TEXT, wakeOrigin())
  const tail = turn.find(m => m.uuid === U2)
  check('the batch keeps one row per prompt under its own identity', turn.length === 2 && turn[0]!.uuid === U1 && tail !== undefined, JSON.stringify(turn.map(m => m.uuid)))
  check("the head, the operator's words, carries no origin", turn[0]!.origin === undefined, JSON.stringify(turn[0]!.origin))
  check("the tail, the wake, keeps the saturn origin it was queued with (red on the base: the batch strips it)", tail !== undefined && JSON.stringify(tail.origin) === JSON.stringify(wakeOrigin()), JSON.stringify(tail?.origin))
  for (const [columns, rowCount] of SIZES) {
    const frame = await paintChat([...turn, replyRow(LATE_ROW_AT)], columns, rowCount)
    const operatorRows = frame.filter(l => l.includes(`${HANDLE} ${CARET}`))
    check(`${columns} columns: the operator's line paints once with the handle, and the wake beneath it paints the Saturn row (red on the base: "${HANDLE} ${CARET} [self-paced wake — …]")`, operatorRows.length === 1 && operatorRows[0]!.includes(OPERATOR_LINE) && frame.some(l => l.includes(`${SATURN} · self-paced wake · fifteen-minute cadence`)) && !frame.some(l => l.includes('[self-paced wake — why you woke')), frame.join('\n'))
  }
  const runner = readFileSync(join(ROOT, 'src/cli/print.ts'), 'utf8')
  const at = runner.indexOf('const batchTail: BatchedPrompt[] =')
  const block = at >= 0 ? runner.slice(at, runner.indexOf(': []', at)) : ''
  check("the runner's batch tail carries each member's origin beside its words and identity (red on the base: value and uuid alone)", block.includes('member.origin') && block.includes('member.uuid') && block.includes('member.value'), block)
}

section('§4 the title crosses the daemon frame and the tools (red on the base: the validator drops it, the list never shows it)')
{
  const submission = { when: { kind: 'every', cron: '0 9 * * 1-5', spelling: CRON_SPELLING }, action: { kind: 'fire', prompt: CRON_BODY }, title: TITLE }
  const kept = saturn.validateSaturnSubmission(submission)
  check('a submission with a title keeps it through the validator, cleaned as a name', kept.ok && (kept as { submission: Raw }).submission.title === TITLE, JSON.stringify(kept))
  const folded = saturn.validateSaturnSubmission({ ...submission, title: '  morning\n  brief\t ' })
  check('a title spanning lines folds to one line, trimmed', folded.ok && (kept as { submission: Raw }).submission.title === TITLE && (folded as { submission: Raw }).submission.title === TITLE, JSON.stringify(folded))
  const none = saturn.validateSaturnSubmission({ when: submission.when, action: submission.action })
  check('a submission without a title stores none', none.ok && !('title' in (none as { submission: Raw }).submission), JSON.stringify(none))
  const long = saturn.validateSaturnSubmission({ ...submission, title: 'x'.repeat(saturn.SATURN_TITLE_CAP + 1) })
  check('an over-long title refuses typed, naming the shape', !long.ok && (long as { reason: string }).reason.includes(saturn.SATURN_TITLE_SHAPE), JSON.stringify(long))
  const secret = saturn.validateSaturnSubmission({ ...submission, title: 'brief AKIAIOSFODNN7EXAMPLE wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' })
  check('a secret-bearing title refuses typed without echoing the bytes', !secret.ok && (secret as { reason: string }).reason.includes('title') && (secret as { reason: string }).reason.includes('secret') && !(secret as { reason: string }).reason.includes('AKIA'), JSON.stringify(secret))
  const facts = saturn.saturnFactsOf({ schedules: [{ schema: 1, id: CRON_ID, when: submission.when, action: submission.action, account: { family: 'anthropic', source: 'oauth' }, modelKey: 'm', createdAt: 1, createdBy: 'operator:test', title: TITLE }] } as never, Date.parse(ROW_AT))
  check('the facts row the daemon pushes carries the title', facts.schedules?.[0]?.title === TITLE, JSON.stringify(facts))
  const listed = CronListTool.mapToolResultToToolResultBlockParam({ rosterKnown: true, schedules: [{ id: CRON_ID, when: CRON_SPELLING, kind: 'fire', nextFireMs: null, paused: true, title: TITLE }, { id: '0badcafe', when: 'Every 5 minutes', kind: 'fire', nextFireMs: null }] } as never, 'tu-1')
  const listText = String((listed as { content: string }).content)
  check("the list's row names the title beside the id, and a row without one reads as before", listText.includes(`${CRON_ID} · ${TITLE}: ${CRON_SPELLING} (fire) — paused`) && listText.includes('0badcafe: Every 5 minutes (fire) — no future fire'), listText)
  const schema = CronCreateTool.inputSchema as { shape?: Record<string, { description?: string }> }
  check("the create tool's strict input takes an optional title", schema.shape !== undefined && 'title' in schema.shape, JSON.stringify(Object.keys(schema.shape ?? {})))
  check("the title field's words name the shape the daemon holds", schema.shape?.title?.description?.includes(saturn.SATURN_TITLE_SHAPE) === true, JSON.stringify(schema.shape?.title?.description))
  const refused = await CronCreateTool.validateInput!({ cron: '0 9 * * 1-5', prompt: CRON_BODY, title: 'x'.repeat(saturn.SATURN_TITLE_CAP + 1) } as never, {} as never)
  check('the tool refuses an over-long title where the model hears it', refused.result === false && String((refused as { message?: string }).message).includes(saturn.SATURN_TITLE_SHAPE), JSON.stringify(refused))
  const fine = await CronCreateTool.validateInput!({ cron: '0 9 * * 1-5', prompt: CRON_BODY, title: TITLE } as never, {} as never)
  check('a fine title passes', fine.result === true, JSON.stringify(fine))
}

section("§5 THE RESTART CARRY (red on the base): a wake re-queued from the journal after the runner died keeps its origin, so its row is the Saturn row, never the operator's line")
const carried = await carriedAcrossRestart()
{
  const wake = carried.find(c => c.uuid === U4)
  const words = carried.find(c => c.uuid === U1)
  check('the journal replays both undelivered lines under their own identities, the words and the wake', carried.length === 2 && words !== undefined && wake !== undefined && wake.value === WAKE_TEXT, JSON.stringify(carried.map(c => c.uuid)))
  check("the operator's re-queued line carries no origin", words !== undefined && words.origin === undefined, JSON.stringify(words?.origin))
  check('the re-queued wake carries the saturn origin it was queued with (red on the base: the journal row has none and the re-queue restores none)', wake !== undefined && JSON.stringify(wake.origin) === JSON.stringify(wakeOrigin()), JSON.stringify(wake?.origin))
  const rows = queueLogRows(journalLines()).filter(row => row.operation === 'enqueue')
  check('the journal row the writer wrote carries the origin, and the reader hands it on', rows.some(row => row.uuid === U4 && JSON.stringify(row.origin) === JSON.stringify(wakeOrigin())) && rows.some(row => row.uuid === U1 && row.origin === undefined), JSON.stringify(rows.map(row => [row.uuid, row.origin])))
  check('a journal row with a foreign origin is handed on without one', undeliveredLines(queueLogRows([JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: ROW_AT, sessionId: 's', content: 'x', commandUuid: U2, mode: 'prompt', origin: { kind: 'channel', server: 'x' } })]))[0]?.origin === undefined)
  for (const [columns, rowCount] of SIZES) {
    const frame = await paintChat([userRow(WAKE_TEXT, U4, ROW_AT, wake?.origin as Raw | undefined), replyRow(LATE_ROW_AT)], columns, rowCount)
    check(`${columns} columns: the carried wake paints the Saturn row (red on the base: "${HANDLE} ${CARET} [self-paced wake — …]")`, frame.some(l => l.includes(`${SATURN} · self-paced wake · fifteen-minute cadence`)) && !frame.some(l => l.includes(HANDLE)), frame.join('\n'))
  }
}

section("§6 THE SEATLESS WAKE (red on the base): the bare run's own sink queues its fire as a row the chat shows — the Saturn row, never a hidden meta row — and the wake stays out of history and out of the command parser")
const seatlessTurn = await drainedTurn(seatlessWakeCommand(WAKE_TEXT, U5))
const seatedTurn = await drainedTurn(seatedFireCommand(CRON_BODY, U6))
{
  const flags = sinkFlagsOfRunner()
  check('the sink queues the wake as words for the model, never as a meta row: no isMeta, skipSlashCommands (red on the base: isMeta: true)', flags.isMeta === undefined && flags.skipSlashCommands === true && flags.mode === 'prompt' && flags.priority === 'later', JSON.stringify(flags))
  const forwarded = forwardedByTurnRoad()
  check('the turn road hands skipSlashCommands to the engine beside isMeta and the origin (red on the base: isMeta and the origin alone)', forwarded.isMeta && forwarded.origin && forwarded.skipSlashCommands, JSON.stringify(forwarded))
  queue.resetCommandQueue()
  queue.enqueue(seatlessWakeCommand(WAKE_TEXT, U5) as never)
  queue.enqueue(seatlessWakeCommand(SLASH_WORDS, U6) as never)
  const [queued, slashLed] = queue.getCommandQueue() as Raw[]
  check('the queue holds the wake with its origin, at later, under the cron workload', queued !== undefined && JSON.stringify(queued.origin) === JSON.stringify(wakeOrigin()) && queued.priority === 'later' && queued.workload === 'cron', JSON.stringify(queued))
  check('the queue reads a slash-led wake as words for the model, not a command (red on the base: a slash command)', slashLed !== undefined && !queue.isSlashCommand(slashLed as never), JSON.stringify(slashLed))
  check('the wake earns no history entry, with or without the hide: the origin alone keeps it out (green on both trees)', queuedCommandHistoryEntry(queued as never) === null && queuedCommandHistoryEntry({ value: WAKE_TEXT, mode: 'prompt', origin: wakeOrigin() }) === null)
  check("the operator's own queued line still earns its entry (a guard)", queuedCommandHistoryEntry({ value: OPERATOR_LINE, mode: 'prompt' })?.display === OPERATOR_LINE)
  queue.resetCommandQueue()
  const row = seatlessTurn.row
  check('the drained wake is one user row under its own identity, asking to query, with the origin on it', seatlessTurn.shouldQuery && row !== undefined && JSON.stringify(row.origin) === JSON.stringify(wakeOrigin()), seatlessTurn.text)
  check('the stored row is a row the chat shows (red on the base: hidden under isMeta)', row !== undefined && visibleRows([row]).length === 1 && row.isMeta !== true, JSON.stringify(row))
  check("the stored row is byte-identical to the seated road's fire apart from its identity, its clock and its origin's own facts (red on the base: isMeta on the seatless row alone)", row !== undefined && seatedTurn.row !== undefined && rowShape(row) === rowShape(seatedTurn.row), `${rowShape(row)} vs ${rowShape(seatedTurn.row)}`)
  for (const [columns, rowCount] of SIZES) {
    const frame = await paintChat(visibleRows([...(row === undefined ? [] : [row]), replyRow(LATE_ROW_AT)]), columns, rowCount)
    const seated = await paintChat([userRow(WAKE_TEXT, U1, ROW_AT, wakeOrigin()), replyRow(LATE_ROW_AT)], columns, rowCount)
    check(`${columns} columns: the chat admits the seatless wake's row and paints the Saturn row above the reply, line for line the seated road's frame (red on the base: the frame holds the reply alone)`, frame.length > 1 && frame[0]!.startsWith(`${clock(ROW_AT)} ${SATURN} · self-paced wake · fifteen-minute cadence`) && oneLine(frame.join(' ')).includes(WAKE_BODY) && !frame.some(l => l.includes(HANDLE)) && frame.join('\n') === seated.join('\n'), `${frame.length} row(s):\n${frame.join('\n')}`)
  }
  const slashTurn = await drainedTurn(seatlessWakeCommand(SLASH_WORDS, U6))
  check('a wake whose words begin with a slash reaches the model as words (red on the base: parsed as a command)', slashTurn.shouldQuery && slashTurn.row !== undefined && (slashTurn.row.message as Raw).content === SLASH_WORDS, `shouldQuery=${slashTurn.shouldQuery}: ${slashTurn.text}`)
  if (row !== undefined) {
    const record = entryToRecord(row as never, { sessionId: 'sess-saturn' as never, nextOrdinal: () => 2 as never, observedAt: ROW_AT, source: { channel: 'sdk' } as never })
    const restored = recordToEntry(record) as Raw
    check('a resumed transcript shows the row (red on the base: the record keeps the hide)', visibleRows([restored]).length === 1 && JSON.stringify(restored.origin) === JSON.stringify(wakeOrigin()), JSON.stringify(restored))
    const resumed = await paintText({ param: { type: 'text', text: String((restored.message as Raw).content) }, origin: restored.origin }, { type: 'user', timestamp: String(restored.timestamp) })
    const live = await paintText({ param: { type: 'text', text: WAKE_TEXT }, origin: row.origin }, { type: 'user', timestamp: ROW_AT })
    check('the resumed row paints the same Saturn row as the live one', resumed === live && resumed.includes(`${SATURN} · self-paced wake`), resumed.slice(0, 200))
  }
}

if (frameDir !== null) {
  section(`frames → ${frameDir}`)
  mkdirSync(frameDir, { recursive: true })
  const scenes: Array<[string, string, Raw[]]> = [
    ['wake', "a self-paced wake's fire, then Mercury's reply", [userRow(WAKE_TEXT, U1, ROW_AT, wakeOrigin()), replyRow(LATE_ROW_AT)]],
    ['cron-title', "a cron schedule with a title fires, Mercury replies, the operator answers", [userRow(CRON_BODY, U1, ROW_AT, titledOrigin()), replyRow(LATE_ROW_AT), userRow(OPERATOR_LINE, U3, LATE_ROW_AT)]],
    ['cron-id', 'the same cron fire when the schedule was given no title', [userRow(CRON_BODY, U1, ROW_AT, cronOrigin()), replyRow(LATE_ROW_AT)]],
    ['batched-wake', "the operator's queued line and a wake taken into one turn, then Mercury's reply", [...(await batchedTurn(OPERATOR_LINE, WAKE_TEXT, wakeOrigin())), replyRow(LATE_ROW_AT)]],
    ['restart-carry', "a wake re-queued from the journal after the runner died, then Mercury's reply", [userRow(WAKE_TEXT, U4, ROW_AT, carried.find(c => c.uuid === U4)?.origin as Raw | undefined), replyRow(LATE_ROW_AT)]],
    ['seatless-wake', "a bare run's own wake as the chat's hide admits it, then Mercury's reply", visibleRows([...(seatlessTurn.row === undefined ? [] : [seatlessTurn.row]), replyRow(LATE_ROW_AT)])],
  ]
  const index: string[] = ['the Saturn row frames — the chat rows as the product paints them, transcript rows only, at the named width', '']
  for (const [name, words, messages] of scenes) {
    for (const [columns, rowCount] of SIZES) {
      const frame = await paintChat(messages, columns, rowCount)
      const file = `${name}-${columns}x${rowCount}.txt`
      writeFileSync(join(frameDir, file), `${frame.join('\n')}\n`)
      index.push(`${file} — ${words}`)
      console.log(`  wrote ${file}`)
    }
  }
  writeFileSync(join(frameDir, 'index.txt'), `${index.join('\n')}\n`)
}

console.log(`\n${failures === 0 ? '✅' : '❌'} saturn row: ${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
