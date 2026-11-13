#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { foldTokens, renderFoldPrompt, sharedFoldTokens, startTensorFoldPromptFixture, type FoldReply, type FoldRequest, type FoldRow, type FoldTemplate } from './tensorfoldPromptFixture.ts'

const HOME = mkdtempSync(join(tmpdir(), 'tensorfold-resumed-conversation-proof-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_LOCAL_API_KEY
delete process.env.MERCURY_LOCAL_BASE_URL

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { refreshLocalDiscovery } = await import('../../src/services/providers/local/localDiscovery.ts')
const { localRecordFor } = await import('../../src/services/providers/local/localCatalogue.ts')
const { localLaneProfileFor } = await import('../../src/services/providers/local/localCallModel.ts')
const { compatChatCallModel } = await import('../../src/services/providers/openaicompat/compatChatCallModel.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
const usageLedger = await import('../../src/services/providers/local/tensorfoldUsage.ts')
type LocalModelRecord = import('../../src/services/providers/local/localDiscovery.ts').LocalModelRecord
type AssistantMessage = import('../../src/types/message.ts').AssistantMessage

const READ = FileReadTool.name
const FILE = Array.from({ length: 40 }, (_, n) => `${n + 1}\tledger line ${n + 1}: a delivery of ${(n * 37) % 91} crates to bay ${(n * 13) % 17}`).join('\n')

async function ask(record: LocalModelRecord, messages: unknown[]): Promise<AssistantMessage[]> {
  const minted: AssistantMessage[] = []
  for await (const item of compatChatCallModel(localLaneProfileFor(record), {
    messages: messages as never,
    systemPrompt: ['You are a careful assistant in a terminal. A file is read before it is described.'] as never,
    thinkingConfig: { type: 'enabled', budget_tokens: 1024 } as never,
    tools: [FileReadTool] as never,
    signal: new AbortController().signal,
    options: { getToolPermissionContext: async () => getEmptyToolPermissionContext(), model: `local/${record.id}`, isNonInteractiveSession: true, querySource: 'agent:builtin:test', agents: [], hasAppendSystemPrompt: false, mcpTools: [], effortValue: 'high' } as never,
  })) {
    if ((item as { type?: string }).type === 'assistant' && (item as { isApiErrorMessage?: boolean }).isApiErrorMessage !== true) minted.push(item as AssistantMessage)
  }
  return minted
}

type Step = { user: string } | { result: string }
type Turned = { requests: FoldRequest[]; kinds: string[] }
const CONVERSATION: Array<{ step: Step; reply: FoldReply; kind: string }> = [
  { step: { user: 'Read /work/alpha.txt and tell me the number it holds.' }, reply: { reasoning: 'The user wants the number in alpha.txt. I should read the file first.', call: { name: READ, arguments: { file_path: '/work/alpha.txt' } } }, kind: 'turn 1, the question' },
  { step: { result: FILE }, reply: { reasoning: 'The first forty lines hold no number yet. I will read on from line 41.', call: { name: READ, arguments: { file_path: '/work/alpha.txt', offset: 41 } } }, kind: 'turn 1, after a tool result' },
  { step: { result: `${FILE}\n41\tThe number is 42.` }, reply: { reasoning: 'Line 41 states the number.', text: 'The number is 42.' }, kind: 'turn 1, after a tool result' },
  { step: { user: 'Now read /work/beta.txt and tell me the colour it names.' }, reply: { reasoning: 'A new file. I need to read beta.txt before answering.', call: { name: READ, arguments: { file_path: '/work/beta.txt' } } }, kind: 'turn 2, a new user message after a turn with tool calls' },
  { step: { result: `${FILE}\n41\tThe colour is green.` }, reply: { reasoning: 'Line 41 names the colour.', text: 'The colour is green.' }, kind: 'turn 2, after a tool result' },
  { step: { user: 'What is that number doubled?' }, reply: { reasoning: '42 doubled is 84.', text: '84' }, kind: 'turn 3, a new user message after a turn with tool calls' },
  { step: { user: 'And halved?' }, reply: { reasoning: '42 halved is 21.', text: '21' }, kind: 'turn 4, a new user message after a plain reply' },
]

async function converse(template: FoldTemplate, model: string): Promise<Turned & { record: LocalModelRecord | undefined }> {
  const fixture = startTensorFoldPromptFixture({ model, template })
  process.env.MERCURY_LOCAL_PROBE_TARGETS = `tensorfold=${fixture.root}`
  await refreshLocalDiscovery({ force: true })
  const record = localRecordFor(`local/${model}`)
  const kinds: string[] = []
  if (record !== undefined && record.server === 'tensorfold') {
    let history: unknown[] = []
    let lastUse: string | undefined
    for (const { step, reply, kind } of CONVERSATION) {
      history = [...history, 'user' in step ? createUserMessage({ content: step.user }) : createUserMessage({ content: [{ type: 'tool_result', tool_use_id: lastUse, content: step.result }] as never })]
      fixture.reply(reply)
      const minted = await ask(record, history)
      history = [...history, ...minted]
      lastUse = (minted.flatMap(row => row.message.content as Array<{ type: string; id?: string }>).find(block => block.type === 'tool_use'))?.id
      kinds.push(kind)
    }
  }
  const requests = [...fixture.requests]
  fixture.stop()
  return { requests, kinds, record }
}

function assistantRows(request: FoldRequest): FoldRow[] {
  return request.rows.filter(row => row.role === 'assistant')
}

function withoutEarlierReasoning(rows: readonly FoldRow[]): FoldRow[] {
  const lastUser = rows.findLastIndex(row => row.role === 'user')
  return rows.map((row, index) => {
    if (row.role !== 'assistant' || index > lastUser || row.reasoning_content === undefined) return row
    const { reasoning_content: _dropped, ...rest } = row
    return rest
  })
}

section('1 · an engine whose template renders the reasoning of every assistant row a client sends (the Qwen3.8-27B checkpoint\'s): every request resumes the whole of the one before it')
{
  usageLedger.__resetTensorFoldUsageForTest()
  const { requests, kinds, record } = await converse('every-row', 'qwen3.8-27b')
  check('the fixture is discovered as a TensorFold record', record?.server === 'tensorfold', JSON.stringify(record))
  check('seven requests reached the engine, one a step of the conversation', requests.length === CONVERSATION.length, String(requests.length))
  const short = requests.map((request, index) => (index === 0 ? null : { at: index + 1, kind: kinds[index], cached: request.cachedTokens, before: requests[index - 1]!.promptTokens })).filter((row): row is NonNullable<typeof row> => row !== null && row.cached !== row.before)
  check('every request after the first reports, as cached tokens, every prompt token of the request before it', requests.length > 1 && short.length === 0, JSON.stringify(short))
  const turnStarts = requests.map((request, index) => ({ request, index })).filter(({ index }) => index > 0 && kinds[index]!.includes('a new user message'))
  check('the first request of a new user turn after a turn with tool calls resumes that whole turn (the engine read 6,538 of 15,427 tokens there before)', turnStarts.length === 3 && turnStarts.slice(0, 2).every(({ request, index }) => request.cachedTokens === requests[index - 1]!.promptTokens), JSON.stringify(turnStarts.map(({ request, index }) => [request.cachedTokens, requests[index - 1]!.promptTokens])))
  const last = requests.at(-1)
  const reasoned = last === undefined ? [] : assistantRows(last).map(row => row.reasoning_content)
  check('the last request carries each of the six earlier replies with the reasoning the model wrote', reasoned.length === 6 && reasoned.every((text, index) => text === CONVERSATION[index]!.reply.reasoning), JSON.stringify(reasoned))
  const earlierForm = last === undefined ? 0 : sharedFoldTokens(foldTokens(requests.at(-2)!.rendered), foldTokens(renderFoldPrompt(withoutEarlierReasoning(last.rows), 'every-row')))
  check('the same rows without the earlier reasoning would part from the held prompt at the first reply of the turn before', last !== undefined && earlierForm < requests.at(-2)!.promptTokens, `${earlierForm} of ${requests.at(-2)?.promptTokens}`)
  const readings = usageLedger.tensorFoldTurnReadings()
  check('Mercury\'s own usage reading carries the engine\'s cached tokens for every request', readings.length === requests.length && readings.every((reading, index) => reading.cachedTokens === requests[index]!.cachedTokens && reading.promptTokens === requests[index]!.promptTokens), JSON.stringify(readings.map(reading => [reading.promptTokens, reading.cachedTokens])))
  const prompt = requests.reduce((sum, request) => sum + request.promptTokens, 0)
  const cached = requests.reduce((sum, request) => sum + request.cachedTokens, 0)
  const session = usageLedger.tensorFoldUsageLines().find(line => line.startsWith('this session'))
  check('the session line of /usage states that share', session !== undefined && session.includes(`${prompt.toLocaleString()} in (${cached.toLocaleString()} cached`), String(session))
}

section('2 · an engine whose template drops reasoning before the last user message itself (the Qwen3.5-2B checkpoint\'s): the rendered prompt is what it was')
{
  const { requests, record } = await converse('after-last-user', 'qwen3.5-2b')
  check('the fixture is discovered as a TensorFold record', record?.server === 'tensorfold', JSON.stringify(record))
  const moved = requests.map((request, index) => ({ at: index + 1, same: renderFoldPrompt(withoutEarlierReasoning(request.rows), 'after-last-user') === request.rendered })).filter(row => !row.same)
  check('every request renders token for token as the same rows without their earlier reasoning do', requests.length === CONVERSATION.length && moved.length === 0, JSON.stringify(moved))
  const third = requests[3]
  check('a new user turn there still parts at the first reply of the turn before, which is the template\'s rule and not a row Mercury sends', third !== undefined && third.cachedTokens < requests[2]!.promptTokens && third.cachedTokens === sharedFoldTokens(foldTokens(requests[2]!.rendered), foldTokens(third.rendered)), JSON.stringify(third && [third.cachedTokens, requests[2]!.promptTokens]))
  const continuations = requests.map((request, index) => ({ request, index })).filter(({ index }) => index === 1 || index === 2 || index === 4)
  check('a continuation inside a turn resumes the whole request before it on this template too', continuations.every(({ request, index }) => request.cachedTokens === requests[index - 1]!.promptTokens), JSON.stringify(continuations.map(({ request, index }) => [request.cachedTokens, requests[index - 1]!.promptTokens])))
}

section('3 · the other local servers keep the rule they had')
{
  const ollama: LocalModelRecord = { id: 'qwen3.5:9b', server: 'ollama', baseUrl: 'http://127.0.0.1:9/v1', toolsDeclared: true, thinkingDeclared: true, family: 'qwen3', parameterSize: '9B' }
  const llamacpp: LocalModelRecord = { id: 'glm-4.7-flash', server: 'llamacpp', baseUrl: 'http://127.0.0.1:9/v1', toolsDeclared: true, family: 'glm4', parameterSize: '30B' }
  const fold: LocalModelRecord = { id: 'qwen3.8-27b', server: 'tensorfold', baseUrl: 'http://127.0.0.1:9/v1', toolsDeclared: true, thinkingDeclared: true }
  const history = (record: LocalModelRecord): boolean => (localLaneProfileFor(record) as { keepsReasoningHistory?: (model: string) => boolean }).keepsReasoningHistory?.(record.id) === true
  const continuations = (record: LocalModelRecord): boolean => (localLaneProfileFor(record) as { keepsReasoningOnContinuations?: (model: string) => boolean }).keepsReasoningOnContinuations?.(record.id) === true
  check('a TensorFold record keeps the reasoning of every turn', history(fold) && continuations(fold))
  check('an Ollama and a llama.cpp record keep it on the running turn only', !history(ollama) && !history(llamacpp) && continuations(ollama) && continuations(llamacpp))
}

console.log(`\nprove-tensorfold-resumed-conversation: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
