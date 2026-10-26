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
const key = 'AIzaFixtureStopReason000000000000000000'
process.env.GEMINI_API_KEY = key
writeFileSync(join(proofHome, '.gemini-auth.json'), JSON.stringify({ version: 1, preferredSource: 'api-key' }))

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { geminiCallModel } = await import('../../src/services/providers/gemini/geminiCallModel.ts')
const { geminiFinishReason } = await import('../../src/services/providers/gemini/geminiClient.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { finalizeAgentTool, finalResponseOf, stoppedPartWay, PROMOTED_NARRATION_NOTE } = await import('../../src/tools/AgentTool/agentToolUtils.ts')
const { createAssistantMessage, createUserMessage } = await import('../../src/utils/messages.ts')
import type { AssistantMessage, Message } from '../../src/types/message.ts'
import type { CompatCallModelParams } from '../../src/services/providers/openaicompat/compatChatCallModel.ts'

let passes = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) passes++
  else failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const j = (value: unknown): string => JSON.stringify(value)
const model = 'gemini-4-argon'
const read = { name: 'Read', prompt: async () => 'Reads a file.', inputSchema: z.object({ path: z.string() }), inputJSONSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }
const user = (content: unknown): Message => ({ type: 'user', uuid: randomUUID(), timestamp: new Date().toISOString(), message: { role: 'user', content } }) as Message
function params(messages: Message[]): CompatCallModelParams {
  return {
    messages, systemPrompt: asSystemPrompt(['Only answer the request.']), thinkingConfig: { type: 'disabled' }, tools: [read] as never, signal: new AbortController().signal,
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
const usage = { promptTokenCount: 2193, candidatesTokenCount: 2068, cachedContentTokenCount: 421558, thoughtsTokenCount: 84 }
let wire: unknown[] = []
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: unknown) => {
  const url = String(input)
  if (!url.startsWith('https://gemini.fixture.invalid/')) throw new Error('unpinned Gemini request')
  if (!url.endsWith(`/models/${model}:streamGenerateContent?alt=sse`)) return Response.json({ error: { message: 'wrong native URL' } }, { status: 404 })
  return sse(wire)
}) as typeof fetch
const shapeOf = (rows: AssistantMessage[]) => rows.map(row => [row.message.content.map(block => block.type).join('+'), row.message.stop_reason ?? null])
const textOf = (rows: AssistantMessage[]) => rows.flatMap(row => row.message.content).filter(block => block.type === 'text').map(block => (block as { text: string }).text).join('')
const toolName = 'proof'
const metadata = { prompt: 'p', resolvedAgentModel: model, isBuiltInAgent: false, startTime: Date.now(), agentType: toolName, isAsync: true }

