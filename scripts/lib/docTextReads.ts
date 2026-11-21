import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { ModuleCache, calleeName, declarationOf, functionOf, importOf, importTarget, importedDeclaration, isFunctionNode, namedFunctionDecl, parseSource, referencesOf, returnedExpressions, rootDeclarationOf, slash, stringText, unwrap, unwrapAwait, visit } from '../gate/sourceCensus.ts'
import { GENERATORS, STEPS, toolsOf } from './sourceTextReads.ts'

export { GENERATORS, STEPS }
export const DOC_TOOLS = ['scripts/vscode/build-vsix.sh']

const REPO = '\x01'
const UNKNOWN = '\0'
const DEEP = 48
const CODE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/
const SHELL = /\.(?:sh|bash|zsh|py|ps1)$|(?:^|\/)[^./]+$/
const QUOTED_SEGMENTS = /['"]\s*[,+/]\s*['"]/g
const READERS = new Set(['readFileSync', 'readFile', 'createReadStream', 'openSync'])
const RUNNERS = new Set(['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync'])
const CHILD_PROCESS = /^(?:node:)?child_process$/
const READ_TOOL = /(?:^|[\s/])(?:grep|egrep|fgrep|rg|cat|sed|awk|head|tail|wc|cmp|show|cat-file|blame)(?:$|\s)/
const JOINERS = new Set(['join', 'resolve'])
const PATH_MODULE = /^(?:path|posix|win32)$/i
const FIRST_ARG = new Set(['fileURLToPath', 'pathToFileURL', 'String', 'stringify', 'parse', 'normalize', 'realpathSync', 'from', 'fromEntries'])
const OF_OBJECT = new Set(['keys', 'values', 'entries'])
const KEEPS = new Set(['toString', 'text', 'json', 'trim', 'trimStart', 'trimEnd', 'toLowerCase', 'toUpperCase', 'slice', 'substring', 'substr', 'replace', 'replaceAll', 'normalize', 'split', 'join', 'filter', 'flat', 'reverse', 'toReversed', 'sort', 'toSorted', 'at', 'padEnd', 'padStart', 'repeat', 'match', 'matchAll', 'find', 'findLast', 'shift', 'pop', 'concat'])
const EACH = new Set(['map', 'flatMap', 'forEach', 'filter', 'some', 'every', 'find', 'findLast', 'findIndex', 'reduce'])
const FILLERS = new Set(['push', 'unshift', 'add', 'set'])
const SEARCHES = new Set(['includes', 'indexOf', 'match', 'search', 'split', 'startsWith', 'endsWith'])
const PATTERN_SEARCHES = new Set(['test', 'exec'])
const AS_TEXT = /\b(?:text|file)\b/
const SHELL_DOC_TOKEN = /(?:^|[\s'"`(:=])([A-Za-z0-9_./-]+\.md)\b/gi

export type DocHit = { line: number; file: string }
type Docs = { files: Map<string, string>; folders: Set<string>; names: Set<string> }
export type DocEstate = { scripts: string[]; docs: Docs; listed: boolean; tools?: ReadonlySet<string> }
export type DocFacts = { pins: Map<string, number>; events: string[]; searches: DocHit[]; namesOnly: Map<string, number>; folder: boolean; shell: boolean; spent: boolean }
type Value = { paths: string[]; text: string[] }
type Env = Map<ts.Node, Value>
type Cx = { root: string; docs: Docs; tools: ReadonlySet<string>; modules: ModuleCache; sf: ts.SourceFile; pins: Map<string, number>; events: Set<string>; searches: DocHit[]; helpers: Set<ts.FunctionLikeDeclaration>; entered: Set<ts.Node>; stack: Set<ts.Node>; valuing: Set<ts.Node>; fills: Map<ts.Node, ts.Expression[]>; walked: Map<ts.Node, Map<string, Array<{ file: string; search: boolean }>>>; log: Array<{ file: string; search: boolean }>; steps: number }

const KNOWN = { decls: new WeakMap<ts.Identifier, ts.Node | null>(), fns: new WeakMap<ts.CallExpression, ts.FunctionLikeDeclaration | null>(), paths: new WeakMap<ts.Node, string[]>(), text: new WeakMap<ts.Node, string[]>(), inert: new WeakMap<ts.Node, boolean>(), pathsIn: new WeakMap<Env, Map<ts.Node, string[]>>(), textIn: new WeakMap<Env, Map<ts.Node, string[]>>() }

const isDocFile = (file: string): boolean => {
  if (!file.endsWith('.md')) return false
  if (!file.includes('/')) return true
  if (file.startsWith('docs/')) return true
  if (file === 'sdk/README.md' || file === 'sdk-py/README.md') return true
  return /^integrations\/[^/]+\/README\.md$/i.test(file)
}

export function docsOf(files: string[]): Docs {
  const docs: Docs = { files: new Map(), folders: new Set(), names: new Set() }
  for (const file of files) {
    if (!isDocFile(file)) continue
    const key = file.toLowerCase()
    docs.files.set(key, file)
    docs.names.add(key.slice(key.lastIndexOf('/') + 1))
    for (let at = key.lastIndexOf('/'); at > 0; at = key.lastIndexOf('/', at - 1)) docs.folders.add(key.slice(0, at))
  }
  return docs
}

export function docToolsOf(scripts: string[], generators: string): Set<string> {
  const base = toolsOf(scripts, generators)
  const listed = new Set(scripts)
  for (const script of DOC_TOOLS) if (listed.has(script)) base.add(script)
  return new Set([...base].sort())
}

export function estateOf(root: string): DocEstate {
  let listed = ''
  try {
    listed = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return { scripts: [], docs: docsOf([]), listed: false }
  }
  const files = [...new Set(listed.split('\0').filter(Boolean))].sort()
  const scripts = files.filter(f => f.startsWith('scripts/'))
  let generators = ''
  try {
    generators = readFileSync(join(root, GENERATORS), 'utf8')
  } catch {
    generators = ''
  }
  return { scripts, docs: docsOf(files), listed: true, tools: docToolsOf(scripts, generators) }
}

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
    else if (top !== UNKNOWN && top !== REPO && top !== '') out.pop()
  })
  return out
}

