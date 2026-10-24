#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import { GRAPH_ROOT, readStubMap, resolveSpec } from './graph.ts'

type ExportForm =
  | 'declaration'
  | 'default-declaration'
  | 'default-anonymous'
  | 'default-assignment'
  | 'export-equals'
  | 'named-reexport'
  | 'star-reexport'
  | 'namespace-reexport'
  | 'local-list'

export type ExportClass =
  | 'read'
  | 'entrypoint'
  | 'rows-surface'
  | 'declaration-file'
  | 'generated'
  | 'fixture'
  | 'orphan-baseline'
  | 're-export'
  | 'default-assignment'
  | 'shared-statement'
  | 'module-anchor'
  | 'text-pin'
  | 'pattern-pin'
  | 'candidate'

export const KEPT_CLASSES: Record<Exclude<ExportClass, 'read' | 'candidate'>, string> = {
  entrypoint: 'the bundle roots (src/entrypoints/*, src/main.tsx): a spawned or exposed surface, never an orphan',
  'rows-surface': 'src/rows/*: the row vocabulary the SDK generator reads and the sdk package re-publishes',
  'declaration-file': 'a .d.ts: its export keywords decide module-versus-global scope, never a surface to trim',
  generated: 'a generated file: it moves only through its generator',
  fixture: 'test data under a fixtures folder: a proof input, not product surface',
  'orphan-baseline': 'a file parked by the typed orphan baseline (scripts/orphans/baseline.json): parked whole, with its reason',
  're-export': 'export { } from / export * / export { local }: a specifier, not a modifier; held for a ruling',
  'default-assignment': 'export default <expression>, export =, or an anonymous default: no modifier to remove without a body change',
  'shared-statement': 'one declaration statement carries a sibling binding that is read',
  'module-anchor': 'the last import-or-export of the file: removing it would turn a module into a global script',
  'text-pin': 'a proof names the declaration in a string, template or regex literal (export <kind> <name>), or names the module and the bare name',
  'pattern-pin': "a proof's regex over source matches the declaration's head line (export const [A-Z_]+_TOOL_NAME = …)",
}

interface ExportStatement {
  start: number
  end: number
  modifierStart: number
  modifierEnd: number
  names: string[]
  head: string
}

export interface ExportRow {
  file: string
  name: string
  form: ExportForm
  typeOnly: boolean
  statements: ExportStatement[]
  readers: string[]
  opaque: boolean
  typeSideOnly: boolean
  class: ExportClass
  inventory: boolean
}

interface UnresolvedLoad {
  file: string
  line: number
  text: string
}

export interface ExportCensus {
  root: string
  subjects: string[]
  readers: string[]
  rows: ExportRow[]
  unresolved: UnresolvedLoad[]
  shellReads: number
  tally: Record<ExportClass, number>
  namedBy: Map<string, string[]>
  wholeReads: { embeddedScripts: number; exportScanners: number; exportedNamespaces: number }
}

export interface CensusOptions {
  root: string
  subjects: string[]
  readers: string[]
  stubMap: Record<string, string>
  entrypoints: string[]
  rowsSurface: string[]
  generated: string[]
  fixtures: string[]
  orphanBaseline: string[]
  inventory: Set<string>
  pinSources: string[]
  generators: Set<string>
}

type Reads = Map<string, Map<string, Set<string>>>
type Opaque = Map<string, Set<string>>

const CODE_FILE = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/
const TEXT_PIN_FILE = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx|sh|bash|md|txt|json|tsv|csv|yml|yaml|py|toml|html|css)$/
const DECLARATION_PIN = /export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\*?|const\s+enum|const|let|var|class|type|interface|enum|namespace|module)\s+([A-Za-z_$][\w$]*)/g
const ROOT_ANCHORS = new Set(['ROOT', 'REPO', 'REPO_ROOT', 'REAL_ROOT', 'root', 'repo', 'repoRoot', 'repo_root', 'GRAPH_ROOT', 'TREE'])
const SRC_ANCHORS = new Set(['SRC', 'src', 'SRC_DIR', 'srcDir'])
const SCRIPTS_ANCHORS = new Set(['SCRIPTS', 'scripts', 'SCRIPTS_DIR'])
const DIR_ANCHORS = new Set(['__dirname', 'HERE', 'here', 'DIR', 'dir', 'SUITE_DIR', 'suiteDir'])

const slash = (p: string): string => p.split('\\').join('/')

function trackedFiles(root: string): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter(Boolean)
    .map(slash)
    .filter(f => existsSync(join(root, f)) && statSync(join(root, f)).isFile())
}

function scriptKindOf(path: string): ts.ScriptKind {
  if (path.endsWith('.tsx') || path.endsWith('.jsx')) return path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.JSX
  if (/\.(m|c)?js$/.test(path)) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

function parseFile(path: string, text: string): ts.SourceFile {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKindOf(path))
}

function stringText(n: ts.Node | undefined): string | null {
  if (!n) return null
  if (ts.isStringLiteralLike(n)) return n.text
  if (ts.isTemplateExpression(n)) return null
  return null
}

function unwrapExpression(e: ts.Expression): ts.Expression {
  let cur = e
  for (;;) {
    if (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isTypeAssertionExpression(cur) || ts.isNonNullExpression(cur) || ts.isSatisfiesExpression(cur) || ts.isAwaitExpression(cur)) cur = cur.expression
    else return cur
  }
}

function isRequireCallee(e: ts.Expression): boolean {
  if (ts.isIdentifier(e)) return e.text === 'require'
  if (ts.isPropertyAccessExpression(e) && e.name.text === 'require') {
    return ts.isMetaProperty(e.expression) || (ts.isIdentifier(e.expression) && e.expression.text === 'require')
  }
  return false
}

function isModuleLoadCall(e: ts.Expression): e is ts.CallExpression {
  return ts.isCallExpression(e) && (e.expression.kind === ts.SyntaxKind.ImportKeyword || isRequireCallee(e.expression))
}

function leftmostIdentifier(q: ts.EntityName): ts.Identifier {
  let cur: ts.EntityName = q
  while (ts.isQualifiedName(cur)) cur = cur.left
  return cur
}

function bindingNames(name: ts.BindingName, out: string[]): void {
  if (ts.isIdentifier(name)) out.push(name.text)
  else for (const el of name.elements) if (!ts.isOmittedExpression(el)) bindingNames(el.name, out)
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): ts.Modifier | undefined {
  return ts.canHaveModifiers(node) ? ts.getModifiers(node)?.find(m => m.kind === kind) : undefined
}

type Env = Map<string, string | null>

