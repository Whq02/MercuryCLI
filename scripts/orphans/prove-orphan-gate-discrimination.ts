#!/usr/bin/env bun

import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'

const t = checker()
const ROOT = join(import.meta.dir, '..', '..')
const GATE = join(import.meta.dir, 'prove-no-orphans.ts')
const REAL = join(import.meta.dir, 'baseline.json')
const scratch = mkdtempSync(join(tmpdir(), 'cairn-orphan-disc-'))
const estate = join(scratch, 'estate')
const ESTATE_GATE = join(estate, 'scripts', 'orphans', 'prove-no-orphans.ts')
const PARKED = { file: 'src/parked.ts', class: 'living-specimen', reason: 'SEEDED: the one file of the synthetic estate that nothing reaches.' }
const TYPED = { file: 'src/typedCode.ts', class: 'proof-or-fixture-only', reason: 'SEEDED: a function nothing calls, in a file one import type names.' }
mkdirSync(join(estate, 'scripts', 'orphans'), { recursive: true })
mkdirSync(join(estate, 'src', 'entrypoints'), { recursive: true })
for (const name of ['graph.ts', 'prove-no-orphans.ts']) copyFileSync(join(import.meta.dir, name), join(estate, 'scripts', 'orphans', name))
symlinkSync(join(ROOT, 'node_modules'), join(estate, 'node_modules'), 'junction')
const CLI_BUILD = "await Bun.build({ entrypoints: [resolve(SRC, 'entrypoints/cli.tsx')] })\n"
writeFileSync(join(estate, 'build.ts'), `${CLI_BUILD}await Bun.build({ entrypoints: [resolve(SRC, 'bundled.ts')] })\n`)
writeFileSync(join(estate, 'src', 'entrypoints', 'cli.tsx'), "import '../reached.js'\nimport type { Shape } from '../shapes.js'\nimport type { Other } from '../typedCode.js'\nexport type Both = Shape | Other\n")
writeFileSync(join(estate, 'src', 'shapes.ts'), 'export type Shape = { n: number }\n')
writeFileSync(join(estate, 'src', 'typedCode.ts'), 'export type Other = { m: number }\nexport function neverCalled(): number {\n  return 1\n}\n')
writeFileSync(join(estate, 'src', 'reached.ts'), 'export const reached = 1\n')
writeFileSync(join(estate, 'src', 'bundled.ts'), 'export const bundled = 1\n')
writeFileSync(join(estate, 'src', 'parked.ts'), 'export const parked = 1\n')

