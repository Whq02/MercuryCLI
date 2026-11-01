import '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { Message } from '../../src/types/message.ts'
import type { CompatChatRequest, CompatMessage } from '../../src/services/providers/openaicompat/compatChatClient.ts'
import type { GeminiContent, GeminiTurnItem } from '../../src/services/providers/gemini/geminiCodec.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { buildTool, getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { tool } = await import('../../src/services/crewBoard/implementation.ts')
const { toolToAPISchema } = await import('../../src/utils/api.ts')
const { mapToolsToZai } = await import('../../src/services/providers/zai/zaiCodec.ts')
const { buildGeminiRequest, buildGeminiPlanRequest } = await import('../../src/services/providers/gemini/geminiCodec.ts')

let failures = 0
function check(name: string, test: () => void): void {
  try { test(); console.log(`PASS ${name}`) }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`) }
}
const model = 'gemini-4-argon-high'
const board = tool({ buildTool, principal: () => null, paused: () => false, sessionOn: () => false }, () => null)
const schema = await toolToAPISchema(board, { tools: [board], agents: [], model, getToolPermissionContext: async () => getEmptyToolPermissionContext() })
assert('name' in schema && 'input_schema' in schema)
const request: CompatChatRequest = {
  model,
  messages: [{ role: 'user', content: 'Read the board and continue.' }],
  tools: mapToolsToZai([schema]),
  extra: { reasoning_effort: 'high', max_tokens: 65536 },
}
const saved: Message[] = []
const boundaries: string[] = []
for (let round = 0; round < 4; round++) {
  const ids = [`call-${round}-a`, `call-${round}-b`]
  const row: CompatMessage = { role: 'assistant', content: null, tool_calls: ids.map(id => ({ id, type: 'function', function: { name: 'CrewBoard', arguments: '{"op":"read"}' } })) }
  const turn: GeminiTurnItem = {
    model,
    parts: ids.map((id, index) => ({ functionCall: { id, name: 'CrewBoard', args: { op: 'read' } }, ...(index === 0 ? { thoughtSignature: `signed-turn-${round}` } : {}) })),
    calls: ids.map(id => ({ id, name: 'CrewBoard', nativeId: id })),
    projection: JSON.stringify(row),
  }
  saved.push({ type: 'assistant', geminiProviderTurn: turn } as Message)
  const boundary = `<system-reminder>Peer task data ${round}: @main\n{"refs":[],"about":null,"values":[[null,"note"]]}\n</system-reminder>`
  boundaries.push(boundary)
  request.messages.push(row, { role: 'tool', tool_call_id: ids[1], content: `second result ${round}` }, { role: 'user', content: boundary }, { role: 'tool', tool_call_id: ids[0], content: `first result ${round}` }, { role: 'user', content: `next note ${round}` })
}
const envelope = { projectId: 'fixture-project', requestId: 'fixture-request', sessionId: 'fixture-session', labels: {} }
const native = buildGeminiRequest(request, saved)
const before = JSON.stringify({ request, saved, native })
const wire = buildGeminiPlanRequest(native, model, envelope)
const inner = wire.request as { contents: GeminiContent[]; tools: Array<{ functionDeclarations: Array<{ name: string; parameters: Record<string, unknown> }> }>; generationConfig: unknown; toolConfig: unknown }
check('the plan keeps boundary text inside the last ordered function response', () => {
  const users = inner.contents.filter(content => content.parts.some(part => part.functionResponse))
  assert.equal(users.length, 4)
  for (const [round, content] of users.entries()) {
    assert.equal(content.parts.some(part => part.text !== undefined), false)
    assert.deepEqual(content.parts.map(part => part.functionResponse?.id), [`call-${round}-a`, `call-${round}-b`])
    assert.deepEqual(content.parts.map(part => part.functionResponse?.name), ['CrewBoard', 'CrewBoard'])
    assert.equal(content.parts[0]!.functionResponse!.response.output, `first result ${round}`)
    assert.equal(content.parts[1]!.functionResponse!.response.output, `second result ${round}\n\n${boundaries[round]}\n\nnext note ${round}`)
  }
})
check('model parts, signed thinking, effort and output ceiling remain intact', () => {
  assert.deepEqual(inner.contents.filter(content => content.role === 'model'), native.contents.filter(content => content.role === 'model'))
  assert.deepEqual(inner.generationConfig, { maxOutputTokens: 65536, thinkingConfig: { thinkingLevel: 'HIGH' } })
  assert.deepEqual(inner.toolConfig, { functionCallingConfig: { mode: 'VALIDATED' } })
})
check('CrewBoard keeps its real declaration and every accepted schema constraint', () => {
  const declaration = inner.tools[0]!.functionDeclarations[0]!
  assert.equal(declaration.name, board.name)
  const parameters = declaration.parameters as { properties: Record<string, any>; additionalProperties: boolean }
  assert.deepEqual(parameters.properties.op.enum, ['read', 'post', 'swarm_team'])
  assert.equal(parameters.properties.refs.items.properties.digest.pattern, '^[a-f0-9]{40,64}$')
  assert.equal(parameters.properties.clientOpId.minLength, 1)
  assert.equal(parameters.properties.clientOpId.maxLength, 160)
  assert.equal(parameters.properties.refs.maxItems, 8)
  assert.equal(parameters.properties.since.maximum, Number.MAX_SAFE_INTEGER)
  assert.equal(parameters.additionalProperties, false)
})
check('the native API wire and the stored replay are not mutated', () => {
  assert.equal(JSON.stringify({ request, saved, native }), before)
  assert(native.contents.some(content => content.parts.some(part => part.functionResponse) && content.parts.some(part => part.text)))
  assert.deepEqual(buildGeminiPlanRequest(native, model, envelope), wire)
})
check('plain text, images and response errors survive without duplication', () => {
  const image = { inlineData: { mimeType: 'image/png', data: 'fixture-image' } }
  const edge = { contents: [{ role: 'user' as const, parts: [{ text: 'plain user text' }] }, { role: 'model' as const, parts: [{ functionCall: { name: 'CrewBoard' }, thoughtSignature: 'signed-error' }] }, { role: 'user' as const, parts: [{ text: 'before' }, { functionResponse: { id: 'refused', name: 'CrewBoard', response: { error: 'invalid input' } } }, image, { text: '' }, { text: 'after' }] }] }
  const packed = (buildGeminiPlanRequest(edge, model, envelope).request as { contents: GeminiContent[] }).contents
  assert.deepEqual(packed[0], edge.contents[0])
  assert.deepEqual(packed[1], edge.contents[1])
  assert.deepEqual(packed[2]!.parts, [{ functionResponse: { id: 'refused', name: 'CrewBoard', response: { error: 'invalid input', output: 'before\n\n\n\nafter' } } }, image])
})
check('bare INVALID_ARGUMENT retry wording and its same/same/plain ladder stay unchanged', () => {
  const source = readFileSync(new URL('../../src/services/providers/gemini/geminiCallModel.ts', import.meta.url), 'utf8')
  for (const text of ["const GEMINI_PLAN_BARE_INVALID_ARGUMENT = 'Request contains an invalid argument.'", 'for (let attempt = 0; attempt < 3; attempt++)', 'plainTools = attempt === 1', 'HTTP ${facts.status ?? \'?\'} after ${seconds}, before any answer byte', '(INVALID_ARGUMENT, no detail); ${attempts}.', "kind === 'plain' ? 'plain function calling' : 'the same shape'"]) assert(source.includes(text), text)
})
process.exitCode = failures ? 1 : 0
