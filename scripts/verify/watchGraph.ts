import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join, posix, relative, resolve } from 'node:path'
import ts from 'typescript'
import { census } from '../gate/prove-suite-class-census.ts'
import { calleeName, declarationOf, parseSource, slash, stringText, unwrap } from '../gate/sourceCensus.ts'
import { factsOf, srcOf } from '../lib/sourceTextReads.ts'

type EdgeKind = 'import' | 'run' | 'lazy' | 'type'
type Edge = { to: string; kind: EdgeKind }
type Blind = { imports: number; paths: number; children: number; git: number }
type Facts = { edges: Edge[]; names: Set<string>; walks: Set<string>; bundle: boolean; blind: Blind }
type Tree = { root: string; list: string[]; files: Set<string>; dirs: Set<string>; aliases: Map<string, string> }
type Step = { hops: number; via: string; kind: EdgeKind }
type How = 'member' | 'runner' | 'import' | 'run' | 'lazy' | 'text' | 'walk'
type Dep = { how: How; hops: number; via: string }

const CODE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/
const RUNNABLE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|sh|py)$/
const BUNDLE = 'dist/mercury.mjs'
const ROOT_NAMES = new Set(['ROOT', 'REPO', 'REPO_ROOT', 'REAL_ROOT', 'root', 'repo', 'repoRoot', 'repo_root', 'GRAPH_ROOT', 'TREE'])
const DIR_NAMES = new Set(['__dirname', 'HERE', 'here', 'DIR', 'dir', 'SUITE_DIR', 'suiteDir'])
const FOLDER_NAMES = new Map([['SRC', 'src'], ['SRC_DIR', 'src'], ['srcDir', 'src'], ['SCRIPTS', 'scripts'], ['SCRIPTS_DIR', 'scripts']])
const SPAWNERS = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'])
const FS_READERS = new Set(['readFileSync', 'readFile', 'readdirSync', 'readdir', 'existsSync', 'statSync', 'lstatSync', 'openSync', 'createReadStream', 'file', 'opendirSync', 'accessSync'])
const PASS_THROUGH = new Set(['fileURLToPath', 'pathToFileURL', 'String', 'realpathSync', 'normalize', 'toString'])
const WALKER = /^(?:Glob|readdir|opendir|scan|walk|glob|ls|list|collect|census|gather|crawl|enumerate|discover|files|tree|load|git)/i
const TOKEN = /(?<![A-Za-z0-9_@./-])(?:[A-Za-z0-9_@.-]+\/)+[A-Za-z0-9_@.*-]+/g
const WHOLE = /^(?:(src|scripts)\/)?\*\*(?:\/.*)?$/
const RUNNER = /^scripts\/[^/]+\/run-all\.sh$/
const EAGER = new Set<EdgeKind>(['import', 'run'])
const VALUE = new Set<EdgeKind>(['import', 'run', 'lazy'])
const EVERY = new Set<EdgeKind>(['import', 'run', 'lazy', 'type'])
const UNLISTED = new Set(['.git', '.mercury', 'dist', 'node_modules'])

const blank = (): Facts => ({ edges: [], names: new Set(), walks: new Set(), bundle: false, blind: { imports: 0, paths: 0, children: 0, git: 0 } })

const globs = new Map<string, InstanceType<typeof Bun.Glob>>()
function globOf(pattern: string): InstanceType<typeof Bun.Glob> {
  let g = globs.get(pattern)
  if (!g) {
    g = new Bun.Glob(pattern)
    globs.set(pattern, g)
  }
  return g
}

function treeOf(root: string, tracked: string[]): Tree {
  const files = new Set(tracked)
  const dirs = new Set<string>()
  for (const f of tracked) {
    let d = posix.dirname(f)
    while (d !== '.' && !dirs.has(d)) {
      dirs.add(d)
      d = posix.dirname(d)
    }
  }
  const aliases = new Map<string, string>()
  const config = ts.readConfigFile(join(root, 'tsconfig.json'), path => readFileSync(path, 'utf8')).config as { compilerOptions?: { paths?: Record<string, string[]> } } | undefined
  for (const [name, targets] of Object.entries(config?.compilerOptions?.paths ?? {})) if (targets[0]) aliases.set(name, posix.normalize(targets[0]))
  return { root, list: tracked, files, dirs, aliases }
}

