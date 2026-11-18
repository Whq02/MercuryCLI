import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { ModuleCache, calleeName, declarationOf, functionOf, importOf, importTarget, importedDeclaration, isDynamicImport, isFunctionNode, namedFunctionDecl, parseSource, referencesOf, returnedExpressions, rootDeclarationOf, slash, stringText, unwrap, unwrapAwait, visit } from '../gate/sourceCensus.ts'

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
export const STEPS = 2_000_000
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

export type Hit = { line: number; file: string }
type Name = Hit & { asText: boolean }
type Src = { files: Map<string, string>; folders: Set<string>; names: Set<string>; parts: Set<string> }
export type Estate = { scripts: string[]; src: Src; listed: boolean }
export type Facts = { pins: Map<string, number>; events: string[]; searches: Hit[]; namesOnly: Map<string, number>; folder: boolean; fragment: boolean; childText: boolean; shell: boolean; spent: boolean }
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

export function srcOf(files: string[]): Src {
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

export function estateOf(root: string): Estate {
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

export function factsOf(root: string, estate: Estate): { facts: Map<string, Facts>; read: number; aside: number } {
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
