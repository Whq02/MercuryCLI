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

const root = mkdtempSync(join(tmpdir(), 'ast-pattern-keywords-'))
const put = (file: string, text: string): void => { mkdirSync(join(root, file, '..'), { recursive: true }); writeFileSync(join(root, file), text) }
const registry = GRAMMAR_REGISTRY as Array<{ name: string; wasm: string; extensions: string[]; basenames?: string[] }>
const rowOf = (lang: string) => registry.find(row => row.name === lang)!
const fileOf = (lang: string): string => (rowOf(lang).extensions[0] ? `probe${rowOf(lang).extensions[0]}` : rowOf(lang).basenames![0]!)
const admitted = (lang: string): boolean => existsSync(join(engineDir, rowOf(lang).wasm))

let cases = 0
async function found(lang: string, code: string, pattern: string): Promise<string[] | string> {
  const file = `rows/${cases++}/${fileOf(lang)}`
  put(file, code)
  const scope = resolveAstScope({ cwd: root, path: file })
  if (isAstRefusal(scope)) throw new Error(scope.refused)
  const result = await searchAstPattern(scope, { pattern })
  if (isAstRefusal(result)) return `refused: ${result.refused}`
  if (result.patternRefusals[0]) return `refused: ${result.patternRefusals[0].note}`
  return (result.matches as Array<{ text: string }>).map(match => match.text.split('\n')[0]!.trim())
}
const same = (got: string[] | string, want: string[]): boolean => Array.isArray(got) && JSON.stringify(got) === JSON.stringify(want)
const said = (got: string[] | string): string => (Array.isArray(got) ? JSON.stringify(got) : got)

type Row = [lang: string, code: string, written: string, finds: string[], plain: string | null, plainFinds: string[]]

async function table(rows: Row[]): Promise<void> {
  for (const [lang, code, written, finds, plain, plainFinds] of rows) {
    const label = plain === null
      ? `${lang}: ${JSON.stringify(written)} finds ${JSON.stringify(finds)} alone`
      : `${lang}: ${JSON.stringify(written)} finds ${JSON.stringify(finds)} alone, and ${JSON.stringify(plain)} finds ${plainFinds.length}`
    if (!admitted(lang)) {
      skip(label, `${rowOf(lang).wasm} not in this checkout's engine dir (bun run scripts/vendor/fetch-grammars.ts)`)
      continue
    }
    const narrow = await found(lang, code, written)
    const wide = plain === null ? plainFinds : await found(lang, code, plain)
    check(label, same(narrow, finds) && same(wide, plainFinds), `${JSON.stringify(written)} found ${said(narrow)}${plain === null ? '' : `; ${JSON.stringify(plain)} found ${said(wide)}`}`)
  }
}

