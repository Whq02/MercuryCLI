import assert from 'node:assert/strict'
import { createAssistantMessage, createUserMessage } from '../../src/utils/messages/factories.ts'
import { ensureToolResultPairing } from '../../src/utils/messages/pairing.ts'
import { SYNTHETIC_TOOL_RESULT_PLACEHOLDER } from '../../src/utils/messages/rejectionText.ts'

const call = createAssistantMessage({ content: [{ type: 'tool_use', id: 'unanswered', name: 'Bash', input: { command: 'publish' } }] })
const stored = JSON.stringify(call)
const repaired = ensureToolResultPairing([call])
const result = repaired[1]?.message.content
assert(Array.isArray(result))
assert.equal(result.length, 1)
assert.equal(result[0]?.type, 'tool_result')
const block = result[0] as { content: string; is_error: boolean; tool_use_id: string }
assert.equal(block.tool_use_id, 'unanswered')
assert.equal(block.is_error, true)
assert.equal(block.content, SYNTHETIC_TOOL_RESULT_PLACEHOLDER)
assert.match(block.content, /unknown whether.*started/i, 'absence of a result must not imply that the call never ran')
assert.match(block.content, /read-only or idempotent/i)
assert.match(block.content, /side effects.*(?:verify|check).*state/i)
assert.match(block.content, /do not retry blindly/i)
assert.equal(JSON.stringify(call), stored)
assert.deepEqual(ensureToolResultPairing(repaired), repaired)
const answered = createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'unanswered', content: 'published', is_error: false }] })
assert.deepEqual(ensureToolResultPairing([call, answered]), [call, answered])
console.log('PASS missing results name the unknown start and require safe retry checks')