interface GateRun {
  code: number
  out: string
}
function runGate(args: string[], gate = GATE, cwd = ROOT): GateRun {
  try {
    const out = execFileSync('bun', [gate, ...args], { cwd, encoding: 'utf8' })
    return { code: 0, out }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

const baseline = JSON.parse(readFileSync(REAL, 'utf8')) as {
  rows: Array<{ file: string; class: string; reason: string }>
}

t.section('§1 — control: the real typed baseline is GREEN')
{
  const r = runGate(['--baseline', REAL])
  t.check('gate exits 0 on the real baseline', r.code === 0, `exit=${r.code}`)
  t.check('gate reports GREEN', r.out.includes('NO-ORPHANS GREEN'))
}

t.section('§2 — a CURED exemption reds the gate until pruned')
{
  const seeded = {
    schema: 1,
    rows: [
      ...baseline.rows,
      {
        file: 'src/boot/main.tsx',
        class: 'superseded-unreachable',
        reason: 'SEEDED WRONG VARIANT — this file is decisively reachable from the CLI entrypoint.',
      },
    ],
  }
  const p = join(scratch, 'cured.json')
  writeFileSync(p, JSON.stringify(seeded, null, 2))
  const r = runGate(['--baseline', p])
  t.check('gate exits non-zero on a cured exemption', r.code !== 0, `exit=${r.code}`)
  t.check('the red names the CURED class', r.out.includes('CURED exemption'))
  t.check('the red names the seeded file', r.out.includes('src/boot/main.tsx'))
}

t.section('§3 — hiding a real orphan reds the gate (fresh-orphan law)')
{
  const listed = join(scratch, 'listed.json')
  writeFileSync(listed, JSON.stringify({ schema: 1, rows: [PARKED, TYPED] }, null, 2))
  const control = runGate(['--baseline', listed], ESTATE_GATE, estate)
  t.check('control: a synthetic estate with its two orphans listed is GREEN, and the file its build.ts bundles is a root', control.code === 0 && control.out.includes('orphans: 2 (typed baseline 2)'), control.out.trim().split('\n').pop())
  const p = join(scratch, 'hidden.json')
  writeFileSync(p, JSON.stringify({ schema: 1, rows: [] }, null, 2))
  const r = runGate(['--baseline', p], ESTATE_GATE, estate)
  t.check('gate exits non-zero when a real orphan is unlisted', r.code !== 0, `exit=${r.code}`)
  t.check('the red names the NEW orphan', r.out.includes('NEW orphan'))
  t.check('the red names the hidden file', r.out.includes(PARKED.file))
}

t.section('§4 — a malformed exemption row reds the gate')
{
  const p = join(scratch, 'malformed.json')
  writeFileSync(p, JSON.stringify({ schema: 1, rows: [{ ...PARKED, class: 'grandfathered', reason: 'legacy' }, TYPED] }, null, 2))
  const r = runGate(['--baseline', p], ESTATE_GATE, estate)
  t.check('gate exits non-zero on an invalid class / thin reason', r.code !== 0, `exit=${r.code}`)
  t.check('the red names the malformed row', r.out.includes('invalid class'))
}

t.section('§5 — --regen prunes cured rows and never adds')
{
  const seeded = {
    schema: 1,
    rows: [
      ...baseline.rows,
      {
        file: 'src/boot/main.tsx',
        class: 'superseded-unreachable',
        reason: 'SEEDED WRONG VARIANT — reachable; --regen must prune exactly this row.',
      },
    ],
  }
  const p = join(scratch, 'regen.json')
  writeFileSync(p, JSON.stringify(seeded, null, 2))
  const r = runGate(['--baseline', p, '--regen'])
  t.check('--regen exits 0', r.code === 0, `exit=${r.code}`)
  const after = JSON.parse(readFileSync(p, 'utf8')) as { rows: Array<{ file: string }> }
  t.check('the cured row was pruned', !after.rows.some(x => x.file === 'src/boot/main.tsx'))
  t.check('the real exemptions survived the prune', after.rows.length === baseline.rows.length)
  const r2 = runGate(['--baseline', p])
  t.check('the pruned copy is GREEN again', r2.code === 0, `exit=${r2.code}`)
}

t.section('§6 — a type import is no reach for code: a file of types alone is reached, a file that carries code is named')
{
  const p = join(scratch, 'typed.json')
  writeFileSync(p, JSON.stringify({ schema: 1, rows: [PARKED] }, null, 2))
  const r = runGate(['--baseline', p], ESTATE_GATE, estate)
  t.check('gate exits non-zero on code that only an import type reaches', r.code !== 0, `exit=${r.code}`)
  t.check('the red names the file and the road', r.out.includes(`${TYPED.file} (it carries code`) && r.out.includes('type-only import; src/boot/entrypoints/cli.tsx names it'), r.out.trim().split('\n').slice(-4).join(' | '))
  t.check('the file of types alone is not named', !r.out.includes('src/shapes.ts'))
}

t.section('§7 — the build-entry reader stops with the line where it cannot read; a list no build uses and a folder make no root; every code file is counted')
{
  const build = join(estate, 'build.ts')
  const standing = readFileSync(build, 'utf8')
  const listed = join(scratch, 'entries.json')
  writeFileSync(listed, JSON.stringify({ schema: 1, rows: [PARKED, TYPED] }, null, 2))
  const last = (r: GateRun): string => r.out.trim().split('\n').slice(-3).join(' | ')
  const withBuild = (text: string): GateRun => {
    writeFileSync(build, text)
    const r = runGate(['--baseline', listed], ESTATE_GATE, estate)
    writeFileSync(build, standing)
    return r
  }
  const unread: Array<[string, string, number]> = [
    ['a list held in a constant', `${CLI_BUILD}const entries = [resolve(SRC, 'bundled.ts')]\nawait Bun.build({ entrypoints: entries })\n`, 3],
    ['a spread of a constant', `${CLI_BUILD}const entries = [resolve(SRC, 'bundled.ts')]\nawait Bun.build({ entrypoints: [...entries] })\n`, 3],
    ['options held in a constant', `${CLI_BUILD}const options = { entrypoints: [resolve(SRC, 'bundled.ts')] }\nawait Bun.build(options)\n`, 3],
    ['a resolve of three arguments', `${CLI_BUILD}await Bun.build({ entrypoints: [resolve(SRC, 'entrypoints', 'cli.tsx')] })\n`, 2],
    ['a path that names no file', `${CLI_BUILD}await Bun.build({ entrypoints: [resolve(SRC, 'gone.ts')] })\n`, 2],
  ]
  for (const [name, text, line] of unread) {
    const r = withBuild(text)
    t.check(`${name} stops the gate with the line of build.ts and names no orphan`, r.code !== 0 && r.out.includes(`build.ts:${line}: `) && !r.out.includes('NEW orphan'), last(r))
  }
  const none = withBuild("const entries = [resolve(SRC, 'entrypoints/cli.tsx')]\n")
  t.check('a build.ts that calls no Bun.build stops the gate', none.code !== 0 && none.out.includes('found no Bun.build call') && !none.out.includes('NEW orphan'), last(none))
  const quoted = withBuild(`${CLI_BUILD}await Bun.build({ 'entrypoints': [resolve(SRC, 'bundled.ts')] })\n`)
  t.check('a quoted key is the same list: its file is still a root', quoted.code === 0 && quoted.out.includes('orphans: 2 (typed baseline 2)'), last(quoted))
  const unbuilt = withBuild(`${CLI_BUILD}const unbuilt = { entrypoints: [resolve(SRC, 'bundled.ts')] }\nvoid unbuilt\n`)
  t.check('a list no build uses makes no root: its file is named', unbuilt.code !== 0 && unbuilt.out.includes('NEW orphan') && unbuilt.out.includes('src/bundled.ts'), last(unbuilt))
  writeFileSync(join(estate, 'src', 'entrypoints', 'side.ts'), "import '../behind.js'\n")
  writeFileSync(join(estate, 'src', 'behind.ts'), 'export const behind = 1\n')
  const folder = runGate(['--baseline', listed], ESTATE_GATE, estate)
  t.check('a file in src/entrypoints that no build names is no root: it and what only it imports are named', folder.code !== 0 && folder.out.includes('src/entrypoints/side.ts') && folder.out.includes('src/behind.ts'), last(folder))
  rmSync(join(estate, 'src', 'entrypoints', 'side.ts'))
  rmSync(join(estate, 'src', 'behind.ts'))
  for (const name of ['worker.mjs', 'older.js', 'module.mts']) writeFileSync(join(estate, 'src', name), 'export const loose = 1\n')
  const loose = runGate(['--baseline', listed], ESTATE_GATE, estate)
  t.check('a code file that is not TypeScript is counted: three that nothing reaches are named', loose.code !== 0 && ['src/worker.mjs', 'src/older.js', 'src/module.mts'].every(file => loose.out.includes(file)), last(loose))
  writeFileSync(join(estate, 'src', 'reached.ts'), "export const reached = ['worker.mjs', new URL('./older.js', import.meta.url).pathname]\nexport { loose } from './module.mjs'\n")
  const named = runGate(['--baseline', listed], ESTATE_GATE, estate)
  t.check('…and each is reached when a reached file names it: by its file name beside it, by a URL of its own folder, by an import', named.code === 0 && named.out.includes('3 of them not TypeScript'), last(named))
}

rmSync(scratch, { recursive: true, force: true })
t.finish('prove-orphan-gate-discrimination')
