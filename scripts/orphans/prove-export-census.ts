#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { GRAPH_ROOT } from './graph.ts'
import { KEPT_CLASSES, runCensus, treeOptions, type CensusOptions, type ExportCensus, type ExportClass } from './exportCensus.ts'

const REPORT = process.argv.includes('--report')
const OUT_DIR = join(GRAPH_ROOT, 'scripts', 'orphans', '.out')
const OUT_JSON = join(OUT_DIR, 'EXPORT-CENSUS.json')

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`)
}

const SYNTHETIC: Record<string, string> = {
  'src/a.ts': [
    'export const used = 1',
    'export const unused = 2',
    'export function dyn(): void {}',
    'export const viaRequire = 1',
    'export const viaNs = 1',
    'export type TOnly = string',
    'export const starRead = 1',
    'export const starUnread = 1',
    'export interface Pinned { a: 1 }',
    'export const bareNamed = 1',
    'export const sharedA = 1, sharedB = 2',
    'export type DtsOnly = 1',
    'export default function defaultFn(): void {}',
    '',
  ].join('\n'),
  'src/b.ts': ["import { used } from './a.js'", "import * as ns from './a.js'", 'console.log(used, ns.viaNs, ns.sharedB)', "export * from './a.js'", 'export const own = 1', ''].join('\n'),
  'src/c.ts': [
    "import { starRead, own } from './b.js'",
    "import type { TOnly } from './a.js'",
    "import def from './a.js'",
    "const { dyn } = await import('./a.js')",
    "const { viaRequire } = require('./a.js') as typeof import('./a.js')",
    'console.log(starRead, own, dyn, viaRequire, def, null as unknown as TOnly)',
    '',
  ].join('\n'),
  'src/d.ts': ["import { join } from 'node:path'", "const ROOT = join(import.meta.dir, '..')", "const m = await import(join(ROOT, 'src', 'e.ts'))", 'console.log(m.fromE)', ''].join('\n'),
  'src/e.ts': ['export const fromE = 1', 'export const eUnused = 2', ''].join('\n'),
  'src/f.ts': ["import * as all from './g.js'", 'console.log(Object.keys(all))', ''].join('\n'),
  'src/g.ts': ['export const g1 = 1', 'export const g2 = 2', ''].join('\n'),
  'src/h.ts': ['export const h1 = 1', 'export const h2 = 2', ''].join('\n'),
  'src/i.ts': ['export const i1 = 1', 'export { i1 as iAlias }', 'export default 42', ''].join('\n'),
  'src/j.ts': ['export const shellRead = 1', 'export const jUnused = 2', ''].join('\n'),
  'src/k.ts': ["void import('./l.js').then(m => m.lThen)", ''].join('\n'),
  'src/l.ts': ['export const lThen = 1', 'export const lUnused = 2', ''].join('\n'),
  'src/m.ts': ['export type MType = number', 'export const mUnused = 1', ''].join('\n'),
  'src/n.d.ts': ["import type { DtsOnly } from './a.js'", 'export type FromDts = DtsOnly', ''].join('\n'),
  'src/o.ts': ['export const o1 = 1', 'export const oUnused = 1', ''].join('\n'),
  'src/p.ts': ['export const pA = 1', 'export const pB = 2', ''].join('\n'),
  'src/q.ts': ['export type QT = { q: 1 }', 'export type QUnused = 2', ''].join('\n'),
  'src/r.ts': ["const r = require('./p.js')", 'const { pA } = r', "let x: import('./q.js').QT", 'console.log(pA, x)', ''].join('\n'),
  'src/s.ts': ['export const loaded = 1', 'export const sUnused = 2', ''].join('\n'),
  'src/t.ts': ["import { join } from 'node:path'", "const ROOT = join(import.meta.dir, '..')", 'const load = (rel: string) => import(join(ROOT, rel))', "const { loaded } = await load('src/s.ts')", 'console.log(loaded)', ''].join('\n'),
  'src/u.ts': ['export const fromCatch = 1', 'export const uUnused = 2', ''].join('\n'),
  'src/v.ts': ["const mod = await import('./u.js').catch(() => null)", 'console.log(mod?.fromCatch)', ''].join('\n'),
  'src/w.ts': ['export const wA = 1', 'export const wB = 2', ''].join('\n'),
  'src/x.ts': ["const actual = await import('./w.js')", 'const stub = { ...actual }', 'console.log(stub)', ''].join('\n'),
  'src/entrypoints/cli.tsx': ['export const cliThing = 1', ''].join('\n'),
  'src/gen/thing.generated.ts': ['export const GEN = 1', ''].join('\n'),
  'src/parked.ts': ['export const parked = 1', ''].join('\n'),
  'scripts/x/fixtures/fx.ts': ['export const FX = 1', ''].join('\n'),
  'scripts/x/prove-x.ts': ["import { readFileSync } from 'node:fs'", "const s = readFileSync('src/a.ts', 'utf8')", "if (!s.includes('export interface Pinned')) throw new Error('pin')", "const names = ['bareNamed']", 'console.log(names)', ''].join('\n'),
  'scripts/x/run.sh': ['#!/usr/bin/env bash', 'repo="$(cd "$(dirname "$0")/../.." && pwd)"', 'bun -e "import { shellRead } from \'$repo/src/j.ts\'; console.log(shellRead)"', ''].join('\n'),
  'scripts/y/tool.mjs': ["/** @type {import('../../src/m.js').MType} */", 'const v = 1', 'export const used = v', ''].join('\n'),
  'scripts/z/prove-z.ts': ["const mod = await import(new URL('../../src/o.ts', import.meta.url).href)", 'console.log(mod.o1)', ''].join('\n'),
  'src/aa.ts': ['export const fromChild = 1', 'export const aaOther = 2', ''].join('\n'),
  'scripts/x/prove-child.ts': ["import { join } from 'node:path'", "const ROOT = join(import.meta.dir, '..', '..')", 'const program = `', "const { fromChild } = await import(${JSON.stringify(join(ROOT, 'src/aa.ts'))})", 'console.log(fromChild)', '`', 'console.log(program)', ''].join('\n'),
  'src/bb.ts': ["export const BB_TOOL_NAME = 'Bb'", 'export const bbOther = 1', ''].join('\n'),
  'scripts/x/prove-pattern.ts': ["import { readFileSync, readdirSync } from 'node:fs'", "import { join } from 'node:path'", "const ROOT = join(import.meta.dir, '..', '..')", 'const names = new Set<string>()', "for (const f of readdirSync(join(ROOT, 'src'))) for (const m of readFileSync(join(ROOT, 'src', f), 'utf8').matchAll(/export const [A-Z_]+_TOOL_NAME = '([A-Za-z_]+)'/g)) names.add(m[1]!)", 'console.log(names.size)', ''].join('\n'),
  'src/cc.ts': ['export const ccA = 1', 'export const ccB = 2', ''].join('\n'),
  'scripts/x/prove-mirror.ts': ["import ts from 'typescript'", "import { readFileSync } from 'node:fs'", "const sf = ts.createSourceFile('cc.ts', readFileSync('src/cc.ts', 'utf8'), ts.ScriptTarget.Latest)", 'const names = sf.statements.filter(st => ts.canHaveModifiers(st) && ts.getModifiers(st)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)).length', 'console.log(names)', ''].join('\n'),
  'src/dd.ts': ['export const ddUsed = 1', 'export const ddAlso = 2', ''].join('\n'),
  'scripts/x/lib.ts': ["export const dd = await import('../../src/dd.js')", ''].join('\n'),
  'scripts/x/prove-lib.ts': ["import { dd } from './lib.js'", 'console.log(dd.ddUsed)', ''].join('\n'),
  'src/ee.ts': ['export const eeA = 1', 'export const eeB = 2', ''].join('\n'),
  'scripts/x/prove-root.ts': ["import { join } from 'node:path'", "const root = join(import.meta.dir, '../../src')", "const m = await import(join(root, 'ee.ts'))", 'console.log(m.eeA)', ''].join('\n'),
  'src/copied.ts': ["import 'node:fs'", 'export const copiedRead = 1', 'export const copiedUnused = 2', ''].join('\n'),
  'scripts/x/prove-copy.ts': ["import { cpSync } from 'node:fs'", "import { cp as copy } from 'node:fs/promises'", "import { join } from 'node:path'", "import { pathToFileURL } from 'node:url'", "const ROOT = join(import.meta.dir, '../..')", "const scratch = makeScratch()", "const delivered = join(scratch, 'delivered')", "cpSync(join(ROOT, 'src'), delivered, { recursive: true })", "const { copiedRead } = await import(pathToFileURL(join(delivered, 'copied.ts')).href)", "const second = join(scratch, 'second.ts')", "await copy(join(ROOT, 'src/copied.ts'), second)", "const again = await import(pathToFileURL(second).href)", 'console.log(copiedRead, again.copiedRead)', ''].join('\n'),
  'src/shared/bridge.ts': ["import 'node:fs'", 'export const bundledRead = 1', 'export const bundledUnused = 2', ''].join('\n'),
  'src/app/server/main.ts': ["import { bundledRead } from '../shared/bridge.ts'", 'console.log(bundledRead)', ''].join('\n'),
  'src/ff.ts': ['export const ffA = 1', 'export type FfB = 2', ''].join('\n'),
  'scripts/x/prove-checker.ts': ["import ts from 'typescript'", "const program = ts.createProgram(['src/ff.ts'], {})", 'const checker = program.getTypeChecker()', "const names = checker.getExportsOfModule(checker.getSymbolAtLocation(program.getSourceFile('src/ff.ts')!)!).map(s => s.name)", 'console.log(names)', ''].join('\n'),
}

function syntheticEstate(): { root: string; options: CensusOptions } {
  const root = mkdtempSync(join(tmpdir(), 'export-census-'))
  for (const [rel, text] of Object.entries(SYNTHETIC)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  const files = Object.keys(SYNTHETIC).sort()
  const options: CensusOptions = {
    root,
    subjects: files.filter(f => /\.(ts|tsx|mjs)$/.test(f)),
    readers: files,
    stubMap: { [join(root, 'src/app/shared/bridge.ts')]: join(root, 'src/shared/bridge.ts') },
    entrypoints: ['src/entrypoints/cli.tsx'],
    rowsSurface: [],
    generated: [],
    fixtures: ['**/fixtures/**'],
    orphanBaseline: ['src/parked.ts'],
    inventory: new Set(['src/a.ts\u0000unused']),
    pinSources: files.filter(f => f.startsWith('scripts/')),
    generators: new Set(),
  }
  return { root, options }
}

function selfTest(): void {
  section('§0 self-test on a synthetic estate: every reader shape is seen, every kept class is named')
  const { root, options } = syntheticEstate()
  let census: ExportCensus
  try {
    census = runCensus(options)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  const byKey = new Map(census.rows.map(r => [`${r.file}:${r.name}`, r]))
  const classOf = (key: string): string => byKey.get(key)?.class ?? '<no row>'
  const expectRead: Array<[string, string]> = [
    ['src/a.ts:used', 'a static named import'],
    ['src/a.ts:viaNs', 'a namespace import read by property'],
    ['src/a.ts:sharedB', 'a sibling binding read through the namespace'],
    ['src/a.ts:TOnly', 'an import type'],
    ['src/a.ts:default', 'a default import'],
    ['src/a.ts:dyn', 'a destructured await import()'],
    ['src/a.ts:viaRequire', 'a destructured require() beside its typeof import() cast'],
    ['src/a.ts:starRead', 'a name read through an export * chain'],
    ['src/a.ts:DtsOnly', 'a type read only by a .d.ts'],
    ['src/b.ts:own', 'a name read from a re-exporting module'],
    ['src/e.ts:fromE', 'an import(join(ROOT, …)) bound to a namespace and read by property'],
    ['src/g.ts:g1', 'an opaque namespace (Object.keys) reads every name'],
    ['src/g.ts:g2', 'an opaque namespace (Object.keys) reads every name'],
    ['src/j.ts:shellRead', 'an inline import inside a shell script'],
    ['src/l.ts:lThen', 'an import().then(m => m.name) read'],
    ['src/m.ts:MType', 'a JSDoc import() type reference'],
    ['src/o.ts:o1', 'an import(new URL(…, import.meta.url).href) namespace read'],
    ['src/p.ts:pA', 'a require() bound to a name and destructured later'],
    ['src/q.ts:QT', 'an import("…").Name type reference'],
    ['src/s.ts:loaded', 'a loader helper resolved at its call site'],
    ['src/u.ts:fromCatch', 'an import().catch() chain read by property'],
    ['src/w.ts:wA', 'a namespace spread into an object reads every name'],
    ['src/w.ts:wB', 'a namespace spread into an object reads every name'],
    ['src/aa.ts:fromChild', 'a child program composed in a template string imports the module: every name counts'],
    ['src/aa.ts:aaOther', 'a child program composed in a template string imports the module: every name counts'],
    ['src/cc.ts:ccA', 'a proof enumerating exports through the TypeScript AST reads every name of the modules it names'],
    ['src/cc.ts:ccB', 'a proof enumerating exports through the TypeScript AST reads every name of the modules it names'],
    ['src/dd.ts:ddUsed', 'a namespace binding a helper module exports is read whole'],
    ['src/dd.ts:ddAlso', 'a namespace binding a helper module exports is read whole'],
    ['src/ee.ts:eeA', "a file's own root constant wins over the anchor table (import(join(root, …)) with root = …/src)"],
    ['src/copied.ts:copiedRead', 'a module imported from a fixture copy resolves to its source'],
    ['src/shared/bridge.ts:bundledRead', 'a delivered shared-folder import resolves to its source'],
    ['src/ff.ts:ffA', 'a proof enumerating exports through the checker (getExportsOfModule) reads every name of the modules it names'],
    ['src/ff.ts:FfB', 'a proof enumerating exports through the checker (getExportsOfModule) reads every name of the modules it names'],
  ]
  for (const [key, why] of expectRead) check(`read — ${why} (${key})`, classOf(key) === 'read', `class ${classOf(key)}`)
  const expectClass: Array<[string, ExportClass, string]> = [
    ['src/a.ts:unused', 'candidate', 'an export nothing imports'],
    ['src/a.ts:starUnread', 'candidate', 'a name re-exported by * that nothing imports'],
    ['src/a.ts:sharedA', 'shared-statement', 'a sibling binding of a read declaration statement'],
    ['src/a.ts:Pinned', 'text-pin', 'a declaration a proof names in a string'],
    ['src/a.ts:bareNamed', 'text-pin', 'a bare name in a proof that names the module'],
    ['src/e.ts:eUnused', 'candidate', 'the other export of a dynamically loaded module'],
    ['src/h.ts:h1', 'module-anchor', 'the exports of a file with no import or export-from statement'],
    ['src/h.ts:h2', 'module-anchor', 'the exports of a file with no import or export-from statement'],
    ['src/i.ts:i1', 'candidate', 'a declaration also listed in a local export list'],
    ['src/i.ts:iAlias', 're-export', 'a local export list specifier'],
    ['src/i.ts:default', 'default-assignment', 'export default <expression>'],
    ['src/b.ts:*', 're-export', 'export * from'],
    ['src/j.ts:jUnused', 'candidate', 'the other export of a shell-read module'],
    ['src/l.ts:lUnused', 'candidate', 'the other export of a then-read module'],
    ['src/m.ts:mUnused', 'candidate', 'the other export of a JSDoc-read module'],
    ['src/n.d.ts:FromDts', 'declaration-file', 'an export in a .d.ts'],
    ['src/o.ts:oUnused', 'candidate', 'the other export of a URL-loaded module'],
    ['src/p.ts:pB', 'candidate', 'the other export of a required module'],
    ['src/q.ts:QUnused', 'candidate', 'the other type of an import-type-read module'],
    ['src/s.ts:sUnused', 'candidate', 'the other export of a loader-helper-read module'],
    ['src/u.ts:uUnused', 'candidate', 'the other export of a catch-chain-read module'],
    ['src/entrypoints/cli.tsx:cliThing', 'entrypoint', 'an entrypoint export'],
    ['src/gen/thing.generated.ts:GEN', 'generated', 'a generated file export'],
    ['src/parked.ts:parked', 'orphan-baseline', 'a typed-baseline orphan export'],
    ['scripts/x/fixtures/fx.ts:FX', 'fixture', 'a fixture export'],
    ['src/bb.ts:BB_TOOL_NAME', 'pattern-pin', "a proof's regex over source matches the declaration head"],
    ['src/bb.ts:bbOther', 'candidate', 'the other export of a pattern-read module'],
    ['src/ee.ts:eeB', 'candidate', 'the other export of a module loaded through a file-own root constant'],
    ['src/copied.ts:copiedUnused', 'candidate', 'copying a module does not consume its unread exports'],
    ['src/shared/bridge.ts:bundledUnused', 'candidate', 'a delivered shared folder does not consume its unread exports'],
  ]
  for (const [key, cls, why] of expectClass) check(`${cls} — ${why} (${key})`, classOf(key) === cls, `class ${classOf(key)}`)
  check('the inventory flag rides the row the contract inventory records', byKey.get('src/a.ts:unused')?.inventory === true)
  check('the .d.ts-only read is marked as a type-side read', byKey.get('src/a.ts:DtsOnly')?.typeSideOnly === true)
  check('no load in the synthetic estate is unresolved', census.unresolved.length === 0, census.unresolved.map(u => `${u.file}:${u.line}`).join(', '))
  check('the whole-module readers are counted: one embedded script, two export scanners (one by syntax kind, one through the checker), one exported namespace', census.wholeReads.embeddedScripts === 1 && census.wholeReads.exportScanners === 2 && census.wholeReads.exportedNamespaces === 1, JSON.stringify(census.wholeReads))
  const candidates = census.rows.filter(r => r.class === 'candidate').map(r => `${r.file}:${r.name}`).sort()
  const wantCandidates = expectClass.filter(([, cls]) => cls === 'candidate').map(([key]) => key).sort()
  check(`the candidate set is exactly the expected ${wantCandidates.length}`, candidates.join('\n') === wantCandidates.join('\n'), `got ${candidates.join(', ')}`)
}

function topFolder(file: string): string {
  const parts = file.split('/')
  return parts.length > 2 ? `${parts[0]}/${parts[1]}` : parts[0]!
}

function realCensus(): ExportCensus {
  section('§1 the census of every export under src/ and scripts/ against every reader in the tree')
  const options = treeOptions()
  const census = runCensus(options)
  const t = census.tally
  console.log(`  subjects ${options.subjects.length} files · readers ${options.readers.length} files · pin sources ${options.pinSources.length} files · inventory names ${options.inventory.size}`)
  console.log(`  exports ${census.rows.length} · read ${t.read} · type-only among the unread ${census.rows.filter(r => r.class !== 'read' && r.typeOnly).length}`)
  console.log('  the unread, by class:')
  for (const cls of Object.keys(KEPT_CLASSES) as Array<keyof typeof KEPT_CLASSES>) console.log(`    ${cls.padEnd(20)} ${String(t[cls]).padStart(5)}   ${KEPT_CLASSES[cls]}`)
  console.log(`    ${'candidate'.padEnd(20)} ${String(t.candidate).padStart(5)}   an export nothing imports: the keyword goes (bun scripts/orphans/rewrite-unread-exports.ts <folder>)`)
  const byFolder = new Map<string, { total: number; read: number; kept: number; candidate: number }>()
  for (const r of census.rows) {
    const k = topFolder(r.file)
    const row = byFolder.get(k) ?? { total: 0, read: 0, kept: 0, candidate: 0 }
    row.total++
    if (r.class === 'read') row.read++
    else if (r.class === 'candidate') row.candidate++
    else row.kept++
    byFolder.set(k, row)
  }
  console.log('  by top-level folder (exports · read · kept by a class · candidates):')
  for (const [k, v] of [...byFolder].sort((a, b) => b[1].total - a[1].total)) if (v.total >= 40 || v.candidate > 0) console.log(`    ${k.padEnd(28)} ${String(v.total).padStart(6)} ${String(v.read).padStart(6)} ${String(v.kept).padStart(5)} ${String(v.candidate).padStart(5)}`)
  console.log(`  inventory names among the candidates (the contract inventory regenerates with them): ${census.rows.filter(r => r.class === 'candidate' && r.inventory).length}`)
  console.log(`  reads that come only from a .d.ts: ${census.rows.filter(r => r.typeSideOnly).length} · inline shell imports read: ${census.shellReads}`)
  console.log(`  modules read whole: by a child program or bundle entry composed in a string ${census.wholeReads.embeddedScripts} proof file(s) · by a proof enumerating exports through the AST ${census.wholeReads.exportScanners} file(s) · through a namespace binding a module exports ${census.wholeReads.exportedNamespaces}`)
  console.log(`  loads the census cannot resolve (a package, argv, a bundle or a scratch path — listed, never silent): ${census.unresolved.length}`)
  for (const u of census.unresolved) console.log(`    ${u.file}:${u.line}  ${u.text}`)
  mkdirSync(OUT_DIR, { recursive: true })
  const artifact = {
    schema: 1,
    generator: 'scripts/orphans/prove-export-census.ts',
    tally: t,
    unresolved: census.unresolved,
    rows: census.rows.filter(r => r.class !== 'read').map(r => ({ file: r.file, name: r.name, form: r.form, typeOnly: r.typeOnly, class: r.class, inventory: r.inventory })),
  }
  writeFileSync(OUT_JSON, JSON.stringify(artifact, null, 1) + '\n')
  console.log(`  wrote ${OUT_JSON.slice(GRAPH_ROOT.length + 1)} (${artifact.rows.length} unread rows)`)
  if (REPORT) {
    section('--report: every unread export, by class')
    for (const cls of [...Object.keys(KEPT_CLASSES), 'candidate'] as ExportClass[]) {
      const rows = census.rows.filter(r => r.class === cls)
      if (!rows.length) continue
      console.log(`\n  ${cls} (${rows.length})`)
      for (const r of rows) console.log(`    ${r.file}  ${r.name}${r.typeOnly ? '  (type)' : ''}${r.form !== 'declaration' ? `  [${r.form}]` : ''}${r.inventory ? '  {inventory}' : ''}`)
    }
  }
  return census
}

function ratchet(census: ExportCensus): void {
  section('§2 the ratchet: every export nothing imports sits in a named class — no candidate stands on the tree')
  const candidates = census.rows.filter(r => r.class === 'candidate')
  check(`zero candidates (found ${candidates.length})`, candidates.length === 0, candidates.slice(0, 40).map(r => `${r.file}:${r.name}`).join(', ') + (candidates.length > 40 ? ` … ${candidates.length - 40} more (--report lists them)` : ''))
  if (candidates.length) console.log('  the keyword goes by syntax: bun scripts/orphans/rewrite-unread-exports.ts <top-level folder>  (typecheck and build after every folder)')
}

console.log('============================================================')
console.log(' export census — every export nothing imports, in a named class')
console.log('============================================================')
selfTest()
const census = realCensus()
ratchet(census)
console.log(failures === 0 ? '\n✅ EXPORT CENSUS GREEN' : `\n❌ EXPORT CENSUS RED (${failures} failing check${failures === 1 ? '' : 's'})`)
process.exit(failures === 0 ? 0 : 1)
