#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const notices = await import('../../src/services/engine-connector/queuedNotices.ts')
type Message = import('../../src/types/message.ts').Message
type QueuedFactV1 = import('../../src/services/engine-connector/seatProjections.ts').QueuedFactV1

const NOTE = '<task-notification>\n<task-id>t1</task-id>\n<status>completed</status>\n<summary>Agent "a quick errand" completed</summary>\n</task-notification>'
const OTHER = '<task-notification>\n<task-id>t2</task-id>\n<status>failed</status>\n<summary>Agent "another errand" failed</summary>\n</task-notification>'

section('N1 — the notice\'s identity is its words')
{
  const key = notices.noticeKeyOf(NOTE)
  check('a stable key from the same words', key === notices.noticeKeyOf(NOTE))
  check('distinct per notice', key !== notices.noticeKeyOf(OTHER))
  check('the key wears the notice lane', notices.isNoticeKey(key) && !notices.isNoticeKey('4f6c1b2e-0000-4000-8000-000000000000') && !notices.isNoticeKey('obl-answer:x'))
  check('a task-notification queue entry is a notice; a prompt is not', notices.isNoticeFact({ mode: 'task-notification' }) && !notices.isNoticeFact({ mode: 'prompt' }) && !notices.isNoticeFact({ mode: 'bash' }))
}

section('N2 — the row is the drained row\'s own shape, born queued at its arrival')
{
  const at = Date.UTC(2030, 0, 2, 3, 4, 5)
  const row = notices.createNoticeRow(NOTE, at) as Message & { queued?: true; attachment?: { type?: string; commandMode?: string; prompt?: unknown } }
  check('an attachment row', row.type === 'attachment')
  check('on the queued_command task-notification lane', row.attachment?.type === 'queued_command' && row.attachment?.commandMode === 'task-notification')
  check('carrying the notice\'s words as its prompt', row.attachment?.prompt === NOTE)
  check('born queued', row.queued === true)
  check('at its arrival clock', row.timestamp === new Date(at).toISOString())
  check('RED on the base: the notice keeps its arrival separately when the delivery clock changes', row.type === 'attachment' && row.attachment.type === 'queued_command' && row.attachment.sentAt === new Date(at).toISOString())
  check('with an identity of its own', typeof row.uuid === 'string' && row.uuid.length > 0 && row.uuid !== (notices.createNoticeRow(NOTE, at) as { uuid: string }).uuid)
}

