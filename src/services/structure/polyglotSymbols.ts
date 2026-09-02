// ============================================================================
//  polyglotSymbols — F2: document-symbol ADDRESSING over the
//  packaged grammar engine. The one job the estate could not do before:
//  select an edit target in a NON-JS/TS file by (kind, name) — no
//  syntax-exact metavariable pattern required.
//
//  v1 scope: python · go · rust, kinds
//  function · class · method, name matched exact-or-glob (*). Every other
//  engine language REFUSES BY NAME (pattern queries remain their lane) —
//  absent is stated, never guessed. Matches mint the SAME stable ids
//  (query.ts matchId), ride the SAME StructureMatch shape, and relocate
//  for preview/apply exactly like pattern matches: re-run the address in
//  current content, join by id — a changed file cannot reproduce them.
// ============================================================================
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { mintFileAnchor } from '../changeTransaction/snapshotAnchor.js'
import type { StructureMatch, StructureQuery, StructureQueryResult } from './contracts.js'
import {
  languageByName,
  loadGrammarEngine,
  parsePolyglot,
  type PolyglotLanguage,
  type TSNode,
} from './grammarFacility.js'
import { discoverPolyglotFiles, type RelocatedMatch } from './polyglotQuery.js'
import { matchId } from './query.js'

export type SymbolKind = 'function' | 'class' | 'method'

/** Per-language symbol tables: node types per kind + the child node types
 *  that carry the NAME token. `method` is contextual (see isMethodContext). */
const SYMBOL_TABLES: Record<
  string,
  {
    function: string[]
    class: string[]
    /** node types that OPEN a class-like scope (method context). */
    classScopes: string[]
    /** node types that carry methods directly (e.g. rust impl_item). */
    methodScopes: string[]
    nameTypes: string[]
  }
> = {
  python: {
    function: ['function_definition'],
    class: ['class_definition'],
    classScopes: ['class_definition'],
    methodScopes: [],
    nameTypes: ['identifier'],
  },
  go: {
    function: ['function_declaration'],
    class: ['type_declaration'],
    classScopes: [],
    methodScopes: [],
    nameTypes: ['identifier', 'type_identifier', 'field_identifier'],
  },
  rust: {
    function: ['function_item'],
    class: ['struct_item', 'enum_item', 'trait_item'],
    classScopes: [],
    methodScopes: ['impl_item', 'trait_item'],
    nameTypes: ['identifier', 'type_identifier', 'field_identifier'],
  },
}

/** go methods are their own node type — table-external special case. */
const GO_METHOD_TYPE = 'method_declaration'

export function symbolLaneSupports(langName: string): boolean {
  return langName in SYMBOL_TABLES
}

function globToRegExp(glob: string): RegExp {
  // Split on '*' FIRST, escape each literal part, rejoin with '.*' — no
  // sentinel byte anywhere (the Write-artifact class struck a raw NUL
  // into an earlier sentinel and made this whole FILE ratchet-invisible
  // binary; a sentinel also broke names containing the sentinel char).
  const parts = glob.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`^${parts.join('.*')}$`)
}

function nameOf(node: TSNode, table: (typeof SYMBOL_TABLES)[string]): string | null {
  // go type_declaration wraps type_spec — the name lives one level down.
  const carrier =
    node.type === 'type_declaration'
      ? (node.namedChildren.find(c => c.type === 'type_spec') ?? node)
      : node
  for (const child of carrier.namedChildren) {
    if (table.nameTypes.includes(child.type)) return child.text
  }
  return null
}

/** The NEAREST enclosing scope decides method-ness: a def nested inside a
 *  METHOD BODY is a local function (closure), never a method (closing
 *  verify-wave finding — the transitive ancestor scan classified locals as
 *  methods and made them unfindable as functions). */
function methodContext(node: TSNode, langName: string, table: (typeof SYMBOL_TABLES)[string]): boolean {
  for (let p = node.parent; p; p = p.parent) {
    if (table.function.includes(p.type) || (langName === 'go' && p.type === GO_METHOD_TYPE)) return false
    if (langName === 'python' && table.classScopes.includes(p.type)) return true
    if (langName === 'rust' && table.methodScopes.includes(p.type)) return true
  }
  return false
}

