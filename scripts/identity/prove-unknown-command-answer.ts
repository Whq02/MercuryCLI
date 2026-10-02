#!/usr/bin/env bun
// gate-watch: src/commands.ts src/commands/effectiveCatalogue.ts src/components/HelpV2/commandDomains.ts src/utils/processUserInput/processSlashCommand.tsx src/constants/querySource.ts README.md
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'unknown-command-home-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME

const REPO = resolve(import.meta.dir, '..', '..')
let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('a slash name Mercury does not have answers as any unknown command does')

const commands = await import('../../src/commands.ts')
const slash = await import('../../src/utils/processUserInput/processSlashCommand.tsx')
const catalogue = await import('../../src/commands/effectiveCatalogue.ts')
const domains = await import('../../src/components/HelpV2/commandDomains.ts')

const roster = [...commands.builtinCommands()]
const RETIRED = 'insights'
const NEVER_HAD = 'frobnicate'

check('the built-in roster carries no row for the name', commands.findCommand(RETIRED, roster) === undefined)
check('…exactly as for a name Mercury never had', commands.findCommand(NEVER_HAD, roster) === undefined)
check('no built-in command claims it as an alias', roster.every(command => !(command.aliases ?? []).includes(RETIRED)))
check('the effective catalogue carries no row for it', catalogue.effectiveCatalogue().every(surface => surface.name !== RETIRED), catalogue.effectiveCatalogue().map(s => s.name).filter(n => n === RETIRED).join(','))
check('no /help domain lists it', domains.COMMAND_DOMAINS.every(domain => !domain.names.includes(RETIRED)))

const retiredLine = slash.unknownCommandLine(RETIRED, roster)
const neverLine = slash.unknownCommandLine(NEVER_HAD, roster)
const shape = (line: string, name: string): string => line.replace(`/${name}`, '/<name>').replace(/ — closest: \/[\w:-]+/, '')
check('typed, it answers with the ordinary unknown-command sentence', retiredLine.startsWith(`Unknown command: /${RETIRED}`) && retiredLine.endsWith('/help lists commands'), retiredLine)
check('…the same sentence a never-registered name gets (no special line, no pointer to a replacement)', shape(retiredLine, RETIRED) === shape(neverLine, NEVER_HAD), `${retiredLine} | ${neverLine}`)
check('the sentence never says the name was ever a command', !/retired|removed|renamed|no longer|replaced|use \//.test(retiredLine), retiredLine)

check('the command module is gone from the tree', !existsSync(join(REPO, 'src/commands', `${RETIRED}.ts`)))
check('the roster module imports no such command', !readFileSync(join(REPO, 'src/commands.ts'), 'utf8').includes(RETIRED))
check('the query sources name no such caller', !readFileSync(join(REPO, 'src/constants/querySource.ts'), 'utf8').includes(RETIRED))
const readme = readFileSync(join(REPO, 'README.md'), 'utf8')
check("the README's command table carries no such cell", !readme.includes(`\`/${RETIRED}\``))

console.log('\n============================================================')
if (failures === 0) {
  console.log(` ✅ UNKNOWN COMMAND ANSWER GREEN (${checks} checks)`)
  process.exit(0)
}
console.log(` ❌ UNKNOWN COMMAND ANSWER RED (${failures} of ${checks} checks failed)`)
process.exit(1)
