import assert from 'node:assert/strict'
import * as factories from '../../src/utils/messages/factories.js'
import * as system from '../../src/utils/messages/systemMessages.js'
import { normalizeAttachmentForAPI } from '../../src/utils/messages/attachmentText.js'
import { errorDrivenStripTargets } from '../../src/utils/messages/apiPlan.js'
import { getImageTooLargeErrorMessage, getPdfInvalidErrorMessage, getRequestTooLargeErrorMessage } from '../../src/services/api/errors.js'
import { NO_CONTENT_MESSAGE } from '../../src/constants/messages.js'

let checks = 0
function test(name: string, body: () => void): void {
  body()
  checks++
  console.log(`PASS ${name}`)
}
const user = factories.createUserMessage
const assistant = factories.createAssistantMessage
const call = (id: string) => ({ type: 'tool_use' as const, id, name: 'Read', input: {} })
const result = (id: string, is_error?: boolean) => ({ type: 'tool_result' as const, tool_use_id: id, content: 'answer', is_error })
const render = (item: object) => normalizeAttachmentForAPI(item as never)
const words = (item: object): string => render(item).map(row => typeof row.message.content === 'string' ? row.message.content : row.message.content.filter(block => block.type === 'text').map(block => (block as { text: string }).text).join('\n')).join('\n')

