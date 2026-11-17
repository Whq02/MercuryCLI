#!/usr/bin/env bun

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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

function* walkDir(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* walkDir(p)
    else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts')) yield p
  }
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

export function extractSpecs(filePath: string, text: string): Array<{ spec: string; kind: EdgeKind; typeOnly: boolean }> {
  const out: Array<{ spec: string; kind: EdgeKind; typeOnly: boolean }> = []
  const sf = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.ES2022,
     false,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
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

export function readBuildEntrypoints(): string[] {
  const sf = ts.createSourceFile(BUILD, readFileSync(BUILD, 'utf-8'), ts.ScriptTarget.ES2022, false, ts.ScriptKind.TS)
  const bases: Record<string, string> = { ROOT: GRAPH_ROOT, SRC }
  const roots: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'entrypoints' &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      for (const el of node.initializer.elements) {
        const [base, path] = ts.isCallExpression(el) && ts.isIdentifier(el.expression) && el.expression.text === 'resolve' ? el.arguments : []
        if (!base || !path || !ts.isIdentifier(base) || !(base.text in bases) || !ts.isStringLiteralLike(path)) {
          const line = sf.getLineAndCharacterOfPosition(el.getStart(sf)).line + 1
          throw new Error(
            `build.ts:${line}: the reachability reader cannot read this entrypoint; write it as resolve(SRC, '<path>') or resolve(ROOT, '<path>') in build.ts, or teach readBuildEntrypoints in scripts/orphans/graph.ts the new form`,
          )
        }
        roots.push(join(bases[base.text]!, path.text))
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return [...new Set(roots)].filter(p => p.startsWith(SRC + '/') && existsSync(p)).sort()
}

export function readBuildRoots(): string[] {
  const roots = readBuildEntrypoints()
  for (const { spec } of extractSpecs(BUILD, readFileSync(BUILD, 'utf-8'))) {
    const resolved = resolveSpec(BUILD, spec, {})
    if (resolved && resolved.startsWith(SRC + '/')) roots.push(resolved)
  }
  return [...new Set(roots)].sort()
}

function graphEntries(buildRoots: string[]): string[] {
  const entries = [
    join(SRC, 'entrypoints', 'cli.tsx'),
    ...readdirSync(join(SRC, 'entrypoints'))
      .filter(f => f.endsWith('.ts') || f.endsWith('.tsx'))
      .map(f => join(SRC, 'entrypoints', f)),
    ...buildRoots,
  ]
  return [...new Set(entries)].filter(p => existsSync(p))
}

export function buildImportGraph(): ImportGraph {
  const stubMap = readStubMap()
  const files = [...walkDir(SRC)].sort()
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
    for (const { spec, kind, typeOnly } of extractSpecs(f, text)) {
      edges.push({ from: f, spec, kind, typeOnly, resolved: resolveSpec(f, spec, stubMap) })
    }
  }
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
  const entries = graphEntries(buildRoots)
  const { reached, codeBehindTypes } = reach(entries)
  return { root: GRAPH_ROOT, files, entries, buildRoots, edges, reached, codeBehindTypes, reachFrom: roots => reach(roots).reached, stubMap }
}
