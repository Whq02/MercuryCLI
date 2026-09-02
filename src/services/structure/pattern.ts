
import type { TSNode } from './grammarFacility.js'


const MV_SINGLE = /^__MV_([A-Za-z0-9_]*?)__$/
const MV_MULTI = /^__MVM_([A-Za-z0-9_]*?)__$/

export function encodePattern(pattern: string): string {
  return pattern
    .replace(/\$\$\$([A-Z_][A-Z0-9_]*)?(?![A-Za-z0-9_$])/g, (_m, name: string | undefined) => `__MVM_${name ?? 'ANON'}__`)
    .replace(/(?<!\$)\$([A-Z_][A-Z0-9_]*)/g, (_m, name: string) => `__MV_${name === '_' ? 'ANON' : name}__`)
}

export interface MetavarInfo {
  kind: 'single' | 'multi'
  name: string | null
}

const MV_QUOTED = /^(["'`])(__MVM?_[A-Za-z0-9_]*?__)\1$/

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


export interface CompiledPattern {
  root: TSNode
  captureNames: string[]
}

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
  ini: ['[mercury_ctx]\n<P>\n'],
}

const RAW_CANDIDATE_LAST = new Set(['php', 'c'])

const STATEMENT_TERMINATED = new Set(['c', 'cpp', 'c-sharp', 'java', 'php', 'rust', 'javascript', 'typescript', 'tsx', 'go', 'css'])

function quotePlaceholders(encoded: string): string {
  return encoded.replace(/__MVM?_[A-Za-z0-9_]*?__/g, m => `"${m}"`)
}

export interface PatternCandidate {
  text: string
  offset: number
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


export interface CaptureSpan {
  key: string
  startIndex: number
  endIndex: number
  text: string
}

export const COMMENT_TYPES = new Set(['comment', 'line_comment', 'block_comment', 'doc_comment'])

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
  if (existing) return existing.text === text
  state.captures.set(key, { key, startIndex: start, endIndex: end, text })
  return true
}

function matchNodePair(pat: TSNode, code: TSNode, state: MatchState): boolean {
  const mv = metavarOf(pat)
  if (mv) {
    if (mv.kind === 'multi') {
      return mv.name === null || bindCapture(state, `$$$${mv.name}`, code.startIndex, code.endIndex, code.text)
    }
    return mv.name === null || bindCapture(state, `$${mv.name}`, code.startIndex, code.endIndex, code.text)
  }
  if (pat.type !== code.type) return false
  const patKids = significantChildren(pat)
  const codeKids = significantChildren(code)
  if (patKids.length === 0 && codeKids.length === 0) {
    if (pat.childCount === 0 && code.childCount === 0) {
      return pat.text.trim() === code.text.trim()
    }
    return pat.text.replace(/\s+/g, '') === code.text.replace(/\s+/g, '')
  }
  return matchSequence(patKids, codeKids, state)
}

function matchSequence(pats: TSNode[], codes: TSNode[], state: MatchState): boolean {
  function step(pi: number, ci: number): boolean {
    if (pi === pats.length) return ci === codes.length
    const pat = pats[pi]!
    const mv = metavarOf(pat)
    if (mv?.kind === 'multi') {
      for (let take = 0; ci + take <= codes.length; take++) {
        const snapshot = new Map(state.captures)
        let ok = true
        if (mv.name) {
          const key = `$$$${mv.name}`
          const start = take === 0 ? (codes[ci]?.startIndex ?? 0) : codes[ci]!.startIndex
          const end = take === 0 ? start : codes[ci + take - 1]!.endIndex
          const text = take === 0 ? '' : codes[ci]!.text
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

export function findPatternMatches(
  pattern: CompiledPattern,
  codeRoot: TSNode,
  sourceText: string,
  cap: number,
): { matches: PatternMatch[]; capped: boolean } {
  const matches: PatternMatch[] = []
  let capped = false
  const stack: TSNode[] = [codeRoot]
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


export interface RewriteRefusal {
  refuse: string
}

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
