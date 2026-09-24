#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { commentRanges } from '../lib/commentBytes.mjs'
import {
  ModuleCache,
  callSites,
  calleeName,
  declarationOf,
  forOfOf,
  functionOf,
  importedDeclaration,
  isDynamicImport,
  isFunctionNode,
  lineOf,
  namedFunctionDecl,
  parseSource,
  referencesOf,
  returnedExpressions,
  rootDeclarationOf,
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

const LOCATORS = new Set(['indexOf', 'lastIndexOf', 'includes', 'startsWith', 'endsWith', 'search', 'match', 'matchAll', 'split', 'replace', 'replaceAll'])
const REGEX_CALLS = new Set(['exec', 'test'])
const ITERATORS = new Set(['map', 'filter', 'some', 'every', 'find', 'findIndex', 'findLast', 'findLastIndex', 'forEach', 'flatMap'])
const PATH_CALLS = new Set(['join', 'resolve'])
const COLLECTORS = new Set(['push', 'unshift', 'add', 'set', 'concat'])
const STRIPPED_FILE = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx|cs|rs)$/

export type AnchorHit = { file: string; line: number; method: string; anchor: string; receiver: string }
type Anchor = { text: string; regex: boolean }
type Site = { call: ts.CallExpression; method: string; anchor: ts.Expression; receiver: ts.Expression }

