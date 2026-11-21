#!/usr/bin/env bun
import { resolve } from 'node:path'
import ts from 'typescript'
import { runnerLaunches } from '../lib/runnerLaunches.ts'
import { declarationOf, importOf, lineOf, parseSource, rootDeclarationOf, stringText, unwrapAwait, visit } from './sourceCensus.ts'

const ROOT = resolve(import.meta.dir, '../..')
const modules = new Set(['assert', 'assert/strict', 'node:assert', 'node:assert/strict'])
type Binding = 'module' | 'namespace' | 'ok'

function member(binding: Binding | undefined, key: string | undefined): Binding | undefined {
  if (!binding || binding === 'ok') return undefined
  if (key === 'ok') return 'ok'
  if (key === 'default' || key === 'strict') return 'module'
  return undefined
}

function assertBinding(expression: ts.Expression, seen = new Set<ts.Node>()): Binding | undefined {
  const e = unwrapAwait(expression)
  if (ts.isPropertyAccessExpression(e)) return member(assertBinding(e.expression, seen), e.name.text)
  if (ts.isElementAccessExpression(e)) return member(assertBinding(e.expression, seen), stringText(e.argumentExpression))
  if (ts.isCallExpression(e)) {
    const spec = e.arguments[0] && stringText(e.arguments[0])
    if (!spec || !modules.has(spec)) return undefined
    if (e.expression.kind === ts.SyntaxKind.ImportKeyword) return 'namespace'
    if (ts.isIdentifier(e.expression) && e.expression.text === 'require' && !declarationOf(e.expression)) return 'module'
    return undefined
  }
  if (!ts.isIdentifier(e)) return undefined
  const d = declarationOf(e)
  if (!d || seen.has(d)) return undefined
  seen.add(d)
  const ref = importOf(d)
  if (ref) return modules.has(ref.module) ? member('namespace', ref.name) : undefined
  if (ts.isNamespaceImport(d)) {
    const spec = stringText(d.parent.parent.moduleSpecifier)
    return spec && modules.has(spec) ? 'namespace' : undefined
  }
  const base = ts.isBindingElement(d) ? rootDeclarationOf(d) : d
  if (!base || !ts.isVariableDeclaration(base) || !base.initializer || !(base.parent.flags & ts.NodeFlags.Const)) return undefined
  const binding = assertBinding(base.initializer, seen)
  if (ts.isVariableDeclaration(d)) return binding
  if (!ts.isBindingElement(d) || !ts.isObjectBindingPattern(d.parent) || base.name !== d.parent) return undefined
  const key = d.propertyName ?? d.name
  return member(binding, ts.isIdentifier(key) ? key.text : stringText(key))
}

function bareLines(source: ts.SourceFile): number[] {
  const lines: number[] = []
  let usesAssert = false
  visit(source, n => {
    if (ts.isStringLiteralLike(n) && modules.has(n.text)) usesAssert = true
  })
  if (!usesAssert) return lines
  visit(source, n => {
    if (!ts.isCallExpression(n) || n.arguments.length !== 1 || ts.isSpreadElement(n.arguments[0]!)) return
    const binding = assertBinding(n.expression)
    if (binding === 'module' || binding === 'ok') lines.push(lineOf(n))
  })
  return lines
}

const example = ts.createSourceFile('example.ts', [
  "import truth, { ok as okay, strictEqual } from 'node:assert/strict'",
  "import * as suite from 'assert'",
  "const { ok: required } = require('node:assert')",
  "const { strict: loaded } = await import('assert/strict')",
  'const alias = truth.ok',
  'truth(false); okay(false); suite.ok(false); required(false); loaded(false); alias(false)',
  "truth(false, 'expected the selected row'); strictEqual(1, 2)",
  'function shadow(truth: (value: boolean) => void) { truth(true) }',
  'const other = { ok(x: boolean) { return x } }; other.ok(false)',
].join('\n'), ts.ScriptTarget.Latest, true)
const planted = bareLines(example)
if (planted.length !== 6 || planted.some(line => line !== 6)) {
  throw new Error(`scripts/gate/prove-assert-diagnostics.ts: resolve the Node assertion bindings in the fixture; expected six calls on line 6, got ${planted.join(', ')}`)
}

const files = new Set(runnerLaunches(ROOT).flatMap(row => row.launched))
let hits = 0
for (const file of files) {
  if (!/\.[cm]?[jt]sx?$/.test(file)) continue
  for (const line of bareLines(parseSource(ROOT, resolve(ROOT, file)).sf)) {
    hits++
    if (hits <= 50) console.error(`${file}:${line}: add a failure message to this Node assertion naming the expected behavior and where to correct it`)
  }
}
if (hits > 50) console.error(`and ${hits - 50} more`)
console.log(`prove-assert-diagnostics: ${hits} bare one-argument Node assertions; allowed 0`)
process.exitCode = hits === 0 ? 0 : 1
