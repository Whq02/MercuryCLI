import assert from 'node:assert/strict'
import { resolve, join } from 'node:path'

const sourceAt = process.argv.indexOf('--source-root')
const root = sourceAt < 0 ? resolve(import.meta.dir, '../..') : resolve(process.argv[sourceAt + 1]!)
const F = await import(join(root, 'src/utils/messages/factories.ts'))
const S = await import(join(root, 'src/utils/messages/systemMessages.ts'))
const A = await import(join(root, 'src/utils/messages/attachmentText.ts'))
const P = await import(join(root, 'src/utils/messages/apiPlan.ts'))
const C = await import(join(root, 'src/utils/messages/rejectionText.ts'))
const E = await import(join(root, 'src/services/api/errors.ts'))
const T = await import(join(root, 'src/services/api/transportEvidence.ts'))
const O = await import(join(root, 'src/services/compact/operatorMessages.ts'))
const N = await import(join(root, 'src/constants/messages.ts'))
const X = await import(join(root, 'src/constants/xml.ts'))
const I = await import(join(root, 'src/utils/messages/imageRequestFit.ts'))
let checks = 0
const only = process.argv.find(arg => arg.startsWith('--only='))?.slice(7)
function test(name: string, body: () => void): void {
  if (only !== undefined && name !== only) return
  body()
  console.log(`PASS ${name}`)
  checks++
}
const call = (id: string, name = 'Read') => ({ type: 'tool_use', id, name, input: {} })
const answer = (content: unknown) => F.createAssistantMessage({ content })
const user = (content: unknown, isMeta?: true) => F.createUserMessage({ content, isMeta })
const render = (item: object) => A.normalizeAttachmentForAPI(item)
const reminder = (body: string) => `<system-reminder>\n${body.replace(/<(\/?)system-reminder/g, '<\u200b$1system-reminder')}\n</system-reminder>`
const bodyOf = (item: object) => render(item)[0]?.message.content
function systemShape(row: Record<string, unknown>, subtype: string, payload: object): void {
  const { uuid, timestamp, ...record } = row
  assert.equal(typeof uuid, 'string')
  assert.equal(typeof timestamp, 'string')
  assert.deepEqual(record, { type: 'system', subtype, isMeta: false, ...payload })
}

test('countToolCalls', () => {
  const twoBlocks = answer([call('a'), call('b')])
  for (const [cap, expected] of [[undefined, 3], [0, 3], [NaN, 3], [Infinity, 3], [-Infinity, 1], [-1, 1], [1, 1], [1.5, 2], [4, 3]] as const) {
    assert.equal(S.countToolCalls([twoBlocks, twoBlocks, twoBlocks], 'Read', cap), expected)
    assert.equal(S.countToolCalls([], 'Read', cap), 0)
  }
  const sparse = new Array(3)
  sparse[2] = call('after-hole')
  assert.equal(S.countToolCalls([answer(sparse)], 'Read'), 1)
  assert.equal(S.countToolCalls([answer(new Array(3))], 'Read'), 0)
  assert.equal(S.countToolCalls([undefined, null, answer('foreign'), user([]), twoBlocks], 'Read'), 1)
  const stopRows = [twoBlocks, twoBlocks]
  Object.defineProperty(stopRows, 1, { get() { throw new Error('walked past cap') } })
  assert.equal(S.countToolCalls(stopRows, 'Read', 1), 1)
  const appended: unknown[] = []
  const mutating = answer([])
  Object.defineProperty(mutating.message, 'content', { get() { if (appended.length === 1) appended.push(twoBlocks); return [] } })
  appended.push(mutating)
  assert.equal(S.countToolCalls(appended, 'Read'), 1)
})