section('N3 — the landing test')
{
  const drained = { type: 'attachment', uuid: 'r1', timestamp: 't', attachment: { type: 'queued_command', prompt: NOTE, commandMode: 'task-notification' } } as unknown as Message
  const drainedBlocks = { type: 'attachment', uuid: 'r2', timestamp: 't', attachment: { type: 'queued_command', prompt: [{ type: 'text', text: NOTE }], commandMode: 'task-notification' } } as unknown as Message
  const promptRow = { type: 'attachment', uuid: 'r3', timestamp: 't', attachment: { type: 'queued_command', prompt: NOTE, commandMode: 'prompt' } } as unknown as Message
  const userRow = { type: 'user', uuid: 'r4', timestamp: 't', message: { role: 'user', content: NOTE } } as unknown as Message
  check('the runner\'s drained attachment with the same words lands it', notices.noticeRowLanded(drained, NOTE))
  check('a block-array prompt with the same words lands it too', notices.noticeRowLanded(drainedBlocks, NOTE))
  check('other words never do', !notices.noticeRowLanded(drained, OTHER))
  check('a prompt\'s drained row never does', !notices.noticeRowLanded(promptRow, NOTE))
  check('a user row with other words never does', !notices.noticeRowLanded(userRow, OTHER))
  const at = Date.now()
  const stamp = (offsetMs: number): string => new Date(at + offsetMs).toISOString()
  const taken = { type: 'user', uuid: 'r5', timestamp: stamp(200), message: { role: 'user', content: NOTE } } as unknown as Message
  const takenBlocks = { type: 'user', uuid: 'r6', timestamp: stamp(200), message: { role: 'user', content: [{ type: 'text', text: NOTE }] } } as unknown as Message
  const batched = { type: 'user', uuid: 'r7', timestamp: stamp(200), message: { role: 'user', content: `${OTHER}\n\n${NOTE}` } } as unknown as Message
  const older = { type: 'user', uuid: 'r8', timestamp: stamp(-5000), message: { role: 'user', content: NOTE } } as unknown as Message
  const meta = { type: 'user', uuid: 'r9', isMeta: true, timestamp: stamp(200), message: { role: 'user', content: NOTE } } as unknown as Message
  const otherId = { type: 'user', uuid: 'r10', timestamp: stamp(200), message: { role: 'user', content: NOTE.replace('<task-id>t1</task-id>', '<task-id>t9</task-id>') } } as unknown as Message
  check('a user row carrying the notice, not older than the send, lands it (the between-turns take)', notices.noticeRowLanded(taken, NOTE, at))
  check('a user row of text blocks carrying the notice lands it too', notices.noticeRowLanded(takenBlocks, NOTE, at))
  check('a row that batched the notice behind other words lands it (the task id and the words)', notices.noticeRowLanded(batched, NOTE, at))
  check('a user row older than the send never lands it (no old-history substring)', !notices.noticeRowLanded(older, NOTE, at))
  check('a drained attachment older than the send never lands it either', !notices.noticeRowLanded({ ...(drained as unknown as Record<string, unknown>), timestamp: stamp(-5000) } as unknown as Message, NOTE, at))
  check('a meta row never lands it', !notices.noticeRowLanded(meta, NOTE, at))
  check('the same words under another task id never land it', !notices.noticeRowLanded(otherId, NOTE, at))
  check('the task id is read off the frame', notices.noticeTaskId(NOTE) === 't1' && notices.noticeTaskId('no frame') === undefined)
}

section('N4 — the queue\'s order is the screen\'s order')
{
  const words = '4f6c1b2e-0000-4000-8000-000000000001'
  const later = '4f6c1b2e-0000-4000-8000-000000000002'
  const noteKey = notices.noticeKeyOf(NOTE)
  const queue: QueuedFactV1[] = [
    { value: NOTE, mode: 'task-notification' },
    { uuid: words, value: 'first queued words', mode: 'prompt' },
  ]
  const sends = [
    { clientMessageId: 'taken-1', state: 'taken' },
    { clientMessageId: words, state: 'queued' },
    { clientMessageId: noteKey, state: 'queued' },
    { clientMessageId: later, state: 'delivered' },
  ]
  const ordered = notices.queueOrderedSends(sends, queue).map(s => s.clientMessageId)
  check('the notice moves above the words typed before it was seen', JSON.stringify(ordered) === JSON.stringify(['taken-1', noteKey, words, later]), JSON.stringify(ordered))
  check('a taken send keeps its place ahead of the queue; a delivered one keeps its place behind', ordered[0] === 'taken-1' && ordered[3] === later)
  const already = [{ clientMessageId: noteKey }, { clientMessageId: words }]
  check('an order the queue already has stays as it is (same entries, same places)', JSON.stringify(notices.queueOrderedSends(already, queue).map(s => s.clientMessageId)) === JSON.stringify([noteKey, words]))
  const one = [{ clientMessageId: 'x' }, { clientMessageId: words }]
  check('fewer than two queued sends move nothing', JSON.stringify(notices.queueOrderedSends(one, queue).map(s => s.clientMessageId)) === JSON.stringify(['x', words]))
  const none = notices.queueOrderedSends(sends, [])
  check('an empty queue moves nothing', JSON.stringify(none.map(s => s.clientMessageId)) === JSON.stringify(sends.map(s => s.clientMessageId)))
  const twice: QueuedFactV1[] = [{ value: NOTE, mode: 'task-notification' }, { value: NOTE, mode: 'task-notification' }]
  check('a notice queued twice keeps the first position', notices.queueOrderedSends([{ clientMessageId: noteKey }, { clientMessageId: words }], [...twice, queue[1]!]).map(s => s.clientMessageId)[0] === noteKey)
}

console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
