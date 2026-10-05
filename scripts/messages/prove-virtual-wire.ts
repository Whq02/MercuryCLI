import { resolve } from 'node:path'
import { DIALECT_CONVERSATION, VIRTUAL_ROW } from './dialectFixture.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const root = resolve(process.argv[2] ?? new URL('../..', import.meta.url).pathname)
const source = (path: string) => import(`${root}/src/${path}.ts`)
const { enableConfigs } = await source('utils/config')
enableConfigs()
const helpers = await source('utils/messages')
const params = await source('services/providers/anthropic/messageParams')
const responses = await source('services/providers/openai/responsesBridge')
const chat = await source('services/providers/zai/zaiCodec')
const gemini = await source('services/providers/gemini/geminiCodec')
const local = await source('services/providers/local/ollamaChatTransport')
const virtualUser = { ...DIALECT_CONVERSATION[0], isVirtual: true, message: { role: 'user', content: 'display-only user fixture' } } as never
const messages = [DIALECT_CONVERSATION[0]!, VIRTUAL_ROW as never, virtualUser, ...DIALECT_CONVERSATION.slice(1)]
const rows = helpers.healWalkableForWire(messages)
const bridge = rows.map((message: any) => message.type === 'user' ? params.userMessageToMessageParam(message, false, false) : params.assistantMessageToMessageParam(message, false, false))
const compatible = chat.buildZaiChatRequest({ model: 'fixture-model', messages: bridge })
const bodies = {
  anthropic: helpers.normalizeMessagesForAPI(messages),
  responses: responses.buildOpenaiResponsesRequest({ model: 'fixture-model', messages: bridge }),
  compatible,
  gemini: gemini.buildGeminiRequest(compatible, messages),
  local: local.ollamaChatBody(compatible, {}),
}
let failures = 0
for (const [name, body] of Object.entries(bodies)) {
  const wire = JSON.stringify(body)
  const good = !wire.includes('a display-only row') && !wire.includes('display-only user fixture')
  console.log(`${good ? 'PASS' : 'FAIL'}: ${name} request excludes display-only user and assistant rows`)
  if (!good) failures++
}
if (messages[1] !== VIRTUAL_ROW || VIRTUAL_ROW.isVirtual !== true) failures++
process.exit(failures ? 1 : 0)
