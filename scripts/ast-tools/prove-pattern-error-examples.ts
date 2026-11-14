#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { armEnvironment, check, drive, enterRoot, finish, makeContext, section, skip, REPO } from './lib/harness.ts'

const { engineDir } = armEnvironment()

const { AstSearchTool } = await import(join(REPO, 'src/tools/AstSearchTool/AstSearchTool.ts'))
const { AstEditTool } = await import(join(REPO, 'src/tools/AstEditTool/AstEditTool.ts'))
const { GRAMMAR_REGISTRY } = await import(join(REPO, 'src/services/structure/grammarRegistry.ts'))
const ast = await import(join(REPO, 'src/utils/astPatterns.ts'))
const { resolveAstScope, searchAstPattern, isAstRefusal, PATTERN_GRAMMAR_LINES } = ast
const OWN: Record<string, readonly string[]> = ast.LANGUAGE_PATTERN_EXAMPLES ?? {}

const SAMPLES: Record<string, string> = {
  python: 'import os\ndef f(a, b):\n    return g(a, b)\n',
  go: 'package p\nfunc f(a int) {\n\tif a > 0 { run() }\n\tg(a)\n}\n',
  rust: 'fn f(a: i32) {\n    if a > 0 { run(); }\n    g(a);\n}\n',
  bash: 'f() { echo hi; }\nif [ -f x ]; then echo y; fi\n',
  'c-sharp': 'class C {\n  int F(int a) { var b = G(a); return b; }\n}\n',
  cpp: '#include <vector>\nint f(int a) { return g(a); }\n',
  css: '@import "x.css";\na { color: red; margin: 0; }\n',
  java: 'class C {\n  int f(int a) { run(a); return this.g(a); }\n}\n',
  php: '<?php\nfunction f($a) { run($a); return $a; }\necho "x";\n',
  ruby: 'def f(a) run(a) end\nobj.run(1)\n',
  powershell: 'function F { Run 1 }\nif ($a) { Run 2 }\n',
  ini: '[core]\nname = value\n',
  regex: '(a|b)\n',
  c: '#include <stdio.h>\nint f(int a) { return g(a); }\n',
  html: '<html><body><a href="x">t</a><ul><li>a</li></ul></body></html>\n',
  json: '{"list": [1, 2], "one": {"name": "y"}}\n',
  toml: '[package]\nname = "x"\n',
  kotlin: 'fun f(a: Int): Int {\n  if (a > 0) { run(a) }\n  val b = g(a)\n  return b\n}\n',
  swift: 'func f(a: Int) -> Int {\n  if a > 0 { run(a) }\n  let b = g(a)\n  return b\n}\n',
  vue: '<template><ul><li>a</li></ul></template>\n',
  yaml: 'jobs:\n  - build\n  - test\n',
  markdown: '# Title\n\n## Install\n\ntext\n',
  sql: 'CREATE TABLE t (a INT, b TEXT);\nSELECT a, b FROM t;\nSELECT COALESCE(a, 0) FROM t;\n',
  dockerfile: 'FROM node:22\nWORKDIR /app\n',
  lua: 'function f(a) if a then run(a) end end\n',
  make: 'CC := gcc\ninclude config.mk\n',
  cmake: 'set(NAME 1)\nmessage(STATUS "x")\n',
  xml: '<r><item>x</item><empty a="1"/></r>\n',
  hcl: 'resource "aws_instance" "web" {\n  ami = "x"\n}\n',
  graphql: 'type Query {\n  a: Int\n}\n',
  protobuf: 'syntax = "proto3";\nmessage Ping { string id = 1; }\nservice S { rpc Get(Ping) returns (Ping); }\n',
  dart: 'void main() {\n  if (ok) { print(1); }\n}\n',
  scala: 'object O {\n  def f(a: Int): Int = { if (a > 0) { run(a) }; g(a) }\n}\n',
  elixir: 'defmodule M do\n  def f(a) do\n    run(a)\n  end\nend\n',
  zig: 'fn f(a: i32) i32 { if (a > 0) { run(a); } return g(a); }\n',
  haskell: 'f x = map g x\n',
  ocaml: 'let f xs = List.map succ xs\n',
  svelte: '{#if ok}<p>a</p>{/if}\n',
  astro: '---\nconst a = 1\n---\n<ul><li>a</li></ul>\n<Row tide={a} />\n',
  nix: '{ a = 1; }\n',
  r: 'f <- function(a) { if (a > 0) { run(a) } }\n',
  julia: 'function f(a) if a > 0 run(a) end end\n',
  starlark: 'NAME = glob(["*.c"])\n',
  clojure: '(defn f [a] (run a))\n',
  erlang: '-module(m).\nf(A) -> lists:reverse(A).\n',
  objc: '@implementation T\n- (void)run { if (ok) { [self stop]; } }\n@end\n',
  fortran: 'program p\n  x = 1\n  call greet(x)\nend program p\n',
  solidity: 'contract C {\n  function f(uint a) public { if (a > 0) { run(a); } }\n}\n',
  verilog: 'module m(input clk);\n  reg a, b;\n  assign b = a;\n  always @(posedge clk) begin a <= b; end\nendmodule\n',
  'emacs-lisp': '(defun f (a) (run a))\n',
  just: 'version := "1"\nalias b := build\nbuild:\n    cargo build\n',
  odin: 'package p\nf :: proc(a: int) { if a > 0 { run(a) } }\n',
  tlaplus: '---- MODULE M ----\nA == F(1)\n====\n',
  diff: '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-int old(void);\n+int renamed(void);\n',
}

