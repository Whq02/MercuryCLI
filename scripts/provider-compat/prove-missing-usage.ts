import { turn, sse } from './compatBugFixture.ts'
import assert from 'node:assert/strict'
const cost = await import('../../src/models/usage/sessionCost.ts')
const missing = await turn(() => sse([{ choices: [{ delta: { content: 'hello there friend, nice day' }, finish_reason: 'stop' }] }]), 'deepseek-flash')
const usage = missing.events.filter(e => e.type === 'assistant').at(-1)?.message.usage
assert(usage.input_tokens > 0, `unreported compat usage in src/models/roads/openaicompat/compatChatCallModel.ts must estimate positive input_tokens (got ${usage?.input_tokens})`)
assert(usage.output_tokens > 0, `unreported compat usage in src/models/roads/openaicompat/compatChatCallModel.ts must estimate positive output_tokens (got ${usage?.output_tokens})`)
assert.equal(usage.usage_source, 'estimated')
assert(cost.sessionSawUsage(), 'cost tracker in src/models/usage/sessionCost.ts must record sessionSawUsage()=true after estimated usage')
assert(cost.getTotalCost() > 0, `cost tracker in src/models/usage/sessionCost.ts must accrue positive cost for estimated usage (got ${cost.getTotalCost()})`)
const measured = await turn(() => sse([{ choices: [{ delta: { content: 'hello' }, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 8 } }]), 'deepseek-flash')
const reported = measured.events.filter(e => e.type === 'assistant').at(-1)?.message.usage
assert.equal(reported.input_tokens, 30)
assert.equal(reported.output_tokens, 8)
assert.equal(reported.usage_source, undefined)
console.log('P09 unreported usage enters the ledger as an estimate; reported usage remains exact')
