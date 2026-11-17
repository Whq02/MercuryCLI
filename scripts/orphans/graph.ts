#!/usr/bin/env bun

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import ts from 'typescript'

export const GRAPH_ROOT = join(import.meta.dir, '..', '..')
const SRC = join(GRAPH_ROOT, 'src')

type EdgeKind =
  | 'static-import'
  | 'export-from'
  | 'dynamic-import'
  | 'require'
  | 'import-equals'
  | 'type-import'
  | 'file-url'
  | 'sibling-name'
  | 'generated-from'

interface RawEdge {
  from: string
  spec: string
  kind: EdgeKind
  typeOnly: boolean
  resolved: string | null
}

interface ImportGraph {
  root: string
  files: string[]
  entries: string[]
  buildRoots: string[]
  edges: RawEdge[]
  reached: Set<string>
  codeBehindTypes: Map<string, string>
  reachFrom: (roots: string[]) => Set<string>
  stubMap: Record<string, string>
}

const CODE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/
const TYPESCRIPT_FILE = /\.(ts|tsx)$/

function* walkDir(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* walkDir(p)
    else if (CODE_FILE.test(e.name) && !e.name.endsWith('.d.ts')) yield p
  }
}

function scriptKindOf(filePath: string): ts.ScriptKind {
  if (filePath.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (filePath.endsWith('.jsx')) return ts.ScriptKind.JSX
  return /\.(js|mjs|cjs)$/.test(filePath) ? ts.ScriptKind.JS : ts.ScriptKind.TS
}

export function readStubMap(): Record<string, string> {
  const map: Record<string, string> = {}
  for (const m of readFileSync(join(GRAPH_ROOT, 'build.ts'), 'utf-8').matchAll(
    /'([^']+)':\s*resolve\(SRC,\s*'([^']+)'\)/g,
  )) {
    map[m[1]!] = join(SRC, m[2]!)
  }
  return map
}

export function resolveSpec(
  fromFile: string,
  spec: string,
  stubMap: Record<string, string>,
): string | null {
  let base: string
  if (spec.startsWith('src/')) base = join(GRAPH_ROOT, spec)
  else if (spec.startsWith('.')) base = resolve(dirname(fromFile), spec)
  else if (spec in stubMap) base = stubMap[spec]!
  else return null
  const candidates = [
    base,
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.js$/, '.tsx'),
    base.replace(/\.jsx$/, '.tsx'),
    base.replace(/\.jsx$/, '.ts'),
    base.replace(/\.mjs$/, '.mts'),
    base.replace(/\.cjs$/, '.cts'),
    base + '.ts',
    base + '.tsx',
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ]
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return c
  }
  return null
}

export function extractSpecs(filePath: string, text: string, siblings?: ReadonlySet<string>): Array<{ spec: string; kind: EdgeKind; typeOnly: boolean }> {
  const out: Array<{ spec: string; kind: EdgeKind; typeOnly: boolean }> = []
  const sf = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.ES2022,
     false,
    scriptKindOf(filePath),
  )
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      if (ts.isStringLiteralLike(node.moduleSpecifier)) {
        const clause = node.importClause
        const named = clause?.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : null
        const typeOnly = clause !== undefined && (clause.isTypeOnly || (clause.name === undefined && named !== null && named.length > 0 && named.every(e => e.isTypeOnly)))
        out.push({ spec: node.moduleSpecifier.text, kind: 'static-import', typeOnly })
      }
    } else if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
        const named = node.exportClause && ts.isNamedExports(node.exportClause) ? node.exportClause.elements : null
        const typeOnly = node.isTypeOnly || (named !== null && named.length > 0 && named.every(e => e.isTypeOnly))
        out.push({ spec: node.moduleSpecifier.text, kind: 'export-from', typeOnly })
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      const ref = node.moduleReference
      if (ts.isExternalModuleReference(ref) && ref.expression && ts.isStringLiteralLike(ref.expression)) {
        out.push({ spec: ref.expression.text, kind: 'import-equals', typeOnly: node.isTypeOnly })
      }
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const a = node.arguments[0]
        if (a && ts.isStringLiteralLike(a)) out.push({ spec: a.text, kind: 'dynamic-import', typeOnly: false })
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        const a = node.arguments[0]
        if (a && ts.isStringLiteralLike(a)) out.push({ spec: a.text, kind: 'require', typeOnly: false })
      }
    } else if (ts.isImportTypeNode(node)) {
      const arg = node.argument
      if (ts.isLiteralTypeNode(arg) && ts.isStringLiteralLike(arg.literal)) {
        out.push({ spec: arg.literal.text, kind: 'type-import', typeOnly: true })
      }
    } else if (ts.isNewExpression(node)) {
      const [target, base] = node.arguments ?? []
      if (ts.isIdentifier(node.expression) && node.expression.text === 'URL' && target && ts.isStringLiteralLike(target) && target.text.startsWith('.') && base && base.getText(sf) === 'import.meta.url') {
        out.push({ spec: target.text, kind: 'file-url', typeOnly: false })
      }
    } else if (siblings !== undefined && ts.isStringLiteralLike(node) && siblings.has(node.text)) {
      out.push({ spec: `./${node.text}`, kind: 'sibling-name', typeOnly: false })
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

export function carriesCode(filePath: string, text: string): boolean {
  const js = ts.transpileModule(text, {
    fileName: filePath,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.Preserve, isolatedModules: true, verbatimModuleSyntax: false, removeComments: true },
  }).outputText
  return js
    .split('\n')
    .map(line => line.trim())
    .some(line => line !== '' && line !== 'export {};' && !/^import\s/.test(line) && !/^export\s*\{[^}]*\}\s*from\s/.test(line) && !/^export\s*\*\s*from\s/.test(line))
}

