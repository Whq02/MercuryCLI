#!/usr/bin/env bun

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MERCURY_CONSTITUTION,
  MERCURY_COORDINATOR_CONTRACT,
  MERCURY_COORDINATOR_SEAT,
  MERCURY_SUBAGENT_CONTRACT,
  getMercuryContractSections,
} from '../../src/prompt/mercuryContract.js'

const J = (...parts: string[]): string => parts.join('')
const ROOT = join(import.meta.dir, '..', '..')
const PROMPTS = readFileSync(join(ROOT, 'src/constants/prompts.ts'), 'utf8')
const CONTRACT = readFileSync(join(ROOT, 'src/prompt/mercuryContract.ts'), 'utf8')

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
check('prompts.ts composes the constitution into the static group right after the head', PROMPTS.includes("const law = layers === 'replace' ? promptReplacementText() : MERCURY_CONSTITUTION") && PROMPTS.includes('const staticSections: Array<string | null> = [frozenHead ?? head, law]'))
check('prompts.ts carries no behaviour prose of its own: no tone, no communication, no care, no doing-tasks section', !/# Tone and style|# Communicating with the user|# Acting with care|# Doing tasks|# System behaviour|# Using your tools|# Session-specific guidance/.test(PROMPTS))

section('the seat contracts stay beside the constitution, one per seat')
check('the coordinator seat fact names the role and no second identity', MERCURY_COORDINATOR_SEAT.includes('"coordinator" is your role, never a second name') && !/^You are/.test(MERCURY_COORDINATOR_SEAT))
check('the coordinator contract carries its evidence rule and its smallest-honest-question rule', /Claim only what the board or this turn's receipts show/.test(MERCURY_COORDINATOR_CONTRACT) && /ask the smallest honest question/.test(MERCURY_COORDINATOR_CONTRACT))
check('the crewmate contract carries its evidence rule and its gate rule', /Claim only what you opened or ran shows/.test(MERCURY_SUBAGENT_CONTRACT) && /Never bypass a safety, permission, approval, or capability gate/.test(MERCURY_SUBAGENT_CONTRACT))
check('no session contract and no doctrine tag exist beside the constitution', !new RegExp([J('MERCURY_SESSION', '_CONTRACT'), J('MERCURY_SESSION', '_DOCTRINE'), J('<mercury', '-doctrine>'), J('MERCURY_IDENTITY', '_RECONCILE')].join('|')).test(CONTRACT))

section('ungated: no flag names the constitution or drops it')
check('the contract module reads no doctrine flag', !new RegExp([J('MERCURY_WRAPPER', '_APPEND'), J('mercuryDoctrine', 'Enabled')].join('|')).test(CONTRACT))
check('the only flags the module reads are the prompt-ablation instrument\'s', (CONTRACT.match(/flagEnv\('([A-Z_]+)'\)/g) ?? []).join(',') === "flagEnv('MERCURY_PROMPT_LAYERS'),flagEnv('MERCURY_PROMPT_REPLACE_FILE')")

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL CONTRACT PROOFS PASS (model-wake + ungated constitution)')
else console.log(`❌ ${failures} CONTRACT PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