function moduleOf(tree: Tree, from: string, spec: string): string | null {
  const plain = spec.startsWith('file://') ? spec.slice(7) : spec
  let base: string
  if (plain.startsWith('.')) base = posix.normalize(posix.join(posix.dirname(from), plain))
  else if (isAbsolute(plain)) base = slash(relative(tree.root, plain))
  else if (tree.aliases.has(plain)) base = tree.aliases.get(plain)!
  else if (tree.dirs.has(plain.split('/')[0]!)) base = posix.normalize(plain)
  else return null
  if (base.startsWith('..')) return null
  const stem = base.replace(/\.(?:js|jsx|mjs)$/, '')
  for (const cand of [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, `${base}.js`, `${base}/index.ts`, `${base}/index.tsx`]) if (tree.files.has(cand)) return cand
  return null
}

function typeOnly(s: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
  if (ts.isExportDeclaration(s)) return s.isTypeOnly
  const clause = s.importClause
  if (!clause) return false
  if (clause.isTypeOnly) return true
  const named = clause.namedBindings
  return clause.name === undefined && named !== undefined && ts.isNamedImports(named) && named.elements.length > 0 && named.elements.every(el => el.isTypeOnly)
}

const isFunction = (n: ts.Node): boolean => ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n)

function sourceFacts(tree: Tree, rel: string): Facts {
  const facts = blank()
  const kind = /\.(?:tsx|jsx)$/.test(rel) ? ts.ScriptKind.TSX : /\.(?:js|mjs|cjs)$/.test(rel) ? ts.ScriptKind.JS : ts.ScriptKind.TS
  const sf = ts.createSourceFile(rel, readFileSync(join(tree.root, rel), 'utf8'), ts.ScriptTarget.Latest, false, kind)
  const edge = (spec: string, how: EdgeKind): void => {
    const to = moduleOf(tree, rel, spec)
    if (to) facts.edges.push({ to, kind: how })
  }
  const walk = (n: ts.Node, deferred: boolean): void => {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) {
      if (n.moduleSpecifier && ts.isStringLiteralLike(n.moduleSpecifier)) edge(n.moduleSpecifier.text, typeOnly(n) ? 'type' : 'import')
      return
    }
    if (ts.isImportEqualsDeclaration(n)) {
      const ref = n.moduleReference
      if (ts.isExternalModuleReference(ref) && ts.isStringLiteralLike(ref.expression)) edge(ref.expression.text, n.isTypeOnly ? 'type' : 'import')
      return
    }
    if (ts.isImportTypeNode(n)) {
      const arg = n.argument
      if (ts.isLiteralTypeNode(arg) && ts.isStringLiteralLike(arg.literal)) edge(arg.literal.text, 'type')
    } else if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require'))) {
      const first = n.arguments[0]
      if (first && ts.isStringLiteralLike(first)) edge(first.text, deferred ? 'lazy' : 'import')
      else facts.blind.imports++
    }
    const inner = deferred || isFunction(n)
    ts.forEachChild(n, child => walk(child, inner))
  }
  walk(sf, false)
  return facts
}

