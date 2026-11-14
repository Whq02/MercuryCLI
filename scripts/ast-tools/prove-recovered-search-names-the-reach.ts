#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { armEnvironment, check, drive, enterRoot, finish, makeContext, section, REPO } from './lib/harness.ts'

armEnvironment()

const { AstSearchTool } = await import(join(REPO, 'src/tools/AstSearchTool/AstSearchTool.ts'))

const root = mkdtempSync(join(tmpdir(), 'ast-reach-'))
const inside = 'function outer( {\n  needle(1);\n  const x = needle(2)\n}\nneedle(3);\n'
mkdirSync(join(root, 'reach'))
writeFileSync(join(root, 'reach', 'inside.ts'), inside)
writeFileSync(join(root, 'reach', 'nine.ts'), Array.from({ length: 9 }, (_, i) => `const broken${i} = ;`).join('\n') + '\nneedle(9);\n')
writeFileSync(join(root, 'reach', 'paren.ts'), 'const a = needle(4;\nconst b = needle(5);\n')
writeFileSync(join(root, 'reach', 'clean.ts'), 'const first = needle(1);\nconst second = needle(2);\n')
await enterRoot(root)
const prover = await makeContext([AstSearchTool])
const search = (file: string) => drive(AstSearchTool, { pattern: 'needle($X)', path: `reach/${file}` }, prover)
const TWO_RISKS = 'Matches may include parser recovery; code inside a syntax error may go unmatched.'
const recovered = (text: string): string => text.split('\n').find(line => line.startsWith('Searched recovered tree:')) ?? ''

section('§1 — an error that runs past its line is given with its end, and the answer says what it could not see')
{
  const r = await search('inside.ts')
  const line = recovered(r.text)
  check('one call is found in the file that holds three', Number(r.data?.matchCount) === 1 && r.text.includes('inside.ts:3:13 [call_expression]') && r.text.includes('1 match in 1 file.'), r.text)
  check('the trailer gives each error its reach and names both risks', line === `Searched recovered tree: inside.ts (typescript; 1:1-5:10 syntax error; 2:10-3:8 syntax error; 4:1-5:7 syntax error). ${TWO_RISKS}`, line)
  const reach = /(\d+):(\d+)-(\d+):(\d+) syntax error/.exec(line)?.slice(1).map(Number) ?? [0, 0, 0, 0]
  const within = (row: number, column: number): boolean => (row > reach[0]! || (row === reach[0] && column >= reach[1]!)) && (row < reach[2]! || (row === reach[2] && column <= reach[3]!))
  const unfound = [...inside.matchAll(/needle\((\d)\)/g)].filter(call => call[1] !== '2').map(call => { const before = inside.slice(0, call.index).split('\n'); return { call: call[0], row: before.length, column: before.at(-1)!.length + 1 } })
  check('the two calls it did not find stand inside the first printed range', unfound.length === 2 && unfound.every(at => within(at.row, at.column) && !r.text.includes(`inside.ts:${at.row}:${at.column}`)), JSON.stringify({ reach, unfound }))
}

section('§2 — an error within one line and a missing token are located as before')
{
  const nine = recovered((await search('nine.ts')).text)
  check('one-line errors keep line and column, with the omitted count', nine === `Searched recovered tree: nine.ts (typescript; 1:15 syntax error; 2:15 syntax error; 3:15 syntax error; +6 more diagnostics). ${TWO_RISKS}`, nine)
  const paren = recovered((await search('paren.ts')).text)
  check('a missing token keeps line and column', paren === `Searched recovered tree: paren.ts (typescript; 1:19 missing )). ${TWO_RISKS}`, paren)
}

section('§3 — a file that parses answers as it did, byte for byte')
{
  const r = await search('clean.ts')
  check('the clean answer carries no word of recovery', r.text === 'clean.ts:1:15 [call_expression]\n  needle(1)\n  captures: $X = 1\nclean.ts:2:16 [call_expression]\n  needle(2)\n  captures: $X = 2\n2 matches in 1 file.\nSearched 1 of 1 files reach/clean.ts — 1 typescript.', JSON.stringify(r.text))
}

finish('RECOVERED SEARCH NAMES THE REACH')
