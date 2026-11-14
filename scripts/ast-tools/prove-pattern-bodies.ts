#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { armEnvironment, check, drive, enterRoot, finish, makeContext, section, skip, REPO } from './lib/harness.ts'

const { engineDir } = armEnvironment()

const { AstSearchTool } = await import(join(REPO, 'src/tools/AstSearchTool/AstSearchTool.ts'))
const { AstEditTool } = await import(join(REPO, 'src/tools/AstEditTool/AstEditTool.ts'))
const { GRAMMAR_REGISTRY } = await import(join(REPO, 'src/services/structure/grammarRegistry.ts'))
const { resolveAstScope, searchAstPattern, isAstRefusal } = await import(join(REPO, 'src/utils/astPatterns.ts'))

const root = mkdtempSync(join(tmpdir(), 'ast-pattern-bodies-'))
const put = (file: string, text: string): void => { mkdirSync(join(root, file, '..'), { recursive: true }); writeFileSync(join(root, file), text) }
const crlf = (lines: string[]): string => `${lines.join('\r\n')}\r\n`
const registry = GRAMMAR_REGISTRY as Array<{ name: string; wasm: string; extensions: string[]; basenames?: string[] }>
const rowOf = (lang: string) => registry.find(row => row.name === lang)!
const fileOf = (lang: string): string => (rowOf(lang).extensions[0] ? `probe${rowOf(lang).extensions[0]}` : rowOf(lang).basenames![0]!)
const admitted = (lang: string): boolean => existsSync(join(engineDir, rowOf(lang).wasm))
const squash = (text: string): string => text.replace(/\s+/g, ' ').trim()

