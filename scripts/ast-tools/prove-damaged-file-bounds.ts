#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { armEnvironment, check, drive, enterRoot, finish, makeContext, section, REPO } from './lib/harness.ts'

armEnvironment()

const { AstEditTool } = await import(join(REPO, 'src/tools/AstEditTool/AstEditTool.ts'))
const { AstSearchTool } = await import(join(REPO, 'src/tools/AstSearchTool/AstSearchTool.ts'))

const root = mkdtempSync(join(tmpdir(), 'ast-bounds-'))
const put = (file: string, text: string): void => { mkdirSync(join(root, file, '..'), { recursive: true }); writeFileSync(join(root, file), text) }
const get = (file: string): string => readFileSync(join(root, file), 'utf8')
const calls = (count: number): string => Array.from({ length: count }, (_, i) => `needle(${i});`).join('\n') + '\n'
const each = (count: number): Array<[string, string]> => Array.from({ length: count }, (_, i): [string, string] => [`c${String(i).padStart(3, '0')}.ts`, 'needle(1);\n'])
const broken = 'const broken = ;\n'
const inside = 'function outer( {\n  needle(1);\n  const x = needle(2)\n}\nneedle(3);\n'
const MATCHES = 'more than 500 matches in one edit'
const FILES = 'more than the 100-file bound for one edit'
const TOO_MANY = (what: string): string => `More than 500 matches in one edit — narrow the scope (path or glob) or the ${what}, then run again. Nothing was written.`
const TOO_MANY_FILES = 'Matches in 101 files, more than the 100-file bound for one edit — narrow the scope (path or glob), then run again. Nothing was written.'

interface Row { dir: string; clean: Array<[string, string]>; damaged: [string, string]; base: string; left: string; leftByRules?: string }
const rows: Row[] = [
  { dir: 'm500', clean: [['clean.ts', calls(500)]], damaged: ['damaged.ts', `${broken}needle(0);\n`], base: '500 matches in 1 file', left: `damaged.ts (${MATCHES})` },
  { dir: 'm499', clean: [['clean.ts', calls(499)]], damaged: ['damaged.ts', `${broken}needle(0);\nneedle(1);\n`], base: '499 matches in 1 file', left: `damaged.ts (${MATCHES})` },
  { dir: 'f100', clean: each(100), damaged: ['damaged.ts', `${broken}needle(0);\n`], base: '100 matches in 100 files', left: `damaged.ts (${FILES})` },
  { dir: 'dirty500', clean: [['clean.ts', calls(500)]], damaged: ['damaged.ts', inside], base: '500 matches in 1 file', left: `damaged.ts (${MATCHES})`, leftByRules: 'damaged.ts (3:13 the match touches a syntax-error region)' },
  { dir: 'big', clean: [['clean.ts', 'needle(1);\n']], damaged: ['damaged.ts', broken + calls(501)], base: '1 match in 1 file', left: `damaged.ts (${MATCHES})` },
  { dir: 'zfirst', clean: [['b-clean.ts', 'needle(1);\n']], damaged: ['a-damaged.ts', broken + calls(501)], base: '1 match in 1 file', left: `a-damaged.ts (${MATCHES})` },
]
for (const row of rows) {
  for (const [file, text] of row.clean) { put(`${row.dir}/${file}`, text); put(`${row.dir}-alone/${file}`, text) }
  put(`${row.dir}/${row.damaged[0]}`, row.damaged[1])
}
put('clean501/clean.ts', calls(501))
put('clean501/damaged.ts', `${broken}needle(0);\n`)
for (const [file, text] of each(101)) put(`clean101/${file}`, text)
put('clean101/damaged.ts', `${broken}needle(0);\n`)
put('onlybig/damaged.ts', broken + calls(501))
put('within/clean.ts', calls(498))
put('within/damaged.ts', `${broken}needle(0);\nneedle(1);\n`)
for (const dir of ['apply', 'token']) { put(`${dir}/clean.ts`, calls(500)); put(`${dir}/damaged.ts`, `${broken}needle(0);\n`) }
for (const [file, text] of each(100)) put(`seven/${file}`, text)
for (let i = 0; i < 7; i++) put(`seven/d${i}.ts`, `${broken}needle(0);\n`)
put('two/clean.ts', calls(500))
for (const file of ['d1.ts', 'd2.ts']) put(`two/${file}`, broken + calls(3))
await enterRoot(root)
const prover = await makeContext([AstEditTool, AstSearchTool], { mode: 'sovereign' })
const edit = (input: Record<string, unknown>) => drive(AstEditTool, input, prover)
const planOf = (text: string): string => /plan: (ae-[a-f0-9]+)/.exec(text)?.[1] ?? ''
const planned = (text: string): string => text.split('\nplan: ')[0] ?? ''
const ends = (text: string): string => `${text.split('\n')[0]} | ${text.split('\n').at(-1)}`
const single = { pattern: 'needle($X)', rewrite: 'found($X)' }

