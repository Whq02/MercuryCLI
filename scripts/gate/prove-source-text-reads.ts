#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { ModuleCache, calleeName, declarationOf, functionOf, importOf, importTarget, importedDeclaration, isDynamicImport, isFunctionNode, namedFunctionDecl, parseSource, referencesOf, returnedExpressions, rootDeclarationOf, slash, stringText, unwrap, unwrapAwait, visit } from './sourceCensus.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const SELF = 'scripts/gate/prove-source-text-reads.ts'
const TABLE = 'scripts/gate/source-text-reads.tsv'
const CODE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/
const SHELL = /\.(?:sh|bash|zsh|py|ps1)$|(?:^|\/)[^./]+$/
const SEP = String.raw`(?:\[[\\/]+\]|[\\/])+`
const NAME = 'A-Za-z0-9_@+-'
const OWN_TREE = String.raw`(?<![.${NAME}])(?<!(?<![$${NAME}])[${NAME}]+[\\/]+)`
const SPELLED = new RegExp(String.raw`${OWN_TREE}src(?:${SEP}(?:\\?[.-]|[A-Za-z0-9_@+])+)+`, 'gi')
const FOLDER = new RegExp(String.raw`${OWN_TREE}src(?:[\\/]+[.${NAME}]+)*[\\/]*$`, 'i')
const UNDER = new RegExp(String.raw`(?:(?<![.\\/${NAME}])|(?<=\$\{?[A-Za-z_][A-Za-z0-9_]*\}?"?[\\/]))[A-Za-z0-9_@][.${NAME}]*(?:[\\/]+[.${NAME}]+)+`, 'g')
const TAIL = new RegExp(String.raw`^[\\/]+[.\\/${NAME}]+`)
const QUOTED_SEGMENTS = /['"]\s*[,+/]\s*['"]/g
const IMPORT_SPELLED = /(?:\b(?:import|export)\b[^;'"`]*\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)\\?['"`](?:[^'"`\s]*[\\/])?$/
const IMPORT_OPEN = /(?:\b(?:import|export)\b[^;'"`]*\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)\\?['"`]?$/
const TEXT_IMPORT_SPELLED = /\bimport\b[^'"`;]*['"`][^'"`]*\bsrc[\\/][^'"`]*['"`]\s*with\s*\{\s*type:\s*\\?['"`](?:text|file)/
const AS_TEXT = /\b(?:text|file)\b/
const NAMES_SRC = /src/i
const UNKNOWN = '\0'
const STEPS = 2_000_000
const DEEP = 48
const READERS = new Set(['readFileSync', 'readFile', 'createReadStream', 'openSync'])
const RUNNERS = new Set(['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync'])
const READ_TOOL = /(?:^|[\s/])(?:grep|egrep|fgrep|rg|cat|sed|awk|head|tail|wc|diff|cmp|show|cat-file|blame)(?:$|\s)/
const JOINERS = new Set(['join', 'resolve'])
const PATH_MODULE = /^(?:path|posix|win32)$/i
const FIRST_ARG = new Set(['fileURLToPath', 'pathToFileURL', 'String', 'stringify', 'parse', 'normalize', 'realpathSync', 'from', 'fromEntries'])
const OF_OBJECT = new Set(['keys', 'values', 'entries'])
const KEEPS = new Set(['toString', 'text', 'json', 'trim', 'trimStart', 'trimEnd', 'toLowerCase', 'toUpperCase', 'slice', 'substring', 'substr', 'replace', 'replaceAll', 'normalize', 'split', 'join', 'filter', 'flat', 'reverse', 'toReversed', 'sort', 'toSorted', 'at', 'padEnd', 'padStart', 'repeat', 'match', 'matchAll', 'find', 'findLast', 'shift', 'pop', 'concat'])
const EACH = new Set(['map', 'flatMap', 'forEach', 'filter', 'some', 'every', 'find', 'findLast', 'findIndex', 'reduce'])
const FILLERS = new Set(['push', 'unshift', 'add', 'set'])
const SEARCHES = new Set(['includes', 'indexOf', 'match', 'search', 'split', 'startsWith', 'endsWith'])
const PATTERN_SEARCHES = new Set(['test', 'exec'])
const INSTEAD = 'import the module and call it, look the value up, or run the built product and read what it prints'

type Hit = { line: number; file: string }
type Name = Hit & { asText: boolean }
type Src = { files: Map<string, string>; folders: Set<string>; names: Set<string>; parts: Set<string> }
type Estate = { scripts: string[]; src: Src; listed: boolean }
type Facts = { pins: Map<string, number>; events: string[]; searches: Hit[]; namesOnly: Map<string, number>; folder: boolean; fragment: boolean; childText: boolean; shell: boolean; spent: boolean }
type Row = { pins: number; searches: number; digest: string }
type Table = Map<string, Row>
type Over = { script: string; why: string; lines: Hit[] }
type Verdict = { over: Over[]; pins: number; searches: number; allowed: number; slack: number }
type Value = { paths: string[]; text: string[] }
type Env = Map<ts.Node, Value>
type Cx = { root: string; src: Src; modules: ModuleCache; sf: ts.SourceFile; pins: Map<string, number>; events: Set<string>; searches: Hit[]; helpers: Set<ts.FunctionLikeDeclaration>; entered: Set<ts.Node>; stack: Set<ts.Node>; valuing: Set<ts.Node>; fills: Map<ts.Node, ts.Expression[]>; walked: Map<ts.Node, Map<string, Array<{ file: string; search: boolean }>>>; log: Array<{ file: string; search: boolean }>; steps: number; fragment: boolean }

const KNOWN = { decls: new WeakMap<ts.Identifier, ts.Node | null>(), fns: new WeakMap<ts.CallExpression, ts.FunctionLikeDeclaration | null>(), paths: new WeakMap<ts.Node, string[]>(), text: new WeakMap<ts.Node, string[]>(), inert: new WeakMap<ts.Node, boolean>(), pathsIn: new WeakMap<Env, Map<ts.Node, string[]>>(), textIn: new WeakMap<Env, Map<ts.Node, string[]>>() }

function declOf(id: ts.Identifier): ts.Node | undefined {
  let decl = KNOWN.decls.get(id)
  if (decl === undefined) {
    decl = declarationOf(id) ?? null
    KNOWN.decls.set(id, decl)
  }
  return decl ?? undefined
}

const ofTheModule = (decl: ts.VariableDeclaration): boolean => ts.isVariableStatement(decl.parent.parent) && ts.isSourceFile(decl.parent.parent.parent)

function nameOf(call: ts.CallExpression | ts.NewExpression): string | undefined {
  const callee = unwrap(call.expression)
  const decl = ts.isIdentifier(callee) ? declOf(callee) : undefined
  if (decl && (ts.isImportSpecifier(decl) || ts.isBindingElement(decl)) && decl.propertyName && ts.isIdentifier(decl.propertyName)) return decl.propertyName.text
  const held = decl && ts.isVariableDeclaration(decl) && decl.initializer ? unwrap(decl.initializer) : undefined
  return held && ts.isIdentifier(held) ? held.text : held && ts.isPropertyAccessExpression(held) ? held.name.text : calleeName(call)
}

function memberships(fn: ts.FunctionLikeDeclaration): ts.Expression[] {
  const param = fn.parameters[0]?.name
  const held: ts.Expression[] = []
  if (!fn.body || !param || !ts.isIdentifier(param)) return held
  visit(fn.body, n => {
    const callee = ts.isCallExpression(n) ? unwrap(n.expression) : undefined
    const asked = callee && ts.isCallExpression(n) && n.arguments[0] ? unwrap(n.arguments[0]) : undefined
    if (callee && ts.isPropertyAccessExpression(callee) && (callee.name.text === 'has' || callee.name.text === 'includes') && asked && ts.isIdentifier(asked) && asked.text === param.text) held.push(callee.expression)
  })
  return held
}

function srcOf(files: string[]): Src {
  const src: Src = { files: new Map(), folders: new Set(['src']), names: new Set(), parts: new Set(['src']) }
  for (const file of files) {
    if (!file.startsWith('src/')) continue
    const key = file.toLowerCase()
    src.files.set(key, file)
    src.names.add(key.slice(key.lastIndexOf('/') + 1))
    for (let at = key.lastIndexOf('/'); at > 3; at = key.lastIndexOf('/', at - 1)) src.folders.add(key.slice(0, at))
    for (const part of key.split('/')) src.parts.add(part).add(part.replace(/\.[^.]*$/, ''))
  }
  return src
}

function estateOf(root: string): Estate {
  let listed = ''
  try {
    listed = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'scripts', 'src'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return { scripts: [], src: srcOf([]), listed: false }
  }
  const files = [...new Set(listed.split('\0').filter(Boolean))].sort()
  return { scripts: files.filter(f => f.startsWith('scripts/')), src: srcOf(files), listed: true }
}

const pathOf = (spelled: string): string => spelled.replace(/\\([.-])/g, '$1').replace(new RegExp(SEP, 'g'), '/').toLowerCase()

function fileUnder(src: Src, folder: string, rest: string, least = 1): string | undefined {
  const parts = pathOf(rest).split('/').filter(Boolean)
  for (let n = parts.length; n >= least; n--) {
    const file = src.files.get(`${folder}/${parts.slice(0, n).join('/')}`.replace(/\.+$/, ''))
    if (file !== undefined) return file
  }
  return undefined
}

const fileAt = (src: Src, spelled: string): string | undefined => fileUnder(src, 'src', pathOf(spelled).slice(3))
const fileIn = (src: Src, folder: string, rel: string): string | undefined => src.files.get(pathOf(`${folder}/${rel}`))
const inAFolder = (rel: string): boolean => /[^\\/][\\/]+[^\\/]/.test(rel)
const baseName = (rel: string): string => pathOf(rel).replace(/^.*\//, '')

function spelledFolder(src: Src, text: string): string | undefined {
  const m = FOLDER.exec(text)
  const folder = m ? pathOf(m[0]).replace(/\/+$/, '') : undefined
  return folder !== undefined && src.folders.has(folder) ? folder : undefined
}

function folderOf(src: Src, e: ts.Expression, depth = 0): string | undefined {
  const x = unwrap(e)
  const text = stringText(x)
  if (text !== undefined) return spelledFolder(src, text)
  if (depth > 4) return undefined
  const under = (base: ts.Expression | undefined, rest: string): string | undefined => {
    const spelled = spelledFolder(src, rest)
    const folder = spelled !== undefined || base === undefined ? undefined : folderOf(src, base, depth + 1)
    const deeper = folder === undefined ? undefined : [folder, ...pathOf(rest).split('/').filter(Boolean)].join('/')
    return spelled ?? (deeper !== undefined && src.folders.has(deeper) ? deeper : undefined)
  }
  if (ts.isIdentifier(x)) {
    const decl = declOf(x)
    const known = decl && ts.isVariableDeclaration(decl) && decl.initializer ? folderOf(src, decl.initializer, depth + 1) : undefined
    return known ?? (NAMES_SRC.test(x.text) ? 'src' : undefined)
  }
  if (ts.isPropertyAccessExpression(x)) return NAMES_SRC.test(x.name.text) ? 'src' : undefined
  if (ts.isBinaryExpression(x)) {
    const op = x.operatorToken.kind
    const right = stringText(unwrap(x.right))
    if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken) return folderOf(src, x.right, depth + 1)
    return op === ts.SyntaxKind.PlusToken && right !== undefined ? under(x.left, right) : undefined
  }
  if (ts.isTemplateExpression(x)) return x.head.text === '' && x.templateSpans.length === 1 ? under(x.templateSpans[0]!.expression, x.templateSpans[0]!.literal.text) : undefined
  if (!ts.isCallExpression(x)) return undefined
  const args = [...x.arguments]
  let start = args.length
  while (start > 0 && stringText(unwrap(args[start - 1]!)) !== undefined) start--
  if (start === args.length) return args.length === 1 ? folderOf(src, args[0]!, depth + 1) : undefined
  return under(
    args[start - 1],
    args
      .slice(start)
      .map(a => stringText(unwrap(a))!)
      .join('/'),
  )
}

const loadsModule = (callee: ts.Expression): boolean =>
  callee.kind === ts.SyntaxKind.ImportKeyword ||
  (ts.isIdentifier(callee) && callee.text === 'require') ||
  (ts.isPropertyAccessExpression(callee) && callee.name.text === 'module' && ts.isIdentifier(callee.expression) && callee.expression.text === 'mock')

function handsToImport(callee: ts.Identifier, index: number): boolean {
  const fn = functionOf(declOf(callee))
  const param = fn?.parameters[index]?.name
  if (!fn?.body || !param || !ts.isIdentifier(param)) return false
  const carried = new Set([param.text])
  const carries = (e: ts.Node): boolean => {
    let hit = false
    visit(e, n => {
      if (ts.isIdentifier(n) && carried.has(n.text)) hit = true
    })
    return hit
  }
  let found = false
  visit(fn.body, n => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && carries(n.initializer)) carried.add(n.name.text)
    if (ts.isCallExpression(n) && loadsModule(unwrap(n.expression)) && n.arguments[0] && carries(n.arguments[0])) found = true
  })
  return found
}

function importKind(node: ts.Node): 'module' | 'text' | null {
  for (let at = node; at.parent; at = at.parent) {
    const p = at.parent
    if ((ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) && p.moduleSpecifier === at) return p.attributes && AS_TEXT.test(p.attributes.getText()) ? 'text' : 'module'
    if (ts.isExternalModuleReference(p) || ts.isImportTypeNode(p)) return 'module'
    if (ts.isTemplateSpan(p) && p.expression === at) {
      const spans = p.parent.templateSpans
      const i = spans.indexOf(p)
      if (IMPORT_OPEN.test(i === 0 ? p.parent.head.text : spans[i - 1]!.literal.text)) return 'module'
    }
    if (ts.isCallExpression(p) && p.arguments.includes(at as ts.Expression)) {
      const callee = unwrap(p.expression)
      const options = callee.kind === ts.SyntaxKind.ImportKeyword ? p.arguments[1] : undefined
      if (options && (!ts.isObjectLiteralExpression(options) || AS_TEXT.test(options.getText()))) return 'text'
      if (loadsModule(callee) || (ts.isIdentifier(callee) && handsToImport(callee, p.arguments.indexOf(at as ts.Expression)))) return 'module'
    }
    if (ts.isStatement(p) || ts.isSourceFile(p)) return null
  }
  return null
}

const isLiteral = (node: ts.Node): boolean => ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isRegularExpressionLiteral(node)

function codeNames(sf: ts.SourceFile, src: Src): { names: Name[]; folder: boolean; childText: boolean } {
  const text = sf.text
  const names: Name[] = []
  let folder = false
  let childText = false
  const spelledAsImport = (at: number): boolean => IMPORT_SPELLED.test(text.slice(Math.max(0, at - 240), at))
  const named = (node: ts.Node, at: number, file: string | undefined, asImport = false): void => {
    if (file === undefined) return
    const kind = importKind(node)
    if (kind === 'module' || (kind === null && asImport)) return
    names.push({ line: sf.getLineAndCharacterOfPosition(at).line + 1, file, asText: kind === 'text' })
  }
  const aFolder = (spelled: string): void => {
    const found = spelledFolder(src, spelled.replace(/[\\/]*[*{].*$/, ''))
    if (found !== undefined && found !== 'src') folder = true
  }
  visit(sf, node => {
    if (isLiteral(node)) {
      const start = node.getStart(sf)
      const raw = text.slice(start, node.getEnd())
      for (const m of raw.matchAll(SPELLED)) named(node, start + m.index, fileAt(src, m[0]), spelledAsImport(start + m.index))
      if (TEXT_IMPORT_SPELLED.test(raw)) childText = true
      const whole = stringText(node)
      if (whole !== undefined) aFolder(whole)
      if (whole !== undefined && inAFolder(whole)) named(node, start, fileIn(src, 'src', whole))
      if ((ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && ts.isTemplateSpan(node.parent)) {
        const tail = TAIL.exec(node.text)?.[0]
        const held = tail === undefined ? undefined : folderOf(src, node.parent.expression)
        if (tail !== undefined) named(node, start, (held !== undefined ? fileUnder(src, held, tail) : undefined) ?? fileUnder(src, 'src', tail, 2), spelledAsImport(start + 1 + tail.length - tail.replace(/^[\\/]+/, '').length))
      }
      return
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const right = stringText(unwrap(node.right))
      const held = right !== undefined && src.names.has(baseName(right)) ? folderOf(src, node.left) : undefined
      if (right !== undefined && held !== undefined) named(node.right, node.right.getStart(sf), fileIn(src, held, right))
      return
    }
    const call = ts.isCallExpression(node) || ts.isNewExpression(node) ? node : undefined
    const list = call ? call.arguments : ts.isArrayLiteralExpression(node) ? node.elements : undefined
    if (!list) return
    for (let i = 0; i < list.length; i++) {
      let end = i
      while (end < list.length && stringText(unwrap(list[end]!)) !== undefined) end++
      if (end === i) continue
      const texts = list.slice(i, end).map(e => stringText(unwrap(e))!)
      const joined = texts.join('/')
      const first = unwrap(list[i]!)
      const at = first.getStart(sf)
      const before = i > 0 ? list[i - 1] : call?.expression
      if (texts.length > 1) {
        const starts = texts.map((_, k) => texts.slice(0, k).join('/').length + (k > 0 ? 1 : 0))
        for (const m of joined.matchAll(SPELLED)) {
          const inOne = starts.some((s, k) => m.index >= s && m.index + m[0].length <= s + texts[k]!.length)
          if (!inOne) named(first, at, fileAt(src, m[0]), IMPORT_SPELLED.test(joined.slice(0, m.index)))
        }
        named(first, at, fileIn(src, 'src', joined))
        aFolder(joined)
      }
      const held = before !== undefined && src.names.has(baseName(joined)) ? folderOf(src, before) : undefined
      if (held !== undefined) named(first, at, fileIn(src, held, joined))
      i = end
    }
  })
  return { names, folder, childText }
}

function textReads(text: string, src: Src): Hit[] {
  const out: Hit[] = []
  text.split('\n').forEach((line, i) => {
    if (line.trimStart().startsWith('#')) return
    const seen = new Set<string>()
    for (const view of new Set([line, line.replace(QUOTED_SEGMENTS, '/')])) {
      for (const m of [...view.matchAll(SPELLED), ...view.matchAll(UNDER)]) {
        const file = m[0].toLowerCase().startsWith('src') ? fileAt(src, m[0]) : fileUnder(src, 'src', m[0], 2)
        if (file === undefined || seen.has(file) || IMPORT_SPELLED.test(view.slice(0, m.index))) continue
        seen.add(file)
        out.push({ line: i + 1, file })
      }
    }
  })
  return out
}

const union = (...sets: string[][]): string[] => {
  const out = new Set<string>()
  for (const set of sets) for (const value of set) if (out.size < 4000) out.add(value)
  return [...out]
}

const cross = (a: string[], b: string[], between: string): string[] => {
  const out = new Set<string>()
  for (const x of a.slice(0, 64)) for (const y of b) if (out.size < 4000) out.add(`${x}${between}${y}`)
  return [...out]
}

function normal(path: string): string[] {
  const out: string[] = []
  path.split(/[\\/]+/).forEach((seg, i) => {
    if (seg === '.' || (seg === '' && i > 0)) return
    if (seg !== '..') {
      out.push(seg)
      return
    }
    const top = out[out.length - 1]
    if (top === undefined || top === '..') out.push('..')
    else if (top !== UNKNOWN && top !== '') out.pop()
  })
  return out
}

function fileNamed(cx: Cx, path: string): string | undefined {
  const segs = normal(path)
  for (let i = segs.length - 2; i >= 0; i--) {
    if (segs[i]!.toLowerCase() !== 'src') continue
    const before = segs[i - 1]
    if (before !== undefined && before !== UNKNOWN && before !== '..' && before !== '') continue
    const file = cx.src.files.get(segs.slice(i).join('/').toLowerCase())
    if (file !== undefined) return file
    const hole = segs.findIndex((s, k) => k > i && s.includes(UNKNOWN))
    if (hole > i + 1 && cx.src.folders.has(segs.slice(i, hole).join('/').toLowerCase())) cx.fragment = true
  }
  const rest = segs[0] === UNKNOWN ? segs.slice(1) : []
  return rest.length >= 2 && !rest.some(s => s.toLowerCase() === 'src') ? cx.src.files.get(`src/${rest.join('/')}`.toLowerCase()) : undefined
}

const filesOf = (cx: Cx, paths: string[]): string[] => [...new Set(paths.flatMap(p => fileNamed(cx, p) ?? []))]

function moduleFile(cx: Cx, from: string, spec: string): string | undefined {
  const key = (spec.startsWith('.') ? slash(relative(cx.root, resolve(dirname(from), spec))) : spec).toLowerCase()
  return cx.src.files.get(key) ?? cx.src.files.get(key.replace(/\.[cm]?js$/, '.ts')) ?? cx.src.files.get(key.replace(/\.[cm]?jsx?$/, '.tsx'))
}

function scriptImport(cx: Cx, decl: ts.Node): ts.Node | undefined {
  const ref = importOf(decl)
  const target = ref ? importTarget(decl.getSourceFile().fileName, ref.module) : null
  return target !== null && slash(relative(cx.root, target)).startsWith('scripts/') ? importedDeclaration(cx.modules, decl) : undefined
}

function fnOfCall(cx: Cx, call: ts.CallExpression): ts.FunctionLikeDeclaration | undefined {
  const known = KNOWN.fns.get(call)
  if (known !== undefined) return known ?? undefined
  const callee = unwrap(call.expression)
  const decl = ts.isIdentifier(callee) ? declOf(callee) : undefined
  const fn = decl ? (functionOf(decl) ?? (ts.isImportSpecifier(decl) || ts.isImportClause(decl) || ts.isBindingElement(decl) ? functionOf(scriptImport(cx, decl)) : undefined)) : undefined
  KNOWN.fns.set(call, fn ?? null)
  return fn
}

function eachReceiver(param: ts.ParameterDeclaration): ts.Expression | undefined {
  const fn = param.parent
  const call = fn.parent
  if (!ts.isCallExpression(call) || !call.arguments.includes(fn as ts.Expression)) return undefined
  const callee = unwrap(call.expression)
  if (!ts.isPropertyAccessExpression(callee) || !EACH.has(callee.name.text)) return undefined
  return fn.parameters.indexOf(param) === (callee.name.text === 'reduce' ? 1 : 0) ? callee.expression : undefined
}

function filled(cx: Cx, decl: ts.VariableDeclaration, name: string): ts.Expression[] {
  const known = cx.fills.get(decl)
  if (known) return known
  const out: ts.Expression[] = []
  cx.fills.set(decl, out)
  const init = decl.initializer ? unwrap(decl.initializer) : undefined
  if (!init || !(ts.isArrayLiteralExpression(init) || ts.isNewExpression(init))) return out
  for (const ref of referencesOf(decl.getSourceFile(), decl, name)) {
    const access = ref.parent
    if (ts.isPropertyAccessExpression(access) && access.expression === ref && FILLERS.has(access.name.text) && ts.isCallExpression(access.parent) && access.parent.expression === access) out.push(...access.parent.arguments)
  }
  return out
}

const loopOf = (decl: ts.VariableDeclaration): ts.Expression | undefined => {
  const loop = decl.parent.parent
  return (ts.isForOfStatement(loop) || ts.isForInStatement(loop)) && loop.initializer === decl.parent ? loop.expression : undefined
}

function bind(cx: Cx, fn: ts.FunctionLikeDeclaration, args: readonly ts.Expression[], env: Env, d: number): Env {
  const inner: Env = new Map(env)
  fn.parameters.forEach((p, i) => {
    const given = p.dotDotDotToken ? args.slice(i) : args[i] ? [args[i]!] : []
    if (given.length === 0) inner.set(p, { paths: p.initializer ? ev(cx, p.initializer, inner, d + 1) : [UNKNOWN], text: [] })
    else inner.set(p, { paths: given.map(a => ev(cx, a, env, d + 1)).reduce((a, b) => cross(a, b, '/')), text: union(...given.map(a => textOf(cx, a, env, d + 1))) })
  })
  return inner
}

function evDecl(cx: Cx, decl: ts.Node, name: string, env: Env, d: number): string[] {
  const bound = env.get(decl)
  if (bound) return bound.paths
  if (ts.isBindingElement(decl)) {
    const root = rootDeclarationOf(decl)
    return root ? evDecl(cx, root, name, env, d + 1) : [UNKNOWN]
  }
  if (ts.isVariableDeclaration(decl)) {
    const loop = loopOf(decl)
    if (loop) return ev(cx, loop, env, d + 1)
    if (!decl.initializer) return [UNKNOWN]
    const known = KNOWN.paths.get(decl)
    if (known) return known
    const held = union(ev(cx, decl.initializer, env, d + 1), ...filled(cx, decl, name).map(a => ev(cx, a, env, d + 1)))
    const values = NAMES_SRC.test(name) && !held.some(v => /(?:^|[\\/])src(?:[\\/]|$)/i.test(v)) ? union(held, [`${UNKNOWN}/src`]) : held
    if (ofTheModule(decl) && d < DEEP / 2) KNOWN.paths.set(decl, values)
    return values
  }
  if (ts.isParameter(decl)) {
    const each = eachReceiver(decl)
    return each ? ev(cx, each, env, d + 1) : decl.initializer ? ev(cx, decl.initializer, env, d + 1) : [UNKNOWN]
  }
  if (ts.isImportSpecifier(decl) || ts.isImportClause(decl)) {
    const target = scriptImport(cx, decl)
    if (target && ts.isVariableDeclaration(target) && target.initializer) return ev(cx, target.initializer, new Map(), d + 1)
  }
  return [NAMES_SRC.test(name) ? `${UNKNOWN}/src` : UNKNOWN]
}

function ev(cx: Cx, e: ts.Node | undefined, env: Env, d = 0): string[] {
  if (!e || d > DEEP || cx.steps++ > STEPS) return [UNKNOWN]
  const seen = KNOWN.pathsIn.get(env) ?? new Map<ts.Node, string[]>()
  KNOWN.pathsIn.set(env, seen)
  const known = seen.get(e)
  if (known) return known
  seen.set(e, [UNKNOWN])
  const values = evNow(cx, e, env, d)
  seen.set(e, values)
  return values
}

function evNow(cx: Cx, e: ts.Node, env: Env, d: number): string[] {
  if (ts.isSpreadElement(e)) return ev(cx, e.expression, env, d + 1)
  const x = unwrapAwait(e as ts.Expression)
  const literal = stringText(x)
  if (literal !== undefined) return [literal]
  if (ts.isTemplateExpression(x)) return x.templateSpans.reduce((sofar, span) => cross(cross(sofar, ev(cx, span.expression, env, d + 1), ''), [span.literal.text], ''), [x.head.text])
  if (ts.isBinaryExpression(x)) {
    const op = x.operatorToken.kind
    if (op === ts.SyntaxKind.PlusToken) return cross(ev(cx, x.left, env, d + 1), ev(cx, x.right, env, d + 1), '')
    return op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken ? union(ev(cx, x.left, env, d + 1), ev(cx, x.right, env, d + 1)) : [UNKNOWN]
  }
  if (ts.isConditionalExpression(x)) return union(ev(cx, x.whenTrue, env, d + 1), ev(cx, x.whenFalse, env, d + 1))
  if (ts.isIdentifier(x)) {
    const decl = declOf(x)
    return decl ? evDecl(cx, decl, x.text, env, d) : [NAMES_SRC.test(x.text) ? `${UNKNOWN}/src` : UNKNOWN]
  }
  if (ts.isPropertyAccessExpression(x) || ts.isElementAccessExpression(x)) return ts.isMetaProperty(x.expression) ? [UNKNOWN] : ev(cx, x.expression, env, d + 1)
  if (ts.isArrayLiteralExpression(x)) return union(...x.elements.map(el => ev(cx, el, env, d + 1)))
  if (ts.isObjectLiteralExpression(x)) {
    return union(
      ...x.properties.map(p => {
        if (ts.isShorthandPropertyAssignment(p)) return ev(cx, p.name, env, d + 1)
        if (ts.isSpreadAssignment(p)) return ev(cx, p.expression, env, d + 1)
        if (!ts.isPropertyAssignment(p)) return []
        const key = ts.isComputedPropertyName(p.name) ? ev(cx, p.name.expression, env, d + 1) : ts.isStringLiteralLike(p.name) ? [p.name.text] : []
        return union(key, ev(cx, p.initializer, env, d + 1))
      }),
    )
  }
  const args = ts.isCallExpression(x) || ts.isNewExpression(x) ? (x.arguments ?? []) : undefined
  if (!args) return [UNKNOWN]
  const name = nameOf(x as ts.CallExpression)
  if (ts.isNewExpression(x)) {
    if (name === 'URL' && args[0]) return args[1] ? cross(ev(cx, args[1], env, d + 1).map(base => `${base}/..`), ev(cx, args[0], env, d + 1), '/') : ev(cx, args[0], env, d + 1)
    return name === 'Set' || name === 'Map' || name === 'Array' ? (args[0] ? ev(cx, args[0], env, d + 1) : []) : [UNKNOWN]
  }
  const call = x as ts.CallExpression
  const callee = unwrap(call.expression)
  const recv = ts.isPropertyAccessExpression(callee) ? callee.expression : undefined
  if (name !== undefined) {
    const from = recv ? unwrap(recv) : undefined
    const ofPath = !from || PATH_MODULE.test(ts.isIdentifier(from) ? from.text : ts.isPropertyAccessExpression(from) ? from.name.text : ts.isCallExpression(from) ? (stringText(unwrap(from.arguments[0] ?? from)) ?? '').replace(/^node:/, '') : '')
    if (JOINERS.has(name) && ofPath && args.length > 0) return args.map(a => ev(cx, a, env, d + 1)).reduce((a, b) => cross(a, b, '/'))
    if (name === 'dirname' && args[0]) return ev(cx, args[0], env, d + 1).map(p => `${p}/..`)
    if (FIRST_ARG.has(name) && args[0] && (ofPath || !KEEPS.has(name))) return ev(cx, args[0], env, d + 1)
    if (OF_OBJECT.has(name)) return args[0] ? ev(cx, args[0], env, d + 1) : recv ? ev(cx, recv, env, d + 1) : [UNKNOWN]
    const handed = recv && args[0] ? unwrap(args[0]) : undefined
    if (recv && (name === 'map' || name === 'flatMap')) return handed && isFunctionNode(handed) ? union(...returnedExpressions(handed).map(r => ev(cx, r, env, d + 1))) : ev(cx, recv, env, d + 1)
    if (recv && name === 'filter' && handed && isFunctionNode(handed)) return union(ev(cx, recv, env, d + 1), ...memberships(handed).map(held => ev(cx, held, env, d + 1)))
    if (recv && KEEPS.has(name)) return name === 'concat' ? union(ev(cx, recv, env, d + 1), ...args.map(a => ev(cx, a, env, d + 1))) : ev(cx, recv, env, d + 1)
  }
  const fn = d < DEEP / 2 ? fnOfCall(cx, call) : undefined
  if (!fn || cx.valuing.has(fn) || cx.valuing.size >= 6) return [UNKNOWN]
  const inner = bind(cx, fn, args, env, d)
  cx.valuing.add(fn)
  const returned = union(...returnedExpressions(fn).map(r => ev(cx, r, inner, d + 2)))
  cx.valuing.delete(fn)
  return returned
}

function sourceOf(cx: Cx, e: ts.Expression): string[] {
  let at = unwrap(e)
  while (ts.isPropertyAccessExpression(at) || ts.isElementAccessExpression(at)) at = unwrap(at.expression)
  if (!ts.isIdentifier(at)) return []
  const named = declOf(at)
  const decl = named && ts.isBindingElement(named) ? (rootDeclarationOf(named) ?? named) : named
  if (!decl) return []
  let spec: string | undefined
  if (ts.isImportSpecifier(decl) || ts.isImportClause(decl) || ts.isNamespaceImport(decl)) {
    let up: ts.Node = decl
    while (!ts.isImportDeclaration(up)) up = up.parent
    spec = stringText(up.moduleSpecifier)
  } else if (ts.isVariableDeclaration(decl) && decl.initializer && isDynamicImport(decl.initializer)) {
    const first = (unwrapAwait(decl.initializer) as ts.CallExpression).arguments[0]
    spec = first ? stringText(unwrap(first)) : undefined
  }
  const file = spec === undefined ? undefined : moduleFile(cx, at.getSourceFile().fileName, spec)
  return file ? [file] : []
}

function openedBy(cx: Cx, call: ts.CallExpression, env: Env): string[] {
  const first = call.arguments[0]
  if (!first) return []
  const callee = unwrap(call.expression)
  const name = nameOf(call)
  const ofBun = ts.isPropertyAccessExpression(callee) && callee.name.text === 'file' && ts.isIdentifier(unwrap(callee.expression)) && (unwrap(callee.expression) as ts.Identifier).text === 'Bun'
  if (ofBun || (name !== undefined && READERS.has(name))) return filesOf(cx, ev(cx, first, env))
  if (callee.kind === ts.SyntaxKind.ImportKeyword) {
    const options = call.arguments[1]
    const spec = options && (!ts.isObjectLiteralExpression(options) || AS_TEXT.test(options.getText())) ? stringText(unwrap(first)) : undefined
    const file = spec === undefined ? undefined : moduleFile(cx, call.getSourceFile().fileName, spec)
    return file ? [file] : []
  }
  if (name === undefined || !RUNNERS.has(name)) return []
  const said = call.arguments.flatMap(a => ev(cx, a, env))
  return said.some(s => READ_TOOL.test(s)) ? [...new Set(said.flatMap(s => [...s.matchAll(SPELLED)].flatMap(m => fileAt(cx.src, m[0]) ?? [])))] : []
}

function textDecl(cx: Cx, decl: ts.Node, name: string, env: Env, d: number): string[] {
  const bound = env.get(decl)
  if (bound) return bound.text
  if (ts.isBindingElement(decl)) {
    const root = rootDeclarationOf(decl)
    return root ? textDecl(cx, root, name, env, d + 1) : []
  }
  if (ts.isVariableDeclaration(decl)) {
    const loop = loopOf(decl)
    if (loop) return textOf(cx, loop, env, d + 1)
    if (!decl.initializer) return []
    const known = KNOWN.text.get(decl)
    if (known) return known
    const files = union(textOf(cx, decl.initializer, env, d + 1), ...filled(cx, decl, name).map(a => textOf(cx, a, env, d + 1)))
    if (ofTheModule(decl) && d < DEEP / 2) KNOWN.text.set(decl, files)
    return files
  }
  if (ts.isParameter(decl)) {
    const each = eachReceiver(decl)
    return each ? textOf(cx, each, env, d + 1) : []
  }
  if (ts.isImportClause(decl) && decl.parent.attributes && AS_TEXT.test(decl.parent.attributes.getText())) {
    const spec = stringText(decl.parent.moduleSpecifier)
    const file = spec === undefined ? undefined : moduleFile(cx, decl.getSourceFile().fileName, spec)
    return file ? [file] : []
  }
  return []
}

function textOf(cx: Cx, e: ts.Node | undefined, env: Env, d = 0): string[] {
  if (!e || d > DEEP || cx.steps++ > STEPS) return []
  const seen = KNOWN.textIn.get(env) ?? new Map<ts.Node, string[]>()
  KNOWN.textIn.set(env, seen)
  const known = seen.get(e)
  if (known) return known
  seen.set(e, [])
  const files = textNow(cx, e, env, d)
  seen.set(e, files)
  return files
}

function textNow(cx: Cx, e: ts.Node, env: Env, d: number): string[] {
  if (ts.isSpreadElement(e)) return textOf(cx, e.expression, env, d + 1)
  const x = unwrapAwait(e as ts.Expression)
  if (ts.isIdentifier(x)) {
    const decl = declOf(x)
    return decl ? textDecl(cx, decl, x.text, env, d) : []
  }
  if (ts.isTemplateExpression(x)) return union(...x.templateSpans.map(span => textOf(cx, span.expression, env, d + 1)))
  if (ts.isBinaryExpression(x)) {
    const op = x.operatorToken.kind
    return op === ts.SyntaxKind.PlusToken || op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken ? union(textOf(cx, x.left, env, d + 1), textOf(cx, x.right, env, d + 1)) : []
  }
  if (ts.isConditionalExpression(x)) return union(textOf(cx, x.whenTrue, env, d + 1), textOf(cx, x.whenFalse, env, d + 1))
  if (ts.isPropertyAccessExpression(x) || ts.isElementAccessExpression(x)) return textOf(cx, x.expression, env, d + 1)
  if (ts.isArrayLiteralExpression(x)) return union(...x.elements.map(el => textOf(cx, el, env, d + 1)))
  if (ts.isObjectLiteralExpression(x)) return union(...x.properties.map(p => (ts.isPropertyAssignment(p) ? textOf(cx, p.initializer, env, d + 1) : ts.isShorthandPropertyAssignment(p) ? textOf(cx, p.name, env, d + 1) : ts.isSpreadAssignment(p) ? textOf(cx, p.expression, env, d + 1) : [])))
  if (!ts.isCallExpression(x)) return []
  const opened = openedBy(cx, x, env)
  if (opened.length > 0) return opened
  const callee = unwrap(x.expression)
  const name = nameOf(x)
  const args = x.arguments
  const recv = ts.isPropertyAccessExpression(callee) ? callee.expression : undefined
  if (name === 'String' && args[0] && !recv) return union(sourceOf(cx, args[0]), textOf(cx, args[0], env, d + 1))
  if (name === 'toString' && recv) return union(sourceOf(cx, recv), textOf(cx, recv, env, d + 1))
  if (name !== undefined && recv && (name === 'map' || name === 'flatMap')) {
    const handed = args[0] ? unwrap(args[0]) : undefined
    return union(textOf(cx, recv, env, d + 1), ...(handed && isFunctionNode(handed) ? returnedExpressions(handed).map(r => textOf(cx, r, env, d + 1)) : []))
  }
  if (name !== undefined && recv && KEEPS.has(name)) return union(textOf(cx, recv, env, d + 1), ...(name === 'concat' ? args.map(a => textOf(cx, a, env, d + 1)) : []))
  if (name !== undefined && (FIRST_ARG.has(name) || OF_OBJECT.has(name))) return args[0] ? textOf(cx, args[0], env, d + 1) : recv ? textOf(cx, recv, env, d + 1) : []
  const fn = d < DEEP / 2 ? fnOfCall(cx, x) : undefined
  if (!fn || cx.valuing.has(fn) || cx.valuing.size >= 6) return []
  const inner = bind(cx, fn, args, env, d)
  cx.valuing.add(fn)
  const returned = union(...returnedExpressions(fn).map(r => textOf(cx, r, inner, d + 2)))
  cx.valuing.delete(fn)
  return returned
}

function pin(cx: Cx, file: string, line: number): void {
  if (!cx.pins.has(file)) cx.pins.set(file, line)
  cx.events.add(`${line} ${file}`)
  cx.log.push({ file, search: false })
}

function searched(cx: Cx, file: string, line: number): void {
  cx.searches.push({ line, file })
  cx.log.push({ file, search: true })
}

function inert(cx: Cx, fn: ts.FunctionLikeDeclaration, within = new Set<ts.Node>(), doubt = { assumed: false }): boolean {
  const known = KNOWN.inert.get(fn)
  if (known !== undefined) return known
  if (within.has(fn)) {
    doubt.assumed = true
    return true
  }
  const first = within.size === 0
  within.add(fn)
  let live = false
  if (fn.body) {
    visit(fn.body, n => {
      if (live || !ts.isCallExpression(n)) return
      const name = calleeName(n)
      const callee = unwrap(n.expression)
      const handed = name !== undefined && EACH.has(name) && n.arguments[0] ? unwrap(n.arguments[0]) : undefined
      const called = fnOfCall(cx, n) ?? (handed && ts.isIdentifier(handed) ? functionOf(declOf(handed)) : undefined)
      if ((callee.kind === ts.SyntaxKind.ImportKeyword && n.arguments.length > 1) || (name !== undefined && (READERS.has(name) || RUNNERS.has(name) || SEARCHES.has(name) || PATTERN_SEARCHES.has(name) || name === 'file')) || (called !== undefined && !inert(cx, called, within, doubt))) live = true
    })
  }
  if (live || first || !doubt.assumed) KNOWN.inert.set(fn, !live)
  return !live
}

function walk(cx: Cx, node: ts.Node, env: Env, at: number | undefined, depth: number): void {
  const enter = (fn: ts.FunctionLikeDeclaration, inner: () => Env, line: number): void => {
    if (!fn.body || depth >= 5 || cx.stack.has(fn) || cx.steps > STEPS || inert(cx, fn)) return
    cx.entered.add(fn)
    const bound = inner()
    const key = JSON.stringify([...bound.values()].map(v => [v.paths.filter(p => p.split(/[\\/]+/).some(part => cx.src.parts.has(part.toLowerCase()))), v.text]))
    const done = cx.walked.get(fn) ?? new Map<string, Array<{ file: string; search: boolean }>>()
    cx.walked.set(fn, done)
    const again = done.get(key)
    if (again) {
      for (const e of again) (e.search ? searched : pin)(cx, e.file, line)
      return
    }
    const mark = cx.log.length
    cx.stack.add(fn)
    walk(cx, fn.body, bound, line, depth + 1)
    cx.stack.delete(fn)
    done.set(key, cx.log.slice(mark))
  }
  const step = (n: ts.Node): void => {
    if (depth > 0 && cx.steps++ > STEPS) return
    if (isFunctionNode(n) && namedFunctionDecl(n) !== undefined) {
      if (n.getSourceFile() === cx.sf) cx.helpers.add(n)
      return
    }
    if (ts.isCallExpression(n)) {
      const line = at ?? cx.sf.getLineAndCharacterOfPosition(n.getStart(cx.sf)).line + 1
      for (const file of openedBy(cx, n, env)) pin(cx, file, line)
      const callee = unwrap(n.expression)
      if (ts.isPropertyAccessExpression(callee)) {
        const method = callee.name.text
        const read = SEARCHES.has(method) ? textOf(cx, callee.expression, env) : PATTERN_SEARCHES.has(method) && n.arguments[0] ? textOf(cx, n.arguments[0], env) : []
        if (read.length > 0) searched(cx, read[0]!, line)
        for (const file of read) pin(cx, file, line)
        const handed = EACH.has(method) && n.arguments[0] ? unwrap(n.arguments[0]) : undefined
        const each = handed && ts.isIdentifier(handed) ? functionOf(declOf(handed)) : undefined
        const first = each?.parameters[0]
        if (each && first) enter(each, () => new Map(env).set(first, { paths: ev(cx, callee.expression, env), text: textOf(cx, callee.expression, env) }), line)
      }
      const fn = fnOfCall(cx, n)
      if (fn) enter(fn, () => bind(cx, fn, n.arguments, env, 0), line)
    }
    ts.forEachChild(n, step)
  }
  step(node)
}

function codeFacts(root: string, src: Src, modules: ModuleCache, script: string): Facts {
  const { sf } = parseSource(root, join(root, script))
  const { names, folder, childText } = codeNames(sf, src)
  const cx: Cx = { root, src, modules, sf, pins: new Map(), events: new Set(), searches: [], helpers: new Set(), entered: new Set(), stack: new Set(), valuing: new Set(), fills: new Map(), walked: new Map(), log: [], steps: 0, fragment: false }
  for (const n of names) if (n.asText) pin(cx, n.file, n.line)
  walk(cx, sf, new Map(), undefined, 0)
  for (const fn of cx.helpers) {
    if (cx.entered.has(fn) || !fn.body || inert(cx, fn)) continue
    cx.entered.add(fn)
    walk(cx, fn.body, new Map(), undefined, 1)
  }
  const namesOnly = new Map<string, number>()
  for (const n of names) if (!cx.pins.has(n.file) && !namesOnly.has(n.file)) namesOnly.set(n.file, n.line)
  return { pins: cx.pins, events: [...cx.events], searches: cx.searches, namesOnly, folder, fragment: cx.fragment, childText, shell: false, spent: cx.steps > STEPS }
}

function shellFacts(text: string, src: Src): Facts {
  const hits = textReads(text, src)
  const pins = new Map<string, number>()
  for (const h of hits) if (!pins.has(h.file)) pins.set(h.file, h.line)
  return { pins, events: hits.map(h => `${h.line} ${h.file}`), searches: hits, namesOnly: new Map(), folder: false, fragment: false, childText: false, shell: true, spent: false }
}

function factsOf(root: string, estate: Estate): { facts: Map<string, Facts>; read: number; aside: number } {
  const facts = new Map<string, Facts>()
  const modules = new ModuleCache(root)
  let read = 0
  let aside = 0
  for (const script of estate.scripts) {
    let text: string
    try {
      text = readFileSync(join(root, script), 'utf8')
    } catch {
      continue
    }
    if (text.includes('\0')) continue
    if (CODE.test(script)) facts.set(script, codeFacts(root, estate.src, modules, script))
    else if (SHELL.test(script)) facts.set(script, shellFacts(text, estate.src))
    else {
      if (textReads(text, estate.src).length > 0) aside++
      continue
    }
    read++
  }
  return { facts, read, aside }
}

const digestOf = (files: Iterable<string>): string =>
  createHash('sha256')
    .update([...files].sort().join('\n'))
    .digest('hex')
    .slice(0, 12)

const rowOf = (f: Facts): Row => ({ pins: f.pins.size, searches: f.searches.length, digest: digestOf(f.pins.keys()) })

function rowsOf(facts: Map<string, Facts>): Table {
  const rows: Table = new Map()
  for (const [script, f] of facts) if (f.pins.size > 0) rows.set(script, rowOf(f))
  return rows
}

const render = (rows: Table): string =>
  [...rows]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([script, row]) => `${script}\t${row.pins}\t${row.searches}\t${row.digest}\n`)
    .join('')

function tableOf(text: string): Table | null {
  const table: Table = new Map()
  for (const line of text.split('\n')) {
    if (line === '') continue
    const m = /^(scripts\/[^\t]+)\t([1-9][0-9]*)\t([0-9]+)\t([0-9a-f]{12})$/.exec(line)
    if (!m || table.has(m[1]!)) return null
    table.set(m[1]!, { pins: Number(m[2]), searches: Number(m[3]), digest: m[4]! })
  }
  return table
}

function olderTableOf(text: string): Table {
  const table: Table = new Map()
  for (const line of text.split('\n')) {
    const m = /^(scripts\/[^\t]+)\t([0-9]+)(?:\t([0-9]+)\t([0-9a-f]{12}))?$/.exec(line)
    if (m) table.set(m[1]!, { pins: Number(m[2]), searches: m[3] === undefined ? -1 : Number(m[3]), digest: m[4] ?? '' })
  }
  return table
}

const pinLines = (f: Facts): Hit[] => [...f.pins].map(([file, line]) => ({ file, line }))

function judge(facts: Map<string, Facts>, table: Table): Verdict {
  const over: Over[] = []
  let pins = 0
  let searches = 0
  for (const [script, f] of facts) {
    if (f.pins.size === 0) continue
    const now = rowOf(f)
    pins += now.pins
    searches += now.searches
    const row = table.get(script)
    if (!row) over.push({ script, why: 'has no row', lines: pinLines(f) })
    else if (now.pins > row.pins) over.push({ script, why: `its row allows ${row.pins} file${row.pins === 1 ? '' : 's'}`, lines: pinLines(f) })
    else if (now.searches > row.searches) over.push({ script, why: `its row allows ${row.searches} search${row.searches === 1 ? '' : 'es'}`, lines: f.searches })
    else if (now.pins === row.pins && now.digest !== row.digest) over.push({ script, why: 'its row holds the same number of other files, so one was swapped for another', lines: pinLines(f) })
  }
  let allowed = 0
  let slack = 0
  for (const [script, row] of table) {
    allowed += row.pins
    const f = facts.get(script)
    if (!f || f.pins.size < row.pins || f.searches.length < row.searches) slack++
  }
  return { over, pins, searches, allowed, slack }
}

function refused(facts: Map<string, Facts>, table: Table, movedFrom: Map<string, string>): Over[] {
  const out: Over[] = []
  for (const [script, f] of facts) {
    if (f.pins.size === 0) continue
    const now = rowOf(f)
    const from = table.has(script) ? script : movedFrom.get(script)
    const row = from === undefined ? undefined : table.get(from)
    if (!row) out.push({ script, why: 'is new: a row is added only when it moves with its file, by git mv and then --write', lines: pinLines(f) })
    else if (now.pins > row.pins) out.push({ script, why: `opens more files than the ${row.pins} of ${from === script ? 'its row' : `the row of ${from}`}`, lines: pinLines(f) })
    else if (now.searches > row.searches) out.push({ script, why: `searches more often than the ${row.searches} of ${from === script ? 'its row' : `the row of ${from}`}`, lines: f.searches })
  }
  return out
}

function movedIn(root: string): Map<string, string> {
  const moved = new Map<string, string>()
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] })
  try {
    const since = git('log', '-1', '--format=%H', '--', TABLE).trim() || 'HEAD'
    for (const line of git('diff', '--cached', '-M', '--name-status', since, '--', 'scripts').split('\n')) {
      const [status, from, to] = line.split('\t')
      if (status?.startsWith('R') && from && to) moved.set(to, from)
    }
  } catch {
    return moved
  }
  return moved
}