const ROWS: Array<[lang: string, pattern: string, code: string, key: string, bodies: string[]]> = [
  ['yaml', '[$$$ITEMS]', 'a: [1, 2, 3]\nb: [4]\nc: []\n', '$$$ITEMS', ['1, 2, 3', '4', '']],
  ['yaml', 'jobs:\n  $$$JOBS', 'jobs:\n  build: 1\n  test: 2\n', '$$$JOBS', ['build: 1 test: 2']],
  ['markdown', '# $T\n\n$$$BODY', '# A\n\ntext one\n\ntext two\n\n# B\n\n# C\n\nonly\n', '$$$BODY', ['text one text two', '', 'only']],
  ['sql', 'CREATE TABLE $T ($$$COLS)', 'CREATE TABLE a (x INT, y TEXT);\nCREATE TABLE b (z INT);\n', '$$$COLS', ['x INT, y TEXT', 'z INT']],
  ['sql', 'SELECT $$$COLS FROM $T', 'SELECT a, b FROM t;\nSELECT c FROM u;\n', '$$$COLS', ['a, b', 'c']],
  ['dockerfile', 'RUN $$$CMD', 'FROM x\nRUN a b\nRUN c\n', '$$$CMD', ['a b', 'c']],
  ['lua', 'function $NAME($$$PARAMS) $$$BODY end', 'function none() end\nfunction one(a) print(a) end\nfunction three(a, b) local c = a + b; print(c); return c end\n', '$$$BODY', ['', 'print(a)', 'local c = a + b; print(c); return c']],
  ['lua', 'if $COND then $$$BODY end', 'if x > 0 then a(); b() end\nif x < 0 then end\nif x then c() end\n', '$$$BODY', ['a(); b()', '', 'c()']],
  ['make', 'clean:\n\t$$$RECIPE', 'all: a b\n\techo one\nclean:\n\trm -f x\n\trm -f y\n', '$$$RECIPE', ['rm -f x rm -f y']],
  ['cmake', 'function($NAME $$$ARGS)\n$$$BODY\nendfunction()', 'function(none)\nendfunction()\nfunction(one a)\n  set(x 1)\nendfunction()\nfunction(three a b)\n  set(x 1)\n  message(STATUS "x")\nendfunction()\n', '$$$BODY', ['', 'set(x 1)', 'set(x 1) message(STATUS "x")']],
  ['cmake', 'if($COND)\n$$$BODY\nendif()', 'if(A)\n  set(x 1)\n  message(STATUS "x")\nendif()\nif(B)\nendif()\nif(C)\n  set(y 2)\nendif()\n', '$$$BODY', ['set(x 1) message(STATUS "x")', '', 'set(y 2)']],
  ['xml', '<item $$$ATTRS>$T</item>', '<r><item a="1" b="2">x</item><item>y</item><item c="3">z</item></r>\n', '$$$ATTRS', ['a="1" b="2"', '', 'c="3"']],
  ['xml', '<list>$$$ITEMS</list>', '<r><list><i/><i/></list><list></list><list><j/></list></r>\n', '$$$ITEMS', ['<i/><i/>', '', '<j/>']],
  ['hcl', 'resource $T $N { $$$BODY }', 'resource "aws_instance" "web" {\n  ami = "x"\n  instance_type = "t3.small"\n}\nresource "aws_s3_bucket" "b" {\n}\nresource "aws_eip" "ip" {\n  vpc = true\n}\n', '$$$BODY', ['ami = "x" instance_type = "t3.small"', '', 'vpc = true']],
  ['graphql', 'type $T { $$$FIELDS }', 'type Query {\n  a: Int\n  b: String!\n}\ntype One {\n  a: Int\n}\n', '$$$FIELDS', ['a: Int b: String!', 'a: Int']],
  ['protobuf', 'message $M { $$$FIELDS }', 'syntax = "proto3";\nmessage Ping {\n  string id = 1;\n  int32 n = 2;\n}\nmessage Empty {\n}\nmessage One {\n  bool ok = 1;\n}\n', '$$$FIELDS', ['string id = 1; int32 n = 2;', '', 'bool ok = 1;']],
  ['protobuf', 'enum $E { $$$VALUES }', 'syntax = "proto3";\nenum A { X = 0; Y = 1; }\nenum B { Z = 0; }\n', '$$$VALUES', ['X = 0; Y = 1;', 'Z = 0;']],
  ['protobuf', 'service $S { $$$RPCS }', 'syntax = "proto3";\nservice A { rpc X(Q) returns (R); rpc Y(Q) returns (R); }\nservice B { }\nservice C { rpc Z(Q) returns (R); }\n', '$$$RPCS', ['rpc X(Q) returns (R); rpc Y(Q) returns (R);', '', 'rpc Z(Q) returns (R);']],
  ['dart', 'if ($COND) { $$$BODY }', 'void f(int x) {\n  if (x > 0) { a(); b(); }\n  if (x < 0) {}\n  if (x == 0) { c(); }\n}\n', '$$$BODY', ['a(); b();', '', 'c();']],
  ['dart', 'class $N { $$$M }', 'class A {}\nclass B { int x = 1; void f() {} }\nclass C { int y = 2; }\n', '$$$M', ['', 'int x = 1; void f() {}', 'int y = 2;']],
  ['scala', 'def $N($$$P): $T = { $$$BODY }', 'object O {\n  def none(): Unit = {}\n  def one(a: Int): Int = { a + 1 }\n  def three(a: Int, b: Int): Int = { val c = a + b; println(c); c }\n}\n', '$$$BODY', ['', 'a + 1', 'val c = a + b; println(c); c']],
  ['scala', 'def $N($$$P): $T = $B', 'object O {\n  def none(): Unit = {}\n  def one(a: Int): Int = a + 1\n  def two(a: Int, b: Int): Int = a + b\n}\n', '$$$P', ['', 'a: Int', 'a: Int, b: Int']],
  ['elixir', 'def $NAME($$$ARGS) do $$$BODY end', 'defmodule M do\n  def none() do\n  end\n  def one(a) do\n    a + 1\n  end\n  def three(a, b) do\n    c = a + b\n    IO.puts(c)\n    c\n  end\nend\n', '$$$BODY', ['', 'a + 1', 'c = a + b IO.puts(c) c']],
  ['zig', 'fn $NAME($$$PARAMS) $RET { $$$BODY }', 'pub fn add(a: i32, b: i32) i32 { return a + b; }\nfn double(x: i32) i32 { return x * 2; }\nfn both(x: i32) i32 { const y = x + 1; return y * 2; }\nfn none() void {}\n', '$$$BODY', ['return a + b;', 'return x * 2;', 'const y = x + 1; return y * 2;', '']],
  ['zig', 'if ($COND) { $$$BODY }', 'fn f(x: i32) void {\n    if (x > 0) { a(); b(); }\n    if (x < 0) {}\n    if (x == 0) { c(); }\n}\n', '$$$BODY', ['a(); b();', '', 'c();']],
  ['zig', 'while ($COND) { $$$BODY }', 'fn f(x: i32) void {\n    while (x > 0) { a(); b(); }\n    while (x < 0) {}\n    while (x == 0) { c(); }\n}\n', '$$$BODY', ['a(); b();', '', 'c();']],
  ['haskell', 'do\n  $$$STMTS', 'main = do\n  a\n  b\n\nother = do\n  c\n', '$$$STMTS', ['a b', 'c']],
  ['ocaml', 'begin $$$BODY end', 'let f () = begin a (); b () end\nlet g () = begin c () end\n', '$$$BODY', ['a (); b ()', 'c ()']],
  ['svelte', '{#if $COND}$$$BODY{/if}', '{#if ok}<p>a</p><p>b</p>{/if}\n{#if no}{/if}\n{#if one}<p>c</p>{/if}\n', '$$$BODY', ['<p>a</p><p>b</p>', '', '<p>c</p>']],
  ['astro', '<ul>$$$ITEMS</ul>', '---\nconst a = 1\n---\n<ul><li>a</li><li>b</li></ul>\n<ul></ul>\n<ul><li>c</li></ul>\n', '$$$ITEMS', ['<li>a</li><li>b</li>', '', '<li>c</li>']],
  ['nix', 'pkgs.mkShell { $$$ATTRS }', '{ pkgs }:\n{\n  a = pkgs.mkShell { x = 1; y = 2; };\n  b = pkgs.mkShell { };\n  c = pkgs.mkShell { z = 3; };\n}\n', '$$$ATTRS', ['x = 1; y = 2;', '', 'z = 3;']],
  ['nix', '{ $$$ATTRS }', '{ a = 1; b = 2; }\n', '$$$ATTRS', ['a = 1; b = 2;']],
  ['r', 'function($$$ARGS) { $$$BODY }', 'none <- function() { }\none <- function(a) { a + 1 }\nthree <- function(a, b) {\n  c <- a + b\n  print(c)\n  c\n}\n', '$$$BODY', ['', 'a + 1', 'c <- a + b print(c) c']],
  ['julia', 'function $NAME($$$ARGS) $$$BODY end', 'function none() end\nfunction one(a) a + 1 end\nfunction three(a, b)\n  c = a + b\n  println(c)\n  c\nend\n', '$$$BODY', ['', 'a + 1', 'c = a + b println(c) c']],
  ['starlark', 'def $NAME($$$ARGS):\n    $$$BODY', 'def one(a):\n    return a\n\ndef three(a, b):\n    c = a + b\n    print(c)\n    return c\n', '$$$BODY', ['return a', 'c = a + b print(c) return c']],
  ['clojure', '(defn $NAME [$$$ARGS] $$$BODY)', '(defn none [])\n(defn one [a] (inc a))\n(defn three [a b] (println a) (println b) (+ a b))\n', '$$$BODY', ['', '(inc a)', '(println a) (println b) (+ a b)']],
  ['erlang', '$NAME($$$ARGS) -> $$$BODY.', '-module(m).\none(A) -> A + 1.\nthree(A, B) -> C = A + B, io:format("~p", [C]), C.\n', '$$$BODY', ['A + 1', 'C = A + B, io:format("~p", [C]), C']],
  ['objc', '- (void)$N { $$$BODY }', '@implementation T\n- (void)none {}\n- (void)one { [self a]; }\n- (void)three { int x = 1; [self a]; return; }\n@end\n', '$$$BODY', ['', '[self a];', 'int x = 1; [self a]; return;']],
  ['objc', 'if ($COND) { $$$BODY }', 'void f(int x) {\n  if (x > 0) { a(); b(); }\n  if (x < 0) {}\n  if (x == 0) { c(); }\n}\n', '$$$BODY', ['a(); b();', '', 'c();']],
  ['fortran', 'do $I = $A, $B\n$$$BODY\nend do', 'program p\n  integer :: i, s\n  do i = 1, 3\n    s = s + i\n    call greet(i)\n  end do\n  do i = 1, 2\n  end do\n  do i = 1, 4\n    s = 0\n  end do\nend program p\n', '$$$BODY', ['s = s + i call greet(i)', '', 's = 0']],
  ['fortran', 'subroutine $NAME($$$ARGS)\n$$$BODY\nend subroutine $NAME', 'subroutine one(a)\n  integer :: a\n  a = 1\nend subroutine one\nsubroutine two(a, b)\n  integer :: a, b\nend subroutine two\n', '$$$BODY', ['integer :: a a = 1', 'integer :: a, b']],
  ['solidity', 'function $N($$$P) external { $$$BODY }', 'contract C {\n  function none() external {}\n  function one(uint a) external { x = a; }\n  function three(uint a) external { uint b = a; x = b; emit Ran(b); }\n}\n', '$$$BODY', ['', 'x = a;', 'uint b = a; x = b; emit Ran(b);']],
  ['solidity', 'contract $N { $$$BODY }', 'contract A {}\ncontract B { uint x; function f() external {} }\ncontract D { uint y; }\n', '$$$BODY', ['', 'uint x; function f() external {}', 'uint y;']],
  ['verilog', 'always @(posedge clk) begin $$$BODY end', 'module m(input clk);\n  reg a, b;\n  always @(posedge clk) begin a <= b; b <= a; end\n  always @(posedge clk) begin end\n  always @(posedge clk) begin a <= b; end\nendmodule\n', '$$$BODY', ['a <= b; b <= a;', '', 'a <= b;']],
  ['verilog', 'module $N(input $P); $$$BODY endmodule', 'module a(input clk); endmodule\nmodule b(input clk); wire w; assign w = clk; endmodule\nmodule c(input en); wire v; endmodule\n', '$$$BODY', ['', 'wire w; assign w = clk;', 'wire v;']],
  ['emacs-lisp', '(defun $NAME ($$$ARGS) $$$BODY)', '(defun none ())\n(defun one (a) (1+ a))\n(defun three (a b) (message "a") (message "b") (+ a b))\n', '$$$BODY', ['', '(1+ a)', '(message "a") (message "b") (+ a b)']],
  ['just', '$NAME:\n    $$$BODY', 'build:\n    cargo build\n    echo done\ntest:\n    cargo test\n', '$$$BODY', ['cargo build echo done', 'cargo test']],
  ['odin', '$NAME :: proc($$$PARAMS) { $$$BODY }', 'package p\nnone :: proc() {}\none :: proc(a: int) { fmt.println(a) }\nthree :: proc(a: int, b: int) {\n\tc := a + b\n\tfmt.println(c)\n\treturn\n}\n', '$$$BODY', ['', 'fmt.println(a)', 'c := a + b fmt.println(c) return']],
  ['tlaplus', '{$$$ITEMS}', '---- MODULE M ----\nA == {1, 2, 3}\nB == {4}\nC == {}\n====\n', '$$$ITEMS', ['1, 2, 3', '4', '']],
]

