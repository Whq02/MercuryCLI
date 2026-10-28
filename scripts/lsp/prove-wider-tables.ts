import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'wider-tables-'))
const emptyBin = join(scratch, 'empty-bin')
const shimBin = join(scratch, 'shim-bin')
mkdirSync(emptyBin)
mkdirSync(shimBin)
const originalPath = process.env.PATH
process.env.PATH = emptyBin
process.env.MERCURY_DAP = '1'

const { SERVER_CATALOGUE, probeCatalogueEntry } = await import('../../src/services/lsp/serverCatalogue.ts')
const dap = await import('../../src/services/dap/dapClient.ts')
const { GRAMMAR_REGISTRY } = await import('../../src/services/structure/grammarRegistry.ts')

let failures = 0
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ok  ${name}`)
  else {
    failures++
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
function section(title: string): void {
  console.log(`\n${title}`)
}
const byId = new Map(SERVER_CATALOGUE.map(entry => [entry.id, entry]))

section('a language-server row for each of the thirteen languages')
const expected: Array<[language: string, id: string, binary: string, marker: string, extension: string]> = [
  ['powershell', 'powershell-editor-services', 'pwsh', '*.ps1', '.ps1'],
  ['haskell', 'haskell-language-server', 'haskell-language-server-wrapper', 'stack.yaml', '.hs'],
  ['ocaml', 'ocamllsp', 'ocamllsp', 'dune-project', '.ml'],
  ['scala', 'metals', 'metals', 'build.sbt', '.scala'],
  ['nix', 'nil', 'nil', 'flake.nix', '.nix'],
  ['dart', 'dart', 'dart', 'pubspec.yaml', '.dart'],
  ['gleam', 'gleam', 'gleam', 'gleam.toml', '.gleam'],
  ['prisma', 'prisma-language-server', 'prisma-language-server', 'schema.prisma', '.prisma'],
  ['clojure', 'clojure-lsp', 'clojure-lsp', 'deps.edn', '.clj'],
  ['julia', 'julia-language-server', 'julia', 'Project.toml', '.jl'],
  ['kotlin', 'kotlin-lsp', 'kotlin-lsp', 'build.gradle.kts', '.kt'],
  ['php', 'phpactor', 'phpactor', 'composer.json', '.php'],
  ['elixir', 'expert', 'expert', 'mix.exs', '.ex'],
]
for (const [language, id, binary, marker, extension] of expected) {
  const row = byId.get(id)
  check(
    `${language}: row ${id} probes ${binary}, roots on ${marker}, claims ${extension}, carries a remedy`,
    row !== undefined && row.languages.includes(language) && row.binaries.includes(binary) && row.rootMarkers.includes(marker) && extension in row.extensionToLanguage && row.remedy.length > 0,
    row === undefined ? 'no row' : JSON.stringify({ binaries: row.binaries, rootMarkers: row.rootMarkers, extensions: Object.keys(row.extensionToLanguage) }),
  )
}
check('the earlier kotlin, php and elixir rows still stand beside the new ones', byId.has('kotlin-language-server') && byId.has('intelephense') && byId.has('elixir-ls'))
check('ids are unique', new Set(SERVER_CATALOGUE.map(entry => entry.id)).size === SERVER_CATALOGUE.length)
check('every new row names at least one root marker (none is offered on a binary alone)', expected.every(([, id]) => (byId.get(id)?.rootMarkers.length ?? 0) > 0))
check('the two rows hosted by a language runtime spawn that runtime with an argument vector, never a shell', ['julia-language-server', 'powershell-editor-services'].every(id => (byId.get(id)?.args ?? []).length > 0) && SERVER_CATALOGUE.every(row => !['sh', 'bash', 'zsh', 'cmd', 'cmd.exe'].some(shell => row.binaries.includes(shell))))
const remedyIsClean = (remedy: string): boolean => {
  const primary = remedy.split(' (or ')[0]!.trim()
  const argv = primary.split(/\s+/).filter(Boolean)
  const tool = argv[0] ?? ''
  if (argv.length < 2 || !/^[a-z][a-z0-9.-]*$/i.test(tool) || /^(ships|download|see|use)$/i.test(tool)) return true
  return tool.toLowerCase() !== 'install' && !argv.some(arg => /['"();]/.test(arg))
}
const badRemedies = SERVER_CATALOGUE.flatMap(row => [[row.id, row.remedy], ...(row.remedyWin32 !== undefined ? [[`${row.id} (win32)`, row.remedyWin32]] : [])]).filter(([, remedy]) => !remedyIsClean(remedy!)).map(([id, remedy]) => `${id}: ${remedy}`)
check('every catalogue remedy, on every platform, is either prose (ships/download/see/use) or a clean unquoted argv before (or ...), never starting with install or carrying shell quotes/parentheses', badRemedies.length === 0, badRemedies.join(' | '))
const brewOnWindows = SERVER_CATALOGUE.filter(row => /(^|[\s(])brew\s/.test(row.remedyWin32 ?? row.remedy)).map(row => row.id)
check('no row sends a Windows user to brew: every brew remedy carries a Windows twin the vendor documents (a package manager command or the download road)', brewOnWindows.length === 0, brewOnWindows.join(', '))
check('a Windows twin exists only where the roads differ; the Mac remedy is the default everywhere else', SERVER_CATALOGUE.every(row => row.remedyWin32 === undefined || row.remedyWin32 !== row.remedy))

section('refusals: a table row never installs anything')
const catalogueSource = readFileSync(join(ROOT, 'src/services/lsp/serverCatalogue.ts'), 'utf8')
check('the catalogue imports no process spawner', !catalogueSource.includes('child_process') && !catalogueSource.includes('Bun.spawn'))
const listing: string[] = []
for (const [, id] of expected) {
  const row = byId.get(id)!
  const probe = probeCatalogueEntry(row, scratch, listing)
  check(`${id}: with no binary on PATH the row is neither detected nor offered`, probe.binaryPath === undefined, JSON.stringify(probe))
}
check('an absent binary leaves PATH untouched and the scratch bin empty (nothing was fetched)', readdirSync(emptyBin).length === 0 && readdirSync(shimBin).length === 0)
writeFileSync(join(shimBin, 'gleam'), '#!/bin/sh\nexit 0\n')
chmodSync(join(shimBin, 'gleam'), 0o755)
process.env.PATH = shimBin
const gleam = byId.get('gleam')!
const detectedOnly = probeCatalogueEntry(gleam, scratch, [])
check('a binary without its root marker is detected, not offered', detectedOnly.binaryPath === join(shimBin, 'gleam') && detectedOnly.rootMatched === false, JSON.stringify(detectedOnly))
const offered = probeCatalogueEntry(gleam, scratch, ['gleam.toml', 'src'])
check('the binary beside gleam.toml is offered', offered.binaryPath === join(shimBin, 'gleam') && offered.rootMatched === true, JSON.stringify(offered))
const powershell = byId.get('powershell-editor-services')!
check('a PowerShell project is one with a .ps1, .psm1 or .psd1 in the folder', probeCatalogueEntry(powershell, scratch, ['Deploy.ps1']).rootMatched && !probeCatalogueEntry(powershell, scratch, ['README.md']).rootMatched)
process.env.PATH = emptyBin

section('a debug-adapter row where one exists in the wild: dart, kotlin and the elixir-ls adapter')
const dormant = dap.dormantBuiltinAdapterHints('live')
for (const key of ['dart', 'kotlin', 'elixir']) {
  check(`${key}: absent on this PATH, the adapter is dormant with its install named`, !dap.knownAdapterKeys().includes(key) && dormant.some(row => row.key === key && row.hint.length > 0), JSON.stringify(dormant.map(row => row.key)))
}
for (const [shim, key, extension] of [['dart', 'dart', '.dart'], ['kotlin-debug-adapter', 'kotlin', '.kt'], ['elixir-ls-debugger', 'elixir', '.ex']] as const) {
  writeFileSync(join(shimBin, shim), '#!/bin/sh\nexit 0\n')
  chmodSync(join(shimBin, shim), 0o755)
  process.env.PATH = shimBin
  const spec = dap.resolveAdapter(key)
  check(`${key}: with ${shim} on PATH the row exists, speaks stdio and owns ${extension}`, spec !== null && spec.command === shim && (spec.connect ?? 'stdio') === 'stdio' && (spec.fileTypes ?? []).includes(extension) && dap.adapterKeyForExtension(extension) === key, JSON.stringify(spec))
  check(`${key}: the row is no longer dormant`, !dap.dormantBuiltinAdapterHints('live').some(row => row.key === key))
  rmSync(join(shimBin, shim))
  process.env.PATH = emptyBin
}
check('dart launches the SDK\'s own adapter verb', (() => {
  writeFileSync(join(shimBin, 'dart'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(shimBin, 'dart'), 0o755)
  process.env.PATH = shimBin
  const spec = dap.resolveAdapter('dart')
  rmSync(join(shimBin, 'dart'))
  process.env.PATH = emptyBin
  return spec?.args.join(' ') === 'debug_adapter'
})())
check('PHP and Bash remain dormant without their dependencies', dap.resolveAdapter('php') === null && dap.resolveAdapter('bash') === null && ['php', 'bash'].every(key => dormant.some(row => row.key === key)))
check('an unknown adapter key still resolves to nothing', dap.resolveAdapter('not-an-adapter') === null)
const prompt = readFileSync(join(ROOT, 'src/tools/DebugTool/prompt.ts'), 'utf8')
check('the Debug tool names the adapters and their extensions', prompt.includes('"dart" (dart debug_adapter, when the Dart SDK is on PATH)') && prompt.includes('"kotlin" (kotlin-debug-adapter, when on PATH)') && prompt.includes('"elixir" (the elixir-ls debug adapter, when on PATH)') && prompt.includes('.dart → flutter when the nearest pubspec.yaml has a Flutter dependency, otherwise dart; .kt → kotlin; .ex/.exs → elixir;') && prompt.includes('"flutter" (flutter debug-adapter, when the Flutter SDK is on PATH)') && prompt.includes('"codelldb" (CodeLLDB on PATH or downloaded once with approval; preferred for Cargo projects when present)') && prompt.includes('"php" (PHP Debug downloaded once with approval; PHP with Xdebug required)') && prompt.includes('"bash" (vscode-bash-debug with bashdb and compatible Bash; no automatic download)') && prompt.includes('.php → php; .sh/.bash → bash;'))
const readiness = readFileSync(join(ROOT, 'src/utils/readiness.ts'), 'utf8')
check('/health carries a lane row for each, with the install when absent', ['lane:dap:dart', 'lane:dap:kotlin', 'lane:dap:elixir'].every(id => readiness.includes(`id: '${id}'`)))

section('a grammar row only for a grammar the build already carries')
const registryWasms = new Set(GRAMMAR_REGISTRY.map(entry => entry.wasm))
const lock = JSON.parse(readFileSync(join(ROOT, 'vendor/grammars.lock.json'), 'utf8')) as { grammars?: Array<{ wasm: string }>; files?: Array<{ wasm: string }> }
const lockWasms = (lock.grammars ?? lock.files ?? []).map(entry => entry.wasm)
check('every cherry-picked grammar wasm has a registry row', lockWasms.length > 0 && lockWasms.every(wasm => registryWasms.has(wasm)), lockWasms.filter(wasm => !registryWasms.has(wasm)).join(', '))
let packWasms: string[] = []
try {
  packWasms = readdirSync(join(ROOT, 'node_modules/@vscode/tree-sitter-wasm/wasm')).filter(name => /^tree-sitter-.+\.wasm$/.test(name))
} catch {
  packWasms = []
}
check('every grammar wasm of the editor pack has a registry row (nothing the build carries is unmapped)', packWasms.length > 0 && packWasms.every(wasm => registryWasms.has(wasm)), packWasms.filter(wasm => !registryWasms.has(wasm)).join(', '))
check('the registry names no wasm the build does not carry', [...registryWasms].every(wasm => lockWasms.includes(wasm) || packWasms.includes(wasm)), [...registryWasms].filter(wasm => !lockWasms.includes(wasm) && !packWasms.includes(wasm)).join(', '))

process.env.PATH = originalPath
rmSync(scratch, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-wider-tables: RED (${failures})`)
  process.exit(1)
}
console.log('\nprove-wider-tables: GREEN')