const BUILD = join(GRAPH_ROOT, 'build.ts')
const GENERATED_ASSETS = join(GRAPH_ROOT, 'scripts', 'gate', 'generated-assets.tsv')
const TEACH = 'or teach readBuildEntrypoints in scripts/orphans/graph.ts the new form'

function propertyName(property: ts.ObjectLiteralElementLike): string | undefined {
  const name = property.name
  if (name === undefined) return undefined
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined
}

export function readBuildEntrypoints(): string[] {
  const sf = ts.createSourceFile(BUILD, readFileSync(BUILD, 'utf-8'), ts.ScriptTarget.ES2022, false, ts.ScriptKind.TS)
  const bases: Record<string, string> = { ROOT: GRAPH_ROOT, SRC }
  const roots: string[] = []
  let builds = 0
  const stop = (node: ts.Node, words: string): never => {
    throw new Error(`build.ts:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}: ${words}`)
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'Bun' && node.expression.name.text === 'build') {
      builds++
      const options = node.arguments[0]
      const property = options && ts.isObjectLiteralExpression(options) ? options.properties.find(p => propertyName(p) === 'entrypoints') : undefined
      if (property === undefined) {
        return stop(node, `the reachability reader cannot read this build's entrypoints; pass Bun.build an object literal that holds entrypoints: [resolve(SRC, '<path>')] in build.ts, ${TEACH}`)
      }
      if (!ts.isPropertyAssignment(property) || !ts.isArrayLiteralExpression(property.initializer)) {
        return stop(property, `the reachability reader cannot read this entrypoints list; write it where Bun.build is called as an array literal, entrypoints: [resolve(SRC, '<path>')], ${TEACH}`)
      }
      for (const el of property.initializer.elements) {
        const args = ts.isCallExpression(el) && ts.isIdentifier(el.expression) && el.expression.text === 'resolve' ? el.arguments : undefined
        const [base, path] = args !== undefined && args.length === 2 ? args : []
        if (!base || !path || !ts.isIdentifier(base) || !(base.text in bases) || !ts.isStringLiteralLike(path)) {
          return stop(el, `the reachability reader cannot read this entrypoint; write it as resolve(SRC, '<path>') or resolve(ROOT, '<path>') in build.ts, ${TEACH}`)
        }
        const file = join(bases[base.text]!, path.text)
        if (!file.startsWith(SRC + '/') || !existsSync(file) || !statSync(file).isFile()) {
          return stop(el, `this entrypoint names no file under src (${file.slice(GRAPH_ROOT.length + 1)}); name the file the build bundles, or take the build out of build.ts`)
        }
        roots.push(file)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  if (builds === 0) throw new Error(`build.ts: the reachability reader found no Bun.build call, so nothing under src has a root; call Bun.build({ entrypoints: [resolve(SRC, '<path>')] }) in build.ts, ${TEACH}`)
  return [...new Set(roots)].sort()
}

export function readBuildRoots(): string[] {
  const roots = readBuildEntrypoints()
  for (const { spec } of extractSpecs(BUILD, readFileSync(BUILD, 'utf-8'))) {
    const resolved = resolveSpec(BUILD, spec, {})
    if (resolved && resolved.startsWith(SRC + '/')) roots.push(resolved)
  }
  return [...new Set(roots)].sort()
}

function generatedSourceEdges(files: string[]): RawEdge[] {
  if (!existsSync(GENERATED_ASSETS)) return []
  const rel = (file: string): string => file.slice(GRAPH_ROOT.length + 1)
  const edges: RawEdge[] = []
  for (const line of readFileSync(GENERATED_ASSETS, 'utf-8').split('\n')) {
    if (line.trim() === '' || line.startsWith('#')) continue
    const columns = line.split('\t')
    const assets = (columns[0] ?? '').split(/\s+/).filter(Boolean).map(glob => new Bun.Glob(glob))
    const sources = (columns[3] ?? '').split(/\s+/).filter(Boolean)
    const built = files.filter(file => assets.some(glob => glob.match(rel(file))))
    if (built.length === 0) continue
    for (const source of sources) {
      const glob = new Bun.Glob(source)
      for (const file of files) {
        if (!glob.match(rel(file))) continue
        for (const asset of built) if (asset !== file) edges.push({ from: asset, spec: source, kind: 'generated-from', typeOnly: false, resolved: file })
      }
    }
  }
  return edges
}

export function buildImportGraph(): ImportGraph {
  const stubMap = readStubMap()
  const files = [...walkDir(SRC)].sort()
  const loose = new Map<string, Set<string>>()
  for (const f of files) {
    if (TYPESCRIPT_FILE.test(f)) continue
    const names = loose.get(dirname(f))
    if (names) names.add(basename(f))
    else loose.set(dirname(f), new Set([basename(f)]))
  }
  const texts = new Map<string, string>()
  const edges: RawEdge[] = []
  for (const f of files) {
    let text: string
    try {
      text = readFileSync(f, 'utf-8')
    } catch {
      continue
    }
    texts.set(f, text)
    for (const { spec, kind, typeOnly } of extractSpecs(f, text, loose.get(dirname(f)))) {
      edges.push({ from: f, spec, kind, typeOnly, resolved: resolveSpec(f, spec, stubMap) })
    }
  }
  edges.push(...generatedSourceEdges(files))
  const valueFrom = new Map<string, string[]>()
  const anyFrom = new Map<string, string[]>()
  const add = (map: Map<string, string[]>, from: string, to: string): void => {
    const list = map.get(from)
    if (list) list.push(to)
    else map.set(from, [to])
  }
  for (const e of edges) {
    if (!e.resolved) continue
    add(anyFrom, e.from, e.resolved)
    if (!e.typeOnly) add(valueFrom, e.from, e.resolved)
  }
  const code = new Map<string, boolean>()
  const runs = (f: string): boolean => {
    const text = texts.get(f)
    if (text === undefined) return false
    let known = code.get(f)
    if (known === undefined) {
      known = carriesCode(f, text)
      code.set(f, known)
    }
    return known
  }
  const reach = (roots: string[]): { reached: Set<string>; codeBehindTypes: Map<string, string> } => {
    const value = new Set<string>(roots)
    const queue = [...roots]
    while (queue.length) {
      const f = queue.pop()!
      for (const target of valueFrom.get(f) ?? []) {
        if (!value.has(target)) {
          value.add(target)
          queue.push(target)
        }
      }
    }
    const typed = new Map<string, string>()
    const typeQueue = [...value]
    while (typeQueue.length) {
      const f = typeQueue.pop()!
      for (const target of anyFrom.get(f) ?? []) {
        if (value.has(target) || typed.has(target)) continue
        typed.set(target, f)
        typeQueue.push(target)
      }
    }
    const reached = new Set<string>(value)
    const codeBehindTypes = new Map<string, string>()
    for (const [target, importer] of typed) {
      if (runs(target)) codeBehindTypes.set(target, importer)
      else reached.add(target)
    }
    return { reached, codeBehindTypes }
  }
  const buildRoots = readBuildRoots()
  const entries = buildRoots
  const { reached, codeBehindTypes } = reach(entries)
  return { root: GRAPH_ROOT, files, entries, buildRoots, edges, reached, codeBehindTypes, reachFrom: roots => reach(roots).reached, stubMap }
}
