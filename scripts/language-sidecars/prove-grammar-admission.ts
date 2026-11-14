#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'grammar-admission-')))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
delete process.env.MERCURY_HOME
process.env.MERCURY_BARE = '1'
delete process.env.NODE_ENV
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))

let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.length > 600 ? `${detail.slice(0, 600)}…` : detail}` : ''}`)
}
const section = (title: string): void => console.log(`\n── ${title} ──`)

interface Admission {
  routes: string[]
  aliases: string[]
  pieceSkip?: string[]
  refuses?: string[]
  searches: Array<{ pattern: string; count: number; first?: Record<string, string> }>
  rewrite: { pattern: string; rewrite: string; expect: string[]; gone?: string[] }
}

const FIRST_TWENTY_THREE = ['python', 'go', 'rust', 'javascript', 'typescript', 'tsx', 'bash', 'c-sharp', 'cpp', 'css', 'java', 'php', 'ruby', 'powershell', 'ini', 'regex', 'c', 'html', 'json', 'toml', 'kotlin', 'swift', 'vue']

const ADMITTED: Record<string, Admission> = {
  yaml: {
    routes: ['sample.yaml', 'sample.yml', 'SAMPLE.YAML'],
    aliases: ['yml'],
    searches: [
      { pattern: 'image: $IMG', count: 1, first: { '$IMG': 'registry.example.com/billing:1.4.2' } },
      { pattern: 'kind: $K', count: 2, first: { '$K': 'Deployment' } },
      { pattern: '[$$$ARGS]', count: 5 },
    ],
    rewrite: { pattern: 'replicas: $N', rewrite: 'replicas: 5', expect: ['replicas: 5'], gone: ['replicas: 3'] },
  },
  markdown: {
    routes: ['sample.md', 'sample.markdown', 'sample.mdx', 'SAMPLE.MD'],
    aliases: ['md', 'mdx'],
    searches: [{ pattern: '## $TITLE', count: 2, first: { '$TITLE': 'Install' } }],
    rewrite: { pattern: '## $TITLE', rewrite: '### $TITLE', expect: ['### Install', '### Options'], gone: ['\n## Install'] },
  },
  sql: {
    routes: ['sample.sql', 'SAMPLE.SQL'],
    aliases: [],
    pieceSkip: ['transaction'],
    searches: [
      { pattern: 'COUNT($X)', count: 2, first: { '$X': 'o.id' } },
      { pattern: 'DELETE FROM orders WHERE $COND', count: 1 },
    ],
    rewrite: { pattern: 'COALESCE($A, $B)', rewrite: 'IFNULL($A, $B)', expect: ['IFNULL(SUM(o.total), 0)'], gone: ['COALESCE'] },
  },
  dockerfile: {
    routes: ['sample.dockerfile', 'SAMPLE.DOCKERFILE', 'Dockerfile', 'dockerfile', 'Containerfile', 'Dockerfile.dev'],
    aliases: ['docker', 'containerfile'],
    searches: [
      { pattern: 'FROM $IMAGE AS $NAME', count: 1, first: { '$NAME': 'build' } },
      { pattern: 'WORKDIR $DIR', count: 2, first: { '$DIR': '/app' } },
    ],
    rewrite: { pattern: 'WORKDIR /app', rewrite: 'WORKDIR /srv/app', expect: ['WORKDIR /srv/app'], gone: ['WORKDIR /app'] },
  },
  lua: {
    routes: ['sample.lua', 'SAMPLE.LUA'],
    aliases: [],
    searches: [
      { pattern: 'setmetatable($T, $MT)', count: 1, first: { '$MT': 'Inventory' } },
      { pattern: 'inv:add($$$ARGS)', count: 2, first: { '$$$ARGS': '"nail", 40' } },
    ],
    rewrite: { pattern: 'inv:add($$$ARGS)', rewrite: 'inv:insert($$$ARGS)', expect: ['inv:insert("nail", 40)', "inv:insert('rope')"], gone: ['inv:add'] },
  },
  make: {
    routes: ['sample.mk', 'sample.mak', 'SAMPLE.MK', 'Makefile', 'GNUmakefile'],
    aliases: ['makefile', 'gnumake', 'mk', 'mak'],
    searches: [
      { pattern: 'CFLAGS += $FLAGS', count: 4, first: { '$FLAGS': '-Wall -Wextra -O2' } },
      { pattern: 'include $F', count: 2, first: { '$F': 'config.mk' } },
      { pattern: 'mkdir -p $@', count: 1 },
    ],
    rewrite: { pattern: 'CC ?= $V', rewrite: 'CC ?= clang', expect: ['CC ?= clang\nCFLAGS'], gone: ['CC ?= cc'] },
  },
  cmake: {
    routes: ['sample.cmake', 'SAMPLE.CMAKE', 'CMakeLists.txt'],
    aliases: [],
    searches: [
      { pattern: 'target_link_libraries($T PRIVATE $$$LIBS)', count: 2, first: { '$T': 'tidecore', '$$$LIBS': 'ZLIB::ZLIB' } },
      { pattern: 'message(STATUS $MSG)', count: 2 },
    ],
    rewrite: { pattern: 'set(CMAKE_CXX_STANDARD $V)', rewrite: 'set(CMAKE_CXX_STANDARD 23)', expect: ['set(CMAKE_CXX_STANDARD 23)\nset(CMAKE_CXX_STANDARD_REQUIRED ON)'], gone: ['set(CMAKE_CXX_STANDARD 20)'] },
  },
  xml: {
    routes: ['sample.xml', 'sample.xsl', 'sample.xslt', 'sample.svg', 'sample.plist', 'SAMPLE.XML'],
    aliases: ['xsl', 'xslt', 'svg', 'plist'],
    pieceSkip: ['prolog'],
    refuses: ['<item $$$ATTRS>$T</item>'],
    searches: [
      { pattern: '<version>$V</version>', count: 3, first: { '$V': '1.4.2' } },
      { pattern: '<artifactId>$ID</artifactId>', count: 4 },
      { pattern: 'order=$V', count: 1, first: { '$V': '"1"' } },
    ],
    rewrite: { pattern: '<scope>test</scope>', rewrite: '<scope>provided</scope>', expect: ['<scope>provided</scope>'], gone: ['<scope>test</scope>'] },
  },
  hcl: {
    routes: ['sample.hcl', 'sample.tf', 'sample.tfvars', 'SAMPLE.HCL'],
    aliases: ['tf', 'tfvars', 'terraform'],
    refuses: ['resource "aws_instance" "web" { $$$BODY }'],
    searches: [
      { pattern: 'instance_type = $T', count: 1, first: { '$T': '"t3.small"' } },
      { pattern: 'merge($$$ARGS)', count: 2 },
    ],
    rewrite: { pattern: 'instance_type = $T', rewrite: 'instance_type = "t3.medium"', expect: ['instance_type = "t3.medium"'], gone: ['t3.small'] },
  },
  graphql: {
    routes: ['sample.graphql', 'sample.gql', 'SAMPLE.GRAPHQL'],
    aliases: ['gql'],
    pieceSkip: ['comment'],
    refuses: ['type Query { $$$FIELDS }'],
    searches: [
      { pattern: 'id: ID!', count: 2 },
      { pattern: 'enum $NAME {\n  $$$VALUES\n}', count: 2, first: { '$NAME': 'TideKind' } },
      { pattern: 'harbour(id: $ID) { $$$SEL }', count: 1, first: { '$ID': '$id' } },
    ],
    rewrite: { pattern: 'kind: TideKind!', rewrite: 'kind: TideKind', expect: ['kind: TideKind\n}'], gone: ['kind: TideKind!'] },
  },
  protobuf: {
    routes: ['sample.proto', 'SAMPLE.PROTO'],
    aliases: ['proto'],
    refuses: ['message Ping { $$$FIELDS }', 'string id = $N;'],
    searches: [
      { pattern: 'string id = 1;', count: 2 },
      { pattern: 'rpc $NAME($REQ) returns ($RES);', count: 3, first: { '$NAME': 'GetHarbour', '$REQ': 'GetHarbourRequest' } },
      { pattern: 'import $PATH;', count: 2 },
    ],
    rewrite: { pattern: 'string id = 1;', rewrite: 'string uid = 1;', expect: ['string uid = 1;'], gone: ['string id = 1;'] },
  },
  dart: {
    routes: ['sample.dart', 'SAMPLE.DART'],
    aliases: [],
    pieceSkip: ['function_signature', 'function_body'],
    refuses: ['void main() { $$$BODY }', 'class $N { $$$M }'],
    searches: [
      { pattern: 'print($X)', count: 3 },
      { pattern: 'harbour.add($$$ARGS)', count: 1 },
      { pattern: 'return $X;', count: 3 },
    ],
    rewrite: { pattern: 'print($X)', rewrite: 'log.info($X)', expect: ["log.info(jsonEncode({'loaded': harbour.name}));", "log.info('bad table: $error\\n$stack');"], gone: ['print('] },
  },
  scala: {
    routes: ['sample.scala', 'sample.sc', 'sample.sbt', 'SAMPLE.SCALA'],
    aliases: ['sc', 'sbt'],
    refuses: ['def $N($$$P): $T = $B'],
    searches: [
      { pattern: 'Left($X)', count: 2 },
      { pattern: 'harbour.add($X)', count: 1, first: { '$X': 'tide' } },
    ],
    rewrite: { pattern: 'Left($X)', rewrite: 'Failure($X)', expect: ['Failure("expected three fields")', 'Failure(s"bad row: ${err.getMessage}")'], gone: ['Left('] },
  },
  elixir: {
    routes: ['sample.ex', 'sample.exs', 'SAMPLE.EX'],
    aliases: ['ex', 'exs'],
    searches: [
      { pattern: 'Logger.info($MSG)', count: 1 },
      { pattern: '{:ok, $X}', count: 2 },
      { pattern: 'length($X)', count: 2 },
    ],
    rewrite: { pattern: 'Logger.info($MSG)', rewrite: 'Logger.warning($MSG)', expect: ['Logger.warning("adding #{inspect(tide)}")'], gone: ['Logger.info'] },
  },
  zig: {
    routes: ['sample.zig', 'SAMPLE.ZIG'],
    aliases: [],
    refuses: ['pub fn main() void { $$$BODY }'],
    searches: [
      { pattern: 'allocator.free($X)', count: 2, first: { '$X': 'out' } },
      { pattern: 'try harbour.add($X)', count: 2 },
      { pattern: '@intCast($X)', count: 1 },
    ],
    rewrite: { pattern: 'allocator.free($X)', rewrite: 'allocator.destroy($X)', expect: ['errdefer allocator.destroy(out);', 'defer allocator.destroy(values);'], gone: ['allocator.free'] },
  },
  haskell: {
    routes: ['sample.hs', 'SAMPLE.HS'],
    aliases: ['hs'],
    searches: [
      { pattern: 'fromMaybe $D $X', count: 1 },
      { pattern: 'Just $X', count: 1 },
      { pattern: 'label :: TideKind -> String', count: 1 },
    ],
    rewrite: { pattern: 'sum $X', rewrite: 'foldr (+) 0 $X', expect: ['total = foldr (+) 0 (map tideHeight tides)'], gone: ['total = sum'] },
  },
  ocaml: {
    routes: ['sample.ml', 'SAMPLE.ML'],
    aliases: ['ml'],
    refuses: ['open $M'],
    searches: [
      { pattern: 'List.length $X', count: 2 },
      { pattern: 'string_of_int $N', count: 1, first: { '$N': 'n' } },
      { pattern: 'if $C then $A else $B', count: 2 },
    ],
    rewrite: { pattern: 'prerr_endline $E', rewrite: 'Printf.eprintf "%s\\n" $E', expect: ['Error e -> Printf.eprintf "%s\\n" e'], gone: ['prerr_endline'] },
  },
  svelte: {
    routes: ['sample.svelte', 'SAMPLE.SVELTE'],
    aliases: [],
    refuses: ['count($X)'],
    searches: [
      { pattern: '<p>$$$KIDS</p>', count: 4 },
      { pattern: '<li>empty</li>', count: 1 },
    ],
    rewrite: { pattern: '<li>empty</li>', rewrite: '<li class="none">empty</li>', expect: ['<li class="none">empty</li>'], gone: ['<li>empty</li>'] },
  },
  astro: {
    routes: ['sample.astro', 'SAMPLE.ASTRO'],
    aliases: [],
    refuses: ['make($X)'],
    searches: [
      { pattern: '<h1>$$$KIDS</h1>', count: 1 },
      { pattern: '<slot name="footer" />', count: 1 },
    ],
    rewrite: { pattern: '<p>No tides.</p>', rewrite: '<p class="empty">No tides.</p>', expect: ['<p class="empty">No tides.</p>'], gone: ['<p>No tides.</p>'] },
  },
  nix: {
    routes: ['sample.nix', 'SAMPLE.NIX'],
    aliases: [],
    refuses: ['pkgs.mkShell { $$$ATTRS }'],
    searches: [
      { pattern: 'lib.optionals $C $L', count: 1, first: { '$C': 'isDarwin' } },
      { pattern: 'version = $V;', count: 1, first: { '$V': '"1.4.2"' } },
      { pattern: 'builtins.length $X', count: 1 },
    ],
    rewrite: { pattern: 'version = $V;', rewrite: 'version = "2.0.0";', expect: ['version = "2.0.0";'], gone: ['version = "1.4.2";'] },
  },
}

