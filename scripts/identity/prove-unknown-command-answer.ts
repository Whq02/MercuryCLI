#!/usr/bin/env bun
// gate-watch: src/commands.ts src/commands/effectiveCatalogue.ts src/components/HelpV2/commandDomains.ts src/utils/processUserInput/processSlashCommand.tsx src/constants/querySource.ts README.md
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'

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
const NAMES = [RETIRED, 'doctor', 'party', 'multiplayer', 'rooms', 'share', 'invite', 'handoff', 'delegate', 'prompt', 'request', 'tickets', 'say', 'security-review', 'terminal-setup', 'pr-comments', 'cost', 'color', 'release-notes', 'heapdump', 'files', 'mock-limits', 'supervisor', 'view', 'harness', 'counsel', 'ledger', 'substrate', 'authority', 'sovereign', 'policy', 'provenance', 'home', 'fullscreen', 'cockpit', 'deck', 'monitor', 'fleet', 'live', 'capabilities-detail', 'agent-form', 'sessiontab', 'surfaces', 'manager', 'debrief', 'status', 'auto-compact-window', 'continue', 'halt', 'speak', 'jevor', 'accent', 'branch', 'branches', 'fork', 'init', 'router']
const NEVER_HAD = 'frobnicate'
const NOT_A_COMMAND: Record<string, string> = {
  'src/constants/changelog.ts': 'the release history: each release names what it shipped',
  'src/tools/GitTool/GitTool.ts /branch': 'the mercury://repo/branch resource address',
}
const roadPattern = new RegExp('(?<![\\w./\\\\<:-])/(' + NAMES.map(name => name.replace(/-/g, '\\-')).join('|') + ')(?![\\w/\\\\-])', 'g')
const productFiles = (dir: string): string[] => readdirSync(dir).flatMap(entry => {
  const path = join(dir, entry)
  if (statSync(path).isDirectory()) return productFiles(path)
  return /\.tsx?$/.test(entry) && !entry.endsWith('.d.ts') ? [path] : []
})
const roads = new Map<string, string[]>()
for (const path of productFiles(join(REPO, 'src'))) {
  const rel = relative(REPO, path)
  if (NOT_A_COMMAND[rel] !== undefined) continue
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const visit = (node: ts.Node): void => {
    const words = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node) ? node.text : undefined
    for (const match of words === undefined ? [] : words.matchAll(roadPattern)) {
      if (NOT_A_COMMAND[`${rel} /${match[1]}`] !== undefined) continue
      roads.set(match[1]!, [...(roads.get(match[1]!) ?? []), `${rel}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`])
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}
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
  check("the README's command table carries no such cell", !readme.includes(`\`/${name}\``))
  check('no product string names it — no link, click, hint, tip or receipt leads a user to an unknown command', !roads.has(name), (roads.get(name) ?? []).join(' · '))
}
check('the roster module imports no such command', !readFileSync(join(REPO, 'src/commands.ts'), 'utf8').includes(RETIRED) && !readFileSync(join(REPO, 'src/commands.ts'), 'utf8').includes('retired'))
check('the query sources name no such caller', !readFileSync(join(REPO, 'src/constants/querySource.ts'), 'utf8').includes(RETIRED))

check('/audit is the security prompt', commands.findCommand('audit', roster)?.type === 'prompt' && commands.findCommand('audit', roster)?.description === 'Analyze the changes on this branch for security risks')

console.log('\n/resume — a road that lives elsewhere gets its named pointer, not a new command (the round-14 Windows row F39W-14A-04)')
const RESUME_POINTER = 'the session picker is /sessions; a specific session resumes with `mercury --resume <id>`'
const resumeLine = slash.unknownCommandLine('resume', roster)
check('/resume is not a registered command, by name or alias', commands.findCommand('resume', roster) === undefined && roster.every(command => !(command.aliases ?? []).includes('resume')))
check('typed, /resume answers the unknown-command sentence with the pointer to /sessions and `mercury --resume <id>`', resumeLine === `Unknown command: /resume — ${RESUME_POINTER} · /help lists commands`, resumeLine)
check('the pointer names a command that exists (/sessions)', commands.findCommand('sessions', roster) !== undefined)
check('the pointer table carries exactly that spelling', (slash as { UNKNOWN_COMMAND_POINTERS?: Readonly<Record<string, string>> }).UNKNOWN_COMMAND_POINTERS?.resume === RESUME_POINTER)
check('the pointer leads only to roads that exist — a registered command and the CLI flag — never to the unknown name itself', /\/sessions/.test(RESUME_POINTER) && /mercury --resume <id>/.test(RESUME_POINTER) && !/\/resume\b(?! <id>)/.test(RESUME_POINTER.replace('--resume', '')))
check('/resume still has no row anywhere: the roster, the aliases, the effective catalogue, the help domains', commands.findCommand('resume', roster) === undefined && surfaces.every(surface => surface.name !== 'resume' && !surface.aliases.includes('resume')) && domains.COMMAND_DOMAINS.every(domain => !domain.names.includes('resume')))
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
    const resumed = door('resume')
    check('typed at the headless door, /resume gets the pointer on stderr and exit 1 (nothing on stdout)', resumed.code === 1 && resumed.out === '' && resumed.err.trim() === `Unknown command: /resume — ${RESUME_POINTER} · /help lists commands`, JSON.stringify(resumed))
    for (const name of NAMES) {
      if (existsSync(`/${name}`)) continue
      const typed = door(name)
      check(`typed at the headless door, /${name} gets the cockpit's unknown-command sentence on stderr and exit 1 (nothing on stdout)`, typed.code === 1 && typed.out === '' && typed.err.trim().startsWith(`Unknown command: /${name}`) && typed.err.trim().endsWith('/help lists commands'), JSON.stringify(typed))
      check('…the same shape a never-registered name gets (exit, stdout and the sentence with the name swapped; a nearest-name pointer may differ)', typed.code === never.code && typed.out === never.out && shape(typed.err, name) === shape(never.err, NEVER_HAD), JSON.stringify(never))
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
