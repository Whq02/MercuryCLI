#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { armEnvironment, check, drive, enterRoot, finish, makeContext, section, REPO } from './lib/harness.ts'

armEnvironment()

const { AstEditTool } = await import(join(REPO, 'src/tools/AstEditTool/AstEditTool.ts'))
const { digestOf, rewritePlanToken } = await import(join(REPO, 'src/utils/astPatterns.ts'))

const root = mkdtempSync(join(tmpdir(), 'ast-left-out-'))
const damaged = 'function outer( {\n  needle(1);\n  const x = needle(2)\n}\nneedle(3);\n'
const put = (file: string, text: string): void => { mkdirSync(join(root, file, '..'), { recursive: true }); writeFileSync(join(root, file), text) }
const get = (file: string): string => readFileSync(join(root, file), 'utf8')
const three = (dir: string): void => { put(`${dir}/clean.ts`, 'const a = needle(1);\n'); put(`${dir}/more.ts`, 'const b = needle(2);\n'); put(`${dir}/inside.ts`, damaged) }
three('one'); three('rules'); three('token')
put('alone/inside.ts', damaged)
put('mixed/clean.ts', 'const a = needle(1);\n')
put('mixed/damaged.js', 'const broken = ;\nconst b = needle(2);\n')
put('only/damaged.js', 'const broken = ;\nconst b = needle(2);\n')
put('breaks/clean.ts', 'const a = needle(1);\n')
put('breaks/clean.js', 'const c = needle(3);\n')
put('breaks/damaged.js', 'const broken = ;\nconst b = needle(2);\n')
for (let i = 0; i < 7; i++) put(`seven/d${i}.ts`, damaged)
put('seven/clean.ts', 'const a = needle(1);\n')
put('plain/clean.ts', 'const a = needle(1);\n')
await enterRoot(root)
const prover = await makeContext([AstEditTool], { mode: 'sovereign' })
const edit = (input: Record<string, unknown>) => drive(AstEditTool, input, prover)
const planOf = (text: string): string => /plan: (ae-[a-f0-9]+)/.exec(text)?.[1] ?? ''
const LEFT = 'Left unchanged: inside.ts (3:13 the match touches a syntax-error region).'
const single = { pattern: 'needle($X)', rewrite: 'found($X)' }

section('§1 — one rule over two clean files and one whose match sits in damage')
{
  const dry = await edit({ ...single, path: 'one' })
  check('the two clean files are planned as before the damaged file was read', !dry.isError && dry.text.startsWith('Dry run — 2 matches in 2 files would change; nothing written.') && dry.text.includes('--- a/clean.ts') && dry.text.includes('--- a/more.ts') && !dry.text.includes('--- a/inside.ts'), dry.text.slice(0, 300))
  check('the damaged file is named with the place and the reason, after the recovered-tree line', dry.text.includes('Searched recovered tree: inside.ts (typescript;') && dry.text.split('\n').at(-1) === LEFT, dry.text.split('\n').slice(-2).join(' | '))
  const done = await edit({ ...single, path: 'one', apply: true, plan: planOf(dry.text) })
  check('the apply writes the two files and names the same file as left', !done.isError && done.text.startsWith('Applied 2 structural rewrites in 2 files (re-read verified):') && done.text.split('\n').at(-1) === LEFT, done.text)
  check('the two files are rewritten and the damaged file is byte for byte as it was', get('one/clean.ts') === 'const a = found(1);\n' && get('one/more.ts') === 'const b = found(2);\n' && get('one/inside.ts') === damaged)
}

section('§2 — where nothing is left to rewrite the ruled sentences stand')
{
  const alone = await edit({ ...single, path: 'alone' })
  check('the damaged file alone: the match touches damage', alone.isError && alone.text.includes('Cannot rewrite inside.ts:3:13: the match touches a syntax-error region. Nothing was written.') && get('alone/inside.ts') === damaged, alone.text)
  const byRules = await edit({ rules: [single], path: 'alone' })
  check('the same by rules, naming the rule', byRules.isError && byRules.text.includes('Cannot rewrite inside.ts:3:13 (rule 0): the match touches a syntax-error region. Nothing was written.'), byRules.text)
  const only = await edit({ pattern: 'needle($X)', rewrite: 'found($X)!', path: 'only' })
  check('a damaged file alone whose errors the rewrite would change', only.isError && only.text.includes('The rewrite introduces a syntax error in damaged.js at 2:19 (syntax error). Nothing was written.'), only.text)
}