function risen(base: Table, tip: Table, movedFrom: Map<string, string>): { lines: string[]; higher: number } {
  const lines: string[] = []
  let higher = 0
  for (const [script, row] of [...tip].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const from = base.has(script) ? script : movedFrom.get(script)
    const was = from === undefined ? undefined : base.get(from)
    const moved = from !== undefined && from !== script ? ` (moved from ${from})` : ''
    const after = `${row.pins} files, ${row.searches} searches`
    if (!was) lines.push(`NEW   ${after}\t${script}`)
    else if (row.pins > was.pins || (was.searches >= 0 && row.searches > was.searches)) lines.push(`ROSE  ${was.pins} files${was.searches >= 0 ? `, ${was.searches} searches` : ''} -> ${after}\t${script}${moved}`)
    else if (was.digest !== '' && row.pins === was.pins && row.digest !== was.digest) lines.push(`SWAP  ${row.pins} files, other files than before\t${script}${moved}`)
    if (!was || row.pins > was.pins || (was.searches >= 0 && row.searches > was.searches)) higher++
  }
  return { lines, higher }
}

const told = (over: Over[], facts: Map<string, Facts>): string =>
  over
    .slice(0, 25)
    .map(o => {
      const f = facts.get(o.script)
      const head = `\n      ${o.script} opens ${f?.pins.size ?? 0} src file${f?.pins.size === 1 ? '' : 's'} as text and searches ${f?.searches.length ?? 0} time${f?.searches.length === 1 ? '' : 's'} in what it read: ${o.why}:`
      return head + o.lines.slice(0, 80).map(h => `\n        ${o.script}:${h.line} ${h.file}`).join('') + (o.lines.length > 80 ? `\n        … and ${o.lines.length - 80} more lines` : '')
    })
    .join('') + (over.length > 25 ? `\n      … and ${over.length - 25} more scripts` : '')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))

