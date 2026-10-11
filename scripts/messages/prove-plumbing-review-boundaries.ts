import { strict as assert } from 'node:assert'
import { resolve } from 'node:path'
;(globalThis as any).MACRO = { VERSION: '1.0.0' }
const root = resolve(process.argv[2] ?? new URL('../..', import.meta.url).pathname)
const merge = await import(`${root}/src/utils/messages/merge.ts`)
const view = await import(`${root}/src/utils/messages/apiView.ts`)
const cache = await import(`${root}/src/services/providers/anthropic/cacheAndUsage.ts`)
const params = await import(`${root}/src/services/providers/anthropic/requestParams.ts`)
const caps = await import(`${root}/src/utils/model/capabilities.ts`)
const state = await import(`${root}/src/bootstrap/state.ts`)
const filters = await import(`${root}/src/utils/messages/apiFilters.ts`)
const streaming = await import(`${root}/src/utils/messages/streaming.ts`)
const config = await import(`${root}/src/utils/config.ts`)
config.enableConfigs()
let failures = 0
function check(name: string, run: () => void) {
  try { run(); console.log(`PASS ${name}`) }
  catch (error) { failures++; console.log(`FAIL ${name}: ${String(error)}`) }
}
const text = (text: string) => ({ type: 'text', text })
const user = (content: any) => ({ type: 'user', uuid: 'u', message: { role: 'user', content } })
const assistant = (content: any) => ({ type: 'assistant', uuid: 'a', message: { role: 'assistant', id: 'id', content } })
check('reference boundary short-circuits before consulting later malformed content', () => {
  const row = user([text('Tool loaded. already'), null])
  assert.equal(view.withToolReferenceTurnBoundary(row), row)
})
check('reference boundary append materializes sparse content slots', () => {
  const blocks = new Array(2)
  blocks[1] = { type: 'tool_result', tool_use_id: 'r', content: [{ type: 'tool_reference', tool_name: 'Read' }] }
  const out = view.withToolReferenceTurnBoundary(user(blocks))
  assert.equal(0 in out.message.content, true)
  assert.deepEqual(out.message.content.at(-1), text('Tool loaded.'))
})
check('plain user-content concatenation materializes sparse slots; absorption preserves the left shape', () => {
  const sparse = new Array(2); sparse[1] = text('last')
  const joined = merge.mergeUserContentBlocks(sparse, [])
  assert.equal(0 in joined, true)
  assert.equal(joined[0], undefined)
  const absorb = new Array(2); absorb[1] = { type: 'tool_result', tool_use_id: 'x', content: 'old' }
  const folded = merge.mergeUserContentBlocks(absorb, [text('new')])
  assert.equal(0 in folded, false)
  assert.equal(folded[1].content, 'old\n\nnew')
})
check('assistant content concatenation materializes sparse slots and retains whole text blocks', () => {
  const sparse = new Array(2); sparse[1] = text('last')
  const out = merge.mergeAssistantMessages(assistant(sparse), assistant('word'))
  assert.equal(0 in out.message.content, true)
  assert.deepEqual(out.message.content.slice(1), [text('last'), { type: 'text', text: 'word', citations: [] }])
})
check('trailing-thinking replacement materializes sparse transcript slots', () => {
  const rows = new Array(2)
  rows[1] = assistant([{ type: 'thinking', thinking: 'thought', signature: 'sig' }])
  const out = filters.filterTrailingThinkingFromLastAssistant(rows)
  assert.equal(0 in out, true)
  assert.equal(out[0], undefined)
})
check('a streamed tool opening materializes sparse prior tool slots', () => {
  let update: any
  const noop = () => {}
  streaming.handleMessageFromStream({ type: 'stream_event', event: { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 't', name: 'Read', input: {} } } }, noop, noop, noop, (f: any) => { update = f })
  const out = update(new Array(1))
  assert.equal(0 in out, true)
  assert.equal(out[1].index, 2)
})
const usage = () => ({
  input_tokens: 3, cache_creation_input_tokens: 4, cache_read_input_tokens: 5, output_tokens: 6,
  server_tool_use: { web_search_requests: 1, web_fetch_requests: 2 }, service_tier: 'standard',
  cache_creation: { ephemeral_1h_input_tokens: 7, ephemeral_5m_input_tokens: 8 },
  inference_geo: 'us', iterations: [], speed: 'standard', output_tokens_details: null,
})
check('delta counters do not read overridden prior output or cache counters', () => {
  const old: any = usage()
  Object.defineProperty(old, 'output_tokens', { get() { throw new Error('old output read') } })
  Object.defineProperty(old, 'cache_creation', { get() { throw new Error('old cache read') } })
  const out = cache.updateUsage(old, { output_tokens: 0, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 9 } })
  assert.equal(out.output_tokens, 0)
  assert.deepEqual(out.cache_creation, { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 9 })
})
check('delta usage accepts complete cache replacement even when prior optional wire group is missing', () => {
  const old: any = usage(); delete old.cache_creation
  const out = cache.updateUsage(old, { cache_creation: { ephemeral_1h_input_tokens: 11, ephemeral_5m_input_tokens: 12 } })
  assert.deepEqual(out.cache_creation, { ephemeral_1h_input_tokens: 11, ephemeral_5m_input_tokens: 12 })
})
check('usage effects read token counters before server counters in both folds', () => {
  const reads: string[] = []
  const tracked = (side: string) => new Proxy(usage(), { get(target, key, receiver) { reads.push(`${side}.${String(key)}`); return Reflect.get(target, key, receiver) } })
  cache.accumulateUsage(tracked('old'), tracked('new'))
  assert.deepEqual(reads.slice(0, 8), ['old.input_tokens','new.input_tokens','old.cache_creation_input_tokens','new.cache_creation_input_tokens','old.cache_read_input_tokens','new.cache_read_input_tokens','old.output_tokens','new.output_tokens'])
  reads.length = 0
  cache.updateUsage(tracked('old'), tracked('new'))
  assert.deepEqual(reads.slice(0, 6), ['new.input_tokens','old.input_tokens','new.cache_creation_input_tokens','old.cache_creation_input_tokens','new.cache_read_input_tokens','old.cache_read_input_tokens'])
})
check('cache edit dedup ignores sparse slots and stamps a copied dense prefix', () => {
  const edits = new Array(2); edits[1] = { type: 'delete', cache_reference: 'old' }
  const replay = cache.addCacheBreakpoints([user('first'), assistant([text('last')])], true, true, null, [{ userMessageIndex: 0, block: { type: 'cache_edits', edits } }])
  assert.deepEqual(replay[0].content.find((block: any) => block.type === 'cache_edits').edits, [edits[1]])
  const blocks = new Array(2); blocks[1] = { type: 'tool_result', tool_use_id: 'x', content: 'out' }
  const stamped = cache.addCacheBreakpoints([user(blocks), assistant([text('last')])], true, true)
  assert.equal(0 in stamped[0].content, true)
  assert.equal(stamped[0].content[1].cache_reference, 'x')
  assert.equal(0 in blocks, false)
})
check('extra-body headers materialize holes in a caller-mutated cached header array', () => {
  process.env.MERCURY_EXTRA_BODY = '{"anthropic_beta":["gone","kept"],"proof":"sparse-cached"}'
  try {
    const first = params.getExtraBodyParams()
    delete first.anthropic_beta[0]
    const out = params.getExtraBodyParams(['added'])
    assert.equal(0 in out.anthropic_beta, true)
    assert.deepEqual(out.anthropic_beta, [undefined, 'kept', 'added'])
  } finally { delete process.env.MERCURY_EXTRA_BODY }
})
check('SDK header holes are ignored while duplicates are retained', () => {
  const headers = new Array(3); headers[1] = 'edge-beta'; headers[2] = 'edge-beta'
  state.setSdkBetas(headers)
  try {
    const base = caps.getModelBetas('claude-haiku-4-5-20251001')
    assert.deepEqual(caps.getMergedBetas('claude-haiku-4-5-20251001'), [...base, 'edge-beta', 'edge-beta'])
  } finally { state.setSdkBetas(undefined) }
})
console.log(`${failures ? 'FAIL' : 'PASS'} plumbing review boundaries: ${failures} failures`)
process.exitCode = failures ? 1 : 0