function kindOf(node: TSNode, langName: string, table: (typeof SYMBOL_TABLES)[string]): SymbolKind | null {
  if (langName === 'go' && node.type === GO_METHOD_TYPE) return 'method'
  if (table.function.includes(node.type)) {
    return methodContext(node, langName, table) ? 'method' : 'function'
  }
  if (table.class.includes(node.type)) return 'class'
  return null
}

interface SymbolHit {
  node: TSNode
  name: string
  kind: SymbolKind
}

function findSymbolNodes(root: TSNode, langName: string, kind: SymbolKind, nameRe: RegExp): SymbolHit[] {
  const table = SYMBOL_TABLES[langName]!
  const hits: SymbolHit[] = []
  const walk = (node: TSNode): void => {
    // go grouped `type (Alpha …; Beta …)`: address each type_spec
    // individually — the group node swallowed siblings (a remove of Alpha
    // silently deleted Beta) and only the FIRST name was findable (closing
    // verify-wave finding). A singleton group keeps the whole declaration
    // as the edit extent.
    if (langName === 'go' && node.type === 'type_declaration') {
      if (kind === 'class') {
        const specs = node.namedChildren.filter(c => c.type === 'type_spec')
        for (const spec of specs) {
          const nm = spec.namedChildren.find(c => table.nameTypes.includes(c.type))?.text
          if (nm && nameRe.test(nm)) {
            hits.push({ node: specs.length > 1 ? spec : node, name: nm, kind: 'class' })
          }
        }
      }
      for (const child of node.namedChildren) walk(child)
      return
    }
    const k = kindOf(node, langName, table)
    if (k === kind) {
      const name = nameOf(node, table)
      if (name && nameRe.test(name)) hits.push({ node, name, kind: k })
    }
    for (const child of node.namedChildren) walk(child)
  }
  walk(root)
  return hits
}

function toSymbolMatch(rel: string, lang: PolyglotLanguage, hit: SymbolHit, anchor: string): StructureMatch {
  const nodeText = hit.node.text
  const bounded = nodeText.length > 400 ? `${nodeText.slice(0, 400)}…` : nodeText
  return {
    id: matchId(rel, hit.node.startIndex, hit.node.endIndex, hit.node.type, nodeText),
    file: rel,
    range: {
      startLine: hit.node.startPosition.row + 1,
      startCol: hit.node.startPosition.column + 1,
      endLine: hit.node.endPosition.row + 1,
      endCol: hit.node.endPosition.column + 1,
    },
    kind: `${hit.kind}:${hit.node.type}`,
    text: bounded,
    context: `${lang.name} ${hit.kind} ${hit.name} — ${(nodeText.split('\n')[0] ?? '').trim().slice(0, 100)}`.slice(0, 200),
    anchor,
    language: lang.name,
  }
}

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const MAX_FILES_PARSED = 500

/** The symbol-lane query runner — mirrors runPolyglotQuery's honesty
 *  contract (per-file parse failures named, bounds named, never guessed). */
