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

const root = mkdtempSync(join(tmpdir(), 'ast-pattern-bodies-first-'))
const put = (file: string, text: string): void => { mkdirSync(join(root, file, '..'), { recursive: true }); writeFileSync(join(root, file), text) }
const registry = GRAMMAR_REGISTRY as Array<{ name: string; wasm: string; extensions: string[] }>
const rowOf = (lang: string) => registry.find(row => row.name === lang)!
const admitted = (lang: string): boolean => existsSync(join(engineDir, rowOf(lang).wasm))
const squash = (text: string): string => text.replace(/\s+/g, ' ').trim()

const JAVA = 'class A {\n  void none() {}\n  void one(int a) { run(a); }\n  void two(int a, int b) {\n    int c = a + b;\n    run(c);\n  }\n  A(int a) { init(a); }\n  void flow(int a) throws Exception {\n    if (a > 0) { run(a); stop(); }\n    if (a < 0) {}\n    if (a == 0) { run(0); }\n    while (a > 9) { a--; }\n    for (int i = 0; i < a; i++) { run(i); stop(); }\n    try { run(a); } catch (Exception e) { stop(); done(); }\n  }\n}\nclass B {}\nclass C { int x = 1; }\nclass D { int y = 2; void f() {} }\ninterface I { void m(); int K = 1; }\n'
const CSHARP = 'class A {\n  void Flow(int a) {\n    if (a > 0) { Run(a); Stop(); }\n    if (a < 0) {}\n    if (a == 0) { Run(0); }\n    while (a > 9) { a--; }\n    foreach (var v in xs) { Run(v); Stop(); }\n    try { Run(a); } catch (Exception e) { Stop(); Done(); }\n  }\n}\nclass B {}\nclass C { int x = 1; }\nclass D { int y = 2; void F() {} }\nstruct S { int a; int b; }\n'
const C = 'void none(void) {}\nvoid one(int a) { run(a); }\nvoid two(int a, int b) {\n  int c = a + b;\n  run(c);\n}\nint calc(int a) { return a + 1; }\nvoid flow(int a) {\n  if (a > 0) { run(a); stop(); }\n  if (a < 0) {}\n  if (a == 0) { run(0); }\n  while (a > 9) { a--; }\n  switch (a) { case 1: run(1); stop(); break; default: stop(); }\n}\n'
const CPP = 'void none() {}\nvoid one(int a) { run(a); }\nvoid two(int a, int b) {\n  int c = a + b;\n  run(c);\n}\nvoid K::out(int a) { run(a); }\nnamespace n { int g; void h() {} }\nnamespace e {}\nvoid flow(int a) {\n  if (a > 0) { run(a); stop(); }\n  if (a < 0) {}\n  try { run(a); } catch (...) { stop(); done(); }\n  try { run(a); } catch (const E& e) { stop(); }\n  std::vector<int> v = { 1, 2 };\n}\n'
const CSS = 'a { color: red; margin: 0; }\nb { color: blue; }\nc { }\n@media (min-width: 10px) { a { color: green; } b { margin: 1px; } }\n'
const JSON_TEXT = '{"none": {}, "one": {"a": 1}, "two": {"a": 1, "b": [1, 2]}}\n'

