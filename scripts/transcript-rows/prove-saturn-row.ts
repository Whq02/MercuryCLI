#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'saturn-row-home-'))
process.env.MERCURY_OPERATOR = 'sam'
const ROOT = resolve(import.meta.dir, '..', '..')
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
const wakeOrigin = (extra: Raw = {}): Raw => ({ kind: 'saturn', fire: 'wake', firedAt: FIRED_AT, spelling: 'in ~900s', reason: REASON, ...extra })
const cronOrigin = (extra: Raw = {}): Raw => ({ kind: 'saturn', fire: 'cron', firedAt: FIRED_AT, scheduleId: '3f9a2c1d', spelling: 'Every weekday at 09:00', ...extra })

function fakeIo(columns: number): { stdout: NodeJS.WriteStream; stdin: NodeJS.ReadStream } {
  const stdout = Object.assign(new Writable({ write(_chunk, _enc, cb) { cb() } }), { columns, rows: 51, isTTY: false }) as unknown as NodeJS.WriteStream
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

async function paintChat(messages: Raw[], columns: number): Promise<string[]> {
  const normalized = normalizeMessages([...(messages as never[])])
  const lookups = buildMessageLookups(normalized, [...(messages as never[])])
  const io = fakeIo(columns)
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

section('§0 the words: the first line the schedule composes from its own facts (red on the base: the word home does not exist there)')
try {
  check("the plate name is Saturn, one home", attachedPlateName('saturn' as never) === 'Saturn' && rows.SATURN_PLATE_NAME === 'Saturn')
  check('a 900 s wake reads fifteen-minute cadence', rows.cadenceWords(900) === 'fifteen-minute cadence')
  check('a 120 s wake reads two-minute cadence, 1800 s thirty-minute, 3600 s sixty-minute', rows.cadenceWords(120) === 'two-minute cadence' && rows.cadenceWords(1800) === 'thirty-minute cadence' && rows.cadenceWords(3600) === 'sixty-minute cadence')
  check('a 25-minute wake reads with digits, a 90 s wake in seconds', rows.cadenceWords(1500) === '25-minute cadence' && rows.cadenceWords(90) === '90-second cadence')
  check("the wake's own spelling round-trips", rows.wakeDelaySpelling(900) === 'in ~900s' && rows.wakeDelayOfSpelling('in ~900s') === 900 && rows.wakeDelayOfSpelling('Every weekday at 09:00') === null && rows.wakeDelayOfSpelling(undefined) === null)
  const wakeLine = rows.saturnFirstLine(wakeOrigin(), ROW_AT)
  check('a self-paced wake: the word, the cadence, the reason', wakeLine === `self-paced wake · fifteen-minute cadence · reason: ${REASON}`, wakeLine)
  const bare = rows.saturnFirstLine(wakeOrigin({ reason: undefined, spelling: undefined }), ROW_AT)
  check('a wake with no reason and no spelling is the word alone', bare === 'self-paced wake', bare)
  const cronLine = rows.saturnFirstLine(cronOrigin(), ROW_AT)
  check("a cron fire: the schedule's id and its own spelling, lowercased into the line", cronLine === 'schedule 3f9a2c1d · every weekday at 09:00', cronLine)
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
  check('the guard admits a saturn origin and refuses the others', rows.isSaturnOrigin(wakeOrigin()) && rows.isSaturnOrigin(cronOrigin()) && !rows.isSaturnOrigin({ kind: 'channel', server: 'x' }) && !rows.isSaturnOrigin(undefined) && !rows.isSaturnOrigin({ kind: 'saturn' }))
  const plate = rows.noticePlate({ kind: 'saturn', origin: wakeOrigin(), lines: [] } as never, ROW_AT)
  check('the notice plate of a saturn block opens with the Saturn name', plate === `[Saturn] · self-paced wake · fifteen-minute cadence · reason: ${REASON}`, plate)
  check("the held rows' plates are untouched", rows.noticePlate({ kind: 'notice', lines: [] } as never) === 'notice' && rows.noticePlate({ kind: 'monitor', taskId: 't', name: 'the build watch', lines: [] } as never) === 'monitor · the build watch')
} catch (error) {
  check('the Saturn word home stands (saturnFirstLine, cadenceWords, saturnPromptLines, isSaturnOrigin)', false, String(error))
}

section("§1 THE DEFECT PIN (red on the base): a wake's row with the saturn origin paints the muted Saturn row, never the operator's line")
for (const columns of [178, 120]) {
  const frame = await paintText({ param: { type: 'text', text: WAKE_TEXT }, origin: wakeOrigin() }, { type: 'user', timestamp: ROW_AT }, columns)
  check(`${columns} columns: the clock stays, then the dim [Saturn] plate and the schedule's own words`, frame.includes(`${clock(ROW_AT)} ${SATURN} · self-paced wake · fifteen-minute cadence · reason: ${REASON}`), frame.slice(0, 260))
  check(`${columns} columns: no accent dot on the row`, !frame.includes(DOT), frame.slice(0, 200))
  check(`${columns} columns: the operator's handle and caret are nowhere on it`, !frame.includes(HANDLE) && !frame.includes(CARET), frame.slice(0, 200))
  check(`${columns} columns: the prompt's own words stand beneath, without the reason line`, frame.includes(WAKE_BODY) && !frame.includes('[self-paced wake — why you woke'), frame.slice(0, 300))
}
{
  const cron = await paintText({ param: { type: 'text', text: CRON_BODY }, origin: cronOrigin() }, { type: 'user', timestamp: ROW_AT })
  check("a cron fire: the same plate, the schedule's id and spelling on the first line, the prompt dim beneath", cron.includes(`${clock(ROW_AT)} ${SATURN} · schedule 3f9a2c1d · every weekday at 09:00`) && cron.includes(CRON_BODY) && !cron.includes(HANDLE) && !cron.includes(DOT), cron.slice(0, 260))
  const late = await paintText({ param: { type: 'text', text: WAKE_TEXT }, origin: wakeOrigin() }, { type: 'user', timestamp: LATE_ROW_AT })
  check('a wake delivered later keeps its delivery stamp and names the fire time on the first line', late.startsWith(`${clock(LATE_ROW_AT)} ${SATURN}`) && late.includes(` · fired ${clock(FIRED_AT)}`), late.slice(0, 260))
  const held = await paintText({ param: { type: 'text', text: WAKE_TEXT }, origin: wakeOrigin({ heldSince: HELD_SINCE, heldWhy: 'window' }) }, { type: 'user', timestamp: LATE_ROW_AT })
  check('a wake that met a closed usage window says so in the same row', held.includes(`held since ${clock(HELD_SINCE)} · the usage window was closed`), held.slice(0, 300))
  const record = entryToRecord(
    { type: 'user', message: { role: 'user', content: WAKE_TEXT }, uuid: 'a5b6c7d8-0000-4000-8000-000000000001', timestamp: ROW_AT, origin: wakeOrigin() },
    { sessionId: 'sess-saturn' as never, nextOrdinal: () => 1 as never, observedAt: ROW_AT, source: { channel: 'sdk' } as never },
  )
  const restored = recordToEntry(record) as Raw
  check('the transcript keeps the origin whole through the codec', JSON.stringify(restored.origin) === JSON.stringify(wakeOrigin()) && (restored.message as Raw).content === WAKE_TEXT, JSON.stringify(restored.origin))
  const resumed = await paintText({ param: { type: 'text', text: String((restored.message as Raw).content) }, origin: restored.origin }, { type: 'user', timestamp: String(restored.timestamp) })
  const fresh = await paintText({ param: { type: 'text', text: WAKE_TEXT }, origin: wakeOrigin() }, { type: 'user', timestamp: ROW_AT })
  check('a resumed record paints the same Saturn row as the live one', resumed === fresh && resumed.includes(SATURN), resumed.slice(0, 200))
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
for (const columns of [178, 120]) {
  const chat = [
    { ...createUserMessage({ content: OPERATOR_LINE, uuid: 'a5b6c7d8-0000-4000-8000-000000000010' }), timestamp: ROW_AT },
    { ...createAssistantMessage({ content: REPLY }), timestamp: LATE_ROW_AT },
  ]
  const frame = await paintChat(chat as Raw[], columns)
  const operatorRows = frame.filter(l => l === `${clock(ROW_AT)} ${HANDLE} ${CARET} ${OPERATOR_LINE}`)
  check(`${columns} columns: the chat around the row paints the operator's line once, handle and caret as today, and the reply beneath it without a handle`, operatorRows.length === 1 && frame.some(l => l.includes(REPLY) && !l.includes(HANDLE)), frame.join('\n'))
  check(`${columns} columns: no Saturn plate where no origin says so`, !frame.some(l => l.includes(SATURN)), frame.join('\n'))
}

console.log(`\n${failures === 0 ? '✅' : '❌'} saturn row: ${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
