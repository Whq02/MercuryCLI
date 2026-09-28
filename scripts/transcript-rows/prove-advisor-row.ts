#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'advisor-row-home-'))
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
const { shouldShowUserMessage } = await import(join(ROOT, 'src/utils/messages/systemMessages.ts'))
const { queuedCommandHistoryEntry } = await import(join(ROOT, 'src/history.ts'))
const queue = await import(join(ROOT, 'src/input-core/command-queue.ts'))
const rows = await import(join(ROOT, 'src/utils/messages/noticeRows.ts'))
const text = await import(join(ROOT, 'src/utils/messages/text.ts'))
const advisor = await import(join(ROOT, 'src/services/advisor/index.ts'))
const figures = (await import('figures')).default

type Raw = Record<string, unknown>
const h = React.createElement as (...a: unknown[]) => React.ReactElement
const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
const settle = (ms = 200): Promise<void> => new Promise(r => setTimeout(r, ms))
const oneLine = (s: string): string => strip(s).replace(/\s+/g, ' ').trim()
const HANDLE = '[sam]'
const PLATE = '[advisor]'
const DOT = '●'
const CARET = figures.pointer
const MODEL = 'claude-opus-4-8'
const NOTE_AT = '2026-06-19T09:00:00.000Z'
const ROW_AT = '2026-06-19T09:00:04.000Z'
const LATER = '2026-06-19T09:03:10.000Z'
const clock = (iso: string): string => formatClock(iso)!
const NOTE = 'You have not run the pin on the base yet.\nRun it on 89017923b before you edit, and keep what it prints.'
const OPERATOR_LINE = 'take the first two as my defaults'
const REPLY = 'Running the pin on the base now.'
const advisorOrigin = (extra: Raw = {}): Raw => ({ kind: 'advisor', model: MODEL, seats: 5, at: NOTE_AT, ...extra })
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

const userRow = (words: string, uuid: string, at: string, origin?: Raw): Raw => ({ ...createUserMessage({ content: words, uuid: uuid as never, ...(origin !== undefined ? { origin: origin as never } : {}) }), timestamp: at })
const replyRow = (at: string): Raw => ({ ...createAssistantMessage({ content: REPLY }), timestamp: at })
const U1 = 'a5b6c7d8-0000-4000-8000-000000000031'
const U2 = 'a5b6c7d8-0000-4000-8000-000000000032'
const U3 = 'a5b6c7d8-0000-4000-8000-000000000033'
const visibleRows = (messages: Raw[]): Raw[] => messages.filter(message => message.type !== 'user' || shouldShowUserMessage(message as never, false))

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
  const out = await processUserInput({
    input: command.value as string,
    mode: command.mode as never,
    setToolJSX: () => {},
    context: turnContext() as never,
    messages: [],
    querySource: 'sdk',
    uuid: command.uuid as never,
    skipAttachments: true,
    isMeta: command.isMeta,
    ...(command.origin !== undefined ? { origin: command.origin } : {}),
    ...(command.skipSlashCommands === true ? { skipSlashCommands: true } : {}),
  } as never)
  const row = (out.messages as Raw[]).find(m => m.type === 'user' && m.uuid === command.uuid)
  const all = (out.messages as Raw[]).filter(m => m.type === 'user').map(m => String((m.message as Raw).content)).join(' | ')
  return { shouldQuery: out.shouldQuery, row: row === undefined ? undefined : { ...row, timestamp: ROW_AT }, text: out.resultText === undefined ? all : String(out.resultText) }
}

