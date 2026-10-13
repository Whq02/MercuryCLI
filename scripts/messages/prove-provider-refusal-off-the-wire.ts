#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'provider-refusal-off-the-wire-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'

type Message = import('../../src/types/message.js').Message
type AssistantMessage = import('../../src/types/message.js').AssistantMessage
type UserMessage = import('../../src/types/message.js').UserMessage
type PendingToolCall = import('../../src/utils/wards/wards.js').PendingToolCall

const { requestConversationPlan } = await import('../../src/utils/messages/apiPlan.ts')
const { createAssistantAPIErrorMessage, createAssistantMessage, createUserMessage } = await import('../../src/utils/messages/factories.ts')
const { REFUSAL_WARDS, buildWardDenial, evaluateWards } = await import('../../src/utils/wards/wards.ts')

let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

const SERVED_MODEL = 'claude-opus-4-8'
const ROOT_DELETE = 'rm -rf /'
const REFUSED_PROMPT = `Use the Bash tool to run exactly this command and nothing else: ${ROOT_DELETE}`
const NEXT_PROMPT = 'Count slowly from 1 to 3, one number per line, and nothing else.'
const PARTIAL_REFUSAL = 'I cannot run that command.'
const COCKPIT_ROW = 'The model ended the response early (stop_reason: refusal). Use /rewind (or shift+up) to edit your last message, or start a new session.'
const HEADLESS_ROW = 'The model ended the response early (stop_reason: refusal). Try rephrasing the request or a different approach.'
const REFUSAL_WORDS = [PARTIAL_REFUSAL, 'stop_reason: refusal', 'refusal is final', 'never repeat, retry or re-issue', '/rewind', 'shift+up', 'Try rephrasing', 'different approach']

type Block = Record<string, unknown>
function served(id: string, blocks: Block[], stopReason: 'refusal' | 'end_turn' | 'tool_use' | null): AssistantMessage {
  const row = createAssistantMessage({ content: blocks as never })
  return { ...row, message: { ...row.message, id, model: SERVED_MODEL, stop_reason: stopReason } }
}
const text = (words: string): Block => ({ type: 'text', text: words })
const thinking = (words: string): Block => ({ type: 'thinking', thinking: words, signature: `sig-${words.length}` })
const toolUse = (id: string, command: string): Block => ({ type: 'tool_use', id, name: 'Bash', input: { command, description: 'proof' } })
function toolResult(toolUseId: string, words: string, isError = false): UserMessage {
  return createUserMessage({ content: [{ type: 'tool_result', tool_use_id: toolUseId, content: words, ...(isError ? { is_error: true } : {}) }] as never })
}
const refusalRow = (words: string): AssistantMessage =>
  createAssistantAPIErrorMessage({ content: words, error: 'invalid_request', errorDetails: `stop_reason: refusal · model: ${SERVED_MODEL} · request_id: unknown` })

function wireOf(messages: Message[]): { rows: Array<UserMessage | AssistantMessage>; texts: string[]; roles: string[] } {
  const plan = requestConversationPlan(messages, [])
  const texts: string[] = []
  for (const row of plan.messages) {
    const content = row.message.content
    if (typeof content === 'string') { texts.push(content); continue }
    if (!Array.isArray(content)) continue
    for (const block of content as Array<{ type?: string; text?: string; content?: unknown }>) {
      if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
      if (block.type === 'tool_result') texts.push(typeof block.content === 'string' ? block.content : JSON.stringify(block.content))
    }
  }
  return { rows: plan.messages, texts, roles: plan.messages.map(row => row.type) }
}
const alternates = (roles: string[]): boolean => roles.length > 0 && roles[0] === 'user' && roles.every((role, index) => index === 0 || role !== roles[index - 1])
const carriesNone = (texts: string[], words: readonly string[]): string[] => words.filter(word => texts.some(line => line.includes(word)))