function plantedEstate(): void {
  const ONE = 'src/planted/one.ts'
  const TWO = 'src/planted/two.tsx'
  const THREE = 'src/planted/deep/three.ts'
  const JSON_ROWS = 'src/planted/rows.json'
  const LONE = 'src/lone.ts'
  const planted: Array<{ file: string; lines: string[]; events: Array<[number, string]>; searches: number; namesOnly: string[] }> = [
    {
      file: 'scripts/lib/door.ts',
      lines: ["import { readFileSync } from 'node:fs'", "import { join, resolve } from 'node:path'", "const ROOT = resolve(import.meta.dir, '..', '..')", "export const text = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')", 'export function loneText(): string {', "  return readFileSync(join(ROOT, 'src/lone.ts'), 'utf8')", '}'],
      events: [[6, LONE]],
      searches: 0,
      namesOnly: [],
    },
    {
      file: 'scripts/a/prove-pins.ts',
      lines: [
        "import { execFileSync, execSync } from 'node:child_process'",
        "import { readFileSync } from 'node:fs'",
        "import { join } from 'node:path'",
        "import { loneText, text } from '../lib/door.ts'",
        "import raw from '../../src/planted/rows.json' with { type: 'text' }",
        "const ROOT = join(import.meta.dir, '..', '..')",
        "const whole = readFileSync(join(ROOT, 'src/planted/one.ts'), 'utf8')",
        "const segments = readFileSync(join(ROOT, 'src', 'planted', 'two.tsx'), 'utf8')",
        "const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')",
        "const deep = (name: string): string => readFileSync(join(ROOT, 'src', 'planted', 'deep', name), 'utf8')",
        "const three = deep('three.ts')",
        "const dotted = read('src/planted/../lone.ts')",
        "const listed = ['src/planted/one.ts', 'src/planted/two.tsx'].map(rel => read(rel))",
        "const table = { one: 'src/planted/one.ts' }",
        'for (const rel of Object.values(table)) console.log(read(rel).length)',
        "const through = text('src/planted/deep/three.ts')",
        'const door = loneText()',
        "const shown = execFileSync('git', ['show', 'HEAD:src/planted/two.tsx'], { encoding: 'utf8' })",
        "const command = execSync('grep -c export src/planted/two.tsx src/lone.ts')",
        "const late = await import('../../src/planted/one.ts')",
        'const body = String(late.one)',
        'const has = (hay: string, needle: string): boolean => hay.includes(needle)',
        "console.log(whole.includes('a') && /b/.test(segments), three.split('\\n').length, has(dotted, 'c'), has(door, 'd'), body.indexOf('e'), listed.join('').match(/f/), through.startsWith('g'), raw.endsWith('h'))",
        'console.log(shown, command)',
      ],
      events: [[5, JSON_ROWS], [7, ONE], [8, TWO], [11, THREE], [12, LONE], [13, ONE], [13, TWO], [15, ONE], [16, THREE], [17, LONE], [18, TWO], [19, LONE], [19, TWO], [23, LONE], [23, THREE], [23, ONE], [23, JSON_ROWS], [23, TWO]],
      searches: 9,
      namesOnly: [],
    },
    {
      file: 'scripts/a/prove-names.ts',
      lines: [
        "import { spawnSync } from 'node:child_process'",
        "import { existsSync, writeFileSync } from 'node:fs'",
        "import { join } from 'node:path'",
        "const ROOT = join(import.meta.dir, '..', '..')",
        "const LISTED = ['src/planted/one.ts', 'src/planted/two.tsx']",
        "const label = { 'src/planted/deep/three.ts': 'a label' }",
        String.raw`const pattern = /src\/planted\/rows\.json$/`,
        "const there = existsSync(join(ROOT, 'src/lone.ts'))",
        "writeFileSync(join(scratch, 'src', 'planted', 'one.ts'), 'export {}')",
        "const ran = spawnSync(process.execPath, [join(ROOT, 'src/planted/two.tsx')])",
        "console.log('the row type lives in src/planted/deep/three.ts.', LISTED.includes(process.argv[2] ?? ''), label, pattern, there, ran)",
      ],
      events: [],
      searches: 0,
      namesOnly: [ONE, TWO, THREE, JSON_ROWS, LONE],
    },
    {
      file: 'scripts/a/prove-imports.ts',
      lines: [
        "import { one } from '../../src/planted/one.ts'",
        "import '../../src/lone.ts'",
        "import type { Two } from '../../src/planted/two.tsx'",
        "import rows from '../../src/planted/rows.json' with { type: 'json' }",
        "export { three } from '../../src/planted/deep/three.ts'",
        "export * from '../../src/lone.ts'",
        "import legacy = require('../../src/planted/one.ts')",
        "const late = await import('../../src/planted/one.ts')",
        "const joined = await import(join(ROOT, 'src', 'planted', 'deep', 'three.ts'))",
        "const href = await import(pathToFileURL(join(SRC, 'lone.ts')).href)",
        "const old = require('../../src/planted/one.ts')",
        "type Three = import('../../src/planted/deep/three.ts').Three",
        "type Lone = typeof import('../../src/lone.ts')",
        "mock.module('../../src/planted/one.ts', () => ({ one: 2 }))",
        "const load = (rel: string): Promise<unknown> => import(join(ROOT, 'src', rel))",
        "const loaded = await load('planted/one.ts')",
        'async function stub(rel: string, over: object): Promise<void> {',
        '  const target = join(ROOT, rel)',
        '  const actual = await import(target)',
        '  mock.module(target, () => ({ ...actual, ...over }))',
        '}',
        "await stub('src/planted/two.tsx', {})",
        "const child = `import { one } from '${ROOT}/src/planted/one.ts'\\nconsole.log(one)`",
        "const inline = ['bun', '-e', \"const m = await import('./src/lone.ts'); console.log(m)\"]",
        "const quoted = `const m = await import(${JSON.stringify(join(ROOT, 'src/planted/one.ts'))})`",
        'const onTemplate = await import(`${SRC}/planted/one.ts`)',
        '// a comment may name src/planted/one.ts',
        'export const out = [one, rows, legacy, late.one.length, joined, href, old, loaded, child, inline, quoted, onTemplate]',
      ],
      events: [],
      searches: 0,
      namesOnly: [],
    },
    {
      file: 'scripts/a/prove-closed.ts',
      lines: [
        "import { readFileSync } from 'node:fs'",
        "import { join } from 'node:path'",
        "const ROOT = join(import.meta.dir, '..', '..')",
        "const load = async (rel: string): Promise<{ mod: unknown; text: string }> => ({ mod: await import(join(ROOT, rel)), text: readFileSync(join(ROOT, rel), 'utf8') })",
        "const { text } = await load('src/planted/one.ts')",
        "const picked = await import(readFileSync(join(ROOT, 'src/lone.ts'), 'utf8').includes('x') ? 'node:path' : 'node:os')",
        "const { join: j } = await import('node:path')",
        "const aliased = readFileSync(j(ROOT, 'src/planted/two.tsx'), 'utf8')",
        "console.log(text.includes('y'), picked, aliased)",
      ],
      events: [[5, ONE], [6, LONE], [8, TWO], [9, ONE]],
      searches: 2,
      namesOnly: [],
    },
    {
      file: 'scripts/a/run-all.sh',
      lines: ['#!/usr/bin/env bash', '# gate-watch: src/planted/one.ts src/lone.ts', 'set -u', 'grep -c export src/planted/one.ts', 'test -s "$ROOT/src/planted/deep/three.ts"', "bun -e \"import { one } from './src/planted/one.ts'; console.log(one)\"", 'cat "${SRC_DIR}/planted/two.tsx"', 'cd "$ROOT/src" && cat lone.ts', 'grep -c import src/planted/one.ts'],
      events: [[4, ONE], [5, THREE], [7, TWO], [9, ONE]],
      searches: 4,
      namesOnly: [],
    },
    { file: 'scripts/a/reader.py', lines: ['# src/planted/one.ts in a comment', "text = open('src/planted/two.tsx').read()", "rows = open(os.path.join(ROOT, 'src', 'planted', 'rows.json')).read()"], events: [[2, TWO], [3, JSON_ROWS]], searches: 2, namesOnly: [] },
    { file: 'scripts/a/hook', lines: ['#!/bin/sh', 'grep -q export src/lone.ts'], events: [[2, LONE]], searches: 1, namesOnly: [] },
    { file: 'scripts/a/list.txt', lines: ['# paths a reader opens', 'src/lone.ts', 'planted/deep/three.ts'], events: [], searches: 0, namesOnly: [] },
    { file: 'scripts/a/notes.md', lines: ['src/planted/one.ts is where the rows live'], events: [], searches: 0, namesOnly: [] },
    { file: 'scripts/a/packed.bin', lines: ['\0src/planted/one.ts'], events: [], searches: 0, namesOnly: [] },
    {
      file: 'scripts/a/out-of-reach.ts',
      lines: [
        'const name = process.argv[2]',
        "const built = readFileSync(join(ROOT, 'src/planted', name + '.ts'), 'utf8')",
        "const walked = readdirSync(join(ROOT, 'src', 'planted')).map(f => readFileSync(join(ROOT, 'src', 'planted', f), 'utf8'))",
        "const globbed = new Bun.Glob('src/planted/*.ts')",
        "const handed = readFileSync(process.argv[3] ?? '', 'utf8')",
        "const other = readFileSync(join(scratch, 'proj', 'src', 'lone.ts'), 'utf8')",
        "const child = execFileSync(process.execPath, ['-e', \"import t from './src/lone.ts' with { type: 'text' }; console.log(t.length)\"])",
        "console.log(built.includes('a'), walked, globbed, handed.includes('b'), other.includes('c'), child)",
      ],
      events: [],
      searches: 0,
      namesOnly: [],
    },
  ]
  const root = mkdtempSync(join(tmpdir(), 'source-text-reads-'))
  for (const { file, lines } of planted) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), lines.join('\n') + '\n')
  }
  const { facts, read, aside } = factsOf(root, { scripts: planted.map(p => p.file), src: srcOf([ONE, TWO, THREE, JSON_ROWS, LONE]), listed: true })
  rmSync(root, { recursive: true, force: true })
  const seen = (file: string): string => {
    const f = facts.get(file)
    return f === undefined ? 'not read' : `opened [${[...f.events].sort((a, b) => Number(a.split(' ')[0]) - Number(b.split(' ')[0]) || (a < b ? -1 : 1)).join(' · ')}] searches ${f.searches.length} names only [${[...f.namesOnly.keys()].sort().join(' ')}]`
  }
  const want = (p: (typeof planted)[number]): string => `opened [${p.events.map(([line, file]) => `${line} ${file}`).sort((a, b) => Number(a.split(' ')[0]) - Number(b.split(' ')[0]) || (a < b ? -1 : 1)).join(' · ')}] searches ${p.searches} names only [${[...p.namesOnly].sort().join(' ')}]`
  const holds = (file: string): boolean => seen(file) === want(planted.find(p => p.file === file)!)
  const differs = (file: string): string => `seen ${seen(file)} · want ${want(planted.find(p => p.file === file)!)}`
  const PINS = 'scripts/a/prove-pins.ts'
  check(
    'a file a script opens as text is a pin, with the line that opens it: a path handed to a read, in one piece or in segments, a text import, a helper of the file that reads what it is handed, a helper that holds the folder and is handed the name, a . or .. inside the path, a list mapped into a read, a table looped into a read, a helper of a module the script imports, handed a path or holding one, a tool that reads (git show, grep), and the source of a function taken from an imported module',
    holds(PINS),
    differs(PINS),
  )
  check('a search on text read from a pinned file is counted where it is made: includes, test, split, indexOf, match, startsWith and endsWith, one for each call of a helper that searches what it is handed (9 on the one line)', facts.get(PINS)?.searches.every(s => s.line === 23) === true && facts.get(PINS)?.searches.length === 9, differs(PINS))
  check('a name that is only listed is no pin and is counted apart: a list nothing opens, a label, a pattern, a test that the file is there, a fixture written under another root, a file run as a program, a sentence', holds('scripts/a/prove-names.ts'), differs('scripts/a/prove-names.ts'))
  check('an import is neither: static, for its effect, of a type, of data, re-exported, assigned from require, dynamic, dynamic on a built path or a template, require, in a type, through mock.module, through a helper that imports what it is handed, in the text of a child program, and neither is a comment', holds('scripts/a/prove-imports.ts'), differs('scripts/a/prove-imports.ts'))
  check('a helper that imports what it is handed and reads it as text too opens it, and so do a read inside the argument of an import and a path joined by a joiner taken under another name', holds('scripts/a/prove-closed.ts'), differs('scripts/a/prove-closed.ts'))
  check('a helper module holds the pin of the file its own function names, and nothing for the path it is handed', holds('scripts/lib/door.ts'), differs('scripts/lib/door.ts'))
  check('in shell, Python and a script with no extension every name on a line that is no comment is taken as opened, and each such line as one search', ['run-all.sh', 'reader.py', 'hook'].every(f => holds(`scripts/a/${f}`)), ['run-all.sh', 'reader.py', 'hook'].map(f => differs(`scripts/a/${f}`)).join(' · '))
  const far = facts.get('scripts/a/out-of-reach.ts')
  check(
    `a data file, a document and a binary file are not read (${read} of ${planted.length} files read, ${aside} set aside that names a src file), and out of reach stay a name assembled at run time, a walked folder, a glob, a path from outside the file, a src folder of another tree and a text import in the text of a child program: no pin, and the script is counted for its folder, its run-time name and its child program`,
    read === planted.length - 3 && aside === 2 && holds('scripts/a/out-of-reach.ts') && far?.folder === true && far.fragment === true && far.childText === true && !facts.has('scripts/a/list.txt') && !facts.has('scripts/a/notes.md') && !facts.has('scripts/a/packed.bin'),
    `${differs('scripts/a/out-of-reach.ts')} · folder ${far?.folder} · run-time name ${far?.fragment} · child program ${far?.childText} · read ${read} · aside ${aside}`,
  )
  const rows = rowsOf(facts)
  const text = render(rows)
  const table = tableOf(text)
  const counts = [...rows].map(([script, row]) => `${script} ${row.pins} ${row.searches}`).join(' · ')
  check('the table is one row for each script that opens a src file: the files it opens, its searches, a digest of the files, in order, and reads back as written', counts === 'scripts/lib/door.ts 1 0 · scripts/a/prove-pins.ts 5 9 · scripts/a/prove-closed.ts 3 2 · scripts/a/run-all.sh 3 4 · scripts/a/reader.py 2 2 · scripts/a/hook 1 1' && table !== null && render(table) === text && text.startsWith('scripts/a/hook\t1\t1\t'), counts)
  check('a table with a row that is no script with its two counts and its digest, or with a script twice, does not read', tableOf('scripts/a/hook\t1\n') === null && tableOf('scripts/a/hook\t0\t0\t0123456789ab\n') === null && tableOf('scripts/a/hook\t1\t1\t0123456789ab\nscripts/a/hook\t1\t1\t0123456789ab\n') === null && tableOf('src/lone.ts\t1\t0\t0123456789ab\n') === null)
  if (table === null) return
  const held = judge(facts, table)
  check('on its own table the estate stands: 15 files opened, 18 searches, no row above its script', held.over.length === 0 && held.pins === 15 && held.searches === 18 && held.allowed === 15 && held.slack === 0, JSON.stringify(held))
  const with_ = (script: string, row: Partial<Row>): Table => new Map([...table].map(([s, r]) => [s, s === script ? { ...r, ...row } : r]))
  const without = (script: string): Table => new Map([...table].filter(([s]) => s !== script))
  const unrowed = judge(facts, without('scripts/a/hook'))
  check('a script with no row that opens a file is named with the line and the file', unrowed.over.length === 1 && told(unrowed.over, facts).includes('scripts/a/hook opens 1 src file as text and searches 1 time in what it read: has no row:\n        scripts/a/hook:2 src/lone.ts'), told(unrowed.over, facts))
  const raised = judge(facts, with_('scripts/a/run-all.sh', { pins: 2 }))
  check('a script that opens one file more than its row allows is named with every file it opens', raised.over.length === 1 && ['its row allows 2 files:', 'scripts/a/run-all.sh:4 src/planted/one.ts', 'scripts/a/run-all.sh:5 src/planted/deep/three.ts', 'scripts/a/run-all.sh:7 src/planted/two.tsx'].every(s => told(raised.over, facts).includes(s)), told(raised.over, facts))
  const worded = judge(facts, with_(PINS, { searches: 8 }))
  check('a script that searches once more than its row allows is named with the line and file of every search', worded.over.length === 1 && told(worded.over, facts).includes('its row allows 8 searches:') && told(worded.over, facts).split(`${PINS}:23 `).length === 10, told(worded.over, facts))
  const swapped = judge(facts, with_('scripts/a/prove-closed.ts', { digest: digestOf([ONE, TWO, THREE]) }))
  check('a script that opens as many files as its row and not the same ones is named: one was swapped for another', swapped.over.length === 1 && swapped.over[0]!.why.includes('swapped'), told(swapped.over, facts))
  const fallen = judge(facts, with_('scripts/a/hook', { pins: 2, searches: 3 }))
  check('a row above its script passes and is counted', fallen.over.length === 0 && fallen.slack === 1, JSON.stringify(fallen))
  const moved = new Map([['scripts/a/hook', 'scripts/a/old-hook']])
  const renamed = (row: Row): Table => new Map([...without('scripts/a/hook'), ['scripts/a/old-hook', row]])
  check(
    'the write rule: a row is written when it falls, leaves or holds other files; a new row and a higher row are refused; a row moves with its file when git reads the rename and its counts are no higher',
    refused(facts, table, new Map()).length === 0 &&
      refused(facts, with_('scripts/a/hook', { pins: 5, searches: 5 }), new Map()).length === 0 &&
      refused(facts, with_('scripts/a/prove-closed.ts', { digest: digestOf([ONE, TWO, THREE]) }), new Map()).length === 0 &&
      refused(facts, without('scripts/a/hook'), new Map()).map(o => o.script).join() === 'scripts/a/hook' &&
      refused(facts, with_(PINS, { pins: 4 }), new Map()).map(o => o.script).join() === PINS &&
      refused(facts, with_(PINS, { searches: 8 }), new Map()).map(o => o.script).join() === PINS &&
      refused(facts, renamed({ pins: 1, searches: 1, digest: digestOf([LONE]) }), moved).length === 0 &&
      refused(facts, renamed({ pins: 1, searches: 0, digest: digestOf([LONE]) }), moved).map(o => o.script).join() === 'scripts/a/hook',
    JSON.stringify(refused(facts, renamed({ pins: 1, searches: 0, digest: '' }), moved)),
  )
  const before = new Map([...renamed({ pins: 1, searches: 1, digest: digestOf([LONE]) })].filter(([s]) => s !== 'scripts/a/reader.py').map(([s, r]): [string, Row] => [s, s === PINS ? { ...r, searches: 8 } : s === 'scripts/a/prove-closed.ts' ? { ...r, digest: digestOf([ONE, TWO, THREE]) } : r]))
  const read2 = risen(before, table, moved)
  check(
    'the comparison of two tables prints a row that is new, a row that is higher and a row that holds other files, counts the first two, and passes a row that moved with its file; a table of the older shape gives its count of names for the files',
    read2.higher === 2 && read2.lines.length === 3 && read2.lines.some(l => l.startsWith('NEW ') && l.endsWith('scripts/a/reader.py')) && read2.lines.some(l => l.startsWith('ROSE ') && l.includes('8 searches -> 5 files, 9 searches') && l.endsWith(PINS)) && read2.lines.some(l => l.startsWith('SWAP ') && l.endsWith('scripts/a/prove-closed.ts')) && risen(olderTableOf('scripts/a/hook\t1\nscripts/a/prove-pins.ts\t4\n'), new Map([...table].filter(([s]) => s === 'scripts/a/hook' || s === PINS)), new Map()).lines.join() === `ROSE  4 files -> 5 files, 9 searches\t${PINS}`,
    read2.lines.join(' · '),
  )
  check('an estate git lists nothing of is not read as an empty one: with no file listed the floor fails', floor({ scripts: [], src: srcOf([]), listed: true }, 0) !== '' && floor({ scripts: [SELF], src: srcOf([]), listed: false }, 1) !== '' && floor({ scripts: [SELF], src: srcOf([ONE]), listed: true }, 1) === '')
}

