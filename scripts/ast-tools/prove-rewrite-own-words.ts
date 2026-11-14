#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { armEnvironment, check, drive, enterRoot, finish, makeContext, section, skip, REPO } from './lib/harness.ts'

const { engineDir } = armEnvironment()

const { AstEditTool } = await import(join(REPO, 'src/tools/AstEditTool/AstEditTool.ts'))

const root = mkdtempSync(join(tmpdir(), 'ast-own-words-'))
const put = (file: string, text: string): void => { mkdirSync(join(root, file, '..'), { recursive: true }); writeFileSync(join(root, file), text) }
put('ts/app.ts', 'async function fetched(a: number) { return a }\nfunction plain(b: number) { return b }\n')
put('zig/app.zig', 'pub fn shown(a: i32) i32 { return a; }\nfn hidden(b: i32) i32 { return b; }\n')
await enterRoot(root)
const prover = await makeContext([AstEditTool], { mode: 'sovereign' })
const edit = (input: Record<string, unknown>) => drive(AstEditTool, input, prover)

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

finish('REWRITE OWN WORDS')