export async function runPolyglotSymbolQuery(
  root: string,
  query: StructureQuery,
  opts: { signal?: AbortSignal } = {},
): Promise<StructureQueryResult | { state: 'unavailable'; note: string }> {
  const started = Date.now()
  const symbol = query.symbol
  if (!symbol) return { state: 'unavailable', note: 'symbol query needs symbol {kind, name}' }
  const engine = await loadGrammarEngine()
  if (engine.state === 'unavailable') return engine

  const langFilter = query.lang ? languageByName(query.lang) : null
  if (query.lang && !langFilter) {
    return { state: 'unavailable', note: `unknown lang '${query.lang}'` }
  }
  if (langFilter && !symbolLaneSupports(langFilter.name)) {
    return {
      state: 'unavailable',
      note: `symbol addressing is not mapped for ${langFilter.name} (v1: python · go · rust) — use a pattern query`,
    }
  }

  const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
  const nameRe = globToRegExp(symbol.name)
  const { files, scanned, truncatedWalk } = discoverPolyglotFiles(root, query.files, langFilter)

  const matches: StructureMatch[] = []
  const parseFailures: { file: string; message: string }[] = []
  let parsed = 0
  let skippedUnmapped = 0
  let truncated = truncatedWalk

  for (const { rel, lang } of files) {
    if (opts.signal?.aborted) break
    if (matches.length >= limit) {
      truncated = true
      break
    }
    if (!symbolLaneSupports(lang.name)) {
      skippedUnmapped++
      continue
    }
    if (parsed >= MAX_FILES_PARSED) {
      truncated = true
      break
    }
    let text: string
    try {
      text = readFileSync(path.join(root, rel), 'utf8')
    } catch (err) {
      parseFailures.push({ file: rel, message: (err as Error).message })
      continue
    }
    const parsedFile = await parsePolyglot(engine, lang, text)
    if ('state' in parsedFile) {
      parseFailures.push({ file: rel, message: parsedFile.note })
      continue
    }
    parsed++
    if (parsedFile.parseErrors.length > 0) {
      parseFailures.push({ file: rel, message: `does not parse as ${lang.name} (${parsedFile.parseErrors[0]})` })
      parsedFile.tree.delete()
      continue
    }
    const anchor = mintFileAnchor(text)
    const hits = findSymbolNodes(parsedFile.tree.rootNode, lang.name, symbol.kind, nameRe)
    for (const hit of hits) {
      if (matches.length >= limit) {
        truncated = true
        break
      }
      matches.push(toSymbolMatch(rel, lang, hit, anchor))
    }
    parsedFile.tree.delete()
  }

  // Honesty (closing verify-wave finding): a scope that reached ONLY
  // unmapped-language files must refuse by name — an empty result here
  // would read as "no such symbol" (false absence, the guessed kind).
  if (matches.length === 0 && parsed === 0 && skippedUnmapped > 0) {
    return {
      state: 'unavailable',
      note: `symbol addressing is not mapped for the language(s) in scope (${skippedUnmapped} file(s) skipped; v1: python · go · rust) — use a pattern query`,
    }
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
    parseFailures,
    matches,
    truncated,
    elapsedMs: Date.now() - started,
  }
}

/** Re-locate symbol matches in ONE file's current content — the
 *  preview/apply relocation seam, joined by stable id exactly like the
 *  pattern lane. */
export async function relocateSymbolMatches(
  rel: string,
  text: string,
  query: StructureQuery,
): Promise<{ state: 'ok'; byId: Map<string, RelocatedMatch> } | { state: 'refused'; note: string }> {
  const symbol = query.symbol
  if (!symbol) return { state: 'refused', note: 'not a symbol query' }
  const engine = await loadGrammarEngine()
  if (engine.state === 'unavailable') return { state: 'refused', note: engine.note }
  const langOf = (await import('./grammarFacility.js')).languageForFile(rel)
  if (!langOf) return { state: 'refused', note: `${rel}: no engine grammar for this extension` }
  if (!symbolLaneSupports(langOf.name)) {
    return { state: 'refused', note: `${rel}: symbol addressing not mapped for ${langOf.name}` }
  }
  const parsedFile = await parsePolyglot(engine, langOf, text)
  if ('state' in parsedFile) return { state: 'refused', note: parsedFile.note }
  if (parsedFile.parseErrors.length > 0) {
    parsedFile.tree.delete()
    return { state: 'refused', note: `${rel}: does not parse as ${langOf.name} (${parsedFile.parseErrors[0]})` }
  }
  const anchor = mintFileAnchor(text)
  const hits = findSymbolNodes(parsedFile.tree.rootNode, langOf.name, symbol.kind, globToRegExp(symbol.name))
  const byId = new Map<string, RelocatedMatch>()
  for (const hit of hits) {
    const structure = toSymbolMatch(rel, langOf, hit, anchor)
    if (byId.has(structure.id)) continue
    byId.set(structure.id, {
      structure,
      startIndex: hit.node.startIndex,
      endIndex: hit.node.endIndex,
      nodeType: hit.node.type,
      nodeText: hit.node.text,
      captures: [],
    })
  }
  parsedFile.tree.delete()
  return { state: 'ok', byId }
}
