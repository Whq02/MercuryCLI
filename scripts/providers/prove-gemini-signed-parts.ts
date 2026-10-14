#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_RECOVERY_BUDGET_MINUTES = '1'
process.env.MERCURY_GEMINI_API_BASE = 'https://gemini.fixture.invalid/v1beta'
for (const name of ['GOOGLE_API_KEY', 'MERCURY_GEMINI_OAUTH_CLIENT_ID', 'MERCURY_GEMINI_OAUTH_CLIENT_SECRET']) delete process.env[name]
const key = 'AIzaFixtureSignedParts00000000000000000'
process.env.GEMINI_API_KEY = key
writeFileSync(join(proofHome, '.gemini-auth.json'), JSON.stringify({ version: 1, preferredSource: 'api-key' }))

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { geminiCallModel } = await import('../../src/services/providers/gemini/geminiCallModel.ts')
const { buildGeminiRequest, GEMINI_SKIP_SIGNATURE_VALIDATION } = await import('../../src/services/providers/gemini/geminiCodec.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { foldSplitTurnsForWire } = await import('../../src/utils/messages/pairing.ts')
import type { AssistantMessage, Message } from '../../src/types/message.ts'
import type { CompatCallModelParams } from '../../src/services/providers/openaicompat/compatChatCallModel.ts'
import type { GeminiContent, GeminiPart } from '../../src/services/providers/gemini/geminiCodec.ts'

let passes = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) passes++
  else failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const model = 'gemini-4-argon'
const bash = { name: 'Bash', prompt: async () => 'Runs a command.', inputSchema: z.object({ command: z.string() }), inputJSONSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }
const read = { name: 'Read', prompt: async () => 'Reads a file.', inputSchema: z.object({ path: z.string() }), inputJSONSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }
const user = (content: unknown): Message => ({ type: 'user', uuid: randomUUID(), timestamp: new Date().toISOString(), message: { role: 'user', content } }) as Message
const toolResult = (id: string, text: string) => ({ type: 'tool_result', tool_use_id: id, content: text })
function params(messages: Message[]): CompatCallModelParams {
  return {
    messages, systemPrompt: asSystemPrompt(['Only answer the request.']), thinkingConfig: { type: 'disabled' }, tools: [bash, read] as never, signal: new AbortController().signal,
    options: { model, querySource: 'main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], hasAppendSystemPrompt: false, mcpTools: [], maxOutputTokensOverride: 64 } as never,
  }
}
async function drain(input: CompatCallModelParams): Promise<AssistantMessage[]> {
  const out: AssistantMessage[] = []
  for await (const item of geminiCallModel(input)) if (item.type === 'assistant') out.push(item)
  return out
}
function sse(chunks: unknown[]): Response {
  return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
}
type Hit = { url: string; key: string | null; body: { contents?: GeminiContent[]; tools?: unknown[] } }
const hits: Hit[] = []
let round = 0
let shape: 'parallel' | 'sequential' | 'text-then-call' = 'parallel'
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = String(input)
  if (!url.startsWith('https://gemini.fixture.invalid/')) throw new Error('unpinned Gemini request')
  const body = JSON.parse(String(init?.body ?? '{}'))
  hits.push({ url, key: new Headers(init?.headers).get('x-goog-api-key'), body })
  if (!url.endsWith(`/models/${model}:streamGenerateContent?alt=sse`)) return Response.json({ error: { message: 'wrong native URL' } }, { status: 404 })
  const unsigned = (body.contents ?? []).flatMap((content: GeminiContent, index: number) => content.role === 'model' ? content.parts.map((part, at) => ({ part, index, at })).filter(({ part, at }) => part.functionCall !== undefined && content.parts.findIndex(p => p.functionCall !== undefined) === at && !part.thoughtSignature) : [])
  if (unsigned.length > 0) {
    const first = unsigned[0]!
    return Response.json({ error: { code: 400, status: 'INVALID_ARGUMENT', message: `Function call is missing a thought_signature in functionCall parts. This is required for tools to work correctly, and missing thought_signature may lead to degraded model performance. Additional data, function call \`default_api:${first.part.functionCall!.name}\` , position ${first.index}. Please refer to https://ai.google.dev/gemini-api/docs/thought-signatures for more details.` } }, { status: 400 })
  }
  round += 1
  if (shape === 'parallel') return sse([
    { candidates: [{ content: { role: 'model', parts: [{ functionCall: { id: `native-${round}-a`, name: 'Bash', args: { command: `echo ${round}a` } }, thoughtSignature: `sig-${round}-a` }, { functionCall: { id: `native-${round}-b`, name: 'Read', args: { path: `/tmp/${round}` } } }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5 } },
  ])
  if (shape === 'text-then-call') return sse([
    { candidates: [{ content: { role: 'model', parts: [{ text: 'Looking.' }] } }] },
    { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'Bash', args: { command: `echo ${round}` } }, thoughtSignature: `sig-${round}` }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5 } },
  ])
  return sse([
    { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'Bash', args: { command: `echo ${round}` } }, thoughtSignature: `sig-${round}` }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5 } },
  ])
}) as typeof fetch

