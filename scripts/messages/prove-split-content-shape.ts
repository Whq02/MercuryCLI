import { strict as assert } from 'node:assert'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DIALECT_CONVERSATION } from './dialectFixture.ts'

const root = resolve(process.argv[2] ?? fileURLToPath(new URL('../..', import.meta.url)))
const { foldSplitTurnsForWire } = await import(`${root}/src/engine/messages/wirePairing.ts`)
const model = DIALECT_CONVERSATION[1] as any
const left = { ...model, message: { ...model.message, content: 'left text', stop_reason: null } }
const right = { ...model, message: { ...model.message, content: [{ type: 'text', text: 'right text', citations: [] }], stop_reason: 'end_turn' }, apexProviderTurn: { provider: 'openai', items: [{ type: 'reasoning', encrypted_content: 'fixture-private-replay' }] } }
const out = foldSplitTurnsForWire([left, right])
try {
  assert.equal(out.length, 1, 'foldSplitTurnsForWire (src/engine/message-shapes/resultPairing.ts) must fold the two split assistant rows into one')
  assert.deepEqual(out[0].message.content, [{ type: 'text', text: 'left text', citations: [] }, { type: 'text', text: 'right text', citations: [] }], 'foldSplitTurnsForWire (src/engine/message-shapes/resultPairing.ts) must turn string content into one whole text block and keep each resumed text block whole')
  assert.equal(out[0].apexProviderTurn, right.apexProviderTurn, 'foldSplitTurnsForWire (src/engine/message-shapes/resultPairing.ts) must keep the later row apexProviderTurn on the folded row')
  assert.equal(out[0].message.stop_reason, 'end_turn', 'foldSplitTurnsForWire (src/engine/message-shapes/resultPairing.ts) must take stop_reason from the later row')
  assert.equal(left.message.content, 'left text', 'foldSplitTurnsForWire (src/engine/message-shapes/resultPairing.ts) must not mutate its input rows')
  console.log('PASS: split-turn folding retains whole resumed text blocks and the settled private replay record')
} catch (error) {
  console.log('FAIL: split-turn folding splits resumed assistant text into character strings')
  throw error
}
