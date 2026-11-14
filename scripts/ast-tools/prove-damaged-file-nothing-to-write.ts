#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { armEnvironment, check, drive, enterRoot, finish, makeContext, section, REPO } from './lib/harness.ts'

armEnvironment()

const { AstEditTool } = await import(join(REPO, 'src/tools/AstEditTool/AstEditTool.ts'))

const root = mkdtempSync(join(tmpdir(), 'ast-nothing-to-write-'))
const damaged = 'function outer( {\n  needle(1);\n  const x = needle(2)\n}\nneedle(3);\n'
const put = (file: string, text: string): void => { mkdirSync(join(root, file, '..'), { recursive: true }); writeFileSync(join(root, file), text) }
const get = (file: string): string => readFileSync(join(root, file), 'utf8')
for (const dir of ['same', 'samerules', 'again']) { put(`${dir}/clean.ts`, 'const a = needle(1);\n'); put(`${dir}/damaged.ts`, damaged) }
put('alone/damaged.ts', damaged)
put('none/clean.ts', 'const a = other(1);\n')
put('none/damaged.ts', damaged)
put('mixed/clean.ts', 'const a = needle(1);\n')
put('mixed/damaged.ts', 'function outer( {\n  other(1);\n  const x = other(2)\n}\nother(3);\n')
put('unread/clean.ts', 'const a = needle(1);\n')
put('unread/damaged.ts', 'function outer( {\n  needle(1);\n  const x = needle(2) + other(5)\n}\nneedle(3);\n')
put('plain/clean.ts', 'const a = needle(1);\n')
await enterRoot(root)
const prover = await makeContext([AstEditTool], { mode: 'sovereign' })
const edit = (input: Record<string, unknown>) => drive(AstEditTool, input, prover)
const planOf = (text: string): string => /plan: (ae-[a-f0-9]+)/.exec(text)?.[1] ?? ''
const LEFT = 'Left unchanged: damaged.ts (3:13 the match touches a syntax-error region).'
const same = { pattern: 'needle($X)', rewrite: 'needle($X)' }
const move = { pattern: 'needle($X)', rewrite: 'found($X)' }

section('§1 — matches that already read as the rewrite, beside a file whose match sits in damage')
{
  const one = await edit({ ...same, path: 'same' })
  check('one rule: the answer is nothing to write, as before the damaged file was read, and no error', !one.isError && one.text.startsWith('1 match of "needle($X)" already read exactly as the rewrite — nothing to write.'), one.text)
  check('one rule: the damaged file is named on the last line with the place and the reason', one.text.includes('Searched recovered tree: damaged.ts (typescript;') && one.text.split('\n').at(-1) === LEFT, one.text.split('\n').slice(-2).join(' | '))
  check('one rule: no file moved', get('same/clean.ts') === 'const a = needle(1);\n' && get('same/damaged.ts') === damaged)
  const rules = await edit({ rules: [same], path: 'samerules' })
  check('by rules: nothing to write, and no error', !rules.isError && rules.text.startsWith('1 match of 1 rule already read exactly as the rewrite — nothing to write.'), rules.text)
  check('by rules: the rule is counted as already rewritten and the damaged file named last', rules.text.includes('rule 0 ("needle($X)" → "needle($X)"): 0 rewrites in 0 files (1 already rewritten)') && rules.text.split('\n').at(-1) === LEFT, rules.text)
}

section('§2 — where no match reads as the rewrite and nothing is left to rewrite, the ruled sentences stand')
{
  const alone = await edit({ ...same, path: 'alone' })
  check('the damaged file alone', alone.isError && alone.text.includes('Cannot rewrite damaged.ts:3:13: the match touches a syntax-error region. Nothing was written.'), alone.text)
  const none = await edit({ ...move, path: 'none' })
  check('a file that parses with no match beside it', none.isError && none.text.includes('Cannot rewrite damaged.ts:3:13: the match touches a syntax-error region. Nothing was written.'), none.text)
  const dry = await edit({ ...move, path: 'again' })
  const done = await edit({ ...move, path: 'again', apply: true, plan: planOf(dry.text) })
  check('an edit is applied to the file that parses and the damaged file named', !done.isError && done.text.startsWith('Applied 1 structural rewrite in 1 file') && done.text.split('\n').at(-1) === LEFT && get('again/clean.ts') === 'const a = found(1);\n', done.text)
  const again = await edit({ ...move, path: 'again' })
  check('the same edit run again names the match it could not rewrite', again.isError && again.text.includes('Cannot rewrite damaged.ts:3:13: the match touches a syntax-error region. Nothing was written.') && get('again/damaged.ts') === damaged, again.text)
}

section('§3 — a rule whose matches sit in a file left unchanged did not match nothing')
{
  const mixed = await edit({ rules: [move, { pattern: 'other($X)', rewrite: 'another($X)' }, { pattern: 'absent($X)', rewrite: 'gone($X)' }], path: 'mixed' })
  check('the file that parses is planned and the damaged one named', !mixed.isError && mixed.text.startsWith('Dry run — 1 match in 1 file would change across 3 rules; nothing written.') && mixed.text.split('\n').at(-1) === LEFT, mixed.text)
  check('the rule that matched only in the damaged file rewrites nothing and is not said to match nothing', mixed.text.includes('rule 1 ("other($X)" → "another($X)"): 0 rewrites in 0 files') && mixed.text.includes('Matched nothing: rule 2.'), mixed.text)
  const unread = await edit({ rules: [move, { pattern: 'other($X)', rewrite: 'another($X)' }, { pattern: 'absent($X)', rewrite: 'gone($X)' }], path: 'unread' })
  check('a rule read after the one that met the damage is not said to match nothing either', !unread.isError && unread.text.includes('Matched nothing: rule 2.') && unread.text.split('\n').at(-1) === LEFT, unread.text)
  const plain = await edit({ rules: [move, { pattern: 'absent($X)', rewrite: 'gone($X)' }], path: 'plain' })
  check('a scope of files that parse names the rule that matched nothing as before', !plain.isError && plain.text.includes('Matched nothing: rule 1.') && !plain.text.includes('Left unchanged'), plain.text)
  const every = await edit({ rules: [move], path: 'plain' })
  check('and says none when every rule matched', !every.isError && every.text.includes('Matched nothing: none.'), every.text)
}

finish('DAMAGED FILE, NOTHING TO WRITE')