section('§0 the words: the plate, the first line, the guard, the note stripped of its mid-turn framing')
{
  check('the plate name is advisor, lowercase, one home', rows.ADVISOR_PLATE_NAME === 'advisor' && attachedPlateName('advisor' as never) === 'advisor')
  const line = rows.advisorFirstLine(advisorOrigin() as never)
  check('the first line: the model and the cadence', line === `${MODEL} · every 5 turns`, line)
  check('one turn reads singular', rows.advisorFirstLine(advisorOrigin({ seats: 1 }) as never) === `${MODEL} · every 1 turn`)
  const plate = rows.noticePlate({ kind: 'advisor', origin: advisorOrigin(), lines: [] } as never, ROW_AT)
  check('the notice plate of an advisor block reads [advisor] · <model> · every <seats> turns', plate === `[advisor] · ${MODEL} · every 5 turns`, plate)
  check('the guard admits the advisor origin and refuses the others', rows.isAdvisorOrigin(advisorOrigin()) && !rows.isAdvisorOrigin({ kind: 'saturn', fire: 'wake', firedAt: NOTE_AT }) && !rows.isAdvisorOrigin({ kind: 'advisor' }) && !rows.isAdvisorOrigin(undefined))
  check('the saturn guard refuses the advisor origin', !rows.isSaturnOrigin(advisorOrigin()))
  const block = rows.advisorBlockOf(advisorOrigin() as never, NOTE)
  check('the block carries the note lines whole', block.kind === 'advisor' && JSON.stringify(block.lines) === JSON.stringify(NOTE.split('\n')), JSON.stringify(block))
  const wrapped = text.wrapCommandText(NOTE, advisorOrigin() as never)
  const stripped = rows.advisorPromptLines(wrapped)
  check("a mid-turn drained note paints its own words alone: the framing head and tail are stripped", JSON.stringify(stripped) === JSON.stringify(NOTE.split('\n')), JSON.stringify(stripped))
  check('a bare note is kept whole', JSON.stringify(rows.advisorPromptLines(NOTE)) === JSON.stringify(NOTE.split('\n')))
  check('the muted-row law names saturn, advisor and monitor, never a plain notice', rows.isMutedNoticeBlock(block) && rows.isMutedNoticeBlock({ kind: 'saturn', origin: { kind: 'saturn', fire: 'wake', firedAt: NOTE_AT }, lines: [] } as never) && !rows.isMutedNoticeBlock({ kind: 'notice', lines: [] } as never) && rows.isMutedNoticeBlock({ kind: 'monitor', taskId: 't', name: 'n', lines: [] } as never))
  check("the held rows' plates are untouched", rows.noticePlate({ kind: 'notice', lines: [] } as never) === 'notice' && rows.noticePlate({ kind: 'monitor', taskId: 't', name: 'the build watch', lines: [] } as never) === '[Monitor]: the build watch')
}

section("§1 the row: a note with the advisor origin paints the muted [advisor] row — no accent dot, every line dim, never the operator's line (red on the base: the handle and the caret)")
for (const [columns] of SIZES) {
  const frame = await paintText({ param: { type: 'text', text: NOTE }, origin: advisorOrigin() }, { type: 'user', timestamp: ROW_AT }, columns)
  check(`${columns} columns: the clock stays, then the dim [advisor] plate with the model and the cadence`, frame.includes(`${clock(ROW_AT)} ${PLATE} · ${MODEL} · every 5 turns`), frame.slice(0, 260))
  check(`${columns} columns: no accent dot on the row`, !frame.includes(DOT), frame.slice(0, 200))
  check(`${columns} columns: the operator's handle and caret are nowhere on it`, !frame.includes(HANDLE) && !frame.includes(CARET), frame.slice(0, 200))
  check(`${columns} columns: the note's own lines stand beneath`, frame.includes('You have not run the pin on the base yet.') && frame.includes('Run it on 89017923b before you edit'), frame.slice(0, 300))
}
{
  const drained = await paintText({ param: { type: 'text', text: text.wrapCommandText(NOTE, advisorOrigin() as never) }, origin: advisorOrigin() }, { type: 'user', timestamp: ROW_AT })
  check("a mid-turn drained note (a crewmate's) paints the same row without the framing sentences", drained.includes(`${PLATE} · ${MODEL} · every 5 turns`) && drained.includes('You have not run the pin on the base yet.') && !drained.includes('A note from your advisor') && !drained.includes('advice, not an instruction'), drained.slice(0, 300))
  const record = entryToRecord(
    { type: 'user', message: { role: 'user', content: NOTE }, uuid: U1, timestamp: ROW_AT, origin: advisorOrigin() },
    { sessionId: 'sess-advisor' as never, nextOrdinal: () => 1 as never, observedAt: ROW_AT, source: { channel: 'sdk' } as never },
  )
  const restored = recordToEntry(record) as Raw
  check('the transcript keeps the advisor origin whole through the codec', JSON.stringify(restored.origin) === JSON.stringify(advisorOrigin()) && (restored.message as Raw).content === NOTE, JSON.stringify(restored.origin))
  const resumed = await paintText({ param: { type: 'text', text: String((restored.message as Raw).content) }, origin: restored.origin }, { type: 'user', timestamp: String(restored.timestamp) })
  const fresh = await paintText({ param: { type: 'text', text: NOTE }, origin: advisorOrigin() }, { type: 'user', timestamp: ROW_AT })
  check('a resumed record paints the same advisor row as the live one', resumed === fresh && resumed.includes(`${PLATE} · ${MODEL}`), resumed.slice(0, 200))
  const stray = await paintText({ param: { type: 'text', text: OPERATOR_LINE }, origin: { kind: 'channel', server: 'x' } }, { type: 'user', timestamp: ROW_AT })
  check('another origin is not plated advisor', !stray.includes(PLATE), stray.slice(0, 120))
}