function modelContents(hit: Hit | undefined): GeminiContent[] {
  return (hit?.body.contents ?? []).filter(content => content.role === 'model')
}
function firstCalls(hit: Hit | undefined): GeminiPart[] {
  return modelContents(hit).map(content => content.parts.find(part => part.functionCall !== undefined)).filter((part): part is GeminiPart => part !== undefined)
}
function everyFirstCallSigned(hit: Hit | undefined): boolean {
  const parts = firstCalls(hit)
  return parts.length > 0 && parts.every(part => typeof part.thoughtSignature === 'string' && part.thoughtSignature !== '')
}
function toolCallsOf(messages: AssistantMessage[]): Array<{ id: string; name: string }> {
  return messages.flatMap(message => message.message.content).filter(block => block.type === 'tool_use').map(block => ({ id: (block as { id: string }).id, name: (block as { name: string }).name }))
}

try {
  console.log('── (a) a response with two function calls, only the first signed: the record replays Google\'s own shape ──')
  shape = 'parallel'
  const history: Message[] = [user('Run the two steps.')]
  const first = await drain(params(history))
  const folded1 = foldSplitTurnsForWire(first) as AssistantMessage[]
  check('the API key rides the native wire under its own header', hits.length === 1 && hits[0]!.key === key)
  check('the folded turn carries the recorded native parts: the first call signed, the second unsigned as Google sent them', folded1.length === 1 && JSON.stringify((folded1[0] as unknown as { geminiProviderTurn: { parts: GeminiPart[] } }).geminiProviderTurn.parts.map(p => p.thoughtSignature)) === JSON.stringify(['sig-1-a', undefined]), JSON.stringify((folded1[0] as unknown as { geminiProviderTurn?: unknown }).geminiProviderTurn))
  history.push(...folded1)
  const calls1 = toolCallsOf(folded1)
  history.push(user(calls1.map(call => toolResult(call.id, `${call.name} done`))))
  shape = 'sequential'
  const second = await drain(params(history))
  const replay1 = hits[1]
  check('the next request replays the first call with Google\'s signature and the second call without one, in one model content', modelContents(replay1).length === 1 && JSON.stringify(modelContents(replay1)[0]!.parts.map(p => [p.functionCall?.name, p.thoughtSignature])) === JSON.stringify([['Bash', 'sig-1-a'], ['Read', undefined]]), JSON.stringify(modelContents(replay1)))
  check('both function responses pair the native ids and the bare tool names, no namespace', JSON.stringify((replay1?.body.contents ?? []).at(-1)?.parts.map(p => [p.functionResponse?.id, p.functionResponse?.name])) === JSON.stringify([['native-1-a', 'Bash'], ['native-1-b', 'Read']]), JSON.stringify((replay1?.body.contents ?? []).at(-1)))
  check('Google accepted the replay (no missing-signature refusal) and answered the next call', second.some(m => m.message.content.some(b => b.type === 'tool_use')))

  console.log('── (b) twelve sequential tool rounds, each turn folded from its minted pieces: every model content keeps its signed first call ──')
  const folded2 = foldSplitTurnsForWire(second) as AssistantMessage[]
  history.push(...folded2)
  history.push(user(toolCallsOf(folded2).map(call => toolResult(call.id, `${call.name} done`))))
  let refused: string | undefined
  for (let i = 0; i < 12; i++) {
    const answer = await drain(params(history))
    const refusal = answer.find(m => m.isApiErrorMessage)
    if (refusal) { refused = JSON.stringify(refusal.message.content); break }
    const folded = foldSplitTurnsForWire(answer) as AssistantMessage[]
    history.push(...folded)
    history.push(user(toolCallsOf(folded).map(call => toolResult(call.id, `${call.name} done`))))
  }
  const last = hits.at(-1)
  check('fourteen rounds in, no request was refused for a missing signature (the live shape: position 11 and beyond)', refused === undefined && modelContents(last).length >= 13, refused ?? `model contents=${modelContents(last).length}`)
  check('every model content\'s first function call carries the signature Google gave it', everyFirstCallSigned(last) && firstCalls(last).every((part, index) => index === 0 ? part.thoughtSignature === 'sig-1-a' : part.thoughtSignature === `sig-${index + 1}`), JSON.stringify(firstCalls(last).map(p => p.thoughtSignature)))

  console.log('── (c) a text part before the call, and a history that lost its record (compaction, a transcript from another model): the documented placeholder on the first call ──')
  shape = 'text-then-call'
  const textCall = foldSplitTurnsForWire(await drain(params(history))) as AssistantMessage[]
  history.push(...textCall)
  history.push(user(toolCallsOf(textCall).map(call => toolResult(call.id, `${call.name} done`))))
  shape = 'sequential'
  await drain(params(history))
  const namedHit = hits.at(-1)
  const withText = modelContents(namedHit).at(-1)
  check('a text part before the call rides as recorded and the call keeps its signature', withText?.parts[0]?.text === 'Looking.' && withText.parts[1]?.functionCall?.name === 'Bash' && typeof withText.parts[1]?.thoughtSignature === 'string', JSON.stringify(withText))
  const stripped = history.map(message => {
    if (message.type !== 'assistant') return message
    const { geminiProviderTurn: _dropped, ...rest } = message as AssistantMessage & { geminiProviderTurn?: unknown }
    return rest as Message
  })
  const afterCompaction = await drain(params(stripped))
  const replayStripped = hits.at(-1)
  check('with every record gone the first call of every model content carries the documented placeholder, so Google still accepts the history', !afterCompaction.some(m => m.isApiErrorMessage) && everyFirstCallSigned(replayStripped) && firstCalls(replayStripped).every(part => part.thoughtSignature === GEMINI_SKIP_SIGNATURE_VALIDATION), JSON.stringify(firstCalls(replayStripped).map(p => p.thoughtSignature)))
  const other = buildGeminiRequest({ model: 'gemini-3.5-flash', messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } }] }, { role: 'tool', tool_call_id: 'c1', content: 'ok' }] } as never, [{ type: 'assistant', uuid: randomUUID(), timestamp: '', message: { role: 'assistant', content: [] }, geminiProviderTurn: { model, parts: [{ functionCall: { name: 'Bash', args: { command: 'ls' } }, thoughtSignature: 'sig-other-model' }], calls: [{ id: 'c1', name: 'Bash' }], projection: 'mismatch' } } as never])
  check('a record from another model is never replayed as that model\'s signature: the placeholder rides instead', other.contents[1]?.parts[0]?.thoughtSignature === GEMINI_SKIP_SIGNATURE_VALIDATION, JSON.stringify(other.contents))
  const legacy = buildGeminiRequest({ model: 'gemini-2.5-pro', messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Bash', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'c1', content: 'ok' }] } as never, [])
  check('a model that does not validate signatures (gemini-2.5) sends no placeholder', legacy.contents[1]?.parts[0]?.thoughtSignature === undefined)

  console.log('── (d) the ids: a call Google named and a call Mercury named ride back with their names paired to the results ──')
  const named = modelContents(namedHit)
  const responses = (namedHit?.body.contents ?? []).filter(content => content.role === 'user' && content.parts.some(part => part.functionResponse !== undefined))
  check('Google-named calls keep their ids on the call and the response; Mercury-named calls carry no id and pair by order', named[0]?.parts[0]?.functionCall?.id === 'native-1-a' && responses[0]?.parts[0]?.functionResponse?.id === 'native-1-a' && named[1]?.parts[0]?.functionCall?.id === undefined && responses[1]?.parts[0]?.functionResponse?.id === undefined && responses.every(content => content.parts.every(part => part.functionResponse?.name === 'Bash' || part.functionResponse?.name === 'Read')), JSON.stringify(responses.slice(0, 2)))
  check('no request on this road ever carried the compatibility namespace or endpoint', hits.every(hit => !hit.url.includes('/openai/') && !JSON.stringify(hit.body).includes('default_api')))
} finally {
  globalThis.fetch = realFetch
}
console.log(`\n${passes} passed, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