const WORDS: Row[] = [
  ['python', 'async def a(x):\n    run(x)\n\ndef b(x):\n    run(x)\n', 'async def $N($$$P):\n    $$$B', ['async def a(x):'], 'def $N($$$P):\n    $$$B', ['async def a(x):', 'def b(x):']],
  ['python', 'def a(x):\n    yield x\n\ndef b(x):\n    yield from x\n', 'yield from $X', ['yield from x'], 'yield $X', ['yield x', 'yield from x']],
  ['go', 'package p\n\nvar a chan int\nvar b <-chan int\nvar c chan<- int\n', '<-chan $T', ['<-chan int'], 'chan $T', ['chan int', '<-chan int', 'chan<- int']],
  ['rust', 'unsafe impl Send for A {}\nimpl Send for B {}\n', 'unsafe impl $T for $U {}', ['unsafe impl Send for A {}'], 'impl $T for $U {}', ['unsafe impl Send for A {}', 'impl Send for B {}']],
  ['rust', 'fn f() {\n    let k = move |y| y;\n    let l = |y| y;\n}\n', 'move |$Y| $Z', ['move |y| y'], '|$Y| $Z', ['move |y| y', '|y| y']],
  ['javascript', 'async function a(x) { run(x) }\nfunction b(x) { run(x) }\n', 'async function $N($$$P) { $$$B }', ['async function a(x) { run(x) }'], 'function $N($$$P) { $$$B }', ['async function a(x) { run(x) }', 'function b(x) { run(x) }']],
  ['javascript', 'class A {\n  a() { run() }\n  static b() { run() }\n  get c() { return 1 }\n  static async d() { run() }\n}\n', 'static $N() { $$$B }', ['static b() { run() }', 'static async d() { run() }'], '$N() { $$$B }', ['a() { run() }', 'static b() { run() }', 'get c() { return 1 }', 'static async d() { run() }']],
  ['javascript', 'class A {\n  a() { run() }\n  static b() { run() }\n  get c() { return 1 }\n  static async d() { run() }\n}\n', 'get $N() { $$$B }', ['get c() { return 1 }'], null, []],
  ['typescript', 'async function a(x: number) { run(x) }\nfunction b(x: number) { run(x) }\n', 'async function $N($$$P) { $$$B }', ['async function a(x: number) { run(x) }'], 'function $N($$$P) { $$$B }', ['async function a(x: number) { run(x) }', 'function b(x: number) { run(x) }']],
  ['typescript', 'import { a } from "x"\nimport type { b } from "y"\n', "import type { $$$N } from '$M'", ['import type { b } from "y"'], "import { $$$N } from '$M'", ['import { a } from "x"', 'import type { b } from "y"']],
  ['typescript', 'class A {\n  readonly a = 1\n  b = 2\n}\n', 'readonly $N = $V', ['readonly a = 1'], null, []],
  ['tsx', 'const a = async () => { run() }\nconst b = () => { run() }\n', 'async () => { $$$B }', ['async () => { run() }'], '() => { $$$B }', ['async () => { run() }', '() => { run() }']],
  ['bash', 'function a() { run; }\nb() { run; }\n', 'function $N() { $$$B; }', ['function a() { run; }'], '$N() { $$$B; }', ['function a() { run; }', 'b() { run; }']],
  ['c-sharp', 'class A {\n  void F() {\n    G(x);\n    G(ref x);\n    G(out x);\n  }\n}\n', 'G(ref $X)', ['G(ref x)'], 'G($X)', ['G(x)', 'G(ref x)', 'G(out x)']],
  ['c-sharp', 'class A {\n  void F() {\n    foreach (var a in b) { }\n    await foreach (var c in d) { }\n  }\n}\n', 'await foreach (var $A in $B) { }', ['await foreach (var c in d) { }'], 'foreach (var $A in $B) { }', ['foreach (var a in b) { }', 'await foreach (var c in d) { }']],
  ['cpp', 'enum class E { A };\nenum F { B };\n', 'enum class $N { $$$M }', ['enum class E { A }'], 'enum $N { $$$M }', ['enum class E { A }', 'enum F { B }']],
  ['cpp', 'template <typename T> void f(T t) {}\ntemplate <class U> void g(U u) {}\n', 'template <typename $T> void $F($T $A) {}', ['template <typename T> void f(T t) {}'], null, []],
  ['c', 'void f(int x) {\n  switch (x) {\n    case 1: a(); break;\n    default: b();\n  }\n}\n', 'default: $$$B', ['default: b();'], null, []],
  ['java', 'import java.util.List;\nimport static java.lang.Math.max;\n', 'import static $X;', ['import static java.lang.Math.max;'], 'import $X;', ['import java.util.List;', 'import static java.lang.Math.max;']],
  ['java', 'class A {\n  @Override public void d() { run(); }\n  @Override protected void e() { run(); }\n  @Override public final void f() { run(); }\n}\n', '@Override public void $N() { $$$B }', ['@Override public void d() { run(); }', '@Override public final void f() { run(); }'], '@Override void $N() { $$$B }', ['@Override public void d() { run(); }', '@Override protected void e() { run(); }', '@Override public final void f() { run(); }']],
  ['php', '<?php\n$a = [1, 2];\n$b = array(3, 4);\n', 'array($$$A)', ['array(3, 4)'], '[$$$A]', ['[1, 2]', 'array(3, 4)']],
  ['powershell', 'function a { 1 }\nfilter b { 2 }\n', 'function $N { $$$B }', ['function a { 1 }'], null, []],
  ['kotlin', 'fun f(x: Any) {\n  val c = x as? String\n  val d = x as String\n  val e = x is String\n  val g = x !is String\n}\n', '$X !is $T', ['x !is String'], null, []],
  ['swift', 'class A {\n  class func a() -> Int { return 1 }\n  func b() -> Int { return 2 }\n}\n', 'class func $N() -> $R { $$$B }', ['class func a() -> Int { return 1 }'], 'func $N() -> $R { $$$B }', ['class func a() -> Int { return 1 }', 'func b() -> Int { return 2 }']],
  ['lua', 'local function a(x) run(x) end\nfunction b(x) run(x) end\nlocal function c() end\n', 'local function $N($$$P) $$$B end', ['local function a(x) run(x) end', 'local function c() end'], 'function $N($$$P) $$$B end', ['local function a(x) run(x) end', 'function b(x) run(x) end', 'local function c() end']],
  ['make', 'include config.mk\n-include local.mk\nsinclude more.mk\n', 'include $F', ['include config.mk'], null, []],
  ['make', 'include config.mk\n-include local.mk\nsinclude more.mk\n', '-include $F', ['-include local.mk'], null, []],
  ['make', 'include config.mk\n-include local.mk\nsinclude more.mk\n', 'sinclude $F', ['sinclude more.mk'], null, []],
  ['graphql', 'directive @a on FIELD\ndirective @b repeatable on FIELD\n', 'directive @$N repeatable on FIELD', ['directive @b repeatable on FIELD'], 'directive @$N on FIELD', ['directive @a on FIELD', 'directive @b repeatable on FIELD']],
  ['protobuf', 'syntax = "proto3";\nimport "a.proto";\nimport public "b.proto";\n', 'import public $P;', ['import public "b.proto";'], 'import $P;', ['import "a.proto";', 'import public "b.proto";']],
  ['protobuf', 'syntax = "proto3";\nservice S {\n  rpc A(Q) returns (R);\n  rpc B(stream Q) returns (R);\n  rpc C(Q) returns (stream R);\n}\n', 'rpc $N(stream $Q) returns ($R);', ['rpc B(stream Q) returns (R);'], 'rpc $N($Q) returns ($R);', ['rpc A(Q) returns (R);', 'rpc B(stream Q) returns (R);', 'rpc C(Q) returns (stream R);']],
  ['protobuf', 'syntax = "proto3";\nmessage M {\n  string a = 1;\n}\nmessage N {\n  repeated string b = 1;\n}\n', 'repeated string $N = 1;', ['repeated string b = 1;'], 'string $N = 1;', ['string a = 1;', 'repeated string b = 1;']],
  ['scala', 'case class A(x: Int)\nclass B(x: Int)\n', 'case class $N($$$P)', ['case class A(x: Int)'], 'class $N($$$P)', ['case class A(x: Int)', 'class B(x: Int)']],
  ['zig', 'pub fn a(x: i32) void { run(x); }\nfn b(x: i32) void { run(x); }\nexport fn c(x: i32) void { run(x); }\ninline fn d(x: i32) void { run(x); }\n', 'pub fn $N($$$P) $R { $$$B }', ['pub fn a(x: i32) void { run(x); }'], 'fn $N($$$P) $R { $$$B }', ['pub fn a(x: i32) void { run(x); }', 'fn b(x: i32) void { run(x); }', 'export fn c(x: i32) void { run(x); }', 'inline fn d(x: i32) void { run(x); }']],
  ['zig', 'pub fn a(x: i32) void { run(x); }\nfn b(x: i32) void { run(x); }\nexport fn c(x: i32) void { run(x); }\ninline fn d(x: i32) void { run(x); }\n', 'export fn $N($$$P) $R { $$$B }', ['export fn c(x: i32) void { run(x); }'], null, []],
  ['zig', 'const a = 1;\nvar b = 2;\npub const c = 3;\n', 'pub const $N = $V;', ['pub const c = 3;'], 'const $N = $V;', ['const a = 1;', 'pub const c = 3;']],
  ['haskell', 'import Data.Map\nimport qualified Data.Map\n', 'import qualified Data.Map', ['import qualified Data.Map'], 'import Data.Map', ['import Data.Map', 'import qualified Data.Map']],
  ['ocaml', 'let rec f x = f x\nlet g x = x\n', 'let rec $F $X = $B', ['let rec f x = f x'], 'let $F $X = $B', ['let rec f x = f x', 'let g x = x']],
  ['julia', 'struct A\n  x\nend\nmutable struct B\n  x\nend\n', 'mutable struct $N $$$F end', ['mutable struct B'], 'struct $N $$$F end', ['struct A', 'mutable struct B']],
  ['fortran', 'program p\n  integer(4) :: i\n  real(4) :: r\nend program p\n', 'integer($K) :: $N', ['integer(4) :: i'], null, []],
  ['solidity', 'abstract contract A { }\ncontract B { }\n', 'abstract contract $N { $$$B }', ['abstract contract A { }'], 'contract $N { $$$B }', ['abstract contract A { }', 'contract B { }']],
  ['verilog', 'module m(input clk);\n  initial begin\n    $error("a");\n    $fatal("b");\n  end\nendmodule\n', '$fatal($$$A);', ['$fatal("b");'], null, []],
  ['emacs-lisp', '(defun a () 1)\n(defsubst c () 3)\n(let ((x 1)) x)\n(let* ((x 1)) x)\n', '(defun $N ($$$A) $$$B)', ['(defun a () 1)'], null, []],
  ['emacs-lisp', '(defun a () 1)\n(defsubst c () 3)\n(let ((x 1)) x)\n(let* ((x 1)) x)\n', '(let* ($$$A) $$$B)', ['(let* ((x 1)) x)'], null, []],
  ['tlaplus', '---- MODULE M ----\nVARIABLE x\nVARIABLES y\n====\n', 'VARIABLES $Y', ['VARIABLES y'], null, []],
  ['diff', 'diff --git a/x b/x\nnew file mode 100644\ndiff --git a/y b/y\ndeleted file mode 100644\n', 'new file mode 100644', ['new file mode 100644'], null, []],
]