section('§1 — a body or a member list written as a meta-variable holds what it stands for, in each language admitted for patterns alone')
{
  let index = 0
  for (const [lang, pattern, code, key, bodies] of ROWS) {
    const label = `${lang}: ${JSON.stringify(pattern)} holds ${bodies.map(body => (body === '' ? 'none' : JSON.stringify(body))).join(', ')}`
    if (!admitted(lang)) {
      skip(label, `${rowOf(lang).wasm} not in this checkout's engine dir (bun run scripts/vendor/fetch-grammars.ts)`)
      continue
    }
    const file = `rows/${index++}/${fileOf(lang)}`
    put(file, code)
    const scope = resolveAstScope({ cwd: root, path: file })
    if (isAstRefusal(scope)) throw new Error(scope.refused)
    const result = await searchAstPattern(scope, { pattern })
    const refused = isAstRefusal(result) ? result.refused : result.patternRefusals[0]?.note
    const found = isAstRefusal(result) ? [] : (result.matches as Array<{ captures: Array<{ key: string; text: string }> }>).map(match => squash(match.captures.find(capture => capture.key === key)?.text ?? `no ${key}`))
    check(label, JSON.stringify(found) === JSON.stringify(bodies), refused ? `refused: ${refused}` : JSON.stringify(found))
  }
}

