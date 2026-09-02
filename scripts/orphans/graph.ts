#!/usr/bin/env bun

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
  from: string
  spec: string
  kind: EdgeKind
  resolved: string | null
}

export interface ImportGraph {
  root: string
  files: string[]
  entries: string[]
  edges: RawEdge[]
  reached: Set<string>
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

export function extractSpecs(filePath: string, text: string): Array<{ spec: string; kind: EdgeKind }> {
  const out: Array<{ spec: string; kind: EdgeKind }> = []
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