const ROWS: Array<[lang: string, file: string, pattern: string, code: string, key: string, bodies: string[]]> = [
  ['java', 'A.java', 'void $N($$$P) { $$$B }', JAVA, '$$$B', ['', 'run(a);', 'int c = a + b; run(c);', '']],
  ['java', 'A.java', 'void $N($$$P) { $$$B }', JAVA, '$$$P', ['', 'int a', 'int a, int b', '']],
  ['java', 'A.java', 'void $N($$$P) throws $E { $$$B }', JAVA, '$N', ['flow']],
  ['java', 'A.java', 'void $N(int a) { $$$B }', JAVA, '$$$B', ['run(a);']],
  ['java', 'A.java', 'A($$$P) { $$$B }', JAVA, '$$$B', ['init(a);']],
  ['java', 'A.java', 'if ($C) { $$$B }', JAVA, '$$$B', ['run(a); stop();', '', 'run(0);']],
  ['java', 'A.java', 'while ($C) { $$$B }', JAVA, '$$$B', ['a--;']],
  ['java', 'A.java', 'for (int i = 0; i < a; i++) { $$$B }', JAVA, '$$$B', ['run(i); stop();']],
  ['java', 'A.java', 'try { $$$T } catch (Exception e) { $$$B }', JAVA, '$$$B', ['stop(); done();']],
  ['java', 'A.java', 'try { $$$T } catch ($X $E) { $$$B }', JAVA, '$$$B', ['stop(); done();']],
  ['java', 'A.java', 'class $N { $$$M }', JAVA, '$N', ['A', 'B', 'C', 'D']],
  ['java', 'A.java', 'class $N { $$$M }', JAVA.slice(JAVA.indexOf('class B')), '$$$M', ['', 'int x = 1;', 'int y = 2; void f() {}']],
  ['java', 'A.java', 'interface $N { $$$M }', JAVA, '$$$M', ['void m(); int K = 1;']],
  ['c-sharp', 'A.cs', 'if ($C) { $$$B }', CSHARP, '$$$B', ['Run(a); Stop();', '', 'Run(0);']],
  ['c-sharp', 'A.cs', 'while ($C) { $$$B }', CSHARP, '$$$B', ['a--;']],
  ['c-sharp', 'A.cs', 'foreach (var $V in $XS) { $$$B }', CSHARP, '$$$B', ['Run(v); Stop();']],
  ['c-sharp', 'A.cs', 'try { $$$T } catch (Exception e) { $$$B }', CSHARP, '$$$B', ['Stop(); Done();']],
  ['c-sharp', 'A.cs', 'try { $$$T } catch ($X $E) { $$$B }', CSHARP, '$$$B', ['Stop(); Done();']],
  ['c-sharp', 'A.cs', 'class $N { $$$M }', CSHARP.slice(CSHARP.indexOf('class B')), '$$$M', ['', 'int x = 1;', 'int y = 2; void F() {}']],
  ['c-sharp', 'A.cs', 'struct $N { $$$M }', CSHARP, '$$$M', ['int a; int b;']],
  ['c', 'a.c', 'void $N($$$P) { $$$B }', C, '$$$B', ['', 'run(a);', 'int c = a + b; run(c);', 'if (a > 0) { run(a); stop(); } if (a < 0) {} if (a == 0) { run(0); } while (a > 9) { a--; } switch (a) { case 1: run(1); stop(); break; default: stop(); }']],
  ['c', 'a.c', '$R $N(int a) { $$$B }', C, '$$$B', ['run(a);', 'return a + 1;', 'if (a > 0) { run(a); stop(); } if (a < 0) {} if (a == 0) { run(0); } while (a > 9) { a--; } switch (a) { case 1: run(1); stop(); break; default: stop(); }']],
  ['c', 'a.c', 'if ($C) { $$$B }', C, '$$$B', ['run(a); stop();', '', 'run(0);']],
  ['c', 'a.c', 'while ($C) { $$$B }', C, '$$$B', ['a--;']],
  ['c', 'a.c', 'switch ($X) { $$$CASES }', C, '$$$CASES', ['case 1: run(1); stop(); break; default: stop();']],
  ['c', 'a.c', 'case 1: $$$S', C, '$$$S', ['run(1); stop(); break;']],
  ['cpp', 'a.cpp', 'void $N($$$P) { $$$B }', CPP.slice(0, CPP.indexOf('void K::')), '$$$B', ['', 'run(a);', 'int c = a + b; run(c);']],
  ['cpp', 'a.cpp', 'void K::$N($$$P) { $$$B }', CPP, '$$$B', ['run(a);']],
  ['cpp', 'a.cpp', 'if ($C) { $$$B }', CPP, '$$$B', ['run(a); stop();', '']],
  ['cpp', 'a.cpp', 'try { $$$T } catch (...) { $$$B }', CPP, '$$$B', ['stop(); done();']],
  ['cpp', 'a.cpp', 'try { $$$T } catch ($X) { $$$B }', CPP, '$$$B', ['stop();']],
  ['cpp', 'a.cpp', 'namespace $N { $$$D }', CPP, '$$$D', ['int g; void h() {}', '']],
  ['css', 'a.css', '$SEL { $$$DECLS }', CSS.slice(0, CSS.indexOf('@media')), '$$$DECLS', ['color: red; margin: 0;', 'color: blue;', '']],
  ['css', 'a.css', 'a { $$$DECLS }', CSS, '$$$DECLS', ['color: red; margin: 0;', 'color: green;']],
  ['css', 'a.css', '@media $Q { $$$RULES }', CSS, '$$$RULES', ['a { color: green; } b { margin: 1px; }']],
  ['css', 'a.css', 'a { color: $V; $$$REST }', CSS, '$$$REST', ['margin: 0;', '']],
  ['json', 'a.json', '{ $$$PAIRS }', JSON_TEXT, '$$$PAIRS', ['"none": {}, "one": {"a": 1}, "two": {"a": 1, "b": [1, 2]}', '', '"a": 1', '"a": 1, "b": [1, 2]']],
]