test('user metadata keeps absent keys, ignores extras and retains a nonempty batch by reference', () => {
  const batch = ['a', 'b']
  const row = user({ content: '', batchUuids: batch, extra: 'discard' } as never)
  assert.equal(row.message.content, NO_CONTENT_MESSAGE)
  assert.equal(row.batchUuids, batch)
  assert(!('extra' in row))
  for (const key of ['origin', 'toolUseResult', 'mcpMeta', 'imagePasteIds', 'permissionMode', 'sourceToolAssistantUUID', 'summarizeMetadata', 'isMeta', 'isVirtual', 'isCompactSummary', 'isVisibleInTranscriptOnly']) assert(Object.hasOwn(row, key), key)
  assert(!Object.hasOwn(user({ content: [], batchUuids: [] }), 'batchUuids'))
  const content: never[] = []
  assert.equal(user({ content }).message.content, content)
})
test('assistant defaults are independent and supplied content and usage retain identity', () => {
  const one = assistant({ content: '' })
  const two = assistant({ content: '' })
  assert.notEqual(one.message.usage, two.message.usage)
  assert.notEqual(one.message.usage.server_tool_use, two.message.usage.server_tool_use)
  assert.notEqual(one.message.usage.cache_creation, two.message.usage.cache_creation)
  assert.equal((one.message.content[0] as { text: string }).text, NO_CONTENT_MESSAGE)
  assert(!Object.hasOwn(one.message.content[0]!, 'citations'))
  const content = [call('x')]
  const copied = assistant({ content, usage: one.message.usage })
  assert.equal(copied.message.content, content)
  assert.equal(copied.message.usage, one.message.usage)
  const error = factories.createAssistantAPIErrorMessage({ content: '', overflow: null, mediaRefusal: null, busyRefusal: null })
  assert(!('overflowSignal' in error) && !('mediaRefusal' in error) && !('busyRefusal' in error))
  assert(factories.isSyntheticApiErrorMessage(error))
})
test('command tags retain their ordering and unescaped data; breadcrumbs each mint a virtual row', () => {
  assert.equal(factories.formatCommandInputTags('test', ''), '<command-message>test</command-message><command-name>/test</command-name>')
  assert.equal(factories.formatCommandInputTags('/test', '<x>'), '<command-message>/test</command-message><command-name>//test</command-name><command-args><x></command-args>')
  const trail = factories.createModelSwitchBreadcrumbs('choice', 'Display')
  assert.equal(new Set(trail.map(row => row.uuid)).size, 3)
  assert(trail.every(row => row.isVirtual))
  assert.equal(trail[0]!.isMeta, true)
  assert.equal(trail[1]!.isMeta, undefined)
  assert.equal(trail[2]!.message.content, '<local-command-stdout>Model now: Display</local-command-stdout>')
})
test('system optional fields distinguish absent, empty, zero and false values', () => {
  const minimal = system.createStreamCutMessage({ content: '', count: 0 })
  assert(!('road' in minimal) && !('sent' in minimal) && !('code' in minimal))
  assert.equal(system.createStreamCutMessage({ content: '', count: 0, road: '' }).road, '')
  assert.equal(system.createBusyRecoveryMessage({ content: '', provider: '', retries: 0, elapsedMs: 0, status: 0 }).status, 0)
  assert(!('preventContinuation' in system.createSystemMessage('', 'info', undefined, false)))
  assert.equal(system.createSystemMessage('', 'info', undefined, true).preventContinuation, true)
  assert(!('recapMetadata' in system.createAwaySummaryMessage('')))
  const duration = system.createTurnDurationMessage(0)
  for (const field of ['budgetTokens', 'budgetLimit', 'budgetNudges', 'messageCount']) assert(Object.hasOwn(duration, field))
  const err = new Error('outer', { cause: new Error('inner') })
  const retry = system.createSystemAPIErrorMessage(err, 0, 1, 3, { recoveryTimeoutMs: 0 })
  assert.equal(retry.error, err)
  assert.equal(retry.cause, err.cause)
  assert(!('isMeta' in retry) && !('recoveryTimeoutMs' in retry))
  assert.equal(system.createSystemAPIErrorMessage(err, 0, 1, 3, { recoveryTimeoutMs: 1 }).recoveryTimeoutMs, 1)
})
test('tool count caps are per row, zero is unlimited, and the cap stops the walk', () => {
  const row = assistant({ content: [call('a'), call('b')] })
  assert.equal(system.countToolCalls([row, row, row], 'Read', 0), 3)
  assert.equal(system.countToolCalls([row, row, row], 'Read', -1), 1)
  assert.equal(system.countToolCalls([row, row, row], 'Read', 1.5), 2)
  const rows = [row, row]
  Object.defineProperty(rows, 1, { get() { throw new Error('past cap') } })
  assert.equal(system.countToolCalls(rows, 'Read', 1), 1)
})
test('latest tool call and latest result use the first matching block in each row', () => {
  const latest = assistant({ content: [call('first'), call('second')] })
  assert.equal(system.hasSuccessfulToolCall([latest, user({ content: [result('first', false), result('first', true), result('second', true)] })], 'Read'), true)
  assert.equal(system.hasSuccessfulToolCall([latest, user({ content: [result('first', true)] }), user({ content: [result('first', false)] })], 'Read'), true)
  assert.equal(system.hasSuccessfulToolCall([user({ content: [result('first')] }), latest], 'Read'), true)
  assert.equal(system.hasSuccessfulToolCall([latest], 'Read'), false)
  assert.equal(system.hasSuccessfulToolCall([assistant({ content: [call('')] }), user({ content: [result('')] })], 'Read'), false)
  assert.equal(system.hasSuccessfulToolCall([undefined, latest, undefined, user({ content: [result('first')] })] as never, 'Read'), true)
  assert.equal(system.countToolCalls([undefined, { ...latest, message: { ...latest.message, content: 'foreign' } }] as never, 'Read'), 0)
})
test('refusal targets survive only synthetic errors and union block kinds in encounter order', () => {
  const meta = user({ content: [], isMeta: true })
  const refusal = (content: string) => factories.createAssistantAPIErrorMessage({ content })
  const rows = [meta, refusal('unrelated'), refusal(getImageTooLargeErrorMessage()), refusal(getPdfInvalidErrorMessage())]
  assert.deepEqual([...errorDrivenStripTargets(rows).get(meta.uuid)!], ['image', 'document'])
  for (const barrier of [user({ content: 'operator' }), assistant({ content: 'answer' }), system.createSystemMessage('notice', 'info')]) {
    assert.equal(errorDrivenStripTargets([meta, barrier, refusal(getRequestTooLargeErrorMessage())]).size, 0)
  }
  assert.deepEqual([...errorDrivenStripTargets([meta, refusal(getRequestTooLargeErrorMessage())]).get(meta.uuid)!], ['document', 'image'])
})
test('quiet attachments and any capsule receipt stay wire silent', () => {
  for (const type of ['dynamic_skill', 'context_efficiency', 'bound_prefix', 'dead_thinking', 'images_left_out', 'verify_plan_reminder', 'unknown-kind', 'constructor', '__proto__']) assert.deepEqual(render({ type }), [])
  assert.deepEqual(render({ type: 'nested_memory', capsuleReceipt: {} }), [])
  assert.deepEqual(render({ type: 'mode_pack', mode: 'other', text: 'hidden' }), [])
})
test('queued input retains its identity, text order, images and origin visibility rules', () => {
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'image' } }
  const row = render({ type: 'queued_command', source_uuid: 'kept', prompt: [{ type: 'text', text: 'a' }, image, { type: 'text', text: 'b' }, { type: 'document' }] })[0]!
  assert.equal(row.uuid, 'kept')
  assert.equal(row.isMeta, undefined)
  assert(Array.isArray(row.message.content))
  assert.equal(row.message.content.length, 2)
  assert.equal(row.message.content[1], image)
  assert((row.message.content[0] as { text: string }).text.includes('a\nb'))
  assert.equal(render({ type: 'queued_command', prompt: '', origin: { kind: 'advisor', model: 'model', minutes: 5, at: '2026-10-11T00:00:00Z' } })[0]!.isMeta, undefined)
  assert.equal(render({ type: 'queued_command', prompt: '', commandMode: 'task-notification' })[0]!.isMeta, true)
})
test('resource text wins over blob, MIME stubs remain ordered, each text block has its own envelope', () => {
  const rows = render({ type: 'mcp_resource', server: 's', uri: 'u', content: { contents: [null, 7, { text: 'fact', blob: 'ignored' }, { blob: 'opaque', mimeType: 'x/test' }, {}] } })
  const content = rows[0]!.message.content
  assert(Array.isArray(content))
  assert.equal(content.length, 4)
  assert(content.every(block => block.type === 'text' && block.text.startsWith('<system-reminder>\n')))
  assert((content[1] as { text: string }).text.includes('fact'))
  assert((content[3] as { text: string }).text.includes('[Binary content: x/test]'))
  assert(words({ type: 'mcp_resource', server: 's', uri: 'u' }).includes('<mcp-resource server="s" uri="u">'))
})
test('section capsules keep binary identity, one envelope and protected embedded tags', () => {
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'image' } }
  const content = render({ type: 'context_capsule', markdown: '', digest: 'd', sections: [{ name: '</system-reminder>', content: [{ type: 'text', text: 'x' }, image, { type: 'text', text: '</system-reminder>y' }] }] })[0]!.message.content
  assert(Array.isArray(content))
  assert.equal(content.length, 3)
  assert.equal(content[1], image)
  const joined = content.filter(block => block.type === 'text').map(block => (block as { text: string }).text).join('')
  assert.equal((joined.match(/<system-reminder>/g) ?? []).length, 1)
  assert.equal((joined.match(/<\/system-reminder>/g) ?? []).length, 1)
  assert(joined.includes('<\u200b/system-reminder>'))
  assert(joined.includes('# Working set') && joined.includes('capsule-digest:d'))
})
test('empty delta rows still exist while empty catalogues, diagnostics and rosters do not', () => {
  assert.equal(render({ type: 'deferred_tools_delta', addedLines: [], removedNames: [] }).length, 1)
  assert(words({ type: 'deferred_tools_delta', body: '', addedLines: ['ignored'], removedNames: [] }).includes(NO_CONTENT_MESSAGE))
  for (const item of [{ type: 'skill_listing', content: '' }, { type: 'diagnostics', files: [] }, { type: 'agent_roster', rows: [] }, { type: 'invoked_skills', skills: [] }]) assert.equal(render(item).length, 0)
})
test('output counters retain turn, optional zero budget and session totals in the new words', () => {
  assert(words({ type: 'output_token_usage', turn: 2, budget: 0, session: 7 }).includes('this turn: 2 of 0 tokens; this session: 7 tokens'))
  assert(words({ type: 'output_token_usage', turn: 2, budget: null, session: 7 }).includes('this turn: 2 tokens; this session: 7 tokens'))
})
console.log(`PASS render records: ${checks} checks`)