class PathEvaluator {
  private readonly consts = new Map<string, ts.Expression>()
  private readonly functions = new Map<string, ts.FunctionLikeDeclaration>()
  private readonly lists = new Map<string, { expression: ts.Expression; index: number | null }>()
  private readonly overrides = new Map<ts.Node, string>()
  private readonly copies = new Map<string, ts.Expression>()
  constructor(private readonly root: string, private readonly file: string, sf: ts.SourceFile) {
    const collect = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
        if (!this.consts.has(n.name.text)) this.consts.set(n.name.text, n.initializer)
        const init = unwrapExpression(n.initializer)
        if ((ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && !this.functions.has(n.name.text)) this.functions.set(n.name.text, init)
      } else if (ts.isFunctionDeclaration(n) && n.name && !this.functions.has(n.name.text)) this.functions.set(n.name.text, n)
      else if (ts.isForOfStatement(n) && ts.isVariableDeclarationList(n.initializer)) {
        for (const d of n.initializer.declarations) {
          if (ts.isIdentifier(d.name) && !this.lists.has(d.name.text)) this.lists.set(d.name.text, { expression: n.expression, index: null })
          else if (ts.isArrayBindingPattern(d.name)) d.name.elements.forEach((el, i) => {
            if (!ts.isOmittedExpression(el) && ts.isIdentifier(el.name) && !this.lists.has(el.name.text)) this.lists.set(el.name.text, { expression: n.expression, index: i })
          })
        }
      }
      ts.forEachChild(n, collect)
    }
    collect(sf)
    const copyNames = new Set<string>()
    for (const statement of sf.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !/^(?:node:)?fs(?:\/promises)?$/.test(statement.moduleSpecifier.text)) continue
      const bindings = statement.importClause?.namedBindings
      if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) {
        if (['cp', 'cpSync', 'copyFile', 'copyFileSync'].includes((element.propertyName ?? element.name).text)) copyNames.add(element.name.text)
      }
    }
    const collectCopies = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && copyNames.has(node.expression.text) && node.arguments[0] && node.arguments[1]) {
        this.copies.set(unwrapExpression(node.arguments[1]).getText(sf), node.arguments[0])
      }
      ts.forEachChild(node, collectCopies)
    }
    collectCopies(sf)
  }

  localFunction(name: string): ts.FunctionLikeDeclaration | undefined {
    return this.functions.get(name)
  }

  initializerOf(name: string): ts.Expression | undefined {
    return this.consts.get(name)
  }

  callbackList(id: ts.Identifier): ts.Expression | null {
    let cur: ts.Node | undefined = id.parent
    while (cur && !ts.isSourceFile(cur)) {
      if ((ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) && cur.parameters[0] && ts.isIdentifier(cur.parameters[0].name) && cur.parameters[0].name.text === id.text) {
        const call = cur.parent
        if (ts.isCallExpression(call) && call.arguments[0] === cur && ts.isPropertyAccessExpression(call.expression) && ['map', 'flatMap', 'forEach', 'filter', 'some', 'every', 'find'].includes(call.expression.name.text)) {
          return this.arrayLiteralOf(call.expression.expression, 0) ? call.expression.expression : null
        }
        return null
      }
      cur = cur.parent
    }
    return null
  }

  arrayLiteralOf(e: ts.Expression, depth: number): ts.ArrayLiteralExpression | null {
    if (depth > 12) return null
    const x = unwrapExpression(e)
    if (ts.isArrayLiteralExpression(x)) return x
    if (ts.isIdentifier(x)) {
      const init = this.consts.get(x.text)
      return init ? this.arrayLiteralOf(init, depth + 1) : null
    }
    return null
  }

  objectLiteralOf(e: ts.Expression, depth: number): ts.ObjectLiteralExpression | null {
    if (depth > 12) return null
    const x = unwrapExpression(e)
    if (ts.isObjectLiteralExpression(x)) return x
    if (ts.isIdentifier(x)) {
      const init = this.consts.get(x.text)
      return init ? this.objectLiteralOf(init, depth + 1) : null
    }
    return null
  }

  evaluateAll(e: ts.Expression | undefined, env: Env = new Map(), depth = 0): string[] {
    if (!e || depth > 12) return []
    const x = unwrapExpression(e)
    if (ts.isArrayLiteralExpression(x)) {
      const out: string[] = []
      for (const el of x.elements) out.push(...this.evaluateAll(el, env, depth + 1))
      return out
    }
    if (ts.isConditionalExpression(x)) return [...this.evaluateAll(x.whenTrue, env, depth + 1), ...this.evaluateAll(x.whenFalse, env, depth + 1)]
    if (ts.isElementAccessExpression(x)) {
      const key = this.evaluate(x.argumentExpression, env, depth + 1)
      const obj = this.objectLiteralOf(x.expression, depth + 1)
      if (obj) {
        const out: string[] = []
        for (const prop of obj.properties) {
          if (!ts.isPropertyAssignment(prop)) continue
          const name = ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name) || ts.isNumericLiteral(prop.name) ? prop.name.text : null
          if (key !== null && name !== key) continue
          out.push(...this.evaluateAll(prop.initializer, env, depth + 1))
        }
        return out
      }
      const arr = this.arrayLiteralOf(x.expression, depth + 1)
      if (arr) {
        const out: string[] = []
        for (const el of arr.elements) out.push(...this.evaluateAll(el, env, depth + 1))
        return out
      }
    }
    if (ts.isBinaryExpression(x) && (x.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || x.operatorToken.kind === ts.SyntaxKind.BarBarToken)) return [...this.evaluateAll(x.left, env, depth + 1), ...this.evaluateAll(x.right, env, depth + 1)]
    if (ts.isIdentifier(x) && !env.has(x.text) && !ROOT_ANCHORS.has(x.text) && !SRC_ANCHORS.has(x.text) && !SCRIPTS_ANCHORS.has(x.text) && !DIR_ANCHORS.has(x.text)) {
      const fromCallback = this.callbackList(x)
      if (fromCallback) return this.evaluateAll(fromCallback, env, depth + 1)
      const list = this.lists.get(x.text)
      if (list) {
        if (list.index === null) return this.evaluateAll(list.expression, env, depth + 1)
        const source = this.arrayLiteralOf(list.expression, depth + 1)
        if (!source) return []
        const out: string[] = []
        for (const el of source.elements) if (ts.isArrayLiteralExpression(el) && el.elements[list.index]) out.push(...this.evaluateAll(el.elements[list.index], env, depth + 1))
        return out
      }
      const init = this.consts.get(x.text)
      if (init) return this.evaluateAll(init, env, depth + 1)
    }
    if (ts.isTemplateExpression(x) || (ts.isCallExpression(x) && x.arguments.length > 0) || (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.PlusToken)) {
      const pieces: ts.Expression[] = ts.isTemplateExpression(x) ? x.templateSpans.map(sp => sp.expression) : ts.isCallExpression(x) ? [...x.arguments] : [x.left, x.right]
      const parts: string[][] = pieces.map(piece => this.evaluateAll(piece, env, depth + 1))
      if (parts.every(v => v.length > 0)) {
        const out: string[] = []
        const walk = (i: number): void => {
          if (i === pieces.length) {
            const v = this.evaluate(x, env, depth + 1)
            if (v !== null) out.push(v)
            return
          }
          for (const v of parts[i]!) {
            this.overrides.set(pieces[i]!, v)
            walk(i + 1)
            this.overrides.delete(pieces[i]!)
          }
        }
        walk(0)
        return out
      }
    }
    const one = this.evaluate(x, env, depth)
    return one === null ? [] : [one]
  }

  evaluate(e: ts.Expression | undefined, env: Env = new Map(), depth = 0): string | null {
    if (!e || depth > 12) return null
    const over = this.overrides.get(e)
    if (over !== undefined) return over
    const x = unwrapExpression(e)
    const copiedFrom = this.copies.get(x.getText())
    if (copiedFrom) return this.evaluate(copiedFrom, env, depth + 1)
    if (ts.isStringLiteralLike(x)) return x.text
    if (ts.isTemplateExpression(x)) {
      let out = x.head.text
      for (const span of x.templateSpans) {
        const v = this.evaluate(span.expression, env, depth + 1)
        if (v === null) return null
        out += v + span.literal.text
      }
      return out
    }
    if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const l = this.evaluate(x.left, env, depth + 1)
      const r = this.evaluate(x.right, env, depth + 1)
      return l === null || r === null ? null : l + r
    }
    if (ts.isBinaryExpression(x) && (x.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || x.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
      return this.evaluate(x.left, env, depth + 1) ?? this.evaluate(x.right, env, depth + 1)
    }
    if (ts.isConditionalExpression(x)) return this.evaluate(x.whenTrue, env, depth + 1) ?? this.evaluate(x.whenFalse, env, depth + 1)
    if (ts.isIdentifier(x)) {
      if (env.has(x.text)) return env.get(x.text) ?? null
      const own = this.consts.get(x.text)
      if (own) {
        const v = this.evaluate(own, env, depth + 1)
        if (v !== null) return v
      }
      if (ROOT_ANCHORS.has(x.text)) return this.root
      if (SRC_ANCHORS.has(x.text)) return join(this.root, 'src')
      if (SCRIPTS_ANCHORS.has(x.text)) return join(this.root, 'scripts')
      if (DIR_ANCHORS.has(x.text)) return dirname(this.file)
      return null
    }
    if (ts.isMetaProperty(x) && x.keywordToken === ts.SyntaxKind.ImportKeyword) return null
    if (ts.isPropertyAccessExpression(x)) {
      if (ts.isMetaProperty(x.expression) && (x.name.text === 'dir' || x.name.text === 'dirname')) return dirname(this.file)
      if (ts.isMetaProperty(x.expression) && (x.name.text === 'url' || x.name.text === 'filename' || x.name.text === 'path')) return this.file
      if (x.name.text === 'href' || x.name.text === 'pathname') return this.evaluate(x.expression, env, depth + 1)
      return null
    }
    if (ts.isNewExpression(x) && ts.isIdentifier(x.expression) && x.expression.text === 'URL' && x.arguments && x.arguments.length >= 1) {
      const rel = this.evaluate(x.arguments[0], env, depth + 1)
      const base = x.arguments[1] ? this.evaluate(x.arguments[1], env, depth + 1) : this.file
      if (rel === null || base === null) return null
      return rel.startsWith('/') ? rel : resolve(dirname(base.replace(/^file:\/\//, '')), rel.replace(/^file:\/\//, ''))
    }
    if (ts.isCallExpression(x)) {
      const callee = x.expression
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : ''
      if (name === 'join' || name === 'resolve') {
        const parts: string[] = []
        for (const a of x.arguments) {
          const v = this.evaluate(a, env, depth + 1)
          if (v === null) return null
          parts.push(v.replace(/^file:\/\//, ''))
        }
        if (parts.length === 0) return null
        return name === 'resolve' ? resolve(...parts) : join(...parts)
      }
      if (name === 'pathToFileURL' || name === 'fileURLToPath' || name === 'normalize' || name === 'toNamespacedPath') return this.evaluate(x.arguments[0], env, depth + 1)
      if (name === 'stringify' && ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'JSON') return this.evaluate(x.arguments[0], env, depth + 1)
      if (name === 'dirname') {
        const v = this.evaluate(x.arguments[0], env, depth + 1)
        return v === null ? null : dirname(v.replace(/^file:\/\//, ''))
      }
      if (name === 'replace' || name === 'replaceAll' || name === 'trim') return this.evaluate(ts.isPropertyAccessExpression(callee) ? callee.expression : undefined, env, depth + 1)
      if (name === 'cwd' && ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'process') return this.root
      if (ts.isIdentifier(callee)) {
        const fn = this.functions.get(callee.text)
        if (fn) {
          const body = returnedExpression(fn)
          if (!body) return null
          const inner: Env = new Map()
          fn.parameters.forEach((param, i) => {
            if (ts.isIdentifier(param.name)) inner.set(param.name.text, x.arguments[i] ? this.evaluate(x.arguments[i], env, depth + 1) : param.initializer ? this.evaluate(param.initializer, env, depth + 1) : null)
          })
          return this.evaluate(body, inner, depth + 1)
        }
      }
      return null
    }
    return null
  }
}

function returnedExpression(fn: ts.FunctionLikeDeclaration): ts.Expression | undefined {
  const body = fn.body
  if (!body) return undefined
  if (!ts.isBlock(body)) return body as ts.Expression
  for (const st of body.statements) if (ts.isReturnStatement(st)) return st.expression
  return undefined
}

const TREE_PATH_TAIL = /(?:^|\/)((?:src|scripts|sdk)\/[A-Za-z0-9_@./-]+\.(?:tsx?|m?js|cjs|jsx))(?=$|['"`])/

function treePathTail(text: string): string | null {
  const m = TREE_PATH_TAIL.exec(text)
  return m ? m[1]! : null
}

function resolveModule(root: string, fromFile: string, spec: string, stubMap: Record<string, string>): string | null {
  if (spec.startsWith('file://')) spec = spec.slice('file://'.length)
  const absolute = isAbsolute(spec) ? spec : spec.startsWith('.') ? resolve(dirname(fromFile), spec) : join(root, spec)
  for (const [delivered, source] of Object.entries(stubMap)) {
    if (isAbsolute(delivered) && (absolute === delivered || absolute.startsWith(delivered + sep))) {
      return resolveModule(root, fromFile, source + absolute.slice(delivered.length), {})
    }
  }
  if (isAbsolute(spec)) {
    const candidates = [spec, spec.replace(/\.js$/, '.ts'), spec.replace(/\.js$/, '.tsx'), spec + '.ts', spec + '.tsx', join(spec, 'index.ts'), join(spec, 'index.tsx')]
    for (const c of candidates) if (existsSync(c) && statSync(c).isFile()) return c
    return null
  }
  if (spec.startsWith('src/') || spec.startsWith('scripts/') || spec.startsWith('sdk/')) {
    const abs = join(root, spec)
    const candidates = [abs, abs.replace(/\.js$/, '.ts'), abs.replace(/\.js$/, '.tsx'), abs + '.ts', abs + '.tsx', join(abs, 'index.ts'), join(abs, 'index.tsx')]
    for (const c of candidates) if (existsSync(c) && statSync(c).isFile()) return c
    return null
  }
  return resolveSpec(fromFile, spec, stubMap)
}

interface Scan {
  reads: Reads
  opaque: Opaque
  stars: Map<string, Set<string>>
  unresolved: UnresolvedLoad[]
  literals: Map<string, Set<string>>
  regexTexts: Map<string, string[]>
  regexLiterals: Map<string, Array<{ source: string; flags: string }>>
  namedModules: Map<string, Set<string>>
  namedDirs: Map<string, Set<string>>
  moduleMarkers: Map<string, number>
  rowsByFile: Map<string, ExportRow[]>
  embeddedScripts: Set<string>
  exportScanners: Set<string>
  exportedNamespaces: Set<string>
}

const CODE_LIKE = /\b(?:import\s*\(|require\s*\(|import\s+(?:type\s+)?[{*\w]|export\s*(?:\*|\{))/
const EXPORT_ENUMERATOR = /\b(?:ExportKeyword|isExportDeclaration|isExportAssignment|isExportSpecifier|isNamedExports|getExportsOfModule)\b/
const PATTERN_PIN_SOURCE = /export(?:\\s[*+]?|\s)+(?:default|declare|async|abstract|function|const|let|var|class|type|interface|enum|namespace|module)\b/
const PROBE_HEADS = ['export const zzProbeZz = 1', 'export function zzProbeZz() {}', 'export type ZzProbeZz = 1', 'export interface ZzProbeZz {}', 'export class ZzProbeZz {}', 'export async function zzProbeZz(): Promise<void> {}']

function addRead(scan: Scan, target: string, name: string, reader: string): void {
  let byName = scan.reads.get(target)
  if (!byName) scan.reads.set(target, (byName = new Map()))
  let set = byName.get(name)
  if (!set) byName.set(name, (set = new Set()))
  set.add(reader)
}

function addOpaque(scan: Scan, target: string, reader: string): void {
  let set = scan.opaque.get(target)
  if (!set) scan.opaque.set(target, (set = new Set()))
  set.add(reader)
}

function addNamed(scan: Scan, target: string, reader: string): void {
  let set = scan.namedModules.get(target)
  if (!set) scan.namedModules.set(target, (set = new Set()))
  set.add(reader)
}

function scanCodeFile(opts: CensusOptions, scan: Scan, abs: string, text: string, isSubject: boolean): void {
  const sf = parseFile(abs, text)
  const evaluator = new PathEvaluator(opts.root, abs, sf)
  const rows: ExportRow[] = []
  const literals = new Set<string>()
  const regexTexts: string[] = []
  const regexLiterals: Array<{ source: string; flags: string }> = []
  let markers = 0
  const exportScanner = EXPORT_ENUMERATOR.test(text) && !opts.generators.has(slash(relative(opts.root, abs)))
  if (exportScanner) scan.exportScanners.add(abs)
  const bindings: Array<{ target: string; ident: ts.Identifier; scope: ts.Node }> = []

  const target = (spec: string): string | null => {
    const t = resolveModule(opts.root, abs, spec, opts.stubMap)
    if (t) addNamed(scan, t, abs)
    return t
  }
  const literalTails = (arg: ts.Expression, depth = 0): string[] => {
    const out: string[] = []
    const walk = (n: ts.Node): void => {
      if (ts.isIdentifier(n) && depth < 4) {
        const init = evaluator.initializerOf(n.text)
        if (init) out.push(...literalTails(init, depth + 1))
      } else if (ts.isStringLiteralLike(n)) {
        const tail = treePathTail(n.text)
        if (tail) out.push(tail)
      } else if (ts.isTemplateExpression(n)) {
        for (const chunk of [n.head.text, ...n.templateSpans.map(sp => sp.literal.text)]) {
          const tail = treePathTail(chunk)
          if (tail) out.push(tail)
        }
      }
      ts.forEachChild(n, walk)
    }
    walk(arg)
    return out
  }
  const enclosingFunction = (n: ts.Node): ts.FunctionLikeDeclaration | undefined => {
    let cur: ts.Node | undefined = n.parent
    while (cur && !ts.isSourceFile(cur)) {
      if (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur) || ts.isFunctionDeclaration(cur) || ts.isMethodDeclaration(cur)) return cur
      cur = cur.parent
    }
    return undefined
  }
  const functionName = (fn: ts.FunctionLikeDeclaration): string | null => {
    if (ts.isFunctionDeclaration(fn) && fn.name) return fn.name.text
    if (ts.isMethodDeclaration(fn) && ts.isIdentifier(fn.name)) return fn.name.text
    const p = fn.parent
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text
    if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) return p.name.text
    return null
  }
  const callSitesOf = (name: string): ts.CallExpression[] => {
    const out: ts.CallExpression[] = []
    const walk = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) {
        const callee = n.expression
        if ((ts.isIdentifier(callee) && callee.text === name) || (ts.isPropertyAccessExpression(callee) && callee.name.text === name)) out.push(n)
      }
      ts.forEachChild(n, walk)
    }
    walk(sf)
    return out
  }
  const loaderCallSites = (call: ts.CallExpression, arg: ts.Expression): Array<{ site: ts.CallExpression; targets: string[] }> => {
    const fn = enclosingFunction(call)
    if (!fn || fn.parameters.length === 0) return []
    const name = functionName(fn)
    if (!name) return []
    const out: Array<{ site: ts.CallExpression; targets: string[] }> = []
    for (const site of callSitesOf(name)) {
      if (site === call) continue
      const env: Env = new Map()
      fn.parameters.forEach((param, i) => {
        if (ts.isIdentifier(param.name)) env.set(param.name.text, site.arguments[i] ? evaluator.evaluate(site.arguments[i], new Map()) : param.initializer ? evaluator.evaluate(param.initializer) : null)
      })
      const specs = evaluator.evaluateAll(arg, env)
      const targets = specs.map(sp => resolveModule(opts.root, abs, sp, opts.stubMap)).filter((t): t is string => t !== null)
      if (targets.length) out.push({ site, targets })
    }
    return out
  }
  const enclosingParameters = (n: ts.Node): Set<string> => {
    const out = new Set<string>()
    let cur: ts.Node | undefined = n.parent
    while (cur && !ts.isSourceFile(cur)) {
      if (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur) || ts.isFunctionDeclaration(cur) || ts.isMethodDeclaration(cur)) for (const p of cur.parameters) if (ts.isIdentifier(p.name)) out.add(p.name.text)
      cur = cur.parent
    }
    return out
  }
  const namesParameter = (arg: ts.Expression): boolean => {
    const params = enclosingParameters(arg)
    if (!params.size) return false
    let found = false
    const walk = (n: ts.Node): void => {
      if (ts.isIdentifier(n) && params.has(n.text) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) found = true
      ts.forEachChild(n, walk)
    }
    walk(arg)
    return found
  }
  const specsOf = (arg: ts.Expression | undefined): string[] => {
    if (!arg) return []
    const lit = stringText(arg)
    if (lit !== null) return [lit]
    if (namesParameter(arg)) return []
    const composed = evaluator.evaluateAll(arg)
    if (composed.length) return composed
    return literalTails(arg)
  }
  const recordUnresolved = (node: ts.Node): void => {
    scan.unresolved.push({ file: slash(relative(opts.root, abs)), line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text: node.getText(sf).replace(/\s+/g, ' ').slice(0, 120) })
  }

  const isExportedDeclaration = (decl: ts.VariableDeclaration): boolean => {
    const list = decl.parent
    return ts.isVariableDeclarationList(list) && ts.isVariableStatement(list.parent) && hasModifier(list.parent, ts.SyntaxKind.ExportKeyword) !== undefined
  }
  const bindPattern = (t: string, name: ts.BindingName, scope: ts.Node): void => {
    if (ts.isIdentifier(name)) bindings.push({ target: t, ident: name, scope })
    else if (ts.isObjectBindingPattern(name)) {
      for (const el of name.elements) {
        if (el.dotDotDotToken) {
          addOpaque(scan, t, abs)
          continue
        }
        const pn = el.propertyName ?? el.name
        if (ts.isIdentifier(pn) || ts.isStringLiteral(pn) || ts.isNumericLiteral(pn)) addRead(scan, t, pn.text, abs)
        else if (ts.isComputedPropertyName(pn)) {
          const lit = stringText(pn.expression)
          if (lit !== null) addRead(scan, t, lit, abs)
          else addOpaque(scan, t, abs)
        } else addOpaque(scan, t, abs)
      }
    } else addOpaque(scan, t, abs)
  }

  const dynamicLoad = (call: ts.CallExpression, t: string): void => {
    let node: ts.Node = call
    let p: ts.Node = node.parent
    for (;;) {
      if (ts.isParenthesizedExpression(p) || ts.isAwaitExpression(p) || ts.isAsExpression(p) || ts.isTypeAssertionExpression(p) || ts.isNonNullExpression(p) || ts.isSatisfiesExpression(p)) {
        node = p
        p = p.parent
        continue
      }
      if (ts.isPropertyAccessExpression(p) && p.expression === node && (p.name.text === 'catch' || p.name.text === 'finally') && ts.isCallExpression(p.parent) && p.parent.expression === p) {
        node = p.parent
        p = node.parent
        continue
      }
      break
    }
    if (ts.isVariableDeclaration(p) && p.initializer === node) {
      if (ts.isIdentifier(p.name) && isExportedDeclaration(p)) {
        scan.exportedNamespaces.add(`${abs}:${p.name.text}`)
        addOpaque(scan, t, abs)
      }
      return bindPattern(t, p.name, sf)
    }
    if (ts.isPropertyAccessExpression(p) && p.expression === node) {
      if (p.name.text === 'then' && ts.isCallExpression(p.parent) && p.parent.expression === p) {
        const cb = p.parent.arguments[0]
        if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) {
          const param = cb.parameters[0]
          if (!param) return
          return bindPattern(t, param.name, cb)
        }
        return addOpaque(scan, t, abs)
      }
      return addRead(scan, t, p.name.text, abs)
    }
    if (ts.isElementAccessExpression(p) && p.expression === node) {
      const lit = stringText(p.argumentExpression)
      return lit !== null ? addRead(scan, t, lit, abs) : addOpaque(scan, t, abs)
    }
    if (ts.isExpressionStatement(p)) return
    if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.right === node && ts.isIdentifier(p.left)) {
      bindings.push({ target: t, ident: p.left, scope: sf })
      return
    }
    addOpaque(scan, t, abs)
  }

  const embeddedModules = (chunks: string[], spans: ts.Expression[]): string[] => {
    const out = new Set<string>()
    for (const chunk of chunks) {
      const tail = treePathTail(chunk)
      if (tail) {
        const t = resolveModule(opts.root, abs, tail, opts.stubMap)
        if (t) out.add(t)
      }
    }
    for (const sp of spans) {
      for (const v of [...evaluator.evaluateAll(sp), ...literalTails(sp)]) {
        const t = resolveModule(opts.root, abs, v, opts.stubMap)
        if (t) out.add(t)
      }
    }
    return [...out]
  }
  const embedded = (chunks: string[], spans: ts.Expression[]): void => {
    if (!CODE_LIKE.test(chunks.join(' \u0000 '))) return
    const targets = embeddedModules(chunks, spans)
    if (!targets.length) return
    scan.embeddedScripts.add(abs)
    for (const t of targets) {
      addNamed(scan, t, abs)
      addOpaque(scan, t, abs)
    }
  }

  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) {
      literals.add(node.text)
      if (ts.isNoSubstitutionTemplateLiteral(node) || node.text.includes('\n')) embedded([node.text], [])
    } else if (ts.isTemplateExpression(node)) {
      literals.add(node.head.text)
      for (const s of node.templateSpans) literals.add(s.literal.text)
      regexTexts.push(node.getText(sf))
      embedded([node.head.text, ...node.templateSpans.map(s => s.literal.text)], node.templateSpans.map(s => s.expression))
    } else if (ts.isRegularExpressionLiteral(node)) {
      regexTexts.push(node.text)
      const m = /^\/(.*)\/([a-z]*)$/s.exec(node.text)
      if (m && PATTERN_PIN_SOURCE.test(m[1]!)) regexLiterals.push({ source: m[1]!, flags: m[2]! })
    }

    if (ts.isImportDeclaration(node)) {
      markers++
      const spec = stringText(node.moduleSpecifier)
      const t = spec === null ? null : target(spec)
      if (t && node.importClause) {
        const c = node.importClause
        if (c.name) addRead(scan, t, 'default', abs)
        if (c.namedBindings) {
          if (ts.isNamespaceImport(c.namedBindings)) bindings.push({ target: t, ident: c.namedBindings.name, scope: sf })
          else for (const el of c.namedBindings.elements) addRead(scan, t, (el.propertyName ?? el.name).text, abs)
        }
      }
    } else if (ts.isExportDeclaration(node)) {
      markers++
      const spec = node.moduleSpecifier ? stringText(node.moduleSpecifier) : null
      const t = spec === null ? null : target(spec)
      if (node.moduleSpecifier) {
        if (node.exportClause && ts.isNamedExports(node.exportClause)) {
          for (const el of node.exportClause.elements) {
            if (t) addRead(scan, t, (el.propertyName ?? el.name).text, abs)
            if (isSubject) rows.push(row(el.name.text, 'named-reexport', node.isTypeOnly || el.isTypeOnly, []))
          }
        } else if (node.exportClause && ts.isNamespaceExport(node.exportClause)) {
          if (t) addOpaque(scan, t, abs)
          if (isSubject) rows.push(row(node.exportClause.name.text, 'namespace-reexport', node.isTypeOnly, []))
        } else {
          if (t) {
            let set = scan.stars.get(abs)
            if (!set) scan.stars.set(abs, (set = new Set()))
            set.add(t)
          }
          if (isSubject) rows.push(row('*', 'star-reexport', node.isTypeOnly, []))
        }
      } else if (node.exportClause && ts.isNamedExports(node.exportClause) && isSubject) {
        for (const el of node.exportClause.elements) rows.push(row(el.name.text, 'local-list', node.isTypeOnly || el.isTypeOnly, []))
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      markers++
      const ref = node.moduleReference
      if (ts.isExternalModuleReference(ref)) {
        const spec = stringText(ref.expression)
        const t = spec === null ? null : target(spec)
        if (t) bindings.push({ target: t, ident: node.name, scope: sf })
      }
      if (isSubject && hasModifier(node, ts.SyntaxKind.ExportKeyword)) rows.push(declarationRow(node, [node.name.text], false))
    } else if (ts.isExportAssignment(node)) {
      markers++
      if (isSubject) rows.push(row(node.isExportEquals ? '=' : 'default', node.isExportEquals ? 'export-equals' : 'default-assignment', false, []))
    } else if (ts.isCallExpression(node) && isModuleLoadCall(node)) {
      const arg = node.arguments[0]
      if (arg) {
        const pathLike = (sp: string): boolean => sp.startsWith('/') || sp.startsWith('.') || sp.startsWith('file://') || /(?:^|\/)(?:src|scripts)\//.test(sp)
        const lit = stringText(arg)
        let settled = false
        if (lit !== null) {
          const t = target(lit)
          if (t) dynamicLoad(node, t)
          else if (pathLike(lit)) recordUnresolved(node)
          settled = true
        }
        if (!settled && namesParameter(arg)) {
          const sites = loaderCallSites(node, arg)
          if (sites.length) {
            const fn = enclosingFunction(node)
            const returned = fn ? returnedExpression(fn) : undefined
            const returnsTheLoad = returned !== undefined && unwrapExpression(returned) === node
            for (const { site, targets: ts2 } of sites) for (const t of ts2) {
              addNamed(scan, t, abs)
              dynamicLoad(returnsTheLoad ? site : node, t)
            }
            settled = true
          }
        }
        if (!settled) {
          const composed = evaluator.evaluateAll(arg)
          const targets = composed.map(sp => target(sp)).filter((t): t is string => t !== null)
          if (targets.length) {
            for (const t of targets) dynamicLoad(node, t)
            settled = true
          } else if (composed.some(pathLike)) {
            recordUnresolved(node)
            settled = true
          }
        }
        if (!settled) {
          const tails = literalTails(arg).map(sp => target(sp)).filter((t): t is string => t !== null)
          if (tails.length) for (const t of tails) dynamicLoad(node, t)
          else recordUnresolved(node)
        }
      }
    } else if (ts.isImportTypeNode(node)) {
      const arg = node.argument
      const spec = ts.isLiteralTypeNode(arg) && ts.isStringLiteralLike(arg.literal) ? arg.literal.text : null
      const t = spec === null ? null : target(spec)
      if (t) {
        if (node.qualifier) addRead(scan, t, leftmostIdentifier(node.qualifier).text, abs)
        else {
          const p = node.parent
          if (ts.isIndexedAccessTypeNode(p) && p.objectType === node && ts.isLiteralTypeNode(p.indexType) && ts.isStringLiteralLike(p.indexType.literal)) addRead(scan, t, p.indexType.literal.text, abs)
          else if ((ts.isAsExpression(p) || ts.isTypeAssertionExpression(p) || ts.isSatisfiesExpression(p)) && isModuleLoadCall(unwrapExpression(p.expression))) {
            const inner = unwrapExpression(p.expression) as ts.CallExpression
            const innerTargets = specsOf(inner.arguments[0]).map(sp => resolveModule(opts.root, abs, sp, opts.stubMap))
            if (!innerTargets.includes(t)) addOpaque(scan, t, abs)
          } else addOpaque(scan, t, abs)
        }
      }
    } else if (isSubject && node.parent === sf && hasModifier(node, ts.SyntaxKind.ExportKeyword)) {
      const isDefault = hasModifier(node, ts.SyntaxKind.DefaultKeyword) !== undefined
      if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
        if (isDefault) rows.push(node.name ? declarationRow(node, ['default'], false, 'default-declaration') : row('default', 'default-anonymous', false, []))
        else if (node.name) rows.push(declarationRow(node, [node.name.text], false))
      } else if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) rows.push(declarationRow(node, [node.name.text], true))
      else if (ts.isEnumDeclaration(node)) rows.push(declarationRow(node, [node.name.text], false))
      else if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name)) rows.push(declarationRow(node, [node.name.text], false))
      else if (ts.isVariableStatement(node)) {
        const names: string[] = []
        for (const d of node.declarationList.declarations) bindingNames(d.name, names)
        const st = statementOf(node, names)
        for (const n of names) rows.push({ file: abs, name: n, form: 'declaration', typeOnly: false, statements: [st], readers: [], opaque: false, typeSideOnly: false, class: 'candidate', inventory: false })
      }
    }

    const jsDoc = (node as { jsDoc?: ts.JSDoc[] }).jsDoc
    if (jsDoc) for (const d of jsDoc) ts.forEachChild(d, visit)
    ts.forEachChild(node, visit)
  }

  function statementOf(node: ts.Node, names: string[]): ExportStatement {
    const exp = hasModifier(node, ts.SyntaxKind.ExportKeyword)!
    const def = hasModifier(node, ts.SyntaxKind.DefaultKeyword)
    let modifierEnd = def ? Math.max(def.end, exp.end) : exp.end
    while (modifierEnd < text.length && /[ \t]/.test(text[modifierEnd]!)) modifierEnd++
    const start = node.getStart(sf)
    const eol = text.indexOf('\n', start)
    return { start, end: node.end, modifierStart: exp.getStart(sf), modifierEnd, names, head: text.slice(start, eol === -1 ? node.end : Math.min(eol, node.end)) }
  }
  function declarationRow(node: ts.Node, names: string[], typeOnly: boolean, form: ExportForm = 'declaration'): ExportRow {
    return { file: abs, name: names[0]!, form, typeOnly, statements: [statementOf(node, names)], readers: [], opaque: false, typeSideOnly: false, class: 'candidate', inventory: false }
  }
  function row(name: string, form: ExportForm, typeOnly: boolean, statements: ExportStatement[]): ExportRow {
    return { file: abs, name, form, typeOnly, statements, readers: [], opaque: false, typeSideOnly: false, class: 'candidate', inventory: false }
  }

  visit(sf)

  const queue = [...bindings]
  const seenBinding = new Set<string>()
  while (queue.length) {
    const b = queue.shift()!
    const key = `${b.target}\u0000${b.ident.pos}`
    if (seenBinding.has(key)) continue
    seenBinding.add(key)
    const name = b.ident.text
    const walk = (n: ts.Node): void => {
      if (ts.isIdentifier(n) && n.text === name && n !== b.ident) {
        const p = n.parent
        if (ts.isPropertyAccessExpression(p) && p.expression === n) addRead(scan, b.target, p.name.text, abs)
        else if (ts.isPropertyAccessExpression(p) && p.name === n) {
        } else if (ts.isElementAccessExpression(p) && p.expression === n) {
          const lit = stringText(p.argumentExpression)
          if (lit !== null) addRead(scan, b.target, lit, abs)
          else addOpaque(scan, b.target, abs)
        } else if (ts.isQualifiedName(p) && p.left === n) addRead(scan, b.target, p.right.text, abs)
        else if (ts.isQualifiedName(p) && p.right === n) {
        } else if (ts.isTypeQueryNode(p)) {
          const q = p.parent
          if (ts.isIndexedAccessTypeNode(q) && q.objectType === p && ts.isLiteralTypeNode(q.indexType) && ts.isStringLiteralLike(q.indexType.literal)) addRead(scan, b.target, q.indexType.literal.text, abs)
          else addOpaque(scan, b.target, abs)
        } else if (ts.isVariableDeclaration(p) && p.initializer === n) {
          if (ts.isIdentifier(p.name)) queue.push({ target: b.target, ident: p.name, scope: sf })
          else bindPattern(b.target, p.name, sf)
        } else if ((ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p) || ts.isPropertySignature(p) || ts.isEnumMember(p) || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)) && p.name === n) {
        } else if (ts.isBindingElement(p) && p.propertyName === n) {
        } else if ((ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isFunctionDeclaration(p) || ts.isClassDeclaration(p) || ts.isTypeAliasDeclaration(p) || ts.isInterfaceDeclaration(p) || ts.isEnumDeclaration(p) || ts.isModuleDeclaration(p)) && p.name === n) {
        } else if (ts.isImportSpecifier(p) || ts.isNamespaceImport(p) || ts.isImportClause(p) || ts.isImportEqualsDeclaration(p)) {
        } else if (ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) {
        } else if (ts.isJsxAttribute(p) && p.name === n) {
        } else if (ts.isBindingElement(p) && p.name === n && !p.propertyName) {
        } else addOpaque(scan, b.target, abs)
      }
      ts.forEachChild(n, walk)
    }
    walk(b.scope)
  }

  const named = literalModulePaths(opts, abs, sf, evaluator)
  for (const t of named.modules) addNamed(scan, t, abs)
  if (named.dirs.size) scan.namedDirs.set(abs, named.dirs)
  if (exportScanner) for (const t of named.modules) addOpaque(scan, t, abs)
  scan.literals.set(abs, literals)
  scan.regexTexts.set(abs, regexTexts)
  if (regexLiterals.length) scan.regexLiterals.set(abs, regexLiterals)
  scan.moduleMarkers.set(abs, markers)
  if (isSubject) scan.rowsByFile.set(abs, rows)
}