section('§1 a provider refusal of a prompt: the model later sees neither its own partial words, nor the error row, nor a closure — the user keeps the row')
for (const [road, rowWords] of [['cockpit', COCKPIT_ROW], ['headless', HEADLESS_ROW]] as const) {
  const greeting = createUserMessage({ content: 'Hello.' })
  const greeted = served('msg_greet', [text('Hello — what shall I do?')], 'end_turn')
  const refused = createUserMessage({ content: REFUSED_PROMPT })
  const refusedThinking = served('msg_refused', [thinking('The user wants a root delete.')], null)
  const refusedText = served('msg_refused', [text(PARTIAL_REFUSAL)], 'refusal')
  const errorRow = refusalRow(rowWords)
  const next = createUserMessage({ content: NEXT_PROMPT })
  const transcript: Message[] = [greeting, greeted, refused, refusedThinking, refusedText, errorRow, next]
  const before = JSON.stringify(transcript)
  const wire = wireOf(transcript)
  const leaked = carriesNone(wire.texts, REFUSAL_WORDS)
  check(`${road}: no refusal word reaches the wire (RED on 6d7b3970b4: the closure "This refusal is final…" rode as an assistant row; RED on aef216c8d5: the model's own partial words rode)`, leaked.length === 0, `leaked: ${JSON.stringify(leaked)}; wire: ${JSON.stringify(wire.texts).slice(0, 400)}`)
  check(`${road}: no assistant row of the refused turn (message.id msg_refused) is sent — its thinking row and its text row both leave`, !wire.rows.some(row => row.type === 'assistant' && row.message.id === 'msg_refused'), wire.roles.join(','))
  check(`${road}: the served reply before the refusal still rides (a refusal omits one turn, not the conversation)`, wire.rows.some(row => row.type === 'assistant' && row.message.id === 'msg_greet'), wire.roles.join(','))
  check(`${road}: the turns alternate user → assistant → user with no doubled role (${wire.roles.join(' → ')})`, alternates(wire.roles) && wire.roles.at(-1) === 'user', wire.roles.join(','))
  check(`${road}: the newest instruction reaches the model`, wire.texts.some(line => line.includes(NEXT_PROMPT)))
  const merged = wire.rows.find(row => row.type === 'user' && JSON.stringify(row.message.content).includes(NEXT_PROMPT))
  check(`${road}: the orphaned prompt merges into the next user turn, as every omitted error row's neighbour does (one user row carries both)`, merged !== undefined && JSON.stringify(merged.message.content).includes(ROOT_DELETE), JSON.stringify(merged?.message.content).slice(0, 300))
  check(`${road}: the transcript is untouched — the same seven rows, the same objects, the error row still saying "${rowWords.slice(0, 48)}…"`, JSON.stringify(transcript) === before && transcript.length === 7 && transcript[5] === errorRow && JSON.stringify(errorRow.message.content).includes('stop_reason: refusal') && transcript[4] === refusedText && refusedText.message.stop_reason === 'refusal')
}

section('§2 a provider refusal mid-task: the tool round before it stays whole, the refused words leave, the pairing holds')
{
  const ask = createUserMessage({ content: 'List the files here, then tidy the build folder.' })
  const listing = served('msg_list', [toolUse('toolu_list', 'ls')], 'tool_use')
  const listed = toolResult('toolu_list', 'README.md\nbuild\n')
  const refusedText = served('msg_mid', [text('I will not continue with this task.')], 'refusal')
  const errorRow = refusalRow(HEADLESS_ROW)
  const next = createUserMessage({ content: 'Just tell me how many files you saw.' })
  const transcript: Message[] = [ask, listing, listed, refusedText, errorRow, next]
  const wire = wireOf(transcript)
  const toolUseSent = wire.rows.some(row => row.type === 'assistant' && Array.isArray(row.message.content) && row.message.content.some(block => block.type === 'tool_use' && (block as { id?: string }).id === 'toolu_list'))
  const resultSent = wire.rows.some(row => row.type === 'user' && Array.isArray(row.message.content) && row.message.content.some(block => block.type === 'tool_result' && (block as { tool_use_id?: string }).tool_use_id === 'toolu_list'))
  check('the tool call and its result both ride (the round before the refusal is the work\'s record)', toolUseSent && resultSent, wire.roles.join(','))
  check('the refused words "I will not continue with this task." never ride (RED on aef216c8d5)', !wire.texts.some(line => line.includes('I will not continue')), JSON.stringify(wire.texts).slice(0, 300))
  check('the error row never rides', carriesNone(wire.texts, ['stop_reason: refusal', 'Try rephrasing']).length === 0)
  check(`the turns alternate and end on the newest instruction (${wire.roles.join(' → ')})`, alternates(wire.roles) && wire.roles.at(-1) === 'user' && wire.texts.some(line => line.includes('how many files')), wire.roles.join(','))
}

