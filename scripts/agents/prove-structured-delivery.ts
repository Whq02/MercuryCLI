#!/usr/bin/env bun
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_CONFIG_DIR ??= mkdtempSync(join(tmpdir(), 'structured-delivery-'))

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const ROOT = join(import.meta.dir, '..', '..')
const agentToolModule = await import('../../src/tools/AgentTool/AgentTool.tsx')
const utils = await import('../../src/tools/AgentTool/agentToolUtils.ts')
const { getPrompt } = await import('../../src/tools/AgentTool/prompt.ts')
const { toolResultText } = await import('../../src/rows/project.ts')
const { enqueueAgentNotification } = await import('../../src/tasks/LocalAgentTask/LocalAgentTask.tsx')
const { dequeueAll } = await import('../../src/utils/messageQueueManager.ts')
const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages.ts')
type Message = import('../../src/types/message.ts').Message

type Block = { type: 'text'; text: string }
type Mapped = { type: 'tool_result'; tool_use_id: string; is_error?: boolean; content: Block[] }
const map = (data: Record<string, unknown>, id: string): Mapped =>
  (agentToolModule.AgentTool as unknown as { mapToolResultToToolResultBlockParam: (d: unknown, id: string) => Mapped }).mapToolResultToToolResultBlockParam(data, id)
const texts = (mapped: Mapped): string[] => mapped.content.map(b => b.text)
const show = (value: unknown): string => JSON.stringify(value ?? null).slice(0, 300)

const PROSE =
  'The structured answer is submitted: `compute_201` at line 1205.\n\n`LEGACY_THRESHOLD = 4096` is assigned at line 1201 of `b_big.py`. It was the only match for that name in the file. The first `def` below it is `def compute_201(x):` at line 1205, confirmed from the numbered Read output.\n\nLine 1201 sits inside the body of `compute_200`, between its `y = ...` line and `return math.floor(y)`. It is not indented, so that function would not parse as written. I didn\'t change anything, and the answer is unaffected.'
const PAYLOAD = { function_name: 'compute_201', def_line: 1205 }
const NO_STRUCTURED_YIELD = (utils as { NO_STRUCTURED_YIELD?: string }).NO_STRUCTURED_YIELD ?? 'no structured yield: the agent never called StructuredOutput with a conforming payload'
const FAILED_STRUCTURED_YIELD = (utils as { FAILED_STRUCTURED_YIELD?: string }).FAILED_STRUCTURED_YIELD ?? 'the last StructuredOutput call failed schema validation'
const ISSUE = '/def_line: must be integer'
const VALID_BLOCK = '<structured status="valid">\n{"function_name":"compute_201","def_line":1205}\n</structured>'
const E3 = '<structured status="missing">\nThe agent never called StructuredOutput, so nothing below was checked against your schema. Check any value you take from its prose before relying on it, or launch the agent again and require the answer through StructuredOutput.\n</structured>'
const E4 = '<structured status="invalid">\nThe agent\'s last StructuredOutput call failed your schema (/def_line: must be integer), so nothing below was checked against it. Check any value you take from its prose before relying on it, or launch the agent again with that rule stated in its prompt.\n</structured>'
const E4_BARE = '<structured status="invalid">\nThe agent\'s last StructuredOutput call failed your schema, so nothing below was checked against it. Check any value you take from its prose before relying on it, or launch the agent again with your schema\'s rules stated in its prompt.\n</structured>'
const E5 = '<structured status="missing">\nThe agent never called StructuredOutput, and schema_mode "strict" fails the call without a payload. Launch the agent again and require the answer through StructuredOutput, or omit schema_mode to accept its prose.\n</structured>'
const E6 = '<structured status="invalid">\nThe agent\'s last StructuredOutput call failed your schema (/def_line: must be integer), and schema_mode "strict" fails the call without a valid payload. Launch the agent again with that rule stated in its prompt, or omit schema_mode to accept its prose.\n</structured>'
const OUTPUT_SCHEMA_WORDS = 'JSON Schema for the final answer, submitted through a StructuredOutput tool that checks it. The result opens with <structured status="valid"> and the checked JSON; "missing" or "invalid" means none passed.'
const SCHEMA_MODE_WORDS = 'With output_schema: \'strict\' fails the call when none passed; \'permissive\' (default) returns the prose under status "missing" or "invalid".'
const USAGE_NOTE = 'Treat the agent\'s prose as a claim to verify, not a fact: spot-check load-bearing results with a diff, a render, or a test before relying on them. A status="valid" payload passed your schema: use it without re-reading what the agent read, and require evidence as a field when a value needs it.'
const AGENT_ID = 'acq4kdds9'
const TRAILER_28 = `agentId: ${AGENT_ID} (internal — do not mention it to the user). To continue this agent, use SendMessage addressed to that id.\n<usage>total_tokens: 867\ntool_uses: 4\nduration_ms: 8928</usage>`