const languagesHeld = new Set(ROWS.map(row => row[0]))
const patternOnly = (GRAMMAR_REGISTRY as Array<{ name: string; patternOnly?: boolean }>).filter(row => row.patternOnly).map(row => row.name)
check('every language admitted for patterns alone has a row above, but diff, which has no list of members', patternOnly.filter(lang => !languagesHeld.has(lang)).join(',') === 'diff', patternOnly.filter(lang => !languagesHeld.has(lang)).join(','))

put('zig/app.zig', crlf([
  'pub fn add(a: i32, b: i32) i32 { return a + b; }',
  'fn double(x: i32) i32 { return x * 2; }',
  'fn both(x: i32) i32 {',
  '    const y = x + 1;',
  '    return y * 2;',
  '}',
  'fn none() void {}',
  'pub fn main() void {',
  '    if (add(1, 2) > 2) { shout(); whisper(); }',
  '    if (double(1) > 2) {}',
  '}',
]))
put('dart/app.dart', crlf(['class Empty {}', 'class One { int y = 2; }', 'class Two {', '  // kept', '  int x = 1;', '', '  void f() {}', '}']))
put('hcl/main.tf', 'resource "aws_instance" "web" {\n  # kept\n  ami           = "x"\n  instance_type = "t3.small"\n}\n')
put('diff/a.diff', '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n')
await enterRoot(root)
const prover = await makeContext([AstSearchTool, AstEditTool], { mode: 'sovereign' })
const search = (input: Record<string, unknown>) => drive(AstSearchTool, input, prover)
const edit = (input: Record<string, unknown>) => drive(AstEditTool, input, prover)

