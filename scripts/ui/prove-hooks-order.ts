#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-hooks-order.ts — the hooks-order ratchet (post-FLUX
//  crash fix).
//
//  React error #300 ("rendered fewer hooks than expected") killed a live
//  operator session: RoomManagerView + PaletteView called useSessionAccent
//  AFTER a conditional early return, so a mounted re-render down the other
//  branch changed the hook count. Sterile proofs missed it (the branch
//  flips on runtime state). This prover scans the WHOLE component estate
//  with the TypeScript AST and fails on either genuine shape:
//
//    V1 a conditional return with ANY hook call after it (same scope)
//    V2 a hook call in a conditionally-evaluated position (if/loop/case
//       bodies, ternary arms, the RIGHT operand of &&/||/??)
//
//  Inner function scopes are excluded (closures may return freely); hooks
//  as an if/ternary CONDITION or the LEFT operand of a logical operator
//  are unconditional and allowed. Documented build-time-constant branches
//  (dead-code elimination) are allowlisted BY FILE+HOOK below.
// ============================================================================

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'

const ROOT = join(import.meta.dir, '..', '..')
const SCAN = ['src/components', 'src/commands', 'src/screens', 'src/ink/components'].map(p =>
  join(ROOT, p),
)

// Documented build-constant DCE branches (lint-suppressed at the site):
// the condition folds at build time, so the hook call is never conditional
// at runtime. Keyed by repo-relative file + hook name.
const ALLOW = new Set([
  'src/components/MemoryUsageIndicator.tsx:useMemoryUsage',
  'src/screens/REPL.tsx:useTaskListWatcher',
  'src/screens/REPL.tsx:useProactive',
  // the documented ant-only DCE gate returns before its hook — the
  // condition folds at build time (lint-suppressed at the site)
  'src/components/MemoryUsageIndicator.tsx:__return__',
])

const files: string[] = []
function walk(d: string): void {
  for (const e of readdirSync(d)) {
    const p = join(d, e)
    const st = statSync(p)
    if (st.isDirectory()) walk(p)
    else if (/\.tsx?$/.test(e)) files.push(p)
  }
}
for (const r of SCAN) walk(r)

type Finding = { file: string; line: number; comp: string; msg: string }
const findings: Finding[] = []

for (const f of files) {
  const src = readFileSync(f, 'utf8')
  const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const rel = relative(ROOT, f)

  function componentName(node: ts.Node): string | null {
    if (ts.isFunctionDeclaration(node) && node.name && /^[A-Z]/.test(node.name.text)) return node.name.text
    if (
      (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
      ts.isVariableDeclaration(node.parent) &&
      ts.isIdentifier(node.parent.name) &&
      /^[A-Z]/.test(node.parent.name.text)
    )
      return node.parent.name.text
    return null
  }

  function analyze(fn: ts.FunctionLikeDeclaration, comp: string): void {
    if (!fn.body || !ts.isBlock(fn.body)) return
    type Ev = { kind: 'hook' | 'condReturn' | 'condHook'; pos: number; hook?: string }
    const evs: Ev[] = []
    function visit(n: ts.Node, d: number): void {
      if (
        ts.isFunctionDeclaration(n) ||
        ts.isArrowFunction(n) ||
        ts.isFunctionExpression(n) ||
        ts.isMethodDeclaration(n)
      )
        return
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && /^use[A-Z]/.test(n.expression.text)) {
        evs.push({ kind: d > 0 ? 'condHook' : 'hook', pos: n.getStart(), hook: n.expression.text })
        n.forEachChild(c => visit(c, d))
        return
      }
      if (ts.isReturnStatement(n) && d > 0) evs.push({ kind: 'condReturn', pos: n.getStart() })
      if (ts.isIfStatement(n)) {
        visit(n.expression, d)
        visit(n.thenStatement, d + 1)
        if (n.elseStatement) visit(n.elseStatement, d + 1)
        return
      }
      if (ts.isConditionalExpression(n)) {
        visit(n.condition, d)
        visit(n.whenTrue, d + 1)
        visit(n.whenFalse, d + 1)
        return
      }
      if (
        ts.isBinaryExpression(n) &&
        (n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          n.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
      ) {
        visit(n.left, d)
        visit(n.right, d + 1)
        return
      }
      if (ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n) || ts.isWhileStatement(n) || ts.isCaseClause(n)) {
        n.forEachChild(c => visit(c, d + 1))
        return
      }
      n.forEachChild(c => visit(c, d))
    }
    fn.body.forEachChild(c => visit(c, 0))

    const hookEvs = evs.filter(e => e.kind !== 'condReturn')
    if (hookEvs.length === 0) return
    const lastHookPos = Math.max(...hookEvs.map(e => e.pos))
    for (const e of evs) {
      const line = sf.getLineAndCharacterOfPosition(e.pos).line + 1
      if (e.kind === 'condHook' && !ALLOW.has(`${rel}:${e.hook}`)) {
        findings.push({ file: rel, line, comp, msg: `conditional hook ${e.hook}` })
      } else if (e.kind === 'condReturn' && e.pos < lastHookPos && !ALLOW.has(`${rel}:__return__`)) {
        findings.push({ file: rel, line, comp, msg: 'conditional return before later hooks' })
      }
    }
  }

  function top(n: ts.Node): void {
    const name = componentName(n)
    if (name && (ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n))) {
      analyze(n as ts.FunctionLikeDeclaration, name)
    }
    n.forEachChild(top)
  }
  top(sf)
}

console.log('── hooks-order ratchet (React #300 class) ──')
for (const x of findings) console.log(`  ✗ ${x.file}:${x.line} ${x.comp} — ${x.msg}`)
console.log(`  scanned ${files.length} files · ${findings.length} finding(s)`)
console.log(findings.length === 0 ? '✅ HOOKS-ORDER GREEN' : '❌ HOOKS-ORDER RED')
process.exit(findings.length === 0 ? 0 : 1)