const THIRD_PARTY_BUILDS = ['sql', 'cmake', 'graphql', 'protobuf', 'dart', 'astro', 'nix']
const NO_COPYRIGHT_LINE = ['hcl', 'elixir']
const HELD = ['markdown']
const NEEDS_FINAL_NEWLINE = ['markdown', 'make']

const CORPUS = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'grammar-corpus.json'), 'utf8')) as Record<string, Record<string, string[]>>
const corpusText = (lang: string, file: string): string => `${CORPUS[lang]![file]!.join('\n')}\n`
const admitted = Object.keys(ADMITTED)

const { GRAMMAR_REGISTRY, GRAMMAR_ENGINE_RUNTIME_FILES } = await import('../../src/services/structure/grammarRegistry.ts')
type Row = (typeof GRAMMAR_REGISTRY)[number]
const rowOf = (name: string): Row | undefined => GRAMMAR_REGISTRY.find((g: Row) => g.name === name)

const vscodeDir = join(ROOT, 'node_modules', '@vscode', 'tree-sitter-wasm', 'wasm')
const packDir = join(ROOT, 'vendor', 'grammars', 'extracted')
const engineDir = join(scratch, 'engine')
mkdirSync(engineDir)
for (const f of GRAMMAR_ENGINE_RUNTIME_FILES) copyFileSync(join(vscodeDir, f), join(engineDir, f))
writeFileSync(join(engineDir, 'package.json'), '{"type":"commonjs"}\n')
{
  const missing: string[] = []
  for (const g of GRAMMAR_REGISTRY) {
    const from = (g.source ?? 'vscode-pack') === 'vscode-pack' ? join(vscodeDir, g.wasm) : join(packDir, g.wasm)
    if (existsSync(from)) copyFileSync(from, join(engineDir, g.wasm))
    else missing.push(g.wasm)
  }
  if (missing.length > 0) {
    console.error(`FAIL: the grammar cache lacks ${missing.join(', ')}`)
    console.error('  remedy: bun install; bun run scripts/vendor/fetch-grammars.ts')
    process.exit(1)
  }
}