test('isSyntheticMessage', () => {
  for (const value of F.SYNTHETIC_MESSAGES) {
    const content = [{ type: 'text', text: value }]
    assert.equal(F.isSyntheticMessage(user(content)), true)
    assert.equal(F.isSyntheticMessage(answer(content)), true)
    assert.equal(F.isSyntheticMessage(user(value)), false)
    assert.equal(F.isSyntheticMessage(user([{ type: 'text', text: 'ordinary' }, ...content])), false)
    for (const type of ['system', 'progress', 'attachment']) {
      assert.equal(F.isSyntheticMessage({ type, message: { content } }), false)
      const hostile = { type }
      Object.defineProperty(hostile, 'message', { get() { throw new Error('non-turn content read') } })
      assert.equal(F.isSyntheticMessage(hostile), false)
    }
  }
  assert.equal(F.isSyntheticMessage(user([])), false)
  assert.equal(F.isSyntheticMessage(answer([{ type: 'thinking', thinking: C.INTERRUPT_MESSAGE, signature: '' }])), false)
})

test('createToolResultStopMessage', () => {
  const expected = { type: 'tool_result', content: C.CANCEL_MESSAGE, is_error: true, tool_use_id: 'call' }
  const one = F.createToolResultStopMessage('call')
  const two = F.createToolResultStopMessage('call')
  assert.deepEqual(one, expected)
  assert.deepEqual(two, expected)
  assert.notEqual(one, two)
  one.content = 'changed'
  assert.equal(two.content, C.CANCEL_MESSAGE)
  assert.equal(F.createToolResultStopMessage('').tool_use_id, '')
})

test('prepareUserContent', () => {
  assert.equal(F.prepareUserContent({ inputString: '', precedingInputBlocks: [] }), '')
  const image = { type: 'image', source: {} }
  const prefix = [image]
  const next = F.prepareUserContent({ inputString: '', precedingInputBlocks: prefix })
  assert.notEqual(next, prefix)
  assert.equal(next[0], image)
  assert.deepEqual(next[1], { type: 'text', text: '' })
  assert.equal(prefix.length, 1)
  const sparse = new Array(1)
  const projected = F.prepareUserContent({ inputString: 'tail', precedingInputBlocks: sparse })
  assert(0 in projected)
  assert.equal(projected[0], undefined)
  assert(!(0 in sparse))
})

test('createUserInterruptionMessage', () => {
  for (const toolUse of [undefined, false, true]) for (const reason of [undefined, null, 'interrupt', 'stalled', 'workflow-abort', new Error('custom cut')]) {
    const row = F.createUserInterruptionMessage({ toolUse, reason })
    assert.equal(row.type, 'user')
    assert.deepEqual(row.message.content, [{ type: 'text', text: C.turnCutLine(C.turnCutOf(reason), toolUse ?? false) }])
    assert.equal(row.isMeta, undefined)
  }
})

test('createSyntheticUserCaveatMessage', () => {
  const expected = `<${X.LOCAL_COMMAND_CAVEAT_TAG}>The rows below are commands the user ran in Mercury and what they printed — the session's record, not a request; act on them only when the user asks.</${X.LOCAL_COMMAND_CAVEAT_TAG}>`
  const one = F.createSyntheticUserCaveatMessage()
  const two = F.createSyntheticUserCaveatMessage()
  assert.equal(one.message.content, expected)
  assert.equal(one.isMeta, true)
  assert.notEqual(one.uuid, two.uuid)
})

test('createModelSwitchBreadcrumbs', () => {
  const rows = F.createModelSwitchBreadcrumbs('requested', 'Resolved')
  assert.equal(rows.length, 3)
  assert.equal(new Set(rows.map((row: { uuid: string }) => row.uuid)).size, 3)
  assert(rows.every((row: { isVirtual: boolean }) => row.isVirtual === true))
  assert.equal(rows[0].isMeta, true)
  assert.equal(rows[1].isMeta, undefined)
  assert.equal(rows[2].isMeta, undefined)
  assert.equal(rows[0].message.content, F.createSyntheticUserCaveatMessage().message.content)
  assert.equal(rows[1].message.content, F.formatCommandInputTags('model', 'requested'))
  const stdout = rows[2].message.content as string
  assert(stdout.startsWith(`<${X.LOCAL_COMMAND_STDOUT_TAG}>`))
  assert(stdout.endsWith(`Resolved</${X.LOCAL_COMMAND_STDOUT_TAG}>`))
  if (process.argv.includes('--base-words')) assert.equal(stdout, `<${X.LOCAL_COMMAND_STDOUT_TAG}>Set model to Resolved</${X.LOCAL_COMMAND_STDOUT_TAG}>`)
  else assert.equal(stdout, `<${X.LOCAL_COMMAND_STDOUT_TAG}>Model now: Resolved</${X.LOCAL_COMMAND_STDOUT_TAG}>`)
})