function floor(estate: Estate, read: number): string {
  if (!estate.listed) return `git lists nothing here: run the proof inside the checkout, with no GIT_DIR, GIT_INDEX_FILE or GIT_WORK_TREE in its environment`
  if (!estate.scripts.includes(SELF)) return `git lists ${estate.scripts.length} files under scripts and not ${SELF}: the proof reads the files git lists, so a tree git lists nothing of proves nothing`
  return read === 0 ? 'no script was read' : ''
}

function report(facts: Map<string, Facts>): void {
  const readers = new Map<string, number>()
  for (const f of facts.values()) for (const file of f.pins.keys()) readers.set(file, (readers.get(file) ?? 0) + 1)
  const top = (m: Map<string, number>): string =>
    [...m]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, 40)
      .map(([name, n]) => `\n  ${String(n).padStart(5)}  ${name}`)
      .join('')
  console.log(`\n  the 40 src files most scripts open as text (scripts that open the file; ${readers.size} files are opened by at least one):${top(readers)}`)
  console.log(`\n  the 40 scripts that open the most src files:${top(new Map([...facts].map(([script, f]) => [script, f.pins.size])))}`)
  console.log(`\n  the 40 scripts with the most searches in what they read:${top(new Map([...facts].map(([script, f]) => [script, f.searches.length])))}`)
  console.log(`\n  the 40 scripts with the most names only:${top(new Map([...facts].map(([script, f]) => [script, f.namesOnly.size])))}`)
}