const root = mkdtempSync(join(tmpdir(), 'ast-error-examples-'))
const put = (file: string, text: string): void => { mkdirSync(join(root, file, '..'), { recursive: true }); writeFileSync(join(root, file), text) }
const registry = GRAMMAR_REGISTRY as Array<{ name: string; wasm: string; extensions: string[]; basenames?: string[] }>
const KEEP = ['javascript', 'typescript', 'tsx']
const fileOf = (row: (typeof registry)[number]): string => (row.extensions[0] ? `sample${row.extensions[0]}` : row.basenames![0]!)
const admitted = (row: (typeof registry)[number]): boolean => existsSync(join(engineDir, row.wasm))
const quoted = (examples: readonly string[]): string => examples.map(example => JSON.stringify(example)).join(', ')
const NAMES = 'Meta-variable names are UPPERCASE: $NAME for one node, $$$NAME for a sequence ($$X and $$$name are literal text).'

section('§1 — every language but JavaScript, TypeScript and TSX has examples of its own')
{
  const without = registry.filter(row => !KEEP.includes(row.name) && OWN[row.name] === undefined).map(row => row.name)
  check('each of the 54 other languages of the registry has examples', without.length === 0 && registry.length - KEEP.length === 54, without.join(', '))
  const stray = Object.keys(OWN).filter(name => KEEP.includes(name) || !registry.some(row => row.name === name))
  check('no example is kept for a language outside them', stray.length === 0, stray.join(', '))
  const counts = Object.entries(OWN).filter(([, examples]) => examples.length < 2 || examples.length > 3).map(([name]) => name)
  check('two or three for each', Object.keys(OWN).length > 0 && counts.length === 0, counts.join(', '))
  const lines = Object.entries(OWN).filter(([, examples]) => examples.some(example => example.includes('\n'))).map(([name]) => name)
  check('each example is one line', lines.length === 0, lines.join(', '))
}

section('§2 — each example compiles in its language and finds a node in a sample of it')
for (const row of registry) {
  if (KEEP.includes(row.name)) continue
  const examples = OWN[row.name] ?? []
  const label = `${row.name}: ${quoted(examples)}`
  if (!admitted(row)) {
    skip(label, `${row.wasm} not in this checkout's engine dir (bun run scripts/vendor/fetch-grammars.ts)`)
    continue
  }
  put(`samples/${row.name}/${fileOf(row)}`, SAMPLES[row.name] ?? '')
  const scope = resolveAstScope({ cwd: join(root, 'samples', row.name) })
  if (isAstRefusal(scope)) throw new Error(scope.refused)
  const fails: string[] = []
  for (const example of examples) {
    const result = await searchAstPattern(scope, { pattern: example })
    if (isAstRefusal(result)) fails.push(`${example}: ${result.refused}`)
    else if (result.patternRefusals.length > 0) fails.push(`${example}: ${result.patternRefusals[0]!.note}`)
    else if (result.matches.length === 0) fails.push(`${example}: no match in the sample`)
  }
  check(label, examples.length > 0 && fails.length === 0, fails.join('; '))
}