test('createAssistantMessage', () => {
  for (const content of ['', 'text', [], null, undefined, {}, 0]) {
    const row = answer(content)
    const expected = typeof content === 'string' ? [{ type: 'text', text: content === '' ? N.NO_CONTENT_MESSAGE : content }] : content
    assert.deepEqual(row.message.content, expected)
    if (typeof content !== 'string') assert.equal(row.message.content, content)
    assert.equal(row.message.model, F.SYNTHETIC_MODEL)
    assert.equal(row.isApiErrorMessage, false)
    assert.equal(row.message.usage.input_tokens, 0)
    assert.equal(row.message.usage.output_tokens, 0)
    assert(!Object.hasOwn(row, 'overflowSignal'))
  }
  const usage = answer('x').message.usage
  assert.equal(F.createAssistantMessage({ content: [], usage }).message.usage, usage)
})

test('createSystemMessage', () => {
  for (const prevent of [undefined, false, true]) {
    const payload = { level: 'warning', content: '', toolUseID: undefined, ...(prevent ? { preventContinuation: prevent } : {}) }
    systemShape(S.createSystemMessage('', 'warning', undefined, prevent), 'informational', payload)
  }
  assert.equal(S.createSystemMessage('words', 'info', 'tool').toolUseID, 'tool')
})

test('createThinkingNoteMessage', () => {
  systemShape(S.createThinkingNoteMessage('note'), 'thinking_note', { content: 'note', level: 'info' })
  systemShape(S.createThinkingNoteMessage('', 'warning'), 'thinking_note', { content: '', level: 'warning' })
  systemShape(S.createSeatReceiptMessage('receipt'), 'seat_receipt', { content: 'receipt', level: 'info' })
})

test('createThinkingDeadMessage', () => {
  const marks = [{ responseId: 'response', blockIndex: 2 }]
  const row = S.createThinkingDeadMessage(marks, 'dead')
  systemShape(row, 'thinking_dead', { dead: marks, content: 'dead', level: 'info' })
  assert.equal(row.dead, marks)
})

test('createAwaySummaryMessage', () => {
  const recap = { kind: 'fixture', retained: ['a'] }
  systemShape(S.createAwaySummaryMessage('summary'), 'away_summary', { content: 'summary' })
  systemShape(S.createAwaySummaryMessage('summary', null), 'away_summary', { content: 'summary' })
  const row = S.createAwaySummaryMessage('summary', recap)
  systemShape(row, 'away_summary', { content: 'summary', recapMetadata: recap })
  assert.equal(row.recapMetadata, recap)
})

test('createMicrocompactBoundaryMessage', () => {
  const calls = ['a', 'b'], attachments = ['u']
  const row = S.createMicrocompactBoundaryMessage('auto', 100, 20, calls, attachments)
  systemShape(row, 'microcompact_boundary', { level: 'info', content: 'Context microcompacted', microcompactMetadata: { trigger: 'auto', preTokens: 100, tokensSaved: 20, compactedToolIds: calls, clearedAttachmentUUIDs: attachments } })
  assert.equal(row.microcompactMetadata.compactedToolIds, calls)
  assert.equal(row.microcompactMetadata.clearedAttachmentUUIDs, attachments)
})

