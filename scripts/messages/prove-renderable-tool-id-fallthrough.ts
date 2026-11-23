import { strict as assert } from 'node:assert'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(process.argv[2] ?? fileURLToPath(new URL('../..', import.meta.url)))
const { getToolUseID } = await import(`${root}/src/engine/messages/lookups.ts`)
for (const type of ['grouped_tool_use', 'collapsed_read_search', 'turn_receipt']) {
  assert.equal(getToolUseID({ type, messages: [], uuid: 'render-row' } as never), undefined, `getToolUseID in src/engine/messages/lookups.ts must return undefined for a ${type} row (no case for it in its switch, and no read of message.message); got something else`)
  console.log(`PASS ${type} has no direct tool id and never dereferences a nonexistent message body`)
}
assert.equal(getToolUseID({ type: 'user', sourceToolUseID: 'source' } as never), 'source', 'getToolUseID in src/engine/messages/lookups.ts must return sourceToolUseID of a user row before it reads message.message.content')
console.log('PASS a source tool id answers before reading user content')
