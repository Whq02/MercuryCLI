#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const ROOT = join(import.meta.dir, '..', '..')

type FacadeExport = {
  name: string
  kind: 'value' | 'type'
  from: string
}

function scanFacade(root = ROOT): { exports: FacadeExport[]; extraStatements: string[] } {
  const facadePath = join(root, 'src', 'screen', 'themedRenderer.ts')
  const source = ts.createSourceFile(
    'ink.ts',
    readFileSync(facadePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  )
  const exports: FacadeExport[] = []
  const extraStatements: string[] = []
  const SANCTIONED_LOCALS = new Set(['themed', 'render', 'createRoot'])

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
    if (ts.isVariableStatement(stmt)) {
      const names = stmt.declarationList.declarations
        .map(d => (ts.isIdentifier(d.name) ? d.name.text : d.name.getText(source)))
        .join(', ')
      extraStatements.push(`variable ${names}`)
      continue
    }
    extraStatements.push(ts.SyntaxKind[stmt.kind])
  }
  exports.sort((a, b) => a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind))
  return { exports, extraStatements }
}

if (import.meta.main) {
  let failures = 0
  function check(label: string, cond: boolean, detail = ''): void {
    if (!cond) failures++
    console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  }

  console.log('bedrock facade inventory — src/screen/themedRenderer.ts')
  const { exports: scanned, extraStatements } = scanFacade()

  check(
    'facade law: no logic beyond re-exports + the theme wrap',
    extraStatements.length === 0,
    extraStatements.length > 0
      ? `${extraStatements.join(', ')} — move logic out of src/screen/themedRenderer.ts and re-export it`
      : '',
  )
  check('facade exports scanned', scanned.length > 0)

  if (failures > 0) {
    console.log(`\nbedrock facade inventory: RED (${failures} failure${failures === 1 ? '' : 's'})`)
    process.exit(1)
  }
  console.log(`\nbedrock facade inventory: green (${scanned.length} exports)`)
}