const OPERATORS: Row[] = [
  ['objc', '@implementation T\n- (void)a { run(); }\n+ (void)b { run(); }\n@end\n', '- (void)$N { $$$B }', ['- (void)a { run(); }'], null, []],
  ['objc', '@implementation T\n- (void)a { run(); }\n+ (void)b { run(); }\n@end\n', '+ (void)$N { $$$B }', ['+ (void)b { run(); }'], null, []],
  ['javascript', 'class A {\n  a() { run() }\n  *b() { run() }\n}\n', '*$N() { $$$B }', ['*b() { run() }'], '$N() { $$$B }', ['a() { run() }', '*b() { run() }']],
  ['typescript', 'class A {\n  a: string\n  b?: string\n}\n', '$N?: $T', ['b?: string'], null, []],
  ['css', 'a[href="x"] { color: red; }\na[href^="x"] { color: red; }\n', 'a[href^="x"] { $$$D }', ['a[href^="x"] { color: red; }'], null, []],
  ['bash', 'run && ok\nrun || fail\n', '$A && $B', ['run && ok'], null, []],
  ['bash', 'a=$(date)\nb=`date`\n', '$(date)', ['$(date)'], '`date`', ['$(date)', '`date`']],
  ['bash', 'echo a > f\necho b >> f\n', 'echo $A >> $F', ['echo b >> f'], null, []],
  ['rust', 'fn f() {\n    let d = -x;\n    let e = !x;\n    let g = 1..2;\n    let h = 1..=2;\n}\n', '-$X', ['-x'], null, []],
  ['rust', 'fn f() {\n    let d = -x;\n    let e = !x;\n    let g = 1..2;\n    let h = 1..=2;\n}\n', '$A..=$B', ['1..=2'], null, []],
  ['go', 'package p\n\nfunc f() {\n\tfor k, v := range m { run(k, v) }\n\tfor k, v = range m { run(k, v) }\n}\n', 'for $K, $V := range $M { $$$B }', ['for k, v := range m { run(k, v) }'], null, []],
  ['kotlin', 'fun f(a: A?) {\n  val x = a.b\n  val y = a?.b\n}\n', '$A?.b', ['a?.b'], null, []],
  ['erlang', '-module(m).\nf(A, B) -> A andalso B.\ng(A, B) -> A orelse B.\nh(A, B) -> A + B.\n', '$A andalso $B', ['A andalso B'], null, []],
  ['erlang', '-module(m).\nf(A, B) -> A andalso B.\ng(A, B) -> A orelse B.\nh(A, B) -> A + B.\n', '$A + $B', ['A + B'], null, []],
  ['hcl', 'c = x && y\nd = x || y\n', '$A || $B', ['x || y'], null, []],
  ['fortran', 'program p\n  integer :: i\n  integer j\nend program p\n', 'integer :: $N', ['integer :: i'], 'integer $N', ['integer :: i', 'integer j']],
  ['regex', 'x(?=a)y(?!a)z', '(?!a)', ['(?!a)'], null, []],
]

