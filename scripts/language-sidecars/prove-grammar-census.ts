import { copyFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { GRAMMAR_REGISTRY, GRAMMAR_ENGINE_RUNTIME_FILES } = await import('../../src/services/structure/grammarRegistry.ts')
{
  const ROOT = join(import.meta.dir, '..', '..')
  const vscodeDir = join(ROOT, 'node_modules', '@vscode', 'tree-sitter-wasm', 'wasm')
  const packDir = join(ROOT, 'vendor', 'grammars', 'extracted')
  const composed = mkdtempSync(join(tmpdir(), 'vista-census-engine-'))
  for (const f of GRAMMAR_ENGINE_RUNTIME_FILES) copyFileSync(join(vscodeDir, f), join(composed, f))
  const missingPack: string[] = []
  for (const g of GRAMMAR_REGISTRY) {
    const from = (g.source ?? 'vscode-pack') === 'vscode-pack' ? join(vscodeDir, g.wasm) : join(packDir, g.wasm)
    if (existsSync(from)) copyFileSync(from, join(composed, g.wasm))
    else missingPack.push(`${g.name} (${from})`)
  }
  if (missingPack.length > 0) {
    console.error(`FAIL: census engine incomplete — missing: ${missingPack.join(', ')}`)
    console.error('  remedy: bun install; bun run scripts/vendor/fetch-grammars.ts')
    process.exit(1)
  }
  process.env.MERCURY_TREESITTER_VENDOR_DIR = composed
}
const { loadGrammarEngine, parsePolyglot, languageByName } = await import('../../src/services/structure/grammarFacility.ts')
const { resolveAstScope, searchAstPattern, isAstRefusal } = await import('../../src/utils/astPatterns.ts')

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

interface Fixture {
  good: string
  broken?: string
  file: string
  pattern: string
  symbol?: { kind: 'function' | 'class' | 'method'; name: string }
}

const FIXTURES: Record<string, Fixture> = {
  python: {
    good: 'def greet(name):\n    print(name)\n',
    broken: 'def broken(:\n    print(\n',
    file: 'app.py',
    pattern: 'print($X)',
    symbol: { kind: 'function', name: 'greet' },
  },
  go: {
    good: 'package main\n\nimport "fmt"\n\nfunc Greet() {\n\tfmt.Println("x")\n}\n',
    broken: 'package main\n\nfunc {\n',
    file: 'main.go',
    pattern: 'fmt.Println($$$A)',
    symbol: { kind: 'function', name: 'Greet' },
  },
  rust: {
    good: 'fn greet() { println!("{}", 1); }\n',
    broken: 'fn broken( {\n',
    file: 'lib.rs',
    pattern: 'println!($$$A)',
    symbol: { kind: 'function', name: 'greet' },
  },
  javascript: {
    good: 'function greet(a) { console.log(a) }\n',
    broken: 'function (]{\n',
    file: 'app.js',
    pattern: 'console.log($A)',
  },
  typescript: {
    good: 'export function greet(a: number) { console.log(a) }\n',
    broken: 'export function (]: {\n',
    file: 'util.ts',
    pattern: 'console.log($A)',
  },
  tsx: {
    good: 'export function C() { return <div>hi</div> }\n',
    broken: 'export function C() { return <div>hi< }\n',
    file: 'view.tsx',
    pattern: '<div>hi</div>',
  },
  bash: {
    good: 'greet() {\n  echo "hi"\n}\n',
    broken: 'if [ ; then\n',
    file: 'run.sh',
    pattern: 'echo "hi"',
  },
  'c-sharp': {
    good: 'class A { void M() { System.Console.WriteLine("x"); } }\n',
    broken: 'class A { void M( { }\n',
    file: 'a.cs',
    pattern: 'System.Console.WriteLine("x")',
  },
  cpp: {
    good: 'int main() { return 0; }\n',
    broken: 'int main( { return 0;\n',
    file: 'a.cpp',
    pattern: 'return 0;',
  },
  css: {
    good: 'body { color: red; }\n',
    broken: 'body { color: red;\n',
    file: 'a.css',
    pattern: 'body { color: red; }',
  },
  java: {
    good: 'class A { void m() { System.out.println("x"); } }\n',
    broken: 'class A { void m( { }\n',
    file: 'A.java',
    pattern: 'System.out.println("x")',
  },
  php: {
    good: '<?php\nfunction greet() { echo "hi"; }\n',
    broken: '<?php\nfunction (] {\n',
    file: 'a.php',
    pattern: 'echo "hi";',
  },
  ruby: {
    good: 'def greet\n  puts "x"\nend\n',
    broken: 'def broken(\nend end\n',
    file: 'a.rb',
    pattern: 'puts "x"',
  },
  powershell: {
    good: 'function Greet {\n  Write-Output "hi"\n}\n',
    broken: 'function Greet {\n  if (\n',
    file: 'deploy.ps1',
    pattern: 'Write-Output "hi"',
  },
  ini: {
    good: '[section]\nkey = value\n',
    broken: '[unclosed\n',
    file: 'settings.ini',
    pattern: 'key = value',
  },
  regex: {
    good: 'a(b|c)*d\n',
    broken: 'a(b\n',
    file: 'corpus.regex',
    pattern: '(b|c)',
  },
  c: {
    good: 'int main() { return 0; }\n',
    broken: 'int main( {\n',
    file: 'a.c',
    pattern: 'return 0;',
  },
  html: {
    good: '<div class="a">hi</div>\n',
    broken: '<div class="a\n',
    file: 'a.html',
    pattern: '<div class="a">hi</div>',
  },
  json: {
    good: '{"a": 1}\n',
    broken: '{"a": }\n',
    file: 'a.json',
    pattern: '{"a": 1}',
  },
  toml: {
    good: '[section]\nkey = "value"\n',
    broken: '[unclosed\n',
    file: 'a.toml',
    pattern: 'key = "value"',
  },
  kotlin: {
    good: 'fun greet() { println("hi") }\n',
    broken: 'fun greet( {\n',
    file: 'a.kt',
    pattern: 'println("hi")',
  },
  swift: {
    good: 'func greet() { print("hi") }\n',
    broken: 'func greet( {\n',
    file: 'a.swift',
    pattern: 'print("hi")',
  },
  vue: {
    good: '<template>\n  <div>hi</div>\n</template>\n',
    broken: '<template><div\n',
    file: 'a.vue',
    pattern: '<div>hi</div>',
  },
  yaml: {
    good: 'name: tidepool\nimage: nginx:1.27\nports:\n  - 80\n  - 443\n',
    broken: 'key: [unclosed\nother: }\n',
    file: 'a.yaml',
    pattern: 'image: $V',
  },
  markdown: {
    good: '# Title\n\n## Install\n\nText.\n\n## Use\n\nMore.\n',
    file: 'a.md',
    pattern: '## $T',
  },
  sql: {
    good: 'SELECT id, COUNT(name) FROM users WHERE id = 1;\nDELETE FROM users WHERE id = 2;\n',
    broken: 'SELECT a FROM;\n',
    file: 'a.sql',
    pattern: 'COUNT($X)',
  },
  dockerfile: {
    good: 'FROM alpine:3.20 AS base\nWORKDIR /app\nRUN apk add --no-cache curl\nWORKDIR /srv\n',
    broken: 'FROM\nRUN [\n',
    file: 'Dockerfile',
    pattern: 'WORKDIR $D',
  },
  lua: {
    good: 'local x = 1\nprint(x)\nprint("hi", x)\n',
    broken: 'local function (\nend end\n',
    file: 'a.lua',
    pattern: 'print($$$A)',
  },
  make: {
    good: 'CC ?= cc\nCFLAGS += -Wall\n\nall: main.o\n\tcc -o app main.o\n',
    broken: 'ifeq ($(A),1\nall:\n',
    file: 'Makefile',
    pattern: 'CFLAGS += $F',
  },
  cmake: {
    good: 'cmake_minimum_required(VERSION 3.20)\nproject(demo)\nadd_executable(demo main.c)\nadd_executable(tool tool.c util.c)\n',
    broken: 'add_executable(demo main.c\n',
    file: 'CMakeLists.txt',
    pattern: 'add_executable($N $$$S)',
  },
  xml: {
    good: '<?xml version="1.0"?>\n<root><item id="1">one</item><item id="2">two</item></root>\n',
    broken: '<root><item></root>\n',
    file: 'a.xml',
    pattern: '<item id="1">$T</item>',
  },
  hcl: {
    good: 'resource "aws_instance" "web" {\n  ami           = "ami-123"\n  instance_type = "t3.small"\n}\n',
    broken: 'resource "a" "b" {\n  ami = \n',
    file: 'main.tf',
    pattern: 'instance_type = $T',
  },
  graphql: {
    good: 'type Query {\n  id: ID!\n  name: String\n}\n\ntype Node {\n  id: ID!\n}\n',
    broken: 'type Query {\n  hello(: String\n',
    file: 'a.graphql',
    pattern: 'id: ID!',
  },
  protobuf: {
    good: 'syntax = "proto3";\n\nmessage Ping {\n  string id = 1;\n}\n\nmessage Pong {\n  string id = 1;\n}\n',
    broken: 'message Ping {\n  string id = ;\n',
    file: 'a.proto',
    pattern: 'string id = 1;',
  },
  dart: {
    good: "void main() {\n  print('hi');\n  print('yo');\n}\n",
    broken: 'void main( {\n  print(;\n',
    file: 'a.dart',
    pattern: 'print($X)',
  },
  scala: {
    good: 'object Main {\n  def run(): Unit = {\n    println("hi")\n    println("yo")\n  }\n}\n',
    broken: 'object Main {\n  def main(: Unit = \n',
    file: 'A.scala',
    pattern: 'println($X)',
  },
  elixir: {
    good: 'defmodule Demo do\n  def run do\n    IO.puts("hi")\n    IO.puts("yo")\n  end\nend\n',
    broken: 'defmodule Demo do\n  def hello(, do: \n',
    file: 'a.ex',
    pattern: 'IO.puts($X)',
  },
  zig: {
    good: 'const std = @import("std");\npub fn main() void {\n    std.debug.print("hi\\n", .{});\n    std.debug.print("yo\\n", .{});\n}\n',
    broken: 'pub fn main( void {\n    const x = ;\n',
    file: 'a.zig',
    pattern: 'std.debug.print($F, $A)',
  },
  haskell: {
    good: 'main :: IO ()\nmain = do\n  putStrLn "hi"\n  putStrLn "yo"\n',
    broken: 'main :: IO (\nmain = = putStrLn\n',
    file: 'A.hs',
    pattern: 'putStrLn $X',
  },
  ocaml: {
    good: 'let () =\n  print_endline "hi";\n  print_endline "yo"\n',
    broken: 'let greet name = = print_endline (\n',
    file: 'a.ml',
    pattern: 'print_endline $X',
  },
  svelte: {
    good: '<script>\n  let name = "x"\n</script>\n\n<p>hi</p>\n<p>yo</p>\n',
    broken: '<div>\n  {#if open}\n</div>\n',
    file: 'A.svelte',
    pattern: '<p>hi</p>',
  },
  astro: {
    good: '---\nconst title = "x"\n---\n<h1>{title}</h1>\n<p>hi</p>\n',
    broken: '---\nconst title = "x"\n---\n<h1>{title}</h2\n',
    file: 'A.astro',
    pattern: '<p>hi</p>',
  },
  nix: {
    good: '{ pkgs }:\n{\n  version = "1.0";\n  name = "demo";\n}\n',
    broken: '{ pkgs }:\npkgs.mkShell { packages = [ ; }\n',
    file: 'a.nix',
    pattern: 'version = $V;',
  },
}

const READS_EVERY_TEXT = new Set(['markdown'])

{
  const missing = GRAMMAR_REGISTRY.filter(g => !FIXTURES[g.name]).map(g => g.name)
  check('every registry row has a proof fixture', missing.length === 0, missing.join(','))
}

const engine = await loadGrammarEngine()
if (engine.state === 'unavailable') {
  console.error(`FAIL: grammar engine unavailable — ${engine.note}`)
  process.exit(1)
}

const censusRows: string[] = []

for (const lang of GRAMMAR_REGISTRY) {
  const fx = FIXTURES[lang.name]
  if (!fx) continue
  console.log(`\n== ${lang.name} ==`)

  const good = await parsePolyglot(engine, lang, fx.good)
  const goodOk = !('state' in good) && good.parseErrors.length === 0
  check('good fixture parses clean', goodOk, 'state' in good ? good.note : good.parseErrors.join('; '))
  if (!('state' in good)) good.tree.delete()

  let brokenOk = READS_EVERY_TEXT.has(lang.name)
  if (fx.broken === undefined) {
    check('no broken fixture, and the grammar is one that reads every text', brokenOk)
  } else {
    const broken = await parsePolyglot(engine, lang, fx.broken)
    brokenOk = !('state' in broken) && broken.parseErrors.length > 0
    check('broken fixture REPORTS', brokenOk, 'state' in broken ? broken.note : `no errors reported`)
    if (!('state' in broken)) broken.tree.delete()
  }

  const root = mkdtempSync(join(tmpdir(), `vista-census-${lang.name.replace(/[^a-z0-9]/g, '')}-`))
  writeFileSync(join(root, fx.file), fx.good)
  const scope = resolveAstScope({ cwd: root, lang: lang.name })
  const q = isAstRefusal(scope) ? scope : await searchAstPattern(scope, { pattern: fx.pattern })
  const queryOk = !isAstRefusal(q) && q.matches.length >= 1 && q.matches.every(m => m.lang === lang.name)
  check(`pattern '${fx.pattern}' matches through the real matcher`, queryOk, isAstRefusal(q) ? q.refused : `${q.matches.length} matches`)
  censusRows.push(
    `${lang.name.padEnd(11)} parse:${goodOk ? 'ok' : 'FAIL'} errors:${brokenOk ? 'ok' : 'FAIL'} query:${queryOk ? 'ok' : 'FAIL'}`,
  )
}

{
  const reg = languageByName('python')
  check('census drove the registry rows (sanity)', reg !== null && censusRows.length === GRAMMAR_REGISTRY.length)
}

console.log('\n== known vendored gaps (expected-defect pins) ==')
{
  const KNOWN_VENDORED_GAPS: Array<{ lang: string; label: string; code: string; card: string }> = [
    { lang: 'ini', label: 'configparser continuation line', code: '[testenv]\ndeps =\n    pytest\n', card: 'FC-103' },
    { lang: 'ini', label: 'configparser colon pair', code: '[s]\nk: v\n', card: 'FC-103' },
    { lang: 'css', label: 'Selectors-4 case flag [attr="v" i]', code: '[data-x="a" i] { color: red; }', card: 'FC-113' },
    { lang: 'css', label: 'named container query', code: '@container card (min-width: 400px) { .a { color: red; } }', card: 'FC-113' },
    { lang: 'bash', label: 'here-string after another redirection', code: 'cat >out <<<"x"', card: 'FC-114' },
    { lang: 'bash', label: 'here-string after fd dup', code: 'cat 2>&1 <<<"x"', card: 'FC-114' },
    { lang: 'html', label: 'omitted </p> (valid HTML5)', code: '<p>only\n', card: 'FC-115' },
  ]
  const CONTROLS: Record<string, string> = {
    ini: '[testenv]\ndeps = pytest\n',
    css: '.a { color: red; }\n',
    bash: 'cat <<<"x"\n',
    html: '<p>a</p>\n',
  }
  for (const gap of KNOWN_VENDORED_GAPS) {
    const lang = GRAMMAR_REGISTRY.find(l => l.name === gap.lang)
    if (!lang) {
      check(`${gap.card} pin: registry carries ${gap.lang}`, false)
      continue
    }
    const parsed = await parsePolyglot(engine, lang, gap.code)
    const stillBroken = !('state' in parsed) && parsed.parseErrors.length > 0
    if (!('state' in parsed)) parsed.tree.delete()
    check(
      `${gap.card} ${gap.lang}: '${gap.label}' still mis-parses (a vendor bump that heals it flips this pin — close the card)`,
      stillBroken,
    )
  }
  for (const [langName, code] of Object.entries(CONTROLS)) {
    const lang = GRAMMAR_REGISTRY.find(l => l.name === langName)
    if (!lang) continue
    const parsed = await parsePolyglot(engine, lang, code)
    const clean = !('state' in parsed) && parsed.parseErrors.length === 0
    if (!('state' in parsed)) parsed.tree.delete()
    check(`${langName} control parses clean (the driver has teeth)`, clean)
  }
}

console.log('\n── grammar census ──')
for (const row of censusRows) console.log(`  ${row}`)

if (failures > 0) {
  console.error(`\ngrammar census: ${failures} FAILURES`)
  process.exit(1)
}
console.log('\ngrammar census: green')