const isRepoRootVal = (p: string): boolean => {
  const segs = normal(p)
  return segs.length === 1 && segs[0] === REPO
}

function docNamed(cx: Cx, path: string): string | undefined {
  if (!path) return undefined
  const segs = normal(path)
  if (segs.length === 0) return undefined
  let relSegs: string[] | undefined
  if (segs[0] === REPO) relSegs = segs.slice(1)
  else if (segs[0] !== '' && segs[0] !== UNKNOWN && !segs[0]!.includes(UNKNOWN) && !segs[0]!.startsWith('..') && !/^[A-Za-z]:$/.test(segs[0]!)) relSegs = segs
  if (!relSegs || relSegs.length === 0) return undefined
  const exact = cx.docs.files.get(relSegs.join('/').toLowerCase())
  if (exact !== undefined) return exact
  const hole = relSegs.findIndex(s => s.includes(UNKNOWN))
  if (hole > 0) {
    const folder = relSegs.slice(0, hole).join('/').toLowerCase()
    if (cx.docs.folders.has(folder)) return `${folder}/**`
  }
  return undefined
}

const filesOf = (cx: Cx, paths: string[]): string[] => [...new Set(paths.flatMap(p => docNamed(cx, p) ?? []))]

function scriptImport(cx: Cx, decl: ts.Node): ts.Node | undefined {
  const ref = importOf(decl)
  const target = ref ? importTarget(decl.getSourceFile().fileName, ref.module) : null
  const script = target === null ? '' : slash(relative(cx.root, target))
  return script.startsWith('scripts/') && !cx.tools.has(script) ? importedDeclaration(cx.modules, decl) : undefined
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

function repoPathOfFile(cx: Cx, node: ts.Node, dirOnly: boolean): string {
  const rel = slash(relative(cx.root, node.getSourceFile().fileName))
  const target = dirOnly ? slash(dirname(rel)) : rel
  return target === '.' || target === '' ? REPO : `${REPO}/${target}`
}

function runnerInRepo(cx: Cx, call: ts.CallExpression, env: Env, d: number): boolean {
  const last = call.arguments[call.arguments.length - 1]
  if (last) {
    const obj = unwrap(last)
    if (ts.isObjectLiteralExpression(obj)) {
      for (const p of obj.properties) {
        if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'cwd') {
          if (!ev(cx, p.initializer, env, d + 1).some(isRepoRootVal)) return false
        } else if (ts.isShorthandPropertyAssignment(p) && p.name.text === 'cwd') {
          if (!ev(cx, p.name, env, d + 1).some(isRepoRootVal)) return false
        }
      }
    }
  }
  const argList = call.arguments[1] ? unwrap(call.arguments[1]) : undefined
  if (argList && ts.isArrayLiteralExpression(argList)) {
    for (let i = 0; i < argList.elements.length - 1; i++) {
      if (stringText(unwrap(argList.elements[i]!)) === '-C') {
        if (!ev(cx, argList.elements[i + 1]!, env, d + 1).some(isRepoRootVal)) return false
      }
    }
  }
  return true
}

