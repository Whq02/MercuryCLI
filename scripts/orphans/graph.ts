#!/usr/bin/env bun
// ============================================================================
//  scripts/orphans/graph.ts — the ONE src import-graph builder.
//
//  One-fact-one-authority: BOTH the no-orphans ratchet (prove-no-orphans.ts)
//  and the reachability manifest (gen-reachability-manifest.ts) consume THIS
//  graph — two walkers would be two reachability authorities.
//
//  Syntax-aware: edges come from the TypeScript
//  parser, not a regex over raw text — import declarations, `export … from`,
//  literal dynamic `import()`, bare `require()`, `import x = require()`, and
//  `typeof import()` type references. A regex walk also matched quoted
//  specifiers inside comments/strings (over-match) and could capture across
//  lines (the cross-line under-match class); the
//  parser sees exactly the real edges. The regex↔parser reached-set diff was
//  adjudicated empty at the landing.
//
//  Roots: the bundle entry + every entrypoints/ sibling + the SDK surface —
//  spawned/exposed surfaces are roots, not orphans. Build-injected package
//  redirects (build.ts stub map) resolve as edges so bundled-live files stay
//  reachable.
// ============================================================================

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import ts from 'typescript'

export const GRAPH_ROOT = join(import.meta.dir, '..', '..')
const SRC = join(GRAPH_ROOT, 'src')

export type EdgeKind =
  | 'static-import'
  | 'export-from'
  | 'dynamic-import'
  | 'require'
  | 'import-equals'
  | 'type-import'

export interface RawEdge {
  /** Absolute path of the importing file. */
  from: string
  /** The literal specifier as written. */
  spec: string
  kind: EdgeKind
  /** Absolute path of the resolved src file, or null (package import). */
  resolved: string | null
}

export interface ImportGraph {
  root: string
  /** Every src .ts/.tsx file (absolute, sorted). */
  files: string[]
  /** The root entrypoints (absolute). */
  entries: string[]
  /** Every extracted edge (literal specifiers only). */
  edges: RawEdge[]
  /** Files reachable from the entries over resolved edges. */
  reached: Set<string>
  /** build.ts package-specifier redirects into src. */
  stubMap: Record<string, string>
}

function* walkDir(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* walkDir(p)
    else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts')) yield p
  }
}

/** Package specifiers the BUILD redirects into src (build.ts stub-map rows of
 *  the form `'pkg': resolve(SRC, '<path>')`). */
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
  else return null // package import
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

/** Extract every literal module specifier in a source file, typed by form. */
export function extractSpecs(filePath: string, text: string): Array<{ spec: string; kind: EdgeKind }> {
  const out: Array<{ spec: string; kind: EdgeKind }> = []
  const sf = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.ES2022,
    /* setParentNodes */ false,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      if (ts.isStringLiteralLike(node.moduleSpecifier)) {
        out.push({ spec: node.moduleSpecifier.text, kind: 'static-import' })
      }
    } else if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
        out.push({ spec: node.moduleSpecifier.text, kind: 'export-from' })
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      const ref = node.moduleReference
      if (ts.isExternalModuleReference(ref) && ref.expression && ts.isStringLiteralLike(ref.expression)) {
        out.push({ spec: ref.expression.text, kind: 'import-equals' })
      }
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const a = node.arguments[0]
        if (a && ts.isStringLiteralLike(a)) out.push({ spec: a.text, kind: 'dynamic-import' })
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        const a = node.arguments[0]
        if (a && ts.isStringLiteralLike(a)) out.push({ spec: a.text, kind: 'require' })
      }
    } else if (ts.isImportTypeNode(node)) {
      const arg = node.argument
      if (ts.isLiteralTypeNode(arg) && ts.isStringLiteralLike(arg.literal)) {
        out.push({ spec: arg.literal.text, kind: 'type-import' })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

/** The root entrypoints: the bundle entry + entrypoints siblings + SDK. */
export function graphEntries(): string[] {
  const entries = [
    'src/entrypoints/cli.tsx',
    ...readdirSync(join(SRC, 'entrypoints'))
      .filter(f => f.endsWith('.ts') || f.endsWith('.tsx'))
      .map(f => `src/entrypoints/${f}`),
    ...(existsSync(join(SRC, 'entrypoints', 'sdk'))
      ? readdirSync(join(SRC, 'entrypoints', 'sdk'))
          .filter(f => f.endsWith('.ts'))
          .map(f => `src/entrypoints/sdk/${f}`)
      : []),
  ]
  return [...new Set(entries)].map(e => join(GRAPH_ROOT, e)).filter(p => existsSync(p))
}

/** Build the full graph: files, typed edges, and entry-reachability. */
export function buildImportGraph(): ImportGraph {
  const stubMap = readStubMap()
  const files = [...walkDir(SRC)].sort()
  const edges: RawEdge[] = []
  for (const f of files) {
    let text: string
    try {
      text = readFileSync(f, 'utf-8')
    } catch {
      continue
    }
    for (const { spec, kind } of extractSpecs(f, text)) {
      edges.push({ from: f, spec, kind, resolved: resolveSpec(f, spec, stubMap) })
    }
  }
  const byFrom = new Map<string, string[]>()
  for (const e of edges) {
    if (!e.resolved) continue
    const list = byFrom.get(e.from)
    if (list) list.push(e.resolved)
    else byFrom.set(e.from, [e.resolved])
  }
  const entries = graphEntries()
  const reached = new Set<string>(entries)
  const queue = [...entries]
  while (queue.length) {
    const f = queue.pop()!
    for (const target of byFrom.get(f) ?? []) {
      if (!reached.has(target)) {
        reached.add(target)
        queue.push(target)
      }
    }
  }
  return { root: GRAPH_ROOT, files, entries, edges, reached, stubMap }
}