put('zig/app.zig', 'fn f(a: i32) i32 { return a; }\n')
put('py/app.py', 'def f(a):\n    return a\n')
put('go/app.go', 'package p\nfunc f(a int) int { return a }\n')
put('ts/app.ts', 'function f(a: number) { return a }\n')
put('js/app.js', 'function f(a) { return a }\n')
put('tsx/app.tsx', 'function f(a: number) { return a }\n')
put('diff/a.diff', '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n')
put('both/app.zig', 'fn f(a: i32) i32 { return a; }\n')
put('both/app.py', 'def f(a):\n    return a\n')
await enterRoot(root)
const prover = await makeContext([AstSearchTool, AstEditTool], { mode: 'sovereign' })
const search = (input: Record<string, unknown>) => drive(AstSearchTool, input, prover)
const edit = (input: Record<string, unknown>) => drive(AstEditTool, input, prover)
const linesOf = (text: string): string[] => text.replace(/^<tool_use_error>/, '').replace(/<\/tool_use_error>$/, '').split('\n')
const own = (lang: string): string => `A pattern is ONE complete node of the target language, written as code. In ${lang}: ${quoted(OWN[lang] ?? [])}.`
const kept = 'Meta-variable names are UPPERCASE: $NAME for one node, $$$NAME for a sequence ($$X and $$$name are literal text). Try one of: "$FN($$$ARGS)", "if ($COND) { $$$BODY }", "function $NAME($$$ARGS) { $$$BODY }".'

section('§3 — the answer under a pattern that does not parse shows the examples of the language asked')
for (const [lang, dir, pattern] of [['zig', 'zig', 'fn f((('], ['python', 'py', 'def f((('], ['go', 'go', 'func f(((']] as const) {
  if (!admitted(registry.find(row => row.name === lang)!)) {
    skip(`${lang}: its own examples`, 'its grammar is not in this checkout\'s engine dir (bun run scripts/vendor/fetch-grammars.ts)')
    continue
  }
  const answer = await search({ pattern, path: dir })
  const lines = linesOf(answer.text)
  check(`${lang}: the first line names the pattern, the language and the place`, answer.isError && lines[0] === `The pattern ${JSON.stringify(pattern)} did not parse as ${lang} (1:1 syntax error).`, answer.text)
  check(`${lang}: the second line shows ${lang}'s own examples`, lines[1] === own(lang), lines[1])
  check(`${lang}: the third line is the sentence about names, and the answer ends there`, lines[2] === NAMES && lines.length === 3, lines.slice(2).join(' | '))
  check(`${lang}: no JavaScript declaration is offered`, !answer.text.includes('function $NAME($$$ARGS) { $$$BODY }'), answer.text)
}
for (const [lang, dir] of [['typescript', 'ts'], ['javascript', 'js'], ['tsx', 'tsx']] as const) {
  const answer = await search({ pattern: 'function f(((', path: dir })
  const lines = linesOf(answer.text)
  check(`${lang}: the answer keeps its two lines as they were`, answer.isError && lines[0] === `The pattern "function f(((" did not parse as ${lang} (1:1 syntax error).` && lines[1] === PATTERN_GRAMMAR_LINES[0] && lines[2] === kept && lines.length === 3, answer.text)
}
if (!admitted(registry.find(row => row.name === 'diff')!) || !admitted(registry.find(row => row.name === 'zig')!)) {
  skip('diff and zig: the other roads to the answer', 'their grammars are not in this checkout\'s engine dir (bun run scripts/vendor/fetch-grammars.ts)')
} else {
  const text = await search({ pattern: '+$X', path: 'diff' })
  check('a meta-variable that is text in the language asked is answered with that language\'s examples', text.isError && linesOf(text.text)[0] === 'The pattern "+$X" did not parse as diff ($X is text there, not a node).' && linesOf(text.text)[1] === own('diff'), text.text)
  const two = await search({ pattern: 'f(((', path: 'both' })
  const named = /did not parse as (\S+) \(/.exec(two.text)?.[1] ?? ''
  check('where two languages refuse, the examples are of the one named first', two.isError && two.text.includes('; nor as ') && linesOf(two.text)[1] === own(named), two.text)
  const rewrite = await edit({ pattern: 'fn f(((', rewrite: 'x', path: 'zig' })
  check('AstEdit answers the same three lines', rewrite.isError && linesOf(rewrite.text)[1] === own('zig') && linesOf(rewrite.text)[2] === NAMES, rewrite.text)
  const rules = await edit({ rules: [{ pattern: 'f($X)', rewrite: 'g($X)' }, { pattern: 'fn f(((', rewrite: 'x' }], path: 'zig' })
  check('and by rules, after the rule\'s number', rules.isError && linesOf(rules.text)[0] === 'Rule 1: The pattern "fn f(((" did not parse as zig (1:1 syntax error).' && linesOf(rules.text)[1] === own('zig'), rules.text)
}

finish('PATTERN ERROR EXAMPLES')
