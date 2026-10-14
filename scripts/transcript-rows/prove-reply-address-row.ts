#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'reply-address-home-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_OPERATOR = 'sam'
const ROOT = resolve(import.meta.dir, '..', '..')
const frameDir = ((): string | null => {
  const at = process.argv.indexOf('--frames')
  return at >= 0 && process.argv[at + 1] !== undefined ? resolve(process.argv[at + 1]!) : null
})()
if (frameDir !== null) mkdirSync(frameDir, { recursive: true })
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
const { Message } = await import(join(ROOT, 'src/components/Message.tsx'))
const { formatClock, replyAddressLine, REPLY_ADDRESS_LEAD } = await import(join(ROOT, 'src/components/messages/TranscriptNameplate.tsx'))
const { normalizeMessages } = await import(join(ROOT, 'src/utils/messages/normalize.ts'))
const { buildMessageLookups } = await import(join(ROOT, 'src/utils/messages/lookups.ts'))
const { createUserMessage, createAssistantMessage } = await import(join(ROOT, 'src/utils/messages/factories.ts'))
const { createAttachmentMessage } = await import(join(ROOT, 'src/utils/attachments/orchestrator.ts'))
const { BashTool } = await import(join(ROOT, 'src/tools/BashTool/BashTool.tsx'))

type Raw = Record<string, unknown>
const h = React.createElement as (...a: unknown[]) => React.ReactElement
const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
const clock = (iso: string): string => formatClock(iso)!
const UA = '11111111-1111-4111-8111-111111111111'
const UB = '22222222-2222-4222-8222-222222222222'
const ASK = 'two tool rounds then a summary'
const LINE_A = 'how long will this take?'
const LINE_B = 'and is the second step the slow one?'
const ANSWER = 'About six more seconds: the second step is a two-second sleep, then the summary.'
const DONE = 'done: two tool rounds then a summary'
const T0 = '2026-10-14T23:09:22.000Z'
const T1 = '2026-10-14T23:09:23.000Z'
const T2 = '2026-10-14T23:09:27.000Z'
const TA = '2026-10-14T23:09:25.000Z'
const TB = '2026-10-14T23:09:26.000Z'
const T3 = '2026-10-14T23:09:28.000Z'
const T4 = '2026-10-14T23:09:30.000Z'
const T5 = '2026-10-14T23:09:31.000Z'

function fakeIo(columns: number, rowCount = 51): { stdout: NodeJS.WriteStream; stdin: NodeJS.ReadStream } {
  const stdout = Object.assign(new Writable({ write(_chunk, _enc, cb) { cb() } }), { columns, rows: rowCount, isTTY: false }) as unknown as NodeJS.WriteStream
  const stdin = Object.assign(new Readable({ read() {} }), { isTTY: true, setRawMode() {}, ref() {}, unref() {} }) as unknown as NodeJS.ReadStream
  return { stdout, stdin }
}

async function paintChat(messages: Raw[], columns: number, isTranscriptMode = false): Promise<string[]> {
  const normalized = normalizeMessages([...(messages as never[])])
  const lookups = buildMessageLookups(normalized, [...(messages as never[])])
  const io = fakeIo(columns, columns === 178 ? 51 : 30)
  const body = h(
    Box as never,
    { flexDirection: 'column' },
    ...normalized.map((message, i) =>
      h(Message as never, {
        key: message.uuid,
        message,
        messages: normalized,
        tools: [BashTool],
        commands: [],
        verbose: false,
        addMargin: i > 0,
        shouldAnimate: false,
        shouldShowDot: true,
        isTranscriptMode,
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
  return strip(instance.lastFrame()).split('\n').map(line => line.trimEnd())
}
const dense = (lines: string[]): string[] => lines.filter(line => line.trim() !== '')

const at = (row: Raw, timestamp: string): Raw => ({ ...row, timestamp })
const ask = at(createUserMessage({ content: ASK }) as unknown as Raw, T0)
const callOne = at(createAssistantMessage({ content: [{ type: 'tool_use', id: 'toolu_r1', name: 'Bash', input: { command: 'sleep 4', description: 'a 4s sleep' } }] }) as unknown as Raw, T1)
const resultOne = at(createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'toolu_r1', content: '(The Bash tool completed successfully with no output)' }] }) as unknown as Raw, T2)
const lineA = at(createAttachmentMessage({ type: 'queued_command', prompt: LINE_A, source_uuid: UA, commandMode: 'prompt', sentAt: TA } as never) as unknown as Raw, TA)
const lineB = at(createAttachmentMessage({ type: 'queued_command', prompt: LINE_B, source_uuid: UB, commandMode: 'prompt', sentAt: TB } as never) as unknown as Raw, TB)
const answerOf = (marks: Array<{ uuid: string; at: string }> | undefined): Raw => ({ ...at(createAssistantMessage({ content: ANSWER }) as unknown as Raw, T3), ...(marks !== undefined ? { inReplyTo: marks } : {}) })
const callTwo = at(createAssistantMessage({ content: [{ type: 'tool_use', id: 'toolu_r2', name: 'Bash', input: { command: 'sleep 2', description: 'a 2s sleep' } }] }) as unknown as Raw, T3)
const resultTwo = at(createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'toolu_r2', content: '(The Bash tool completed successfully with no output)' }] }) as unknown as Raw, T4)
const done = at(createAssistantMessage({ content: DONE }) as unknown as Raw, T5)