function literalModulePaths(opts: CensusOptions, abs: string, sf: ts.SourceFile, evaluator: PathEvaluator): { modules: Set<string>; dirs: Set<string> } {
  const out = new Set<string>()
  const dirs = new Set<string>()
  const tryPath = (p: string | null): void => {
    if (p === null) return
    if (/\.(ts|tsx|mts|js|mjs|cjs|jsx)$/.test(p) || p.startsWith('src/') || p.startsWith('scripts/')) {
      const t = resolveModule(opts.root, abs, p.startsWith('/') || p.startsWith('.') || p.startsWith('src/') || p.startsWith('scripts/') || p.startsWith('sdk/') ? p : './' + p, opts.stubMap)
      if (t) out.add(t)
    }
    if (p.startsWith(opts.root + '/') && !/\.[a-z]+$/.test(p) && existsSync(p) && statSync(p).isDirectory()) dirs.add(p)
  }
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteralLike(n) && n.text.includes('/')) tryPath(n.text)
    else if (ts.isTemplateExpression(n)) for (const v of evaluator.evaluateAll(n)) if (v.includes('/')) tryPath(v)
    else if (ts.isCallExpression(n)) {
      const callee = n.expression
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : ''
      if (name === 'join' || name === 'resolve') tryPath(evaluator.evaluate(n))
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return { modules: out, dirs }
}

