import '../lib/hermetic.ts'
import assert from 'node:assert/strict'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { createUserMessage, createAssistantMessage, createUserInterruptionMessage } = await import('../../src/utils/messages.ts')
const { requestConversationPlan } = await import('../../src/utils/messages/apiPlan.ts')
const { addCacheBreakpoints } = await import('../../src/services/providers/anthropic/cacheAndUsage.ts')
const { mapMessagesToZai } = await import('../../src/services/providers/zai/zaiCodec.ts')
const { mapMessagesToOpenaiInput } = await import('../../src/services/providers/openai/responsesBridge.ts')
const { buildGeminiRequest } = await import('../../src/services/providers/gemini/geminiCodec.ts')
const { entryToRecord, recordToEntry } = await import('../../src/fabric/entryCodec.ts')
import type { Message } from '../../src/types/message.ts'

const assistant = createAssistantMessage({ content: [
  { type: 'thinking', thinking: 'inspect first', signature: 'signed-fixture' },
  { type: 'tool_use', id: 'call-read', name: 'Read', input: { file_path: '/fixture/source.ts' } },
] as never })
assistant.message.model = 'claude-opus-5-5'
assistant.message.stop_reason = 'tool_use'
const history = [
  createUserMessage({ content: 'inspect and edit' }),
  assistant,
  createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'call-read', content: 'source contents' }] }),
  createUserInterruptionMessage({ toolUse: false }),
  createUserMessage({ content: '<task-notification><status>message</status><message>resume the edit</message></task-notification>' }),
  createUserInterruptionMessage({ toolUse: false }),
  createUserMessage({ content: 'do as the lead said' }),
]
let ordinal = 0
const recorded = history.map(message => entryToRecord(message as never, {
  sessionId: 'fixture-session' as never, nextOrdinal: () => String(++ordinal) as never,
  observedAt: new Date().toISOString(), source: { channel: 'sdk' },
}))
const restored = recorded.map(record => recordToEntry(JSON.parse(JSON.stringify(record)))) as Message[]
const before = JSON.stringify(restored)
let failures = 0
const check = (name: string, ok: boolean): void => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) failures++ }
for (const geometry of ['anthropic', 'family'] as const) {
  const plan = requestConversationPlan(restored, [], geometry).messages
  const userRows = geometry === 'anthropic' ? 2 : 3
  check(`${geometry}: TaskStop and both ResumeCrewmate messages share one trailing user row`, plan.filter(message => message.type === 'user').length === userRows && plan.length === userRows + 1)
  const last = JSON.stringify(plan.slice(2).map(message => message.message.content))
  check(`${geometry}: the interruption, result and both resume requests survive in order`, last.indexOf('source contents') !== -1 && last.indexOf('Request interrupted') !== -1 && last.indexOf('resume the edit') !== -1 && last.indexOf('do as the lead said') !== -1 && last.indexOf('source contents') < last.indexOf('Request interrupted') && last.indexOf('Request interrupted') < last.indexOf('resume the edit') && last.indexOf('resume the edit') < last.indexOf('do as the lead said'))
  check(`${geometry}: the assistant and its signed thinking are unchanged`, JSON.stringify(plan.find(message => message.type === 'assistant')?.message.content) === JSON.stringify(assistant.message.content))
  if (geometry === 'anthropic') {
    const wire = addCacheBreakpoints(plan, true)
    check('Anthropic request alternates roles and has no invented assistant stop', wire.map(row => row.role).join(',') === 'user,assistant,user')
  } else {
    check('family replay keeps results separate from the resumed user text', Array.isArray(plan[2]?.message.content) && plan[2].message.content.every(block => block.type === 'tool_result') && Array.isArray(plan[3]?.message.content) && plan[3].message.content.every(block => block.type === 'text'))
    const chat = mapMessagesToZai(undefined, plan.map(message => message.message))
    check('compatible replay preserves tool/result identity with one following user row', chat.map(row => row.role).join(',') === 'user,assistant,tool,user' && chat[2]?.role === 'tool' && chat[2].tool_call_id === 'call-read')
    const openai = mapMessagesToOpenaiInput(plan.map(message => message.message))
    check('Responses replay carries one final user message and the tool output', openai.filter(item => item.type === 'message' && item.role === 'user').length === 2 && openai.some(item => item.type === 'function_call_output' && item.call_id === 'call-read'))
    const gemini = buildGeminiRequest({ model: 'gemini-4-argon', messages: chat as never }, plan)
    check('Gemini replay alternates without changing the stop/resume text', gemini.contents.map(row => row.role).join(',') === 'user,model,user' && JSON.stringify(gemini.contents.at(-1)).includes('do as the lead said'))
  }
  const twice = requestConversationPlan(plan, [], geometry).messages
  check(`${geometry}: preparing the request twice changes no content`, JSON.stringify(twice.map(m => m.message.content)) === JSON.stringify(plan.map(m => m.message.content)))
  const continued = requestConversationPlan([...restored, createAssistantMessage({ content: 'resumed answer' }), createUserMessage({ content: 'next task' })], [], geometry).messages
  check(`${geometry}: the merged resume prefix stays identical on the next request`, JSON.stringify(continued.slice(0, plan.length).map(m => m.message.content)) === JSON.stringify(plan.map(m => m.message.content)))
}
check('the transcript remains separate audit records', JSON.stringify(restored) === before && restored.length === 7)
assert.equal(failures, 0)