const todayShape = (answer: Raw): Raw[] => [ask, callOne, resultOne, lineA, answer, callTwo, resultTwo, done]
const ADDRESS_A = `${REPLY_ADDRESS_LEAD} ${clock(TA)} message`

section('§1 the words: one owner for the address line')
check('one mark → "answering your HH:MM:SS message", the clock in the plate\'s own format', replyAddressLine([{ at: TA }]) === ADDRESS_A, String(replyAddressLine([{ at: TA }])))
check('two marks → both clocks, "messages"', replyAddressLine([{ at: TA }, { at: TB }]) === `${REPLY_ADDRESS_LEAD} ${clock(TA)} and ${clock(TB)} messages`, String(replyAddressLine([{ at: TA }, { at: TB }])))
check('the same clock twice is said once', replyAddressLine([{ at: TA }, { at: TA }]) === ADDRESS_A)
check('a mark without a readable clock still names the message, never a guessed clock', replyAddressLine([{ at: 'not a clock' }]) === `${REPLY_ADDRESS_LEAD} message` && replyAddressLine([{}]) === `${REPLY_ADDRESS_LEAD} message`)
check('no marks → no line', replyAddressLine(undefined) === null && replyAddressLine([]) === null)

for (const columns of [178, 80]) {
  section(`§2 the chat at ${columns} columns: the answer to a mid-turn message paints its address directly above it`)
  const marked = await paintChat(todayShape(answerOf([{ uuid: UA, at: TA }])), columns)
  if (frameDir !== null && columns === 178) writeFileSync(join(frameDir, 'reply-address-178.txt'), marked.join('\n') + '\n')
  const lines = dense(marked)
  const addressAt = lines.findIndex(line => line.trim() === ADDRESS_A)
  const answerAt = lines.findIndex(line => line.includes(ANSWER.slice(0, 24)))
  const lineAAt = lines.findIndex(line => line.includes(LINE_A))
  const callTwoAt = lines.findIndex((line, i) => i > answerAt && line.includes('sleep 2'))
  check(`RED ON THE BASE: the address line "${ADDRESS_A}" paints, directly above the answer row`, addressAt >= 0 && answerAt === addressAt + 1, JSON.stringify({ addressAt, answerAt, around: lines.slice(Math.max(0, answerAt - 2), answerAt + 1) }))
  check("the address names the clock the user's own row wears (the queued row keeps its send clock)", lineAAt >= 0 && lines[lineAAt]!.startsWith(`${clock(TA)} [sam]`), lines[lineAAt])
  check('the answer row itself is unchanged: its own clock, the Mercury plate, the words', answerAt >= 0 && lines[answerAt]!.startsWith(`${clock(T3)} [Mercury] `) && lines[answerAt]!.includes(ANSWER.slice(0, 24)), lines[answerAt])
  check("the rows keep their order: the user's line, then the answer, then round two's tool call", lineAAt >= 0 && lineAAt < addressAt && callTwoAt > answerAt, JSON.stringify({ lineAAt, addressAt, answerAt, callTwoAt }))
  check('exactly one address line in the turn — the closing text carries none', lines.filter(line => line.includes(REPLY_ADDRESS_LEAD)).length === 1 && lines.some(line => line.includes(DONE)), JSON.stringify(lines.filter(line => line.includes(REPLY_ADDRESS_LEAD))))
  check('no blank line between the address and its answer (the row\'s own margin moved above the address)', marked.indexOf(marked.find(line => line.trim() === ADDRESS_A)!) + 1 === marked.findIndex(line => line.includes(ANSWER.slice(0, 24))), JSON.stringify(marked.slice(marked.findIndex(line => line.trim() === ADDRESS_A) - 1, marked.findIndex(line => line.trim() === ADDRESS_A) + 2)))
  check('every line fits the width', marked.every(line => [...line].length <= columns), String(Math.max(...marked.map(line => [...line].length))))

  const plain = dense(await paintChat(todayShape(answerOf(undefined)), columns))
  check('an older transcript (no mark on the record) paints as today: no address line, every other line identical', !plain.some(line => line.includes(REPLY_ADDRESS_LEAD)) && JSON.stringify(plain) === JSON.stringify(lines.filter((_, i) => i !== addressAt)), JSON.stringify({ plain: plain.length, marked: lines.length }))
}