function scriptFacts(tree: Tree, rel: string): Facts {
  const facts = blank()
  const { sf } = parseSource(tree.root, join(tree.root, rel))
  const fileAbs = join(tree.root, rel)
  const dirAbs = posix.dirname(fileAbs)
  const named = (x: ts.Identifier, depth: number): string | null => {
    const decl = declarationOf(x)
    const folder = FOLDER_NAMES.get(x.text)
    const anchor = ROOT_NAMES.has(x.text) ? tree.root : folder !== undefined ? join(tree.root, folder) : null
    if (decl && ts.isVariableDeclaration(decl)) return decl.initializer ? (text(decl.initializer, depth + 1) ?? anchor) : null
    if (decl && !ts.isImportSpecifier(decl) && !ts.isImportClause(decl)) return null
    return anchor ?? (DIR_NAMES.has(x.text) ? dirAbs : null)
  }
  const text = (e: ts.Expression, depth = 0): string | null => {
    if (depth > 8) return null
    const x = unwrap(e)
    const lit = stringText(x)
    if (lit !== undefined) return lit
    if (ts.isIdentifier(x)) return named(x, depth)
    if (ts.isPropertyAccessExpression(x)) {
      const owner = unwrap(x.expression)
      const prop = x.name.text
      if (ts.isMetaProperty(owner)) return prop === 'dir' || prop === 'dirname' ? dirAbs : prop === 'path' || prop === 'filename' || prop === 'url' ? fileAbs : null
      return prop === 'pathname' || prop === 'href' ? text(owner, depth + 1) : null
    }
    if (ts.isTemplateExpression(x)) {
      let out = x.head.text
      for (const span of x.templateSpans) {
        const part = text(span.expression, depth + 1)
        if (part === null) return null
        out += part + span.literal.text
      }
      return out
    }
    if (ts.isBinaryExpression(x)) {
      const op = x.operatorToken.kind
      if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken) return text(x.right, depth + 1)
      if (op !== ts.SyntaxKind.PlusToken) return null
      const left = text(x.left, depth + 1)
      const right = left === null ? null : text(x.right, depth + 1)
      return left === null || right === null ? null : left + right
    }
    if (ts.isConditionalExpression(x)) return text(x.whenFalse, depth + 1) ?? text(x.whenTrue, depth + 1)
    if (ts.isNewExpression(x)) {
      const args = x.arguments ?? []
      if (calleeName(x) !== 'URL' || !args[0]) return null
      const spec = text(args[0], depth + 1)
      const base = args[1] ? text(args[1], depth + 1) : ''
      if (spec === null || base === null) return null
      return base === '' ? spec : resolve(posix.dirname(base), spec)
    }
    if (!ts.isCallExpression(x)) return null
    const name = calleeName(x)
    const args = [...x.arguments]
    if (name === 'cwd' && args.length === 0) return tree.root
    if (name === 'join' || name === 'resolve') {
      const parts: string[] = []
      for (const a of args) {
        const part = ts.isSpreadElement(a) ? null : text(a, depth + 1)
        if (part === null) return null
        parts.push(part)
      }
      if (parts.length === 0) return null
      return name === 'resolve' ? resolve(tree.root, ...parts) : posix.join(...parts)
    }
    if (name === 'dirname' && args[0]) {
      const inner = text(args[0], depth + 1)
      return inner === null ? null : posix.dirname(inner)
    }
    if (name === undefined || !PASS_THROUGH.has(name)) return null
    const callee = unwrap(x.expression)
    const subject = args[0] ?? (ts.isPropertyAccessExpression(callee) ? callee.expression : undefined)
    return subject ? text(subject, depth + 1) : null
  }
  const relOf = (s: string): string | null => {
    const t = s.startsWith('file://') ? s.slice(7) : s
    if (t === '' || /\s/.test(t)) return null
    if (isAbsolute(t)) {
      const r = slash(relative(tree.root, t))
      return r.startsWith('..') ? null : r
    }
    if (t.startsWith('.') || !t.includes('/')) return null
    return posix.normalize(t).replace(/\/$/, '')
  }
  const handedTo = (n: ts.Node): ts.CallExpression | ts.NewExpression | null => {
    const p = n.parent
    if (!ts.isCallExpression(p) && !ts.isNewExpression(p)) return null
    const args: readonly ts.Node[] = p.arguments ?? []
    return args.includes(n) ? p : null
  }
  const argument = (n: ts.Node): boolean => handedTo(n) !== null || ts.isArrayLiteralExpression(n.parent)
  const walked = (n: ts.Node): boolean => {
    const call = handedTo(n)
    return call !== null && WALKER.test(calleeName(call) ?? '')
  }
  const tokens = (chunk: string, run: boolean): void => {
    if (!chunk.includes('/')) return
    if (chunk.includes(BUNDLE)) facts.bundle = true
    for (const m of chunk.matchAll(TOKEN)) {
      const t = posix.normalize(m[0]).replace(/\.+$/, '')
      if (!tree.files.has(t)) continue
      if (run && RUNNABLE.test(t)) facts.edges.push({ to: t, kind: 'run' })
      else facts.names.add(t)
    }
  }
  const place = (n: ts.Node, s: string, run: boolean): boolean => {
    const r = relOf(s)
    if (r === null) return false
    if (r === 'dist' || r.startsWith('dist/')) {
      facts.bundle = true
      return true
    }
    if (tree.files.has(r)) {
      if (run && RUNNABLE.test(r)) facts.edges.push({ to: r, kind: 'run' })
      else facts.names.add(r)
      return true
    }
    if (r !== '' && !r.includes('*') && !tree.dirs.has(r)) return false
    if (walked(n)) facts.walks.add(r === '' ? '.' : r)
    return true
  }
  const rooted = (e: ts.Node): boolean => {
    let hit = false
    const seek = (n: ts.Node): void => {
      if (hit) return
      if (ts.isIdentifier(n) || ts.isPropertyAccessExpression(n)) {
        const s = text(n)
        if (s !== null && (s === tree.root || s.startsWith(`${tree.root}/`))) {
          hit = true
          return
        }
      }
      ts.forEachChild(n, seek)
    }
    seek(e)
    return hit
  }
  const loads = (callee: ts.Expression): boolean => {
    if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require')) return true
    if (!ts.isPropertyAccessExpression(callee)) return false
    const owner = unwrap(callee.expression)
    const prop = callee.name.text
    return (prop === 'resolve' && ((ts.isIdentifier(owner) && owner.text === 'require') || ts.isMetaProperty(owner))) || (prop === 'module' && ts.isIdentifier(owner) && owner.text === 'mock')
  }
  const evaluable = (n: ts.Node): n is ts.Expression =>
    ts.isStringLiteral(n) ||
    ts.isNoSubstitutionTemplateLiteral(n) ||
    ts.isTemplateExpression(n) ||
    ts.isCallExpression(n) ||
    ts.isNewExpression(n) ||
    (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) ||
    ((ts.isIdentifier(n) || ts.isPropertyAccessExpression(n)) && argument(n))
  const walk = (n: ts.Node, run: boolean): void => {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) {
      if (n.moduleSpecifier && ts.isStringLiteralLike(n.moduleSpecifier)) {
        const to = moduleOf(tree, rel, n.moduleSpecifier.text)
        if (to) facts.edges.push({ to, kind: typeOnly(n) ? 'type' : 'import' })
      }
      return
    }
    if (ts.isImportEqualsDeclaration(n)) {
      const ref = n.moduleReference
      const to = ts.isExternalModuleReference(ref) && ts.isStringLiteralLike(ref.expression) ? moduleOf(tree, rel, ref.expression.text) : null
      if (to) facts.edges.push({ to, kind: n.isTypeOnly ? 'type' : 'import' })
      return
    }
    if (ts.isImportTypeNode(n)) {
      const arg = n.argument
      const to = ts.isLiteralTypeNode(arg) && ts.isStringLiteralLike(arg.literal) ? moduleOf(tree, rel, arg.literal.text) : null
      if (to) facts.edges.push({ to, kind: 'type' })
      return
    }
    if (ts.isCallExpression(n)) {
      const name = calleeName(n)
      if (loads(unwrap(n.expression))) {
        const first = n.arguments[0]
        const spec = first ? text(first) : null
        const to = spec === null ? null : moduleOf(tree, rel, spec)
        if (to) facts.edges.push({ to, kind: 'import' })
        else if (spec === null) facts.blind.imports++
        for (const rest of n.arguments.slice(1)) walk(rest, run)
        return
      }
      if (name !== undefined && SPAWNERS.has(name)) {
        const before = facts.edges.length
        const had = facts.bundle
        facts.bundle = false
        for (const a of n.arguments) walk(a, true)
        const ran = facts.edges.length > before || facts.bundle
        facts.bundle = facts.bundle || had
        const program = n.arguments[0] ? text(n.arguments[0]) : null
        if (!ran && program !== null && /(?:^|\/)git$/.test(program)) facts.blind.git++
        else if (!ran) facts.blind.children++
        return
      }
      if (name !== undefined && FS_READERS.has(name) && n.arguments[0] && text(n.arguments[0]) === null && rooted(n.arguments[0])) facts.blind.paths++
    }
    if (evaluable(n)) {
      const s = text(n)
      if (s !== null && place(n, s, run)) return
      if (s !== null && stringText(n) !== undefined) {
        tokens(s, run)
        return
      }
    }
    if (ts.isTemplateExpression(n)) {
      tokens(n.head.text, run)
      for (const span of n.templateSpans) tokens(span.literal.text, run)
    }
    ts.forEachChild(n, child => walk(child, run))
  }
  walk(sf, false)
  return facts
}