if (!admitted('zig')) {
  skip('zig: the rows a Windows box read', `${rowOf('zig').wasm} not in this checkout's engine dir (bun run scripts/vendor/fetch-grammars.ts)`)
} else {
  section('§2 — AstSearch on a Zig file saved with CRLF')
  {
    const body = await search({ pattern: 'fn $NAME($$$PARAMS) $RET { $$$BODY }', path: 'zig' })
    check('a function is found by a pattern whose body is a meta-variable: every one of five', !body.isError && body.text.includes('\n5 matches in 1 file.'), body.text)
    check('with a body of one statement', body.text.includes('$NAME = double · $$$PARAMS = x: i32 · $RET = i32 · $$$BODY = return x * 2;'), body.text)
    check('with a body of two statements, over its lines', body.text.includes('app.zig:3:1-6:2 [function_declaration]') && body.text.includes('$NAME = both · $$$PARAMS = x: i32 · $RET = i32 · $$$BODY = const y = x + 1;'), body.text)
    check('with an empty body', body.text.includes('$NAME = none · $$$PARAMS =  · $RET = void · $$$BODY = \n'), body.text)
    const exported = await search({ pattern: 'pub fn $NAME($$$PARAMS) $RET { $$$BODY }', path: 'zig' })
    check('the same pattern after pub parses and finds the functions that carry it', !exported.isError && exported.text.includes('$NAME = add ·') && exported.text.includes('$NAME = main ·'), exported.text)
    const branch = await search({ pattern: 'if ($COND) { $$$BODY }', path: 'zig' })
    check('a block of an if holds two statements and none', !branch.isError && branch.text.includes('$COND = add(1, 2) > 2 · $$$BODY = shout(); whisper();') && branch.text.includes('$COND = double(1) > 2 · $$$BODY = \n') && branch.text.includes('\n2 matches in 1 file.'), branch.text)
    const one = await search({ pattern: 'fn $NAME($$$PARAMS) $RET { $STMT }', path: 'zig' })
    check('one meta-variable for the body stands for one statement', !one.isError && one.text.includes('$STMT = return a + b;') && one.text.includes('\n2 matches in 1 file.'), one.text)
    const written = await search({ pattern: 'fn $NAME($$$PARAMS) $RET { $$$BODY; }', path: 'zig' })
    check('a body written with its own semicolon reads as it did: the functions of one statement', !written.isError && written.text.includes('$$$BODY = return a + b\n') && written.text.includes('\n2 matches in 1 file.'), written.text)
    const empty = await search({ pattern: 'fn $NAME($$$PARAMS) $RET {}', path: 'zig' })
    check('an empty body written out finds the empty function alone, as it did', !empty.isError && empty.text.includes('$NAME = none') && empty.text.includes('\n1 match in 1 file.'), empty.text)
  }

  section('§3 — AstEdit through such a pattern')
  {
    const before = readFileSync(join(root, 'zig/app.zig'), 'utf8')
    const rename = await edit({ pattern: 'fn both($$$A) $R { $$$B }', rewrite: 'fn renamed($$$A) $R { $$$B }', path: 'zig' })
    check('a rename changes the one line that holds the name', !rename.isError && rename.text.includes('-fn both(x: i32) i32 {\r\n+fn renamed(x: i32) i32 {\r\n     const y = x + 1;\r\n     return y * 2;\r\n }'), rename.text)
    const plan = /plan: (ae-[a-f0-9]+)/.exec(rename.text)?.[1] ?? ''
    const applied = await edit({ pattern: 'fn both($$$A) $R { $$$B }', rewrite: 'fn renamed($$$A) $R { $$$B }', path: 'zig', apply: true, plan })
    check('applied, the file differs by that name alone and keeps its line endings', !applied.isError && readFileSync(join(root, 'zig/app.zig'), 'utf8') === before.replace('fn both(', 'fn renamed('), applied.text)
    const added = await edit({ pattern: 'fn double($$$A) $R { $$$B }', rewrite: 'fn double($$$A) $R { log(); $$$B }', path: 'zig' })
    check('a statement written before the body\'s meta-variable is added before the body', !added.isError && added.text.includes('+fn double(x: i32) i32 { log(); return x * 2; }'), added.text)
  }
}

