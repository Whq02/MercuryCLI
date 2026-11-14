#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { armEnvironment, check, drive, enterRoot, finish, makeContext, section, skip, REPO } from './lib/harness.ts'

const { engineDir } = armEnvironment()

const { AstSearchTool } = await import(join(REPO, 'src/tools/AstSearchTool/AstSearchTool.ts'))

const root = mkdtempSync(join(tmpdir(), 'ast-dart-function-'))
const put = (file: string, text: string): void => { mkdirSync(join(root, file, '..'), { recursive: true }); writeFileSync(join(root, file), text) }
put('dart/app.dart', [
  'void main() { run(); }',
  'class Tide {',
  '  void rise(int by) { run(); }',
  '}',
  'void outer() {',
  '  void inner() { run(); }',
  '  inner();',
  '}',
  '',
].join('\n'))
put('ts/app.ts', 'function main(a: number) { run(); }\n')
await enterRoot(root)
const prover = await makeContext([AstSearchTool])
const search = (input: Record<string, unknown>) => drive(AstSearchTool, input, prover)
const SAYS = 'did not parse as dart (a function is two nodes there, its signature and its body: write the signature alone, or a statement of the body).'

if (!existsSync(join(engineDir, 'tree-sitter-dart.wasm'))) {
  skip('dart: a function with its body', 'tree-sitter-dart.wasm not in this checkout\'s engine dir (bun run scripts/vendor/fetch-grammars.ts)')
} else {
  section('§1 — a Dart function written with its body is answered in Dart\'s terms')
  {
    const whole = await search({ pattern: 'void $NAME($$$PARAMS) { $$$BODY }', path: 'dart' })
    check('a function with a body for a meta-variable is refused with what to write', whole.isError && whole.text.includes(`The pattern "void $NAME($$$PARAMS) { $$$BODY }" ${SAYS}`), whole.text)
    const literal = await search({ pattern: 'void main() { run(); }', path: 'dart' })
    check('a function written out is refused the same way, where it found a local function alone', literal.isError && literal.text.includes(`The pattern "void main() { run(); }" ${SAYS}`), literal.text)
    const local = await search({ pattern: 'void inner() { run(); }', path: 'dart' })
    check('so is a local function written out', local.isError && local.text.includes(SAYS), local.text)
  }

  section('§2 — what the sentence names is found')
  {
    const signature = await search({ pattern: 'void $NAME($$$PARAMS)', path: 'dart' })
    check('the signature alone finds every function: top level, in a class, local', !signature.isError && signature.text.includes('\n4 matches in 1 file.') && ['$NAME = main', '$NAME = rise', '$NAME = outer', '$NAME = inner'].every(name => signature.text.includes(name)), signature.text)
    check('a method\'s parameters are captured', signature.text.includes('$$$PARAMS = int by'), signature.text)
    const statement = await search({ pattern: 'run();', path: 'dart' })
    check('a statement of the body finds each body that holds it', !statement.isError && statement.text.includes('\n3 matches in 1 file.'), statement.text)
  }

  section('§3 — beside it')
  {
    const call = await search({ pattern: 'inner()', path: 'dart' })
    check('a Dart call statement is found as before', !call.isError && call.text.includes('\n1 match in 1 file.'), call.text)
    const typescript = await search({ pattern: 'function $NAME($$$ARGS) { $$$BODY }', path: 'ts' })
    check('a TypeScript function with its body is found as before', !typescript.isError && typescript.text.includes('\n1 match in 1 file.') && typescript.text.includes('$$$BODY = run();'), typescript.text)
  }
}

finish('DART FUNCTION PATTERN')
