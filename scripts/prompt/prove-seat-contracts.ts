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
  ['sub-agent', contract.MERCURY_SUBAGENT_CONTRACT],
]

section('§1 the owner\'s shape — one seat contract beside the constitution, three to four sentences, no example block, no retired word')
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
check('the sub-agent\'s is the one seat contract the module exports', Object.keys(contract).filter(k => /^MERCURY_[A-Z_]*_CONTRACT$/.test(k)).join(',') === 'MERCURY_SUBAGENT_CONTRACT', Object.keys(contract).filter(k => /_CONTRACT$/.test(k)).join(','))
check('the session seat has no contract of its own: the constitution is its whole text', !(J('MERCURY_SESSION', '_CONTRACT') in contract) && !(J('MERCURY_SESSION', '_DOCTRINE') in contract) && typeof contract.MERCURY_CONSTITUTION === 'string')

section('§2 the session seat — the constitution, no doctrine section, no gate')
{
  const sections = contract.getMercuryContractSections()
  check('the contract sections carry no identity or doctrine text (the constitution is a static section)', sections.every(s => s.name !== J('identity', '-floor') && s.name !== J('mercury', '-doctrine') && !s.text.includes('You are Mercury')))
  check('the session prompt carries no seat contract', !src('src/constants/prompts.ts').includes('MERCURY_SUBAGENT_CONTRACT'))
  check('no flag gates the constitution', !src('src/prompt/mercuryContract.ts').includes(J('MERCURY_WRAPPER', '_APPEND')) && !src('src/substrate/flagRegistry.ts').includes(J('MERCURY_WRAPPER', '_APPEND')))
}

section('§3 the sub-agent seat — element 0 is the constitution, element 1 the sub-agent contract in its tag, nothing of another seat')
{
  const sections = buildSubagentMercurySections({ agentDefinition: { agentType: 'mercury-crew' } })
  const operating = sections[1] ?? ''
  check('element 0 is the constitution', sections[0] === contract.MERCURY_CONSTITUTION)
  check('element 1 is the sub-agent contract inside the subagent-doctrine tag', operating === `<subagent-doctrine>\n${contract.MERCURY_SUBAGENT_CONTRACT}\n</subagent-doctrine>`)
  check('RED ON THE LONG DOCTRINE: element 1 carries three to four sentences', sentencesOf(operating).length >= 3 && sentencesOf(operating).length <= 4, `${sentencesOf(operating).length} sentences`)
  check('the fixed-output scout gets the same contract', buildSubagentMercurySections({ agentDefinition: { agentType: 'mercury-scout' } })[1] === operating)
}

section('§4 the words the seat shares with the constitution')
{
  const subagent = contract.MERCURY_SUBAGENT_CONTRACT ?? ''
  check('the seat contract opens its evidence rule with "Claim only what"', subagent.includes('Claim only what'))
  check('the seat ends a block by naming what it needs from the caller', /with what you need named/.test(subagent))
  check('the constitution carries the shared laws the seats build on: the stop sentence, the evidence rule, the honesty line, the finishing clause', ["Outstanding work and verification never override that instruction.", 'Use evidence appropriate to the claim.', 'Never invent a result or present an assumption as an observation.', 'Before ending, finish any useful work that remains both requested and authorised.'].every(words => contract.MERCURY_CONSTITUTION.includes(words)))
}

rmSync(process.env.MERCURY_CONFIG_DIR, { recursive: true, force: true })
console.log(`\n${failures === 0 ? '✅' : '❌'} seat contracts: ${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
