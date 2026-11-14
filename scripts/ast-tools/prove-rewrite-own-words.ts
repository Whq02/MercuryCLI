#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { armEnvironment, check, drive, enterRoot, finish, makeContext, section, skip, REPO } from './lib/harness.ts'

const { engineDir } = armEnvironment()

const { AstEditTool } = await import(join(REPO, 'src/tools/AstEditTool/AstEditTool.ts'))
const { AstSearchTool } = await import(join(REPO, 'src/tools/AstSearchTool/AstSearchTool.ts'))

const root = mkdtempSync(join(tmpdir(), 'ast-own-words-'))
const put = (file: string, text: string): void => { mkdirSync(join(root, file, '..'), { recursive: true }); writeFileSync(join(root, file), text) }
put('ts/app.ts', 'async function fetched(a: number) { return a }\nfunction plain(b: number) { return b }\n')
put('zig/app.zig', 'pub fn shown(a: i32) i32 { return a; }\nfn hidden(b: i32) i32 { return b; }\n')
put('modifiers/A.java', 'class A {\n  public void shown() { run(); }\n  void plain() { run(); }\n}\n')
put('modifiers/A.cs', 'class A {\n  public void Shown() { Run(); }\n  void Plain() { Run(); }\n}\n')
put('modifiers/a.kt', 'private fun shown(x: Int) { run(x) }\nfun plain(x: Int) { run(x) }\n')
put('modifiers/a.swift', 'private func shown(x: Int) { run(x) }\nfunc plain(x: Int) { run(x) }\n')
put('modifiers/a.rs', 'pub fn shown(x: i32) { run(x); }\nfn plain(x: i32) { run(x); }\n')
await enterRoot(root)
const prover = await makeContext([AstEditTool, AstSearchTool], { mode: 'sovereign' })
const edit = (input: Record<string, unknown>) => drive(AstEditTool, input, prover)
const search = (input: Record<string, unknown>) => drive(AstSearchTool, input, prover)

section('§1 — the page says it')
{
  const page = readFileSync(join(REPO, 'docs/STRUCTURAL-PATTERNS.md'), 'utf8').replace(/\s+/g, ' ')
  check('the AstEdit section says a keyword the pattern does not name is not kept', page.includes('A rewrite of a whole declaration writes the rewrite\'s own words: a keyword the pattern does not name is not kept, so read the diff.'))
  check('beside the sentence that such a keyword is not compared', page.includes('a keyword a grammar keeps as an unnamed token is not compared'))
}

section('§2 — and the diff of a dry run shows it')
{
  const dropped = await edit({ pattern: 'function $N($$$A) { $$$B }', rewrite: 'function $N($$$A) { log(); $$$B }', path: 'ts' })
  check('a pattern without async finds the async function too', !dropped.isError && dropped.text.includes('Dry run — 2 matches in 1 file would change'), dropped.text)
  check('its rewrite is written without async, and both lines are in the diff', dropped.text.includes('-async function fetched(a: number) { return a }') && dropped.text.includes('+function fetched(a: number) { log(); return a }'), dropped.text)
  const added = await edit({ pattern: 'async function $N($$$A) { $$$B }', rewrite: 'async function $N($$$A) { log(); $$$B }', path: 'ts' })
  check('a rewrite that names async writes it on the function that had none', !added.isError && added.text.includes('-function plain(b: number) { return b }') && added.text.includes('+async function plain(b: number) { log(); return b }'), added.text)
  check('and keeps it where it was', added.text.includes('+async function fetched(a: number) { log(); return a }'), added.text)
}

if (!existsSync(join(engineDir, 'tree-sitter-zig.wasm'))) {
  skip('zig: pub', 'tree-sitter-zig.wasm not in this checkout\'s engine dir (bun run scripts/vendor/fetch-grammars.ts)')
} else {
  section('§3 — in a language admitted for patterns alone')
  {
    const dropped = await edit({ pattern: 'fn $N($$$A) $R { $$$B }', rewrite: 'fn $N($$$A) $R { log(); $$$B }', path: 'zig' })
    check('a Zig rewrite through a pattern without pub writes the function without it, in the diff', !dropped.isError && dropped.text.includes('-pub fn shown(a: i32) i32 { return a; }') && dropped.text.includes('+fn shown(a: i32) i32 { log(); return a; }'), dropped.text)
  }
}

section('§4 — a modifier that is a node of its own is part of the pattern')
{
  const page = readFileSync(join(REPO, 'docs/STRUCTURAL-PATTERNS.md'), 'utf8').replace(/\s+/g, ' ')
  check('the page says it beside the unnamed keywords', page.includes('Where a modifier is a node of its own (Java, C#, Kotlin, Swift, Rust) it is part of the pattern: `void $N() { … }` finds only a method written without one, and `public void $N() { … }` the public ones.'))
  for (const [lang, file, bare, written] of [
    ['java', 'A.java', 'void $N() { $$$B }', 'public void $N() { $$$B }'],
    ['c-sharp', 'A.cs', 'void $N() { $$$B }', 'public void $N() { $$$B }'],
    ['kotlin', 'a.kt', 'fun $N(x: Int) { $$$B }', 'private fun $N(x: Int) { $$$B }'],
    ['swift', 'a.swift', 'func $N(x: Int) { $$$B }', 'private func $N(x: Int) { $$$B }'],
    ['rust', 'a.rs', 'fn $N($$$P) { $$$B }', 'pub fn $N($$$P) { $$$B }'],
  ] as const) {
    const without = await search({ pattern: bare, path: `modifiers/${file}` })
    const withIt = await search({ pattern: written, path: `modifiers/${file}` })
    const names = (text: string): string => [...text.matchAll(/\$N = (\w+)/g)].map(found => found[1]).join(',')
    check(`${lang}: the pattern without the modifier finds the one written without it`, !without.isError && names(without.text).toLowerCase() === 'plain', without.text)
    check(`${lang}: the pattern with the modifier finds the one that has it`, !withIt.isError && names(withIt.text).toLowerCase() === 'shown', withIt.text)
  }
}

finish('REWRITE OWN WORDS')