section('§3 — a damaged file whose errors the rewrite would change is left out; a clean file it breaks refuses the edit')
{
  const mixed = await edit({ pattern: 'needle($X)', rewrite: 'found($X)!', path: 'mixed' })
  check('the clean file is planned and the damaged one named', !mixed.isError && mixed.text.startsWith('Dry run — 1 match in 1 file would change; nothing written.') && mixed.text.split('\n').at(-1) === 'Left unchanged: damaged.js (2:19 the rewrite would introduce a syntax error).', mixed.text.split('\n').slice(-2).join(' | '))
  const breaks = await edit({ pattern: 'needle($X)', rewrite: 'found($X)!', path: 'breaks' })
  check('a clean file the rewrite breaks refuses the whole edit by the existing sentence', breaks.isError && breaks.text.includes('The rewrite would leave clean.js unparsable as javascript (1:19 syntax error) — adjust the rewrite so the result is valid code. Nothing was written.') && get('breaks/clean.ts') === 'const a = needle(1);\n', breaks.text)
}

section('§4 — the rules planner leaves the same file out')
{
  const dry = await edit({ rules: [single], path: 'rules' })
  check('two files planned across one rule, the damaged file named', !dry.isError && dry.text.startsWith('Dry run — 2 matches in 2 files would change across 1 rule; nothing written.') && dry.text.split('\n').at(-1) === LEFT, dry.text.split('\n').slice(-2).join(' | '))
  const done = await edit({ rules: [single], path: 'rules', apply: true, plan: planOf(dry.text) })
  check('the apply by rules writes two files and names the same file', !done.isError && done.text.startsWith('Applied 2 structural rewrites in 2 files (re-read verified):') && done.text.split('\n').at(-1) === LEFT && get('rules/inside.ts') === damaged && get('rules/more.ts') === 'const b = found(2);\n', done.text)
}

section('§5 — the plan covers what was left out')
{
  const dry = await edit({ ...single, path: 'token' })
  put('token/later.ts', damaged)
  const stale = await edit({ ...single, path: 'token', apply: true, plan: planOf(dry.text) })
  check('a second file left out after the dry run is a plan mismatch, nothing written', stale.isError && stale.text.startsWith(`<tool_use_error>Plan ${planOf(dry.text)} does not match the current dry run (`) && stale.text.includes('Left unchanged: inside.ts (3:13 the match touches a syntax-error region); later.ts (3:13 the match touches a syntax-error region).') && get('token/clean.ts') === 'const a = needle(1);\n', stale.text.slice(0, 200))
  const again = await edit({ ...single, path: 'token', apply: true, plan: planOf(stale.text) })
  check('the dry run that names both is applied', !again.isError && again.text.startsWith('Applied 2 structural rewrites in 2 files') && get('token/later.ts') === damaged && get('token/clean.ts') === 'const a = found(1);\n', again.text)
  const plain = await edit({ ...single, path: 'plain' })
  check('a scope with nothing left out keeps the token it always had', planOf(plain.text) === rewritePlanToken('needle($X)', 'found($X)', [['clean.ts', digestOf('const a = needle(1);\n'), digestOf('const a = found(1);\n')]]) && !plain.text.includes('Left unchanged'), plain.text.slice(-200))
}

section('§6 — five files are named, the rest counted')
{
  const dry = await edit({ ...single, path: 'seven' })
  const line = dry.text.split('\n').at(-1) ?? ''
  check('seven damaged files beside a clean one', !dry.isError && dry.text.startsWith('Dry run — 1 match in 1 file would change; nothing written.') && line === `Left unchanged: ${[0, 1, 2, 3, 4].map(i => `d${i}.ts (3:13 the match touches a syntax-error region)`).join('; ')}; +2 more.`, line)
}

finish('DAMAGED FILE LEFT OUT')