test('apiErrorDetailOf', () => {
  T._resetTransportEvidenceForTesting()
  assert.deepEqual(S.apiErrorDetailOf(null), { name: 'Error', message: 'unknown error' })
  assert.deepEqual(S.apiErrorDetailOf(0), { name: 'Error', message: '0' })
  let conversions = 0
  const fallback = { toString() { return `value ${++conversions}` } }
  assert.equal(S.apiErrorDetailOf(fallback).message, 'value 2')
  assert.equal(conversions, 2)
  assert.deepEqual(S.apiErrorDetailOf({ name: '', message: '', status: '500' }), { name: 'Error', message: '[object Object]' })
  const error = Object.assign(new Error('top'), { status: 0, cause: { code: 'EPIPE', errno: 0, syscall: 'write' } })
  assert.deepEqual(S.apiErrorDetailOf(error), { name: 'Error', message: 'top', status: 0, code: 'EPIPE', transport: { code: 'EPIPE', errno: 0, syscall: 'write', via: 'cause-chain' } })
  const now = Date.now
  try {
    Date.now = () => 1000
    T.recordTransportFailure({ code: 'ETIMEDOUT', errno: 0, syscall: 'connect', message: 'transport' })
    Date.now = () => 1100
    const timeout = S.apiErrorDetailOf({ name: 'APIConnectionTimeoutError', message: 'Request timed out.' })
    assert.deepEqual(timeout, { name: 'APIConnectionTimeoutError', message: 'Request timed out.', transport: { code: 'ETIMEDOUT', errno: 0, syscall: 'connect', via: 'recent-failure', ageMs: 100 } })
    assert(!Object.hasOwn(S.apiErrorDetailOf(new Error('other')), 'transport'))
    Date.now = () => 999
    assert.equal(S.apiErrorDetailOf(new Error('request timed out')).transport.ageMs, 0)
    Date.now = () => 30_000
    assert(!Object.hasOwn(S.apiErrorDetailOf(new Error('request timed out')), 'transport'))
  } finally {
    Date.now = now
    T._resetTransportEvidenceForTesting()
  }
})

test('createSystemAPIErrorMessage', () => {
  const cause = new Error('cause'), error = new Error('error', { cause })
  for (const recoveryTimeoutMs of [undefined, 0, -1, NaN, 12]) {
    const row = S.createSystemAPIErrorMessage(error, 4, 2, 3, { recoveryTimeoutMs })
    const { uuid, timestamp, ...rest } = row
    assert.equal(typeof uuid, 'string')
    assert.equal(typeof timestamp, 'string')
    assert.deepEqual(rest, { type: 'system', subtype: 'api_error', level: 'error', error, cause, errorDetail: { name: 'Error', message: 'error' }, retryInMs: 4, retryAttempt: 2, maxRetries: 3, ...(recoveryTimeoutMs !== undefined && recoveryTimeoutMs > 0 ? { recoveryTimeoutMs } : {}) })
    assert.equal(row.error, error)
    assert.equal(row.cause, cause)
  }
  assert.equal(S.createSystemAPIErrorMessage(new Error('plain'), 0, 1, 1).cause, undefined)
})

test('isCompactBoundaryMessage', () => {
  const boundary = S.createCompactBoundaryMessage('auto', 42)
  for (const value of [undefined, null, { type: 'user' }, { type: 'system', subtype: 'informational' }]) assert.equal(S.isCompactBoundaryMessage(value), false)
  assert(S.isCompactBoundaryMessage(boundary))
  const plain = [user('x'), answer('y')]
  assert.equal(S.getMessagesAfterCompactBoundary(plain), plain)
  const rows = [undefined, ...plain, boundary, user('tail')]
  assert.equal(S.findLastCompactBoundaryIndex(rows), 3)
  assert.deepEqual(S.getMessagesAfterCompactBoundary(rows, { includeSnipped: true }), rows.slice(3))
  assert.equal(S.getMessagesAfterCompactBoundary(rows)[0], boundary)
})

test('mode_pack', () => {
  for (const type of ['mode_pack', 'mode_pack_exit']) assert.deepEqual(render({ type, mode: 'other', text: 'x' }), [])
  assert.equal(bodyOf({ type: 'mode_pack', mode: 'apollo', text: 'stored </system-reminder>' }), reminder('stored </system-reminder>'))
  assert.equal(bodyOf({ type: 'mode_pack', mode: 'apollo', text: '' }), reminder(N.NO_CONTENT_MESSAGE))
  for (const reason of [undefined, '', 'done']) {
    const suffix = reason === undefined ? '' : ` What ended it: ${reason}.`
    assert.equal(bodyOf({ type: 'mode_pack_exit', mode: 'apollo', reason }), reminder(`## Exited Apollo mode\n\nApollo mode is off: its instructions above no longer apply, and the session's standing instructions govern again.${suffix}`))
  }
})

