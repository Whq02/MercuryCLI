#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { GRAPH_ROOT } from './graph.ts'
import { runCensus, treeOptions } from './exportCensus.ts'

const REPORT = process.argv.includes('--report')
const UNUSED_CODES = new Set([6133, 6138, 6192, 6196, 6198, 6199, 6205])
const SCHEMA = 'src/utils/config/schema.ts'

const ALLOW: Array<{ key: string; reason: string }> = []
const allowed = new Map(ALLOW.map(a => [a.key, a.reason]))

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`)
}

type Dead = { key: string; what: string }
type CensusResult = { found: Dead[]; dead: Dead[] }

function unusedDeclarations(fileNames: string[], options: ts.CompilerOptions, root: string): Dead[] {
  const program = ts.createProgram(fileNames, { ...options, noUnusedLocals: true, noUnusedParameters: false, noEmit: true })
  const out: Dead[] = []
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || !sf.fileName.startsWith(root + '/')) continue
    for (const d of program.getSemanticDiagnostics(sf)) {
      if (!UNUSED_CODES.has(d.code) || d.start === undefined) continue
      const { line } = sf.getLineAndCharacterOfPosition(d.start)
      const text = ts.flattenDiagnosticMessageText(d.messageText, ' ')
      const name = text.match(/^'([^']+)'/)?.[1] ?? (d.code === 6192 ? '<every import of the declaration>' : text)
      out.push({ key: `${relative(root, sf.fileName)}:${name}`, what: `${relative(root, sf.fileName)}:${line + 1} ${name} (TS${d.code})` })
    }
  }
  return out
}

function treeProgramInputs(): { fileNames: string[]; options: ts.CompilerOptions } {
  const cfg = ts.readConfigFile(join(GRAPH_ROOT, 'tsconfig.json'), ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, GRAPH_ROOT)
  return { fileNames: parsed.fileNames, options: parsed.options }
}

function schemaKeys(text: string): string[] {
  const sf = ts.createSourceFile(SCHEMA, text, ts.ScriptTarget.Latest, true)
  const keys = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isPropertySignature(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) keys.add(node.name.text)
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return [...keys].sort()
}

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* walk(p)
    else if (/\.(ts|tsx)$/.test(e.name)) yield p
  }
}

function unreadKeys(keys: string[], readers: Array<{ file: string; text: string }>): string[] {
  return keys.filter(key => {
    const word = new RegExp(`(^|[^A-Za-z0-9_$])${key}([^A-Za-z0-9_$]|$)`)
    return !readers.some(r => word.test(r.text))
  })
}

function selfTest(): void {
  section('§0 self-test on a synthetic project: the checker names an unused import, local, function and type, and never an export')
  const root = mkdtempSync(join(tmpdir(), 'dead-exports-'))
  try {
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'b.ts'), ['export const read = 1', 'export const unreadExport = 2', 'export function helper(): number {', '  return read', '}', ''].join('\n'))
    writeFileSync(
      join(root, 'src', 'a.ts'),
      [
        "import { read, unreadImport } from './b.js'",
        'function usedFn(): number {',
        '  const kept = read',
        '  const unusedLocal = 2',
        '  return kept',
        '}',
        'function unusedFn(): void {}',
        'type UnusedType = string',
        'export const out = usedFn()',
        '',
      ].join('\n'),
    )
    const files = [join(root, 'src', 'a.ts'), join(root, 'src', 'b.ts')]
    const found = unusedDeclarations(files, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, skipLibCheck: true, types: [] }, root)
    const keys = found.map(f => f.key).sort()
    check('the unused import specifier is named', keys.includes('src/a.ts:unreadImport'), keys.join(', '))
    check('the unused local is named', keys.includes('src/a.ts:unusedLocal'))
    check('the unused function is named', keys.includes('src/a.ts:unusedFn'))
    check('the unused type alias is named', keys.includes('src/a.ts:UnusedType'))
    check('a used declaration, a used import and an exported name are never named', !keys.some(k => /:usedFn$|:read$|:kept$|:unreadExport$|:helper$|:out$/.test(k)), keys.join(', '))
    check('exactly those four', keys.length === 4, keys.join(', '))
    const schemaText = ['type A = {', '  readKey: number', '  unreadKey?: string', "  'quoted-key'?: boolean", '}', 'export type Config = A', ''].join('\n')
    const keysOut = schemaKeys(schemaText)
    check('every property signature of the schema is a key, quoted or bare', keysOut.join(',') === 'quoted-key,readKey,unreadKey', keysOut.join(','))
    const unread = unreadKeys(keysOut, [{ file: 'x.ts', text: 'const v = cfg.readKey + cfg["quoted-key"]' }])
    check('a key read by name is read, a key read nowhere is not, and a prefix match is no read', unread.join(',') === 'unreadKey', unread.join(','))
    check('readKeyed does not count as a read of readKey', unreadKeys(['readKey'], [{ file: 'x.ts', text: 'cfg.readKeyed' }]).join(',') === 'readKey')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function declarationCensus(): CensusResult {
  section('§1 every declaration under src/ that nothing reads: an import, a local, a function, a type (the checker with noUnusedLocals)')
  const { fileNames, options } = treeProgramInputs()
  const found = unusedDeclarations(fileNames, options, GRAPH_ROOT)
  const dead = found.filter(f => !allowed.has(f.key))
  console.log(`  program ${fileNames.length} files · unread declarations ${found.length} · allowed ${found.length - dead.length}`)
  check(`zero unread declarations (found ${dead.length})`, dead.length === 0, `\n    ${dead.slice(0, 60).map(d => d.what).join('\n    ')}${dead.length > 60 ? `\n    … ${dead.length - 60} more (--report lists them)` : ''}`)
  if (REPORT && dead.length) for (const d of dead) console.log(`    ${d.what}`)
  return { found, dead }
}

function exportCensus(): CensusResult {
  section('§2 every export under src/ and scripts/ that nothing imports, loads, names or scans (the export census classes)')
  const census = runCensus(treeOptions())
  const found = census.rows.filter(r => r.class === 'candidate').map(r => ({ key: `${r.file}:${r.name}`, what: `${r.file} ${r.name}${r.typeOnly ? ' (type)' : ''}` }))
  const dead = found.filter(f => !allowed.has(f.key))
  console.log(`  exports ${census.rows.length} · read ${census.tally.read} · unread in a named class ${census.rows.length - census.tally.read - census.tally.candidate}`)
  check(`zero exports nothing imports (found ${dead.length})`, dead.length === 0, `\n    ${dead.map(d => d.what).join('\n    ')}`)
  return { found, dead }
}

function settingsCensus(): CensusResult {
  section(`§3 every key the settings schema carries (${SCHEMA}) is read by name somewhere under src/`)
  const keys = schemaKeys(readFileSync(join(GRAPH_ROOT, SCHEMA), 'utf8'))
  const readers: Array<{ file: string; text: string }> = []
  for (const p of walk(join(GRAPH_ROOT, 'src'))) {
    const rel = relative(GRAPH_ROOT, p)
    if (rel === SCHEMA) continue
    readers.push({ file: rel, text: readFileSync(p, 'utf8') })
  }
  const found = unreadKeys(keys, readers).map(k => ({ key: `${SCHEMA}:${k}`, what: k }))
  const dead = found.filter(f => !allowed.has(f.key))
  console.log(`  keys ${keys.length} · readers ${readers.length} files`)
  check(`zero schema keys no code reads (found ${dead.length})`, dead.length === 0, dead.map(d => d.what).join(', '))
  return { found, dead }
}

function allowListIsHonest(results: CensusResult[]): void {
  section('§4 the allow list: every entry carries a reason and names something the censuses still find unread')
  if (ALLOW.length === 0) {
    console.log('  the allow list is empty: every declaration, export and settings key in the tree is read')
    return
  }
  const found = new Set(results.flatMap(r => r.found.map(f => f.key)))
  for (const a of ALLOW) {
    check(`${a.key} — a reason of at least 40 characters`, a.reason.length >= 40, `${a.reason.length} chars`)
    check(`${a.key} — still unread (a cured entry leaves the list)`, found.has(a.key))
  }
}

console.log('============================================================')
console.log(' the dead-code census: no declaration, export or settings key that nothing reads')
console.log('============================================================')
selfTest()
const r1 = declarationCensus()
const r2 = exportCensus()
const r3 = settingsCensus()
allowListIsHonest([r1, r2, r3])
const total = r1.dead.length + r2.dead.length + r3.dead.length
console.log(failures === 0 ? `\n✅ DEAD-CODE CENSUS GREEN — ${checks} checks, nothing unread` : `\n❌ DEAD-CODE CENSUS RED — ${total} unread (${r1.dead.length} declarations · ${r2.dead.length} exports · ${r3.dead.length} settings keys); ${failures} of ${checks} checks failed`)
process.exit(failures === 0 ? 0 : 1)