const PLACES: Row[] = [
  ['go', 'package p\n\nvar a chan int\nvar b <-chan int\nvar c chan<- int\n', 'chan<- $T', ['chan<- int'], null, []],
  ['javascript', 'class A {\n  static async a() { run() }\n  async b() { run() }\n  static c() { run() }\n}\n', 'static async $N() { $$$B }', ['static async a() { run() }'], 'async $N() { $$$B }', ['static async a() { run() }', 'async b() { run() }']],
  ['lua', 'local function a() end\nfunction b() end\n', 'local function $N($$$P) $$$B end', ['local function a() end'], 'function $N($$$P) $$$B end', ['local function a() end', 'function b() end']],
  ['rust', 'fn f() {\n    println!("{}", a + b);\n    println!("{}", a - b);\n}\n', 'println!("{}", $A + $B)', ['println!("{}", a + b)'], 'println!($$$T)', ['println!("{}", a + b)', 'println!("{}", a - b)']],
]

const KEPT: Row[] = [
  ['javascript', 'const a = "hello"\nconst b = \'hello\'\n', '"hello"', ['"hello"', "'hello'"], "'hello'", ['"hello"', "'hello'"]],
  ['javascript', 'foo(1)\nfoo(2);\n', 'foo($A);', ['foo(1)', 'foo(2);'], 'foo($A)', ['foo(1)', 'foo(2)']],
  ['javascript', 'bar(1, 2,)\nbar(3, 4)\nbaz(x)\n', 'bar($A, $B,)', ['bar(1, 2,)', 'bar(3, 4)'], 'baz($$$A, $B)', ['baz(x)']],
  ['rust', 'fn f() {\n    let a = vec![1, 2];\n    let b = vec!(1, 2);\n    let c = vec!{1, 2};\n}\n', 'vec![$$$A]', ['vec![1, 2]', 'vec!(1, 2)', 'vec!{1, 2}'], 'vec!($$$A)', ['vec![1, 2]', 'vec!(1, 2)', 'vec!{1, 2}']],
  ['ruby', 'foo(1)\nfoo 2\ny = %w(a b)\nz = %w[a b]\n', 'foo($A)', ['foo(1)', 'foo 2'], '%w($$$A)', ['%w(a b)', '%w[a b]']],
  ['lua', 'f("a")\nf "a"\n', 'f($A)', ['f("a")', 'f "a"'], 'f $A', ['f("a")', 'f "a"']],
  ['elixir', 'foo(1)\nfoo 2\n', 'foo($A)', ['foo(1)', 'foo 2'], 'foo $A', ['foo(1)', 'foo 2']],
  ['python', 'print("a")\nprint(\'a\')\n', 'print("a")', ['print("a")'], "print('a')", ["print('a')"]],
  ['java', 'class A {\n  public void a() { run(); }\n  public static void b() { run(); }\n  void c() { run(); }\n}\n', 'public void $N() { $$$B }', ['public void a() { run(); }'], 'void $N() { $$$B }', ['void c() { run(); }']],
  ['c-sharp', 'class A {\n  public void a() { Run(); }\n  public static void b() { Run(); }\n  void c() { Run(); }\n}\n', 'public void $N() { $$$B }', ['public void a() { Run(); }'], 'void $N() { $$$B }', ['void c() { Run(); }']],
  ['rust', 'pub fn a(x: i32) { run(x); }\nfn b(x: i32) { run(x); }\nasync fn c(x: i32) { run(x); }\n', 'pub fn $N($$$P) { $$$B }', ['pub fn a(x: i32) { run(x); }'], 'fn $N($$$P) { $$$B }', ['fn b(x: i32) { run(x); }']],
  ['fortran', 'program p\n  call f(a, &\n         b)\n  call f(c, d)\nend program p\n', 'call f($A, $B)', ['call f(a, &', 'call f(c, d)'], null, []],
  ['sql', 'SELECT a FROM t;\nSELECT DISTINCT c FROM v;\n', 'SELECT $A FROM $T', ['SELECT a FROM t'], 'SELECT DISTINCT $A FROM $T', ['SELECT DISTINCT c FROM v']],
  ['yaml', 'a: 1\nb: 2\n', 'a: $V', ['a: 1'], '$K: 2', ['b: 2']],
  ['json', '{"a": [1, 2], "b": []}\n', '[$$$ITEMS]', ['[1, 2]', '[]'], null, []],
  ['toml', 'a = 1\nb = "x"\n', 'a = $V', ['a = 1'], null, []],
  ['css', 'a { color: red; }\nb { color: blue; margin: 0; }\n', 'color: $V;', ['color: red;', 'color: blue;'], '$SEL { $$$DECLS }', ['a { color: red; }', 'b { color: blue; margin: 0; }']],
  ['html', '<p class="a">x</p>\n<p>y</p>\n', '<p>y</p>', ['<p>y</p>'], null, []],
  ['clojure', '(defn a [x] (inc x))\n(defn- b [x] (dec x))\n', '(defn $NAME [$$$ARGS] $$$BODY)', ['(defn a [x] (inc x))'], null, []],
  ['nix', '{ a = 1; inherit b; inherit (c) d; }\n', 'inherit $X;', ['inherit b;'], 'inherit ($S) $X;', ['inherit (c) d;']],
  ['r', 'f <- function(x) x + 1\ng <- \\(x) x + 1\n', 'function($$$A) $B', ['function(x) x + 1'], '\\($$$A) $B', ['\\(x) x + 1']],
  ['starlark', 'def a(x):\n    return x\n', 'def $NAME($$$ARGS):\n    $$$BODY', ['def a(x):'], null, []],
  ['dockerfile', 'FROM x\nRUN one\nRUN two three\n', 'RUN $$$CMD', ['RUN one', 'RUN two three'], null, []],
  ['cmake', 'set(A 1)\nmessage(STATUS "x")\n', 'set($$$ARGS)', ['set(A 1)'], null, []],
  ['xml', '<r><item a="1">x</item><item>y</item></r>\n', '<item $$$ATTRS>$T</item>', ['<item a="1">x</item>', '<item>y</item>'], null, []],
  ['just', 'export FOO := "x"\nBAR := "y"\n', 'export $N := $V', ['export FOO := "x"'], '$N := $V', ['FOO := "x"', 'BAR := "y"']],
  ['odin', 'package p\nf :: proc() { x := a + b; y := a - b }\n', '$A + $B', ['a + b'], '$A - $B', ['a - b']],
  ['dart', 'void f(Object o) { if (o is String) {} if (o is! String) {} }\n', '$O is $T', ['o is String'], '$O is! $T', ['o is! String']],
  ['markdown', '# A\n\n## B\n\n## C\n', '## $TITLE', ['## B', '## C'], null, []],
  ['ini', '[s]\na = 1\nb = 2\n', 'a = $V', ['a = 1'], null, []],
  ['vue', '<template>\n  <p class="a">x</p>\n</template>\n', '<p class="a">x</p>', ['<p class="a">x</p>'], null, []],
  ['svelte', '{#if ok}<p>a</p>{/if}\n', '{#if $COND}$$$BODY{/if}', ['{#if ok}<p>a</p>{/if}'], null, []],
  ['astro', '---\nconst a = 1\n---\n<ul><li>a</li></ul>\n', '<ul>$$$ITEMS</ul>', ['<ul><li>a</li></ul>'], null, []],
]