function isRunnerCall(callee: ts.Expression, name: string): boolean {
  if (!RUNNERS.has(name)) return false
  if (name !== 'exec' || !ts.isPropertyAccessExpression(callee)) return true
  const recv = unwrap(callee.expression)
  if (ts.isIdentifier(recv)) {
    const decl = declOf(recv)
    const ref = decl ? importOf(decl) : undefined
    return ref !== undefined && CHILD_PROCESS.test(ref.module)
  }
  if (ts.isCallExpression(recv) && calleeName(recv) === 'require' && recv.arguments[0]) {
    const spec = stringText(unwrap(recv.arguments[0]))
    return spec !== undefined && CHILD_PROCESS.test(spec)
  }
  return false
}

function gitLsFilesValue(cx: Cx, call: ts.CallExpression, env: Env, d: number): string[] | undefined {
  const name = nameOf(call)
  if (name === undefined || !isRunnerCall(unwrap(call.expression), name) || !runnerInRepo(cx, call, env, d)) return undefined
  const first = call.arguments[0] ? ev(cx, call.arguments[0], env, d + 1) : []
  const isGitLs = first.some(s => /^git\s+ls-files\b/.test(s)) || (first.includes('git') && call.arguments[1] !== undefined && ev(cx, call.arguments[1], env, d + 1).includes('ls-files'))
  if (!isGitLs) return undefined
  const args = call.arguments.slice(0, 2).flatMap(a => ev(cx, a, env, d + 1))
  if (/\bdocs\b/.test(args.join(' '))) return [`docs/${UNKNOWN}`]
  return undefined
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
    if (ofTheModule(decl) && d < DEEP / 2) KNOWN.paths.set(decl, held)
    return held
  }
  if (ts.isParameter(decl)) {
    const each = eachReceiver(decl)
    return each ? ev(cx, each, env, d + 1) : decl.initializer ? ev(cx, decl.initializer, env, d + 1) : [UNKNOWN]
  }
  if (ts.isImportSpecifier(decl) || ts.isImportClause(decl)) {
    const target = scriptImport(cx, decl)
    if (target && ts.isVariableDeclaration(target) && target.initializer) return ev(cx, target.initializer, new Map(), d + 1)
  }
  return [UNKNOWN]
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
    if (x.text === '__dirname') return [repoPathOfFile(cx, x, true)]
    if (x.text === '__filename') return [repoPathOfFile(cx, x, false)]
    const decl = declOf(x)
    return decl ? evDecl(cx, decl, x.text, env, d) : [UNKNOWN]
  }
  if (ts.isPropertyAccessExpression(x)) {
    if (ts.isMetaProperty(x.expression)) {
      if (x.name.text === 'dir' || x.name.text === 'dirname') return [repoPathOfFile(cx, x, true)]
      if (x.name.text === 'url' || x.name.text === 'filename' || x.name.text === 'path') return [repoPathOfFile(cx, x, false)]
      return [UNKNOWN]
    }
    return ev(cx, x.expression, env, d + 1)
  }
  if (ts.isElementAccessExpression(x)) return ts.isMetaProperty(x.expression) ? [UNKNOWN] : ev(cx, x.expression, env, d + 1)
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
  const lsFiles = gitLsFilesValue(cx, call, env, d)
  if (lsFiles) return lsFiles
  const callee = unwrap(call.expression)
  const recv = ts.isPropertyAccessExpression(callee) ? callee.expression : undefined
  if (name === 'cwd' && recv && ts.isIdentifier(unwrap(recv)) && (unwrap(recv) as ts.Identifier).text === 'process') return [REPO]
  if (name !== undefined) {
    const from = recv ? unwrap(recv) : undefined
    const ofPath = !from || PATH_MODULE.test(ts.isIdentifier(from) ? from.text : ts.isPropertyAccessExpression(from) ? from.name.text : ts.isCallExpression(from) ? (stringText(unwrap(from.arguments[0] ?? from)) ?? '').replace(/^node:/, '') : '')
    if (JOINERS.has(name) && ofPath && args.length > 0) return args.map(a => ev(cx, a, env, d + 1)).reduce((a, b) => cross(a, b, '/'))
    if (name === 'dirname' && args[0]) return ev(cx, args[0], env, d + 1).map(p => `${p}/..`)
    if (name === 'relative' && ofPath && args[0] && args[1]) {
      const bases = ev(cx, args[0], env, d + 1).map(b => normal(b).join('/'))
      const targets = ev(cx, args[1], env, d + 1).map(t => normal(t).join('/'))
      const out: string[] = []
      for (const b of bases) for (const t of targets) if (t.startsWith(`${b}/`)) out.push(t.slice(b.length + 1))
      return out.length > 0 ? out : [UNKNOWN]
    }
    if (FIRST_ARG.has(name) && args[0] && (ofPath || !KEEPS.has(name))) return ev(cx, args[0], env, d + 1)
    if (OF_OBJECT.has(name)) return args[0] ? ev(cx, args[0], env, d + 1) : recv ? ev(cx, recv, env, d + 1) : [UNKNOWN]
    const handed = recv && args[0] ? unwrap(args[0]) : undefined
    if (recv && (name === 'map' || name === 'flatMap')) return handed && isFunctionNode(handed) ? union(...returnedExpressions(handed).map(r => ev(cx, r, env, d + 1))) : ev(cx, recv, env, d + 1)
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

function docFromImport(cx: Cx, from: string, spec: string): string | undefined {
  if (!spec.startsWith('.')) return undefined
  const target = slash(relative(cx.root, resolve(dirname(from), spec)))
  return cx.docs.files.get(target.toLowerCase())
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
    const hit = spec === undefined ? undefined : docFromImport(cx, call.getSourceFile().fileName, spec)
    return hit ? [hit] : []
  }
  if (name === undefined || !isRunnerCall(callee, name) || !runnerInRepo(cx, call, env, 0)) return []
  const said = call.arguments.slice(0, 2).flatMap(a => ev(cx, a, env))
  if (!said.some(s => READ_TOOL.test(s))) return []
  const out = new Set<string>()
  for (const s of said) {
    for (const token of s.split(/[\s:'"]+/).filter(Boolean)) {
      const hit = docNamed(cx, token)
      if (hit) out.add(hit)
    }
  }
  return [...out]
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
    const hit = spec === undefined ? undefined : docFromImport(cx, decl.getSourceFile().fileName, spec)
    return hit ? [hit] : []
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
    const key = JSON.stringify([...bound.values()].map(v => [v.paths.slice(0, 16), v.text]))
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

function collectNamedDocs(sf: ts.SourceFile, docs: Docs): { named: DocHit[]; textImports: DocHit[]; folder: boolean } {
  const named: DocHit[] = []
  const textImports: DocHit[] = []
  let folder = false
  visit(sf, node => {
    if (ts.isImportDeclaration(node) && node.attributes && AS_TEXT.test(node.attributes.getText())) {
      const spec = stringText(node.moduleSpecifier)
      if (spec !== undefined && spec.startsWith('.')) {
        const target = slash(relative(dirname(sf.fileName), resolve(dirname(sf.fileName), spec)))
        const base = target.split('/').pop()?.toLowerCase() ?? ''
        if (docs.names.has(base)) textImports.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, file: spec })
      }
      return
    }
    const whole = stringText(node)
    if (whole === undefined) return
    const norm = whole.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
    if (norm === 'docs' || norm.startsWith('docs/')) folder = true
    const hit = docs.files.get(norm)
    if (hit !== undefined) named.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, file: hit })
  })
  return { named, textImports, folder }
}

