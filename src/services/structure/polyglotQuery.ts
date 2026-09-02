// ============================================================================
//  structure/polyglotQuery — bounded deterministic PATTERN queries over the
//  packaged grammar engine. Mixed-language directory
//  scopes: language is inferred per file; files whose language the engine
//  does not ship are skipped (counted, never guessed); files that do not
//  parse are REPORTED per file and never matched over.
//
//  Determinism: sorted bounded walk (project ignore rules honored — the
//  root .gitignore's positive rules + the standard skip set), matches in
//  (file, position) order, explicit caps, truncation flagged.
// ============================================================================

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import * as path from 'node:path'
import { mintFileAnchor } from '../changeTransaction/snapshotAnchor.js'
import type { StructureMatch, StructureQuery, StructureQueryResult } from './contracts.js'
import {
  languageByName,
  languageForFile,
  loadGrammarEngine,
  parsePolyglot,
  type PolyglotLanguage,
  type TSNode,
} from './grammarFacility.js'
import {
  compilePatternRoot,
  encodePattern,
  findExactSpanNode,
  findPatternMatches,
  patternCandidates,
  type CompiledPattern,
  type PatternMatch,
} from './pattern.js'
import { matchId } from './query.js'

const MAX_FILES_SCANNED = 3000
const MAX_FILES_PARSED = 500
const MAX_MATCH_TEXT = 400
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const MAX_FILE_BYTES = 2_000_000

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
  'target',
])

// ── project ignore rules (bounded: the ROOT .gitignore's positive rules) ───

interface IgnoreRules {
  /** Directory basenames ignored anywhere ('dir/' rules). */
  dirs: Set<string>
  /** Root-anchored relative path prefixes ('/x' or 'a/b' rules). */
  anchored: string[]
  /** Extension suffixes ('*.log' rules). */
  suffixes: string[]
}

export function loadRootIgnoreRules(root: string): IgnoreRules {
  const rules: IgnoreRules = { dirs: new Set(), anchored: [], suffixes: [] }
  const file = path.join(root, '.gitignore')
  if (!existsSync(file)) return rules
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return rules
  }
  const lines = text.split('\n').slice(0, 500)
  // Bounded honesty: negation re-INCLUDES files a positive rule would hide,
  // and modeling it is out of scope — so a .gitignore that uses `!` at all
  // degrades these rules to the standard skip set (over-inclusion, the safe
  // direction for a QUERY surface: a tracked file must never turn invisible).
  if (lines.some(l => l.trim().startsWith('!'))) return rules
  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('*.') && !line.slice(2).includes('*') && !line.includes('/')) {
      rules.suffixes.push(line.slice(1))
      continue
    }
    if (line.includes('*')) continue
    const trimmed = line.replace(/\/+$/, '')
    if (!trimmed) continue
    if (line.endsWith('/') && !trimmed.includes('/')) {
      rules.dirs.add(trimmed)
    } else {
      rules.anchored.push(trimmed.replace(/^\//, ''))
    }
  }
  return rules
}

function ignoredByRules(rules: IgnoreRules, rel: string, isDir: boolean, basename: string): boolean {
  if (isDir && rules.dirs.has(basename)) return true
  for (const suffix of rules.suffixes) {
    if (!isDir && rel.endsWith(suffix)) return true
  }
  for (const anchor of rules.anchored) {
    if (rel === anchor || rel.startsWith(`${anchor}/`)) return true
  }
  return false
}

// ── discovery ───────────────────────────────────────────────────────────────

function globToRegExp(glob: string): RegExp {
  // '**/' spans zero-or-more directories; a remaining '**' (e.g. trailing
  // 'src/**') spans anything including '/'; a bare '*' never crosses '/'.
  const esc = (s: string): string => s.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '[^/]*')
  const parts = glob.split('**/').map(p => p.split('**').map(esc).join('.*'))
  return new RegExp(`^${parts.join('(?:.*/)?')}$`)
}