section('§3 a refused turn that issued a tool call stays with its result — the pairing law outranks the omission')
{
  const ask = createUserMessage({ content: 'Say hi through the shell.' })
  const saying = served('msg_hi', [text('Running it:')], null)
  const call = served('msg_hi', [toolUse('toolu_hi', 'echo hi')], 'refusal')
  const errorRow = refusalRow(HEADLESS_ROW)
  const result = toolResult('toolu_hi', 'hi\n')
  const next = createUserMessage({ content: 'Thanks.' })
  const transcript: Message[] = [ask, saying, call, errorRow, result, next]
  const wire = wireOf(transcript)
  const toolUseSent = wire.rows.some(row => row.type === 'assistant' && Array.isArray(row.message.content) && row.message.content.some(block => block.type === 'tool_use' && (block as { id?: string }).id === 'toolu_hi'))
  const resultSent = wire.rows.some(row => row.type === 'user' && Array.isArray(row.message.content) && row.message.content.some(block => block.type === 'tool_result' && (block as { tool_use_id?: string }).tool_use_id === 'toolu_hi'))
  check('the refused turn\'s tool call rides because its result is in the transcript', toolUseSent && resultSent, wire.roles.join(','))
  check('the error row still never rides', !wire.texts.some(line => line.includes('stop_reason: refusal')))
  check(`the turns alternate (${wire.roles.join(' → ')})`, alternates(wire.roles), wire.roles.join(','))
}

section('§4 the ward\'s road is not a provider refusal: a ward-refused tool call still reaches the model as a closed tool result')
{
  const pending: PendingToolCall = { toolName: 'Bash', input: { command: ROOT_DELETE }, shellCommand: ROOT_DELETE }
  const verdict = evaluateWards(REFUSAL_WARDS, pending)
  check('the root delete is refused by a refusal ward', !verdict.allow && verdict.rule.refusal === true, JSON.stringify(verdict).slice(0, 200))
  if (!verdict.allow) {
    const denial = buildWardDenial(verdict, 'Bash')
    const ask = createUserMessage({ content: REFUSED_PROMPT })
    const call = served('msg_ward', [toolUse('toolu_ward', ROOT_DELETE)], 'tool_use')
    const refusedResult = toolResult('toolu_ward', denial, true)
    const reply = served('msg_ward_reply', [text('The ward blocked that delete; it did not run.')], 'end_turn')
    const next = createUserMessage({ content: NEXT_PROMPT })
    const wire = wireOf([ask, call, refusedResult, reply, next])
    const sentResult = wire.rows.flatMap(row => (row.type === 'user' && Array.isArray(row.message.content) ? row.message.content : [])).find(block => block.type === 'tool_result' && (block as { tool_use_id?: string }).tool_use_id === 'toolu_ward') as { is_error?: boolean; content?: unknown } | undefined
    const sentWords = typeof sentResult?.content === 'string' ? sentResult.content : JSON.stringify(sentResult?.content ?? '')
    check('the ward\'s tool result rides as an error result', sentResult !== undefined && sentResult.is_error === true, JSON.stringify(sentResult).slice(0, 200))
    check('it names the ward and the matched text', sentWords.includes(`Ward '${verdict.rule.name}' blocked this Bash call`) && sentWords.includes(ROOT_DELETE), sentWords.slice(0, 200))
    check('it carries the closing — do not rephrase, surface the refusal to the operator', sentWords.includes('Do not rephrase the command to evade this rule — surface the refusal to the operator instead.'), sentWords.slice(-160))
    check(`the turns alternate (${wire.roles.join(' → ')})`, alternates(wire.roles), wire.roles.join(','))
  }
}

rmSync(home, { recursive: true, force: true })
console.log(`\n${failures === 0 ? `✅ provider-refusal-off-the-wire PROVEN (${checks} checks)` : `❌ ${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