try {
  console.log('── (a) the transcript shape: the signature rides the last part, after the answer text streamed ──')
  wire = [
    { candidates: [{ content: { role: 'model', parts: [{ text: 'I have written and verified ' }] } }] },
    { candidates: [{ content: { role: 'model', parts: [{ text: 'the renderer spec.' }] } }] },
    { candidates: [{ content: { role: 'model', parts: [{ text: '', thoughtSignature: 'EpQDCpEDAWkUfRPYB5q' }] }, finishReason: 'STOP' }], usageMetadata: usage },
  ]
  const late = await drain(params([user('Write the spec.')]))
  check('the reply settles as the withheld-thinking fact, then the answer text: the fact never trails the answer', j(shapeOf(late)) === j([['thinking', null], ['text', 'end_turn']]), j(shapeOf(late)))
  check('the answer text is whole across its streamed parts', textOf(late) === 'I have written and verified the renderer spec.', textOf(late))
  check('the last minted message carries end_turn and the usage, as every lane stamps them', late.at(-1)?.message.stop_reason === 'end_turn' && (late.at(-1)?.message.usage?.output_tokens ?? 0) > 0, j(late.at(-1)?.message))
  check('the fact keeps the signature for the transcript', (late[0]?.message.content[0] as { signature?: string } | undefined)?.signature === 'EpQDCpEDAWkUfRPYB5q')
  const record = (late.at(-1) as unknown as { geminiProviderTurn?: { parts: unknown[] } }).geminiProviderTurn
  check('the replay record carries the signed text part Google sent', j(record?.parts) === j([{ text: 'I have written and verified the renderer spec.', thoughtSignature: 'EpQDCpEDAWkUfRPYB5q' }]), j(record))
  const transcript: Message[] = [createUserMessage({ content: 'Write the spec.' }), ...late]
  const result = finalizeAgentTool(transcript, 'agent-late', metadata)
  check('the crewmate envelope reads the whole final reply: the answer is the report and nothing is promoted', result.outcome?.status === 'completed' && result.outcome.promotedNarration === false && result.content.length === 1 && result.content[0]!.text === 'I have written and verified the renderer spec.', j(result.outcome) + ' ' + j(result.content))

  console.log('── (b) the same signature arriving with the first text part keeps the shape the F35A-11 proof pins ──')
  wire = [
    { candidates: [{ content: { role: 'model', parts: [{ text: 'pears', thoughtSignature: 'sig-early' }] }, finishReason: 'STOP' }], usageMetadata: usage },
  ]
  const early = await drain(params([user('Fruit?')]))
  check('fact, then text, end_turn on the text', j(shapeOf(early)) === j([['thinking', null], ['text', 'end_turn']]), j(shapeOf(early)))

  console.log("── (c) Gemini's finish reasons map to Mercury's stop reasons ──")
  wire = [
    { candidates: [{ content: { role: 'model', parts: [{ text: 'A very long answer that the ceiling cut' }] }, finishReason: 'MAX_TOKENS' }], usageMetadata: usage },
  ]
  const cut = await drain(params([user('Write a book.')]))
  check('MAX_TOKENS settles as max_tokens on the text', j(shapeOf(cut)) === j([['text', 'max_tokens']]), j(shapeOf(cut)))
  wire = [
    { candidates: [{ content: { role: 'model', parts: [{ text: 'Partial' }] }, finishReason: 'CONTINUATION' }], usageMetadata: usage },
  ]
  const continued = await drain(params([user('Continue.')]))
  check('CONTINUATION (the per-request token limit) settles as max_tokens', j(shapeOf(continued)) === j([['text', 'max_tokens']]), j(shapeOf(continued)))
  wire = [
    { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'Read', args: { path: '/proj/app.py' } }, thoughtSignature: 'sig-call' }] }, finishReason: 'STOP' }], usageMetadata: usage },
  ]
  const call = await drain(params([user('Read it.')]))
  check('a function call settles as tool_use on the tool_use block, the fact ahead of it', j(shapeOf(call)) === j([['thinking', null], ['tool_use', 'tool_use']]), j(shapeOf(call)))
  for (const reason of ['SAFETY', 'SPII', 'RECITATION', 'LANGUAGE', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT', 'IMAGE_RECITATION', 'ESCALATION', 'PUP_LIMITED_DISABLED']) {
    check(`${reason} is a content filter`, geminiFinishReason(reason, false) === 'content_filter')
  }
  check('STOP is stop without calls and tool_calls with them', geminiFinishReason('STOP', false) === 'stop' && geminiFinishReason('STOP', true) === 'tool_calls')
  check('MAX_TOKENS and CONTINUATION are length', geminiFinishReason('MAX_TOKENS', false) === 'length' && geminiFinishReason('CONTINUATION', false) === 'length')
  for (const reason of ['OTHER', 'UNEXPECTED_TOOL_CALL', 'TOO_MANY_TOOL_CALLS', 'MISSING_THOUGHT_SIGNATURE', 'MALFORMED_RESPONSE', 'NO_IMAGE', 'IMAGE_OTHER', 'FINISH_REASON_UNSPECIFIED']) {
    check(`${reason} stays an unmapped termination the note names`, geminiFinishReason(reason, false) === 'other')
  }
  wire = [
    { candidates: [{ content: { role: 'model', parts: [{ text: 'I cannot' }] }, finishReason: 'SPII' }], usageMetadata: usage },
  ]
  const filtered = await drain(params([user('Tell me.')]))
  const filteredText = textOf(filtered)
  check('a filtered reply carries the content-filter note, never a silent end', filteredText.includes('[gemini] the provider ended this response under its content filter'), filteredText)

  console.log('── (d) the crewmate envelope says part-way only when the stop reason says so ──')
  const sibling = (id: string, content: AssistantMessage['message']['content'], stop: AssistantMessage['message']['stop_reason']): AssistantMessage => {
    const row = createAssistantMessage({ content })
    return { ...row, message: { ...row.message, id, stop_reason: stop } }
  }
  const prompt = createUserMessage({ content: 'go' })
  const earlier = sibling('msg-earlier', [{ type: 'text', text: 'Narration from an earlier turn.', citations: null }] as never, 'end_turn')
  const toolRow = sibling('msg-earlier', [{ type: 'tool_use', id: 'call-1', name: 'Read', input: { path: '/a' } }] as never, 'tool_use')
  const toolAnswer = createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'ok' }] as never })

  const geminiShape = finalizeAgentTool([prompt, earlier, toolRow, toolAnswer, sibling('msg-final', [{ type: 'text', text: 'The final report.', citations: null }] as never, null), sibling('msg-final', [{ type: 'thinking', thinking: '', signature: 'sig' }] as never, 'end_turn')], 'agent-a', metadata)
  check('the recorded Gemini shape (text with null, then a signed empty thinking block with end_turn) reports the text, not promoted', geminiShape.outcome?.status === 'completed' && geminiShape.outcome.promotedNarration === false && geminiShape.content[0]?.text === 'The final report.', j(geminiShape.outcome) + ' ' + j(geminiShape.content))

  const anthropicShape = finalizeAgentTool([prompt, sibling('msg-final', [{ type: 'thinking', thinking: 'plan', signature: 'sig' }] as never, null), sibling('msg-final', [{ type: 'text', text: 'Done.', citations: null }] as never, 'end_turn')], 'agent-b', metadata)
  check('the Anthropic shape (thinking, then text with end_turn) reports the text, not promoted', anthropicShape.outcome?.status === 'completed' && anthropicShape.outcome.promotedNarration === false && anthropicShape.content[0]?.text === 'Done.', j(anthropicShape.outcome))

  const cutOff = finalizeAgentTool([prompt, earlier, toolAnswer, sibling('msg-final', [{ type: 'tool_use', id: 'call-2', name: 'Read', input: { path: '/b' } }] as never, 'tool_use')], 'agent-c', metadata)
  check('a run that ended on a tool_use reply promotes the earlier narration and says part-way', cutOff.outcome?.status === 'completed' && cutOff.outcome.promotedNarration === true && cutOff.content[0]?.text === 'Narration from an earlier turn.', j(cutOff.outcome))

  const quietEnd = finalizeAgentTool([prompt, earlier, toolRow, toolAnswer, sibling('msg-final', [{ type: 'thinking', thinking: '', signature: 'sig' }] as never, 'end_turn')], 'agent-d', metadata)
  check('a reply that ended its turn with no text promotes the earlier narration without the part-way note', quietEnd.outcome?.status === 'completed' && quietEnd.outcome.promotedNarration === false && quietEnd.content[0]?.text === 'Narration from an earlier turn.', j(quietEnd.outcome))

  const unsettled = finalizeAgentTool([prompt, earlier, toolRow, toolAnswer, sibling('msg-final', [{ type: 'thinking', thinking: '', signature: 'sig' }] as never, null)], 'agent-e', metadata)
  check('a reply with no stop reason at all is part-way', unsettled.outcome?.status === 'completed' && unsettled.outcome.promotedNarration === true, j(unsettled.outcome))

  const maxed = finalizeAgentTool([prompt, earlier, toolRow, toolAnswer, sibling('msg-final', [{ type: 'thinking', thinking: 'cut', signature: 'sig' }] as never, 'max_tokens')], 'agent-f', metadata)
  check('a reply cut at max_tokens is part-way', maxed.outcome?.status === 'completed' && maxed.outcome.promotedNarration === true, j(maxed.outcome))

  const trailingUser = finalizeAgentTool([prompt, sibling('msg-final', [{ type: 'text', text: 'Report.', citations: null }] as never, 'end_turn'), createUserMessage({ content: 'The check did not count.', isMeta: true })], 'agent-g', metadata)
  check('a user row after the final reply (a stop-hook line) does not hide the reply', trailingUser.outcome?.status === 'completed' && trailingUser.outcome.promotedNarration === false && trailingUser.content[0]?.text === 'Report.', j(trailingUser.outcome))

  const response = finalResponseOf([prompt, earlier, toolRow, toolAnswer, sibling('msg-final', [{ type: 'text', text: 'A', citations: null }] as never, null), sibling('msg-final', [{ type: 'text', text: 'B', citations: null }] as never, 'end_turn')])
  check('the final response is the trailing run of one reply id with its last stop reason', response.messages.length === 2 && response.stopReason === 'end_turn')
  const none: Message[] = []
  check('part-way is every stop reason but a settled end', stoppedPartWay({ messages: none, stopReason: 'tool_use' }) && stoppedPartWay({ messages: none, stopReason: 'max_tokens' }) && stoppedPartWay({ messages: none, stopReason: 'pause_turn' }) && stoppedPartWay({ messages: none, stopReason: 'refusal' }) && stoppedPartWay({ messages: none, stopReason: null }) && !stoppedPartWay({ messages: none, stopReason: 'end_turn' }) && !stoppedPartWay({ messages: none, stopReason: 'stop_sequence' }))
  check('a final reply holding a tool call is part-way whatever its stamped stop reason says', stoppedPartWay({ messages: [sibling('m', [{ type: 'tool_use', id: 'c', name: 'Read', input: {} }] as never, 'stop_sequence')], stopReason: 'stop_sequence' }))
  check('the note text is unchanged', PROMOTED_NARRATION_NOTE.startsWith('[The crewmate stopped part-way through a turn'))
} finally {
  globalThis.fetch = realFetch
}
console.log(`${passes + failures} checks, ${failures} failures`)
process.exit(failures ? 1 : 0)
