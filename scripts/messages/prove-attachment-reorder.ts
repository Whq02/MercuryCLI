import { resolve } from 'node:path'

const root = resolve(process.argv[2] ?? new URL('../..', import.meta.url).pathname)
const { reorderAttachmentsForAPI } = await import(`${root}/src/utils/messages/apiView.ts`)
let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}
const user = (id: string, content: unknown = `text ${id}`) => ({ type: 'user', uuid: id, message: { role: 'user', content } })
const assistant = (id: string) => ({ type: 'assistant', uuid: id, message: { role: 'assistant', content: [{ type: 'text', text: id }] } })
const result = (id: string) => user(id, [{ type: 'tool_result', tool_use_id: `toolu_${id}`, content: 'ok' }])
const attachment = (id: string) => ({ type: 'attachment', uuid: id, attachment: { type: 'todo', itemCount: 1 } })
const progress = (id: string) => ({ type: 'progress', uuid: id })
const order = (messages: Array<{ uuid: string }>) => messages.map(m => m.uuid).join(' ')

const input = [
  progress('p0'), attachment('a0'), user('u0'), attachment('a1'),
  assistant('s1'), progress('p1'), attachment('a2'), user('u1'), attachment('a3'), progress('p2'),
  result('r1'), attachment('a4'),
  assistant('s2'), user('u2', [{ type: 'text', text: 'x' }, { type: 'tool_result', tool_use_id: 't', content: 'late' }]), attachment('a5'),
]
const out = reorderAttachmentsForAPI(input)
check('attachments climb to just after the nearest stopping point above, keeping their order, before the segment\'s other rows', order(out) === 'a0 a1 p0 u0 s1 a2 a3 p1 u1 p2 r1 a4 s2 a5 u2', order(out))
check('every message is kept exactly once', out.length === input.length && new Set(out).size === input.length)
check('the input list is not modified', order(input) === 'p0 a0 u0 a1 s1 p1 a2 u1 a3 p2 r1 a4 s2 u2 a5')
check('a user message whose first block is not a tool_result is no stopping point', order(reorderAttachmentsForAPI([assistant('s'), user('u2', [{ type: 'text', text: 'x' }, { type: 'tool_result', tool_use_id: 't', content: 'late' }]), attachment('b')])) === 's b u2')
check('a user message with string content is no stopping point', order(reorderAttachmentsForAPI([user('u'), attachment('b')])) === 'b u')
check('without attachments the list comes back in the same order', order(reorderAttachmentsForAPI([user('u'), assistant('s'), result('r')])) === 'u s r')
check('an empty list stays empty', reorderAttachmentsForAPI([]).length === 0)

console.log(`${failures ? 'FAIL' : 'PASS'} attachment reorder: ${failures} failures`)
process.exit(failures ? 1 : 0)
