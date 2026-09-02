// ============================================================================
//  structure/pattern — the metavariable pattern lane.
//  ast-grep-compatible pattern grammar over tree-sitter trees:
//
//    $NAME   — capture exactly ONE named AST node
//    $_      — match one named node without binding
//    $$$NAME — capture ZERO OR MORE sibling nodes (lazy)
//    $$$     — match zero or more siblings without binding
//
//  Compilation: metavariables are encoded as identifier-shaped placeholders,
//  the pattern text is parsed with the TARGET language's own grammar, and
//  the wrapper chain (module/program/source_file/expression_statement…) is
//  unwrapped to the significant node. A pattern that does not parse REFUSES
//  with the parser's own location — never a silent zero-match.
//
//  Matching (smart strictness, an honest approximation of ast-grep's):
//  node types must agree; named children are matched as ordered lists with
//  multi-metavariable sequence support; leaves compare exact text; a
//  metavariable reused twice must capture identical text. Comments in the
//  code tree are skipped.
//
//  Rewrite: `out` templates substitute captures ($NAME → the captured
//  node's source text · $$$NAME → the exact source span of the captured
//  sequence). Unknown $NAMEs in `out` refuse at compile time.
// ============================================================================

import type { TSNode } from './grammarFacility.js'

// ── metavariable encoding ───────────────────────────────────────────────────

const MV_SINGLE = /^__MV_([A-Za-z0-9_]*?)__$/
const MV_MULTI = /^__MVM_([A-Za-z0-9_]*?)__$/

/** `$$$NAME` / `$$$` / `$NAME` / `$_` → identifier-shaped placeholders.
 *  Boundary-guarded: `$$$foo` (lowercase) and `$$X` are NOT metavariables —
 *  they stay literal rather than half-encoding into unmatchable text. */
export function encodePattern(pattern: string): string {
  return pattern
    .replace(/\$\$\$([A-Z_][A-Z0-9_]*)?(?![A-Za-z0-9_$])/g, (_m, name: string | undefined) => `__MVM_${name ?? 'ANON'}__`)
    .replace(/(?<!\$)\$([A-Z_][A-Z0-9_]*)/g, (_m, name: string) => `__MV_${name === '_' ? 'ANON' : name}__`)
}

export interface MetavarInfo {
  kind: 'single' | 'multi'
  /** null = anonymous (no binding). */
  name: string | null
}

/** A placeholder the quoted-encoding candidate wrapped in string quotes —
 *  the value-position spelling for grammars where a bare identifier is not
 *  a value (JSON, TOML, YAML-class): the string node IS the metavariable. */