const SHELL_IMPORT = /import\s*(?:type\s+)?(?:\{([^}]*)\}|\*\s*as\s*([A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*))\s*from\s*['"]([^'"\n]+)['"]/g

function scanShellFile(opts: CensusOptions, scan: Scan, abs: string, text: string): number {
  let n = 0
  for (const m of text.matchAll(SHELL_IMPORT)) {
    let spec = m[4]!
    spec = spec.replace(/^"?\$\{?(?:repo|root|ROOT|REPO|REPO_ROOT|repoRoot|REAL_ROOT)\}?"?\//, opts.root + '/')
    spec = spec.replace(/^"?\$\{?(?:here|HERE|dir|DIR|SUITE_DIR)\}?"?\//, dirname(abs) + '/')
    spec = spec.replace(/^"?\$\(dirname "\$0"\)"?\//, dirname(abs) + '/')
    if (spec.includes('$')) continue
    const t = resolveModule(opts.root, abs, spec.startsWith('/') || spec.startsWith('.') || spec.startsWith('src/') || spec.startsWith('scripts/') ? spec : './' + spec, opts.stubMap)
    if (!t) continue
    addNamed(scan, t, abs)
    n++
    if (m[1] !== undefined) for (const part of m[1].split(',')) {
      const nm = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]!.trim()
      if (nm) addRead(scan, t, nm, abs)
    } else if (m[2] !== undefined) addOpaque(scan, t, abs)
    else if (m[3] !== undefined) addRead(scan, t, 'default', abs)
  }
  return n
}

function propagateStars(scan: Scan): void {
  const starsOf = (f: string): string[] => [...(scan.stars.get(f) ?? [])]
  const localNames = new Map<string, Set<string>>()
  for (const [f, rows] of scan.rowsByFile) localNames.set(f, new Set(rows.filter(r => r.form !== 'star-reexport').map(r => r.name)))
  let changed = true
  let rounds = 0
  while (changed && rounds++ < 50) {
    changed = false
    for (const [f, byName] of [...scan.reads]) {
      const targets = starsOf(f)
      if (!targets.length) continue
      const local = localNames.get(f)
      for (const [name, readers] of byName) {
        if (local?.has(name)) continue
        for (const t of targets) {
          const before = scan.reads.get(t)?.get(name)?.size ?? 0
          for (const r of readers) addRead(scan, t, name, r)
          if ((scan.reads.get(t)?.get(name)?.size ?? 0) !== before) changed = true
        }
      }
    }
    for (const [f, readers] of [...scan.opaque]) {
      for (const t of starsOf(f)) {
        const before = scan.opaque.get(t)?.size ?? 0
        for (const r of readers) addOpaque(scan, t, r)
        if ((scan.opaque.get(t)?.size ?? 0) !== before) changed = true
      }
    }
  }
}

function matchesAny(rel: string, globs: string[]): boolean {
  return globs.some(g => new Bun.Glob(g).match(rel))
}

const normaliseRegex = (src: string): string => src.replace(/\\s[*+]?/g, ' ').replace(/\\b/g, '').replace(/\\\(/g, '(').replace(/\^/g, '')

export function runCensus(opts: CensusOptions): ExportCensus {
  const scan: Scan = { reads: new Map(), opaque: new Map(), stars: new Map(), unresolved: [], literals: new Map(), regexTexts: new Map(), regexLiterals: new Map(), namedModules: new Map(), namedDirs: new Map(), moduleMarkers: new Map(), rowsByFile: new Map(), embeddedScripts: new Set(), exportScanners: new Set(), exportedNamespaces: new Set() }
  const subjects = new Set(opts.subjects.map(f => join(opts.root, f)))
  let shellReads = 0
  const readerAbs = [...new Set([...opts.readers, ...opts.subjects])].map(f => join(opts.root, f)).sort()
  for (const abs of readerAbs) {
    let text: string
    try {
      text = readFileSync(abs, 'utf8')
    } catch {
      continue
    }
    if (CODE_FILE.test(abs)) scanCodeFile(opts, scan, abs, text, subjects.has(abs))
    else if (/\.(sh|bash)$/.test(abs)) shellReads += scanShellFile(opts, scan, abs, text)
  }
  for (const abs of subjects) if (!scan.rowsByFile.has(abs)) scan.rowsByFile.set(abs, [])
  propagateStars(scan)

  const pinSources = opts.pinSources.map(f => join(opts.root, f))
  const pinDeclarations = new Set<string>()
  const pinNamesByFile = new Map<string, Set<string>>()
  for (const abs of pinSources) {
    if (!TEXT_PIN_FILE.test(abs)) continue
    const texts: string[] = []
    if (CODE_FILE.test(abs)) {
      const lits = scan.literals.get(abs)
      if (lits) {
        for (const l of lits) texts.push(l)
        pinNamesByFile.set(abs, lits)
      } else {
        try {
          const sf = parseFile(abs, readFileSync(abs, 'utf8'))
          const lits = new Set<string>()
          const regs: string[] = []
          const visit = (n: ts.Node): void => {
            if (ts.isStringLiteralLike(n)) lits.add(n.text)
            else if (ts.isTemplateExpression(n)) {
              lits.add(n.head.text)
              for (const s of n.templateSpans) lits.add(s.literal.text)
              regs.push(n.getText(sf))
            } else if (ts.isRegularExpressionLiteral(n)) regs.push(n.text)
            ts.forEachChild(n, visit)
          }
          visit(sf)
          scan.literals.set(abs, lits)
          scan.regexTexts.set(abs, regs)
          for (const l of lits) texts.push(l)
          pinNamesByFile.set(abs, lits)
        } catch {
          continue
        }
      }
      for (const r of scan.regexTexts.get(abs) ?? []) texts.push(normaliseRegex(r))
    } else {
      let raw: string
      try {
        raw = readFileSync(abs, 'utf8')
      } catch {
        continue
      }
      texts.push(raw)
      const quoted = new Set<string>()
      for (const m of raw.matchAll(/["'`]([A-Za-z_$][\w$]*)["'`]/g)) quoted.add(m[1]!)
      pinNamesByFile.set(abs, quoted)
      const named = new Set<string>()
      for (const m of raw.matchAll(/(?:src|scripts|sdk)\/[A-Za-z0-9_@./-]+\.(?:tsx?|m?js)/g)) {
        const t = resolveModule(opts.root, abs, m[0], opts.stubMap)
        if (t) named.add(t)
      }
      for (const t of named) addNamed(scan, t, abs)
    }
    for (const t of texts) for (const m of t.matchAll(DECLARATION_PIN)) pinDeclarations.add(m[1]!)
  }

  const pinSourceSet = new Set(pinSources)
  const patterns: Array<{ file: string; re: RegExp; broad: boolean }> = []
  for (const [file, list] of scan.regexLiterals) {
    if (!pinSourceSet.has(file)) continue
    for (const { source, flags } of list) {
      let re: RegExp
      try {
        re = new RegExp(source, flags.replace(/[gy]/g, ''))
      } catch {
        continue
      }
      patterns.push({ file, re, broad: PROBE_HEADS.some(h => re.test(h)) })
    }
  }
  const scopedTo = (proof: string, abs: string): boolean => {
    if (scan.namedModules.get(abs)?.has(proof)) return true
    for (const d of scan.namedDirs.get(proof) ?? []) if (abs.startsWith(d + '/')) return true
    return false
  }
  const entry = new Set(opts.entrypoints.map(f => join(opts.root, f)))
  const rowsSurface = new Set(opts.rowsSurface.map(f => join(opts.root, f)))
  const orphan = new Set(opts.orphanBaseline.map(f => join(opts.root, f)))
  const rows: ExportRow[] = []
  for (const [abs, fileRows] of scan.rowsByFile) {
    const rel = slash(relative(opts.root, abs))
    const byName = scan.reads.get(abs)
    const opaqueReaders = scan.opaque.get(abs)
    const grouped = new Map<string, ExportRow>()
    for (const r of fileRows) {
      const key = `${r.form === 'star-reexport' ? '*' : r.name}\u0000${r.form === 'local-list' || r.form === 'named-reexport' || r.form === 'star-reexport' || r.form === 'namespace-reexport' ? r.form : 'decl'}`
      const g = grouped.get(key)
      if (g) {
        g.statements.push(...r.statements)
        g.typeOnly = g.typeOnly && r.typeOnly
      } else grouped.set(key, { ...r, file: rel, statements: [...r.statements] })
    }
    for (const r of grouped.values()) {
      const readers = new Set<string>([...(byName?.get(r.name) ?? []), ...(opaqueReaders ?? [])])
      readers.delete(abs)
      r.readers = [...readers].map(x => slash(relative(opts.root, x))).sort()
      r.opaque = (opaqueReaders?.size ?? 0) > 0
      r.typeSideOnly = r.readers.length > 0 && r.readers.every(x => x.endsWith('.d.ts'))
      r.inventory = opts.inventory.has(`${rel}\u0000${r.name}`)
      r.class = classify(r, abs, rel)
      rows.push(r)
    }
  }

  function classify(r: ExportRow, abs: string, rel: string): ExportClass {
    if (r.readers.length > 0) return 'read'
    if (entry.has(abs)) return 'entrypoint'
    if (rowsSurface.has(abs)) return 'rows-surface'
    if (rel.endsWith('.d.ts')) return 'declaration-file'
    if (matchesAny(rel, opts.generated) || /\.generated\./.test(rel)) return 'generated'
    if (matchesAny(rel, opts.fixtures)) return 'fixture'
    if (orphan.has(abs)) return 'orphan-baseline'
    if (r.form === 'named-reexport' || r.form === 'star-reexport' || r.form === 'namespace-reexport' || r.form === 'local-list') return 're-export'
    if (r.form === 'default-assignment' || r.form === 'export-equals' || r.form === 'default-anonymous') return 'default-assignment'
    if (pinDeclarations.has(r.name)) return 'text-pin'
    for (const reader of scan.namedModules.get(abs) ?? []) {
      if (reader === abs) continue
      if (pinNamesByFile.get(reader)?.has(r.name)) return 'text-pin'
    }
    for (const p of patterns) {
      if (p.file === abs) continue
      if (p.broad && !scopedTo(p.file, abs)) continue
      if (r.statements.some(s => p.re.test(s.head))) return 'pattern-pin'
    }
    return 'candidate'
  }

  const byFile = new Map<string, ExportRow[]>()
  for (const r of rows) {
    const list = byFile.get(r.file)
    if (list) list.push(r)
    else byFile.set(r.file, [r])
  }
  for (const [rel, list] of byFile) {
    const abs = join(opts.root, rel)
    let changed = true
    while (changed) {
      changed = false
      const kept = new Set<ExportStatement>()
      for (const r of list) if (r.class !== 'candidate') for (const s of r.statements) kept.add(s)
      for (const r of list) {
        if (r.class !== 'candidate') continue
        if (r.statements.some(s => kept.has(s))) {
          r.class = 'shared-statement'
          changed = true
        }
      }
    }
    const markers = scan.moduleMarkers.get(abs) ?? 0
    const exportStatements = new Set<ExportStatement>()
    for (const r of list) for (const s of r.statements) exportStatements.add(s)
    const candidateStatements = new Set<ExportStatement>()
    for (const r of list) if (r.class === 'candidate') for (const s of r.statements) candidateStatements.add(s)
    if (candidateStatements.size > 0 && markers === 0 && candidateStatements.size === exportStatements.size) for (const r of list) if (r.class === 'candidate') r.class = 'module-anchor'
  }

  rows.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name) || a.form.localeCompare(b.form))
  const tally = {} as Record<ExportClass, number>
  for (const c of ['read', ...Object.keys(KEPT_CLASSES), 'candidate'] as ExportClass[]) tally[c] = 0
  for (const r of rows) tally[r.class] = (tally[r.class] ?? 0) + 1
  const namedBy = new Map<string, string[]>()
  for (const [t, readers] of scan.namedModules) namedBy.set(slash(relative(opts.root, t)), [...readers].map(r => slash(relative(opts.root, r))).sort())
  return { root: opts.root, subjects: opts.subjects, readers: opts.readers, rows, unresolved: scan.unresolved.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line), shellReads, tally, namedBy, wholeReads: { embeddedScripts: scan.embeddedScripts.size, exportScanners: scan.exportScanners.size, exportedNamespaces: scan.exportedNamespaces.size } }
}

export function treeOptions(root = GRAPH_ROOT): CensusOptions {
  const tracked = trackedFiles(root)
  const code = tracked.filter(f => CODE_FILE.test(f) || /\.(sh|bash)$/.test(f))
  const outside = (f: string): boolean => f.startsWith('node_modules/') || f.startsWith('dist/') || f.startsWith('vendor/') || f.startsWith('bench/')
  const readers = code.filter(f => !outside(f))
  const subjects = tracked.filter(f => (f.startsWith('src/') || f.startsWith('scripts/')) && CODE_FILE.test(f))
  const entrypoints = tracked.filter(f => f.startsWith('src/entrypoints/') || f === 'src/main.tsx' || f === 'build.ts')
  const rowsSurface = tracked.filter(f => f.startsWith('src/rows/'))
  const generated: string[] = []
  const generators = new Set<string>()
  const mapPath = join(root, 'scripts', 'gate', 'generated-assets.tsv')
  if (existsSync(mapPath)) {
    for (const line of readFileSync(mapPath, 'utf8').split('\n')) {
      if (!line || line.startsWith('#')) continue
      const cells = line.split('\t')
      for (const a of (cells[0] ?? '').split(/\s+/)) if (a) generated.push(a)
      for (const cell of [cells[1] ?? '', cells[2] ?? '']) for (const m of cell.matchAll(/scripts\/[A-Za-z0-9_@./-]+\.(?:ts|mjs|js|sh)/g)) generators.add(m[0])
    }
  }
  const fixtures = ['**/fixtures/**', '**/fixture/**', '**/goldens/**', '**/__fixtures__/**']
  const baselinePath = join(root, 'scripts', 'orphans', 'baseline.json')
  const orphanBaseline = existsSync(baselinePath) ? (JSON.parse(readFileSync(baselinePath, 'utf8')) as { rows: Array<{ file: string }> }).rows.map(r => r.file) : []
  const inventory = new Set<string>()
  const inventoryPath = join(root, 'scripts', 'ownership', 'contract-inventory.json')
  if (existsSync(inventoryPath)) {
    const inv = JSON.parse(readFileSync(inventoryPath, 'utf8')) as { modules: Record<string, Record<string, string[]>> }
    for (const files of Object.values(inv.modules)) for (const [file, names] of Object.entries(files)) for (const n of names) inventory.add(`${file}\u0000${n.replace(/^type:/, '')}`)
  }
  const generatedSet = (f: string): boolean => matchesAny(f, generated)
  const pinSources = tracked.filter(f => (f.startsWith('scripts/') || f.startsWith('.github/') || f === 'build.ts' || f === 'package.json' || f.startsWith('sdk/')) && TEXT_PIN_FILE.test(f) && !generatedSet(f))
  const stubMap = readStubMap()
  const bundledPath = join(root, 'src/extensions/bundled/content.generated.ts')
  if (existsSync(bundledPath)) {
    const text = readFileSync(bundledPath, 'utf8')
    const payloads = JSON.parse(text.slice(text.indexOf('=') + 1)) as Record<string, Record<string, string>>
    for (const manifest of tracked.filter(f => /^src\/extensions\/bundled\/[^/]+\/mercury-extension\.json$/.test(f))) {
      const name = manifest.split('/')[3]!
      for (const source of tracked.filter(f => f.startsWith('src/extensions/bundled/shared/') && CODE_FILE.test(f))) {
        const delivered = source.slice('src/extensions/bundled/'.length)
        if (payloads[name]?.[delivered] === readFileSync(join(root, source), 'utf8')) stubMap[join(root, dirname(manifest), delivered)] = join(root, source)
      }
    }
  }
  return { root, subjects, readers, stubMap, entrypoints, rowsSurface, generated, fixtures, orphanBaseline, inventory, pinSources, generators }
}

interface RewriteResult {
  file: string
  removed: number
  names: string[]
  before: string
  after: string
}

export function rewriteFile(root: string, rel: string, rows: ExportRow[]): RewriteResult {
  const abs = join(root, rel)
  const before = readFileSync(abs, 'utf8')
  const ranges = new Map<number, ExportStatement>()
  const names = new Set<string>()
  for (const r of rows) {
    if (r.class !== 'candidate') continue
    for (const s of r.statements) ranges.set(s.modifierStart, s)
    names.add(r.name)
  }
  const ordered = [...ranges.values()].sort((a, b) => b.modifierStart - a.modifierStart)
  let after = before
  for (const s of ordered) {
    const slice = before.slice(s.modifierStart, s.modifierEnd)
    if (!/^export(\s+default)?\s*$/.test(slice)) throw new Error(`${rel}: the modifier range at ${s.modifierStart} reads ${JSON.stringify(slice)}, not an export modifier`)
    after = after.slice(0, s.modifierStart) + after.slice(s.modifierEnd)
  }
  const sfBefore = parseFile(abs, before)
  const sfAfter = parseFile(abs, after)
  const diagnostics = (sfAfter as unknown as { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics
  if (diagnostics.length) throw new Error(`${rel}: the rewritten text does not parse: ${ts.flattenDiagnosticMessageText(diagnostics[0]!.messageText, ' ')}`)
  if (sfBefore.statements.length !== sfAfter.statements.length) throw new Error(`${rel}: the statement count moved (${sfBefore.statements.length} → ${sfAfter.statements.length})`)
  for (let i = 0; i < sfBefore.statements.length; i++) if (sfBefore.statements[i]!.kind !== sfAfter.statements[i]!.kind) throw new Error(`${rel}: statement ${i} changed kind`)
  const stripped = ordered.reduce((n, s) => n + (s.modifierEnd - s.modifierStart), 0)
  if (after.length !== before.length - stripped) throw new Error(`${rel}: the byte count moved by more than the modifiers`)
  return { file: rel, removed: ordered.length, names: [...names].sort(), before, after }
}
