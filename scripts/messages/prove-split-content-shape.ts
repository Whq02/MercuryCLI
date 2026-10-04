import { strict as assert } from 'node:assert'
import { resolve } from 'node:path'
import { DIALECT_CONVERSATION } from './dialectFixture.ts'

const root = resolve(process.argv[2] ?? new URL('../..', import.meta.url).pathname)
const { foldSplitTurnsForWire } = await import(`${root}/src/utils/messages/pairing.ts`)
const model = DIALECT_CONVERSATION[1] as any
const left = { ...model, message: { ...model.message, content: 'left text', stop_reason: null } }
const right = { ...model, message: { ...model.message, content: [{ type: 'text', text: 'right text', citations: [] }], stop_reason: 'end_turn' }, apexProviderTurn: { provider: 'openai', items: [{ type: 'reasoning', encrypted_content: 'fixture-private-replay' }] } }
const out = foldSplitTurnsForWire([left, right])
try {
  assert.equal(out.length, 1)
  assert.deepEqual(out[0].message.content, [{ type: 'text', text: 'left text', citations: [] }, { type: 'text', text: 'right text', citations: [] }])
  assert.equal(out[0].apexProviderTurn, right.apexProviderTurn)
  assert.equal(out[0].message.stop_reason, 'end_turn')
  assert.equal(left.message.content, 'left text')
  console.log('PASS: split-turn folding retains whole resumed text blocks and the settled private replay record')
} catch (error) {
  console.log('FAIL: split-turn folding splits resumed assistant text into character strings')
  throw error
}