section('§1 — an edit\'s parse note and a read\'s outline of an admitted language\'s file load no grammar')
{
  const trapDir = join(scratch, 'trap')
  const marker = join(scratch, 'engine-was-loaded')
  mkdirSync(trapDir)
  writeFileSync(
    join(trapDir, 'tree-sitter.js'),
    `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'loaded\\n')\nmodule.exports = require(${JSON.stringify(join(engineDir, 'tree-sitter.js'))})\n`,
  )
  writeFileSync(join(trapDir, 'package.json'), '{"type":"commonjs"}\n')
  copyFileSync(join(engineDir, 'tree-sitter.wasm'), join(trapDir, 'tree-sitter.wasm'))
  for (const g of GRAMMAR_REGISTRY) copyFileSync(join(engineDir, g.wasm), join(trapDir, g.wasm))
  process.env.MERCURY_TREESITTER_VENDOR_DIR = trapDir
  const { checkIntroducedParseError } = await import('../../src/tools/FileWriteTool/parseCheck.ts')
  const { buildOutlineNumberedWindow } = await import('../../src/tools/FileReadTool/outline.ts')
  const files = join(scratch, 'pattern-only')
  mkdirSync(files)
  const quiet: string[] = []
  const loud: string[] = []
  for (const name of admitted) {
    for (const [file, lines] of Object.entries(CORPUS[name] ?? {})) {
      const text = `${lines.join('\n')}\n`
      const broken = `${text.slice(0, Math.floor(text.length / 2))}\n((( [[[ {{{ "\n`
      await checkIntroducedParseError(join(files, file), text, broken, false)
      const outline = await buildOutlineNumberedWindow(join(files, file), text, 1, lines.length, lines.length, false)
      if (existsSync(marker) || outline !== null) loud.push(`${name}/${file}`)
      else quiet.push(`${name}/${file}`)
    }
  }
  check(`${quiet.length} corpus files of the ${admitted.length} admitted languages: an edit that breaks the file and a read of it never reached the grammar engine, and the read drew no outline`, loud.length === 0 && quiet.length >= admitted.length, loud.join(', '))
  const note = await checkIntroducedParseError(join(files, 'control.py'), 'x = 1\n', 'def (:\n', false)
  check('control: the same edit of a Python file is read by its grammar and named (the trap has teeth)', existsSync(marker) && /^Python parse error at line 1: .+\(the edit introduced it\)$/.test(note ?? ''), `${existsSync(marker) ? 'engine loaded' : 'engine NOT loaded'} · ${note}`)
}