function matchesGlob(value: string, glob: string): boolean {
  if (!glob.includes('*')) return value === glob || value.startsWith(`${glob.replace(/\/$/, '')}/`)
  return globToRegExp(glob).test(value)
}

export function discoverPolyglotFiles(
  root: string,
  fileGlobs: string[] | undefined,
  langFilter: PolyglotLanguage | null,
): {
  files: Array<{ rel: string; lang: PolyglotLanguage }>
  scanned: number
  skippedUnsupported: number
  truncatedWalk: boolean
  /** Files skipped because no grammar routes their extension, counted per
   *  extension (the basename when there is none) — the honest "what was not
   *  searched" census the AstSearch/AstEdit tools report. */
  skippedNoGrammar: Map<string, number>
} {
  const rules = loadRootIgnoreRules(root)
  const files: Array<{ rel: string; lang: PolyglotLanguage }> = []
  const skippedNoGrammar = new Map<string, number>()
  let scanned = 0
  let skippedUnsupported = 0
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
      if (entry.startsWith('.')) continue
      const full = path.join(dir, entry)
      const rel = path.relative(root, full)
      let stat
      try {
        stat = statSync(full)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        if (SKIP_DIRS.has(entry)) continue
        if (ignoredByRules(rules, rel, true, entry)) continue
        walk(full)
      } else if (stat.isFile()) {
        scanned++
        if (scanned > MAX_FILES_SCANNED) {
          truncatedWalk = true
          return
        }
        if (ignoredByRules(rules, rel, false, entry)) continue
        if (globs && !globs.some(g => matchesGlob(rel, g))) continue
        const lang = languageForFile(entry)
        if (!lang) {
          const ext = path.extname(entry).toLowerCase() || entry
          skippedNoGrammar.set(ext, (skippedNoGrammar.get(ext) ?? 0) + 1)
          continue
        }
        if (langFilter && lang.name !== langFilter.name) {
          skippedUnsupported++
          continue
        }
        files.push({ rel, lang })
      }
    }
  }
  walk(root)
  files.sort((a, b) => a.rel.localeCompare(b.rel))
  return { files, scanned, skippedUnsupported, truncatedWalk, skippedNoGrammar }
}

// ── pattern query execution ─────────────────────────────────────────────────

export interface PolyglotQueryOptions {
  signal?: AbortSignal
}

/**
 * Compile the pattern PER LANGUAGE present in the scope (each language's own
 * grammar parses the pattern; a language where it does not parse is an
 * honest per-language refusal, not a silent zero).
 *
 * Candidates: the raw pattern text first (declarations are top-level
 * shaped), then the language's parse-context embeddings (statement/
 * expression patterns — a bare Go call outside a func misparses). The first
 * candidate whose WHOLE tree is error-free and holds an exact-span pattern
 * node wins; if none is fully clean, the first with a clean-WITHIN-SPAN
 * exact node is the recovery; otherwise the refusal carries the raw parse
 * error.
 */
export async function compileFor(
  engine: Awaited<ReturnType<typeof loadGrammarEngine>> & { state: 'ok' },
  lang: PolyglotLanguage,
  encoded: string,
  cache: Map<string, { pattern: CompiledPattern; hold: { delete(): void } } | { state: 'refused'; note: string }>,
): Promise<{ pattern: CompiledPattern; hold: { delete(): void } } | { state: 'refused'; note: string }> {
  const cached = cache.get(lang.name)
  if (cached) return cached

  let recovery: { pattern: CompiledPattern; hold: { delete(): void } } | null = null
  let firstError: string | null = null

  for (const candidate of patternCandidates(lang.name, encoded)) {
    const parsed = await parsePolyglot(engine, lang, candidate.text)
    if ('state' in parsed) {
      const refusal = { state: 'refused' as const, note: parsed.note }
      cache.set(lang.name, refusal)
      if (recovery) recovery.hold.delete()
      return refusal
    }
    // The candidate carries its own pattern span: the quoted-placeholder
    // spelling is longer than the bare encoding.
    const node = findExactSpanNode(parsed.tree.rootNode, candidate.offset, candidate.offset + candidate.length, candidate.text)
    if (!node) {
      firstError ??= parsed.parseErrors[0] ?? 'no single node spans the pattern'
      parsed.tree.delete()
      continue
    }
    if (parsed.parseErrors.length === 0) {
      if (recovery) recovery.hold.delete()
      const compiled = { pattern: compilePatternRoot(node), hold: parsed.tree }
      cache.set(lang.name, compiled)
      return compiled
    }
    firstError ??= parsed.parseErrors[0]!
    if (!recovery && !node.hasError) {
      recovery = { pattern: compilePatternRoot(node), hold: parsed.tree }
      continue
    }
    parsed.tree.delete()
  }

  if (recovery) {
    cache.set(lang.name, recovery)
    return recovery
  }
  const refusal = {
    state: 'refused' as const,
    note: `the pattern does not parse as ${lang.name} (${firstError ?? 'no parse'})`,
  }
  cache.set(lang.name, refusal)
  return refusal
}

