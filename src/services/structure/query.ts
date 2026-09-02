// ============================================================================
//  structure/query — bounded deterministic structural queries (
// One pass: bounded sorted file walk → cheap text pre-filter →
//  parse (parse failures REPORTED, never guessed over) → AST match →
//  stable content-derived match ids.
//
//  Determinism: files visited in sorted order, matches emitted in
//  (file, position) order, bounds explicit (scanned/parsed caps + limit),
//  truncation flagged — never silent.
// ============================================================================

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import * as path from 'node:path'
import type * as TS from 'typescript'
import { mintFileAnchor } from '../changeTransaction/snapshotAnchor.js'
import type {
  StructureMatch,
  StructureQuery,
  StructureQueryResult,
  StructureRange,
} from './contracts.js'
import {
  isSupportedSourceFile,
  loadTs,
  parseSource,
  resolveStructureTypescript,
  type TsModule,
} from './tsFacility.js'

const MAX_FILES_SCANNED = 3000
const MAX_FILES_PARSED = 500
const MAX_MATCH_TEXT = 400
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.cache',
  'vendor',
])

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`)
}

function matchesGlob(value: string, glob: string): boolean {
  if (!glob.includes('*')) return value === glob
  return globToRegExp(glob).test(value)
}

/** Sorted bounded walk. Returns project-root-relative paths. */
export function discoverSourceFiles(
  root: string,
  fileGlobs: string[] | undefined,
): { files: string[]; scanned: number; truncatedWalk: boolean } {
  const files: string[] = []
  let scanned = 0
  let truncatedWalk = false
  const globs = fileGlobs?.map(g => g.replace(/^\.\//, ''))

  function walk(dir: string): void {
    if (truncatedWalk) return
    let entries: string[]
    try {
      entries = readdirSync(dir).sort()
    } catch {
      return
    }
    for (const entry of entries) {
      if (truncatedWalk) return
      if (entry.startsWith('.') && entry !== '.') continue
      const full = path.join(dir, entry)
      let stat
      try {
        stat = statSync(full)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        if (SKIP_DIRS.has(entry)) continue
        walk(full)
      } else if (stat.isFile()) {
        scanned++
        if (scanned > MAX_FILES_SCANNED) {
          truncatedWalk = true
          return
        }
        if (!isSupportedSourceFile(entry)) continue
        const rel = path.relative(root, full)
        if (globs && !globs.some(g => matchesGlob(rel, g))) continue
        files.push(rel)
      }
    }
  }
  walk(root)
  files.sort()
  return { files, scanned, truncatedWalk }
}

/** Cheap text pre-filter: a file that cannot contain the filtered token
 *  never gets parsed. Conservative — wildcard-bearing filters skip it. */
function preFilterToken(query: StructureQuery): string | null {
  for (const candidate of [query.name, query.callee, query.module, query.value]) {
    if (!candidate) continue
    const literalHead = candidate.split('*')[0]
    if (literalHead && literalHead.length >= 3) return literalHead
  }
  return null
}

function nodeName(ts: TsModule, node: TS.Node): string | null {
  const named = node as { name?: TS.Node }
  if (!named.name) return null
  try {
    if (ts.isIdentifier(named.name as TS.Node) || ts.isStringLiteral(named.name as TS.Node)) {
      return (named.name as TS.Identifier).text
    }
    return (named.name as TS.Node).getText()
  } catch {
    return null
  }
}

function hasExportModifier(ts: TsModule, node: TS.Node): boolean {
  const mods = (node as { modifiers?: readonly TS.Node[] }).modifiers
  return mods?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) ?? false
}

function isFunctionLikeVariable(ts: TsModule, node: TS.Node): node is TS.VariableDeclaration {
  if (!ts.isVariableDeclaration(node)) return false
  const init = node.initializer
  return init !== undefined && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
}

/** Does `node` match the query's select + filters? Returns the display name. */
function matchNode(
  ts: TsModule,
  node: TS.Node,
  query: StructureQuery,
): { matched: boolean; name?: string } {
  const q = query
  // Pattern queries ride the polyglot lane (polyglotQuery.ts), never this
  // select-vocabulary matcher.
  if (!q.select) return { matched: false }
  const nameOk = (n: string | null): boolean => (q.name ? n !== null && matchesGlob(n, q.name) : true)

  switch (q.select) {
    case 'function': {
      if (ts.isFunctionDeclaration(node)) {
        const n = nodeName(ts, node)
        return { matched: nameOk(n), name: n ?? undefined }
      }
      if (isFunctionLikeVariable(ts, node)) {
        const n = nodeName(ts, node)
        return { matched: nameOk(n), name: n ?? undefined }
      }
      return { matched: false }
    }
    case 'class': {
      if (!ts.isClassDeclaration(node) && !ts.isClassExpression(node)) return { matched: false }
      const n = nodeName(ts, node)
      return { matched: nameOk(n), name: n ?? undefined }
    }
    case 'interface': {
      if (!ts.isInterfaceDeclaration(node)) return { matched: false }
      const n = nodeName(ts, node)
      return { matched: nameOk(n), name: n ?? undefined }
    }
    case 'type-alias': {
      if (!ts.isTypeAliasDeclaration(node)) return { matched: false }
      const n = nodeName(ts, node)
      return { matched: nameOk(n), name: n ?? undefined }
    }
    case 'enum': {
      if (!ts.isEnumDeclaration(node)) return { matched: false }
      const n = nodeName(ts, node)
      return { matched: nameOk(n), name: n ?? undefined }
    }
    case 'method': {
      if (!ts.isMethodDeclaration(node)) return { matched: false }
      const n = nodeName(ts, node)
      return { matched: nameOk(n), name: n ?? undefined }
    }
    case 'variable': {
      if (!ts.isVariableDeclaration(node)) return { matched: false }
      const n = nodeName(ts, node)
      return { matched: nameOk(n), name: n ?? undefined }
    }
    case 'call': {
      if (!ts.isCallExpression(node)) return { matched: false }
      let calleeText: string
      try {
        calleeText = node.expression.getText()
      } catch {
        return { matched: false }
      }
      if (q.callee && !matchesGlob(calleeText, q.callee)) return { matched: false }
      if (q.name && !matchesGlob(calleeText, q.name)) return { matched: false }
      return { matched: true, name: calleeText }
    }
    case 'import': {
      if (!ts.isImportDeclaration(node)) return { matched: false }
      const spec = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : ''
      if (q.module && !matchesGlob(spec, q.module)) return { matched: false }
      if (q.name) {
        const clause = node.importClause
        const names: string[] = []
        if (clause?.name) names.push(clause.name.text)
        const bindings = clause?.namedBindings
        if (bindings && ts.isNamedImports(bindings)) {
          for (const el of bindings.elements) names.push(el.name.text)
        }
        if (bindings && ts.isNamespaceImport(bindings)) names.push(bindings.name.text)
        if (!names.some(n => matchesGlob(n, q.name!))) return { matched: false }
      }
      return { matched: true, name: spec }
    }
    case 'export': {
      if (ts.isExportDeclaration(node)) {
        const spec =
          node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
            ? node.moduleSpecifier.text
            : ''
        if (q.module && !matchesGlob(spec, q.module)) return { matched: false }
        if (q.name) {
          const names: string[] = []
          if (node.exportClause && ts.isNamedExports(node.exportClause)) {
            for (const el of node.exportClause.elements) names.push(el.name.text)
          }
          if (!names.some(n => matchesGlob(n, q.name!))) return { matched: false }
        }
        return { matched: true, name: spec || undefined }
      }
      if (ts.isExportAssignment(node)) {
        return { matched: !q.name || matchesGlob('default', q.name), name: 'default' }
      }
      if (hasExportModifier(ts, node)) {
        // export const/function/class/interface/type — name filter applies.
        const n = nodeName(ts, node) ?? (ts.isVariableStatement(node) ? null : null)
        if (ts.isVariableStatement(node)) {
          const names = node.declarationList.declarations
            .map(d => nodeName(ts, d))
            .filter((x): x is string => x !== null)
          if (q.name && !names.some(x => matchesGlob(x, q.name!))) return { matched: false }
          return { matched: true, name: names.join(', ') }
        }
        return { matched: nameOk(n), name: n ?? undefined }
      }
      return { matched: false }
    }
    case 'property': {
      if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
        const n = nodeName(ts, node)
        return { matched: nameOk(n), name: n ?? undefined }
      }
      return { matched: false }
    }
    case 'string': {
      if (!ts.isStringLiteral(node) && !ts.isNoSubstitutionTemplateLiteral(node)) {
        return { matched: false }
      }
      const text = (node as TS.StringLiteral).text
      if (q.value && !text.includes(q.value)) return { matched: false }
      if (q.name && !matchesGlob(text, q.name)) return { matched: false }
      return { matched: true, name: text.slice(0, 40) }
    }
    case 'jsx-element': {
      let tag: string | null = null
      if (ts.isJsxElement(node)) tag = node.openingElement.tagName.getText()
      else if (ts.isJsxSelfClosingElement(node)) tag = node.tagName.getText()
      if (tag === null) return { matched: false }
      return { matched: nameOk(tag), name: tag }
    }
  }
}

/** Ancestor constraint: 'class:Name' · 'function:name' · a bare kind. */
function withinOk(ts: TsModule, node: TS.Node, within: string | undefined): boolean {
  if (!within) return true
  const [kindRaw, nameRaw] = within.includes(':')
    ? [within.slice(0, within.indexOf(':')), within.slice(within.indexOf(':') + 1)]
    : [within, undefined]
  let cur: TS.Node | undefined = node.parent
  while (cur) {
    let hit = false
    let curName: string | null = null
    switch (kindRaw) {
      case 'class':
        hit = ts.isClassDeclaration(cur) || ts.isClassExpression(cur)
        break
      case 'function':
        hit =
          ts.isFunctionDeclaration(cur) ||
          ts.isMethodDeclaration(cur) ||
          ts.isArrowFunction(cur) ||
          ts.isFunctionExpression(cur)
        break
      case 'interface':
        hit = ts.isInterfaceDeclaration(cur)
        break
      default:
        hit = false
    }
    if (hit) {
      if (!nameRaw) return true
      curName = nodeName(ts, cur)
      if (curName === null && (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur))) {
        // named via the enclosing variable declaration
        const parent = cur.parent
        if (parent && ts.isVariableDeclaration(parent)) curName = nodeName(ts, parent)
      }
      if (curName !== null && matchesGlob(curName, nameRaw)) return true
    }
    cur = cur.parent
  }
  return false
}

function rangeOf(sourceFile: TS.SourceFile, start: number, end: number): StructureRange {
  const s = sourceFile.getLineAndCharacterOfPosition(start)
  const e = sourceFile.getLineAndCharacterOfPosition(end)
  return {
    startLine: s.line + 1,
    startCol: s.character + 1,
    endLine: e.line + 1,
    endCol: e.character + 1,
  }
}

export function matchId(relFile: string, start: number, end: number, kind: string, text: string): string {
  return `sm-${createHash('sha1')
    .update(`${relFile}:${start}:${end}:${kind}:${text.slice(0, 200)}`)
    .digest('hex')
    .slice(0, 12)}`
}

/**
 * Walk one parsed file, calling `cb` for every query match WITH its AST
 * node — the shared engine under runStructureQuery (ranges only) and the
 * preview builder (needs nodes to compute edits). Deterministic document
 * order; the caller owns bounds.
 */
export function forEachQueryMatch(
  ts: TsModule,
  sourceFile: TS.SourceFile,
  text: string,
  rel: string,
  query: StructureQuery,
  cb: (match: StructureMatch, node: TS.Node) => void,
): void {
  const anchor = mintFileAnchor(text)
  const visit = (node: TS.Node): void => {
    const { matched, name } = matchNode(ts, node, query)
    if (matched && withinOk(ts, node, query.within)) {
      const start = node.getStart(sourceFile)
      const end = node.getEnd()
      let nodeText: string
      try {
        nodeText = node.getText(sourceFile)
      } catch {
        nodeText = text.slice(start, end)
      }
      const bounded =
        nodeText.length > MAX_MATCH_TEXT ? `${nodeText.slice(0, MAX_MATCH_TEXT)}…` : nodeText
      cb(
        {
          id: matchId(rel, start, end, ts.SyntaxKind[node.kind]!, nodeText),
          file: rel,
          range: rangeOf(sourceFile, start, end),
          kind: ts.SyntaxKind[node.kind]!,
          text: bounded,
          context: `${name ? `${name} — ` : ''}${(nodeText.split('\n')[0] ?? '').trim().slice(0, 160)}`,
          anchor,
        },
        node,
      )
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
}

export interface RunQueryOptions {
  signal?: AbortSignal
}

export function runStructureQuery(
  root: string,
  query: StructureQuery,
  opts: RunQueryOptions = {},
): StructureQueryResult | { state: 'unavailable'; note: string } {
  const started = Date.now()
  const resolution = resolveStructureTypescript(root)
  if (resolution.state === 'unavailable') return resolution
  const ts = loadTs(resolution.modulePath)

  const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
  const { files, scanned, truncatedWalk } = discoverSourceFiles(root, query.files)
  const preToken = preFilterToken(query)

  const matches: StructureMatch[] = []
  const parseFailures: { file: string; message: string }[] = []
  let parsed = 0
  let truncated = truncatedWalk

  for (const rel of files) {
    if (opts.signal?.aborted) break
    if (matches.length >= limit) {
      truncated = true
      break
    }
    if (parsed >= MAX_FILES_PARSED) {
      truncated = true
      break
    }
    const full = path.join(root, rel)
    let text: string
    try {
      text = readFileSync(full, 'utf8')
    } catch {
      continue
    }
    if (text.length > 2_000_000) continue // bounded: no multi-MB parse
    if (preToken && !text.includes(preToken)) continue
    parsed++
    const { sourceFile, parseErrors } = parseSource(ts, full, text)
    if (parseErrors.length > 0) {
      parseFailures.push({ file: rel, message: parseErrors[0]! })
      continue
    }
    forEachQueryMatch(ts, sourceFile, text, rel, query, match => {
      if (matches.length >= limit) return
      matches.push(match)
    })
  }

  const queryHash = createHash('sha1')
    .update(JSON.stringify({ query, root: path.basename(root) }))
    .digest('hex')
    .slice(0, 10)

  return {
    id: `sq-${queryHash}`,
    query,
    root,
    scanned,
    parsed,
    parseFailures: parseFailures.slice(0, 10),
    matches,
    truncated,
    elapsedMs: Date.now() - started,
  }
}
