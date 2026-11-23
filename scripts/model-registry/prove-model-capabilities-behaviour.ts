#!/usr/bin/env bun
import fc from 'fast-check'
import { getModelCapability } from '../../src/models/facts/inactiveCapabilityLookup.ts'

const WHERE = 'getModelCapability in src/models/facts/inactiveCapabilityLookup.ts'
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

console.log('§1 no model has a capability record here')
{
  const names = ['claude-opus-5-5', 'claude-sonnet-5', 'claude-fable-5', 'gpt-5.6-codex', 'glm-4.7', 'local/some-model', 'opus', '', ' ', 'no-such-model']
  const answers = names.map(name => getModelCapability(name))
  check('for every model name asked, the answer is nothing', answers.every(answer => answer === undefined), `${JSON.stringify(names.filter((_, n) => answers[n] !== undefined))} got a record; ${WHERE} answers undefined in this product`)
  const law = fc.check(fc.property(fc.string(), name => getModelCapability(name) === undefined), { numRuns: 500 })
  check('and for any text at all', !law.failed, `counterexample ${JSON.stringify(law.counterexample)}; see ${WHERE}`)
  let thrown = ''
  try {
    getModelCapability(undefined as never)
    getModelCapability(null as never)
  } catch (error) {
    thrown = String(error)
  }
  check('asking with no name does not throw', thrown === '', thrown)
}

if (failures > 0) {
  console.error(`\nprove-model-capabilities-behaviour: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-model-capabilities-behaviour: all green')