const MV_QUOTED = /^(["'`])(__MVM?_[A-Za-z0-9_]*?__)\1$/

/** Is this pattern node (or a pure wrapper around it) a metavariable? */
export function metavarOf(node: TSNode): MetavarInfo | null {
  let text = node.text.trim()
  const quoted = MV_QUOTED.exec(text)
  if (quoted) text = quoted[2]!
  const single = MV_SINGLE.exec(text)
  if (single) return { kind: 'single', name: single[1] === 'ANON' || single[1] === '' ? null : single[1]! }
  const multi = MV_MULTI.exec(text)
  if (multi) return { kind: 'multi', name: multi[1] === 'ANON' || multi[1] === '' ? null : multi[1]! }
  return null
}

// ── pattern compilation ─────────────────────────────────────────────────────

export interface CompiledPattern {
  /** The significant pattern node (tree retained by the caller). */
  root: TSNode
  /** Named captures the pattern binds ($X and $$$XS). */
  captureNames: string[]
}

/**
 * Parse-context templates per language: a bare expression/statement pattern
 * is not always a valid TOP-LEVEL construct (a Go call outside a func
 * misparses as a type conversion; a PHP snippet without `<?php` is HTML).
 * Each candidate embeds the pattern at `<P>`; the compiler picks the first
 * candidate whose WHOLE tree parses clean and contains an exact-span
 * pattern node (raw text is always tried first — declarations stay
 * top-level-shaped).
 */
export const PATTERN_CONTEXTS: Record<string, string[]> = {
  python: [],
  go: ['package mercury_ctx\n\nfunc mercuryCtx() {\n<P>\n}'],
  rust: ['fn mercury_ctx() {\n<P>\n}'],
  javascript: ['function mercuryCtx() {\n<P>\n}', 'class MercuryCtx {\n<P>\n}'],
  typescript: ['function mercuryCtx() {\n<P>\n}', 'class MercuryCtx {\n<P>\n}'],
  tsx: ['function mercuryCtx() {\n<P>\n}', 'class MercuryCtx {\n<P>\n}'],
  java: ['class MercuryCtx { void mercuryCtx() {\n<P>\n} }', 'class MercuryCtx {\n<P>\n}'],
  'c-sharp': ['class MercuryCtx { void MercuryFn() {\n<P>\n} }', 'class MercuryCtx {\n<P>\n}'],
  cpp: ['void mercury_ctx() {\n<P>\n}'],
  c: ['void mercury_ctx() {\n<P>\n}'],
  ruby: ['def mercury_ctx\n<P>\nend'],
  php: ['<?php\n<P>\n'],
  bash: [],
  css: [],
  // A bare `key = value` setting is not valid top-level ini (settings live
  // under a section header, and the grammar wants a trailing newline).
  ini: ['[mercury_ctx]\n<P>\n'],
}

/**
 * Languages whose RAW candidate must come LAST: a php snippet without
 * `<?php` parses "clean" as inline HTML text, and a bare C call at the top
 * level parses "clean" as a function DECLARATION — the raw candidate would
 * always win with a node that can never match the code the model means.
 */
const RAW_CANDIDATE_LAST = new Set(['php', 'c'])

/**
 * Statement-terminated grammars: an expression pattern the model writes
 * without its `;` (`printf($X)`, `foo($X)`) is offered a `;`-terminated
 * candidate too, so the statement parses clean and the exact-span node is
 * the expression the model meant. The pattern text itself is never changed
 * — the appended terminator sits OUTSIDE the matched span.
 */
const STATEMENT_TERMINATED = new Set(['c', 'cpp', 'c-sharp', 'java', 'php', 'rust', 'javascript', 'typescript', 'tsx', 'go', 'css'])

/** `__MV_X__` → `"__MV_X__"` — the value-position spelling (see MV_QUOTED). */
function quotePlaceholders(encoded: string): string {
  return encoded.replace(/__MVM?_[A-Za-z0-9_]*?__/g, m => `"${m}"`)
}

/**
 * Every embedding candidate for a language, raw text first (except the
 * RAW_CANDIDATE_LAST languages, where the raw parse is a false positive),
 * each followed by its `;`-terminated form where the grammar wants one,
 * then the whole set again with quoted placeholders (the value-position
 * spelling) — the compiler takes the first that parses clean.
 */
export interface PatternCandidate {
  text: string
  /** Where the pattern's own text starts inside `text`. */
  offset: number
  /** The pattern's own length inside `text` (the quoted spelling is longer
   *  than the bare encoding — the exact-span search must use THIS). */
  length: number
}

export function patternCandidates(langName: string, encoded: string): PatternCandidate[] {
  const trimmed = encoded.trim()
  const bare = candidatesFor(langName, trimmed)
  const quoted = /__MVM?_[A-Za-z0-9_]*?__/.test(trimmed) ? candidatesFor(langName, quotePlaceholders(trimmed)) : []
  return [...bare, ...quoted]
}

function candidatesFor(langName: string, trimmed: string): PatternCandidate[] {
  const withTerminator = (c: PatternCandidate): PatternCandidate[] => {
    if (!STATEMENT_TERMINATED.has(langName) || /[;}]$/.test(trimmed)) return [c]
    const head = c.text.slice(0, c.offset + trimmed.length)
    const tail = c.text.slice(c.offset + trimmed.length)
    return [c, { text: `${head};${tail}`, offset: c.offset, length: c.length }]
  }
  const raw = withTerminator({ text: trimmed, offset: 0, length: trimmed.length })
  const embedded = (PATTERN_CONTEXTS[langName] ?? []).flatMap(template =>
    withTerminator({ text: template.replace('<P>', trimmed), offset: template.indexOf('<P>'), length: trimmed.length }),
  )
  return RAW_CANDIDATE_LAST.has(langName) ? [...embedded, ...raw] : [...raw, ...embedded]
}

/** The DEEPEST named node spanning [start, end) — the significant pattern
 *  node (wrappers with identical spans are descended through). The node may
 *  overhang `end` by TRAILING WHITESPACE ONLY (`text` is the parsed source):
 *  line-oriented grammars (ini today; Dockerfile/Make later) bind the
 *  statement-terminating newline into the node, and a whitespace tail can
 *  never change structural match semantics. */
export function findExactSpanNode(root: TSNode, start: number, end: number, text?: string): TSNode | null {
  const spans = (node: TSNode): boolean => {
    if (node.startIndex !== start) return false
    if (node.endIndex === end) return true
    if (node.endIndex < end || text === undefined) return false
    return text.slice(end, node.endIndex).trim() === ''
  }
  let found: TSNode | null = null
  let cur: TSNode | null = root
  while (cur) {
    if (cur.isNamed && spans(cur)) found = cur
    let next: TSNode | null = null
    for (const child of cur.namedChildren) {
      if (child.startIndex <= start && child.endIndex >= end) {
        next = child
        break
      }
    }
    cur = next
  }
  return found
}

function collectCaptureNames(node: TSNode, into: Set<string>): void {
  const mv = metavarOf(node)
  if (mv?.name) {
    into.add(mv.kind === 'multi' ? `$$$${mv.name}` : `$${mv.name}`)
    return
  }
  for (const child of node.namedChildren) collectCaptureNames(child, into)
}

export function compilePatternRoot(patternNode: TSNode): CompiledPattern {
  const names = new Set<string>()
  collectCaptureNames(patternNode, names)
  return { root: patternNode, captureNames: [...names].sort() }
}

// ── matching ────────────────────────────────────────────────────────────────

export interface CaptureSpan {
  /** '$NAME' or '$$$NAME'. */
  key: string
  startIndex: number
  endIndex: number
  text: string
}

export const COMMENT_TYPES = new Set(['comment', 'line_comment', 'block_comment', 'doc_comment'])

/**
 * The children the matcher compares: named nodes PLUS anonymous tokens that
 * carry a grammar FIELD name (operators, significant keywords — the ast-grep
 * smart-strictness line). Without the field-carrying tokens, `$A + $B`
 * would conflate `x - y` and `x * y` (verified defect class). Pure
 * punctuation (parens, commas — fieldless) stays skipped so multi-metavar
 * sequences match.
 */
export function significantChildren(node: TSNode): TSNode[] {
  const out: TSNode[] = []
  const all = node.children
  const fieldFor = (node as unknown as { fieldNameForChild?: (i: number) => string | null }).fieldNameForChild?.bind(node)
  for (let i = 0; i < all.length; i++) {
    const child = all[i]!
    if (COMMENT_TYPES.has(child.type)) continue
    if (child.isNamed) {
      out.push(child)
      continue
    }
    if (fieldFor?.(i)) out.push(child)
  }
  return out
}

interface MatchState {
  captures: Map<string, CaptureSpan>
}

function bindCapture(state: MatchState, key: string, start: number, end: number, text: string): boolean {
  const existing = state.captures.get(key)
  if (existing) return existing.text === text // reuse requires identical code
  state.captures.set(key, { key, startIndex: start, endIndex: end, text })
  return true
}

function matchNodePair(pat: TSNode, code: TSNode, state: MatchState): boolean {
  const mv = metavarOf(pat)
  if (mv) {
    if (mv.kind === 'multi') {
      // A multi metavar in single-node position matches that one node.
      return mv.name === null || bindCapture(state, `$$$${mv.name}`, code.startIndex, code.endIndex, code.text)
    }
    return mv.name === null || bindCapture(state, `$${mv.name}`, code.startIndex, code.endIndex, code.text)
  }
  if (pat.type !== code.type) return false
  const patKids = significantChildren(pat)
  const codeKids = significantChildren(code)
  if (patKids.length === 0 && codeKids.length === 0) {
    // A true leaf (no children at all) compares exact text; a childless-of-
    // significant-children node (empty argument lists, empty blocks — only
    // fieldless punctuation inside) compares whitespace-insensitively so
    // `foo()` matches `foo()`.
    if (pat.childCount === 0 && code.childCount === 0) {
      return pat.text.trim() === code.text.trim()
    }
    return pat.text.replace(/\s+/g, '') === code.text.replace(/\s+/g, '')
  }
  return matchSequence(patKids, codeKids, state)
}

/** Ordered-list match with multi-metavariable (lazy) sequence support. */
function matchSequence(pats: TSNode[], codes: TSNode[], state: MatchState): boolean {
  function step(pi: number, ci: number): boolean {
    if (pi === pats.length) return ci === codes.length
    const pat = pats[pi]!
    const mv = metavarOf(pat)
    if (mv?.kind === 'multi') {
      // Lazy: try shortest span first; captures snapshot/restore around trials.
      for (let take = 0; ci + take <= codes.length; take++) {
        const snapshot = new Map(state.captures)
        let ok = true
        if (mv.name) {
          const key = `$$$${mv.name}`
          const start = take === 0 ? (codes[ci]?.startIndex ?? 0) : codes[ci]!.startIndex
          const end = take === 0 ? start : codes[ci + take - 1]!.endIndex
          const text = take === 0 ? '' : codes[ci]!.text // refined below by caller via source slice
          ok = bindCapture(state, key, start, end, spanText(codes, ci, take) ?? text)
        }
        if (ok && step(pi + 1, ci + take)) return true
        state.captures = snapshot
      }
      return false
    }
    if (ci >= codes.length) return false
    const snapshot = new Map(state.captures)
    if (matchNodePair(pat, codes[ci]!, state) && step(pi + 1, ci + 1)) return true
    state.captures = snapshot
    return false
  }
  return step(0, 0)
}

/** Concatenated text of a sibling span (joined with the trivia-free gap). */
function spanText(codes: TSNode[], start: number, count: number): string | null {
  if (count === 0) return ''
  const nodes = codes.slice(start, start + count)
  if (nodes.length === 0) return null
  return nodes.map(n => n.text).join(nodes.length > 1 ? ', ' : '')
}

export interface PatternMatch {
  node: TSNode
  captures: CaptureSpan[]
}

/**
 * Walk the code tree, reporting every node the compiled pattern matches, in
 * document order. `sourceText` refines multi-capture spans to the EXACT
 * source slice (separators preserved). Nested matches inside an already
 * matched node are still reported (query truth); the transform layer owns
 * overlap policy.
 */
export function findPatternMatches(
  pattern: CompiledPattern,
  codeRoot: TSNode,
  sourceText: string,
  cap: number,
): { matches: PatternMatch[]; capped: boolean } {
  const matches: PatternMatch[] = []
  let capped = false
  const stack: TSNode[] = [codeRoot]
  // Depth-first in document order: push children reversed.
  while (stack.length > 0) {
    if (matches.length >= cap) {
      capped = true
      break
    }
    const node = stack.pop()!
    const state: MatchState = { captures: new Map() }
    if (matchNodePair(pattern.root, node, state)) {
      const captures = [...state.captures.values()].map(c =>
        c.endIndex > c.startIndex ? { ...c, text: sourceText.slice(c.startIndex, c.endIndex) } : c,
      )
      matches.push({ node, captures })
    }
    const kids = node.namedChildren
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!)
  }
  return { matches, capped }
}