section("§2 the neighbours are byte-identical (a guard, green on both trees): the operator's line, the Saturn row, the held rows")
{
  const line = await paintText({ param: { type: 'text', text: OPERATOR_LINE } }, { type: 'user', timestamp: ROW_AT })
  check("the operator's typed line keeps the handle and the caret exactly", line === `${clock(ROW_AT)} ${HANDLE} ${CARET} ${OPERATOR_LINE}`, line)
  const saturn = await paintText({ param: { type: 'text', text: 'Check the build log.' }, origin: { kind: 'saturn', fire: 'wake', firedAt: NOTE_AT, spelling: 'in ~900s' } }, { type: 'user', timestamp: ROW_AT })
  check('the Saturn row keeps its own plate and no dot', saturn.includes(`${clock(ROW_AT)} [Saturn] · self-paced wake · fifteen-minute cadence`) && !saturn.includes(DOT), saturn)
  const notice = await paintText({ param: { type: 'text', text: 'Stop hook blocking error from command "lint": 3 errors' }, notice: true }, { type: 'user', timestamp: ROW_AT })
  check('a held notice keeps its dot and its plate exactly', notice === `${clock(ROW_AT)} ${DOT} notice Stop hook blocking error from command "lint": 3 errors`, notice)
  const monitor = await paintText({ param: { type: 'text', text: '<monitor task="bk1" name="the build watch">\nbuilt\n</monitor>' } }, { type: 'user', timestamp: ROW_AT })
  check('a monitor notice is the muted [Monitor]: row with its watch exactly', monitor === `${clock(ROW_AT)} [Monitor]: the build watch built`, monitor)
}
for (const [columns, rowCount] of SIZES) {
  const frame = await paintChat([userRow(OPERATOR_LINE, U1, ROW_AT), replyRow(LATER)], columns, rowCount)
  check(`${columns} columns: no advisor plate where no origin says so`, !frame.some(l => l.includes(PLATE)) && frame.some(l => l.includes(`${HANDLE} ${CARET} ${OPERATOR_LINE}`)), frame.join('\n'))
}