function shellReads(text: string, docs: Docs): DocHit[] {
  const out: DocHit[] = []
  text.split('\n').forEach((line, i) => {
    if (line.trimStart().startsWith('#')) return
    const seen = new Set<string>()
    for (const view of new Set([line, line.replace(QUOTED_SEGMENTS, '/')])) {
      for (const m of view.matchAll(SHELL_DOC_TOKEN)) {
        const cleaned = m[1]!.replace(/^\.\//, '').toLowerCase()
        const file = docs.files.get(cleaned)
        if (file === undefined || seen.has(file)) continue
        seen.add(file)
        out.push({ line: i + 1, file })
      }
    }
  })
  return out
}

function codeFacts(root: string, docs: Docs, tools: ReadonlySet<string>, modules: ModuleCache, script: string): DocFacts {
  const { sf } = parseSource(root, join(root, script))
  const { named, textImports, folder } = collectNamedDocs(sf, docs)
  const cx: Cx = { root, docs, tools, modules, sf, pins: new Map(), events: new Set(), searches: [], helpers: new Set(), entered: new Set(), stack: new Set(), valuing: new Set(), fills: new Map(), walked: new Map(), log: [], steps: 0 }
  for (const imp of textImports) {
    const hit = docFromImport(cx, sf.fileName, imp.file)
    if (hit !== undefined) pin(cx, hit, imp.line)
  }
  walk(cx, sf, new Map(), undefined, 0)
  for (const fn of cx.helpers) {
    if (cx.entered.has(fn) || !fn.body || inert(cx, fn)) continue
    cx.entered.add(fn)
    walk(cx, fn.body, new Map(), undefined, 1)
  }
  const namesOnly = new Map<string, number>()
  for (const n of named) if (!cx.pins.has(n.file) && !namesOnly.has(n.file)) namesOnly.set(n.file, n.line)
  return { pins: cx.pins, events: [...cx.events], searches: cx.searches, namesOnly, folder, shell: false, spent: cx.steps > STEPS }
}

function shellFacts(text: string, docs: Docs): DocFacts {
  const hits = shellReads(text, docs)
  const pins = new Map<string, number>()
  for (const h of hits) if (!pins.has(h.file)) pins.set(h.file, h.line)
  return { pins, events: hits.map(h => `${h.line} ${h.file}`), searches: hits, namesOnly: new Map(), folder: false, shell: true, spent: false }
}

export function factsOf(root: string, estate: DocEstate): { facts: Map<string, DocFacts>; read: number; aside: number } {
  const facts = new Map<string, DocFacts>()
  const modules = new ModuleCache(root)
  const tools = estate.tools ?? new Set<string>()
  let read = 0
  let aside = 0
  for (const script of estate.scripts) {
    if (tools.has(script)) continue
    let text: string
    try {
      text = readFileSync(join(root, script), 'utf8')
    } catch {
      continue
    }
    if (text.includes('\0')) continue
    if (CODE.test(script)) facts.set(script, codeFacts(root, estate.docs, tools, modules, script))
    else if (SHELL.test(script)) facts.set(script, shellFacts(text, estate.docs))
    else {
      if (shellReads(text, estate.docs).length > 0) aside++
      continue
    }
    read++
  }
  return { facts, read, aside }
}
