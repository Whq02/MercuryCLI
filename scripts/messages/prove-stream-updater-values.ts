import { strict as assert } from 'node:assert'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(process.argv[2] ?? fileURLToPath(new URL('../..', import.meta.url)))
const { handleMessageFromStream: handle } = await import(`${root}/src/screen/messages-list/streamToScreen.ts`)
const noop = () => {}
let textUpdate: any
const textFrame: any = { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'original' } } }
handle(textFrame, noop, () => { textFrame.event.delta.text = 'changed in callback' }, noop, noop, undefined, undefined, undefined, (update: any) => { textUpdate = update })
textFrame.event.delta.text = 'changed after call'
assert.equal(textUpdate(null), 'original', 'the deferred text updater must apply the text captured when the frame arrived: change handleMessageFromStream in src/screen/messages-list/streamToScreen.ts to copy the delta text before deferring')
console.log('PASS deferred text updater retains the arrival value across callbacks and later frame reuse')
let toolUpdate: any
const toolFrame: any = { type: 'stream_event', event: { type: 'content_block_delta', index: 7, delta: { type: 'input_json_delta', partial_json: 'original' } } }
handle(toolFrame, noop, () => { toolFrame.event.index = 8; toolFrame.event.delta.partial_json = 'changed' }, noop, (update: any, options: any) => { toolUpdate = update; assert.deepEqual(options, { silent: true }) })
const before = [{ index: 7, unparsedToolInput: 'prefix:' }, { index: 8, unparsedToolInput: 'other' }]
const after = toolUpdate(before)
assert.equal(after[0].unparsedToolInput, 'prefix:original', 'the silent input updater must append the partial_json and index captured on arrival: change handleMessageFromStream in src/screen/messages-list/streamToScreen.ts to copy index and partial_json before deferring')
assert.equal(after[1], before[1], 'the silent input updater must return untouched sibling blocks by identity: change the input_json_delta updater in handleMessageFromStream in src/screen/messages-list/streamToScreen.ts')
assert.equal(before[0].unparsedToolInput, 'prefix:', 'the silent input updater must not mutate its input array: change the input_json_delta updater in handleMessageFromStream in src/screen/messages-list/streamToScreen.ts')
console.log('PASS silent input updater retains index and bytes and preserves sibling identities')
const start: any = { type: 'stream_event', event: { type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 't', name: 'Read', input: {} } } }
handle(start, noop, noop, noop, (update: any) => { toolUpdate = update })
start.event.index = 4
assert.equal(toolUpdate([])[0].index, 3, 'the deferred tool opening must keep the index it arrived with: change the content_block_start handling in handleMessageFromStream in src/screen/messages-list/streamToScreen.ts to copy the index before deferring')
console.log('PASS deferred tool opening keeps its arrival index')