if (process.argv.includes('--risen')) {
  const [base, tip] = process.argv.slice(process.argv.indexOf('--risen') + 1)
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 })
  if (!base || !tip) {
    console.log(`usage: bun ${SELF} --risen <base commit> <tip commit>`)
    process.exit(2)
  }
  let was = ''
  try {
    was = git('show', `${base}:${TABLE}`)
  } catch {
    was = ''
  }
  const now = git('show', `${tip}:${TABLE}`)
  const moved = new Map<string, string>()
  for (const line of git('diff', '-M', '--name-status', base, tip, '--', 'scripts').split('\n')) {
    const [status, from, to] = line.split('\t')
    if (status?.startsWith('R') && from && to) moved.set(to, from)
  }
  const older = olderTableOf(was)
  const read = risen(older, olderTableOf(now), moved)
  if ([...older.values()].some(row => row.searches < 0)) console.log(`the table at ${base} is of the older shape (a script and the src files it names): its count stands for the files opened, and searches and digests begin at ${tip}`)
  for (const line of read.lines) console.log(line)
  console.log(`${read.higher} rows new or higher · ${read.lines.length - read.higher} rows that hold other files · ${older.size} rows at ${base}, ${olderTableOf(now).size} at ${tip}`)
  process.exit(read.higher === 0 ? 0 : 1)
}

