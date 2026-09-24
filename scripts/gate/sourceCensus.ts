import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

export type Source = { path: string; rel: string; sf: ts.SourceFile }
export type ImportRef = { module: string; name: string }

export const slash = (p: string): string => p.split('\\').join('/')

export function walkProofs(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      if (name === 'node_modules' || name.startsWith('.')) continue
      const full = join(dir, name)
      const st = statSync(full)
      if (st.isDirectory()) walk(full)
      else if (st.isFile() && name.startsWith('prove-') && name.endsWith('.ts')) out.push(full)
    }
  }
  const scripts = join(root, 'scripts')
  if (existsSync(scripts)) walk(scripts)
  return out
}

function scriptKindOf(path: string): ts.ScriptKind {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (/\.(m|c)?js$/.test(path)) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

export function parseSource(root: string, path: string): Source {
  const full = resolve(path)
  const text = readFileSync(full, 'utf8')
  return { path: full, rel: slash(relative(root, full)), sf: ts.createSourceFile(full, text, ts.ScriptTarget.Latest, true, scriptKindOf(full)) }
}

export class ModuleCache {
  private readonly parsed = new Map<string, Source | null>()
  constructor(readonly root: string) {}
  get(path: string): Source | null {
    const full = resolve(path)
    const known = this.parsed.get(full)
    if (known !== undefined) return known
    let source: Source | null = null
    try {
      if (statSync(full).isFile()) source = parseSource(this.root, full)
    } catch {
      source = null
    }
    this.parsed.set(full, source)
    return source
  }
}

export function unwrap(e: ts.Expression): ts.Expression {
  let cur = e
  for (;;) {
    if (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isNonNullExpression(cur) || ts.isSatisfiesExpression(cur) || ts.isTypeAssertionExpression(cur)) cur = cur.expression
    else return cur
  }
}

export function unwrapAwait(e: ts.Expression): ts.Expression {
  let cur = unwrap(e)
  while (ts.isAwaitExpression(cur)) cur = unwrap(cur.expression)
  return cur
}

export function lineOf(node: ts.Node): number {
  const sf = node.getSourceFile()
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
}

export function textOf(node: ts.Node, max = 90): string {
  const flat = node.getText(node.getSourceFile()).replace(/\s+/g, ' ')
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

export function stringText(e: ts.Node): string | undefined {
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text
  return undefined
}

export function calleeName(call: ts.CallExpression | ts.NewExpression): string | undefined {
  const callee = unwrap(call.expression)
  if (ts.isIdentifier(callee)) return callee.text
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text
  return undefined
}

export function isFunctionNode(n: ts.Node): n is ts.FunctionLikeDeclaration {
  return ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n)
}

export function visit(node: ts.Node, cb: (n: ts.Node) => void, skipFunctions = false): void {
  const walk = (n: ts.Node): void => {
    cb(n)
    ts.forEachChild(n, child => {
      if (skipFunctions && isFunctionNode(child)) return
      walk(child)
    })
  }
  walk(node)
}

export function isReference(id: ts.Identifier): boolean {
  const p = id.parent
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false
  if ((ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isPropertySignature(p) || ts.isMethodDeclaration(p)) && p.name === id) return false
  if (ts.isBindingElement(p) && p.propertyName === id) return false
  if ((ts.isImportSpecifier(p) || ts.isExportSpecifier(p)) && p.propertyName === id) return false
  if (ts.isLabeledStatement(p) || ts.isBreakStatement(p) || ts.isContinueStatement(p)) return false
  if (ts.isTypeReferenceNode(p) || ts.isQualifiedName(p)) return false
  return true
}

function bindingIn(name: ts.BindingName, text: string): ts.Node | undefined {
  if (ts.isIdentifier(name)) return name.text === text ? name.parent : undefined
  for (const el of name.elements) {
    if (ts.isOmittedExpression(el)) continue
    const hit = bindingIn(el.name, text)
    if (hit) return hit
  }
  return undefined
}

function declaredIn(scope: ts.Node, text: string): ts.Node | undefined {
  if (isFunctionNode(scope)) {
    for (const p of scope.parameters) {
      const hit = bindingIn(p.name, text)
      if (hit) return hit
    }
    if (ts.isFunctionExpression(scope) && scope.name?.text === text) return scope
  }
  if ((ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope)) && scope.initializer && ts.isVariableDeclarationList(scope.initializer)) {
    for (const d of scope.initializer.declarations) {
      const hit = bindingIn(d.name, text)
      if (hit) return hit
    }
  }
  if (ts.isCatchClause(scope) && scope.variableDeclaration) {
    const hit = bindingIn(scope.variableDeclaration.name, text)
    if (hit) return hit
  }
  const statements = ts.isSourceFile(scope) || ts.isBlock(scope) || ts.isModuleBlock(scope) || ts.isCaseClause(scope) || ts.isDefaultClause(scope) ? scope.statements : undefined
  if (!statements) return undefined
  for (const s of statements) {
    if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) {
        const hit = bindingIn(d.name, text)
        if (hit) return hit
      }
    } else if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) && s.name?.text === text) {
      return s
    } else if (ts.isImportDeclaration(s) && s.importClause) {
      const clause = s.importClause
      if (clause.name?.text === text) return clause
      const named = clause.namedBindings
      if (named && ts.isNamespaceImport(named) && named.name.text === text) return named
      if (named && ts.isNamedImports(named)) for (const el of named.elements) if (el.name.text === text) return el
    }
  }
  return undefined
}

