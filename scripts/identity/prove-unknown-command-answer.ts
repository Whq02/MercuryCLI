#!/usr/bin/env bun
// gate-watch: src/commands.ts src/commands/effectiveCatalogue.ts src/components/HelpV2/commandDomains.ts src/utils/processUserInput/processSlashCommand.tsx src/constants/querySource.ts README.md
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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

const dist = join(REPO, 'dist/mercury.mjs')
check('the built bundle stands for the headless door (bun run build.ts first)', existsSync(dist), dist)
if (existsSync(dist)) {
  const NODE = execFileSync('/bin/sh', ['-c', 'command -v node'], { encoding: 'utf8' }).trim()
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'unknown-command-door-')))
  const cwd = join(root, 'cwd')
  mkdirSync(cwd, { recursive: true })
  writeFileSync(
    join(root, '.config.json'),
    JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } } }),
  )
  const env = {
    HOME: root,
    PATH: process.env.PATH,
    MERCURY_CONFIG_DIR: root,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_DAEMON_DIR: join(root, 'daemon'),
    ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key',
    TMPDIR: tmpdir(),
  }
  const door = (name: string): { code: number | null; out: string; err: string } => {
    const result = spawnSync(NODE, [dist, 'run', `/${name}`], { cwd, env, encoding: 'utf8', input: '', timeout: 120_000 })
    return { code: result.status, out: result.stdout ?? '', err: result.stderr ?? '' }
  }
  try {
    const retired = door(RETIRED)
    const never = door(NEVER_HAD)
    check("typed at the headless door, the name gets the runner's own unknown-skill line and exit 0", retired.code === 0 && retired.out.trim() === `Unknown skill: ${RETIRED}`, JSON.stringify(retired))
    check('…byte for byte the answer a never-registered name gets, with the name swapped', retired.code === never.code && retired.out === never.out.replaceAll(NEVER_HAD, RETIRED) && retired.err === never.err, JSON.stringify(never))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(` ✅ UNKNOWN COMMAND ANSWER GREEN (${checks} checks)`)
  process.exit(0)
}
console.log(` ❌ UNKNOWN COMMAND ANSWER RED (${failures} of ${checks} checks failed)`)
process.exit(1)