function shellFacts(tree: Tree, rel: string, runner: boolean): Facts {
  const facts = blank()
  const dir = posix.dirname(rel)
  for (const raw of readFileSync(join(tree.root, rel), 'utf8').split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    if (line.includes(BUNDLE)) facts.bundle = true
    const plain = line
      .replace(/"?\$\(dirname "\$\{?(?:BASH_SOURCE\[0\]|0)\}?"\)"?/g, dir)
      .replace(/"?\$\{?(?:here|HERE|dir|DIR|SUITE_DIR|suite_dir)\}?"?(?=\/)/g, dir)
      .replace(/"?\$\{?(?:root|ROOT|repo|REPO|repo_root|REPO_ROOT)\}?"?\//g, '')
    for (const m of plain.matchAll(TOKEN)) {
      const t = posix.normalize(m[0]).replace(/\.+$/, '')
      const hits = !t.includes('*') ? (tree.files.has(t) ? [t] : []) : tree.dirs.has(t.split('/')[0]!) ? tree.list.filter(f => globOf(t).match(f)) : []
      for (const f of hits) {
        if (!RUNNABLE.test(f)) facts.names.add(f)
        else if (!runner) facts.edges.push({ to: f, kind: 'run' })
      }
    }
  }
  return facts
}

function pythonFacts(tree: Tree, rel: string): Facts {
  const facts = blank()
  const dir = posix.dirname(rel)
  const code = readFileSync(join(tree.root, rel), 'utf8')
    .split('\n')
    .filter(line => !line.trimStart().startsWith('#'))
    .join('\n')
  if (code.includes(BUNDLE)) facts.bundle = true
  for (const m of code.matchAll(/['"]([^'"\s]+)['"]/g)) {
    const t = posix.normalize(m[1]!)
    if (m[1]!.includes('/') && tree.files.has(t)) facts.names.add(t)
  }
  for (const m of code.matchAll(/^\s*(?:from\s+([A-Za-z_][\w.]*)\s+import|import\s+([A-Za-z_][\w.]*))/gm)) {
    const mod = (m[1] ?? m[2]!).split('.').join('/')
    const to = [`${dir}/${mod}.py`, `scripts/${mod}.py`].find(cand => tree.files.has(cand))
    if (to) facts.edges.push({ to, kind: 'import' })
  }
  return facts
}

function wholeScope(walk: string): string | null {
  if (walk === '.') return ''
  if (walk === 'src' || walk === 'scripts') return walk
  const m = WHOLE.exec(walk)
  return m ? (m[1] ?? '') : null
}

function readWatchGraph(root: string, tracked: string[], named: Map<string, string[]>) {
  const tree = treeOf(root, tracked)
  const memo = new Map<string, Facts>()
  const unread: string[] = []
  const factsAt = (rel: string): Facts => {
    let facts = memo.get(rel)
    if (facts) return facts
    try {
      if (rel.startsWith('src/')) facts = CODE.test(rel) ? sourceFacts(tree, rel) : blank()
      else if (CODE.test(rel)) facts = scriptFacts(tree, rel)
      else if (rel.endsWith('.sh')) facts = shellFacts(tree, rel, false)
      else if (rel.endsWith('.py')) facts = pythonFacts(tree, rel)
      else facts = blank()
    } catch (error) {
      unread.push(`${rel}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
      facts = blank()
    }
    memo.set(rel, facts)
    return facts
  }
  const reach = (start: string[], allowed: Set<EdgeKind>): Map<string, Step> => {
    const seen = new Map<string, Step>()
    for (const s of start) seen.set(s, { hops: 0, via: '', kind: 'import' })
    let frontier = [...start]
    for (let hops = 0; frontier.length > 0; hops++) {
      const next: string[] = []
      const spread = (fromSource: boolean): void => {
        for (let i = 0; i < frontier.length; i++) {
          const f = frontier[i]!
          if (f.startsWith('src/') !== fromSource || RUNNER.test(f)) continue
          for (const e of factsAt(f).edges) {
            if (!allowed.has(e.kind) || seen.has(e.to)) continue
            seen.set(e.to, { hops: fromSource ? hops + 1 : hops, via: f, kind: e.kind })
            ;(fromSource ? next : frontier).push(e.to)
          }
        }
      }
      spread(false)
      spread(true)
      frontier = next
    }
    return seen
  }
  const suites = census(root).suites.map(row => {
    const runner = `scripts/${row.suite}/run-all.sh`
    const executed = row.executed.map(slash).filter(f => tree.files.has(f))
    const eager = reach(executed, EAGER)
    const value = reach(executed, VALUE)
    const every = reach(executed, EVERY)
    const deps = new Map<string, Dep>()
    for (const f of executed) deps.set(f, { how: f.startsWith('scripts/lib/') ? 'runner' : 'member', hops: 0, via: runner })
    for (const [f, at] of eager) if (!deps.has(f)) deps.set(f, { how: at.kind === 'run' ? 'run' : 'import', hops: at.hops, via: at.via })
    for (const [f, at] of value) if (!deps.has(f)) deps.set(f, { how: 'lazy', hops: at.hops, via: at.via })
    const whole: Array<{ scope: string; via: string }> = []
    const naming: string[] = []
    const blind: Blind = { imports: 0, paths: 0, children: 0, git: 0 }
    const note = (f: string, how: How, via: string): void => {
      if (!deps.has(f)) deps.set(f, { how, hops: 0, via })
    }
    const read = (f: string, facts: Facts): void => {
      for (const name of [...facts.names, ...(named.get(f) ?? [])].sort()) if (tree.files.has(name)) note(name, f === runner ? 'runner' : 'text', f)
      for (const w of [...facts.walks].sort()) {
        const scope = wholeScope(w)
        if (scope !== null) whole.push({ scope, via: f })
        else if (w.includes('*')) for (const t of tree.list) if (globOf(w).match(t)) note(t, 'walk', f)
        else for (const t of tree.list) if (t.startsWith(`${w}/`)) note(t, 'walk', f)
      }
      if (facts.bundle) naming.push(f)
      blind.imports += facts.blind.imports
      blind.paths += facts.blind.paths
      blind.children += facts.blind.children
      blind.git += facts.blind.git
    }
    if (tree.files.has(runner)) read(runner, shellFacts(tree, runner, true))
    for (const f of [...value.keys()].sort()) if (!f.startsWith('src/')) read(f, factsAt(f))
    return { suite: row.suite, cls: row.cls, members: executed.filter(f => !f.startsWith('scripts/lib/')), deps, typed: every.size - value.size, naming, bundle: [] as string[], whole, blind }
  })
  const back = new Map<string, string[]>()
  for (const [from, facts] of memo) {
    for (const e of facts.edges) {
      if (!VALUE.has(e.kind)) continue
      const list = back.get(e.to)
      if (list) list.push(from)
      else back.set(e.to, [from])
    }
  }
  const roads = new Set<string>([...memo].filter(([, facts]) => facts.bundle).map(([f]) => f))
  const queue = [...roads]
  while (queue.length > 0) {
    for (const from of back.get(queue.pop()!) ?? []) {
      if (roads.has(from)) continue
      roads.add(from)
      queue.push(from)
    }
  }
  for (const s of suites) s.bundle = s.members.filter(f => roads.has(f))
  const parsed = [...memo.keys()]
  let edges = 0
  for (const facts of memo.values()) edges += facts.edges.length
  const targets = (rel: string): string[] => factsAt(rel).edges.map(e => e.to)
  return { suites, targets, unread: unread.sort(), edges, files: { src: parsed.filter(f => f.startsWith('src/')).length, other: parsed.filter(f => !f.startsWith('src/')).length } }
}

function walkedFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (UNLISTED.has(entry.name)) continue
      const rel = dir === '' ? entry.name : `${dir}/${entry.name}`
      if (entry.isDirectory()) walk(rel)
      else out.push(rel)
    }
  }
  walk('')
  return out.sort()
}

function listedFiles(root: string): string[] {
  let out = ''
  try {
    out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    out = ''
  }
  const files = [...new Set(out.split('\0').filter(Boolean))].sort()
  return files.length > 0 ? files : walkedFiles(root)
}

export function watchGraphOf(root: string) {
  const listed = listedFiles(root)
  const fence = factsOf(root, { scripts: listed.filter(f => f.startsWith('scripts/')), src: srcOf(listed), listed: true })
  const named = new Map<string, string[]>()
  let opened = 0
  let onlyNamed = 0
  for (const [script, facts] of fence.facts) {
    opened += facts.pins.size
    onlyNamed += facts.namesOnly.size
    if (facts.pins.size + facts.namesOnly.size > 0) named.set(script, [...facts.pins.keys(), ...facts.namesOnly.keys()])
  }
  return { ...readWatchGraph(root, listed, named), listed, fence: { opened, onlyNamed, scripts: named.size } }
}