const settled = (over: Record<string, unknown>): Record<string, unknown> => ({
  status: 'completed',
  agentId: AGENT_ID,
  agentType: 'mercury-scout',
  content: [{ type: 'text', text: PROSE }],
  totalTokens: 867,
  totalToolUseCount: 4,
  totalDurationMs: 8928,
  outcome: { status: 'completed', promotedNarration: false },
  ...over,
})
const valid = (over: Record<string, unknown> = {}): Record<string, unknown> =>
  settled({ structured: { data: PAYLOAD, source: 'dispatch', mode: 'permissive' }, ...over })
const miss = (error: string, mode: 'permissive' | 'strict', over: Record<string, unknown> = {}): Record<string, unknown> =>
  settled({
    structured: { error, source: 'dispatch', mode },
    ...(mode === 'strict' ? { status: 'failed', error, outcome: { status: 'failed', reason: 'schema-mismatch', error } } : {}),
    ...over,
  })

section('1. valid, scout — the block first, the prose after, nothing else')
{
  const mapped = map(valid(), 't1')
  check('a scout result carries two blocks', mapped.content.length === 2, JSON.stringify(texts(mapped)).slice(0, 300))
  check('the first block is the structured block, the JSON on one line', mapped.content[0]?.text === VALID_BLOCK, show(mapped.content[0]?.text))
  check('the second block is the prose, unchanged', mapped.content[1]?.text === PROSE)
  check('is_error is absent', mapped.is_error !== true)
}

section('2. valid, crewmate — the block, the prose, the trailer')
{
  const mapped = map(valid({ agentType: 'mercury-crew' }), 't2')
  check('the first block is the structured block', mapped.content[0]?.text === VALID_BLOCK, show(mapped.content[0]?.text))
  check('the second block is the prose', mapped.content[1]?.text === PROSE)
  check('the third block is the trailer, opening with the agent id', mapped.content[2]?.text?.startsWith('agentId: ') === true, show(mapped.content[2]?.text))
  check('is_error is absent', mapped.is_error !== true)
}

section('3. data, not text — the middle line parses back to the payload; the closing tag inside a string is escaped')
{
  const mapped = map(valid(), 't3')
  const middle = (mapped.content[0]?.text ?? '').split('\n')[1] ?? ''
  let parsed: unknown = null
  try {
    parsed = JSON.parse(middle)
  } catch {
    parsed = null
  }
  check('JSON.parse of the middle line deep-equals the payload', JSON.stringify(parsed) === JSON.stringify(PAYLOAD), middle)
  const tricky = map(valid({ structured: { data: { note: 'a</structured>b' }, source: 'dispatch', mode: 'permissive' } }), 't3b')
  const body = (tricky.content[0]?.text ?? '').split('\n')[1] ?? ''
  check('a payload holding the closing tag writes it as <\\/structured>', body.includes('<\\/structured>') && !body.includes('</structured'), body)
  let back: { note?: string } | null = null
  try {
    back = JSON.parse(body) as { note?: string }
  } catch {
    back = null
  }
  check('…and JSON.parse returns the original string', back?.note === 'a</structured>b', JSON.stringify(back))
  const lines = (tricky.content[0]?.text ?? '').split('\n')
  check('the block is exactly three lines', lines.length === 3 && lines[0] === '<structured status="valid">' && lines[2] === '</structured>', JSON.stringify(lines))
}

