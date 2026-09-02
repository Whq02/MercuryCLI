// decompile-react-compiler — batch _c de-compile.
//
// Inverts React-Compiler memo-cache output to plain straight-line code:
//   - every `if (<test referencing $[n]>) { COMPUTE; $[k]=…; } else { x = $[k]; }`
//     becomes COMPUTE with the `$[k] = …;` cache-write statements stripped and the
//     else (cache-read) branch dropped — i.e. ALWAYS take the recompute branch,
//     which is the compiler's own semantic contract (memoization is transparent);
//   - `const $ = _c(N);` declarations and the `react/compiler-runtime` import go.
//
// SURGICAL: edits are position-based string splices driven by the TS AST, so all
// untouched text stays byte-identical (reviewable diffs). Nested cache blocks are
// processed innermost-first across repeated passes. HARD BAIL (file reported, not
// written) if any `$[` or `_c(` survives — deviant shapes go to the hand list.
//
// Usage: bun run scripts/codemod/decompile-react-compiler.ts [--write] <file...>
//        (default is a dry run listing OK/BAIL per file)

import { readFileSync, writeFileSync } from 'node:fs'
import ts from 'typescript'

const args = process.argv.slice(2)
const write = args.includes('--write')
const files = args.filter(a => a !== '--write')

type Splice = { start: number; end: number; text: string }

/** One innermost-first pass. Returns the new source, or null when no $-if found. */
function pass(source: string, fileName: string): string | null {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const candidates: ts.IfStatement[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isIfStatement(node)) {
      const test = node.expression.getText(sf)
      if (test.includes('$[')) candidates.push(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  if (candidates.length === 0) return null

  // Innermost-first: only splice ifs whose CONSEQUENT contains no nested $-if.
  const innermost = candidates.filter(c => {
    const [start, end] = [c.getStart(sf), c.getEnd()]
    return !candidates.some(
      other => other !== c && other.getStart(sf) > start && other.getEnd() <= end,
    )
  })

  const splices: Splice[] = []
  for (const ifStmt of innermost) {
    if (!ts.isBlock(ifStmt.thenStatement)) return source // deviant → bail via survivor check
    const kept: string[] = []
    for (const stmt of ifStmt.thenStatement.statements) {
      // Strip pure cache-write statements: `$[n] = <expr>;`
      if (
        ts.isExpressionStatement(stmt) &&
        ts.isBinaryExpression(stmt.expression) &&
        stmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isElementAccessExpression(stmt.expression.left) &&
        stmt.expression.left.expression.getText(sf) === '$'
      ) {
        continue
      }
      kept.push(stmt.getFullText(sf))
    }
    splices.push({
      start: ifStmt.getStart(sf),
      end: ifStmt.getEnd(),
      text: kept.join('').replace(/^\s*\n/, '').trimEnd(),
    })
  }

  // Apply back-to-front so positions stay valid.
  splices.sort((a, b) => b.start - a.start)
  let out = source
  for (const s of splices) out = out.slice(0, s.start) + s.text + out.slice(s.end)
  return out
}

function stripDeclarations(source: string): string {
  return source
    .split('\n')
    .filter(
      line =>
        !/^\s*import \{ c as _c \} from ["']react\/compiler-runtime["'];?\s*$/.test(line) &&
        !/^\s*const \$ = _c\(\d+\);?\s*$/.test(line),
    )
    .join('\n')
}

/** AST-precise survivor check: any CODE use of `$[…]` or `_c(…)` (comments don't count). */
function hasCacheResidue(source: string, fileName: string): boolean {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === '$'
    ) {
      found = true
      return
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === '_c'
    ) {
      found = true
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

let okCount = 0
const bailed: string[] = []
for (const file of files) {
  const original = readFileSync(file, 'utf8')
  let current = original
  for (let i = 0; i < 60; i++) {
    const next = pass(current, file)
    if (next === null) break
    if (next === current) break // no progress (deviant shape) — survivor check bails
    current = next
  }
  current = stripDeclarations(current)
  if (hasCacheResidue(current, file)) {
    bailed.push(file)
    console.log(`BAIL ${file}`)
    continue
  }
  okCount++
  if (write) {
    writeFileSync(file, current)
    console.log(`OK   ${file}`)
  } else {
    console.log(`DRY  ${file}`)
  }
}
console.log(`\n${okCount} ok, ${bailed.length} bailed${write ? ' (written)' : ' (dry run)'}`)
if (bailed.length > 0) {
  console.log('bailed files:')
  for (const b of bailed) console.log(`  ${b}`)
}