// ── rewrite templates ───────────────────────────────────────────────────────

export interface RewriteRefusal {
  refuse: string
}

/**
 * Substitute captures into an `out` template — ONE pass over the template
 * only (substituted capture text is NEVER re-scanned: source containing
 * `$UPPER` must ride through verbatim, the verified corruption class).
 * `$NAME`/`$$$NAME` tokens not bound by the pattern REFUSE (a template can
 * never invent code silently).
 */
export function substituteRewrite(
  out: string,
  captures: CaptureSpan[],
  captureNames: string[],
): string | RewriteRefusal {
  const byKey = new Map(captures.map(c => [c.key, c.text]))
  let refusal: string | null = null
  const substituted = out.replace(
    /\$\$\$([A-Z_][A-Z0-9_]*)|\$([A-Z_][A-Z0-9_]*)/g,
    (whole, multi: string | undefined, single: string | undefined) => {
      if (single === '_') return whole
      const key = multi !== undefined ? `$$$${multi}` : `$${single}`
      if (!captureNames.includes(key)) {
        refusal ??= `out references ${whole} which the pattern does not capture (captures: ${captureNames.join(', ') || 'none'})`
        return whole
      }
      return byKey.get(key) ?? ''
    },
  )
  if (refusal) return { refuse: refusal }
  return substituted
}
