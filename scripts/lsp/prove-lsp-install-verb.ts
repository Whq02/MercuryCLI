#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'lsp-install-home-')))
const PROJ = realpathSync(mkdtempSync(join(tmpdir(), 'lsp-install-proj-')))
const BIN = join(HOME, 'bin')
mkdirSync(BIN, { recursive: true })
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_DAEMON_DIR = join(HOME, 'daemon')
mkdirSync(process.env.MERCURY_DAEMON_DIR, { recursive: true })
delete process.env.MERCURY_LSP
process.chdir(PROJ)

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}`)
const ROOT = resolve(import.meta.dir, '..', '..')
const source = (relative: string): string => readFileSync(join(ROOT, relative), 'utf8')

const systemPath = process.env.PATH ?? ''
const scratchPath = (...extra: string[]): string => [BIN, ...extra, '/usr/bin', '/bin'].join(delimiter)
const usePath = (path: string): void => {
  process.env.PATH = path
}
const fakeTool = (name: string, body: string): string => {
  const path = join(BIN, name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}
const fakeBinary = (name: string): string => fakeTool(name, 'exit 0')

const catalogue = await import('../../src/services/lsp/serverCatalogue.ts')
const verb = await import('../../src/cli/lspVerb.ts').catch(() => null)

type Io = NonNullable<typeof verb>['lspListCli'] extends (io: infer I) => unknown ? I : never
type Plan = { file: string; args: string[]; windowsVerbatimArguments: boolean }
type Run = { out: string[]; err: string[]; asked: string[]; ran: string[][]; plans: Plan[]; io: Io }
function harness(options: { interactive?: boolean; answer?: boolean; exitCode?: number | null; onRun?: (argv: string[]) => void } = {}): Run {
  const run: Run = { out: [], err: [], asked: [], ran: [], plans: [], io: undefined as never }
  run.io = {
    out: line => run.out.push(line),
    err: line => run.err.push(line),
    interactive: options.interactive ?? true,
    ask: async question => {
      run.asked.push(question)
      return options.answer ?? true
    },
    run: async (plan: Plan | string[]) => {
      const argv = Array.isArray(plan) ? plan : [plan.file, ...plan.args]
      if (!Array.isArray(plan)) run.plans.push(plan)
      run.ran.push(argv)
      options.onRun?.(argv)
      return options.exitCode === undefined ? 0 : options.exitCode
    },
  } as Io
  return run
}
const text = (lines: string[]): string => lines.join('\n')

section('§1 lsp list prints the whole catalogue: every row installed (with its binary) or absent (with its remedy)')
{
  usePath(scratchPath())
  const marksman = fakeBinary('marksman')
  const run = harness()
  const code = verb ? await verb.lspListCli(run.io) : -1
  const body = text(run.out)
  check('the verb exits 0', code === 0, body)
  check('every catalogue id has a line', catalogue.SERVER_CATALOGUE.every(entry => run.out.some(line => line.startsWith(entry.id + ' ') || line.startsWith(entry.id + '  '))), body)
  check('the installed server shows installed with the binary path', run.out.some(line => /^marksman\s+installed\s+/.test(line) && line.includes(marksman)), body)
  check('an absent server shows absent with its exact remedy', run.out.some(line => /^gopls\s+absent\s+go install golang\.org\/x\/tools\/gopls@latest/.test(line)), body)
  check('each line names the languages', run.out.some(line => line.startsWith('rust-analyzer') && line.endsWith('[rust]')), body)
  const installedNow = catalogue.SERVER_CATALOGUE.filter(entry => catalogue.probeCatalogueEntry(entry, PROJ).binaryPath).length
  check('the tally and the install line close the list, and say a server is never installed on its own', installedNow >= 1 && run.out[run.out.length - 1]?.startsWith(`${installedNow} of ${catalogue.SERVER_CATALOGUE.length} installed · install one with: `) === true && run.out[run.out.length - 1]!.endsWith('lsp install <server> · a server is never installed on its own'), `${installedNow} installed by the probe · ${run.out[run.out.length - 1] ?? ''}`)
  rmSync(marksman)
}

section('§2 lsp install shows the remedy, asks, runs exactly it, and reports where the binary landed')
{
  usePath(scratchPath())
  const brewLog = join(HOME, 'brew.log')
  fakeTool('brew', `echo "$@" >> ${JSON.stringify(brewLog)}\nif [ "$1" = install ] && [ "$2" = marksman ]; then printf '#!/bin/sh\\nexit 0\\n' > ${JSON.stringify(join(BIN, 'marksman'))}; chmod +x ${JSON.stringify(join(BIN, 'marksman'))}; fi`)
  const asked = harness({ answer: true, onRun: argv => { Bun.spawnSync(argv, { env: process.env }) } })
  const code = verb ? await verb.lspInstallCli('marksman', { yes: false }, asked.io) : -1
  check('the verb exits 0', code === 0, `${text(asked.out)}\n${text(asked.err)}`)
  check('it shows the remedy before asking', asked.out[0] === 'Install Marksman (Markdown) (markdown) by running:' && asked.out[1] === '  brew install marksman', text(asked.out))
  check('it asks once', asked.asked.length === 1 && asked.asked[0] === 'Run it?', JSON.stringify(asked.asked))
  check('it runs exactly the remedy, as argv, with the tool resolved to the file the PATH walk found', JSON.stringify(asked.ran) === JSON.stringify([[join(BIN, 'brew'), 'install', 'marksman']]) && asked.plans[0]?.windowsVerbatimArguments === false, JSON.stringify(asked.ran))
  check('the fake brew was invoked with those words', existsSync(brewLog) && readFileSync(brewLog, 'utf8').trim() === 'install marksman', existsSync(brewLog) ? readFileSync(brewLog, 'utf8') : 'no log')
  check('it reports where the binary landed and when Mercury offers it', asked.out[2] === `Installed Marksman (Markdown): ${join(BIN, 'marksman')} — Mercury offers it in projects that carry its files`, text(asked.out))
  const again = harness()
  const second = verb ? await verb.lspInstallCli('marksman', { yes: true }, again.io) : -1
  check('an installed server is reported as installed and nothing is run', second === 0 && again.ran.length === 0 && again.out[0] === `Marksman (Markdown) is already installed: ${join(BIN, 'marksman')} — nothing to run`, text(again.out))
  rmSync(join(BIN, 'marksman'), { force: true })
  const declined = harness({ answer: false })
  const no = verb ? await verb.lspInstallCli('marksman', { yes: false }, declined.io) : -1
  check('answering no runs nothing and exits 1', no === 1 && declined.ran.length === 0 && declined.out.includes('Nothing run.'), text(declined.out))
  const scripted = harness({ interactive: false })
  const noTty = verb ? await verb.lspInstallCli('marksman', { yes: false }, scripted.io) : -1
  check('no terminal and no --yes: refused with the --yes hint, nothing run', noTty === 2 && scripted.ran.length === 0 && scripted.err[0] === 'Not a terminal: pass --yes to run the install command without the question', text(scripted.err))
  const yes = harness({ interactive: false, onRun: argv => { Bun.spawnSync(argv, { env: process.env }) } })
  const scriptedYes = verb ? await verb.lspInstallCli('marksman', { yes: true }, yes.io) : -1
  check('--yes runs without the question', scriptedYes === 0 && yes.asked.length === 0 && yes.ran.length === 1 && existsSync(join(BIN, 'marksman')), `${text(yes.out)}\n${text(yes.err)}`)
  rmSync(join(BIN, 'marksman'), { force: true })
  check('the server\'s binary name is accepted as well as its id', verb !== null && verb.catalogueRowNamed('csharp-ls')?.id === 'csharp' && verb.catalogueRowNamed('CSHARP')?.id === 'csharp' && verb.catalogueRowNamed('OmniSharp')?.id === 'csharp')
}

section('§3 refusals: an unknown server (with the roster), a failing remedy, a remedy whose tool is absent, a remedy that is words, a remedy that lands nothing')
{
  usePath(scratchPath())
  const unknown = harness()
  const code = verb ? await verb.lspInstallCli('clangd-ultra', { yes: true }, unknown.io) : -1
  check('an unknown server is refused with the roster, nothing run', code === 2 && unknown.ran.length === 0 && unknown.err[0]?.startsWith('No language server named "clangd-ultra" in the catalogue. Known servers: rust-analyzer, gopls, ') === true && catalogue.SERVER_CATALOGUE.every(entry => unknown.err[0]!.includes(entry.id)), text(unknown.err))
  const failing = harness({ exitCode: 7 })
  const failed = verb ? await verb.lspInstallCli('marksman', { yes: true }, failing.io) : -1
  check('a remedy that exits non-zero is reported with its code; nothing is claimed installed', failed === 1 && failing.err[0] === 'The install command exited 7; Marksman (Markdown) was not installed' && !failing.out.some(line => line.startsWith('Installed')), text(failing.err))
  const unstartable = harness({ exitCode: null })
  const notStarted = verb ? await verb.lspInstallCli('marksman', { yes: true }, unstartable.io) : -1
  check('a remedy that cannot be started says so', notStarted === 1 && unstartable.err[0] === 'The install command could not be started: brew install marksman', text(unstartable.err))
  const landedNothing = harness({ exitCode: 0 })
  const nothing = verb ? await verb.lspInstallCli('marksman', { yes: true }, landedNothing.io) : -1
  check('a remedy that exits 0 but leaves no binary on PATH is not reported as installed', nothing === 1 && landedNothing.err[0]?.startsWith('The install command finished, but no marksman is on PATH yet') === true, text(landedNothing.err))
  rmSync(join(BIN, 'brew'), { force: true })
  const noTool = harness()
  const missing = verb ? await verb.lspInstallCli('marksman', { yes: true }, noTool.io) : -1
  check('a remedy whose tool is not on PATH is refused naming the tool, nothing run', missing === 2 && noTool.ran.length === 0 && noTool.err[0] === 'The install remedy for Marksman (Markdown) needs brew, which is not on PATH: brew install marksman', text(noTool.err))
  const words = harness()
  const sourcekit = verb ? await verb.lspInstallCli('sourcekit-lsp', { yes: true }, words.io) : -1
  const sourcekitHere = catalogue.probeCatalogueEntry(catalogue.SERVER_CATALOGUE.find(entry => entry.id === 'sourcekit-lsp')!, PROJ).binaryPath
  check(sourcekitHere ? 'sourcekit-lsp is on this box: reported installed, nothing run' : 'a remedy that is words, not a command, is shown and nothing is run', words.ran.length === 0 && (sourcekitHere ? sourcekit === 0 && words.out[0]?.startsWith('SourceKit-LSP is already installed: ') === true : sourcekit === 2 && words.err[0] === 'SourceKit-LSP has no install command to run: ships with Xcode/Swift toolchains (xcrun sourcekit-lsp)'), `${text(words.out)}\n${text(words.err)}`)
  if (verb) check('the words remedy yields no command', verb.installCommandOf('ships with Xcode/Swift toolchains (xcrun sourcekit-lsp)').kind === 'words')
  if (verb) {
    check('the install command of a remedy with an alternative is its primary command', JSON.stringify(verb.installCommandOf('rustup component add rust-analyzer (or brew install rust-analyzer)')) === JSON.stringify({ kind: 'command', argv: ['rustup', 'component', 'add', 'rust-analyzer'], tool: 'rustup' }))
    check('a one-word remedy is words', verb.installCommandOf('xcode').kind === 'words')
  }
}

section('§4 the win32 scene: an npm delivered as npm.cmd beside the extensionless npm script (the Windows box\'s shape) is resolved through PATHEXT and started through cmd.exe, never spawned by its bare word')
{
  usePath(scratchPath())
  const WINBIN = join(HOME, 'Program Files', 'nodejs')
  mkdirSync(WINBIN, { recursive: true })
  writeFileSync(join(WINBIN, 'npm'), '#!/bin/sh\nexec node "$(dirname "$0")/node_modules/npm/bin/npm-cli.js" "$@"\n')
  writeFileSync(join(WINBIN, 'npm.cmd'), '@ECHO OFF\r\nnode "%~dp0\\node_modules\\npm\\bin\\npm-cli.js" %*\r\n')
  writeFileSync(join(WINBIN, 'npm.ps1'), '& "$PSScriptRoot/node.exe" "$PSScriptRoot/node_modules/npm/bin/npm-cli.js" $args\n')
  const win32 = { platform: 'win32', path: WINBIN, comSpec: 'C:\\Windows\\System32\\cmd.exe' }
  const planner = await import('../../src/utils/spawnPlan.ts').catch(() => null)
  check('the spawn plan module exists', planner !== null)
  const plan = planner ? planner.spawnPlanOf(['npm', 'i', '-g', 'dockerfile-language-server-nodejs'], win32) : null
  check('the plan resolves npm to npm.cmd (PATHEXT), never the extensionless script', plan !== null && 'file' in plan && plan.file === win32.comSpec, JSON.stringify(plan))
  check('a .cmd rides cmd.exe /d /s /c with the whole line quoted once and every word carried verbatim', plan !== null && 'file' in plan && JSON.stringify(plan.args) === JSON.stringify(['/d', '/s', '/c', `""${join(WINBIN, 'npm.cmd')}" i -g dockerfile-language-server-nodejs"`]) && plan.windowsVerbatimArguments === true, JSON.stringify(plan))
  const docker = harness({ onRun: () => { fakeBinary('docker-langserver') } })
  const code = verb ? await verb.lspInstallCli('docker-langserver', { yes: true, world: win32 } as never, docker.io) : -1
  check('the door installs the npm server on the win32 world: the remedy shown, the plan run once, the binary reported', code === 0 && docker.out[0] === 'Install Dockerfile LS (dockerfile) by running:' && docker.out[1] === '  npm i -g dockerfile-language-server-nodejs' && docker.plans.length === 1 && docker.plans[0]!.file === win32.comSpec && docker.out[2]?.startsWith('Installed Dockerfile LS: ') === true, `${code} ${text(docker.out)}\n${text(docker.err)}`)
  rmSync(join(BIN, 'docker-langserver'), { force: true })
  writeFileSync(join(WINBIN, 'go.exe'), '')
  const goPlan = planner ? planner.spawnPlanOf(['go', 'install', 'golang.org/x/tools/gopls@latest'], win32) : null
  check('a .exe tool is spawned directly by its resolved path, with its own argv and no cmd.exe', goPlan !== null && 'file' in goPlan && goPlan.file === join(WINBIN, 'go.exe') && JSON.stringify(goPlan.args) === JSON.stringify(['install', 'golang.org/x/tools/gopls@latest']) && goPlan.windowsVerbatimArguments === false, JSON.stringify(goPlan))
  const spaced = planner ? planner.spawnPlanOf(['npm', 'i', '-g', '@vue/language-server'], win32) : null
  check('a path with a space is quoted inside the cmd.exe line; a scoped package name passes unquoted', spaced !== null && 'file' in spaced && spaced.args[3] === `""${join(WINBIN, 'npm.cmd')}" i -g @vue/language-server"`, JSON.stringify(spaced))
  rmSync(join(WINBIN, 'npm.cmd'))
  const bareOnly = planner ? planner.spawnPlanOf(['npm', 'i', '-g', 'x'], win32) : null
  check('with only the extensionless npm present the walk answers that file and no cmd.exe ride is invented', bareOnly !== null && 'file' in bareOnly && bareOnly.file === join(WINBIN, 'npm') && bareOnly.windowsVerbatimArguments === false, JSON.stringify(bareOnly))
  writeFileSync(join(WINBIN, 'npm.cmd'), '')
  const posix = planner ? planner.spawnPlanOf(['npm', 'i', '-g', 'x'], { platform: 'darwin', path: WINBIN }) : null
  check('off win32 a .cmd is never a spelling: the same PATH answers not-on-PATH', posix !== null && 'refused' in posix && posix.missing === 'npm', JSON.stringify(posix))
  console.log('refusals')
  for (const word of ['50%off', 'say "hi"', 'two\nlines', 'bang!']) {
    const unsafe = planner ? planner.spawnPlanOf(['npm', 'i', word], win32) : null
    check(`a word cmd.exe would rewrite (${JSON.stringify(word)}) refuses the batch road, nothing spawned`, unsafe !== null && 'refused' in unsafe && unsafe.missing === undefined && unsafe.refused.includes('cmd.exe would rewrite'), JSON.stringify(unsafe))
  }
  const noTool = planner ? planner.spawnPlanOf(['', 'x'], win32) : null
  check('an empty program word is refused', noTool !== null && 'refused' in noTool, JSON.stringify(noTool))
  const absent = planner ? planner.spawnPlanOf(['cargo', 'install', 'x'], win32) : null
  check('a tool with no spawnable spelling on the win32 PATH is reported missing (the door prints its needs-<tool> line)', absent !== null && 'refused' in absent && absent.missing === 'cargo', JSON.stringify(absent))
  const absentDoor = harness()
  const absentCode = verb ? await verb.lspInstallCli('zls', { yes: true, world: win32 } as never, absentDoor.io) : -1
  check('the door on the win32 world refuses a remedy whose tool is absent, naming the tool, nothing run', absentCode === 2 && absentDoor.ran.length === 0 && absentDoor.err[0]?.startsWith('The install remedy for zls (Zig) needs ') === true, text(absentDoor.err))
  const srcVerb = source('src/cli/lspVerb.ts')
  check('the door spawns the plan (file + args + the verbatim flag), never argv[0] by its bare word and never shell:true', /spawn\(plan\.file, plan\.args, \{[^}]*windowsVerbatimArguments: plan\.windowsVerbatimArguments/.test(srcVerb) && !/shell: true/.test(srcVerb) && !/spawn\(argv\[0\]/.test(srcVerb))
}

section('§5 never an automatic install: nothing under the language service imports the verb, and the verb lives in the CLI alone')
{
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => (entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]))
  const importers = [...walk(join(ROOT, 'src', 'services', 'lsp')), ...walk(join(ROOT, 'src', 'tools', 'LSPTool'))].filter(file => /\.(ts|tsx)$/.test(file) && /cli\/lspVerb/.test(readFileSync(file, 'utf8')))
  check('no language-service or LSP-tool file imports the install verb', importers.length === 0, importers.join(','))
  const main = source('src/main.tsx')
  check('main.tsx wires lsp list and lsp install <server> with --yes, through the verb module', /command\('lsp'\)/.test(main) && /command\('list'\)/.test(main) && /command\('install <server>'\)/.test(main) && /option\('--yes'/.test(main) && /cli\/lspVerb\.js/.test(main))
  check('the catalogue file is read through its exports and not edited for the verb', /export function probeCatalogueEntry\(/.test(source('src/services/lsp/serverCatalogue.ts')) && /export const SERVER_CATALOGUE/.test(source('src/services/lsp/serverCatalogue.ts')) && !/lspVerb|lspInstall/.test(source('src/services/lsp/serverCatalogue.ts')))
  check('the README names both verbs', /`mercury lsp list`/.test(source('README.md')) && /`mercury lsp install <server>`/.test(source('README.md')))
  for (const file of ['assets/completions/_mercury', 'assets/completions/mercury.bash', 'assets/completions/mercury.fish']) {
    check(`${file} completes lsp install`, /lsp/.test(source(file)) && /install/.test(source(file)))
  }
}

usePath(systemPath)
rmSync(HOME, { recursive: true, force: true })
rmSync(PROJ, { recursive: true, force: true })
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.log(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')