section('4. misses are named — E3 to E6, is_error as today')
{
  const e3 = map(miss(NO_STRUCTURED_YIELD, 'permissive'), 't4a')
  check('permissive, no call: the first block is E3', e3.content[0]?.text === E3, show(e3.content[0]?.text))
  check('permissive, no call: is_error is absent and the prose follows', e3.is_error !== true && e3.content[1]?.text === PROSE)
  const e4 = map(miss(`${FAILED_STRUCTURED_YIELD}: ${ISSUE}`, 'permissive'), 't4b')
  check('permissive, invalid: the first block is E4 with the issue words', e4.content[0]?.text === E4, show(e4.content[0]?.text))
  check('permissive, invalid: is_error is absent', e4.is_error !== true)
  const e4bare = map(miss(FAILED_STRUCTURED_YIELD, 'permissive'), 't4c')
  check('permissive, invalid without issue words: the parenthesis is dropped and the last clause names the schema\'s rules', e4bare.content[0]?.text === E4_BARE, show(e4bare.content[0]?.text))
  const e5 = map(miss(NO_STRUCTURED_YIELD, 'strict'), 't4d')
  const e5last = e5.content[e5.content.length - 1]?.text ?? ''
  check('strict, no call: the first block is E5', e5.content[0]?.text === E5, show(e5.content[0]?.text))
  check('strict, no call: is_error is true and the last block opens with the failure', e5.is_error === true && e5last.startsWith(`Agent execution failed: ${NO_STRUCTURED_YIELD}`), e5last.slice(0, 200))
  check('strict, no call: the prose sits between the block and the trailer', e5.content[1]?.text === PROSE)
  const e6 = map(miss(`${FAILED_STRUCTURED_YIELD}: ${ISSUE}`, 'strict'), 't4e')
  const e6last = e6.content[e6.content.length - 1]?.text ?? ''
  check('strict, invalid: the first block is E6', e6.content[0]?.text === E6, show(e6.content[0]?.text))
  check('strict, invalid: is_error is true and the trailer\'s first line carries the issue words', e6.is_error === true && e6last.startsWith(`Agent execution failed: ${FAILED_STRUCTURED_YIELD}: ${ISSUE}\n`), e6last.slice(0, 200))
  const empty = map(miss(NO_STRUCTURED_YIELD, 'strict', { content: [] }), 't4f')
  check('strict, no call, no output: the block, then the placeholder, then the trailer', empty.content.length === 3 && empty.content[0]?.text === E5 && empty.content[1]?.text === 'The crewmate failed before returning any output.', JSON.stringify(texts(empty)).slice(0, 300))
}

