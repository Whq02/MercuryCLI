
import type { TSNode } from './grammarFacility.js'


const MV_SINGLE = /^__MV_([A-Za-z0-9_]*?)__$/
const MV_MULTI = /^__MVM_([A-Za-z0-9_]*?)__$/

export function encodePattern(pattern: string): string {
  return pattern
    .replace(/\$\$\$([A-Z_][A-Z0-9_]*)?(?![A-Za-z0-9_$])/g, (_m, name: string | undefined) => `__MVM_${name ?? 'ANON'}__`)
    .replace(/(?<!\$)\$([A-Z_][A-Z0-9_]*)/g, (_m, name: string) => `__MV_${name === '_' ? 'ANON' : name}__`)
}

interface MetavarInfo {
  kind: 'single' | 'multi'
  name: string | null
}

const MV_QUOTED = /^(["'`])(__MVM?_[A-Za-z0-9_]*?__)\1$/

function decodeTagMetavar(text: string): string {
  const encoded = /^mercurymv((?:[0-9a-f]{2})+)$/.exec(text)
  return encoded ? Buffer.from(encoded[1]!, 'hex').toString('ascii') : text
}

export function metavarOf(node: TSNode, tagMetavars = false, standIn?: RegExp): MetavarInfo | null {
  let text = node.text.trim()
  if (tagMetavars && node.type === 'tag_name') text = decodeTagMetavar(text)
  const stood = standIn?.exec(text.replace(/[;,]$/, '').trimEnd())
  if (stood) text = stood.slice(1).find(group => group !== undefined)!
  const quoted = MV_QUOTED.exec(text)
  if (quoted) text = quoted[2]!
  const single = MV_SINGLE.exec(text)
  if (single) return { kind: 'single', name: single[1] === 'ANON' || single[1] === '' ? null : single[1]! }
  const multi = MV_MULTI.exec(text)
  if (multi) return { kind: 'multi', name: multi[1] === 'ANON' || multi[1] === '' ? null : multi[1]! }
  return null
}

export function metavarOutsideNodes(root: TSNode, text: string, start: number, end: number, tagMetavars = false, standIn?: RegExp): string | null {
  const spans: Array<[number, number]> = []
  const stack: TSNode[] = [root]
  while (stack.length > 0) {
    const node = stack.pop()!
    if (metavarOf(node, tagMetavars, standIn)) {
      spans.push([node.startIndex, node.endIndex])
      continue
    }
    for (const child of node.children) stack.push(child)
  }
  const markers = tagMetavars ? /__MVM?_[A-Za-z0-9_]*?__|mercurymv(?:[0-9a-f]{2})+/g : /__MVM?_[A-Za-z0-9_]*?__/g
  for (const found of text.slice(start, end).matchAll(markers)) {
    const at = start + found.index!
    if (spans.some(([from, to]) => from <= at && at + found[0].length <= to)) continue
    const marker = /^__MV(M?)_([A-Za-z0-9_]*?)__$/.exec(decodeTagMetavar(found[0]))
    if (!marker) continue
    const name = marker[2] === 'ANON' ? '' : marker[2]!
    return marker[1] === 'M' ? `$$$${name}` : `$${name === '' ? '_' : name}`
  }
  return null
}


export interface CompiledPattern {
  root: TSNode
  captureNames: string[]
  spansTerminator?: boolean
  tagMetavars?: true
  standIn?: RegExp
  detached?: Record<string, string>
  also?: string[]
}

const PATTERN_CONTEXTS: Record<string, string[]> = {
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
  sql: ['SELECT <P>', 'SELECT * FROM mercury_ctx <P>'],
  lua: ['local mercury_ctx = <P>'],
  make: ['mercury_ctx:\n\t<P>\n'],
  xml: ['<mercury_ctx <P>/>'],
  hcl: ['mercury_ctx = <P>'],
  graphql: ['type MercuryCtx {\n<P>\n}', 'query MercuryCtx {\n<P>\n}', 'query MercuryCtx { mercuryCtx(<P>) }'],
  protobuf: ['message MercuryCtx {\n<P>\n}', 'service MercuryCtx {\n<P>\n}', 'enum MercuryCtx {\n<P>\n}'],
  dart: ['void mercuryCtx() {\n<P>\n}'],
  scala: ['object MercuryCtx {\n<P>\n}'],
  zig: ['fn mercuryCtx() void {\n<P>\n}', 'const mercury_ctx = <P>;'],
  haskell: ['mercuryCtx = <P>'],
  ocaml: ['let mercury_ctx = <P>'],
  nix: ['{\n<P>\n}'],
  erlang: ['mercury_ctx() ->\n<P>.'],
  objc: ['void mercury_ctx() {\n<P>\n}', '@implementation MercuryCtx\n<P>\n@end', '@interface MercuryCtx\n<P>\n@end'],
  fortran: ['program mercury_ctx\n<P>\nend program mercury_ctx'],
  solidity: ['contract MercuryCtx { function mercuryCtx() public {\n<P>\n} }', 'contract MercuryCtx {\n<P>\n}'],
  verilog: ['module mercury_ctx;\n<P>\nendmodule', 'module mercury_ctx;\ninitial begin\n<P>\nend\nendmodule'],
  just: ['mercury_ctx:\n    <P>\n'],
  odin: ['package mercury_ctx\nmercury_ctx :: proc() {\n<P>\n}', 'package mercury_ctx\n<P>'],
  tlaplus: ['---- MODULE MercuryCtx ----\n<P>\n====', '---- MODULE MercuryCtx ----\nmercury_ctx == <P>\n===='],
}

const RAW_CANDIDATE_LAST = new Set(['php', 'c', 'dart', 'objc'])

const STATEMENT_SPANNED = new Set(['dart'])

const STATEMENT_TERMINATED = new Set(['c', 'cpp', 'c-sharp', 'java', 'php', 'rust', 'javascript', 'typescript', 'tsx', 'go', 'css', 'protobuf', 'dart', 'zig', 'objc', 'solidity', 'verilog'])

function quotePlaceholders(encoded: string): string {
  return encoded.replace(/__MVM?_[A-Za-z0-9_]*?__/g, m => `"${m}"`)
}

interface PatternCandidate {
  text: string
  offset: number
  length: number
  spansTerminator?: boolean
  tagMetavars?: true
  quoted?: true
  standIn?: RegExp
  stood?: Array<StoodMember>
}

interface StoodMember {
  mark: string
  start: number
  end: number
  ended: number
  within: string[]
}

const STAND_INS: Record<string, Array<{ as: string; within: string[] }>> = {
  java: [{ as: '<M>;', within: ['block', 'constructor_body', 'switch_block_statement_group'] }, { as: 'int <M>;', within: ['class_body', 'interface_body', 'enum_body_declarations'] }, { as: 'int <M>', within: ['formal_parameters'] }],
  'c-sharp': [{ as: '<M>();', within: ['block', 'switch_section'] }, { as: 'int <M>;', within: ['declaration_list'] }],
  c: [{ as: '<M>;', within: ['compound_statement', 'case_statement'] }, { as: 'int <M>;', within: ['field_declaration_list'] }],
  cpp: [{ as: '<M>;', within: ['compound_statement', 'case_statement'] }, { as: 'int <M>;', within: ['field_declaration_list', 'declaration_list'] }],
  css: [{ as: '<M>: 0;', within: ['block'] }],
  json: [{ as: '"<M>": 0', within: ['object'] }],
  zig: [{ as: '<M>;', within: ['block'] }],
  dart: [{ as: '<M>;', within: ['block', 'switch_statement_case'] }, { as: 'var <M>;', within: ['class_body', 'extension_body'] }],
  objc: [{ as: '<M>;', within: ['compound_statement', 'case_statement'] }],
  solidity: [{ as: '<M>;', within: ['function_body', 'block_statement'] }, { as: 'uint <M>;', within: ['contract_body', 'struct_body'] }],
  verilog: [{ as: '<M>;', within: ['seq_block', 'par_block'] }, { as: 'wire <M>;', within: ['module_declaration', 'generate_block', 'interface_declaration'] }],
  fortran: [{ as: 'call <M>()', within: ['program', 'subroutine', 'function', 'do_loop', 'if_statement', 'elseif_clause', 'else_clause', 'case_statement', 'block_construct', 'associate_statement', 'where_statement'] }],
  hcl: [{ as: '<M> = 0', within: ['body', 'object'] }],
  graphql: [{ as: '<M>: Int', within: ['fields_definition', 'input_fields_definition', 'arguments_definition', 'arguments', 'object_value'] }],
  protobuf: [{ as: 'int32 <M> = 1;', within: ['message_body', 'oneof'] }, { as: '<M> = 0;', within: ['enum_body'] }, { as: 'rpc <M>(A) returns (B);', within: ['service'] }],
  nix: [{ as: '<M> = 0;', within: ['binding_set'] }],
  sql: [{ as: '<M> INT', within: ['column_definitions'] }],
  lua: [{ as: '<M>()', within: ['block'] }],
  cmake: [{ as: '<M>()', within: ['body'] }],
  xml: [{ as: '<M>="0"', within: ['STag', 'EmptyElemTag'] }],
  scala: [{ as: '<M> : Int', within: ['parameters', 'class_parameters'] }],
}

const STAND_IN_TRIES = 32

export function standInCandidates(langName: string, candidate: PatternCandidate): PatternCandidate[] {
  const templates = STAND_INS[langName]
  if (!templates || candidate.quoted) return []
  const from = candidate.offset
  const marks = [...candidate.text.slice(from, from + candidate.length).matchAll(/__MVM?_[A-Za-z0-9_]*?__/g)]
    .map(found => ({ at: from + found.index!, text: found[0] }))
    .filter(mark => !/[.\w$]/.test(candidate.text[mark.at - 1] ?? '') && !/[.([\w$]/.test(candidate.text[mark.at + mark.text.length] ?? ''))
  if (marks.length === 0) return []
  const subsets: Array<typeof marks> = []
  const tried = new Set<string>()
  const add = (subset: typeof marks): void => {
    const key = subset.map(mark => mark.at).join(',')
    if (subset.length === 0 || tried.has(key) || subsets.length >= STAND_IN_TRIES) return
    tried.add(key)
    subsets.push(subset)
  }
  add(marks.filter(mark => mark.text.startsWith('__MVM_')))
  for (let size = 1; size <= marks.length; size++) {
    const pick = (start: number, chosen: typeof marks): void => {
      if (chosen.length === size) {
        add(chosen)
        return
      }
      for (let i = start; i < marks.length && subsets.length < STAND_IN_TRIES; i++) pick(i + 1, [...chosen, marks[i]!])
    }
    pick(0, [])
  }
  const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const sides = (as: string): [string, string] => as.replace(/[;,]$/, '').split('<M>') as [string, string]
  const place = (placed: Array<{ mark: (typeof marks)[number]; row: (typeof templates)[number] }>): PatternCandidate => {
    let text = candidate.text
    let shift = 0
    const stood: StoodMember[] = []
    const forms = new Map<string, Set<string>>()
    for (const { mark, row } of placed) {
      const [before, after] = sides(row.as)
      const start = mark.at + shift
      const put = row.as.replace('<M>', () => mark.text)
      text = `${text.slice(0, start)}${put}${text.slice(start + mark.text.length)}`
      stood.push({ mark: mark.text, start, end: start + before.length + mark.text.length + after.length, ended: start + put.length, within: row.within })
      shift += put.length - mark.text.length
      forms.set(row.as, (forms.get(row.as) ?? new Set<string>()).add(mark.text))
    }
    const standIn = new RegExp(`^(?:${[...forms].map(([as, names]) => `${escape(sides(as)[0])}(${[...names].join('|')})${escape(sides(as)[1])}`).join('|')})$`)
    return { ...candidate, text, length: candidate.length + shift, standIn, stood }
  }
  const out: PatternCandidate[] = []
  for (const row of templates) for (const subset of subsets) out.push(place(subset.map(mark => ({ mark, row }))))
  const sequences = marks.filter(mark => mark.text.startsWith('__MVM_'))
  if (templates.length > 1 && sequences.length > 1) {
    const mixed: PatternCandidate[] = []
    const assign = (chosen: number[]): void => {
      if (mixed.length >= STAND_IN_TRIES) return
      if (chosen.length === sequences.length) {
        if (new Set(chosen).size > 1) mixed.push(place(sequences.map((mark, i) => ({ mark, row: templates[chosen[i]!]! }))))
        return
      }
      for (let row = 0; row < templates.length; row++) assign([...chosen, row])
    }
    assign([])
    out.push(...mixed)
  }
  return out
}

export function standsAsMember(pattern: TSNode, member: StoodMember): 'whole' | 'detached' | null {
  const whole = findExactSpanNode(pattern, member.start, member.ended)
  let node = whole ?? findExactSpanNode(pattern, member.start, member.end)
  if (node === null || (node.startIndex === pattern.startIndex && node.endIndex === pattern.endIndex)) return null
  const from = node.startIndex
  const to = node.endIndex
  for (;;) {
    if (member.within.includes(node.type)) return whole !== null || member.ended === member.end ? 'whole' : 'detached'
    if (node.startIndex !== from || node.endIndex !== to || node.parent === null) return null
    node = node.parent
  }
}

const ALSO_FOUND: Record<string, Record<string, string[]>> = {
  'c-sharp': { local_function_statement: ['method_declaration'] },
}

export function alsoFound(langName: string, kind: string): string[] | undefined {
  return ALSO_FOUND[langName]?.[kind]
}

const CLAUSE_WORDS = /^(?:if|for|while|switch|catch|else|finally|do|try)$/

export function namedByAClauseWord(pattern: TSNode): boolean {
  let leaf = pattern
  while (leaf.childCount > 0) leaf = leaf.children[0]!
  return leaf.isNamed && leaf.type !== leaf.text && CLAUSE_WORDS.test(leaf.text)
}

export function captureKeyOf(mark: string): string {
  const multi = MV_MULTI.exec(mark)
  return multi ? `$$$${multi[1]}` : `$${MV_SINGLE.exec(mark)?.[1] ?? ''}`
}

const SPLIT_DECLARATIONS: Record<string, { whole: string[]; part: string; statement: RegExp; says: string }> = {
  dart: {
    whole: ['lambda_expression', 'local_function_declaration'],
    part: 'function_body',
    statement: /^(?:if|for|while|switch|catch)\b/,
    says: 'a function is two nodes there, its signature and its body: write the signature alone, or a statement of the body',
  },
}

export function splitDeclaration(langName: string, node: TSNode): { says: string | null } | null {
  const split = SPLIT_DECLARATIONS[langName]
  if (!split) return null
  if (!split.whole.includes(node.type) && !(node.parent === null && node.namedChildren.some(child => child.type === split.part))) return null
  return { says: split.statement.test(node.text.trimStart()) ? null : split.says }
}

export function patternCandidates(langName: string, encoded: string): PatternCandidate[] {
  const original = encoded.trim()
  const trimmed = langName === 'svelte' || langName === 'astro'
    ? original.replace(/(<\/?)(__MVM?_[A-Za-z0-9_]*?__)(?=[\s/>])/g, (_all, open: string, marker: string) => `${open}mercurymv${Buffer.from(marker).toString('hex')}`)
    : original
  const bare = candidatesFor(langName, trimmed)
  const quoted = /__MVM?_[A-Za-z0-9_]*?__/.test(trimmed) ? candidatesFor(langName, quotePlaceholders(trimmed)).map(candidate => ({ ...candidate, quoted: true as const })) : []
  return [...bare, ...quoted].map(candidate => trimmed === original ? candidate : { ...candidate, tagMetavars: true })
}

function candidatesFor(langName: string, trimmed: string): PatternCandidate[] {
  const withTerminator = (c: PatternCandidate): PatternCandidate[] => {
    if (!STATEMENT_TERMINATED.has(langName) || /[;}]$/.test(trimmed)) return [c]
    const head = c.text.slice(0, c.offset + trimmed.length)
    const tail = c.text.slice(c.offset + trimmed.length)
    const terminated = { text: `${head};${tail}`, offset: c.offset, length: c.length }
    return STATEMENT_SPANNED.has(langName) ? [c, terminated, { ...terminated, length: c.length + 1, spansTerminator: true }] : [c, terminated]
  }
  const raw = withTerminator({ text: trimmed, offset: 0, length: trimmed.length })
  const embedded = (PATTERN_CONTEXTS[langName] ?? []).flatMap(template =>
    withTerminator({ text: template.replace('<P>', () => trimmed), offset: template.indexOf('<P>'), length: trimmed.length }),
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

function collectCaptureNames(node: TSNode, into: Set<string>, tagMetavars: boolean, standIn?: RegExp): void {
  const mv = metavarOf(node, tagMetavars, standIn)
  if (mv?.name) {
    into.add(mv.kind === 'multi' ? `$$$${mv.name}` : `$${mv.name}`)
    return
  }
  for (const child of node.namedChildren) collectCaptureNames(child, into, tagMetavars, standIn)
}

export function compilePatternRoot(patternNode: TSNode, tagMetavars = false, standIn?: RegExp, detached?: Record<string, string>): CompiledPattern {
  const names = new Set<string>()
  collectCaptureNames(patternNode, names, tagMetavars, standIn)
  return { root: patternNode, captureNames: [...names].sort(), ...(tagMetavars && { tagMetavars: true }), ...(standIn && { standIn }), ...(detached && { detached }) }
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
  tagMetavars?: boolean
  standIn?: RegExp
}

function bindCapture(state: MatchState, key: string, start: number, end: number, text: string): boolean {
  const existing = state.captures.get(key)
  if (existing) return existing.text === text
  state.captures.set(key, { key, startIndex: start, endIndex: end, text })
  return true
}

function matchNodePair(pat: TSNode, code: TSNode, state: MatchState): boolean {
  const mv = metavarOf(pat, state.tagMetavars, state.standIn)
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
    const mv = metavarOf(pat, state.tagMetavars, state.standIn)
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

interface PatternMatch {
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
    const state: MatchState = { captures: new Map(), tagMetavars: pattern.tagMetavars, standIn: pattern.standIn }
    if (matchNodePair(pattern.root, node, state) || (pattern.also?.includes(node.type) === true && matchSequence(significantChildren(pattern.root), significantChildren(node), state))) {
      const captures = [...state.captures.values()].map(c => {
        if (c.endIndex <= c.startIndex) return c
        let endIndex = c.endIndex
        const closer = pattern.detached?.[c.key]
        if (closer !== undefined) {
          let next = endIndex
          while (/\s/.test(sourceText[next] ?? '')) next++
          if (sourceText[next] === closer) endIndex = next + 1
        }
        return { ...c, endIndex, text: sourceText.slice(c.startIndex, endIndex) }
      })
      matches.push({ node, captures })
    }
    const kids = node.namedChildren
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!)
  }
  return { matches, capped }
}


interface RewriteRefusal {
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
