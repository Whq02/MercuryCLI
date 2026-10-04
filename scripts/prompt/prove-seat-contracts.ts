;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'seat-contracts-'))
delete process.env.MERCURY_WRAPPER_APPEND

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
  ['session', contract.MERCURY_SESSION_CONTRACT],
  ['coordinator', contract.MERCURY_COORDINATOR_CONTRACT],
  ['sub-agent', contract.MERCURY_SUBAGENT_CONTRACT],
]

section('§1 the owner\'s shape — three contracts, three to four sentences each, no example block, no retired word')
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
check('the three constants are three different texts', new Set(seats.map(([, t]) => t)).size === 3)

section('§2 the session seat — the doctrine section IS the session contract, in its tag, gated')
{
  const on = contract.getMercuryContractSections()
  const doctrine = on.find(s => s.name === 'mercury-doctrine')
  const body = doctrine?.text ?? ''
  const n = sentencesOf(body).length
  check('the doctrine section is present with the layer on', doctrine !== undefined)
  check('RED ON THE LONG DOCTRINE: the section carries three to four sentences', n >= 3 && n <= 4, `${n} sentences`)
  check('RED ON THE LONG DOCTRINE: the section carries no example block', !/<example>/.test(body))
  check('RED ON THE LONG DOCTRINE: the section carries no retired word', retiredIn(body).length === 0, retiredIn(body).join(', '))
  check('the section is the session contract inside the mercury-doctrine tag', body === `<mercury-doctrine>\n${contract.MERCURY_SESSION_CONTRACT}\n</mercury-doctrine>`)
  check('the session prompt carries neither the coordinator contract nor the sub-agent contract', on.every(s => !s.text.includes(contract.MERCURY_COORDINATOR_CONTRACT ?? '\u0000') && !s.text.includes(contract.MERCURY_SUBAGENT_CONTRACT ?? '\u0000')))
  process.env.MERCURY_WRAPPER_APPEND = '0'
  const off = contract.getMercuryContractSections()
  check('MERCURY_WRAPPER_APPEND=0 drops the session contract and keeps the floor first', off[0]?.name === 'identity-floor' && off.every(s => !s.text.includes(contract.MERCURY_SESSION_CONTRACT ?? '\u0000')))
  delete process.env.MERCURY_WRAPPER_APPEND
}

section('§3 the sub-agent seat — element 1 is the sub-agent contract in its tag, nothing of another seat')
{
  const sections = buildSubagentMercurySections({ agentDefinition: { agentType: 'mercury-crew' } })
  const operating = sections[1] ?? ''
  check('element 0 is the identity floor', sections[0] === contract.MERCURY_IDENTITY_FLOOR)
  check('element 1 is the sub-agent contract inside the subagent-doctrine tag', operating === `<subagent-doctrine>\n${contract.MERCURY_SUBAGENT_CONTRACT}\n</subagent-doctrine>`)
  check('RED ON THE LONG DOCTRINE: element 1 carries three to four sentences', sentencesOf(operating).length >= 3 && sentencesOf(operating).length <= 4, `${sentencesOf(operating).length} sentences`)
  const joined = sections.join('\n')
  check('the sub-agent prompt carries neither the session contract nor the coordinator contract', !joined.includes(contract.MERCURY_SESSION_CONTRACT ?? '\u0000') && !joined.includes(contract.MERCURY_COORDINATOR_CONTRACT ?? '\u0000'))
  check('the fixed-output scout gets the same contract', buildSubagentMercurySections({ agentDefinition: { agentType: 'mercury-scout' } })[1] === operating)
}

section('§4 the coordinator seat — composed between the engine line and the persona, nowhere else')
{
  const call = src('src/services/concourse/coordinatorCall.ts')
  check('coordinatorCall composes floor, engine line, coordinator contract, persona in that order', call.includes('asSystemPrompt([\n          MERCURY_COORDINATOR_FLOOR,\n          engineLine,\n          MERCURY_COORDINATOR_CONTRACT,\n          input.contract,'))
  check('coordinatorCall names no other seat\'s contract', !call.includes('MERCURY_SESSION_CONTRACT') && !call.includes('MERCURY_SUBAGENT_CONTRACT'))
  check('the session splice names no other seat\'s contract', !src('src/constants/prompts.ts').includes('MERCURY_COORDINATOR_CONTRACT') && !src('src/constants/prompts.ts').includes('MERCURY_SUBAGENT_CONTRACT'))
  check('the sub-agent splice names no other seat\'s contract', !src('src/constants/subagentDoctrine.ts').includes('MERCURY_SESSION_CONTRACT') && !src('src/constants/subagentDoctrine.ts').includes('MERCURY_COORDINATOR_CONTRACT'))
  const persona = src('src/services/concourse/coordinatorPersona.ts')
  check('the coordinator contract speaks the persona\'s two names and never "agent"', /coordinator|operator/.test(contract.MERCURY_COORDINATOR_CONTRACT ?? '') && !/agent/i.test(contract.MERCURY_COORDINATOR_CONTRACT ?? '') && persona.includes('COORDINATOR_PERSONA'))
}

section('§5 the same words where the seats agree')
{
  const [session, coordinator, subagent] = seats.map(([, t]) => t ?? '')
  check('every seat opens its evidence rule with "Claim only what"', [session, coordinator, subagent].every(t => t.includes('Claim only what')))
  const persist = 'keep going while evidence advances the outcome'
  check('the session and the sub-agent carry the persistence clause in the same words', session.includes(persist) && subagent.includes(persist))
  check('every seat ends a block by naming what it needs from the operator or the caller', /input only the operator can give/.test(session) && /with what you need named/.test(subagent) && /ask the smallest honest question/.test(coordinator))
}

rmSync(process.env.MERCURY_CONFIG_DIR, { recursive: true, force: true })
console.log(`\n${failures === 0 ? '✅' : '❌'} seat contracts: ${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
