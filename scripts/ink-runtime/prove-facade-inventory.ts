#!/usr/bin/env bun
// ============================================================================
//  scripts/ink-runtime/prove-facade-inventory.ts —
//  freeze the public terminal facade.
//
//  Statically scans `src/ink.ts` (the ONE public terminal surface) with the
//  TypeScript AST — no module evaluation — and pins every export name, its
//  kind (value | type), and its source module against the recorded
//  `facade-inventory.json`. Self-accounting both ways (the R2 oracle
//  pattern): a recorded export DISAPPEARING fails, and a NEW unrecorded
//  export fails, so the surface can never silently rot during the cutover.
//
//  Also pins the facade LAW: src/ink.ts stays
//  logic-free — re-exports plus the ThemeProvider wrap only. Any statement
//  beyond imports/exports/the two wrap functions fails.
//
//  Run:            ~/.bun/bin/bun run scripts/ink-runtime/prove-facade-inventory.ts
//  Regen (review): … --record
// ============================================================================
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const ROOT = join(import.meta.dir, '..', '..')
const FACADE = join(ROOT, 'src', 'ink.ts')
const INVENTORY = join(import.meta.dir, 'facade-inventory.json')
const record = process.argv.includes('--record')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

type FacadeExport = {
  name: string
  kind: 'value' | 'type'
  from: string // source module specifier ('' = declared in the facade itself)
}

function scanFacade(): { exports: FacadeExport[]; extraStatements: string[] } {
  const source = ts.createSourceFile(
    'ink.ts',
    readFileSync(FACADE, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  )
  const exports: FacadeExport[] = []
  const extraStatements: string[] = []
  // The two sanctioned local declarations: the theme-wrap helper and the
  // wrapped render/createRoot entry points it powers.
  const SANCTIONED_LOCALS = new Set(['withTheme', 'render', 'createRoot'])

  for (const stmt of source.statements) {
    if (ts.isImportDeclaration(stmt)) continue
    if (ts.isExportDeclaration(stmt)) {
      const from = stmt.moduleSpecifier
        ? (stmt.moduleSpecifier as ts.StringLiteral).text
        : ''
      const typeOnlyClause = stmt.isTypeOnly
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          exports.push({
            name: el.name.text,
            kind: typeOnlyClause || el.isTypeOnly ? 'type' : 'value',
            from,
          })
        }
      } else {
        extraStatements.push(`star-export from ${from}`)
      }
      continue
    }
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      const name = stmt.name.text
      const isExported = stmt.modifiers?.some(
        m => m.kind === ts.SyntaxKind.ExportKeyword,
      )
      if (isExported) exports.push({ name, kind: 'value', from: '' })
      if (!SANCTIONED_LOCALS.has(name)) {
        extraStatements.push(`function ${name}`)
      }
      continue
    }
    if (ts.isTypeAliasDeclaration(stmt) || ts.isInterfaceDeclaration(stmt)) {
      const isExported = stmt.modifiers?.some(
        m => m.kind === ts.SyntaxKind.ExportKeyword,
      )
      if (isExported) exports.push({ name: stmt.name.text, kind: 'type', from: '' })
      continue
    }
    extraStatements.push(ts.SyntaxKind[stmt.kind])
  }
  exports.sort((a, b) => a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind))
  return { exports, extraStatements }
}

console.log('bedrock facade inventory — src/ink.ts')
const { exports: scanned, extraStatements } = scanFacade()

check(
  'facade law: no logic beyond re-exports + the theme wrap',
  extraStatements.length === 0,
  extraStatements.join(', '),
)

if (record) {
  writeFileSync(INVENTORY, JSON.stringify({ exports: scanned }, null, 2) + '\n')
  console.log(`  recorded ${scanned.length} exports → ${INVENTORY}`)
} else {
  check('inventory file exists (run --record once)', existsSync(INVENTORY))
  if (existsSync(INVENTORY)) {
    const recorded: FacadeExport[] = JSON.parse(readFileSync(INVENTORY, 'utf8')).exports
    const key = (e: FacadeExport) => `${e.name}|${e.kind}|${e.from}`
    const scannedSet = new Set(scanned.map(key))
    const recordedSet = new Set(recorded.map(key))
    const missing = recorded.filter(e => !scannedSet.has(key(e)))
    const unrecorded = scanned.filter(e => !recordedSet.has(key(e)))
    check(
      `no recorded export disappeared (${recorded.length} recorded)`,
      missing.length === 0,
      missing.map(e => `${e.name} (${e.kind} from '${e.from}')`).join(', '),
    )
    check(
      'no unrecorded export appeared (self-accounting)',
      unrecorded.length === 0,
      unrecorded.map(e => `${e.name} (${e.kind} from '${e.from}')`).join(', '),
    )
  }
}

if (failures > 0) {
  console.log(`\nbedrock facade inventory: RED (${failures} failure${failures === 1 ? '' : 's'})`)
  process.exit(1)
}
console.log('\nbedrock facade inventory: green')
