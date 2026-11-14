#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { armEnvironment, check, drive, enterRoot, finish, makeContext, section, skip, REPO } from './lib/harness.ts'

const { engineDir } = armEnvironment()

const { AstSearchTool } = await import(join(REPO, 'src/tools/AstSearchTool/AstSearchTool.ts'))
const { AstEditTool } = await import(join(REPO, 'src/tools/AstEditTool/AstEditTool.ts'))
const { resolveAstScope, searchAstPattern, isAstRefusal } = await import(join(REPO, 'src/utils/astPatterns.ts'))

const root = mkdtempSync(join(tmpdir(), 'ast-csharp-function-'))
const put = (file: string, text: string): void => { mkdirSync(join(root, file, '..'), { recursive: true }); writeFileSync(join(root, file), text) }
const SOURCE = [
  'using System;',
  'class A {',
  '  int count = 0;',
  '  void None() {}',
  '  void One(int a) { Run(a); }',
  '  public void Pub(int a) { Run(a); Stop(); }',
  '  public static async Task<int> Gen<T>(int a) where T : class { return 1; }',
  '  int Calc(int a) => a + 1;',
  '  [Obsolete]',
  '  void Old() {}',
  '  void IFace.Explicit() {}',
  '  void Outer() {',
  '    int local = 1;',
  '    void Local() { Run(1); }',
  '    Local();',
  '  }',
  '  A() { Init(); }',
  '}',
  'struct S { void InStruct() { Run(2); } }',
  'interface I { void Declared(); void WithBody() { Run(3); } }',
  'record R { void InRecord() {} }',
  '',
]
const KIND: Record<string, string> = { method_declaration: 'method', local_function_statement: 'local' }
const ROWS: Array<[pattern: string, found: string[]]> = [
  ['void None() {}', ['method None']],
  ['void One(int a) { Run(a); }', ['method One']],
  ['void $N() { $$$B }', ['method None', 'method Outer', 'local Local', 'method InStruct', 'method WithBody', 'method InRecord']],
  ['void $N($$$P) { $$$B }', ['method None', 'method One', 'method Outer', 'local Local', 'method InStruct', 'method WithBody', 'method InRecord']],
  ['public void $N($$$P) { $$$B }', ['method Pub']],
  ['public static async Task<int> $N<$T>($$$P) where $T : class { $$$B }', ['method Gen']],
  ['int $N($$$P) => $E;', ['method Calc']],
  ['[Obsolete]\nvoid $N() { $$$B }', ['method Old']],
  ['void $N();', ['method Declared']],
  ['void Local() { Run(1); }', ['local Local']],
  ['void IFace.$N() { $$$B }', ['method Explicit']],
  ['A() { $$$B }', ['constructor_declaration A']],
  ['int $X = $V;', ['local_declaration_statement local']],
]