const facility = await import('../../src/services/structure/grammarFacility.ts')
const { languageForFile, patternLanguageForFile, loadGrammarEngine, parsePolyglot } = facility
const { resolveAstLanguage, resolveAstScope, searchAstPattern, planAstRewrite, isAstRefusal, astLanguageNames } = await import('../../src/utils/astPatterns.ts')
const { compileFor } = await import('../../src/services/structure/polyglotQuery.ts')
const { encodePattern } = await import('../../src/services/structure/pattern.ts')

section('§2 — a search for code beside files of the admitted languages loads none of their grammars unless one of those files can hold the pattern')
{
  const poisoned = join(scratch, 'poisoned')
  mkdirSync(poisoned)
  for (const f of [...GRAMMAR_ENGINE_RUNTIME_FILES, 'package.json']) copyFileSync(join(engineDir, f), join(poisoned, f))
  for (const g of GRAMMAR_REGISTRY) {
    if (g.patternOnly) writeFileSync(join(poisoned, g.wasm), 'these bytes are no grammar')
    else copyFileSync(join(engineDir, g.wasm), join(poisoned, g.wasm))
  }
  process.env.MERCURY_TREESITTER_VENDOR_DIR = poisoned
  facility._resetGrammarEngineForTesting()
  facility._resetFragileProbeForTesting()
  const beside = join(scratch, 'beside')
  mkdirSync(beside)
  writeFileSync(join(beside, 'app.ts'), 'export const height = tideHeightOf(1)\n')
  let files = 0
  for (const name of admitted) {
    for (const file of Object.keys(CORPUS[name]!)) {
      writeFileSync(join(beside, file), corpusText(name, file))
      files++
    }
  }
  const scope = resolveAstScope({ cwd: beside })
  const quiet = isAstRefusal(scope) ? scope : await searchAstPattern(scope, { pattern: 'tideHeightOf($X)' })
  const counted = isAstRefusal(quiet) ? '' : quiet.languagesSearched.map(([l, n]) => `${l}=${n}`).sort().join(',')
  const expected = [...admitted.map(n => `${n}=${Object.keys(CORPUS[n]!).length}`), 'typescript=1'].sort().join(',')
  check(`TypeScript beside ${files} files of the ${admitted.length} admitted languages, every admitted grammar replaced by bytes that fail the audition: the call is found, nothing is refused, and each of those files is counted as unable to hold the pattern`, !isAstRefusal(quiet) && quiet.matches.length === 1 && quiet.patternRefusals.length === 0 && quiet.parseFailures.length === 0 && quiet.filesParsed === 1 && counted === expected, isAstRefusal(quiet) ? quiet.refused : `${quiet.matches.length} matches · parsed ${quiet.filesParsed} · ${counted} · ${JSON.stringify(quiet.patternRefusals)}`)
  const first = admitted[0]!
  writeFileSync(join(beside, `named-${ADMITTED[first]!.routes[0]!}`), 'tideHeightOf(x) is named here\n')
  const again = resolveAstScope({ cwd: beside })
  const loud = isAstRefusal(again) ? again : await searchAstPattern(again, { pattern: 'tideHeightOf($X)' })
  check(`control: once a ${first} file names the word its grammar is asked for, and the replaced one is refused by name (the reading has teeth)`, !isAstRefusal(loud) && loud.matches.length === 1 && loud.patternRefusals.some(r => r.lang === first && /quarantined/.test(r.note)), isAstRefusal(loud) ? loud.refused : JSON.stringify(loud.patternRefusals))
  process.env.MERCURY_TREESITTER_VENDOR_DIR = engineDir
  facility._resetGrammarEngineForTesting()
  facility._resetFragileProbeForTesting()
}