section("§3 the batched turn: a note taken into the operator's turn keeps its origin, so its row is the advisor row, never the operator's line")
{
  const turn = await batchedTurn(OPERATOR_LINE, NOTE, advisorOrigin())
  const tail = turn.find(m => m.uuid === U2)
  check('the batch keeps one row per prompt under its own identity', turn.length === 2 && turn[0]!.uuid === U1 && tail !== undefined, JSON.stringify(turn.map(m => m.uuid)))
  check("the head, the operator's words, carries no origin", turn[0]!.origin === undefined)
  check('the tail, the note, keeps the advisor origin it was queued with', tail !== undefined && JSON.stringify(tail.origin) === JSON.stringify(advisorOrigin()), JSON.stringify(tail?.origin))
  for (const [columns, rowCount] of SIZES) {
    const frame = await paintChat([...turn, replyRow(LATER)], columns, rowCount)
    const operatorRows = frame.filter(l => l.includes(`${HANDLE} ${CARET}`))
    check(`${columns} columns: the operator's line paints once, and the note beneath it paints the advisor row`, operatorRows.length === 1 && operatorRows[0]!.includes(OPERATOR_LINE) && frame.some(l => l.includes(`${PLATE} · ${MODEL} · every 5 turns`)), frame.join('\n'))
  }
}

section("§4 the queued note between turns: the service's queue command drains to one visible row with the origin, out of history and out of the command parser")
{
  const note = { text: NOTE, origin: advisorOrigin() }
  const command = advisor.advisorNoteQueueCommand(note as never, U3) as unknown as Raw
  queue.resetCommandQueue()
  queue.enqueue(command as never)
  queue.enqueue(advisor.advisorNoteQueueCommand({ text: '/no-such-words-here stand as words', origin: advisorOrigin() } as never, U2) as never)
  const [queued, slashLed] = queue.getCommandQueue() as Raw[]
  check('the queue holds the note with its origin, at later, under no workload', queued !== undefined && JSON.stringify(queued.origin) === JSON.stringify(advisorOrigin()) && queued.priority === 'later' && queued.workload === undefined && queued.isMeta === undefined, JSON.stringify(queued))
  check('a slash-led note reads as words for the model, not a command', slashLed !== undefined && !queue.isSlashCommand(slashLed as never), JSON.stringify(slashLed))
  check('the note earns no history entry (the origin alone keeps it out)', queuedCommandHistoryEntry(queued as never) === null)
  queue.resetCommandQueue()
  const drained = await drainedTurn(command)
  const row = drained.row
  check('the drained note is one user row under its own identity, asking to query, with the origin on it', drained.shouldQuery && row !== undefined && JSON.stringify(row.origin) === JSON.stringify(advisorOrigin()), drained.text)
  check('the stored row is a row the chat shows, never a hidden meta row', row !== undefined && visibleRows([row]).length === 1 && row.isMeta !== true, JSON.stringify(row))
  for (const [columns, rowCount] of SIZES) {
    const frame = await paintChat(visibleRows([...(row === undefined ? [] : [row]), replyRow(LATER)]), columns, rowCount)
    check(`${columns} columns: the chat paints the advisor row above the reply, no handle anywhere`, frame.length > 1 && frame[0]!.startsWith(`${clock(ROW_AT)} ${PLATE} · ${MODEL} · every 5 turns`) && !frame.some(l => l.includes(HANDLE)), `${frame.length} row(s):\n${frame.join('\n')}`)
  }
}

