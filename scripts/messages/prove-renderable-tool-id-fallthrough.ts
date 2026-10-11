import { strict as assert } from 'node:assert'
import { resolve } from 'node:path'
const root = resolve(process.argv[2] ?? new URL('../..', import.meta.url).pathname)
const { getToolUseID } = await import(`${root}/src/utils/messages/lookups.ts`)
for (const type of ['grouped_tool_use', 'collapsed_read_search', 'turn_receipt']) {
  assert.equal(getToolUseID({ type, messages: [], uuid: 'render-row' } as never), undefined)
  console.log(`PASS ${type} has no direct tool id and never dereferences a nonexistent message body`)
}
assert.equal(getToolUseID({ type: 'user', sourceToolUseID: 'source' } as never), 'source')
console.log('PASS a source tool id answers before reading user content')