section('§1 — a body or a list of members written as one meta-variable holds none, one and several, with LF and with CRLF')
{
  let index = 0
  for (const [lang, file, pattern, code, key, bodies] of ROWS) {
    const label = `${lang}: ${JSON.stringify(pattern)} holds ${key} ${bodies.map(body => (body === '' ? 'none' : JSON.stringify(body.length > 40 ? `${body.slice(0, 37)}…` : body))).join(', ')}`
    if (!admitted(lang)) {
      skip(label, `${rowOf(lang).wasm} not in this checkout's engine dir`)
      continue
    }
    const read: string[] = []
    for (const [ending, text] of [['lf', code], ['crlf', code.replace(/\n/g, '\r\n')]] as const) {
      const at = `rows/${index}/${ending}/${file}`
      put(at, text)
      const scope = resolveAstScope({ cwd: root, path: at })
      if (isAstRefusal(scope)) throw new Error(scope.refused)
      const result = await searchAstPattern(scope, { pattern })
      const refused = isAstRefusal(result) ? result.refused : result.patternRefusals[0]?.note
      const found = isAstRefusal(result) ? [] : (result.matches as Array<{ captures: Array<{ key: string; text: string }> }>).map(match => squash(match.captures.find(capture => capture.key === key)?.text ?? `no ${key}`))
      read.push(refused ? `${ending} refused: ${refused}` : JSON.stringify(found) === JSON.stringify(bodies) ? '' : `${ending}: ${JSON.stringify(found)}`)
    }
    index++
    check(label, read.every(line => line === ''), read.filter(line => line !== '').join(' · '))
  }
}

put('java/A.java', JAVA.replace(/\n/g, '\r\n'))
put('cpp/a.cpp', CPP)
put('cs/A.cs', 'class A {\n  void Flow() {\n    var xs = new List<int> { 1, 2 };\n    if (ok) { Run(); }\n    try { Run(); } catch (Exception e) { Stop(); }\n  }\n}\n')
put('css/a.css', CSS)
put('ts/a.ts', 'function none() {}\nfunction one(a: number) { run(a) }\n')
await enterRoot(root)
const prover = await makeContext([AstSearchTool, AstEditTool], { mode: 'sovereign' })
const search = (input: Record<string, unknown>) => drive(AstSearchTool, input, prover)
const edit = (input: Record<string, unknown>) => drive(AstEditTool, input, prover)