section('§1 — a damaged file whose matches would take the edit past a bound is left out, and the edit is the one the base planned')
for (const row of rows) {
  const dry = await edit({ ...single, path: row.dir })
  const alone = await edit({ ...single, path: `${row.dir}-alone` })
  check(`${row.dir}: the base's plan (${row.base}) and the damaged file named with the bound`, !dry.isError && dry.text.startsWith(`Dry run — ${row.base} would change; nothing written.`) && dry.text.split('\n').at(-1) === `Left unchanged: ${row.left}.`, ends(dry.text).slice(0, 300))
  check(`${row.dir}: the header and every diff are those of the same files without the damaged one`, !dry.isError && !alone.isError && planned(dry.text).length > 0 && planned(dry.text) === planned(alone.text), `${planned(dry.text).length} characters against ${planned(alone.text).length}`)
  const byRules = await edit({ rules: [single], path: row.dir })
  const aloneByRules = await edit({ rules: [single], path: `${row.dir}-alone` })
  check(`${row.dir} by rules: the same plan and the damaged file named`, !byRules.isError && byRules.text.startsWith(`Dry run — ${row.base} would change across 1 rule; nothing written.`) && byRules.text.split('\n').at(-1) === `Left unchanged: ${row.leftByRules ?? row.left}.`, ends(byRules.text).slice(0, 300))
  check(`${row.dir} by rules: the header, the rule counts and every diff are those of the same files without the damaged one`, !byRules.isError && !aloneByRules.isError && planned(byRules.text).length > 0 && planned(byRules.text) === planned(aloneByRules.text), `${planned(byRules.text).length} characters against ${planned(aloneByRules.text).length}`)
}

section('§2 — files that parse, alone past a bound, refuse as on the base; a damaged file alone past one keeps the bound\'s sentence')
{
  const matches = await edit({ ...single, path: 'clean501' })
  check('501 matches in a file that parses, beside a damaged file: the existing sentence', matches.isError && matches.text.includes(TOO_MANY('pattern')), matches.text.slice(0, 200))
  const matchesByRules = await edit({ rules: [single], path: 'clean501' })
  check('the same by rules', matchesByRules.isError && matchesByRules.text.includes(TOO_MANY('rules')), matchesByRules.text.slice(0, 200))
  const files = await edit({ ...single, path: 'clean101' })
  check('101 files that parse, beside a damaged file: the existing sentence with the count of the files that parse', files.isError && files.text.includes(TOO_MANY_FILES), files.text.slice(0, 200))
  const filesByRules = await edit({ rules: [single], path: 'clean101' })
  check('the same by rules', filesByRules.isError && filesByRules.text.includes(TOO_MANY_FILES), filesByRules.text.slice(0, 200))
  const only = await edit({ ...single, path: 'onlybig' })
  check('a damaged file alone with 501 matches: the bound\'s sentence stands', only.isError && only.text.includes(TOO_MANY('pattern')) && get('onlybig/damaged.ts') === broken + calls(501), only.text.slice(0, 200))
  const onlyByRules = await edit({ rules: [single], path: 'onlybig' })
  check('the same by rules', onlyByRules.isError && onlyByRules.text.includes(TOO_MANY('rules')), onlyByRules.text.slice(0, 200))
}

section('§3 — within both bounds a damaged file joins the edit as it did')
{
  const dry = await edit({ ...single, path: 'within' })
  check('498 matches and two in a damaged file: 500 matches in 2 files, nothing left out', !dry.isError && dry.text.startsWith('Dry run — 500 matches in 2 files would change; nothing written.') && dry.text.includes('--- a/damaged.ts') && !dry.text.includes('Left unchanged'), ends(dry.text).slice(0, 300))
  const byRules = await edit({ rules: [single], path: 'within' })
  check('the same by rules', !byRules.isError && byRules.text.startsWith('Dry run — 500 matches in 2 files would change across 1 rule; nothing written.') && byRules.text.includes('--- a/damaged.ts') && !byRules.text.includes('Left unchanged'), ends(byRules.text).slice(0, 300))
}