export async function runPolyglotQuery(
  root: string,
  query: StructureQuery,
  opts: PolyglotQueryOptions = {},
): Promise<StructureQueryResult | { state: 'unavailable'; note: string }> {
  const started = Date.now()
  if (!query.pattern) return { state: 'unavailable', note: 'polyglot query needs pattern' }
  const engine = await loadGrammarEngine()
  if (engine.state === 'unavailable') return engine

  const langFilter = query.lang ? languageByName(query.lang) : null
  if (query.lang && !langFilter) {
    return {
      state: 'unavailable',
      note: `unknown lang '${query.lang}' — engine languages: ${['python', 'go', 'rust', 'javascript', 'typescript', 'tsx'].join(', ')} + more (see the tool prompt)`,
    }
  }

  const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
  const { files, scanned, truncatedWalk } = discoverPolyglotFiles(root, query.files, langFilter)
  const encoded = encodePattern(query.pattern)
  const compileCache = new Map<string, { pattern: CompiledPattern; hold: { delete(): void } } | { state: 'refused'; note: string }>()

  // Cheap pre-filter: the pattern's longest literal IDENTIFIER token (a
  // file that cannot contain it never parses). Identifiers cannot be split
  // by formatting; dotted paths CAN (`console\n .log`), so '.' is a
  // separator here — never part of a token. Metavariables excluded.
  const literalTokens = query.pattern
    .split(/\$\$\$[A-Z_][A-Z0-9_]*|\$\$\$|\$[A-Z_][A-Z0-9_]*/)
    .flatMap(part => part.split(/[^A-Za-z0-9_]+/))
    .filter(tok => tok.length >= 3)
    .sort((a, b) => b.length - a.length)
  const preToken = literalTokens[0] ?? null

  const matches: StructureMatch[] = []
  const parseFailures: { file: string; message: string }[] = []
  let parsed = 0
  let truncated = truncatedWalk

  for (const { rel, lang } of files) {
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
    if (text.length > MAX_FILE_BYTES) continue
    if (preToken && !text.includes(preToken)) continue

    const compiled = await compileFor(engine, lang, encoded, compileCache)
    if ('state' in compiled) {
      parseFailures.push({ file: rel, message: compiled.note })
      continue
    }
    parsed++
    const parsedFile = await parsePolyglot(engine, lang, text)
    if ('state' in parsedFile) {
      parseFailures.push({ file: rel, message: parsedFile.note })
      continue
    }
    if (parsedFile.parseErrors.length > 0) {
      parseFailures.push({ file: rel, message: `does not parse as ${lang.name}: ${parsedFile.parseErrors[0]}` })
      parsedFile.tree.delete()
      continue
    }
    const anchor = mintFileAnchor(text)
    const found = findPatternMatches(compiled.pattern, parsedFile.tree.rootNode, text, limit - matches.length + 1)
    for (const m of found.matches) {
      if (matches.length >= limit) {
        truncated = true
        break
      }
      matches.push(toStructureMatch(rel, lang, m, m.node, anchor))
    }
    if (found.capped) truncated = true
    parsedFile.tree.delete()
  }
  for (const entry of compileCache.values()) {
    if (!('state' in entry)) entry.hold.delete()
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

function toStructureMatch(
  rel: string,
  lang: PolyglotLanguage,
  m: PatternMatch,
  node: TSNode,
  anchor: string,
): StructureMatch {
  const nodeText = node.text
  const bounded = nodeText.length > MAX_MATCH_TEXT ? `${nodeText.slice(0, MAX_MATCH_TEXT)}…` : nodeText
  const captureNote = m.captures.length
    ? ` [${m.captures.map(c => `${c.key}=${c.text.split('\n')[0]!.slice(0, 30)}`).join(' ')}]`
    : ''
  return {
    id: matchId(rel, node.startIndex, node.endIndex, node.type, nodeText),
    file: rel,
    range: {
      startLine: node.startPosition.row + 1,
      startCol: node.startPosition.column + 1,
      endLine: node.endPosition.row + 1,
      endCol: node.endPosition.column + 1,
    },
    kind: node.type,
    text: bounded,
    context: `${lang.name} — ${(nodeText.split('\n')[0] ?? '').trim().slice(0, 120)}${captureNote}`.slice(0, 200),
    anchor,
    language: lang.name,
  }
}

/** A match re-located in current content, DETACHED from the WASM tree —
 *  the primitive fields the transform layer reads, safe after tree.delete(). */
export interface RelocatedMatch {
  structure: StructureMatch
  startIndex: number
  endIndex: number
  nodeType: string
  nodeText: string
  captures: PatternMatch['captures']
}

/**
 * Re-locate the matches of a pattern query in ONE file's current content —
 * the preview/apply re-location seam (stable ids re-derive from content, so
 * a changed file cannot reproduce them). Returns matches keyed by id.
 */
export async function relocatePatternMatches(
  rel: string,
  text: string,
  query: StructureQuery,
): Promise<{ state: 'ok'; byId: Map<string, RelocatedMatch> } | { state: 'refused'; note: string }> {
  if (!query.pattern) return { state: 'refused', note: 'not a pattern query' }
  const engine = await loadGrammarEngine()
  if (engine.state === 'unavailable') return { state: 'refused', note: engine.note }
  const lang = languageForFile(rel)
  if (!lang) return { state: 'refused', note: `${rel}: no engine grammar for this extension` }
  if (query.lang && lang.name !== query.lang) {
    return { state: 'refused', note: `${rel}: language ${lang.name} does not match the query lang ${query.lang}` }
  }
  const encoded = encodePattern(query.pattern)
  const compiled = await compileFor(engine, lang, encoded, new Map())
  if ('state' in compiled) return { state: 'refused', note: compiled.note }
  const parsedFile = await parsePolyglot(engine, lang, text)
  if ('state' in parsedFile) {
    compiled.hold.delete()
    return { state: 'refused', note: parsedFile.note }
  }
  if (parsedFile.parseErrors.length > 0) {
    parsedFile.tree.delete()
    compiled.hold.delete()
    return { state: 'refused', note: `${rel}: does not parse as ${lang.name} (${parsedFile.parseErrors[0]})` }
  }
  const anchor = mintFileAnchor(text)
  const found = findPatternMatches(compiled.pattern, parsedFile.tree.rootNode, text, MAX_LIMIT * 2)
  // Materialize BEFORE freeing the WASM tree — node reads after delete are UB.
  const byId = new Map<string, RelocatedMatch>()
  for (const m of found.matches) {
    const structure = toStructureMatch(rel, lang, m, m.node, anchor)
    if (byId.has(structure.id)) continue
    byId.set(structure.id, {
      structure,
      startIndex: m.node.startIndex,
      endIndex: m.node.endIndex,
      nodeType: m.node.type,
      nodeText: m.node.text,
      captures: m.captures,
    })
  }
  parsedFile.tree.delete()
  compiled.hold.delete()
  return { state: 'ok', byId }
}
