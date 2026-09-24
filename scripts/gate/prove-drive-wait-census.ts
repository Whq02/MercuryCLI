#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'
import {
  ModuleCache,
  callSites,
  calleeName,
  declarationOf,
  functionOf,
  importOf,
  importTarget,
  importedDeclaration,
  isFunctionNode,
  isReference,
  lineOf,
  namedFunctionDecl,
  parseSource,
  returnedExpressions,
  slash,
  stringText,
  textOf,
  unwrap,
  unwrapAwait,
  visit,
  walkProofs,
  type Source,
} from './sourceCensus.ts'

const REAL_ROOT = resolve(import.meta.dir, '..', '..')
const REPORT = process.argv.includes('--report')

const LAUNCHERS = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync'])
const KNOB_NAMES = new Set(['vshotBudgetMs', 'vshotBudgetScale'])
const CAPTURE_MODULE = /(?:^|\/)captureDriver(?:\.ts)?$/
const CAPTURE_PLAIN_EXPORTS = new Set(['vshotBudgetMs', 'vshotBudgetScale', 'findOnPath'])
const FIXTURE_MAKERS = new Set(['startScriptedFixture', 'startFixture', 'startFixtureApi', 'startCrewStopFixture', 'createServer', 'serve'])
const KIND_FIELDS = new Set(['type', 'subtype', 'kind', 'is_error'])
const KIND_HELPERS = new Map([
  ['isResult', 'result'],
  ['isInit', 'system:init'],
])
const EQUALITY = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken])
const POSITIVE = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken])
const COMPARE = new Set([ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken])
const MOVED = new Set([...COMPARE, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken])
const TURN_TEXT = /\bwait[A-Za-z]*\s*\(|\bsend\s*\(|\.submit\s*\(|\brunScriptedTurn\s*\(/
const FOR_SEQ = /\bfor\s+\w+\s+in\s+\$\(\s*seq\s+([^)]*)\)\s*;?\s*do\b([\s\S]*?)\bdone\b/g
const WHILE_LOOP = /\b(?:while|until)\s+([\s\S]*?);\s*do\b([\s\S]*?)\bdone\b/g

type Pred = { kindOnly: boolean; kinds: string[]; params: number }
type Stream = { decl?: ts.Node; scope?: ts.Node }
type Start = { call: ts.CallExpression; stream: Stream; user: boolean }
type Wait = { call: ts.CallExpression; label: string; pred: Pred; budget?: ts.Expression; after?: ts.Expression; stream: Stream }
type Flow = { turn: boolean; open: boolean; gap: boolean }
type Step = { pos: number; effect: 'start' | 'settle' | 'active' | 'call'; call?: ts.CallExpression; fn?: ts.FunctionLikeDeclaration }
type Summary = { start: boolean; open: boolean; active: boolean; streams: Stream[] }
const FRESH: Flow = { turn: false, open: false, gap: false }
export type WaitHit = { file: string; line: number; rule: 'a' | 'b'; detail: string }
export type Pause = { file: string; line: number; text: string }

function contains(outer: ts.Node, inner: ts.Node): boolean {
  return inner.pos >= outer.pos && inner.end <= outer.end && inner.getSourceFile() === outer.getSourceFile()
}

function enclosingFunction(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
  for (let cur = node.parent; cur; cur = cur.parent) if (isFunctionNode(cur)) return cur
  return undefined
}

function blockScopeOf(decl: ts.Node): ts.Node | undefined {
  for (let cur = decl.parent; cur; cur = cur.parent) if (ts.isBlock(cur) || ts.isSourceFile(cur) || ts.isModuleBlock(cur)) return cur
  return undefined
}

function rootDecl(e: ts.Expression): ts.Node | undefined {
  let x = unwrapAwait(e)
  while (ts.isPropertyAccessExpression(x) || ts.isElementAccessExpression(x)) x = unwrapAwait(x.expression)
  return ts.isIdentifier(x) ? declarationOf(x) : undefined
}

function streamOfCallee(callee: ts.Expression): Stream {
  if (ts.isPropertyAccessExpression(callee)) return { decl: rootDecl(callee.expression) }
  if (ts.isIdentifier(callee)) {
    const d = declarationOf(callee)
    return { scope: d ? blockScopeOf(d) : undefined }
  }
  return {}
}

function sameStream(a: Stream, b: Stream): boolean {
  return (a.decl !== undefined && a.decl === b.decl) || (a.scope !== undefined && a.scope === b.scope)
}

function streamInside(stream: Stream, outer: ts.Node): boolean {
  const anchor = stream.decl ?? stream.scope
  return anchor !== undefined && contains(outer, anchor)
}

function isUserFrame(e: ts.Expression, depth = 0): boolean {
  const x = unwrap(e)
  if (ts.isCallExpression(x)) return calleeName(x) === 'user'
  if (ts.isObjectLiteralExpression(x)) return x.properties.some(p => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'type' && stringText(unwrap(p.initializer)) === 'user')
  if (ts.isIdentifier(x) && depth < 2) {
    const d = declarationOf(x)
    return d !== undefined && ts.isVariableDeclaration(d) && d.initializer !== undefined && isUserFrame(d.initializer, depth + 1)
  }
  return false
}

function isDateNow(e: ts.Expression): boolean {
  const x = unwrap(e)
  return ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression) && x.expression.name.text === 'now' && ts.isIdentifier(x.expression.expression) && x.expression.expression.text === 'Date'
}

function addedToNow(init: ts.Expression): ts.Expression | undefined {
  const x = unwrap(init)
  if (!ts.isBinaryExpression(x) || x.operatorToken.kind !== ts.SyntaxKind.PlusToken) return undefined
  if (isDateNow(x.left)) return x.right
  if (isDateNow(x.right)) return x.left
  return undefined
}

function budgetOfComparison(b: ts.BinaryExpression): ts.Expression | undefined {
  if (!COMPARE.has(b.operatorToken.kind)) return undefined
  for (const [side, other] of [
    [b.left, b.right],
    [b.right, b.left],
  ] as const) {
    const s = unwrap(side)
    if (isDateNow(s)) {
      const o = unwrap(other)
      if (!ts.isIdentifier(o)) continue
      const d = declarationOf(o)
      const extra = d && ts.isVariableDeclaration(d) && d.initializer ? addedToNow(d.initializer) : undefined
      if (extra) return extra
      continue
    }
    if (ts.isBinaryExpression(s) && s.operatorToken.kind === ts.SyntaxKind.MinusToken && isDateNow(s.left)) return other
  }
  return undefined
}

function budgetOfLoop(loop: ts.IterationStatement): ts.Expression | undefined {
  const parts: ts.Node[] = [loop.statement]
  if (ts.isForStatement(loop)) {
    if (loop.initializer) parts.unshift(loop.initializer)
    if (loop.condition) parts.unshift(loop.condition)
    if (loop.incrementor) parts.push(loop.incrementor)
  } else if (ts.isWhileStatement(loop) || ts.isDoStatement(loop)) parts.unshift(loop.expression)
  let found: ts.Expression | undefined
  for (const part of parts) {
    visit(part, n => {
      if (!found && ts.isBinaryExpression(n)) found = budgetOfComparison(n)
    }, true)
    if (found) return found
  }
  if (ts.isForStatement(loop) && loop.initializer && ts.isVariableDeclarationList(loop.initializer) && loop.condition) {
    const counters = new Set<ts.Node>(loop.initializer.declarations.filter(d => d.initializer !== undefined && ts.isNumericLiteral(unwrap(d.initializer))))
    visit(loop.condition, n => {
      if (found || !ts.isBinaryExpression(n)) return
      const op = n.operatorToken.kind
      const left = unwrap(n.left)
      if ((op === ts.SyntaxKind.LessThanToken || op === ts.SyntaxKind.LessThanEqualsToken) && ts.isIdentifier(left)) {
        const d = declarationOf(left)
        if (d && counters.has(d)) found = n.right
      }
    }, true)
  }
  return found
}

function loopAround(node: ts.Node): ts.IterationStatement | undefined {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (isFunctionNode(cur)) return undefined
    if (ts.isIterationStatement(cur, false)) return cur
  }
  return undefined
}

function inFixture(node: ts.Node): boolean {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (!(ts.isArrowFunction(cur) || ts.isFunctionExpression(cur))) continue
    let up: ts.Node = cur.parent
    while (ts.isPropertyAssignment(up) || ts.isObjectLiteralExpression(up) || ts.isArrayLiteralExpression(up) || ts.isParenthesizedExpression(up)) up = up.parent
    if (ts.isCallExpression(up)) {
      const name = calleeName(up)
      if (name && FIXTURE_MAKERS.has(name)) return true
    }
  }
  return false
}

function overlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}:`) || b.startsWith(`${a}:`)
}

class Estate {
  readonly modules: ModuleCache
  private readonly runners = new Map<string, boolean>()
  private readonly knobs = new Map<ts.Node, boolean>()
  private readonly sleepers = new Map<ts.Node, boolean>()
  constructor(readonly root: string) {
    this.modules = new ModuleCache(root)
  }

  private captureResolver(decl: ts.Node): boolean {
    const ref = importOf(decl)
    return ref !== undefined && CAPTURE_MODULE.test(ref.module) && !CAPTURE_PLAIN_EXPORTS.has(ref.name)
  }

  private reachesProduct(node: ts.Node, depth: number): boolean {
    let hit = false
    visit(node, n => {
      if (hit) return
      if (ts.isIdentifier(n) && isReference(n)) {
        if (n.text === 'DIST') {
          hit = true
          return
        }
        const d = declarationOf(n)
        if (!d) return
        if (this.captureResolver(d)) {
          hit = true
          return
        }
        if (depth < 3 && ts.isVariableDeclaration(d) && d.initializer && !contains(d, n) && this.reachesProduct(d.initializer, depth + 1)) hit = true
        return
      }
      const lit = stringText(n)
      if (lit !== undefined && lit.includes('mercury.mjs')) hit = true
    })
    return hit
  }

  launches(sf: ts.SourceFile): boolean {
    let hit = false
    visit(sf, n => {
      if (hit || !ts.isCallExpression(n)) return
      const name = calleeName(n)
      if (name && LAUNCHERS.has(name) && n.arguments.some(a => this.reachesProduct(a, 0))) hit = true
    })
    return hit
  }

  valueImports(src: Source): string[] {
    const out: string[] = []
    const add = (spec: string): void => {
      const target = importTarget(src.path, spec)
      if (target) out.push(target)
    }
    for (const s of src.sf.statements) {
      if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier)) continue
      const clause = s.importClause
      if (clause?.isTypeOnly) continue
      const named = clause?.namedBindings
      const typesOnly = clause !== undefined && clause.name === undefined && named !== undefined && ts.isNamedImports(named) && named.elements.length > 0 && named.elements.every(el => el.isTypeOnly)
      if (!typesOnly) add(s.moduleSpecifier.text)
    }
    visit(src.sf, n => {
      if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) add(n.arguments[0].text)
    })
    return out
  }

  isRunner(path: string, stack: Set<string> = new Set()): boolean {
    const known = this.runners.get(path)
    if (known !== undefined) return known
    if (stack.has(path)) return false
    stack.add(path)
    const src = this.modules.get(path)
    const out = src !== null && (this.launches(src.sf) || this.valueImports(src).some(p => this.isRunner(p, stack)))
    stack.delete(path)
    this.runners.set(path, out)
    return out
  }

  driveReason(src: Source): string | null {
    if (this.launches(src.sf)) return 'launches the built product'
    const via = this.valueImports(src).find(p => this.isRunner(p))
    return via ? `imports the runner ${slash(relative(this.root, via))}` : null
  }

  knobFunction(decl: ts.Node | undefined, depth = 0): boolean {
    if (!decl || depth > 3) return false
    const known = this.knobs.get(decl)
    if (known !== undefined) return known
    this.knobs.set(decl, false)
    const ref = importOf(decl)
    let out = ref !== undefined && KNOB_NAMES.has(ref.name)
    if (!out) {
      const fn = functionOf(ref ? importedDeclaration(this.modules, decl) : decl)
      if (fn?.body) {
        visit(fn.body, n => {
          if (!out && ts.isCallExpression(n)) out = this.knobCall(n, depth + 1)
        })
      }
    }
    this.knobs.set(decl, out)
    return out
  }

  knobCall(call: ts.CallExpression, depth = 0): boolean {
    const callee = unwrap(call.expression)
    if (ts.isPropertyAccessExpression(callee)) return KNOB_NAMES.has(callee.name.text)
    return ts.isIdentifier(callee) && this.knobFunction(declarationOf(callee), depth)
  }

  private promisedTimeout(n: ts.NewExpression): boolean {
    if (!ts.isIdentifier(n.expression) || n.expression.text !== 'Promise' || !n.arguments || n.arguments.length !== 1) return false
    const executor = unwrap(n.arguments[0]!)
    if (!(ts.isArrowFunction(executor) || ts.isFunctionExpression(executor)) || executor.parameters.length !== 1) return false
    const resolve = executor.parameters[0]!.name
    if (!ts.isIdentifier(resolve)) return false
    const timer = soleExpression(executor.body)
    if (!timer || !ts.isCallExpression(timer) || calleeName(timer) !== 'setTimeout' || timer.arguments.length !== 2) return false
    const cb = unwrap(timer.arguments[0]!)
    if (ts.isIdentifier(cb)) return cb.text === resolve.text
    if (!(ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) return false
    const settle = soleExpression(cb.body)
    return settle !== undefined && ts.isCallExpression(settle) && ts.isIdentifier(unwrap(settle.expression)) && (unwrap(settle.expression) as ts.Identifier).text === resolve.text
  }

  isSleep(e: ts.Expression): boolean {
    const x = unwrap(e)
    if (ts.isNewExpression(x)) return this.promisedTimeout(x)
    if (!ts.isCallExpression(x)) return false
    const callee = unwrap(x.expression)
    if (ts.isPropertyAccessExpression(callee)) return ts.isIdentifier(callee.expression) && callee.expression.text === 'Bun' && callee.name.text === 'sleep'
    if (!ts.isIdentifier(callee)) return false
    const d = declarationOf(callee)
    if (!d) return callee.text === 'sleep'
    const known = this.sleepers.get(d)
    if (known !== undefined) return known
    const ref = importOf(d)
    if (ref && /(?:^|:)timers\/promises$/.test(ref.module) && ref.name === 'setTimeout') return true
    const fn = functionOf(ref ? importedDeclaration(this.modules, d) : d)
    const out = fn ? returnedExpressions(fn).some(r => {
      const u = unwrap(r)
      return ts.isNewExpression(u) && this.promisedTimeout(u)
    }) : callee.text === 'sleep'
    this.sleepers.set(d, out)
    return out
  }
}

function soleExpression(body: ts.ConciseBody): ts.Expression | undefined {
  let e: ts.Expression | undefined
  if (ts.isBlock(body)) {
    const only = body.statements.length === 1 ? body.statements[0] : undefined
    e = only && ts.isExpressionStatement(only) ? only.expression : undefined
  } else e = body
  if (!e) return undefined
  const x = unwrap(e)
  return ts.isVoidExpression(x) ? unwrap(x.expression) : x
}

function termsOf(e: ts.Expression): ts.Expression[] {
  const x = unwrap(e)
  if (ts.isBinaryExpression(x) && (x.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || x.operatorToken.kind === ts.SyntaxKind.BarBarToken)) return [...termsOf(x.left), ...termsOf(x.right)]
  return [x]
}

function countersOf(loop: ts.IterationStatement): Set<ts.Node> {
  const out = new Set<ts.Node>()
  if (ts.isForStatement(loop) && loop.initializer && ts.isVariableDeclarationList(loop.initializer)) for (const d of loop.initializer.declarations) out.add(d)
  return out
}

function budgetTerm(e: ts.Expression, counters: Set<ts.Node>): boolean {
  const x = unwrap(e)
  if (!ts.isBinaryExpression(x) || !COMPARE.has(x.operatorToken.kind)) return false
  if (budgetOfComparison(x) !== undefined) return true
  for (const side of [x.left, x.right]) {
    const s = unwrap(side)
    if (ts.isIdentifier(s)) {
      const d = declarationOf(s)
      if (d && counters.has(d)) return true
    }
  }
  return false
}

function waitsOnSomething(loop: ts.IterationStatement): boolean {
  const cond = ts.isForStatement(loop) ? loop.condition : ts.isWhileStatement(loop) || ts.isDoStatement(loop) ? loop.expression : undefined
  if (cond && unwrap(cond).kind !== ts.SyntaxKind.TrueKeyword) {
    const counters = countersOf(loop)
    if (termsOf(cond).some(t => !budgetTerm(t, counters))) return true
  }
  let exits = false
  visit(loop.statement, n => {
    if (exits) return
    if (ts.isReturnStatement(n)) exits = true
    else if (ts.isBreakStatement(n)) {
      let target: ts.Node | undefined = n.parent
      while (target && !ts.isIterationStatement(target, false) && !ts.isSwitchStatement(target)) target = target.parent
      if (n.label !== undefined || target === loop) exits = true
    }
  }, true)
  return exits
}

function ownerOf(node: ts.Node): ts.Node {
  return enclosingFunction(node) ?? node.getSourceFile()
}

function worse(a: Flow, b: Flow): Flow {
  return { turn: a.turn || b.turn, open: a.open || b.open, gap: a.gap || b.gap }
}

function singleReturn(block: ts.Block): ts.Expression | undefined {
  const only = block.statements.length === 1 ? block.statements[0] : undefined
  return only && ts.isReturnStatement(only) ? only.expression : undefined
}

function isParam(e: ts.Expression, p: string): boolean {
  const x = unwrap(e)
  return ts.isIdentifier(x) && x.text === p
}

function kindField(e: ts.Expression, p: string): string | undefined {
  const x = unwrap(e)
  return ts.isPropertyAccessExpression(x) && KIND_FIELDS.has(x.name.text) && isParam(x.expression, p) ? x.name.text : undefined
}

function isLiteral(e: ts.Expression): boolean {
  const x = unwrap(e)
  return stringText(x) !== undefined || ts.isNumericLiteral(x) || x.kind === ts.SyntaxKind.TrueKeyword || x.kind === ts.SyntaxKind.FalseKeyword || x.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(x) && x.text === 'undefined')
}

function predicateOf(e: ts.Expression, estate: Estate, depth: number): Pred | null {
  if (depth > 3) return null
  const x = unwrap(e)
  if (ts.isArrowFunction(x) || ts.isFunctionExpression(x)) return analyzeFn(x, estate, depth)
  if (ts.isIdentifier(x)) {
    const d = declarationOf(x)
    if (!d) return null
    const ref = importOf(d)
    const helper = ref ? KIND_HELPERS.get(ref.name) : undefined
    if (helper !== undefined) return { kindOnly: true, kinds: [helper], params: 1 }
    const fn = functionOf(ref ? importedDeclaration(estate.modules, d) : d)
    return fn ? analyzeFn(fn, estate, depth + 1) : null
  }
  if (ts.isCallExpression(x)) {
    const callee = unwrap(x.expression)
    const fn = ts.isIdentifier(callee) ? functionOf(declarationOf(callee)) : undefined
    const made = fn ? returnedExpressions(fn).map(r => unwrap(r)).find(r => ts.isArrowFunction(r) || ts.isFunctionExpression(r)) : undefined
    return made ? { ...analyzeFn(made as ts.FunctionLikeDeclaration, estate, depth + 1), kindOnly: false } : null
  }
  return null
}

function analyzeFn(fn: ts.FunctionLikeDeclaration, estate: Estate, depth: number): Pred {
  const params = fn.parameters.length
  const first = fn.parameters[0]?.name
  if (!first || !ts.isIdentifier(first)) return { kindOnly: false, kinds: [], params }
  const body = fn.body
  const expr = body === undefined ? undefined : ts.isBlock(body) ? singleReturn(body) : body
  if (!expr) return { kindOnly: false, kinds: body ? kindsIn(body, first.text, estate, depth) : [], params }
  return { kindOnly: kindTest(expr, first.text, estate, depth), kinds: kindsIn(expr, first.text, estate, depth), params }
}

function kindTest(e: ts.Expression, p: string, estate: Estate, depth: number): boolean {
  const x = unwrap(e)
  if (ts.isBinaryExpression(x)) {
    const op = x.operatorToken.kind
    if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) return kindTest(x.left, p, estate, depth) && kindTest(x.right, p, estate, depth)
    if (EQUALITY.has(op)) return (kindField(x.left, p) !== undefined && isLiteral(x.right)) || (kindField(x.right, p) !== undefined && isLiteral(x.left))
    return false
  }
  if (ts.isPrefixUnaryExpression(x) && x.operator === ts.SyntaxKind.ExclamationToken) return kindTest(x.operand, p, estate, depth)
  if (ts.isCallExpression(x) && x.arguments.length === 1 && isParam(x.arguments[0]!, p)) {
    const helper = predicateOf(x.expression, estate, depth + 1)
    return helper !== null && helper.kindOnly
  }
  return x.kind === ts.SyntaxKind.TrueKeyword
}

function kindsIn(e: ts.Node, p: string, estate: Estate, depth: number): string[] {
  const types: string[] = []
  const subtypes: string[] = []
  const helped: string[] = []
  visit(e, n => {
    if (ts.isBinaryExpression(n) && POSITIVE.has(n.operatorToken.kind)) {
      for (const [side, other] of [
        [n.left, n.right],
        [n.right, n.left],
      ] as const) {
        const field = kindField(side, p)
        const lit = stringText(unwrap(other))
        if (!field || lit === undefined) continue
        if (field === 'subtype') subtypes.push(lit)
        else if (field === 'type' || field === 'kind') types.push(lit)
      }
    }
    if (ts.isCallExpression(n) && n.arguments.length === 1 && isParam(n.arguments[0]!, p) && depth < 3) {
      const helper = predicateOf(n.expression, estate, depth + 1)
      if (helper) helped.push(...helper.kinds)
    }
  })
  const own = subtypes.length === 1 ? types.map(t => `${t}:${subtypes[0]}`) : types
  return [...new Set([...own, ...helped])]
}

function labelOf(call: ts.CallExpression): string {
  for (const a of call.arguments) {
    const x = unwrap(a)
    const lit = stringText(x)
    if (lit !== undefined) return lit
    if (ts.isTemplateExpression(x)) return textOf(x, 60)
  }
  return textOf(call.expression, 40)
}

function runnerSession(receiver: ts.Expression, estate: Estate): boolean {
  const d = rootDecl(receiver)
  if (!d || !ts.isVariableDeclaration(d) || !d.initializer) return false
  const init = unwrapAwait(d.initializer)
  if (!ts.isCallExpression(init)) return false
  const callee = unwrap(init.expression)
  const maker = ts.isIdentifier(callee) ? declarationOf(callee) : undefined
  const ref = maker ? importOf(maker) : undefined
  const target = ref ? importTarget(receiver.getSourceFile().fileName, ref.module) : null
  return target !== null && estate.isRunner(target)
}

function startsOf(sf: ts.SourceFile, estate: Estate): Start[] {
  const out: Start[] = []
  visit(sf, n => {
    if (!ts.isCallExpression(n)) return
    const name = calleeName(n)
    const callee = unwrap(n.expression)
    if (name === 'send' && n.arguments[0] && isUserFrame(n.arguments[0])) out.push({ call: n, stream: streamOfCallee(callee), user: true })
    else if (name === 'submit' && ts.isPropertyAccessExpression(callee) && n.arguments.length > 0 && runnerSession(callee.expression, estate)) out.push({ call: n, stream: streamOfCallee(callee), user: true })
    else if (name === 'runScriptedTurn') out.push({ call: n, stream: {}, user: false })
  })
  return out
}

function waitsOf(sf: ts.SourceFile, estate: Estate): Wait[] {
  const out: Wait[] = []
  visit(sf, n => {
    if (!ts.isCallExpression(n)) return
    const name = calleeName(n)
    if (!name || !/^wait/.test(name)) return
    const args = n.arguments
    let predIndex = -1
    let pred: Pred | null = null
    for (let i = 0; i < args.length && pred === null; i++) {
      pred = predicateOf(args[i]!, estate, 0)
      if (pred) predIndex = i
    }
    if (!pred) return
    let budgetIndex = -1
    for (let i = predIndex + 1; i < args.length; i++) {
      const a = unwrap(args[i]!)
      if (stringText(a) === undefined && !ts.isTemplateExpression(a)) {
        budgetIndex = i
        break
      }
    }
    const callee = unwrap(n.expression)
    let stream: Stream
    if (ts.isPropertyAccessExpression(callee)) stream = { decl: rootDecl(callee.expression) }
    else {
      const lead = args.slice(0, predIndex).map(a => unwrap(a)).find(a => stringText(a) === undefined && !ts.isTemplateExpression(a))
      const leadDecl = lead ? rootDecl(lead) : undefined
      stream = leadDecl ? { decl: leadDecl } : streamOfCallee(callee)
    }
    out.push({ call: n, label: labelOf(n), pred, budget: budgetIndex >= 0 ? args[budgetIndex] : undefined, after: budgetIndex >= 0 ? args[budgetIndex + 1] : undefined, stream })
  })
  return out
}

class DriveFile {
  readonly starts: Start[]
  readonly waits: Wait[]
  readonly firstTurn: number
  private readonly turnBudgets = new Set<ts.Node>()
  private readonly summaries = new Map<ts.Node, Summary | null>()

  constructor(
    readonly src: Source,
    readonly estate: Estate,
  ) {
    this.starts = startsOf(src.sf, estate)
    this.waits = waitsOf(src.sf, estate)
    this.firstTurn = this.starts.reduce((min, s) => Math.min(min, s.call.getStart()), Number.POSITIVE_INFINITY)
    for (const w of this.waits) {
      if (w.budget && (w.pred.params === 0 || w.pred.kinds.some(k => overlap(k, 'result')))) this.collect(w.budget, 0)
    }
    for (const s of this.starts) {
      if (s.user) continue
      const opts = s.call.arguments[0] ? unwrap(s.call.arguments[0]) : undefined
      if (!opts || !ts.isObjectLiteralExpression(opts)) continue
      for (const p of opts.properties) {
        if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'timeoutMs') this.collect(p.initializer, 0)
        if (ts.isShorthandPropertyAssignment(p) && p.name.text === 'timeoutMs') this.collect(p.name, 0)
      }
    }
  }

  private collect(e: ts.Node, depth: number): void {
    visit(e, n => {
      if (!ts.isIdentifier(n) || !isReference(n)) return
      const d = declarationOf(n)
      if (!d || this.turnBudgets.has(d)) return
      this.turnBudgets.add(d)
      if (depth < 3 && ts.isVariableDeclaration(d) && d.initializer) this.collect(d.initializer, depth + 1)
    })
  }

  private helperOf(call: ts.CallExpression): ts.FunctionLikeDeclaration | undefined {
    const callee = unwrap(call.expression)
    if (!ts.isIdentifier(callee) || this.estate.isSleep(call)) return undefined
    const fn = functionOf(declarationOf(callee))
    return fn && fn.getSourceFile() === this.src.sf ? fn : undefined
  }

  private steps(body: ts.Node, stream: Stream | undefined, from: number, to: number): Step[] {
    const out: Step[] = []
    const known = new Set<ts.Node>()
    const inside = (n: ts.Node): boolean => n.pos >= from && n.pos < to && ownerOf(n) === body
    for (const s of this.starts) {
      known.add(s.call)
      if (s.user && inside(s.call) && (!stream || sameStream(s.stream, stream))) out.push({ pos: s.call.pos, effect: 'start' })
    }
    for (const w of this.waits) {
      known.add(w.call)
      if (!inside(w.call)) continue
      const settles = w.pred.kinds.some(k => overlap(k, 'result'))
      if (settles && (!stream || sameStream(w.stream, stream))) out.push({ pos: w.call.pos, effect: 'settle' })
      else if (!settles && w.pred.kinds.length > 0 && !w.pred.kinds.every(k => k === 'control_response')) out.push({ pos: w.call.pos, effect: 'active' })
    }
    const root = ts.isSourceFile(body) ? body : (body as ts.FunctionLikeDeclaration).body
    if (root) {
      visit(root, n => {
        if (n.pos < from || n.pos >= to) return
        if (ts.isAwaitExpression(n) && this.estate.isSleep(n.expression)) out.push({ pos: n.pos, effect: 'active' })
        else if (ts.isIterationStatement(n, false) && n.end <= to && this.sleepsIn(n)) out.push({ pos: n.pos, effect: 'active' })
        else if (ts.isCallExpression(n) && !known.has(n)) {
          const fn = this.helperOf(n)
          if (fn && fn !== body) out.push({ pos: n.pos, effect: 'call', call: n, fn })
        }
      }, true)
    }
    return out.sort((a, b) => a.pos - b.pos)
  }

  private move(st: Flow, step: Step): Flow {
    if (step.effect === 'start') return { turn: true, open: true, gap: false }
    if (step.effect === 'settle') return { turn: st.turn, open: false, gap: false }
    if (step.effect === 'active') return st.turn ? { ...st, gap: true } : st
    return st
  }

  private summary(fn: ts.FunctionLikeDeclaration, depth: number): Summary | null {
    const known = this.summaries.get(fn)
    if (known !== undefined) return known
    if (depth > 3) return null
    this.summaries.set(fn, null)
    let st = FRESH
    let active = false
    for (const step of this.steps(fn, undefined, fn.pos, fn.end)) {
      if (step.effect === 'call') {
        const inner = this.summary(step.fn!, depth + 1)
        if (inner?.start) st = { turn: true, open: inner.open, gap: inner.active }
        else if (inner?.active) {
          if (st.turn) st = { ...st, gap: true }
          else active = true
        }
        continue
      }
      if (step.effect === 'active' && !st.turn) active = true
      st = this.move(st, step)
    }
    const streams = [...this.starts.filter(s => s.user && ownerOf(s.call) === fn).map(s => s.stream), ...this.waits.filter(w => ownerOf(w.call) === fn).map(w => w.stream)]
    const out: Summary = { start: st.turn, open: st.open, active: st.turn ? st.gap : active, streams }
    this.summaries.set(fn, out)
    return out
  }

  private relates(call: ts.CallExpression, s: Summary, stream: Stream): boolean {
    const d = stream.decl
    if (d && ts.isVariableDeclaration(d) && d.initializer && unwrapAwait(d.initializer) === call) return true
    if (d && call.arguments.some(a => rootDecl(a) === d)) return true
    return s.streams.some(x => sameStream(x, stream))
  }

  private apply(st: Flow, step: Step, stream: Stream): Flow {
    if (step.effect !== 'call') return this.move(st, step)
    const s = this.summary(step.fn!, 0)
    if (!s) return st
    if (s.start) return this.relates(step.call!, s, stream) ? { turn: true, open: s.open, gap: s.active } : st
    return s.active && st.turn ? { ...st, gap: true } : st
  }

  private flowAt(body: ts.Node, stream: Stream, at: number, depth: number): Flow {
    let st = this.entry(body, stream, depth)
    for (const step of this.steps(body, stream, body.pos, at)) st = this.apply(st, step, stream)
    return st
  }

  private entry(body: ts.Node, stream: Stream, depth: number): Flow {
    if (ts.isSourceFile(body) || depth > 3) return FRESH
    const owner = namedFunctionDecl(body)
    const d = stream.decl
    const param = d && ts.isParameter(d) && d.parent === body ? (body as ts.FunctionLikeDeclaration).parameters.indexOf(d) : -1
    if (!owner || (param < 0 && streamInside(stream, body))) return FRESH
    return callSites(this.src.sf, owner).reduce((acc, c) => {
      const arg = param >= 0 ? c.arguments[param] : undefined
      const outer = arg ? rootDecl(arg) : undefined
      if (param >= 0 && outer === undefined) return acc
      return worse(acc, this.flowAt(ownerOf(c), outer ? { decl: outer } : stream, c.pos, depth + 1))
    }, FRESH)
  }

  private anchorOf(w: Wait): number {
    const body = ownerOf(w.call)
    const x = w.after ? unwrap(w.after) : undefined
    if (x && ts.isNumericLiteral(x) && Number(x.text) === 0) {
      const d = w.stream.decl
      return d && ownerOf(d) === body && d.pos < w.call.pos ? d.pos : body.pos
    }
    if (x && ts.isIdentifier(x)) {
      const d = declarationOf(x)
      if (d && ts.isVariableDeclaration(d) && ownerOf(d) === body && d.pos < w.call.pos) return d.pos
    }
    return w.call.pos
  }

  private stale(body: ts.Node, w: Wait, at: number): boolean {
    let started = false
    let settled = false
    for (const step of this.steps(body, w.stream, at, w.call.pos)) {
      const s = step.effect === 'call' ? this.summary(step.fn!, 0) : null
      const turn = s !== null && s.start && this.relates(step.call!, s, w.stream)
      const starts = step.effect === 'start' || turn
      if (starts && settled) return true
      if (starts) started = true
      if ((step.effect === 'settle' || (turn && !s!.open)) && started) settled = true
    }
    return false
  }

  ruleA(): WaitHit[] {
    const hits: WaitHit[] = []
    for (const w of this.waits) {
      if (!w.pred.kindOnly || !w.after) continue
      const body = ownerOf(w.call)
      const at = this.anchorOf(w)
      const opens = (s: Start, from: number): boolean => s.user && ownerOf(s.call) === body && sameStream(s.stream, w.stream) && s.call.pos >= from && s.call.pos < w.call.pos
      const loop = loopAround(w.call)
      const reused = loop !== undefined && at < loop.pos && !streamInside(w.stream, loop) && this.starts.some(s => opens(s, loop.pos))
      if (!reused && !this.starts.some(s => opens(s, at))) continue
      const held = !reused && this.stale(body, w, at)
      let st = this.flowAt(body, w.stream, at, 0)
      if (loop && loop.pos <= at && !streamInside(w.stream, loop)) {
        let again = st
        for (const step of [...this.steps(body, w.stream, at, loop.end), ...this.steps(body, w.stream, loop.pos, at)]) again = this.apply(again, step, w.stream)
        st = worse(st, again)
      }
      if (!reused && !held && !st.open && !st.gap) continue
      const kind = w.pred.kinds.length > 0 ? w.pred.kinds.join('|') : 'any'
      const why = reused
        ? 'its window opens once, before the loop, and every later pass reads it again'
        : held
          ? 'its window already holds the result of an earlier turn the drive waited for'
          : st.open
            ? 'an earlier turn on the same stream had not settled when the window opened'
            : 'the drive paused or waited on the product after the earlier turn settled, before the window opened'
      hits.push({ file: this.src.rel, line: lineOf(w.call), rule: 'a', detail: `"${w.label}" takes the next ${kind} frame for a turn it opened, but ${why}; its predicate names no turn, request, file or fixture-seen condition` })
    }
    return hits
  }

  derived(e: ts.Node, depth = 0): boolean {
    if (depth > 8) return false
    let yes = false
    visit(e, n => {
      if (yes) return
      if (ts.isCallExpression(n) && this.estate.knobCall(n)) {
        yes = true
        return
      }
      if (!ts.isIdentifier(n) || !isReference(n)) return
      const d = declarationOf(n)
      if (!d) return
      if (this.turnBudgets.has(d)) {
        yes = true
        return
      }
      if (ts.isParameter(d)) {
        if (this.paramDerived(d, depth)) yes = true
        return
      }
      if (ts.isVariableDeclaration(d) && d.initializer && !contains(d.initializer, n) && this.derived(d.initializer, depth + 1)) yes = true
    })
    return yes
  }

  private paramSites(param: ts.ParameterDeclaration): ts.CallExpression[] | undefined {
    const fn = param.parent
    if (!isFunctionNode(fn)) return undefined
    const owner = namedFunctionDecl(fn)
    return owner ? callSites(this.src.sf, owner).filter(c => c.getStart() > this.firstTurn) : undefined
  }

  private paramDerived(param: ts.ParameterDeclaration, depth: number): boolean {
    const sites = this.paramSites(param)
    if (!sites) return false
    const index = (param.parent as ts.FunctionLikeDeclaration).parameters.indexOf(param)
    return sites.every(c => {
      const a = c.arguments[index]
      return a !== undefined ? this.derived(a, depth + 1) : param.initializer !== undefined && this.derived(param.initializer, depth + 1)
    })
  }

  private offenders(budget: ts.Expression): ts.Node[] {
    if (this.derived(budget)) return []
    const out: ts.Node[] = []
    visit(budget, n => {
      if (!ts.isIdentifier(n) || !isReference(n)) return
      const d = declarationOf(n)
      if (!d || !ts.isParameter(d)) return
      const index = (d.parent as ts.FunctionLikeDeclaration).parameters.indexOf(d)
      for (const c of this.paramSites(d) ?? []) {
        const a = c.arguments[index]
        if (a !== undefined && !this.derived(a)) out.push(a)
      }
    })
    return out.length > 0 ? out : [budget]
  }

  private nested(node: ts.Node): boolean {
    if (node.getStart() > this.firstTurn) return true
    for (let fn = enclosingFunction(node); fn; fn = enclosingFunction(fn)) {
      const owner = namedFunctionDecl(fn)
      if (owner && callSites(this.src.sf, owner).some(c => c.getStart() > this.firstTurn)) return true
    }
    return false
  }

  private sleepsIn(loop: ts.IterationStatement): boolean {
    let yes = false
    visit(loop, n => {
      if (!yes && ts.isAwaitExpression(n) && this.estate.isSleep(n.expression)) yes = true
    }, true)
    return yes
  }

  ruleB(): { hits: WaitHit[]; pauses: Pause[] } {
    const hits: WaitHit[] = []
    const pauses: Pause[] = []
    if (this.firstTurn === Number.POSITIVE_INFINITY) return { hits, pauses }
    const polls = new Set<ts.Node>()
    const seen = new Set<string>()
    const report = (nodes: ts.Node[], what: string): void => {
      for (const node of nodes) {
        const key = `${lineOf(node)}:${node.getStart()}`
        if (seen.has(key)) continue
        seen.add(key)
        hits.push({ file: this.src.rel, line: lineOf(node), rule: 'b', detail: `${what} ${textOf(node, 60)} is a number of its own: neither the turn's budget nor the drive's budget knob` })
      }
    }
    visit(this.src.sf, n => {
      if (!ts.isIterationStatement(n, false) || !this.sleepsIn(n) || !waitsOnSomething(n)) return
      const budget = budgetOfLoop(n)
      if (!budget) return
      polls.add(n)
      if (inFixture(n) || !this.nested(n)) return
      report(this.offenders(budget), 'the poll budget')
    })
    visit(this.src.sf, n => {
      let text: string | undefined
      let spans: readonly ts.TemplateSpan[] = []
      if (ts.isTemplateExpression(n)) {
        spans = n.templateSpans
        text = n.head.text + spans.map((s, i) => `\u0000${i}\u0000${s.literal.text}`).join('')
      } else text = stringText(n)
      if (text === undefined || !/\bsleep\b/.test(text)) return
      const judge = (token: string): void => {
        const placeholder = /^\u0000(\d+)\u0000$/.exec(token)
        if (placeholder) {
          const expr = spans[Number(placeholder[1])]?.expression
          if (expr) report(this.offenders(expr), 'the scripted shell poll count')
        } else if (/^\d+$/.test(token)) report([n], 'the scripted shell poll')
      }
      for (const m of text.matchAll(FOR_SEQ)) {
        const body = m[2] ?? ''
        if (/\bsleep\b/.test(body) && /\bbreak\b/.test(body)) judge((m[1] ?? '').trim().split(/\s+/).pop() ?? '')
      }
      for (const m of text.matchAll(WHILE_LOOP)) {
        const body = m[2] ?? ''
        if (!/\bsleep\b/.test(body)) continue
        const limit = /-(?:lt|le|gt|ge|eq|ne)\s+(\S+)/.exec(m[1] ?? '') ?? /-(?:lt|le|gt|ge)\s+(\S+)/.exec(body)
        if (limit) judge(limit[1] ?? '')
      }
    })
    visit(this.src.sf, n => {
      if (!ts.isAwaitExpression(n) || !this.estate.isSleep(n.expression)) return
      for (let cur: ts.Node | undefined = n.parent; cur && !isFunctionNode(cur); cur = cur.parent) if (polls.has(cur)) return
      if (inFixture(n) || !this.nested(n)) return
      pauses.push({ file: this.src.rel, line: lineOf(n), text: textOf(n, 60) })
    })
    return { hits, pauses }
  }
}

function servesFixture(sf: ts.SourceFile): boolean {
  let yes = false
  visit(sf, n => {
    if (!yes && ts.isCallExpression(n) && FIXTURE_MAKERS.has(calleeName(n) ?? '')) yes = true
  })
  return yes
}

function flat(node: ts.Node): string {
  return node.getText(node.getSourceFile()).replace(/\s+/g, '')
}

function movedTerm(e: ts.Expression, at: number): string | undefined {
  const x = unwrap(e)
  if (!ts.isBinaryExpression(x) || !MOVED.has(x.operatorToken.kind)) return undefined
  for (const [side, other] of [
    [x.left, x.right],
    [x.right, x.left],
  ] as const) {
    const base = unwrap(side)
    const reading = unwrap(other)
    if (!ts.isIdentifier(base) || isLiteral(reading)) continue
    const d = declarationOf(base)
    if (!d || !ts.isVariableDeclaration(d) || !d.initializer || d.getStart() >= at) continue
    const taken = unwrapAwait(d.initializer)
    if (!isLiteral(taken) && flat(taken) === flat(reading)) return `${textOf(reading, 50)} moves past ${base.text}`
  }
  return undefined
}

function movedOnly(e: ts.Expression, at: number, terms: string[]): boolean {
  const x = unwrap(e)
  if (ts.isBinaryExpression(x) && (x.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || x.operatorToken.kind === ts.SyntaxKind.BarBarToken)) return movedOnly(x.left, at, terms) && movedOnly(x.right, at, terms)
  const term = movedTerm(x, at)
  if (term === undefined) return false
  terms.push(term)
  return true
}

function movedWaits(src: Source): WaitHit[] {
  const hits: WaitHit[] = []
  visit(src.sf, n => {
    if (!ts.isCallExpression(n) || !/^wait/.test(calleeName(n) ?? '')) return
    for (const arg of n.arguments) {
      const fn = unwrap(arg)
      if (!(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) || fn.parameters.length > 0) continue
      const body = ts.isBlock(fn.body) ? singleReturn(fn.body) : fn.body
      const terms: string[] = []
      if (!body || !movedOnly(body, n.getStart(), terms)) continue
      hits.push({ file: src.rel, line: lineOf(n), rule: 'a', detail: `"${labelOf(n)}" ends when ${terms.join(' and ')} — any event that moves that reading ends it, not only the one this step is for; its predicate names no turn, request, file or fixture-seen condition` })
      break
    }
  })
  return hits
}

export function census(root: string): { files: number; drives: number; served: number; hits: WaitHit[]; pauses: Pause[] } {
  const estate = new Estate(root)
  const hits: WaitHit[] = []
  const pauses: Pause[] = []
  const files = walkProofs(root)
  let drives = 0
  let served = 0
  for (const path of files) {
    if (!TURN_TEXT.test(readFileSync(path, 'utf8'))) continue
    const src = parseSource(root, path)
    const isDrive = estate.driveReason(src) !== null
    if (!isDrive && !servesFixture(src.sf)) continue
    hits.push(...movedWaits(src))
    if (!isDrive) {
      served++
      continue
    }
    drives++
    const drive = new DriveFile(src, estate)
    hits.push(...drive.ruleA())
    const b = drive.ruleB()
    hits.push(...b.hits)
    pauses.push(...b.pauses)
  }
  hits.sort((x, y) => (x.file === y.file ? x.line - y.line : x.file < y.file ? -1 : 1))
  return { files: files.length, drives, served, hits, pauses }
}

const WORLD = [
  "import { spawn } from 'node:child_process'",
  "import { vshotBudgetMs } from './knobs.ts'",
  "export const DIST = 'dist/product.mjs'",
  'export const bound = (ms: number): number => vshotBudgetMs(ms)',
  'export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))',
  "export const isResult = (f: Record<string, unknown>): boolean => f.type === 'result'",
  "export const user = (text: string, uuid: string): Record<string, unknown> => ({ type: 'user', message: { role: 'user', content: text }, uuid })",
  'export type Frame = Record<string, unknown>',
  'export type Runner = { frames: Frame[]; send: (frame: Frame) => void; waitFor: (label: string, test: (f: Frame) => boolean, ms: number, after?: number) => Promise<Frame | null> }',
  'export const run = (args: string[]): Promise<number> => new Promise(done => {',
  "  const child = spawn('node', [DIST, ...args])",
  '  const timer = setTimeout(() => child.kill(), 60_000)',
  "  child.on('exit', code => { clearTimeout(timer); done(code ?? 1) })",
  '})',
  'export function bootRunner(): Runner {',
  "  const proc = spawn('node', [DIST, '-p'])",
  '  const frames: Frame[] = []',
  '  return { frames, send: frame => { proc.stdin?.write(`${JSON.stringify(frame)}\\n`) }, waitFor: async () => null }',
  '}',
]

const HITS: Array<[string, '' | 'a' | 'b']> = [
  ["import { bootRunner, bound, isResult, sleep, user } from './world.ts'", ''],
  ['const runner = bootRunner()', ''],
  ["runner.send(user('the first ask', 'u-1'))", ''],
  ["const tool = await runner.waitFor('the first tool call', f => f.type === 'assistant', bound(60_000))", ''],
  ['const before = runner.frames.length', ''],
  ["runner.send(user('the follow-up', 'u-2'))", ''],
  ["const follow = await runner.waitFor('the follow-up result', isResult, bound(60_000), before)", 'a'],
  ["const named = await runner.waitFor('the named follow-up', f => isResult(f) && f.result === 'follow-up done', bound(60_000), before)", ''],
  ['await sleep(3_000)', ''],
  ['const later = runner.frames.length', ''],
  ["runner.send(user('the late ask', 'u-3'))", ''],
  ["const late = await runner.waitFor('a success of the late ask', f => f.type === 'result' && f.subtype === 'success', bound(60_000), later)", 'a'],
  ['const once = runner.frames.length', ''],
  ["for (const ask of ['x', 'y']) {", ''],
  ['  runner.send(user(ask, ask))', ''],
  ["  await runner.waitFor('each ask', isResult, bound(60_000), once)", 'a'],
  ['}', ''],
  ["const again = await runner.waitFor('the whole stream again', isResult, bound(60_000), 0)", 'a'],
  ['const until = Date.now() + 30_000', 'b'],
  ['while (Date.now() < until && runner.frames.length < 9) await sleep(100)', ''],
  ['const scaled = Date.now() + bound(30_000)', ''],
  ['while (Date.now() < scaled && runner.frames.length < 9) await sleep(100)', ''],
  ['const command = `for i in $(seq 1 150); do [ -f "${String(follow)}" ] && break; sleep 0.2; done`', 'b'],
  ["const paced = 'for i in 1 2 3; do echo $i; sleep 1; done'", ''],
  ['const poll = async (budgetMs: number): Promise<void> => {', ''],
  ['  const end = Date.now() + budgetMs', ''],
  ['  while (Date.now() < end && runner.frames.length < 9) await sleep(50)', ''],
  ['}', ''],
  ['await poll(5_000)', 'b'],
  ['await poll(bound(5_000))', ''],
  ['for (let waited = 0; waited < 10_000 && runner.frames.length < 9; waited += 250) await sleep(250)', 'b'],
  ['const mark = runner.frames.length', ''],
  ["const moved = await runner.waitFor('any frame past the mark', () => runner.frames.length > mark, bound(60_000))", 'a'],
  ['console.log(tool, named, late, again, command, paced, moved)', ''],
]

const HELPER: Array<[string, '' | 'a' | 'b']> = [
  ["import { bootRunner, bound, isResult, sleep, user } from './world.ts'", ''],
  ['const runner = bootRunner()', ''],
  ['const turn = async (ask: string): Promise<Record<string, unknown> | null> => {', ''],
  ['  const from = runner.frames.length', ''],
  ['  runner.send(user(ask, ask))', ''],
  ["  return runner.waitFor('the helper turn', isResult, bound(60_000), from)", 'a'],
  ['}', ''],
  ["await turn('one')", ''],
  ["await turn('two')", ''],
  ['await sleep(2_000)', ''],
  ["await turn('three')", ''],
  ['async function openWorld(): Promise<{ runner: ReturnType<typeof bootRunner> }> {', ''],
  ['  const opened = bootRunner()', ''],
  ["  opened.send(user('hello', 'u-0'))", ''],
  ["  await opened.waitFor('the opening tool call', f => f.type === 'assistant', bound(60_000))", ''],
  ['  return { runner: opened }', ''],
  ['}', ''],
  ['const w = await openWorld()', ''],
  ['const mark = w.runner.frames.length', ''],
  ["w.runner.send(user('the arm', 'u-1'))", ''],
  ['const armed = await w.runner.waitFor("the arm\'s turn", isResult, bound(60_000), mark)', 'a'],
  ['const turnOf = async (world: { runner: ReturnType<typeof bootRunner> }, ask: string): Promise<unknown> => {', ''],
  ['  const at = world.runner.frames.length', ''],
  ['  world.runner.send(user(ask, ask))', ''],
  ["  return world.runner.waitFor('a turn of the world passed in', isResult, bound(60_000), at)", 'a'],
  ['}', ''],
  ['await sleep(500)', ''],
  ["await turnOf(w, 'after a pause')", ''],
  ['console.log(armed)', ''],
]

const CLEAN = [
  "import { bootRunner, bound, isResult, run, sleep, user } from './world.ts'",
  "import { startScriptedFixture } from './fixture.ts'",
  'const TURN_MS = 60_000',
  'const runner = bootRunner()',
  "runner.send(user('the first ask', 'u-1'))",
  "const first = await runner.waitFor('the first turn', isResult, bound(TURN_MS))",
  'const before = runner.frames.length',
  "runner.send(user('the second ask', 'u-2'))",
  "const second = await runner.waitFor('the second turn, after a settled first', isResult, bound(TURN_MS), before)",
  'const turn = async (ask: string): Promise<unknown> => {',
  '  const from = runner.frames.length',
  '  runner.send(user(ask, ask))',
  "  return runner.waitFor('a helper turn, each call settled', isResult, bound(TURN_MS), from)",
  '}',
  "await turn('three')",
  "await turn('four')",
  'async function openWorld(): Promise<{ runner: ReturnType<typeof bootRunner> }> {',
  '  const opened = bootRunner()',
  "  opened.send(user('hello', 'u-0'))",
  "  await opened.waitFor('the opening turn', isResult, bound(TURN_MS))",
  '  return { runner: opened }',
  '}',
  'const w = await openWorld()',
  'const mark = w.runner.frames.length',
  "w.runner.send(user('the arm', 'u-1'))",
  'const armed = await w.runner.waitFor("the arm\'s turn, after a settled world", isResult, bound(TURN_MS), mark)',
  "runner.send(user('the interrupted ask', 'u-5'))",
  "await runner.waitFor('its tool call', f => f.type === 'assistant', bound(TURN_MS))",
  'const pressed = runner.frames.length',
  "runner.send({ type: 'control_request', request: { subtype: 'interrupt' } })",
  "const interrupted = await runner.waitFor('the interrupted turn itself', isResult, bound(TURN_MS), pressed)",
  'const fold = runner.frames.length',
  "runner.send(user('/compact', 'u-6'))",
  "runner.send(user('held while the fold runs', 'u-7'))",
  "const folded = await runner.waitFor('the fold, first in its window', isResult, bound(TURN_MS), fold)",
  'for (let extra = 0; extra < 3; extra++) {',
  "  const next = await runner.waitFor('a following turn', isResult, bound(TURN_MS), runner.frames.length)",
  '  if (next === null) break',
  '}',
  'const fresh = async (ask: string): Promise<void> => {',
  '  const own = bootRunner()',
  '  own.send(user(ask, ask))',
  "  await own.waitFor('its only turn', isResult, bound(TURN_MS), 0)",
  '}',
  "await fresh('a')",
  "await fresh('b')",
  'const until = Date.now() + TURN_MS / 2',
  'while (Date.now() < until && runner.frames.length < 9) await sleep(100)',
  'const rounds = (budgetMs: number): number => Math.ceil(budgetMs / 200)',
  'const command = `for i in $(seq 1 ${rounds(TURN_MS / 2)}); do [ -f "${String(first)}" ] && break; sleep 0.2; done`',
  'const unbounded = `while [ ! -f "${String(first)}" ]; do sleep 0.05; done`',
  'const scaled = `for i in $(seq 1 ${Math.ceil(bound(30_000) / 200)}); do [ -f /x ] && break; sleep 0.2; done`',
  "const leg = { spellings: ['a', 'b', 'c'] }",
  'const runs: number[] = []',
  "for (let i = 0; i < leg.spellings.length; i++) runs.push(await run(['-p', leg.spellings[i]!]))",
  'await startScriptedFixture(async () => {',
  '  const end = Date.now() + 5_000',
  '  while (Date.now() < end) await sleep(10)',
  '  return []',
  '})',
  'console.log(second, armed, interrupted, folded, command, unbounded, scaled, runs)',
]

const SESSION: Array<[string, '' | 'a' | 'b']> = [
  ["import { bootRunner, sleep } from './world.ts'", ''],
  ['const session = bootRunner()', ''],
  ["session.submit('the lead ask')", ''],
  ['const until = Date.now() + 30_000', 'b'],
  ['while (Date.now() < until && session.frames.length < 3) await sleep(50)', ''],
]

const SERVICE = [
  "import { execFileSync } from 'node:child_process'",
  "import { startService } from './service.ts'",
  'const pause = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))',
  'const service = startService()',
  "const job = await service.submit({ job: 'a' })",
  'for (let i = 0; i < 600 && job === null; i++) await pause(50)',
  "execFileSync('node', ['dist/mercury.mjs', 'godot', 'profile'])",
]

const SERVED: Array<[string, '' | 'a' | 'b']> = [
  ["import { createServer } from 'node:http'", ''],
  ['let epoch = 0', ''],
  ['const hits: string[] = []', ''],
  ['const server = createServer((req, res) => { hits.push(String(req.url)); epoch++; res.end() })', ''],
  ['const count = (path: string): number => hits.filter(h => h === path).length', ''],
  ['const readEpoch = (): number => epoch', ''],
  ['const waitFor = async (predicate: () => boolean, timeoutMs = 3_000): Promise<boolean> => {', ''],
  ['  const start = Date.now()', ''],
  ['  while (Date.now() - start < timeoutMs) {', ''],
  ['    if (predicate()) return true', ''],
  ['    await new Promise(resolve => setTimeout(resolve, 10))', ''],
  ['  }', ''],
  ['  return predicate()', ''],
  ['}', ''],
  ['const e0 = readEpoch()', ''],
  ["await fetch('http://127.0.0.1:1/a').catch(() => null)", ''],
  ['const moved = await waitFor(() => readEpoch() > e0)', 'a'],
  ['const before = hits.length', ''],
  ['const grew = await waitFor(() => hits.length !== before && e0 < readEpoch())', 'a'],
  ["const named = await waitFor(() => count('/a') === 1 && readEpoch() > e0)", ''],
  ["const own = await waitFor(() => count('/a') === 1 && hits.at(-1) !== undefined)", ''],
  ['const fixed = await waitFor(() => readEpoch() > 0)', ''],
  ['console.log(moved, grew, named, own, fixed, server)', ''],
]

const NOT_A_DRIVE = [
  'const frames: Array<Record<string, unknown>> = []',
  'const send = (f: Record<string, unknown>): void => { frames.push(f) }',
  'const waitFor = async (label: string, test: (f: Record<string, unknown>) => boolean, ms: number, after = 0): Promise<unknown> => frames.slice(after).find(test) ?? null',
  "send({ type: 'user', text: 'a' })",
  "send({ type: 'user', text: 'b' })",
  "await waitFor('not a drive', f => f.type === 'result', 1_000, 0)",
  'const n0 = frames.length',
  "await waitFor('a moved count in a proof that serves nothing', () => frames.length > n0, 1_000)",
  'const until = Date.now() + 30_000',
  'while (Date.now() < until) await new Promise(r => setTimeout(r, 10))',
]

function selfTest(): boolean {
  const root = mkdtempSync(join(tmpdir(), 'drive-wait-census-'))
  const dir = 'scripts/wait-fixture'
  const write = (name: string, lines: string[]): void => {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, name), `${lines.join('\n')}\n`)
  }
  let ok = false
  try {
    write('world.ts', WORLD)
    write('prove-wait-hits.ts', HITS.map(([line]) => line))
    write('prove-wait-helper.ts', HELPER.map(([line]) => line))
    write('prove-wait-clean.ts', CLEAN)
    write('prove-wait-session.ts', SESSION.map(([line]) => line))
    write('prove-wait-service.ts', SERVICE)
    write('prove-wait-served.ts', SERVED.map(([line]) => line))
    write('prove-wait-not-a-drive.ts', NOT_A_DRIVE)
    const got = census(root)
    const planted = (name: string, rows: Array<[string, '' | 'a' | 'b']>): string[] => rows.flatMap(([, rule], i) => (rule ? [`${dir}/${name}:${i + 1}:${rule}`] : []))
    const want = [...planted('prove-wait-hits.ts', HITS), ...planted('prove-wait-helper.ts', HELPER), ...planted('prove-wait-session.ts', SESSION), ...planted('prove-wait-served.ts', SERVED)].sort()
    const seen = [...new Set(got.hits.map(h => `${h.file}:${h.line}:${h.rule}`))].sort()
    const pauseLines = got.pauses.map(p => `${p.file}:${p.line}`).sort()
    const pausesIn = (name: string, rows: Array<[string, '' | 'a' | 'b']>): string[] => rows.flatMap(([line], i) => (line.startsWith('await sleep(') ? [`${dir}/${name}:${i + 1}`] : []))
    const pauseWant = [...pausesIn('prove-wait-hits.ts', HITS), ...pausesIn('prove-wait-helper.ts', HELPER)].sort()
    const exact = seen.join(' ') === want.join(' ')
    const drivesOk = got.drives === 5 && got.served === 1
    const pausesOk = pauseLines.join(' ') === pauseWant.join(' ')
    ok = exact && drivesOk && pausesOk
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] self-test: ${want.length} planted rows named exactly (a follow-up after an unsettled turn, after a pause past a settled turn, from a helper called after a pause, after an unsettled world, through a world passed in, in a loop reading one window, on a window that already holds an answered turn; a wait on a reading merely moved past its own earlier value, in a drive and in a proof that serves a fixture; raw deadline, counter, helper and scripted shell budgets), none for named waits, a moved reading joined to a named request, settled sequential turns, settled helpers and worlds, the in-flight turn itself, the first turn of a crowded window, a fresh runner, knob or turn-derived budgets, unbounded or paced shell loops, a spawn loop whose promise only carries a kill timer, fixture pacing or a proof that neither drives nor serves; ${pauseWant.length} fixed pauses counted, never failed${ok ? '' : ` — rows ${JSON.stringify(seen)} want ${JSON.stringify(want)}; drives ${got.drives}; served ${got.served}; pauses ${JSON.stringify(pauseLines)} want ${JSON.stringify(pauseWant)}`}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  return ok
}

if (import.meta.main) {
  console.log('============================================================')
  console.log(' drive-wait census — a wait in a drive names its event and takes its budget from the turn')
  console.log('============================================================')
  let failures = selfTest() ? 0 : 1
  const { files, drives, served, hits, pauses } = census(REAL_ROOT)
  const a = hits.filter(h => h.rule === 'a')
  const b = hits.filter(h => h.rule === 'b')
  console.log(`  census: ${files} proof files read · ${drives} drive the product · ${served} more serve a fixture the product calls · ${a.length} wait(s) on no named event · ${b.length} budget(s) of their own`)
  for (const h of hits) {
    failures++
    console.log(`  [FAIL] ${h.file}:${h.line} (${h.rule}) ${h.detail}`)
  }
  if (a.length === 0) console.log('  [PASS] (a) every kind-only wait for a turn the drive opened owns its window (no earlier turn unsettled in it, no pause or product wait before it, no earlier answer in it), and no wait in a drive or a fixture-served proof ends on a reading merely moving past its own earlier value')
  if (b.length === 0) console.log("  [PASS] (b) every poll a drive runs during a turn takes its budget from the turn or the budget knob")
  console.log(`  info: ${pauses.length} fixed pause(s) in drives past the first turn; a pause that stands between a settled turn and the next window already fails (a), the rest are listed for review${REPORT ? '' : ' — --report lists them'}`)
  if (REPORT) for (const p of pauses) console.log(`    pause ${p.file}:${p.line} ${p.text}`)
  console.log(`\n${failures === 0 ? '✅' : '❌'} prove-drive-wait-census — ${failures === 0 ? 'all checks pass' : `${failures} check(s) failed`}`)
  process.exit(failures === 0 ? 0 : 1)
}