if (!existsSync(join(engineDir, 'tree-sitter-c-sharp.wasm'))) {
  skip('c-sharp: a function written alone', 'tree-sitter-c-sharp.wasm not in this checkout\'s engine dir')
} else {
  section('§1 — a C# function written alone finds a method of a class, a struct, an interface or a record, and a local function')
  for (const [pattern, found] of ROWS) {
    const read: string[] = []
    for (const [ending, text] of [['lf', SOURCE.join('\n')], ['crlf', SOURCE.join('\r\n')]] as const) {
      put(`rows/${ending}/A.cs`, text)
      const scope = resolveAstScope({ cwd: root, path: `rows/${ending}/A.cs` })
      if (isAstRefusal(scope)) throw new Error(scope.refused)
      const result = await searchAstPattern(scope, { pattern })
      const refused = isAstRefusal(result) ? result.refused : result.patternRefusals[0]?.note
      const names = isAstRefusal(result) ? [] : (result.matches as Array<{ nodeType: string; text: string; captures: Array<{ key: string; text: string }> }>).map(match => `${KIND[match.nodeType] ?? match.nodeType} ${match.captures.find(capture => capture.key === '$N' || capture.key === '$X')?.text ?? /(\w+)\(/.exec(match.text)?.[1] ?? '?'}`)
      read.push(refused ? `${ending} refused: ${refused}` : JSON.stringify(names) === JSON.stringify(found) ? '' : `${ending}: ${JSON.stringify(names)}`)
    }
    check(`${JSON.stringify(pattern)} finds ${found.join(', ')}`, read.every(line => line === ''), read.filter(line => line !== '').join(' · '))
  }

  put('door/A.cs', SOURCE.join('\r\n'))
  put('ts/a.ts', 'class A { none() {} }\nfunction none() {}\n')
  await enterRoot(root)
  const prover = await makeContext([AstSearchTool, AstEditTool], { mode: 'sovereign' })
  const search = (input: Record<string, unknown>) => drive(AstSearchTool, input, prover)
  const edit = (input: Record<string, unknown>) => drive(AstEditTool, input, prover)

  section('§2 — through AstSearch and AstEdit on a file saved with CRLF')
  {
    const found = await search({ pattern: 'void $NAME($$$PARAMS) { $$$BODY }', path: 'door' })
    check('the answer names each match by the node it is', !found.isError && found.text.includes('A.cs:5:3 [method_declaration]') && found.text.includes('A.cs:14:5 [local_function_statement]') && found.text.includes('\n7 matches in 1 file.'), found.text)
    check('with the method\'s parameters and body captured', found.text.includes('$NAME = One · $$$PARAMS = int a · $$$BODY = Run(a);'), found.text)
    const before = readFileSync(join(root, 'door/A.cs'), 'utf8')
    const rename = await edit({ pattern: 'void One($$$P) { $$$B }', rewrite: 'void Renamed($$$P) { $$$B }', path: 'door' })
    check('a method renamed changes the one line that holds its name', !rename.isError && rename.text.includes('-  void One(int a) { Run(a); }\r\n+  void Renamed(int a) { Run(a); }\r\n') && rename.text.includes('Dry run — 1 match in 1 file would change'), rename.text)
    const plan = /plan: (ae-[a-f0-9]+)/.exec(rename.text)?.[1] ?? ''
    const applied = await edit({ pattern: 'void One($$$P) { $$$B }', rewrite: 'void Renamed($$$P) { $$$B }', path: 'door', apply: true, plan })
    check('applied, the file differs by that name alone and keeps its line endings', !applied.isError && readFileSync(join(root, 'door/A.cs'), 'utf8') === before.replace('void One(', 'void Renamed('), applied.text)
    const added = await edit({ pattern: 'public void $N($$$P) { $$$B }', rewrite: 'public void $N($$$P) { Log(); $$$B }', path: 'door' })
    check('a statement added before a method\'s body is planned, so the rewritten file parses', !added.isError && added.text.includes('+  public void Pub(int a) { Log(); Run(a); Stop(); }'), added.text)
    const second = /plan: (ae-[a-f0-9]+)/.exec(added.text)?.[1] ?? ''
    const written = await edit({ pattern: 'public void $N($$$P) { $$$B }', rewrite: 'public void $N($$$P) { Log(); $$$B }', path: 'door', apply: true, plan: second })
    const again = await search({ pattern: 'public void Pub($$$P) { Log(); $$$B }', path: 'door' })
    check('and the method it wrote is found as a method again', !written.isError && !again.isError && again.text.includes('[method_declaration]') && again.text.includes('$$$B = Run(a); Stop();'), `${written.text}\n${again.text}`)
  }

  section('§3 — beside it')
  {
    const local = await search({ pattern: 'int $X = $V;', path: 'door' })
    check('a declaration written alone is the local declaration it was: the field beside it is not found', !local.isError && local.text.includes('[local_declaration_statement]') && local.text.includes('$X = local') && !local.text.includes('$X = count') && local.text.includes('\n1 match in 1 file.'), local.text)
    const typescript = await search({ pattern: 'function none() {}', path: 'ts' })
    check('a TypeScript function written alone finds the function and not the method, as it did', !typescript.isError && typescript.text.includes('a.ts:2:1 [function_declaration]') && typescript.text.includes('\n1 match in 1 file.'), typescript.text)
  }
}

finish('C# FUNCTION PATTERN')
