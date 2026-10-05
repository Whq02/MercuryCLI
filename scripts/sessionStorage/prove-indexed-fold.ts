import { strict as assert } from 'node:assert'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const source = process.argv[2] ? resolve(process.argv[2]) : resolve(import.meta.dir, '../..')
const { applyTranscriptEntry, emptyFoldState } = await import(pathToFileURL(resolve(source, 'src/utils/sessionStorage/fold.ts')).href)
const { buildConversationChain, applySnipRemovals, isLoggableMessage } = await import(pathToFileURL(resolve(source, 'src/utils/sessionStorage/chain.ts')).href)
const { computeResumeLeaves } = await import(pathToFileURL(resolve(source, 'src/utils/sessionStorage/transcriptReader.ts')).href)
const sessionId = '00000000-0000-4000-8000-000000000001'
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const stamp = (n: number, parent: number | null) => ({ uuid: id(n), parentUuid: parent === null ? null : id(parent), timestamp: '2026-01-01T00:00:00.000Z', sessionId, cwd: '/proof', version: 'proof', isSidechain: false })
const user = (n: number, parent: number | null, content: unknown) => ({ ...stamp(n, parent), type: 'user', message: { role: 'user', content } })
const assistant = (n: number, parent: number, group: string) => ({ ...stamp(n, parent), type: 'assistant', message: { role: 'assistant', id: group, model: '', content: [{ type: 'text', text: 'answer' }] } })
const state = emptyFoldState()
const entries = [
  user(1, null, 'prompt'),
  assistant(2, 1, 'parallel'),
  assistant(3, 2, 'parallel'),
  user(4, 2, [{ type: 'tool_result', tool_use_id: 'a', content: 'first' }]),
  user(5, 3, [{ type: 'tool_result', tool_use_id: 'b', content: 'second' }]),
  { ...stamp(6, 4), type: 'system', subtype: 'local_command', content: 'receipt', level: 'info' },
  user(7, 4, 'next'),
]
for (const row of entries) applyTranscriptEntry(state, row)
assert.equal(Object.getPrototypeOf(state.messages), Map.prototype)
const iter = state.messages.values
state.messages.values = () => { throw new Error('the conversation view rescanned the whole message map') }
try {
  const chain = buildConversationChain(state.messages, state.messages.get(id(7)))
  assert.deepEqual(chain.map((row: any) => row.uuid), [1, 2, 3, 5, 4, 6, 7].map(id))
  assert.deepEqual([...computeResumeLeaves(state.messages)], [5, 4, 7].map(id))
  applyTranscriptEntry(state, assistant(8, 7, 'final'))
  assert.equal(buildConversationChain(state.messages, state.messages.get(id(8))).at(-1).uuid, id(8))
} finally {
  state.messages.values = iter
}
const removed = new Map([
  [id(1), user(1, null, 'keep')],
  [id(2), user(2, 1, 'remove')],
  [id(3), user(3, 2, 'keep')],
  [id(4), { ...stamp(4, 3), type: 'system', subtype: 'microcompact_boundary', snipMetadata: { removedUuids: [id(2)] } }],
])
applySnipRemovals(removed)
assert.equal(removed.has(id(2)), false)
assert.equal(removed.get(id(3)).parentUuid, id(1))
assert.equal(isLoggableMessage({ ...stamp(9, 8), type: 'attachment', attachment: { type: 'hook_success', content: '', capsuleReceipt: { digest: 'proof' } } }), true)
console.log('PASS indexed fold: native Map shape, no whole-map chain or leaf scan, parallel results, attached notes, growth, snip healing, and receipt persistence')
