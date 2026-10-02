#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
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
const { unknownCommandLine } = await import('../../src/utils/processUserInput/processSlashCommand.tsx')
const words = await import('../../src/utils/cockpit/crewmateWords.ts')
const { readFileSync } = await import('node:fs')
const ROOT = join(import.meta.dir, '..', '..')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' /crewmates opens the crew view; /teammates is no command and no hidden alias')
console.log('============================================================')

const registry = [...builtinCommands()]
const crewmates = findCommand('crewmates', registry)
const teammates = findCommand('teammates', registry)
check('/crewmates is a built-in command', crewmates !== undefined, crewmates === undefined ? 'findCommand("crewmates") is undefined — the name is unknown' : getCommandName(crewmates))
check('/crewmates is the command\'s own name, not an alias', crewmates !== undefined && crewmates.name === 'crewmates', crewmates === undefined ? 'no command' : `name ${crewmates.name}`)
check('/teammates is no command: the old name resolves to nothing', teammates === undefined, teammates === undefined ? '' : `resolves to ${getCommandName(teammates)}`)
check('the command carries no alias row at all (no hidden spelling)', crewmates !== undefined && (crewmates.aliases ?? []).length === 0, crewmates === undefined ? 'no command' : `aliases ${JSON.stringify(crewmates.aliases ?? [])}`)
check('the command-name catalogue carries crewmates and not teammates', builtInCommandNames().has('crewmates') && !builtInCommandNames().has('teammates'), [...builtInCommandNames()].filter(n => /mates$/.test(n)).join(' '))
const unknown = unknownCommandLine('teammates', registry)
check('the palette answers /teammates with its unknown-command sentence, pointing at /help', unknown === 'Unknown command: /teammates · /help lists commands', unknown)
check('…and never names /crewmates as the command that ran, nor the crew view\'s foreground refusal', !unknown.includes('/crewmates command') && !/interactive surface/.test(unknown), unknown)
check('no spelling table maps the old command name — or any old crew word — to the new', !existsSync(join(ROOT, 'src', 'migrations', 'retiredCrewSpellings.ts')))
check('the crew view stays a concourse surface under the new name', crewmates !== undefined && crewmates.needsConcourse === true)
check('the command speaks of the crew, not the team', crewmates !== undefined && /\bcrew/i.test(crewmates.description) && !/\bteam(mate)?s?\b/i.test(crewmates.description), crewmates === undefined ? 'no command' : crewmates.description)
const registered = registry.filter(c => c.name === 'crewmates' || c.name === 'teammates')
check('exactly one registry row, and it is named crewmates', registered.length === 1 && registered[0]?.name === 'crewmates', registered.map(c => c.name).join(', '))
const commandSource = readFileSync(join(ROOT, 'src', 'commands', 'crewmates', 'crewmates.tsx'), 'utf8')
check('/crewmates opens the crew view (the bare command opens it; a name opens that crewmate\'s chat)', /openCrewView\(\)/.test(commandSource) && /<CrewView/.test(commandSource))

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