section('§1 — a word the pattern writes is in the code it finds, and the pattern without it finds the rest too')
await table(WORDS)

section('§2 — an operator the pattern writes, the same')
await table(OPERATORS)

section('§3 — in its place and its order, and beside a list that holds nothing')
await table(PLACES)

section('§4 — what was passed over still is: quotes, brackets, commas, a semicolon, the parentheses of a call, what the code has beyond the pattern, and a node made only of words is compared whole')
await table(KEPT)

const listed = new Set([...WORDS, ...OPERATORS, ...PLACES, ...KEPT].map(row => row[0]))
check(`every one of the ${registry.length} languages has a row above`, registry.every(row => listed.has(row.name)), registry.filter(row => !listed.has(row.name)).map(row => row.name).join(','))

put('ts/app.ts', 'async function fetched(a: number) { return a }\r\nfunction plain(b: number) { return b }\r\n')
put('zig/app.zig', 'pub fn shown(a: i32) i32 { return a; }\nfn hidden(b: i32) i32 { return b; }\n')
await enterRoot(root)
const prover = await makeContext([AstSearchTool, AstEditTool], { mode: 'sovereign' })
const search = (input: Record<string, unknown>) => drive(AstSearchTool, input, prover)
const edit = (input: Record<string, unknown>) => drive(AstEditTool, input, prover)

