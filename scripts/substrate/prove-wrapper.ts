#!/usr/bin/env bun

import { join } from 'node:path'
import {
  MERCURY_CONSTITUTION,
  MERCURY_SUBAGENT_CONTRACT,
  getMercuryContractSections,
} from '../../src/prompt/mercuryContract.js'

const J = (...parts: string[]): string => parts.join('')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

console.log('============================================================')
console.log(' Mercury constitution — model-wake + ungated proof')
console.log('============================================================')

section('the constitution — content')
check('the constitution is a non-empty string', typeof MERCURY_CONSTITUTION === 'string' && MERCURY_CONSTITUTION.length > 0)
check('it opens on who the seat is', MERCURY_CONSTITUTION.startsWith("You are Mercury, the coding agent working in the operator's terminal."))
check('it names Mercury once as the identity and states nothing the seat is not', (MERCURY_CONSTITUTION.match(/^You are /gm) ?? []).length === 1 && !/claim to be human|misrepresent what you are|not a person/i.test(MERCURY_CONSTITUTION))
check('it states the operator relation (the operator\'s stated preferences come ahead of the seat\'s defaults)', /Follow the operator's stated preferences on scope, approach, delegation and communication ahead of your defaults\./.test(MERCURY_CONSTITUTION) && /Discussion, a problem described without a request to act, or a plan you propose does not by itself authorise edits\./.test(MERCURY_CONSTITUTION))
check('it states the honesty line (plainly, without jargon, never mislead)', /Work as a capable colleague: use judgement, speak plainly, and be honest about what you know and what you have done\./.test(MERCURY_CONSTITUTION))
check('it is provider-neutral (no model-family identity — cross-provider law)', !/Claude|Anthropic|GPT|OpenAI/.test(MERCURY_CONSTITUTION))
check('the smallest-question rule is its last statement (no trailer)', MERCURY_CONSTITUTION.endsWith('Keep paused work paused until they authorise resumption.'))

section('model-wake: the constitution is a static section; getMercuryContractSections() carries no identity or doctrine')
const secs = getMercuryContractSections()
check('the contract sections carry no identity or doctrine section', secs.every(s => s.name !== J('identity', '-floor') && s.name !== J('mercury', '-doctrine') && !/You are/.test(s.text)))
check('every section carries a semantic name + string text', secs.every(s => typeof s.name === 'string' && s.name.length > 0 && typeof s.text === 'string'))
check('no positional section names (semantic-ID law)', secs.every(s => !/^wrapper-\d|^mode-\d+$/.test(s.name)))

section('the seat contract stays beside the constitution')
check('the crewmate contract carries its evidence rule and its gate rule', /Claim only what you opened or ran shows/.test(MERCURY_SUBAGENT_CONTRACT) && /Never bypass a safety, permission, approval, or capability gate/.test(MERCURY_SUBAGENT_CONTRACT))


console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL CONTRACT PROOFS PASS (model-wake + ungated constitution)')
else console.log(`❌ ${failures} CONTRACT PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