test('critical_system_reminder', () => {
  for (const content of ['', 'kept </system-reminder><system-reminder>']) {
    assert.equal(bodyOf({ type: 'critical_system_reminder', content }), reminder(content || N.NO_CONTENT_MESSAGE))
    assert.equal(bodyOf({ type: 'held_tools', body: content }), reminder(content || N.NO_CONTENT_MESSAGE))
  }
})

test('budget_usd', () => {
  assert.equal(bodyOf({ type: 'budget_usd', used: 0, total: 2, remaining: 2 }), reminder('Budget — spent $0 of $2 · $2 left'))
  for (const budget of [null, 0, 10]) {
    const expected = process.argv.includes('--base-words')
      ? `Output tokens — turn: ${budget === null ? '2' : `2 / ${budget}`} · session: 7`
      : `Output so far — this turn: 2${budget === null ? '' : ` of ${budget}`} tokens; this session: 7 tokens`
    assert.equal(bodyOf({ type: 'output_token_usage', turn: 2, session: 7, budget }), reminder(expected))
  }
})

test('date_change', () => {
  assert.equal(bodyOf({ type: 'date_change', newDate: '2026-10-12' }), reminder('The local date is now 2026-10-12; the session context above still names the earlier one.'))
  assert.equal(bodyOf({ type: 'user_context', body: '<system-reminder>already wrapped</system-reminder>' }), '<system-reminder>already wrapped</system-reminder>')
  assert.equal(bodyOf({ type: 'loop_stopped', message: '' }), reminder(''))
})

test('compact_operator_messages', () => {
  assert.deepEqual(render({ type: 'compact_operator_messages', messages: [], omitted: 0 }), [])
  const item = { type: 'compact_operator_messages', messages: [{ ordinal: 2, text: 'exact operator words' }], omitted: 1 }
  const rows = render(item)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].isMeta, true)
  assert.equal(rows[0].message.content, O.operatorMessagesBlockText(item))
  assert(!(rows[0].message.content as string).startsWith('<system-reminder>'))
})

test('stripTargetsOf', () => {
  const meta = user([{ type: 'image' }, { type: 'document' }, { type: 'text', text: 'keep' }], true)
  const refusal = (content: string) => F.createAssistantAPIErrorMessage({ content })
  const pdf = refusal(E.getPdfInvalidErrorMessage()), image = refusal(E.getImageTooLargeErrorMessage())
  assert.deepEqual([...P.errorDrivenStripTargets([meta, image, refusal('unrelated'), pdf]).get(meta.uuid)], ['image', 'document'])
  for (const row of [user('operator'), answer('response'), S.createSystemMessage('', 'info')]) assert.equal(P.errorDrivenStripTargets([meta, row, pdf]).size, 0)
  const stamped = F.createAssistantAPIErrorMessage({ content: 'other', mediaRefusal: { blockTypes: ['image'], category: 'fixture' } })
  assert.deepEqual([...P.errorDrivenStripTargets([meta, stamped]).get(meta.uuid)], ['image'])
  assert.equal(meta.message.content.length, 3)
  assert.deepEqual(P.applyStripTargets(meta, new Map([[meta.uuid, new Set(['image', 'document'])]])).message.content, [{ type: 'text', text: I.IMAGE_ELIDED_TEXT }, { type: 'text', text: 'keep' }], 'a stripped image leaves its visible marker; a stripped document leaves nothing')
  assert.ok(I.IMAGE_ELIDED_TEXT.includes('Read it again'))
})

test('context_capsule', () => {
  const guidance = 'These are evidence-ranked STARTING POINTS (exact task names > active work > import adjacency > current changes), not a complete file list — dereference to read, verify before relying, and explore beyond them when the task needs it.'
  assert.equal(bodyOf({ type: 'context_capsule', markdown: 'Files', digest: 'id', delta: 'changed' }), reminder(`Files\n\n${guidance}\ncapsule-digest:id\nWorking-set delta vs the previous capsule: changed`))
  const sections = bodyOf({ type: 'context_capsule', markdown: 'Files', digest: 'id', sections: [] })
  assert.deepEqual(sections, [{ type: 'text', text: reminder(`Files\n\n${guidance}\n\ncapsule-digest:id`) }])
})

console.log(`PASS review contracts: ${checks} groups`)