section('§0 the reader on a planted estate: what is a pin, what is a search, what is only a name, and how the table is kept')
plantedEstate()

section(`§1 the estate: the src files each script opens as text and its searches in what it read, against ${TABLE}`)
const estate = estateOf(ROOT)
const { facts, read, aside } = factsOf(ROOT, estate)
const rows = rowsOf(facts)
const sum = (of: (f: Facts) => number): number => [...facts.values()].reduce((n, f) => n + of(f), 0)
const count = (of: (f: Facts) => boolean): number => [...facts.values()].filter(of).length
const totals = { pins: sum(f => f.pins.size), searches: sum(f => (f.pins.size > 0 ? f.searches.length : 0)), namesOnly: sum(f => f.namesOnly.size) }
const text = existsSync(join(ROOT, TABLE)) ? readFileSync(join(ROOT, TABLE), 'utf8') : null
const table = text === null ? null : tableOf(text)
const REACH = `the fence reads scripts/ and counts files under src/: a test in another folder and source outside src/ are not read. Out of reach, with the scripts that do it today: a folder under src that is walked, globbed or searched by a tool, or the base of a name built at run time (${count(f => f.folder)} name one); a name under src assembled at run time (${count(f => f.fragment)} read one); a search in a shell or Python script, where every name counts as opened and every line that names a file as one search (${count(f => f.shell && f.pins.size > 0)}); a text import spelled in the text of a child program (${count(f => f.childText)}); a script whose helper calls outrun the ${STEPS} steps the reader follows them for (${count(f => f.spent)}); a list kept in a data file or a document (${aside} such files name a src file); and with no count a path that arrives from outside the file, a copy of the tree under a named folder, a search by another method than includes, indexOf, match, search, split, startsWith, endsWith, test and exec, and more needles handed to one call`
const REPAIR = `${INSTEAD}; a row is written only when it falls, leaves, holds other files or moves with its file (git mv, then bun ${SELF} --write)`
console.log(`  ${estate.scripts.length} files under scripts · ${read} read (code by its syntax tree, shell and Python by the line; data files, documents and binary files aside) · ${estate.src.files.size} files under src · ${rows.size} scripts open a src file as text · ${totals.pins} files opened · ${totals.searches} searches · ${totals.namesOnly} names only`)
const low = floor(estate, read)
check('git lists the proof among the files under scripts, and scripts were read', low === '', low)
if (process.argv.includes('--write')) {
  const no = table === null ? [] : refused(facts, table, movedIn(ROOT))
  if (failures > 0) console.log('  nothing written: the reader failed on its own estate or the estate is not listed')
  else if (text !== null && table === null) check(`${TABLE} reads as rows of a script, the files it opens, its searches and a digest`, false, `nothing written: a table of another shape stands there; a first table is written where none stands (git rm ${TABLE}, then --write)`)
  else if (no.length > 0) check(`no row is new or higher (${no.length} are)`, false, `nothing written — ${REPAIR}:${told(no, facts)}`)
  else {
    writeFileSync(join(ROOT, TABLE), render(rows))
    console.log(`  wrote ${TABLE}: ${rows.size} rows · ${totals.pins} files opened · ${totals.searches} searches${table === null ? ' (the first table)' : ` (it held ${table.size} rows)`}`)
  }
} else if (table === null) {
  check(`${TABLE} reads as rows of a script, the files it opens, its searches and a digest`, false, text === null ? `no table: bun ${SELF} --write writes the first one` : 'a row is not a script under scripts, two counts and a digest of 12 hex digits, or a script stands twice')
} else {
  const found = judge(facts, table)
  check(`no script opens more src files as text than its row allows, searches more often in what it read, or opens other files; a script with no row opens none (${table.size} rows · ${REACH})`, found.over.length === 0, `${found.over.length} found — ${REPAIR}:${told(found.over, facts)}`)
  if (found.slack > 0) console.log(`  rows above their script's count: ${found.slack} (the fold lowers them with bun ${SELF} --write)`)
}
if (process.argv.includes('--report')) report(facts)
console.log(`\nprove-source-text-reads: ${failures === 0 ? 'green' : `${failures} failed`} · pins ${totals.pins} (src files opened as text) · searches ${totals.searches} · names only ${totals.namesOnly} · scripts with a row ${rows.size}`)
process.exit(failures === 0 ? 0 : 1)