if (!admitted('dart') || !admitted('hcl')) {
  skip('dart and hcl: a list of members rewritten', 'their grammars are not in this checkout\'s engine dir (bun run scripts/vendor/fetch-grammars.ts)')
} else {
  section('§4 — a list of members rewritten')
  {
    const members = await edit({ pattern: 'class $N { $$$M }', rewrite: 'class $N { int id = 0; $$$M }', path: 'dart' })
    check('a member added to every Dart class keeps each member\'s own semicolon', !members.isError && members.text.includes('Dry run — 3 matches in 1 file would change') && members.text.includes('+class One { int id = 0; int y = 2; }') && members.text.includes('+class Empty { int id = 0;  }'), members.text)
    const renamed = await edit({ pattern: 'class Two { $$$M }', rewrite: 'class Renamed { $$$M }', path: 'dart' })
    check('a Dart class renamed keeps the comment and the lines of its members', !renamed.isError && renamed.text.includes('-class Two {\r\n+class Renamed {\r\n   // kept\r\n   int x = 1;'), renamed.text)
    const block = await edit({ pattern: 'resource "aws_instance" $N { $$$BODY }', rewrite: 'resource "aws_vm" $N { $$$BODY }', path: 'hcl' })
    check('an HCL block renamed keeps the comment and the alignment of its attributes', !block.isError && block.text.includes('-resource "aws_instance" "web" {\n+resource "aws_vm" "web" {\n   # kept\n   ami           = "x"'), block.text)
  }
}

if (!admitted('diff')) {
  skip('diff: a meta-variable inside a line', `${rowOf('diff').wasm} not in this checkout's engine dir (bun run scripts/vendor/fetch-grammars.ts)`)
} else {
  section('§5 — where a meta-variable cannot be a node the answer says so')
  {
    const inside = await search({ pattern: '+$X', path: 'diff' })
    check('a diff line\'s text is text, and the answer says it', inside.isError && inside.text.includes('The pattern "+$X" did not parse as diff ($X is text there, not a node).'), inside.text)
    const line = await search({ pattern: '-a', path: 'diff' })
    check('a diff line written out is found', !line.isError && line.text.includes('a.diff:4:1 [deletion]'), line.text)
  }
}

finish('PATTERN BODIES')
