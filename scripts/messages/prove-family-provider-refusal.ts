import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const home = mkdtempSync(join(tmpdir(), 'family-refusal-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const { requestConversationPlan } = await import('../../src/utils/messages/apiPlan.ts')
const { createAssistantMessage, createAssistantAPIErrorMessage, createUserMessage } = await import('../../src/utils/messages/factories.ts')
try {
  const user = createUserMessage({ content: 'The original user request.' })
  const thinking = createAssistantMessage({ content: [{ type: 'thinking', thinking: 'Refused thought.', signature: 'fixture-signature' }] })
  const refused = createAssistantMessage({ content: 'Refused words.' })
  thinking.message.id = refused.message.id
  refused.message.stop_reason = 'refusal'
  const error = createAssistantAPIErrorMessage({ content: 'API Error: prior refusal.', error: 'invalid_request' })
  const next = createUserMessage({ content: 'The next user request.' })
  const transcript = [user, thinking, refused, error, next]
  const before = JSON.stringify(transcript)
  const plan = requestConversationPlan(transcript, [], 'family')
  assert.deepEqual(plan.messages.map(row => row.uuid), [user.uuid])
  assert.deepEqual(plan.messages[0]?.message.content, [{ type: 'text', text: 'The original user request.\n' }, { type: 'text', text: 'The next user request.' }])
  assert.deepEqual(plan.selected.filter(row => row.type === 'user').map(row => row.uuid), [user.uuid, next.uuid])
  assert.equal(JSON.stringify(transcript), before)
  const tool = createAssistantMessage({ content: [{ type: 'tool_use', id: 'call_fixture', name: 'Bash', input: { command: 'echo hi' } }] })
  tool.message.id = refused.message.id
  const result = createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'call_fixture', content: 'Ward refused this call.', is_error: true }] })
  const paired = requestConversationPlan([user, thinking, tool, refused, error, result, next], [], 'family')
  const kept = paired.messages.find(row => row.type === 'assistant' && row.message.id === refused.message.id)
  assert(kept && Array.isArray(kept.message.content))
  assert.equal(JSON.stringify(kept.message.content), JSON.stringify([...thinking.message.content, ...tool.message.content, ...refused.message.content]))
  assert(!paired.messages.some(row => row.uuid === error.uuid))
  assert(JSON.stringify(paired.messages).includes('Ward refused this call.'))
  assert.equal(JSON.stringify(paired.messages).match(/"tool_use_id":"call_fixture"/g)?.length, 1)
  console.log('PASS family refusal: omit the complete refused turn and synthetic rows; keep user prompts, paired tools and ward results; never change the transcript')
} finally {
  rmSync(home, { recursive: true, force: true })
}