section('§5 — through both tools')
{
  const narrow = await search({ pattern: 'async function $N($$$A) { $$$B }', path: 'ts' })
  check('AstSearch: the pattern with async finds the async function alone, in a file saved with CRLF', !narrow.isError && narrow.text.includes('\n1 match in 1 file.') && narrow.text.includes('$N = fetched'), narrow.text)
  const wide = await search({ pattern: 'function $N($$$A) { $$$B }', path: 'ts' })
  check('AstSearch: the pattern without it finds both', !wide.isError && wide.text.includes('\n2 matches in 1 file.'), wide.text)
  const counted = await search({ pattern: 'async function $N($$$A) { $$$B }', path: 'ts', mode: 'count' })
  check('AstSearch: and counts one', !counted.isError && /\b1 match\b/.test(counted.text) && !/\b2 matches\b/.test(counted.text), counted.text)
  const kept = await edit({ pattern: 'async function $N($$$A) { $$$B }', rewrite: 'async function $N($$$A) { log(); $$$B }', path: 'ts' })
  check('AstEdit: a rewrite through the pattern with async changes the async function alone', !kept.isError && kept.text.includes('Dry run — 1 match in 1 file would change') && kept.text.includes('+async function fetched(a: number) { log(); return a }') && !kept.text.includes('plain(b: number) { log();'), kept.text)
  const before = readFileSync(join(root, 'ts/app.ts'), 'utf8')
  const plan = /plan: (ae-[a-f0-9]+)/.exec(kept.text)?.[1] ?? ''
  const applied = await edit({ pattern: 'async function $N($$$A) { $$$B }', rewrite: 'async function $N($$$A) { log(); $$$B }', path: 'ts', apply: true, plan })
  check('AstEdit: applied, the other function is as it was, byte for byte', !applied.isError && readFileSync(join(root, 'ts/app.ts'), 'utf8') === before.replace('{ return a }', '{ log(); return a }'), applied.text)
  if (!admitted('zig')) {
    skip('zig: pub through AstEdit', `${rowOf('zig').wasm} not in this checkout's engine dir (bun run scripts/vendor/fetch-grammars.ts)`)
  } else {
    const shown = await edit({ pattern: 'pub fn $N($$$A) $R { $$$B }', rewrite: 'pub fn $N($$$A) $R { log(); $$$B }', path: 'zig' })
    check('AstEdit: a Zig rewrite through the pattern with pub changes the pub function alone and keeps pub', !shown.isError && shown.text.includes('Dry run — 1 match in 1 file would change') && shown.text.includes('+pub fn shown(a: i32) i32 { log(); return a; }') && !shown.text.includes('hidden(b: i32) i32 { log();'), shown.text)
    const rules = await edit({ rules: [{ pattern: 'pub fn $N($$$A) $R { $$$B }', rewrite: 'pub fn $N($$$A) $R { seen(); $$$B }' }, { pattern: 'export fn $N($$$A) $R { $$$B }', rewrite: 'export fn $N($$$A) $R { seen(); $$$B }' }], path: 'zig' })
    check('AstEdit by rules: the rule with pub rewrites one function, and the rule with export is named as matching nothing', !rules.isError && rules.text.includes('+pub fn shown(a: i32) i32 { seen(); return a; }') && !rules.text.includes('hidden(b: i32) i32 { seen();') && rules.text.includes('Matched nothing: rule 1.'), rules.text)
  }
}

section('§6 — the page says it')
{
  const page = readFileSync(join(REPO, 'docs/STRUCTURAL-PATTERNS.md'), 'utf8').replace(/\s+/g, ' ')
  check('a word or an operator the pattern writes must be in the code', page.includes('A word or an operator a pattern writes must be in the code it finds, in the same place among the parts of its node; what the code has beyond the pattern is passed over.'))
  check('a spelling the pattern writes is the one it finds', page.includes('Where a language has two spellings for one thing, a pattern finds the one it writes'))
  check('and what is never required', page.includes('Brackets, quotes, commas and semicolons are never required'))
  check('the old sentence is gone', !page.includes('is not compared'))
}

finish('PATTERN KEYWORDS')