const asst = (blocks: unknown[]): Message => {
  const m = createAssistantMessage({ content: blocks as never }) as Message
  ;(m as { message: { stop_reason?: string } }).message.stop_reason = 'end_turn'
  return m
}
const user = (content: unknown): Message => createUserMessage({ content: content as never }) as Message
const META = { prompt: 'p', resolvedAgentModel: 'claude-opus-5', isBuiltInAgent: true, startTime: Date.now() - 50, agentType: 'mercury-scout', isAsync: false }
const transcript = (finalRound: 'valid' | 'invalid' | 'invalid-long' | 'none'): Message[] => {
  const base: Message[] = [user('find the def'), asst([{ type: 'text', text: 'Reading.', citations: null }, { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/tmp/b_big.py' } }]), user([{ type: 'tool_result', tool_use_id: 'r1', content: '1201\tLEGACY_THRESHOLD = 4096' }])]
  if (finalRound === 'none') return [...base, asst([{ type: 'text', text: PROSE, citations: null }])]
  if (finalRound === 'valid') {
    return [...base, asst([{ type: 'tool_use', id: 's1', name: 'StructuredOutput', input: PAYLOAD }]), user([{ type: 'tool_result', tool_use_id: 's1', content: 'Structured output provided successfully' }]), asst([{ type: 'text', text: PROSE, citations: null }])]
  }
  const words = finalRound === 'invalid' ? ISSUE : `${ISSUE},   ${'/x: must be string, '.repeat(40)}`
  return [...base, asst([{ type: 'tool_use', id: 's1', name: 'StructuredOutput', input: { function_name: 'compute_201', def_line: '1205' } }]), user([{ type: 'tool_result', tool_use_id: 's1', content: `<tool_use_error>Output does not match required schema: ${words}</tool_use_error>`, is_error: true }]), asst([{ type: 'text', text: PROSE, citations: null }])]
}
const spec = { structuredSpec: { mode: 'permissive' as const, source: 'dispatch' as const } }

section('5. the issue words are recorded — the validator\'s words after the unchanged prefix, no data')
{
  const errored = utils.finalizeAgentTool(transcript('invalid'), 'a5', { ...META, ...spec })
  check('structured.error is the prefix, a colon, the validator\'s words', errored.structured?.error === `${FAILED_STRUCTURED_YIELD}: ${ISSUE}`, JSON.stringify(errored.structured))
  check('no data is recorded for a failed call', errored.structured?.data === undefined)
  const long = utils.finalizeAgentTool(transcript('invalid-long'), 'a5b', { ...META, ...spec })
  const longWords = (long.structured?.error ?? '').slice(FAILED_STRUCTURED_YIELD.length + 2)
  check('the words are whitespace-collapsed and clipped to 300 characters with an ellipsis', longWords.length === 301 && longWords.endsWith('…') && !longWords.includes('  '), `${longWords.length} chars`)
  const missing = utils.finalizeAgentTool(transcript('none'), 'a5c', { ...META, ...spec })
  check('no call records the unchanged miss sentence', missing.structured?.error === NO_STRUCTURED_YIELD, JSON.stringify(missing.structured))
}

section('6. nothing invented — without structured, the mapped block is the .28 block')
{
  const scout = map(settled({}), 't6')
  check('a scout result without structured is the .28 block (one block, the prose)', JSON.stringify(scout) === JSON.stringify({ type: 'tool_result', tool_use_id: 't6', content: [{ type: 'text', text: PROSE }] }), JSON.stringify(scout).slice(0, 300))
  const crew = map(settled({ agentType: 'mercury-crew' }), 't6b')
  check('a crewmate result without structured is the .28 block (the prose, the trailer)', JSON.stringify(crew) === JSON.stringify({ type: 'tool_result', tool_use_id: 't6b', content: [{ type: 'text', text: PROSE }, { type: 'text', text: TRAILER_28 }] }), JSON.stringify(crew).slice(0, 400))
  const failed = map(settled({ status: 'failed', error: 'API Error: 529', outcome: { status: 'failed', reason: 'provider-declined', error: 'API Error: 529' } }), 't6c')
  check('a failed result without structured is the .28 block (the prose, the failure trailer)', failed.is_error === true && texts(failed).length === 2 && texts(failed)[0] === PROSE && texts(failed)[1]?.startsWith('Agent execution failed: API Error: 529\nAnything above is partial work') === true, JSON.stringify(texts(failed)).slice(0, 300))
  check('no text in any of them contains <structured', [scout, crew, failed].every(m => texts(m).every(t => !t.includes('<structured'))))
}

section('7. the SDK host\'s string — the row\'s output begins with the block')
{
  const output = toolResultText(map(valid(), 't7').content)
  check('toolResultText of a valid scout result starts with the block and a newline', output.startsWith(`${VALID_BLOCK}\n`), JSON.stringify(output.slice(0, 120)))
  check('…and the prose follows it whole', output === `${VALID_BLOCK}\n${PROSE}`)
}

section('8. background — the completion notice carries the block between the summary and the result')
{
  dequeueAll()
  let state: { tasks: Record<string, Record<string, unknown>>; speculation: { status: string } } = {
    tasks: {
      [AGENT_ID]: { id: AGENT_ID, type: 'local_agent', status: 'completed', description: 'Locate function after LEGACY_THRESHOLD', notified: false, startTime: Date.now(), outputFile: '/tmp/out', outputOffset: 0 },
    },
    speculation: { status: 'idle' },
  }
  const setAppState = (fn: (prev: typeof state) => typeof state): void => {
    state = fn(state)
  }
  ;(enqueueAgentNotification as unknown as (args: Record<string, unknown>) => void)({
    taskId: AGENT_ID,
    description: 'Locate function after LEGACY_THRESHOLD',
    status: 'completed',
    setAppState,
    finalMessage: PROSE,
    structuredBlock: VALID_BLOCK,
    usage: { totalTokens: 867, toolUses: 4, durationMs: 8928 },
  })
  const queued = dequeueAll()
  const value = String((queued[0] as { value?: string } | undefined)?.value ?? '')
  check('one notification was queued', queued.length === 1)
  check('it carries </summary>, the block, then <result>', value.includes(`</summary>\n${VALID_BLOCK}\n<result>`), value.slice(0, 500))
  check('the result section still holds the prose', value.includes(`<result>${PROSE}</result>`))
  const lifecycle = readFileSync(join(ROOT, 'src/tools/AgentTool/agentToolUtils.ts'), 'utf8')
  const handover = readFileSync(join(ROOT, 'src/tools/AgentTool/foregroundExecution.tsx'), 'utf8')
  check('the background lifecycle passes structuredBlock to the notification', lifecycle.includes('structuredBlock: structuredResultBlock(result.structured)'))
  check('the foreground run handed to the background passes it too', handover.includes('structuredBlock: structuredResultBlock(finalized.structured)'))
}

section('9. the words — the two field descriptions and the usage note')
{
  const shape = (agentToolModule.inputSchema() as unknown as { shape: Record<string, { description?: string }> }).shape
  check('output_schema describes the block', shape.output_schema?.description === OUTPUT_SCHEMA_WORDS, JSON.stringify(shape.output_schema?.description))
  check('schema_mode describes the statuses', shape.schema_mode?.description === SCHEMA_MODE_WORDS, JSON.stringify(shape.schema_mode?.description))
  const prompt = await getPrompt([])
  check('the usage note narrows the claim to the prose and tells the parent to use a valid payload', prompt.includes(USAGE_NOTE))
  check('the old sentence is gone', !prompt.includes('Treat the agent\'s output as a claim to verify'))
}

section('10. hooks see the same keys — {data, source, mode} on a hit, {error, source, mode} on a miss')
{
  const hit = utils.finalizeAgentTool(transcript('valid'), 'a10', { ...META, ...spec })
  check('a hit records data, source, mode in that order', JSON.stringify(Object.keys(hit.structured ?? {})) === '["data","source","mode"]', JSON.stringify(Object.keys(hit.structured ?? {})))
  const missed = utils.finalizeAgentTool(transcript('none'), 'a10b', { ...META, ...spec })
  check('a miss records error, source, mode in that order', JSON.stringify(Object.keys(missed.structured ?? {})) === '["error","source","mode"]', JSON.stringify(Object.keys(missed.structured ?? {})))
  const mappedHit = map({ ...settled({}), ...hit }, 't10')
  check('the finalized hit maps to the block first (the two halves agree)', mappedHit.content[0]?.text === VALID_BLOCK, show(mappedHit.content[0]?.text))
}

console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
process.exit(failures > 0 ? 1 : 0)