section('§4 — the apply writes that edit, and the plan covers what the bound left out')
{
  const LEFT = `Left unchanged: damaged.ts (${MATCHES}).`
  const dry = await edit({ ...single, path: 'apply' })
  const done = await edit({ ...single, path: 'apply', apply: true, plan: planOf(dry.text) })
  check('500 rewrites written in the file that parses, the damaged file byte for byte, the same file named', !done.isError && done.text.startsWith('Applied 500 structural rewrites in 1 file (re-read verified):') && done.text.split('\n').at(-1) === LEFT && get('apply/clean.ts') === calls(500).replaceAll('needle(', 'found(') && get('apply/damaged.ts') === `${broken}needle(0);\n`, ends(done.text).slice(0, 300))
  const first = await edit({ ...single, path: 'token' })
  put('token/later.ts', `${broken}needle(0);\n`)
  const stale = await edit({ ...single, path: 'token', apply: true, plan: planOf(first.text) })
  check('a second damaged file left out after the dry run is a plan mismatch, nothing written', stale.isError && stale.text.startsWith(`<tool_use_error>Plan ${planOf(first.text)} does not match the current dry run (`) && stale.text.includes(`Left unchanged: damaged.ts (${MATCHES}); later.ts (${MATCHES}).`) && get('token/clean.ts') === calls(500), stale.text.slice(0, 200))
  const again = await edit({ ...single, path: 'token', apply: true, plan: planOf(stale.text) })
  check('the dry run that names both is applied', !again.isError && again.text.startsWith('Applied 500 structural rewrites in 1 file') && get('token/later.ts') === `${broken}needle(0);\n` && get('token/clean.ts') === calls(500).replaceAll('needle(', 'found('), ends(again.text).slice(0, 300))
}

section('§5 — the search keeps its own cap and counts every match')
{
  const counted = await drive(AstSearchTool, { pattern: 'needle($X)', path: 'm500', mode: 'count' }, prover)
  check('counted: 500 matches in the file that parses and one in the damaged file are 501 in 2 files', !counted.isError && Number(counted.data?.matchCount) === 501 && Number(counted.data?.fileCount) === 2 && counted.data?.capped === false, `${counted.data?.matchCount} in ${counted.data?.fileCount}, capped ${counted.data?.capped}`)
  const listed = await drive(AstSearchTool, { pattern: 'needle($X)', path: 'm500' }, prover)
  check('listed: the search stops at its own 400 as it did', !listed.isError && Number(listed.data?.matchCount) === 400 && listed.data?.capped === true, `${listed.data?.matchCount}, capped ${listed.data?.capped}`)
}

section('§6 — several damaged files past a bound: each is named, five and then a count')
{
  const SEVEN = `Left unchanged: ${[0, 1, 2, 3, 4].map(i => `d${i}.ts (${FILES})`).join('; ')}; +2 more.`
  const TWO = `Left unchanged: d1.ts (${MATCHES}); d2.ts (${MATCHES}).`
  const seven = await edit({ ...single, path: 'seven' })
  check('100 files that parse and seven damaged files: the 100 are planned, five named and two counted', !seven.isError && seven.text.startsWith('Dry run — 100 matches in 100 files would change; nothing written.') && seven.text.split('\n').at(-1) === SEVEN, ends(seven.text).slice(0, 400))
  const sevenByRules = await edit({ rules: [single], path: 'seven' })
  check('the same by rules', !sevenByRules.isError && sevenByRules.text.startsWith('Dry run — 100 matches in 100 files would change across 1 rule; nothing written.') && sevenByRules.text.split('\n').at(-1) === SEVEN, ends(sevenByRules.text).slice(0, 400))
  const two = await edit({ ...single, path: 'two' })
  check('500 matches and two damaged files of three matches each: both are named', !two.isError && two.text.startsWith('Dry run — 500 matches in 1 file would change; nothing written.') && two.text.split('\n').at(-1) === TWO, ends(two.text).slice(0, 300))
  const twoByRules = await edit({ rules: [single], path: 'two' })
  check('the same by rules', !twoByRules.isError && twoByRules.text.startsWith('Dry run — 500 matches in 1 file would change across 1 rule; nothing written.') && twoByRules.text.split('\n').at(-1) === TWO, ends(twoByRules.text).slice(0, 300))
}

finish('DAMAGED FILE BOUNDS')