if (!admitted('java') || !admitted('cpp') || !admitted('c-sharp') || !admitted('css')) {
  skip('java, cpp, c-sharp, css: the tools\' own answers', 'their grammars are not in this checkout\'s engine dir')
} else {
  section('§2 — through AstSearch and AstEdit, on a Java file saved with CRLF')
  {
    const methods = await search({ pattern: 'void $NAME($$$PARAMS) { $$$BODY }', path: 'java' })
    check('a Java method is found by a pattern whose parameters and body are meta-variables: each of the four that declare no exception', !methods.isError && methods.text.includes('\n4 matches in 1 file.'), methods.text)
    check('with its parameters and its body captured', methods.text.includes('$NAME = one · $$$PARAMS = int a · $$$BODY = run(a);') && methods.text.includes('$NAME = none · $$$PARAMS =  · $$$BODY = \n'), methods.text)
    const before = readFileSync(join(root, 'java/A.java'), 'utf8')
    const rename = await edit({ pattern: 'void two($$$P) { $$$B }', rewrite: 'void renamed($$$P) { $$$B }', path: 'java' })
    check('a rename changes the one line that holds the name', !rename.isError && rename.text.includes('-  void two(int a, int b) {\r\n+  void renamed(int a, int b) {\r\n     int c = a + b;\r\n     run(c);'), rename.text)
    const plan = /plan: (ae-[a-f0-9]+)/.exec(rename.text)?.[1] ?? ''
    const applied = await edit({ pattern: 'void two($$$P) { $$$B }', rewrite: 'void renamed($$$P) { $$$B }', path: 'java', apply: true, plan })
    check('applied, the file differs by that name alone and keeps its line endings', !applied.isError && readFileSync(join(root, 'java/A.java'), 'utf8') === before.replace('void two(', 'void renamed('), applied.text)
    const rule = await edit({ pattern: 'b { $$$D }', rewrite: 'b { display: block; $$$D }', path: 'css' })
    check('a declaration written before a CSS rule\'s list is added before it, in each rule of that selector', !rule.isError && rule.text.includes('+b { display: block; color: blue; }') && rule.text.includes('display: block; margin: 1px;'), rule.text)
  }

  section('§3 — what read otherwise before reads as it did')
  {
    const list = await search({ pattern: '{ $$$A }', path: 'cpp' })
    check('C++: braces written alone are still the initializer list', !list.isError && list.text.includes('[initializer_list]') && list.text.includes('$$$A = 1, 2') && list.text.includes('\n1 match in 1 file.'), list.text)
    const initializer = await search({ pattern: '{ $$$A }', path: 'cs' })
    check('C#: braces written alone are still no block', !initializer.text.includes('[block]'), initializer.text)
    const typescript = await search({ pattern: 'function $N($$$P) { $$$B }', path: 'ts' })
    check('TypeScript: a function with its body is found as before', !typescript.isError && typescript.text.includes('\n2 matches in 1 file.'), typescript.text)
  }

  section('§4 — a clause written alone is refused as it was, never read as a declaration of that name')
  {
    const handler = await search({ pattern: 'catch (Exception e) { $$$B }', path: 'java' })
    check('Java: a catch clause alone', handler.isError && handler.text.includes('did not parse as java ('), handler.text)
    const otherwise = await search({ pattern: 'else { $$$B }', path: 'java' })
    check('Java: an else alone', otherwise.isError && otherwise.text.includes('did not parse as java ('), otherwise.text)
    const sharp = await search({ pattern: 'catch (Exception e) { $$$B }', path: 'cs' })
    check('C#: a catch clause alone', sharp.isError && sharp.text.includes('did not parse as c-sharp ('), sharp.text)
    const header = await search({ pattern: 'for ($$$H) { $$$B }', path: 'java' })
    check('Java: a for whose header is one meta-variable', header.isError && header.text.includes('did not parse as java ('), header.text)
    const ellipsis = await search({ pattern: 'catch (...) { $$$B }', path: 'cpp' })
    check('C++: a catch clause alone', ellipsis.isError && ellipsis.text.includes('did not parse as cpp ('), ellipsis.text)
  }
}

finish('PATTERN BODIES, THE FIRST LANGUAGES')