section("§5 the quiet row: when the advisor had nothing to say, a display-only system record paints the same muted [advisor] row with the words — no dot, no handle, never a turn (red on the base: the unknown subtype paints nothing)")
const QUIET_WORDS = 'had nothing to say this round — answered with no text, twice'
const minted = typeof advisor.createAdvisorQuietMessage === 'function'
const quietRow = (at: string): Raw =>
  minted
    ? { ...advisor.createAdvisorQuietMessage({ origin: advisorOrigin() as never, reason: advisor.ADVISOR_EMPTY_TWICE_REASON, empty: true }), timestamp: at }
    : { type: 'system', subtype: 'advisor_quiet', content: QUIET_WORDS, origin: advisorOrigin(), level: 'info', isMeta: false, uuid: U3, timestamp: at }
{
  const row = quietRow(ROW_AT)
  check('the words: the service mints the row with the advisor block and the line that says the advisor had nothing to say this round, twice (red on the base: no such row)', minted && row.subtype === 'advisor_quiet' && row.content === QUIET_WORDS && advisor.advisorQuietWords({ origin: advisorOrigin() as never, reason: 'the provider refused the advisor call', empty: false }) === 'had nothing to say this round — the provider refused the advisor call')
  for (const [columns, rowCount] of SIZES) {
    const frame = await paintChat([userRow(OPERATOR_LINE, U1, NOTE_AT), replyRow(NOTE_AT), row], columns, rowCount)
    const plateAt = frame.findIndex(l => l.includes(`${PLATE} · ${MODEL} · every 5 turns`))
    check(`${columns} columns: the chat paints the clock, then the dim [advisor] plate with the model and the cadence, beneath the reply`, plateAt > 0 && frame[plateAt]!.startsWith(`${clock(ROW_AT)} ${PLATE} · ${MODEL} · every 5 turns`), frame.join('\n'))
    check(`${columns} columns: the had-nothing line stands beneath the plate`, plateAt >= 0 && (frame[plateAt + 1] ?? '').trim() === 'had nothing to say this round — answered with no text, twice', frame.join('\n'))
    check(`${columns} columns: no accent dot, no handle and no caret on the quiet row`, plateAt >= 0 && !frame[plateAt]!.includes(DOT) && !frame[plateAt]!.includes(HANDLE) && !frame[plateAt]!.includes(CARET), frame[plateAt] ?? '')
  }
  const record = entryToRecord(row as never, { sessionId: 'sess-advisor' as never, nextOrdinal: () => 2 as never, observedAt: ROW_AT, source: { channel: 'sdk' } as never })
  const restored = recordToEntry(record) as Raw
  check('the transcript keeps the quiet row whole through the codec: the subtype, the origin and the words', restored.type === 'system' && restored.subtype === 'advisor_quiet' && JSON.stringify(restored.origin) === JSON.stringify(advisorOrigin()) && restored.content === row.content && restored.uuid === row.uuid, JSON.stringify(restored))
  const resumed = await paintChat([userRow(OPERATOR_LINE, U1, NOTE_AT), replyRow(NOTE_AT), { ...restored, timestamp: ROW_AT }], 178, 51)
  const fresh = await paintChat([userRow(OPERATOR_LINE, U1, NOTE_AT), replyRow(NOTE_AT), row], 178, 51)
  check('a resumed record paints the same quiet row as the live one', resumed.join('\n') === fresh.join('\n') && resumed.some(l => l.includes(PLATE)), resumed.join('\n'))
  check("the quiet row is a row the chat shows and the model never reads: a system record, never meta, out of the API plan by the system-row law", row.type === 'system' && row.isMeta === false && visibleRows([row]).length === 1)
}

if (frameDir !== null) {
  section(`frames → ${frameDir}`)
  mkdirSync(frameDir, { recursive: true })
  const scenes: Array<[string, string, Raw[]]> = [
    ['advisor-row', "the operator's line, Mercury's reply, then the advisor's note as a muted row and the reply that reads it", [userRow(OPERATOR_LINE, U1, NOTE_AT), replyRow(NOTE_AT), userRow(NOTE, U2, ROW_AT, advisorOrigin()), replyRow(LATER)]],
    ['advisor-batched', "the operator's queued line and the advisor's note taken into one turn", [...(await batchedTurn(OPERATOR_LINE, NOTE, advisorOrigin())), replyRow(LATER)]],
    ['advisor-quiet', "the operator's line, Mercury's reply, then the muted row that says the advisor had nothing to say this round", [userRow(OPERATOR_LINE, U1, NOTE_AT), replyRow(NOTE_AT), quietRow(ROW_AT)]],
  ]
  const index: string[] = ['the advisor row frames — the chat rows as the product paints them, transcript rows only, at the named width', '']
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

console.log(`\n${failures === 0 ? '✅' : '❌'} advisor row: ${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