export function declarationOf(id: ts.Identifier): ts.Node | undefined {
  for (let scope: ts.Node | undefined = id.parent; scope; scope = scope.parent) {
    const hit = declaredIn(scope, id.text)
    if (hit) return hit
  }
  return undefined
}

export function rootDeclarationOf(el: ts.BindingElement): ts.VariableDeclaration | ts.ParameterDeclaration | undefined {
  let cur: ts.Node = el
  while (ts.isBindingElement(cur)) cur = cur.parent.parent
  return ts.isVariableDeclaration(cur) || ts.isParameter(cur) ? cur : undefined
}

export function forOfOf(decl: ts.Node): ts.ForOfStatement | undefined {
  const list = decl.parent
  return ts.isVariableDeclaration(decl) && list && ts.isVariableDeclarationList(list) && ts.isForOfStatement(list.parent) ? list.parent : undefined
}

export function isDynamicImport(e: ts.Expression): e is ts.CallExpression {
  const x = unwrapAwait(e)
  return ts.isCallExpression(x) && x.expression.kind === ts.SyntaxKind.ImportKeyword
}

export function importOf(decl: ts.Node): ImportRef | undefined {
  if (ts.isImportSpecifier(decl)) {
    const imp = decl.parent.parent.parent
    if (ts.isStringLiteral(imp.moduleSpecifier)) return { module: imp.moduleSpecifier.text, name: (decl.propertyName ?? decl.name).text }
  }
  if (ts.isImportClause(decl) && ts.isStringLiteral(decl.parent.moduleSpecifier)) return { module: decl.parent.moduleSpecifier.text, name: 'default' }
  if (ts.isBindingElement(decl)) {
    const root = rootDeclarationOf(decl)
    if (root && ts.isVariableDeclaration(root) && root.initializer && isDynamicImport(root.initializer)) {
      const call = unwrapAwait(root.initializer) as ts.CallExpression
      const spec = call.arguments[0]
      const prop = decl.propertyName && ts.isIdentifier(decl.propertyName) ? decl.propertyName.text : ts.isIdentifier(decl.name) ? decl.name.text : undefined
      if (spec && ts.isStringLiteral(spec) && prop) return { module: spec.text, name: prop }
    }
  }
  return undefined
}

export function importTarget(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const base = resolve(dirname(fromFile), spec)
  for (const cand of [base, base.replace(/\.js$/, '.ts'), `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand
  }
  return null
}

function exportedDeclaration(sf: ts.SourceFile, name: string): ts.Node | undefined {
  for (const s of sf.statements) {
    const exported = ts.canHaveModifiers(s) && (ts.getModifiers(s) ?? []).some(m => m.kind === ts.SyntaxKind.ExportKeyword)
    if (ts.isVariableStatement(s) && exported) {
      for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name) && d.name.text === name) return d
    }
    if (ts.isFunctionDeclaration(s) && exported && s.name?.text === name) return s
    if (ts.isExportDeclaration(s) && !s.moduleSpecifier && s.exportClause && ts.isNamedExports(s.exportClause)) {
      for (const el of s.exportClause.elements) if (el.name.text === name) return declaredIn(sf, (el.propertyName ?? el.name).text)
    }
  }
  return undefined
}

export function importedDeclaration(modules: ModuleCache, decl: ts.Node): ts.Node | undefined {
  const ref = importOf(decl)
  if (!ref) return undefined
  const target = importTarget(decl.getSourceFile().fileName, ref.module)
  const mod = target ? modules.get(target) : null
  return mod ? exportedDeclaration(mod.sf, ref.name) : undefined
}

export function functionOf(decl: ts.Node | undefined): ts.FunctionLikeDeclaration | undefined {
  if (!decl) return undefined
  if (ts.isFunctionDeclaration(decl)) return decl
  if (ts.isVariableDeclaration(decl) && decl.initializer) {
    const init = unwrap(decl.initializer)
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init
  }
  return undefined
}

export function namedFunctionDecl(fn: ts.Node): ts.Node | undefined {
  if (ts.isFunctionDeclaration(fn) && fn.name) return fn
  if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isVariableDeclaration(fn.parent) && fn.parent.initializer === fn && ts.isIdentifier(fn.parent.name)) return fn.parent
  return undefined
}

export function returnedExpressions(fn: ts.FunctionLikeDeclaration): ts.Expression[] {
  const body = fn.body
  if (!body) return []
  if (!ts.isBlock(body)) return [body]
  const out: ts.Expression[] = []
  visit(body, n => {
    if (ts.isReturnStatement(n) && n.expression) out.push(n.expression)
  }, true)
  return out
}

export function callSites(sf: ts.SourceFile, decl: ts.Node): ts.CallExpression[] {
  const name = ts.isFunctionDeclaration(decl) ? decl.name?.text : ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name) ? decl.name.text : undefined
  if (!name) return []
  const out: ts.CallExpression[] = []
  visit(sf, n => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name && declarationOf(n.expression) === decl) out.push(n)
  })
  return out
}

export function referencesOf(sf: ts.SourceFile, decl: ts.Node, name: string): ts.Identifier[] {
  const out: ts.Identifier[] = []
  visit(sf, n => {
    if (ts.isIdentifier(n) && n.text === name && isReference(n) && declarationOf(n) === decl) out.push(n)
  })
  return out
}
