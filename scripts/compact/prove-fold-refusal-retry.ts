#!/usr/bin/env bun
// gate-watch: src/services/compact/compact.ts src/services/compact/foldStatus.ts src/commands/compact/compact.ts src/Tool.ts src/daemon/sessionSeat.ts src/rows/project.ts src/rows/vocabulary.ts
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v) ?? ''
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — fold-refusal-retry prover exceeded 240s')
  process.exit(1)
}, 240_000)
watchdog.unref?.()

delete process.env.NODE_ENV
delete process.env.CI
for (const ambient of [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_MODEL', 'MERCURY_OAUTH_TOKEN', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_BARE', 'MERCURY_HOME',
  'GOOGLE_API_KEY', 'MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT', 'MERCURY_OVERFLOW_RECOVERY', 'MERCURY_BLOCKING_LIMIT_OVERRIDE',
  'MERCURY_AUTOCOMPACT_PCT_OVERRIDE', 'MERCURY_EFFORT_LEVEL', 'MERCURY_MAX_OUTPUT_TOKENS', 'MERCURY_COMPACT_KEEP_TAIL', 'MERCURY_THINKING_BINDING', 'MERCURY_SM_COMPACT',
]) {
  delete process.env[ambient]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'fold-refusal-retry-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'fold-refusal-retry-daemon-'))
process.env.MERCURY_CREWS_DIR = mkdtempSync(join(tmpdir(), 'fold-refusal-retry-crews-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

const ROOT = join(import.meta.dir, '..', '..')
const { startOverflowFixture } = await import('./overflowFixture.ts')
type Captured = import('./overflowFixture.ts').Captured
const fixture = await startOverflowFixture()
Object.assign(process.env, fixture.env)

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { createUserMessage } = await import('../../src/utils/messages.ts')
const compactMod = await import('../../src/services/compact/compact.ts')
const foldStatus = await import('../../src/services/compact/foldStatus.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
type CompactProgressEvent = import('../../src/Tool.ts').CompactProgressEvent

const SONNET = 'claude-sonnet-5-5'
const OPUS = 'claude-opus-5-5'
const REFUSAL_WORDS = 'The model ended the response early (stop_reason: refusal)'
const SUMMARY = ['<summary>', '1. Operator Intent: count the words of the notes files and report the total.', '8. Where Work Stands: the scout counted three files; the total is 412 words.', '</summary>'].join('\n')

type AnyMsg = Record<string, unknown> & { type?: string }
let seq = 0
const uuidOf = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
function assistant(model: string, blocks: Array<Record<string, unknown>>, stopReason = 'end_turn'): AnyMsg {
  seq++
  return {
    type: 'assistant',
    uuid: uuidOf(seq),
    timestamp: new Date().toISOString(),
    requestId: `req_${seq}`,
    message: {
      id: `msg_${seq}`,
      type: 'message',
      role: 'assistant',
      model,
      content: blocks,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: { input_tokens: 900 + seq, output_tokens: 60, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  }
}
const thinking = (n: number, who: string): Record<string, unknown> => ({ type: 'thinking', thinking: `${who} reasons about step ${n}: ${'the notes files are read in order, the counts added up. '.repeat(6)}`, signature: `sig_${who}_${n}` })
const text = (t: string): Record<string, unknown> => ({ type: 'text', text: t })
const toolUse = (id: string, name: string, input: Record<string, unknown>): Record<string, unknown> => ({ type: 'tool_use', id, name, input })
const toolResult = (id: string, content: string): AnyMsg => createUserMessage({ content: [{ type: 'tool_result', tool_use_id: id, content }] as never }) as unknown as AnyMsg

function airConversation(replyChars = 0): AnyMsg[] {
  seq = 0
  const pad = replyChars > 0 ? `\n${'the count so far holds steady and the next file follows. '.repeat(Math.ceil(replyChars / 58))}` : ''
  const rows: AnyMsg[] = []
  rows.push(createUserMessage({ content: 'turn 1 (Sonnet 5.5): write a word-count tool for the notes folder' }) as unknown as AnyMsg)
  rows.push(assistant(SONNET, [thinking(1, 'sonnet'), text(`the tool is written: it walks the notes folder and sums the words.${pad}`)]))
  rows.push(createUserMessage({ content: 'turn 2 (Opus 5.5): send a scout to count the notes files, then report' }) as unknown as AnyMsg)
  rows.push(assistant(OPUS, [thinking(2, 'opus'), thinking(3, 'opus'), thinking(4, 'opus'), toolUse('toolu_scout', 'Agent', { description: 'count the notes', prompt: 'count the notes files', subagent_type: 'mercury-crew' })], 'tool_use'))
  rows.push(toolResult('toolu_scout', `SCOUT-DONE: three notes files, 412 words.${pad}`))
  rows.push(assistant(OPUS, [thinking(5, 'opus'), thinking(6, 'opus'), text(`the scout counted three files; the total is 412 words.${pad}`)]))
  rows.push(createUserMessage({ content: 'turn 3 (Sonnet 5.5): fizz — say the word' }) as unknown as AnyMsg)
  rows.push(assistant(SONNET, [thinking(7, 'sonnet'), text(`fizz.${pad}`)]))
  return rows
}

const CACHE_SAFE = { systemPrompt: ['fixture posture'] } as never
function makeContext(model: string, events: CompactProgressEvent[]): Record<string, unknown> {
  const toolPermissionContext = { ...getEmptyToolPermissionContext(), mode: 'default' as const }
  const appState = { toolPermissionContext, sessionHooks: new Map(), denialTracking: undefined, tasks: {}, agentNameRegistry: new Map(), mcp: { clients: [], tools: [], commands: [], resources: {} }, effortValue: 'high' }
  return {
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: () => {},
    messages: [],
    agentType: undefined,
    agentId: undefined,
    readFileState: new Map<string, unknown>(),
    onCompactProgress: (event: CompactProgressEvent) => { events.push(event) },
    options: { tools: [], mcpClients: [], engineModel: model, maxThinkingTokens: 0, isNonInteractiveSession: true, agentDefinitions: { activeAgents: [] } },
  }
}
type Fold = { result: Record<string, unknown> | undefined; error: string | undefined; wire: Captured[]; events: CompactProgressEvent[] }
async function fold(rows: AnyMsg[], model = SONNET): Promise<Fold> {
  const before = fixture.captured.length
  const events: CompactProgressEvent[] = []
  try {
    const result = (await compactMod.compactConversation(rows as never, makeContext(model, events) as never, CACHE_SAFE, false)) as unknown as Record<string, unknown>
    return { result, error: undefined, wire: fixture.captured.slice(before), events }
  } catch (err) {
    return { result: undefined, error: err instanceof Error ? err.message : String(err), wire: fixture.captured.slice(before), events }
  }
}
const rowsOf = (request: Captured): Array<{ role?: string; content?: unknown }> => ((request.body.messages as Array<{ role?: string; content?: unknown }> | undefined) ?? [])
const blockTypesOf = (request: Captured): string[] => rowsOf(request).flatMap(row => (Array.isArray(row.content) ? (row.content as Array<{ type?: string }>).map(block => String(block.type)) : ['string']))
const textOf = (request: Captured): string => rowsOf(request).map(row => (typeof row.content === 'string' ? row.content : Array.isArray(row.content) ? (row.content as Array<{ text?: string }>).map(block => block.text ?? '').join('\n') : '')).join('\n')
const summaryTextOf = (result: Record<string, unknown> | undefined): string => {
  const rows = (result?.summaryMessages as Array<{ message?: { content?: unknown } }> | undefined) ?? []
  const content = rows[0]?.message?.content
  return typeof content === 'string' ? content : Array.isArray(content) ? (content as Array<{ text?: string }>).map(block => block.text ?? '').join('\n') : ''
}

section("§1 the Air's shape (LIVE-27-AIR finding 9): Opus 5.5's turn with its thinking between two Sonnet 5.5 turns, a scout's tool round; the provider refuses the first fold with stop_reason refusal and accepts the second")
{
  fixture.script([{ refusal: true }, { text: SUMMARY }])
  const r = await fold(airConversation())
  check('the fold lands (red on the base: "Error during compaction: The model ended the response early (stop_reason: refusal)" — the user retried by hand)', r.error === undefined && r.result !== undefined, r.error ?? 'no result')
  check('two requests: the refused fold, then ONE retry (red on the base: one request, then the error row)', r.wire.length === 2, `${r.wire.length}: ${r.wire.map(w => w.path).join(', ')}`)
  const first = r.wire[0]
  const second = r.wire[1]
  check("the first request replays the conversation as it stands: assistant rows from both models, the scout's tool call and its result", first !== undefined && rowsOf(first).some(row => row.role === 'assistant') && blockTypesOf(first).includes('tool_use') && blockTypesOf(first).includes('tool_result'), first !== undefined ? j(blockTypesOf(first)) : 'no first request')
  check('the retry adjusts the refused shape: the conversation goes over as text in the user turn — no assistant row, no tool call, no thinking block', second !== undefined && rowsOf(second).every(row => row.role === 'user') && !blockTypesOf(second).includes('tool_use') && !blockTypesOf(second).includes('thinking'), second !== undefined ? j({ roles: rowsOf(second).map(row => row.role), blocks: blockTypesOf(second) }) : 'no second request')
  check("…and the text carries every turn's words, both models' answers and the scout's result", second !== undefined && ['write a word-count tool', 'the tool is written', 'send a scout', 'SCOUT-DONE: three notes files', 'the total is 412 words', 'fizz.'].every(words => textOf(second).includes(words)), second !== undefined ? textOf(second).slice(0, 300) : '')
  check('…and the retry carries the compaction prompt (the same summariser, the same instructions)', second !== undefined && first !== undefined && textOf(second).includes(rowsOf(first).at(-1) !== undefined ? textOf(first).split('\n').at(-1) ?? '' : ''), '')
  check('the summary that lands is the retry\'s answer', summaryTextOf(r.result).includes('the total is 412 words'), summaryTextOf(r.result).slice(0, 200))
  check('the fold said why it retried: a retry event naming the refusal, after the summarising stage began', r.events.some(event => event.type === 'retry' && event.why === 'refused' && event.attempt === 2), j(r.events))
  check("the result carries the plain line for the outcome row: '" + compactMod.FOLD_REFUSED_RETRY_NOTE + "'", j(r.result?.notes) === j([compactMod.FOLD_REFUSED_RETRY_NOTE]), j(r.result?.notes))
}

section('§2 the same conversation, the provider accepting the first fold: one request, no retry, no note (the road is byte-identical when nothing is refused)')
{
  fixture.script([{ text: SUMMARY }])
  const r = await fold(airConversation())
  check('one request, the fold lands', r.error === undefined && r.wire.length === 1, `${r.error ?? ''} ${r.wire.length}`)
  check('no retry event, no note', !r.events.some(event => event.type === 'retry') && r.result?.notes === undefined, j({ events: r.events, notes: r.result?.notes }))
}

section('§3 the provider refuses the retry too: the honest error, in the refusal\'s own words, after exactly one retry — never a loop')
{
  fixture.script([{ refusal: true }, { refusal: true }, { text: 'never reached' }])
  const r = await fold(airConversation())
  check('the fold fails with the refusal words (unchanged)', r.error !== undefined && r.error.includes(REFUSAL_WORDS), r.error ?? 'landed')
  check('exactly two requests: the fold and its one retry', r.wire.length === 2, String(r.wire.length))
  check('the retry event was announced before the second refusal', r.events.some(event => event.type === 'retry' && event.why === 'refused'), j(r.events))
}

section('§4 a conversation whose text is bigger than one request of the window: the retry walks the parts (every part as text), then the whole lands')
{
  const chunkChars = compactMod.refusalRetryChunkChars(SONNET)
  const rows = airConversation(Math.ceil(chunkChars / 2))
  const textChars = compactMod.conversationAsText(rows as never).length
  check(`the text is bigger than one chunk (${textChars.toLocaleString('en-US')} chars > ${chunkChars.toLocaleString('en-US')})`, textChars > chunkChars, String(textChars))
  const partCount = compactMod.splitTextForFold(compactMod.conversationAsText(rows as never), chunkChars).length
  fixture.script([{ refusal: true }, ...Array.from({ length: partCount }, (_, index) => ({ text: `PART ${index + 1}: the notes count carries on.` })), { text: SUMMARY }])
  const r = await fold(rows)
  check('the fold lands', r.error === undefined, r.error ?? '')
  check(`requests: the refused fold, ${partCount} part requests as text, then the whole`, r.wire.length === 2 + partCount, String(r.wire.length))
  const parts = r.wire.slice(1, 1 + partCount)
  check('every part request is text in the user turn, none replays an assistant row', parts.every(request => rowsOf(request).every(row => row.role === 'user') && !blockTypesOf(request).includes('tool_use')), j(parts.map(blockTypesOf)))
  const whole = r.wire.at(-1)
  check('the whole opens on the parts\' summaries (the part capsule), and the summary that lands is the whole\'s answer', whole !== undefined && textOf(whole).includes('PART 1: the notes count carries on.') && textOf(whole).includes(`PART ${partCount}:`) && summaryTextOf(r.result).includes('the total is 412 words'), whole !== undefined ? textOf(whole).slice(0, 200) : '')
}

section('§5 the row and the record: the live row names the refusal retry, the record carries it across the wire, an older record reads as before')
{
  const now = Date.now()
  const started = foldStatus.foldStatusOnEvent(foldStatus.beginFoldStatus({ trigger: 'manual', startedAtMs: now, sessionMemory: false, microcompaction: false }), { type: 'compact_start' })
  const retrying = foldStatus.foldStatusOnEvent(started, { type: 'retry', attempt: 2, why: 'refused' })
  check("the record reads retryWhy: 'refused' after the retry event", retrying.retryWhy === 'refused' && retrying.attempt === 2, j(retrying))
  const words = foldStatus.foldRowWords(retrying, now + 65_000)
  check(`the live row says it plainly: summarising · retry 2 · ${foldStatus.FOLD_REFUSED_RETRY_ROW_WORDS}`, words.stage === `summarising · retry 2 · ${foldStatus.FOLD_REFUSED_RETRY_ROW_WORDS}` && words.line.includes(foldStatus.FOLD_REFUSED_RETRY_ROW_WORDS), words.line)
  const narrowing = foldStatus.foldStatusOnEvent(started, { type: 'retry', attempt: 2 })
  check('a narrowing retry (a size refusal) keeps its old words: no refusal clause', narrowing.retryWhy === undefined && foldStatus.foldRowWords(narrowing, now).stage === 'summarising · retry 2', foldStatus.foldRowWords(narrowing, now).stage ?? '')
  const onWire = foldStatus.foldStatusToWire(retrying) as Record<string, unknown>
  check('the status frame spells the reason retry_why', onWire.retry_why === 'refused' && !('retryWhy' in onWire), j(onWire))
  const rows = await import('../../src/rows/project.ts')
  const vocabulary = await import('../../src/rows/vocabulary.ts')
  const row = { ...(rows.compactionRow({ session_id: 'fixture' } as never, retrying as never, 'manual' as never) as unknown as Record<string, unknown>), seq: 1, timestamp: new Date().toISOString() }
  check("the machine feed's compaction row carries retry_why: refused", row.retry_why === 'refused' && row.attempt === 2, j(row))
  const schema = vocabulary.CompactionRowSchema() as { safeParse: (value: unknown) => { success: boolean; error?: unknown } }
  check('the row vocabulary admits retry_why: refused and refuses another word', schema.safeParse(row).success && !schema.safeParse({ ...row, retry_why: 'weather' }).success, j({ ok: schema.safeParse(row).success, error: String(schema.safeParse(row).error ?? '').slice(0, 200), other: schema.safeParse({ ...row, retry_why: 'weather' }).success }))
  const back = foldStatus.decodeFoldStatus({ ...retrying })
  check('…and the record reads back whole', back !== null && back.retryWhy === 'refused' && back.attempt === 2, j(back))
  const seat = readFileSync(join(ROOT, 'src/daemon/sessionSeat.ts'), 'utf8')
  check('the seat carries the row\'s retry_why into the record the chat row paints', seat.includes("...(row.retry_why === 'refused' ? { retryWhy: 'refused' } : {})"))
  check('a record without the reason reads as before', foldStatus.decodeFoldStatus({ ...started }) !== null && foldStatus.decodeFoldStatus({ ...started })?.retryWhy === undefined)
  check('a record with an unknown reason word reads as no detail', foldStatus.decodeFoldStatus({ ...retrying, retryWhy: 'weather' }) === null)
}

section('§6 the outcome row: /compact paints the note beneath its facts')
{
  const command = readFileSync(join(ROOT, 'src/commands/compact/compact.ts'), 'utf8')
  check('buildDisplayText carries every note the result holds', command.includes('for (const note of result.notes ?? []) parts.push(note)'))
  const words = compactMod.FOLD_REFUSED_RETRY_NOTE
  check('the note is plain: it says what was refused, what the retry did and that it landed', /refused the first compaction request/.test(words) && /handed the conversation over as text/.test(words) && /landed/.test(words), words)
}

await fixture.close()
console.log(`\n${failures === 0 ? '✅' : '❌'} prove-fold-refusal-retry — ${failures === 0 ? 'all checks pass' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
