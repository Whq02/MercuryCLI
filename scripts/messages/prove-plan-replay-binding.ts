import { strict as assert } from 'node:assert'
import { resolve } from 'node:path'
import { requestPlanOf } from '../../src/rows/request.ts'
import { DIALECT_CONVERSATION } from './dialectFixture.ts'

const path = process.argv[2] ? resolve(process.argv[2]) : new URL('../../src/services/providers/openai/responsesBridge.ts', import.meta.url).pathname
const { encodeOpenaiPlan } = await import(path)
const assistant = DIALECT_CONVERSATION[1] as any
const turn = { ...assistant, message: { ...assistant.message, model: 'fixture-served-model' }, apexProviderTurn: { provider: 'openai', items: [{ type: 'reasoning', summary: [], encrypted_content: 'private-bound-fixture' }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'fixture answer' }] }] } }
const plan = requestPlanOf([turn])
try {
  assert.equal(JSON.stringify(encodeOpenaiPlan(plan)).includes('private-bound-fixture'), false)
  assert.equal(JSON.stringify(encodeOpenaiPlan(plan, { model: 'fixture-other-model' })).includes('private-bound-fixture'), false)
  assert.equal(JSON.stringify(encodeOpenaiPlan(plan, { model: 'fixture-served-model' })).includes('private-bound-fixture'), true)
  assert.equal(plan.turns[0]?.replay?.openai, turn.apexProviderTurn)
  console.log('PASS: a plan codec carries private replay only for its explicitly matching served model')
} catch (error) {
  console.log('FAIL: the plan codec can carry private replay with no target or a different target model')
  throw error
}