section('§3 two messages drained together are answered by one text: both clocks in the address')
{
  const lines = dense(await paintChat([ask, callOne, resultOne, lineA, lineB, answerOf([{ uuid: UA, at: TA }, { uuid: UB, at: TB }]), callTwo, resultTwo, done], 178))
  const address = `${REPLY_ADDRESS_LEAD} ${clock(TA)} and ${clock(TB)} messages`
  const addressAt = lines.findIndex(line => line.trim() === address)
  check(`the address reads "${address}", above the answer`, addressAt >= 0 && lines[addressAt + 1]!.includes(ANSWER.slice(0, 24)), JSON.stringify(lines.slice(Math.max(0, addressAt), addressAt + 2)))
}

section('§4 the transcript view (ctrl+o) carries the address too')
{
  const lines = dense(await paintChat(todayShape(answerOf([{ uuid: UA, at: TA }])), 178, true))
  const addressAt = lines.findIndex(line => line.trim() === ADDRESS_A)
  const answerAt = lines.findIndex(line => line.includes(ANSWER.slice(0, 24)))
  check('the address line paints in the transcript view, above the answer', addressAt >= 0 && answerAt > addressAt, JSON.stringify({ addressAt, answerAt }))
}

section('§5 the model works another tool round before it answers: the address still names the message; the other painting as a still')
{
  const lookup = at(createAssistantMessage({ content: [{ type: 'tool_use', id: 'toolu_look', name: 'Bash', input: { command: 'cat plan.md', description: 'read the plan' } }] }) as unknown as Raw, '2026-10-14T23:09:27.500Z')
  const looked = at(createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'toolu_look', content: 'two steps: sleep 4, sleep 2' }] }) as unknown as Raw, '2026-10-14T23:09:27.800Z')
  const afterTools = await paintChat([ask, callOne, resultOne, lineA, lookup, looked, answerOf([{ uuid: UA, at: TA }]), callTwo, resultTwo, done], 178)
  const lines = dense(afterTools)
  const addressAt = lines.findIndex(line => line.trim() === ADDRESS_A)
  const lookAt = lines.findIndex(line => line.includes('cat plan.md'))
  const lineAAt = lines.findIndex(line => line.includes(LINE_A))
  check('with a tool round between the message and its answer, the address paints above the answer, after the tool row', lineAAt >= 0 && lookAt > lineAAt && addressAt > lookAt && lines[addressAt + 1]!.includes(ANSWER.slice(0, 24)), JSON.stringify({ lineAAt, lookAt, addressAt }))
  if (frameDir !== null) {
    writeFileSync(join(frameDir, 'reply-address-after-tools-178.txt'), afterTools.join('\n') + '\n')
    const moved = await paintChat([ask, callOne, resultOne, lineA, answerOf(undefined), lookup, looked, callTwo, resultTwo, done], 178)
    writeFileSync(join(frameDir, 'reply-under-message-178.txt'), moved.join('\n') + '\n')
    check('the still of the other painting (the answer moved under the message, out of time order) was written', moved.some(line => line.includes(ANSWER.slice(0, 24))))
  } else {
    console.log('  (no --frames: the stills are not written)')
  }
}

console.log(`\nprove-reply-address-row: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