section(`§3 — the rows: the twenty-three and the ${admitted.length} admitted, each pinned in the lock`)
{
  const names = GRAMMAR_REGISTRY.map((g: Row) => g.name)
  check(`the registry carries ${FIRST_TWENTY_THREE.length + admitted.length} grammars: the twenty-three first, unchanged in order, then the admitted in theirs`, JSON.stringify(names) === JSON.stringify([...FIRST_TWENTY_THREE, ...admitted]), names.join(','))
  check('none of the twenty-three is pattern-only, and swift alone of them is auditioned', FIRST_TWENTY_THREE.every(n => rowOf(n)?.patternOnly !== true) && FIRST_TWENTY_THREE.filter(n => rowOf(n)?.fragile).join(',') === 'swift')
  check('every admitted row is pattern-only, auditioned on first use and carried by the grammar cache', admitted.every(n => rowOf(n)?.patternOnly === true && rowOf(n)?.fragile !== undefined && rowOf(n)?.source === 'grammar-pack'), admitted.filter(n => !(rowOf(n)?.patternOnly === true && rowOf(n)?.fragile !== undefined && rowOf(n)?.source === 'grammar-pack')).join(','))
  check(`the admitted rows held off the optimising tier are ${HELD.join(', ')}`, admitted.filter(n => rowOf(n)?.baseline === true).join(',') === HELD.join(','), admitted.filter(n => rowOf(n)?.baseline === true).join(','))
  check(`the admitted rows handed their text with a final newline are ${NEEDS_FINAL_NEWLINE.join(', ')}`, admitted.filter(n => rowOf(n)?.finalNewline === true).join(',') === NEEDS_FINAL_NEWLINE.join(','), admitted.filter(n => rowOf(n)?.finalNewline === true).join(','))
  check('the build carries every one of them by name', admitted.every(n => (astLanguageNames() as string[]).includes(n)))
  const lock = JSON.parse(readFileSync(join(ROOT, 'vendor', 'grammars.lock.json'), 'utf8')) as {
    grammars: Array<{ wasm: string; sha256: string; bytes: number; sourceUrl?: string; sourceMember?: string; sourceSha512?: string; upstream: { package?: string; license?: string; repository?: string; commit?: string; copyright?: string; builder?: string } }>
  }
  const PERMISSIVE = new Set(['MIT', 'Apache-2.0', 'CC0-1.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'Unlicense'])
  const unpinned: string[] = []
  const unrecorded: string[] = []
  for (const name of admitted) {
    const row = rowOf(name)
    const entry = lock.grammars.find(g => g.wasm === row?.wasm)
    const cached = row && existsSync(join(packDir, row.wasm)) ? readFileSync(join(packDir, row.wasm)) : null
    if (!entry || !cached || createHash('sha256').update(cached).digest('hex') !== entry.sha256 || cached.byteLength !== entry.bytes) unpinned.push(name)
    const up = entry?.upstream
    const copyrightOk = NO_COPYRIGHT_LINE.includes(name) ? up?.copyright === undefined : (up?.copyright ?? '') !== ''
    if (!up || !PERMISSIVE.has(up.license ?? '') || !/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(up.repository ?? '') || !copyrightOk || !/^[0-9a-f]{40}$/.test(up.commit ?? '')) unrecorded.push(name)
  }
  check('each admitted grammar in the cache is the file its lock entry pins, byte for byte', unpinned.length === 0, unpinned.join(','))
  check(`each lock entry records the upstream repository, the commit, a permissive licence and the copyright line of its licence text${NO_COPYRIGHT_LINE.length > 0 ? ` (${NO_COPYRIGHT_LINE.join(', ')}: a licence text that names no holder)` : ''}`, unrecorded.length === 0, unrecorded.join(','))
  const builders = admitted.filter(n => lock.grammars.find(g => g.wasm === rowOf(n)?.wasm)?.upstream.builder !== undefined)
  check(`the third party's builds among them are named as such, with the builder and the digest of its package: ${THIRD_PARTY_BUILDS.join(', ')}`, builders.join(',') === THIRD_PARTY_BUILDS.join(',') && builders.every(n => {
    const entry = lock.grammars.find(g => g.wasm === rowOf(n)?.wasm)!
    return /^@?[a-z0-9/_-]+@\d+\.\d+\.\d+$/.test(entry.upstream.builder ?? '') && /^[0-9a-f]{128}$/.test(entry.sourceSha512 ?? '') && entry.sourceMember !== undefined
  }), builders.join(','))
}

section('§4 — a file is routed by its name; the edit note and the outline keep to the twenty-three')
{
  const wrong: string[] = []
  for (const name of admitted) {
    for (const file of ADMITTED[name]!.routes) {
      if (patternLanguageForFile(join('some', 'dir', file))?.name !== name) wrong.push(`${file} is not ${name}`)
      if (languageForFile(file) !== null) wrong.push(`${file} reaches the edit note`)
    }
    for (const alias of [name, name.toUpperCase(), ...ADMITTED[name]!.aliases]) {
      if (resolveAstLanguage(alias)?.name !== name) wrong.push(`lang ${alias} is not ${name}`)
    }
  }
  check(`every extension, basename and alias of the ${admitted.length} routes to its language for a pattern and to none for the edit note`, wrong.length === 0, wrong.join('; '))
  const kept = FIRST_TWENTY_THREE.flatMap(n => (rowOf(n)?.extensions ?? []).map((e: string) => [n, e] as const)).filter(([n, e]) => languageForFile(`x${e}`)?.name !== n || patternLanguageForFile(`x${e}`)?.name !== n)
  check('every extension of the twenty-three routes as before, for both', kept.length === 0, kept.map(([n, e]) => `${e}→${n}`).join(','))
  check('.h stays C, .json stays JSON, .toml stays TOML', patternLanguageForFile('a.h')?.name === 'c' && patternLanguageForFile('a.json')?.name === 'json' && patternLanguageForFile('a.toml')?.name === 'toml')
  check('a name no grammar claims is still none', patternLanguageForFile('notes.txt') === null && patternLanguageForFile('LICENSE') === null)
}

const engine = await loadGrammarEngine()
if (engine.state === 'unavailable') {
  console.error(`FAIL: grammar engine unavailable — ${engine.note}`)
  process.exit(1)
}
const errorsOf = async (name: string, text: string): Promise<string[]> => {
  const parsed = await parsePolyglot(engine, rowOf(name)!, text)
  if ('state' in parsed) return [`unavailable: ${parsed.note}`]
  const errors = parsed.parseErrors
  parsed.tree.delete()
  return errors
}

section('§5 — the corpus of each language parses clean: as written, with CRLF line endings, without its final newline, and piece by piece')
for (const name of admitted) {
  const spec = ADMITTED[name]!
  const fails: string[] = []
  let pieces = 0
  for (const file of Object.keys(CORPUS[name] ?? {})) {
    const text = corpusText(name, file)
    for (const [how, variant] of [['as written', text], ['CRLF', text.replace(/\n/g, '\r\n')], ['no final newline', text.replace(/\s+$/, '')]] as const) {
      const errors = await errorsOf(name, variant)
      if (errors.length > 0) fails.push(`${file} ${how}: ${errors[0]}`)
    }
    const parsed = await parsePolyglot(engine, rowOf(name)!, text)
    if ('state' in parsed) continue
    const tops = parsed.tree.rootNode.namedChildren.map(c => ({ type: c.type, text: c.text, row: c.startPosition.row + 1 }))
    parsed.tree.delete()
    for (const piece of tops) {
      if ((spec.pieceSkip ?? []).includes(piece.type)) continue
      pieces++
      const errors = await errorsOf(name, piece.text)
      if (errors.length > 0) fails.push(`${file}:${piece.row} ${piece.type} alone: ${errors[0]}`)
    }
  }
  check(`${name}: ${Object.keys(CORPUS[name] ?? {}).length} corpus file(s) and ${pieces} top-level pieces`, Object.keys(CORPUS[name] ?? {}).length > 0 && pieces > 0 && fails.length === 0, fails.slice(0, 4).join('; '))
}

section('§6 — search and rewrite over the corpus, each file found by its name')
const work = join(scratch, 'corpus')
for (const name of admitted) {
  for (const file of Object.keys(CORPUS[name]!)) {
    mkdirSync(join(work, 'lf', name), { recursive: true })
    mkdirSync(join(work, 'crlf', name), { recursive: true })
    mkdirSync(join(work, 'mixed'), { recursive: true })
    writeFileSync(join(work, 'lf', name, file), corpusText(name, file))
    writeFileSync(join(work, 'crlf', name, file), corpusText(name, file).replace(/\n/g, '\r\n'))
    writeFileSync(join(work, 'mixed', file), corpusText(name, file))
  }
}
writeFileSync(join(work, 'mixed', 'notes.txt'), 'no grammar reads this\n')
writeFileSync(join(work, 'mixed', 'app.ts'), 'export const n = 1\n')
for (const name of admitted) {
  const spec = ADMITTED[name]!
  for (const ending of ['lf', 'crlf'] as const) {
    const fails: string[] = []
    const scope = resolveAstScope({ cwd: join(work, ending, name) })
    if (isAstRefusal(scope)) {
      check(`${name} (${ending}): the scope`, false, scope.refused)
      continue
    }
    if (scope.files.some(f => f.lang.name !== name) || scope.files.length !== Object.keys(CORPUS[name]!).length) fails.push(`scope: ${scope.files.map(f => `${f.rel}=${f.lang.name}`).join(',')}`)
    for (const s of spec.searches) {
      const r = await searchAstPattern(scope, { pattern: s.pattern })
      if (isAstRefusal(r)) {
        fails.push(`${s.pattern}: ${r.refused}`)
        continue
      }
      if (r.patternRefusals.length > 0 || r.parseFailures.length > 0) fails.push(`${s.pattern}: ${[...r.patternRefusals.map(x => x.note), ...r.parseFailures.map(x => x.message)].join('; ')}`)
      if (r.matches.length !== s.count) fails.push(`${s.pattern}: ${r.matches.length} matches, not ${s.count}`)
      const got = Object.fromEntries((r.matches[0]?.captures ?? []).map(c => [c.key, c.text]))
      for (const [key, value] of Object.entries(s.first ?? {})) {
        if (got[key] !== value) fails.push(`${s.pattern}: ${key} is ${JSON.stringify(got[key])}, not ${JSON.stringify(value)}`)
      }
    }
    const plan = await planAstRewrite(scope, { pattern: spec.rewrite.pattern, rewrite: spec.rewrite.rewrite })
    if (isAstRefusal(plan)) fails.push(`rewrite: ${plan.refused}`)
    else {
      const after = plan.files.map(f => f.after).join('\n')
      const read = ending === 'crlf' ? after.replace(/\r\n/g, '\n') : after
      const missing = spec.rewrite.expect.filter(e => !read.includes(e))
      const lingering = (spec.rewrite.gone ?? []).filter(e => read.includes(e))
      if (plan.files.length === 0 || missing.length > 0 || lingering.length > 0) fails.push(`rewrite: ${plan.files.length} files, missing ${JSON.stringify(missing)}, lingering ${JSON.stringify(lingering)}`)
      if (ending === 'crlf' && plan.files.some(f => /(^|[^\r])\n/.test(f.after))) fails.push('rewrite: a bare LF entered a CRLF file')
      if (ending === 'lf' && plan.files.some(f => f.after.includes('\r'))) fails.push('rewrite: a CR entered an LF file')
    }
    check(`${name} (${ending}): ${spec.searches.length} search(es) with their counts and captures, and the rewrite`, fails.length === 0, fails.join('; '))
  }
  if (spec.refuses) {
    const accepted: string[] = []
    for (const pattern of spec.refuses) {
      const compiled = await compileFor(engine, rowOf(name)!, encodePattern(pattern), new Map())
      if ('state' in compiled) continue
      compiled.hold.delete()
      accepted.push(pattern)
    }
    check(`${name}: the shapes the page says it refuses are refused (${spec.refuses.join(' · ')})`, accepted.length === 0, accepted.join(' · '))
  }
}
{
  const mixed = resolveAstScope({ cwd: join(work, 'mixed') })
  const expected = admitted.flatMap(n => Object.keys(CORPUS[n]!).map(f => `${f}=${n}`)).concat('app.ts=typescript').sort()
  check('one directory of every corpus file: each is routed to its own language, the .txt is skipped and counted', !isAstRefusal(mixed) && JSON.stringify(mixed.files.map(f => `${f.rel}=${f.lang.name}`).sort()) === JSON.stringify(expected) && JSON.stringify(mixed.skippedNoGrammar) === JSON.stringify([['.txt', 1]]), isAstRefusal(mixed) ? mixed.refused : `${mixed.files.map(f => `${f.rel}=${f.lang.name}`).sort().join(',')} · ${JSON.stringify(mixed.skippedNoGrammar)}`)
  const first = admitted[0]!
  const pinned = resolveAstScope({ cwd: join(work, 'mixed'), lang: ADMITTED[first]!.aliases[0] ?? first })
  check(`lang given by an alias over that directory keeps the ${first} files alone`, !isAstRefusal(pinned) && pinned.files.length === Object.keys(CORPUS[first]!).length && pinned.files.every(f => f.lang.name === first), isAstRefusal(pinned) ? pinned.refused : pinned.files.map(f => `${f.rel}=${f.lang.name}`).join(','))
  const forced = resolveAstScope({ cwd: join(work, 'mixed'), path: 'notes.txt', lang: first })
  check('lang given for one file overrides its name', !isAstRefusal(forced) && forced.files.length === 1 && forced.files[0]!.lang.name === first, isAstRefusal(forced) ? forced.refused : '')
}
for (const name of NEEDS_FINAL_NEWLINE) {
  const file = Object.keys(CORPUS[name]!)[0]!
  const dir = join(work, 'no-final', name)
  mkdirSync(dir, { recursive: true })
  const text = corpusText(name, file).replace(/\s+$/, '')
  writeFileSync(join(dir, file), text)
  const scope = resolveAstScope({ cwd: dir })
  const spec = ADMITTED[name]!
  const plan = isAstRefusal(scope) ? scope : await planAstRewrite(scope, { pattern: spec.rewrite.pattern, rewrite: spec.rewrite.rewrite })
  check(`${name}: a file without a final newline is searched and rewritten, and is left without one`, !isAstRefusal(plan) && plan.files.length === 1 && spec.rewrite.expect.every(e => plan.files[0]!.after.includes(e)) && !plan.files[0]!.after.endsWith('\n'), isAstRefusal(plan) ? plan.refused : JSON.stringify(plan.files[0]?.after.slice(-60)))
}

function vendoredNode(): string | null {
  const os = process.platform === 'win32' ? 'win' : process.platform
  const dir = join(ROOT, 'vendor', 'node', 'extracted', `${os}-${process.arch}`)
  for (const candidate of [join(dir, 'bin', 'node'), join(dir, 'node.exe')]) {
    if (existsSync(candidate)) return candidate
  }
  return Bun.which('node')
}

section('§7 — under the runtime the product ships: each admitted grammar loads, declares the name its row expects and parses its corpus two hundred times')
{
  const NODE = vendoredNode()
  if (!NODE) {
    console.log('  [SKIP] no node binary (the product runtime)')
  } else {
    writeFileSync(
      join(scratch, 'sustained.cjs'),
      `const path = require('node:path')
const fs = require('node:fs')
const [dir, wasm, ...files] = process.argv.slice(2)
const raw = require(path.join(dir, 'tree-sitter.js'))
const mod = raw && raw.Parser ? raw : raw.default
const log = console.log
console.log = console.warn = console.error = () => {}
;(async () => {
  await mod.Parser.init({ locateFile: f => path.join(dir, f) })
  const parser = new mod.Parser()
  const language = await mod.Language.load(path.join(dir, wasm))
  parser.setLanguage(language)
  const texts = files.map(f => fs.readFileSync(f, 'utf8'))
  let clean = true
  let nodes = 0
  for (let round = 0; round < 200; round++) {
    for (const text of texts) {
      const tree = parser.parse(text)
      if (tree.rootNode.hasError) clean = false
      if (round === 0) nodes += tree.rootNode.descendantCount
      tree.delete()
    }
  }
  log(JSON.stringify({ declared: language.name ?? null, clean, nodes, residentMb: Math.round(process.memoryUsage().rss / 1048576) }))
  process.exit(0)
})().catch(err => {
  log(JSON.stringify({ error: String(err && err.message ? err.message : err) }))
  process.exit(9)
})
`,
    )
    const fold = (n: string): string => n.toLowerCase().replace(/[-_]/g, '')
    for (const name of admitted) {
      const row = rowOf(name)!
      const files = Object.keys(CORPUS[name]!).map(f => join(work, 'lf', name, f))
      const flags = row.baseline === true ? ['--no-wasm-tier-up', '--no-wasm-dynamic-tiering'] : []
      const run = spawnSync(NODE, [...flags, join(scratch, 'sustained.cjs'), engineDir, row.wasm, ...files], { encoding: 'utf8', timeout: 180_000, env: process.env })
      let out: { declared?: string | null; clean?: boolean; nodes?: number; residentMb?: number; error?: string } = {}
      try {
        out = JSON.parse((run.stdout ?? '').trim().split('\n').at(-1) ?? '{}')
      } catch {
        out = {}
      }
      const declaredOk = out.declared === null || out.declared === undefined ? row.declares === undefined : fold(out.declared) === fold(row.declares ?? row.name)
      check(`${name}: exit 0, clean, ${out.nodes ?? '?'} nodes a pass, ${out.residentMb ?? '?'} MB resident${row.baseline === true ? ' (held)' : ''}`, run.status === 0 && out.clean === true && (out.nodes ?? 0) > 20 && declaredOk, `exit ${run.status} · ${JSON.stringify(out)} · ${(run.stderr ?? '').slice(-200)}`)
    }
  }
}

console.log(failures > 0 ? `\ngrammar admission: ${failures} of ${checks} FAILED` : `\ngrammar admission: ${checks} of ${checks} green`)
process.exit(failures > 0 ? 1 : 0)