function stringShaped(text: string): boolean {
  const t = text.replace(/^\s+/, '')
  if (!t.startsWith('//') && !t.startsWith('/*') && !t.startsWith('*')) return false
  return /\S/.test(t.replace(/^[/*!]+/, ''))
}

function regexCarriesText(src: string): boolean {
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!
    if (c === '\\') {
      const n = src[i + 1] ?? ''
      i++
      if ('dDwWsSbBnrtfv0'.includes(n)) continue
      if (n === 'u') {
        i = src[i + 1] === '{' ? Math.max(i, src.indexOf('}', i)) : i + 4
        continue
      }
      if (n === 'x') {
        i += 2
        continue
      }
      if (n === 'c') {
        i += 1
        continue
      }
      if (n === 'p' || n === 'P' || n === 'k') {
        const close = src.indexOf(n === 'k' ? '>' : '}', i)
        i = close < 0 ? src.length : close
        continue
      }
      if (n === '*' || n === '/' || n === '') continue
      if (/\S/.test(n)) return true
      continue
    }
    if (c === '[') {
      let j = i + 1
      while (j < src.length && src[j] !== ']') j += src[j] === '\\' ? 2 : 1
      i = j
      continue
    }
    if (c === '(') {
      const group = /^\((?:\?:|\?=|\?!|\?<=|\?<!|\?<[A-Za-z_$][\w$]*>)/.exec(src.slice(i))
      if (group) i += group[0].length - 1
      continue
    }
    if (c === '{' && /^\{\d+(?:,\d*)?\}/.test(src.slice(i))) {
      i = src.indexOf('}', i)
      continue
    }
    if (')|?+*.^$/!'.includes(c) || /\s/.test(c)) continue
    return true
  }
  return false
}

function regexShaped(source: string): boolean {
  let s = source.replace(/^\^/, '')
  const lead = /^(?:\\s[*+?]?|\\t[*+?]?|\\n[*+?]?|\[ \\t\][*+?]?|\[\\t \][*+?]?| [*+?]?)*/.exec(s)
  s = s.slice(lead ? lead[0].length : 0)
  const delimiter = /^(?:\\\/\\\/|\\\/\\\*|\\\*)/.exec(s)
  if (!delimiter) return false
  return regexCarriesText(s.slice(delimiter[0].length).replace(/^(?:\\\*|\\\/|!)*/, ''))
}

function strippedByPublish(text: string): boolean {
  const t = text.replace(/^\s+/, '')
  const firstLine = t.split('\n')[0] ?? ''
  let comment: string
  if (t.startsWith('//')) comment = firstLine
  else if (t.startsWith('/*')) {
    const end = t.indexOf('*/')
    comment = end >= 0 ? t.slice(0, end + 2) : `${t} */`
  } else comment = `/*${firstLine} */`
  return (commentRanges('anchor.ts', `${comment}\n`) as unknown[]).length > 0
}

function commentAnchor(anchors: Anchor[]): Anchor | undefined {
  return anchors.find(a => (a.regex ? regexShaped(a.text) : stringShaped(a.text) && strippedByPublish(a.text)))
}

function elementsOf(e: ts.Expression, depth: number): ts.Expression[] {
  if (depth > 6) return []
  const x = unwrap(e)
  if (ts.isArrayLiteralExpression(x)) return x.elements.flatMap(el => (ts.isSpreadElement(el) ? elementsOf(el.expression, depth + 1) : [el]))
  if (ts.isIdentifier(x)) {
    const d = declarationOf(x)
    if (d && ts.isVariableDeclaration(d) && d.initializer) return elementsOf(d.initializer, depth + 1)
  }
  return []
}

function callbackSource(param: ts.ParameterDeclaration): ts.Expression | undefined {
  const fn = param.parent
  if (!(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) || fn.parameters[0] !== param) return undefined
  const call = fn.parent
  if (!ts.isCallExpression(call) || !call.arguments.some(a => a === fn)) return undefined
  const callee = unwrap(call.expression)
  return ts.isPropertyAccessExpression(callee) && ITERATORS.has(callee.name.text) ? callee.expression : undefined
}

function anchorsOf(e: ts.Expression, depth: number): Anchor[] {
  if (depth > 6) return []
  const x = unwrap(e)
  const lit = stringText(x)
  if (lit !== undefined) return [{ text: lit, regex: false }]
  if (ts.isRegularExpressionLiteral(x)) return [{ text: x.text.slice(1, x.text.lastIndexOf('/')), regex: true }]
  if ((ts.isNewExpression(x) || ts.isCallExpression(x)) && ts.isIdentifier(x.expression) && x.expression.text === 'RegExp' && x.arguments && x.arguments[0]) {
    return anchorsOf(x.arguments[0], depth + 1).map(a => ({ text: a.text, regex: true }))
  }
  if (ts.isTemplateExpression(x)) return [{ text: x.head.text + x.templateSpans.map(s => `x${s.literal.text}`).join(''), regex: false }]
  if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const right = anchorsOf(x.right, depth + 1)
    const tail = right.length > 0 ? right : [{ text: 'x', regex: false }]
    return anchorsOf(x.left, depth + 1).flatMap(l => tail.map(r => ({ text: l.text + r.text, regex: l.regex })))
  }
  if (ts.isConditionalExpression(x)) return [...anchorsOf(x.whenTrue, depth + 1), ...anchorsOf(x.whenFalse, depth + 1)]
  if (ts.isIdentifier(x)) {
    const d = declarationOf(x)
    if (d && ts.isVariableDeclaration(d)) {
      const loop = forOfOf(d)
      if (loop) return elementsOf(loop.expression, depth + 1).flatMap(el => anchorsOf(el, depth + 1))
      return d.initializer ? anchorsOf(d.initializer, depth + 1) : []
    }
    if (d && ts.isParameter(d)) {
      const source = callbackSource(d)
      if (source) return elementsOf(source, depth + 1).flatMap(el => anchorsOf(el, depth + 1))
    }
  }
  return []
}

function isRegexValue(e: ts.Expression, depth = 0): boolean {
  const x = unwrap(e)
  if (ts.isRegularExpressionLiteral(x)) return true
  if ((ts.isNewExpression(x) || ts.isCallExpression(x)) && ts.isIdentifier(x.expression) && x.expression.text === 'RegExp') return true
  if (ts.isIdentifier(x) && depth < 4) {
    const d = declarationOf(x)
    return d !== undefined && ts.isVariableDeclaration(d) && d.initializer !== undefined && isRegexValue(d.initializer, depth + 1)
  }
  return false
}

function siteOf(call: ts.CallExpression): Site | null {
  const callee = unwrap(call.expression)
  if (!ts.isPropertyAccessExpression(callee) || call.arguments.length === 0) return null
  const method = callee.name.text
  if (LOCATORS.has(method)) return { call, method, anchor: call.arguments[0]!, receiver: callee.expression }
  if (REGEX_CALLS.has(method) && isRegexValue(callee.expression)) return { call, method, anchor: callee.expression, receiver: call.arguments[0]! }
  return null
}

function normalizeRel(p: string): string | null {
  const stack: string[] = []
  for (const seg of slash(p).split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (stack.length === 0) return null
      stack.pop()
      continue
    }
    stack.push(seg)
  }
  return stack.join('/')
}

const isAbsolutePath = (t: string): boolean => t.startsWith('/') || t.startsWith('~') || t.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(t)
const fromCwd = (t: string): string | null => (isAbsolutePath(t) ? null : normalizeRel(t))
const parentOf = (p: string | null): string | null => (p === null || p === '' ? null : p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')

function isMeta(x: ts.Expression, names: string[]): boolean {
  return ts.isPropertyAccessExpression(x) && ts.isMetaProperty(x.expression) && x.expression.keywordToken === ts.SyntaxKind.ImportKeyword && names.includes(x.name.text)
}

class Provenance {
  private readonly memo = new Map<ts.Node, boolean>()
  private readonly busy = new Set<ts.Node>()
  constructor(
    private readonly root: string,
    private readonly modules: ModuleCache,
  ) {}

  private isSrc(p: string | null): boolean {
    if (p === null || (p !== 'src' && !p.startsWith('src/'))) return false
    const last = p.slice(p.lastIndexOf('/') + 1)
    return !last.includes('.') || STRIPPED_FILE.test(last)
  }

  private dirOf(node: ts.Node): string | null {
    const rel = slash(relative(this.root, dirname(node.getSourceFile().fileName)))
    return rel.startsWith('..') ? null : rel
  }

  private valueOf(id: ts.Identifier): ts.Expression | undefined {
    const d = declarationOf(id)
    if (!d) return undefined
    if (ts.isVariableDeclaration(d)) return forOfOf(d) ? undefined : d.initializer
    const imported = importedDeclaration(this.modules, d)
    return imported && ts.isVariableDeclaration(imported) ? imported.initializer : undefined
  }

  private constString(arg: ts.Expression): string | undefined {
    const x = unwrap(arg)
    if (!ts.isIdentifier(x)) return undefined
    const v = this.valueOf(x)
    return v ? stringText(unwrap(v)) : undefined
  }

  private joinOf(args: readonly ts.Expression[], depth: number): string | null {
    if (args.length === 0) return ''
    let acc = this.pathOf(args[0]!, depth + 1)
    for (const arg of args.slice(1)) {
      if (acc === null) return null
      const lit = stringText(unwrap(arg)) ?? this.constString(arg)
      if (lit === undefined) {
        acc = `${acc}/*`
        continue
      }
      if (isAbsolutePath(lit)) return null
      acc = normalizeRel(`${acc}/${lit}`)
    }
    return acc
  }

  pathOf(e: ts.Expression, depth = 0): string | null {
    if (depth > 12) return null
    const x = unwrapAwait(e)
    const lit = stringText(x)
    if (lit !== undefined) return fromCwd(lit)
    if (isMeta(x, ['dir', 'dirname'])) return this.dirOf(x)
    if (ts.isIdentifier(x)) {
      if (x.text === '__dirname') return this.dirOf(x)
      const v = this.valueOf(x)
      return v ? this.pathOf(v, depth + 1) : null
    }
    if (ts.isCallExpression(x)) {
      const name = calleeName(x)
      const first = x.arguments[0]
      const callee = unwrap(x.expression)
      if (name === 'cwd' && ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'process') return ''
      if (name && PATH_CALLS.has(name)) return this.joinOf(x.arguments, depth)
      if ((name === 'fileURLToPath' || name === 'realpathSync' || name === 'normalize') && first) return this.pathOf(first, depth + 1)
      if (name === 'dirname' && first) return parentOf(this.pathOf(first, depth + 1))
      return null
    }
    if (ts.isNewExpression(x) && ts.isIdentifier(x.expression) && x.expression.text === 'URL' && x.arguments && x.arguments.length >= 2) {
      const spec = stringText(unwrap(x.arguments[0]!))
      const base = this.dirOf(x)
      if (spec === undefined || base === null || !isMeta(unwrap(x.arguments[1]!), ['url'])) return null
      return normalizeRel(`${base}/${spec}`)
    }
    if (ts.isPropertyAccessExpression(x) && x.name.text === 'pathname') return this.pathOf(x.expression, depth + 1)
    if (ts.isTemplateExpression(x)) {
      const spans = x.templateSpans
      if (x.head.text === '' && spans.length > 0) {
        const base = this.pathOf(spans[0]!.expression, depth + 1)
        if (base === null) return null
        return normalizeRel(`${base}/${spans[0]!.literal.text}${spans.slice(1).map(s => `*${s.literal.text}`).join('')}`)
      }
      return fromCwd(x.head.text + spans.map(s => `*${s.literal.text}`).join(''))
    }
    if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const tail = stringText(unwrap(x.right))
      const base = this.pathOf(x.left, depth + 1)
      return base === null || tail === undefined ? null : normalizeRel(`${base}/${tail}`)
    }
    return null
  }

  fromSrc(e: ts.Expression, depth = 0): boolean {
    if (depth > 16) return false
    const x = unwrapAwait(e)
    const known = this.memo.get(x)
    if (known !== undefined) return known
    if (this.busy.has(x)) return false
    this.busy.add(x)
    const out = this.compute(x, depth)
    this.busy.delete(x)
    this.memo.set(x, out)
    return out
  }

  private compute(x: ts.Expression, depth: number): boolean {
    if (stringText(x) !== undefined || isMeta(x, ['dir', 'dirname']) || ts.isNewExpression(x)) return this.isSrc(this.pathOf(x))
    if (ts.isIdentifier(x)) return this.identifier(x, depth)
    if (ts.isCallExpression(x)) {
      if (isDynamicImport(x)) return false
      const name = calleeName(x)
      if (name === 'require') return false
      if (name && (PATH_CALLS.has(name) || name === 'fileURLToPath' || name === 'dirname')) return this.isSrc(this.pathOf(x))
      const callee = unwrap(x.expression)
      if (ts.isPropertyAccessExpression(callee) && this.fromSrc(callee.expression, depth + 1)) return true
      if (x.arguments.some(a => !isFunctionNode(unwrap(a)) && this.fromSrc(a, depth + 1))) return true
      if (ts.isIdentifier(callee)) {
        const fn = functionOf(declarationOf(callee))
        if (fn && returnedExpressions(fn).some(r => this.fromSrc(r, depth + 1))) return true
      }
      return false
    }
    if (ts.isPropertyAccessExpression(x) || ts.isElementAccessExpression(x)) return this.fromSrc(x.expression, depth + 1)
    if (ts.isBinaryExpression(x)) return this.fromSrc(x.left, depth + 1) || this.fromSrc(x.right, depth + 1)
    if (ts.isConditionalExpression(x)) return this.fromSrc(x.whenTrue, depth + 1) || this.fromSrc(x.whenFalse, depth + 1)
    if (ts.isTemplateExpression(x)) return this.isSrc(this.pathOf(x)) || x.templateSpans.some(s => this.fromSrc(s.expression, depth + 1))
    if (ts.isArrayLiteralExpression(x)) return x.elements.some(el => this.fromSrc(ts.isSpreadElement(el) ? el.expression : el, depth + 1))
    return false
  }

  private identifier(id: ts.Identifier, depth: number): boolean {
    const d = declarationOf(id)
    if (!d) return false
    if (ts.isVariableDeclaration(d)) {
      const loop = forOfOf(d)
      if (loop) return this.fromSrc(loop.expression, depth + 1)
      if (d.initializer && !isDynamicImport(d.initializer) && this.fromSrc(d.initializer, depth + 1)) return true
      return this.mutated(d, id, depth)
    }
    if (ts.isBindingElement(d)) {
      const root = rootDeclarationOf(d)
      if (!root || !ts.isVariableDeclaration(root)) return false
      const loop = forOfOf(root)
      if (loop) return this.fromSrc(loop.expression, depth + 1)
      return root.initializer !== undefined && !isDynamicImport(root.initializer) && this.fromSrc(root.initializer, depth + 1)
    }
    if (ts.isParameter(d)) {
      const source = callbackSource(d)
      if (source) return this.fromSrc(source, depth + 1)
      const owner = namedFunctionDecl(d.parent)
      if (!owner) return false
      const index = (d.parent as ts.FunctionLikeDeclaration).parameters.indexOf(d)
      return callSites(id.getSourceFile(), owner).some(c => {
        const arg = c.arguments[index]
        return arg !== undefined && this.fromSrc(arg, depth + 1)
      })
    }
    const imported = importedDeclaration(this.modules, d)
    return imported !== undefined && ts.isVariableDeclaration(imported) && imported.initializer !== undefined && this.fromSrc(imported.initializer, depth + 1)
  }

  private mutated(decl: ts.VariableDeclaration, id: ts.Identifier, depth: number): boolean {
    if (!ts.isIdentifier(decl.name)) return false
    const init = decl.initializer ? unwrap(decl.initializer) : undefined
    const collection = init !== undefined && (ts.isArrayLiteralExpression(init) || ts.isObjectLiteralExpression(init) || ts.isNewExpression(init))
    for (const ref of referencesOf(id.getSourceFile(), decl, decl.name.text)) {
      const p = ref.parent
      if (ts.isPropertyAccessExpression(p) && p.expression === ref && COLLECTORS.has(p.name.text) && ts.isCallExpression(p.parent) && p.parent.expression === p) {
        if (p.parent.arguments.some(a => this.fromSrc(a, depth + 1))) return true
      }
      if (collection && ts.isCallExpression(p) && p.arguments.some(a => a === ref)) {
        if (p.arguments.some(a => a !== ref && !isFunctionNode(unwrap(a)) && this.fromSrc(a, depth + 1))) return true
      }
      if (ts.isBinaryExpression(p) && p.left === ref && (p.operatorToken.kind === ts.SyntaxKind.EqualsToken || p.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken)) {
        if (this.fromSrc(p.right, depth + 1)) return true
      }
    }
    return false
  }
}

function hitOf(src: Source, node: ts.Node, method: string, anchor: Anchor, receiver: ts.Expression): AnchorHit {
  return { file: src.rel, line: lineOf(node), method, anchor: anchor.regex ? `/${anchor.text}/` : anchor.text, receiver: textOf(receiver, 60) }
}

function judge(src: Source, site: Site, prov: Provenance): AnchorHit[] {
  const anchorExpr = unwrap(site.anchor)
  if (ts.isIdentifier(anchorExpr)) {
    const d = declarationOf(anchorExpr)
    if (d && ts.isParameter(d) && !callbackSource(d)) {
      const fn = d.parent as ts.FunctionLikeDeclaration
      const owner = namedFunctionDecl(fn)
      if (!owner) return []
      const anchorIndex = fn.parameters.indexOf(d)
      const recv = unwrap(site.receiver)
      const recvDecl = ts.isIdentifier(recv) ? declarationOf(recv) : undefined
      const recvIndex = recvDecl && ts.isParameter(recvDecl) && recvDecl.parent === fn ? fn.parameters.indexOf(recvDecl) : -1
      const out: AnchorHit[] = []
      for (const call of callSites(src.sf, owner)) {
        const arg = call.arguments[anchorIndex]
        const anchor = arg ? commentAnchor(anchorsOf(arg, 0)) : undefined
        if (!anchor) continue
        const receiver = recvIndex >= 0 ? call.arguments[recvIndex] : site.receiver
        if (receiver && prov.fromSrc(receiver)) out.push(hitOf(src, call, site.method, anchor, receiver))
      }
      return out
    }
  }
  const anchor = commentAnchor(anchorsOf(site.anchor, 0))
  if (!anchor || !prov.fromSrc(site.receiver)) return []
  return [hitOf(src, site.call, site.method, anchor, site.receiver)]
}

export function census(root: string): { files: number; hits: AnchorHit[] } {
  const modules = new ModuleCache(root)
  const hits: AnchorHit[] = []
  const files = walkProofs(root)
  for (const path of files) {
    const src = parseSource(root, path)
    const sites: Site[] = []
    visit(src.sf, n => {
      if (!ts.isCallExpression(n)) return
      const site = siteOf(n)
      if (site) sites.push(site)
    })
    if (sites.length === 0) continue
    const prov = new Provenance(root, modules)
    for (const site of sites) hits.push(...judge(src, site, prov))
  }
  return { files: files.length, hits }
}

const HIT_LINES: Array<[string, boolean]> = [
  ["import { readFileSync, readdirSync } from 'node:fs'", false],
  ["import { join } from 'node:path'", false],
  ["import { ROOT } from './world.ts'", false],
  ["const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')", false],
  ["const src = read('src/sample.ts')", false],
  ["const block = src.slice(src.indexOf('export function alpha'), src.indexOf('// ── the block end marker'))", true],
  ["const doc = src.lastIndexOf('/** Doc for beta')", true],
  ["const cont = readFileSync('src/sample.ts', 'utf8').includes(' * continuation line text')", true],
  ["const END = '// ── the block end marker'", false],
  ['const viaConst = src.indexOf(END)', true],
  ['const history = /\\* {3}v(\\d+) {2}([^\\n]+)/g', false],
  ['const ages = [...src.matchAll(history)]', true],
  ['const tested = /\\/\\/ ── the block end/.test(src)', true],
  ["for (const needle of ['export const beta', '// ── the block end marker']) src.includes(needle)", true],
  ['const between = (text: string, from: string, to: string): string => text.slice(text.indexOf(from), text.indexOf(to))', false],
  ["between(src, 'export function alpha', '// ── the block end marker')", true],
  ['const files: string[] = []', false],
  ['const walk = (dir: string, out: string[]): void => { for (const n of readdirSync(dir)) out.push(join(dir, n)) }', false],
  ["walk(join(ROOT, 'src'), files)", false],
  ["for (const f of files) readFileSync(f, 'utf8').startsWith('// ── the block end marker')", true],
  ["const lines = src.split('\\n').filter(line => line.includes('// ── the block end marker'))", true],
  ["const viaMeta = readFileSync(join(import.meta.dir, '..', '..', 'src', 'sample.ts'), 'utf8')", false],
  ["viaMeta.includes('/* a block comment line')", true],
  ["readFileSync(join(ROOT, 'src', 'sample.ts'), 'utf8').endsWith('// the closing comment\\n')", true],
  ["const url = readFileSync(new URL('../../src/sample.ts', import.meta.url), 'utf8')", false],
  ["url.search(/^\\s*\\/\\/ ── the block end/m)", true],
]

const CLEAN_LINES: string[] = [
  "import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'",
  "import { tmpdir } from 'node:os'",
  "import { join } from 'node:path'",
  "const ROOT = join(import.meta.dir, '..', '..')",
  "const src = readFileSync(join(ROOT, 'src', 'sample.ts'), 'utf8')",
  "src.indexOf('export function alpha')",
  "src.includes('fetch(\"https://example.invalid/x\")')",
  "src.includes('// @ts-expect-error a kept directive')",
  "src.split('\\n').map(line => line.indexOf('//'))",
  "src.replace(/\\/\\*[\\s\\S]*?\\*\\//g, '')",
  'const scan = /^\\s*\\/\\//.test(src)',
  "const doc = readFileSync(join(ROOT, 'src', 'skills', 'guide.md'), 'utf8')",
  "doc.includes('**Bold** in a markdown file under src')",
  "src.lastIndexOf('/**')",
  "const scratch = mkdtempSync(join(tmpdir(), 'fixture-'))",
  "readFileSync(join(scratch, 'src', 'a.ts'), 'utf8').startsWith('// alpha')",
  "const project = join(scratch, 'node-repo')",
  "mkdirSync(join(project, 'src'), { recursive: true })",
  "writeFileSync(join(project, 'src', 'index.ts'), 'export const x = 1\\n')",
  "const { surfaceMap } = await import('../../src/sample.ts')",
  "const generated = surfaceMap(project) ?? ''",
  "generated.includes('**CI**: 1 GitHub workflow')",
  "readFileSync(join(ROOT, 'README.md'), 'utf8').includes('**Bold** text')",
  "const mod = await import('../../src/sample.ts')",
  "String(mod.beta).includes('// a runtime value')",
  "const notes = '// a fixture line\\n'",
  "notes.startsWith('// a fixture')",
]

function selfTest(): boolean {
  const root = mkdtempSync(join(tmpdir(), 'comment-anchor-census-'))
  const write = (rel: string, lines: string[]): void => {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), `${lines.join('\n')}\n`)
  }
  let ok = false
  try {
    write('scripts/anchor-fixture/world.ts', ["import { join } from 'node:path'", "export const ROOT = join(import.meta.dir, '..', '..')"])
    write('scripts/anchor-fixture/prove-anchor-hits.ts', HIT_LINES.map(([line]) => line))
    write('scripts/anchor-fixture/prove-anchor-clean.ts', CLEAN_LINES)
    const got = census(root).hits
    const want = HIT_LINES.flatMap(([, hit], i) => (hit ? [`scripts/anchor-fixture/prove-anchor-hits.ts:${i + 1}`] : []))
    const seen = [...new Set(got.map(h => `${h.file}:${h.line}`))].sort()
    const exact = seen.join(' ') === [...want].sort().join(' ')
    const clean = !got.some(h => h.file.endsWith('prove-anchor-clean.ts'))
    ok = exact && clean && want.length >= 10
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] self-test: ${want.length} planted comment anchors on src/ text are each named once, and none of the code anchors, delimiter scanners, kept directives, scratch fixtures (a scratch project with its own src/ included), markdown or module values is${ok ? '' : ` — got ${JSON.stringify(seen)}, want ${JSON.stringify(want)}`}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  return ok
}

if (import.meta.main) {
  console.log('============================================================')
  console.log(' comment-anchor census — a source pin anchors on code the publish filter keeps')
  console.log('============================================================')
  let failures = selfTest() ? 0 : 1
  const { files, hits } = census(REAL_ROOT)
  console.log(`  census: ${files} proof files read · ${hits.length} anchor(s) on comment text of a src/ file`)
  for (const h of hits) {
    failures++
    console.log(`  [FAIL] ${h.file}:${h.line} .${h.method}(${JSON.stringify(h.anchor)}) on ${h.receiver} — the published tree strips this comment, so the anchor finds nothing there`)
  }
  if (hits.length === 0) console.log('  [PASS] no proof locates a position in src/ text by a comment the publish filter strips')
  if (REPORT && hits.length > 0) console.log(`\n${hits.map(h => `${h.file}:${h.line}`).join('\n')}`)
  console.log(`\n${failures === 0 ? '✅' : '❌'} prove-comment-anchor-census — ${failures === 0 ? 'all checks pass' : `${failures} check(s) failed`}`)
  process.exit(failures === 0 ? 0 : 1)
}
