;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const J = (...parts: string[]): string => parts.join('')

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'seat-contracts-'))

const ROOT = join(import.meta.dir, '..', '..')
const src = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const RETIRED_WORDS = ['effort', ['deep', 'think'].join(''), ['super', 'code'].join('')]
const untagged = (text: string): string => text.replace(/<\/?[a-z-]+>/g, ' ').replace(/\s+/g, ' ').trim()
const sentencesOf = (text: string): string[] => untagged(text).split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 0)
const retiredIn = (text: string): string[] => RETIRED_WORDS.filter(w => new RegExp(`\\b${w}\\b`, 'i').test(text))

const contract = await import('../../src/prompt/mercuryContract.ts')
const { buildSubagentMercurySections } = await import('../../src/constants/subagentDoctrine.ts')

const seats: Array<[string, string | undefined]> = [
  ['coordinator', contract.MERCURY_COORDINATOR_CONTRACT],
  ['sub-agent', contract.MERCURY_SUBAGENT_CONTRACT],
]

section('§1 the owner\'s shape — two seat contracts beside the constitution, three to four sentences each, no example block, no retired word')
for (const [seat, text] of seats) {
  const ok = typeof text === 'string' && text.length > 0
  check(`${seat}: one exported constant, non-empty`, ok)
  if (!ok) continue
  const n = sentencesOf(text).length
  check(`${seat}: three to four sentences`, n >= 3 && n <= 4, `${n} sentences`)
  check(`${seat}: no example block`, !/<example>/.test(text))
  check(`${seat}: no retired word`, retiredIn(text).length === 0, retiredIn(text).join(', '))
  check(`${seat}: no tag inside the constant (the splice owns the tag)`, !/<\/?[a-z-]+>/.test(text))
}
check('the two constants are two different texts', new Set(seats.map(([, t]) => t)).size === 2)
check('the session seat has no contract of its own: the constitution is its whole text', !(J('MERCURY_SESSION', '_CONTRACT') in contract) && !(J('MERCURY_SESSION', '_DOCTRINE') in contract) && typeof contract.MERCURY_CONSTITUTION === 'string')

section('§2 the session seat — the constitution, no doctrine section, no gate')
{
  const sections = contract.getMercuryContractSections()
  check('the contract sections carry no identity or doctrine text (the constitution is a static section)', sections.every(s => s.name !== J('identity', '-floor') && s.name !== J('mercury', '-doctrine') && !s.text.includes('You are Mercury')))
  check('the session prompt carries neither the coordinator contract nor the sub-agent contract', !src('src/constants/prompts.ts').includes('MERCURY_COORDINATOR_CONTRACT') && !src('src/constants/prompts.ts').includes('MERCURY_SUBAGENT_CONTRACT'))
  check('no flag gates the constitution', !src('src/prompt/mercuryContract.ts').includes(J('MERCURY_WRAPPER', '_APPEND')) && !src('src/substrate/flagRegistry.ts').includes(J('MERCURY_WRAPPER', '_APPEND')))
}

section('§3 the sub-agent seat — element 0 is the constitution, element 1 the sub-agent contract in its tag, nothing of another seat')
{
  const sections = buildSubagentMercurySections({ agentDefinition: { agentType: 'mercury-crew' } })
  const operating = sections[1] ?? ''
  check('element 0 is the constitution', sections[0] === contract.MERCURY_CONSTITUTION)
  check('element 1 is the sub-agent contract inside the subagent-doctrine tag', operating === `<subagent-doctrine>\n${contract.MERCURY_SUBAGENT_CONTRACT}\n</subagent-doctrine>`)
  check('RED ON THE LONG DOCTRINE: element 1 carries three to four sentences', sentencesOf(operating).length >= 3 && sentencesOf(operating).length <= 4, `${sentencesOf(operating).length} sentences`)
  const joined = sections.join('\n')
  check('the sub-agent prompt carries no coordinator text', !joined.includes(contract.MERCURY_COORDINATOR_CONTRACT ?? '\u0000') && !joined.includes(contract.MERCURY_COORDINATOR_SEAT ?? '\u0000'))
  check('the fixed-output scout gets the same contract', buildSubagentMercurySections({ agentDefinition: { agentType: 'mercury-scout' } })[1] === operating)
}

section('§4 the coordinator seat — the constitution, its seat fact, the engine line, its contract, the persona, nowhere else')
{
  const call = src('src/services/concourse/coordinatorCall.ts')
  check('coordinatorCall composes the constitution, the seat fact, the engine line, the coordinator contract, the persona in that order', call.includes('asSystemPrompt([\n          MERCURY_CONSTITUTION,\n          MERCURY_COORDINATOR_SEAT,\n          engineLine,\n          MERCURY_COORDINATOR_CONTRACT,\n          input.contract,'))
  check('coordinatorCall names no other seat\'s contract', !call.includes('MERCURY_SUBAGENT_CONTRACT'))
  check('the sub-agent splice names no other seat\'s text', !src('src/constants/subagentDoctrine.ts').includes('MERCURY_COORDINATOR_CONTRACT') && !src('src/constants/subagentDoctrine.ts').includes('MERCURY_COORDINATOR_SEAT'))
  const persona = src('src/services/concourse/coordinatorPersona.ts')
  check('the coordinator contract speaks the persona\'s two names and never "agent"', /coordinator|operator/.test(contract.MERCURY_COORDINATOR_CONTRACT ?? '') && !/agent/i.test(contract.MERCURY_COORDINATOR_CONTRACT ?? '') && persona.includes('COORDINATOR_PERSONA'))
  check('the seat fact names the role and no second name, and states no second identity', contract.MERCURY_COORDINATOR_SEAT.includes('"coordinator" is your role, never a second name') && !contract.MERCURY_COORDINATOR_SEAT.startsWith('You are'))
}

section('§5 the same words where the seats agree')
{
  const [coordinator, subagent] = seats.map(([, t]) => t ?? '')
  check('both seat contracts open their evidence rule with "Claim only what"', [coordinator, subagent].every(t => t.includes('Claim only what')))
  check('each seat ends a block by naming what it needs from the operator or the caller', /with what you need named/.test(subagent) && /ask the smallest honest question/.test(coordinator))
  check('the constitution carries the shared laws the seats build on: the stop sentence, the evidence rule, the honesty line, the finishing clause', ["Outstanding work or verification never overrides an operator's instruction to stop.", 'Base claims on research first, tool outputs second, and best-practises third. Memory, documentation, and crewmate reports act as that; they are prone to being stale and dated.', 'and never mislead.', 'continue while useful, authorised work remains.'].every(words => contract.MERCURY_CONSTITUTION.includes(words)))
}

rmSync(process.env.MERCURY_CONFIG_DIR, { recursive: true, force: true })
console.log(`\n${failures === 0 ? '✅' : '❌'} seat contracts: ${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
