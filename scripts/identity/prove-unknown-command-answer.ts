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
const NAMES = [RETIRED, 'doctor', 'party', 'multiplayer', 'rooms', 'share', 'invite', 'handoff', 'delegate', 'prompt', 'request', 'tickets', 'say', 'security-review', 'terminal-setup', 'pr-comments', 'cost', 'color', 'release-notes', 'heapdump', 'files', 'mock-limits']
const NEVER_HAD = 'frobnicate'
const shape = (line: string, name: string): string => line.replace(`/${name}`, '/<name>').replace(/ — closest: \/[\w:-]+/, '')
const neverLine = slash.unknownCommandLine(NEVER_HAD, roster)
const surfaces = catalogue.effectiveCatalogue()
const readme = readFileSync(join(REPO, 'README.md'), 'utf8')

check('a name Mercury never had resolves to no command', commands.findCommand(NEVER_HAD, roster) === undefined)
for (const name of NAMES) {
  console.log(`\n/${name}`)
  check('the built-in roster carries no row for the name', commands.findCommand(name, roster) === undefined)
  check('no built-in command claims it as an alias', roster.every(command => !(command.aliases ?? []).includes(name)))
  check('the effective catalogue carries no row for it, by name or alias', surfaces.every(surface => surface.name !== name && !surface.aliases.includes(name)), surfaces.filter(s => s.name === name || s.aliases.includes(name)).map(s => s.name).join(','))
  check('no /help domain lists it', domains.COMMAND_DOMAINS.every(domain => !domain.names.includes(name)))
  const line = slash.unknownCommandLine(name, roster)
  check('typed, it answers with the ordinary unknown-command sentence', line.startsWith(`Unknown command: /${name}`) && line.endsWith('/help lists commands'), line)
  check('…the same sentence a never-registered name gets (no special line, no pointer to a replacement)', shape(line, name) === shape(neverLine, NEVER_HAD), `${line} | ${neverLine}`)
  check('the sentence never says the name was ever a command', !/retired|removed|renamed|no longer|replaced|use \//.test(line), line)
  check('the command module is gone from the tree', !existsSync(join(REPO, 'src/commands', `${name}.ts`)) && !existsSync(join(REPO, 'src/commands', name)))
  check("the README's command table carries no such cell", !readme.includes(`\`/${name}\``))
}
check('the roster module imports no such command', !readFileSync(join(REPO, 'src/commands.ts'), 'utf8').includes(RETIRED) && !readFileSync(join(REPO, 'src/commands.ts'), 'utf8').includes('retired'))
check('the query sources name no such caller', !readFileSync(join(REPO, 'src/constants/querySource.ts'), 'utf8').includes(RETIRED))

check('/audit is the security prompt', commands.findCommand('audit', roster)?.type === 'prompt' && commands.findCommand('audit', roster)?.description === 'Analyze the changes on this branch for security risks')
check('/keysetup is the terminal-key action', commands.findCommand('keysetup', roster)?.type === 'local-jsx')

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
    const never = door(NEVER_HAD)
    for (const name of NAMES) {
      const typed = door(name)
      check(`typed at the headless door, /${name} gets the runner's own unknown-skill line and exit 0`, typed.code === 0 && typed.out.trim() === `Unknown skill: ${name}`, JSON.stringify(typed))
      check('…byte for byte the answer a never-registered name gets, with the name swapped', typed.code === never.code && typed.out === never.out.replaceAll(NEVER_HAD, name) && typed.err === never.err, JSON.stringify(never))
    }
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
