#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-crewmates-command-')))
const HOME = join(SCRATCH, 'home')
const CWD = join(SCRATCH, 'project')
mkdirSync(HOME, { recursive: true })
mkdirSync(CWD, { recursive: true })
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.NODE_ENV
delete process.env.CI
delete process.env.MERCURY_CONCOURSE_WORKER

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(HOME, [CWD])
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { builtinCommands, builtInCommandNames, findCommand, getCommandName } = await import('../../src/commands.ts')
const words = await import('../../src/utils/cockpit/crewmateWords.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' /crewmates opens the crew view; /teammates still does as the old name')
console.log('============================================================')

const registry = [...builtinCommands()]
const crewmates = findCommand('crewmates', registry)
const teammates = findCommand('teammates', registry)
check('/crewmates is a built-in command', crewmates !== undefined, crewmates === undefined ? 'findCommand("crewmates") is undefined — the name is unknown' : getCommandName(crewmates))
check('/crewmates is the command\'s own name, not an alias', crewmates !== undefined && crewmates.name === 'crewmates', crewmates === undefined ? 'no command' : `name ${crewmates.name}`)
check('/teammates resolves to the very same command (the old name keeps working)', crewmates !== undefined && teammates !== undefined && teammates === crewmates, teammates === undefined ? 'findCommand("teammates") is undefined' : `resolves to ${getCommandName(teammates)}`)
check('teammates is carried as an alias row, in the register of runs/tasks', crewmates !== undefined && (crewmates.aliases ?? []).includes('teammates'), crewmates === undefined ? 'no command' : `aliases ${JSON.stringify(crewmates.aliases ?? [])}`)
check('the command-name catalogue carries both spellings', builtInCommandNames().has('crewmates') && builtInCommandNames().has('teammates'), [...builtInCommandNames()].filter(n => /mates$/.test(n)).join(' '))
check('the crew view stays a concourse surface under the new name', crewmates !== undefined && crewmates.needsConcourse === true)
check('the command speaks of the crew, not the team', crewmates !== undefined && /\bcrew/i.test(crewmates.description) && !/\bteam(mate)?s?\b/i.test(crewmates.description), crewmates === undefined ? 'no command' : crewmates.description)
const registered = registry.filter(c => c.name === 'crewmates' || c.name === 'teammates')
check('exactly one registry row serves both names', registered.length === 1, registered.map(c => c.name).join(', '))

console.log('\n the doors the crew words print name /crewmates')
const doors = [
  ['CREW_CLEAR_DOOR', words.CREW_CLEAR_DOOR],
  ['crewmateSendClause (a stopped local crewmate)', words.crewmateSendClause({ name: 'atlas', pinned: false, live: false, local: true })],
  ['CREWMATE_BETWEEN_TURNS_DETAIL', words.CREWMATE_BETWEEN_TURNS_DETAIL],
  ['crewmateStatusRightHint (viewing, live)', words.crewmateStatusRightHint(false, true)],
  ['crewmateCardKeys (viewing, landed)', words.crewmateCardKeys(false, false)],
] as const
for (const [label, text] of doors) {
  check(`${label} says /crewmates and never /teammates`, text.includes('/crewmates') && !text.includes('/teammates'), text)
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(`\nprove-crewmates-command: ${failures === 0 ? 'green' : `${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)
