
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import * as path from 'node:path'
import { structuredPatch } from 'diff'
import { buildDiffHunks, type BoundedDiffHunk } from '../services/changeTransaction/diffBudget.js'
import {
  languageByName,
  languageForFile,
  loadGrammarEngine,
  parsePolyglot,
  POLYGLOT_LANGUAGES,
  resolveGrammarEngineDir,
  type PolyglotLanguage,
  type TSNode,
} from '../services/structure/grammarFacility.js'
import {
  COMMENT_TYPES,
  encodePattern,
  findExactSpanNode,
  findPatternMatches,
  metavarOf,
  significantChildren,
  substituteRewrite,
  type CaptureSpan,
  type CompiledPattern,
} from '../services/structure/pattern.js'
import { compileFor, discoverPolyglotFiles } from '../services/structure/polyglotQuery.js'
import { applyEdits, digestOf, lineExtendedRange, type Edit } from '../services/structure/transform.js'


export const AST_BOUNDS = {
  defaultLimit: 50,
  maxLimit: 200,
  matchCap: 2000,
  maxFileBytes: 2_000_000,
  maxFilesParsed: 500,
  editMaxFiles: 100,
  editMaxMatches: 500,
  diffLinesPerFile: 160,
} as const


const availabilityByEngineDir = new Map<string, Set<string>>()

export function availableAstLanguages(): PolyglotLanguage[] {
  const engine = resolveGrammarEngineDir()
  if (engine.state !== 'ok') return []
  let names = availabilityByEngineDir.get(engine.dir)
  if (!names) {
    names = new Set(POLYGLOT_LANGUAGES.filter(l => existsSync(path.join(engine.dir, l.wasm))).map(l => l.name))
    availabilityByEngineDir.set(engine.dir, names)
  }
  const carried = names
  return POLYGLOT_LANGUAGES.filter(l => carried.has(l.name))
}

export function astLanguageNames(): string[] {
  return availableAstLanguages().map(l => l.name)
}

export function uncarriedAstLanguages(): PolyglotLanguage[] {
  const have = new Set(astLanguageNames())
  return POLYGLOT_LANGUAGES.filter(l => !have.has(l.name))
}

export const GRAMMAR_PACK_REMEDY =
  'the grammar-pack extension is not vendored in this build — the operator prepares it with `bun run scripts/vendor/fetch-grammars.ts` and rebuilds (release archives carry it)'

function isCarried(lang: PolyglotLanguage): boolean {
  return availableAstLanguages().some(l => l.name === lang.name)
}

function uncarriedRefusal(lang: PolyglotLanguage, what: string): string {
  return `${what} routes to ${lang.name}, but this build does not carry the ${lang.name} grammar: ${GRAMMAR_PACK_REMEDY}. Languages this build carries: ${astLanguageNames().join(', ')}.`
}

const LANGUAGE_ALIASES: Record<string, string> = {
  ts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  py: 'python',
  rs: 'rust',
  golang: 'go',
  cs: 'c-sharp',
  csharp: 'c-sharp',
  'c#': 'c-sharp',
  'c++': 'cpp',
  cxx: 'cpp',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  rb: 'ruby',
  kt: 'kotlin',
  ps1: 'powershell',
  pwsh: 'powershell',
  htm: 'html',
}

export function resolveAstLanguage(name: string): PolyglotLanguage | null {
  const lowered = name.trim().toLowerCase()
  return languageByName(lowered) ?? languageByName(LANGUAGE_ALIASES[lowered] ?? '')
}

export const PATTERN_GRAMMAR_LINES: readonly string[] = [
  'A pattern is ONE complete node of the target language, written as code: a call "$FN($$$ARGS)", a statement "if ($COND) { $$$BODY }", a declaration "function $NAME($$$ARGS) { $$$BODY }", an import "import { $$$NAMES } from \'$MODULE\'". Wrap a fragment that is not standalone in its container: "class $_ { $$$BODY }".',
  'Meta-variables: $NAME matches exactly one node and captures it; $$$NAME matches a sequence of zero or more sibling nodes (arguments, parameters, statements) and captures it; $_ matches one node without capturing; $$$ matches a sequence without capturing. Names are UPPERCASE letters, digits and underscores. A name used twice must match identical code ($A == $A finds x == x, never x == y). $$X and $$$name are literal text, not meta-variables.',
  'Formatting never matters (spacing, line breaks, comments); structure does: "foo($A)" finds every one-argument call to foo, "foo($$$ARGS)" every call to foo, and neither finds the word foo in a string or a comment.',
]

export const PATTERN_EXAMPLES: readonly string[] = [
  '$FN($$$ARGS)',
  'if ($COND) { $$$BODY }',
  'function $NAME($$$ARGS) { $$$BODY }',
]


export interface AstScopeFile {
  abs: string
  rel: string
  lang: PolyglotLanguage
}

export interface AstScope {
  root: string
  target: string
  display: string
  singleFile: boolean
  files: AstScopeFile[]
  skippedNoGrammar: Array<[ext: string, count: number]>
  skippedUncarried: Array<[ext: string, count: number]>
  skippedDenied: number
  truncatedWalk: boolean
  glob?: string
  lang?: PolyglotLanguage
}

export interface AstRefusal {
  refused: string
}

export function isAstRefusal(value: unknown): value is AstRefusal {
  return typeof value === 'object' && value !== null && typeof (value as AstRefusal).refused === 'string'
}

function normaliseGlob(glob: string): string {
  const trimmed = glob.trim().replace(/^\.\//, '')
  if (trimmed === '') return trimmed
  return trimmed.includes('/') ? trimmed : `**/${trimmed}`
}

export function resolveAstScope(opts: {
  path?: string
  glob?: string
  lang?: string
  cwd: string
  readable?: (abs: string) => boolean
}): AstScope | AstRefusal {
  let lang: PolyglotLanguage | undefined
  if (opts.lang !== undefined && opts.lang.trim() !== '') {
    const resolved = resolveAstLanguage(opts.lang)
    if (!resolved) {
      return {
        refused: `Unknown language "${opts.lang}". Supported languages: ${astLanguageNames().join(', ')}. Omit lang to detect the language per file from its extension.`,
      }
    }
    if (!isCarried(resolved)) return { refused: uncarriedRefusal(resolved, `lang "${opts.lang}"`) }
    lang = resolved
  }
  const target = path.resolve(opts.cwd, opts.path ?? '.')
  const display = opts.path === undefined || opts.path === '' ? '.' : opts.path
  let stat
  try {
    stat = statSync(target)
  } catch {
    return { refused: `Path does not exist: ${display} (resolved against ${opts.cwd}).` }
  }
  if (stat.isFile()) {
    const fileLang = lang ?? languageForFile(target)
    if (!fileLang) {
      const ext = path.extname(target) || '(no extension)'
      return {
        refused: `${display} has no grammar for its extension ${ext}, so it cannot be searched structurally. Supported languages: ${astLanguageNames().join(', ')}. Pass lang to force one when the extension is misleading.`,
      }
    }
    if (!isCarried(fileLang)) return { refused: uncarriedRefusal(fileLang, display) }
    if (opts.readable && !opts.readable(target)) {
      return { refused: `${display} is hidden by a read-deny permission rule.` }
    }
    return {
      root: path.dirname(target),
      target,
      display,
      singleFile: true,
      files: [{ abs: target, rel: path.basename(target), lang: fileLang }],
      skippedNoGrammar: [],
      skippedUncarried: [],
      skippedDenied: 0,
      truncatedWalk: false,
      ...(opts.glob !== undefined && { glob: opts.glob }),
      ...(lang !== undefined && { lang }),
    }
  }
  if (!stat.isDirectory()) {
    return { refused: `${display} is neither a file nor a directory.` }
  }
  const glob = opts.glob !== undefined && opts.glob.trim() !== '' ? normaliseGlob(opts.glob) : undefined
  const discovered = discoverPolyglotFiles(target, glob !== undefined ? [glob] : undefined, lang ?? null)
  let skippedDenied = 0
  const uncarried = new Map<string, number>()
  const files: AstScopeFile[] = []
  for (const f of discovered.files) {
    const abs = path.join(target, f.rel)
    if (!isCarried(f.lang)) {
      const ext = path.extname(f.rel).toLowerCase() || path.basename(f.rel)
      uncarried.set(ext, (uncarried.get(ext) ?? 0) + 1)
      continue
    }
    if (opts.readable && !opts.readable(abs)) {
      skippedDenied++
      continue
    }
    files.push({ abs, rel: f.rel, lang: f.lang })
  }
  const byCount = (a: [string, number], b: [string, number]): number => b[1] - a[1] || a[0].localeCompare(b[0])
  return {
    root: target,
    target,
    display,
    singleFile: false,
    files,
    skippedNoGrammar: [...discovered.skippedNoGrammar.entries()].sort(byCount),
    skippedUncarried: [...uncarried.entries()].sort(byCount),
    skippedDenied,
    truncatedWalk: discovered.truncatedWalk,
    ...(glob !== undefined && { glob }),
    ...(lang !== undefined && { lang }),
  }
}

export function describeScopeLanguages(files: readonly AstScopeFile[]): string {
  const counts = new Map<string, number>()
  for (const f of files) counts.set(f.lang.name, (counts.get(f.lang.name) ?? 0) + 1)
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, n]) => `${n} ${name}`)
    .join(', ')
}

export function describeSkipped(skipped: ReadonlyArray<[string, number]>, cap = 6): string {
  if (skipped.length === 0) return ''
  const shown = skipped.slice(0, cap).map(([ext, n]) => `${ext} ×${n}`)
  const more = skipped.length > cap ? `, +${skipped.length - cap} more` : ''
  return `${shown.join(', ')}${more}`
}


export interface AstCapture {
  key: string
  text: string
  startIndex: number
  endIndex: number
}

export interface AstMatch {
  rel: string
  abs: string
  lang: string
  startIndex: number
  endIndex: number
  startLine: number
  startCol: number
  endLine: number
  endCol: number
  nodeType: string
  text: string
  captures: AstCapture[]
}

export interface AstSearchResult {
  matches: AstMatch[]
  capped: boolean
  filesParsed: number
  filesWithMatches: number
  parseFailures: Array<{ rel: string; message: string }>
  patternRefusals: Array<{ lang: string; files: number; note: string }>
  captureNamesByLang: Map<string, string[]>
  skippedLarge: number
  truncatedParse: boolean
  languagesSearched: Array<[lang: string, files: number]>
}

function preFilterToken(pattern: string): string | null {
  const tokens = pattern
    .split(/\$\$\$[A-Z_][A-Z0-9_]*|\$\$\$|\$[A-Z_][A-Z0-9_]*/)
    .flatMap(part => part.split(/[^A-Za-z0-9_]+/))
    .filter(tok => tok.length >= 3)
    .sort((a, b) => b.length - a.length)
  return tokens[0] ?? null
}

function materialise(rel: string, abs: string, lang: string, node: TSNode, captures: CaptureSpan[]): AstMatch {
  return {
    rel,
    abs,
    lang,
    startIndex: node.startIndex,
    endIndex: node.endIndex,
    startLine: node.startPosition.row + 1,
    startCol: node.startPosition.column + 1,
    endLine: node.endPosition.row + 1,
    endCol: node.endPosition.column + 1,
    nodeType: node.type,
    text: node.text,
    captures: captures.map(c => ({ key: c.key, text: c.text, startIndex: c.startIndex, endIndex: c.endIndex })),
  }
}

type CompileCache = Map<string, { pattern: CompiledPattern; hold: { delete(): void } } | { state: 'refused'; note: string }>

export async function searchAstPattern(
  scope: AstScope,
  opts: { pattern: string; signal?: AbortSignal; matchCap?: number },
): Promise<AstSearchResult | AstRefusal> {
  const engine = await loadGrammarEngine()
  if (engine.state === 'unavailable') return { refused: engine.note }
  const cap = Math.max(1, opts.matchCap ?? AST_BOUNDS.matchCap)
  const encoded = encodePattern(opts.pattern)
  const preToken = preFilterToken(opts.pattern)
  const compileCache: CompileCache = new Map()
  const refusedLangs = new Map<string, { files: number; note: string }>()
  const captureNamesByLang = new Map<string, string[]>()
  const langFiles = new Map<string, number>()
  const matches: AstMatch[] = []
  const parseFailures: Array<{ rel: string; message: string }> = []
  let filesParsed = 0
  let filesWithMatches = 0
  let skippedLarge = 0
  let capped = false
  let truncatedParse = false

  for (const file of scope.files) {
    if (opts.signal?.aborted) break
    if (matches.length >= cap) {
      capped = true
      break
    }
    if (filesParsed >= AST_BOUNDS.maxFilesParsed) {
      truncatedParse = true
      break
    }
    const compiled = await compileFor(engine, file.lang, encoded, compileCache)
    if ('state' in compiled) {
      const entry = refusedLangs.get(file.lang.name) ?? { files: 0, note: compiled.note }
      entry.files++
      refusedLangs.set(file.lang.name, entry)
      continue
    }
    if (!captureNamesByLang.has(file.lang.name)) {
      captureNamesByLang.set(file.lang.name, compiled.pattern.captureNames)
    }
    let text: string
    try {
      text = readFileSync(file.abs, 'utf8')
    } catch {
      continue
    }
    if (text.length > AST_BOUNDS.maxFileBytes) {
      skippedLarge++
      continue
    }
    langFiles.set(file.lang.name, (langFiles.get(file.lang.name) ?? 0) + 1)
    if (preToken && !text.includes(preToken)) continue
    filesParsed++
    const parsed = await parsePolyglot(engine, file.lang, text)
    if ('state' in parsed) {
      parseFailures.push({ rel: file.rel, message: parsed.note })
      continue
    }
    if (parsed.parseErrors.length > 0) {
      parseFailures.push({ rel: file.rel, message: `does not parse as ${file.lang.name}: ${parsed.parseErrors[0]}` })
      parsed.tree.delete()
      continue
    }
    const found = findPatternMatches(compiled.pattern, parsed.tree.rootNode, text, cap - matches.length)
    if (found.matches.length > 0) filesWithMatches++
    for (const m of found.matches) matches.push(materialise(file.rel, file.abs, file.lang.name, m.node, m.captures))
    if (found.capped) capped = true
    parsed.tree.delete()
  }
  for (const entry of compileCache.values()) {
    if (!('state' in entry)) entry.hold.delete()
  }
  return {
    matches,
    capped,
    filesParsed,
    filesWithMatches,
    parseFailures,
    patternRefusals: [...refusedLangs.entries()].map(([lang, e]) => ({ lang, files: e.files, note: e.note })),
    captureNamesByLang,
    skippedLarge,
    truncatedParse,
    languagesSearched: [...langFiles.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
  }
}

export function patternRefusedEverywhere(scope: AstScope, result: AstSearchResult): boolean {
  return result.patternRefusals.length > 0 && result.languagesSearched.length === 0 && result.filesParsed === 0 && scope.files.length > 0
}

export function patternErrorText(pattern: string, result: AstSearchResult): string {
  const first = result.patternRefusals[0]
  const where = first ? ` as ${first.lang} (${first.note.replace(/^the pattern does not parse as [^ ]+ \(/, '').replace(/\)$/, '')})` : ''
  const others = result.patternRefusals.slice(1).map(r => r.lang)
  const shown = JSON.stringify(pattern.length > 120 ? `${pattern.slice(0, 117)}…` : pattern)
  return [
    `The pattern ${shown} did not parse${where}${others.length > 0 ? `; nor as ${others.join(', ')}` : ''}.`,
    PATTERN_GRAMMAR_LINES[0]!,
    `Meta-variable names are UPPERCASE: $NAME for one node, $$$NAME for a sequence ($$X and $$$name are literal text). Try one of: ${PATTERN_EXAMPLES.map(e => JSON.stringify(e)).join(', ')}.`,
  ].join('\n')
}


export interface AstRewriteFile {
  rel: string
  abs: string
  lang: string
  matchCount: number
  before: string
  after: string
  digestBefore: string
  digestAfter: string
  diff: string
  diffOmittedLines: number
  hunks: BoundedDiffHunk[]
  omittedHunks: number
  changedLines: number
  edits: Edit[]
}

export interface AstRewritePlan {
  token: string
  files: AstRewriteFile[]
  matchCount: number
  unchangedMatches: number
  inPlaceMatches: number
  search: AstSearchResult
}


function normalisedText(node: TSNode): string {
  return node.text.replace(/\s+/g, '')
}

function sameShape(p: TSNode, r: TSNode): boolean {
  const mp = metavarOf(p)
  const mr = metavarOf(r)
  if (mp || mr) return mp !== null && mr !== null && mp.kind === mr.kind && mp.name === mr.name
  if (p.type !== r.type) return false
  const pk = significantChildren(p)
  const rk = significantChildren(r)
  if (pk.length !== rk.length) return false
  if (pk.length === 0) {
    if (p.childCount === 0 && r.childCount === 0) return true
    return normalisedText(p) === normalisedText(r)
  }
  return pk.every((child, i) => sameShape(child, rk[i]!))
}

function alignEdits(p: TSNode, r: TSNode, c: TSNode, captures: AstCapture[], out: Edit[]): boolean {
  if (metavarOf(p)) return true
  const pk = significantChildren(p)
  const rk = significantChildren(r)
  const ck = significantChildren(c)
  if (pk.length === 0) {
    if (p.childCount === 0 && c.childCount === 0) {
      if (p.text.trim() !== r.text.trim()) out.push({ start: c.startIndex, end: c.endIndex, newText: r.text.trim() })
      return true
    }
    return normalisedText(p) === normalisedText(r)
  }
  let ci = 0
  for (let pi = 0; pi < pk.length; pi++) {
    const pc = pk[pi]!
    const rc = rk[pi]!
    const mv = metavarOf(pc)
    if (mv?.kind === 'multi') {
      if (mv.name) {
        const cap = captures.find(x => x.key === `$$$${mv.name}`)
        if (!cap) return false
        while (ci < ck.length && cap.endIndex > cap.startIndex && ck[ci]!.startIndex >= cap.startIndex && ck[ci]!.endIndex <= cap.endIndex) ci++
      } else {
        const rest = pk.slice(pi + 1)
        if (rest.some(x => metavarOf(x)?.kind === 'multi')) return false
        const take = ck.length - ci - rest.length
        if (take < 0) return false
        ci += take
      }
      continue
    }
    if (ci >= ck.length) return false
    if (mv) {
      ci++
      continue
    }
    if (!alignEdits(pc, rc, ck[ci]!, captures, out)) return false
    ci++
  }
  return ci === ck.length
}

function uncapturedCommentSpans(node: TSNode, captures: AstCapture[]): Edit[] {
  const out: Edit[] = []
  const stack: TSNode[] = [node]
  while (stack.length > 0) {
    const cur = stack.pop()!
    if (COMMENT_TYPES.has(cur.type)) {
      const inCapture = captures.some(c => c.endIndex > c.startIndex && cur.startIndex >= c.startIndex && cur.endIndex <= c.endIndex)
      if (!inCapture) out.push({ start: cur.startIndex, end: cur.endIndex, newText: '' })
      continue
    }
    for (let i = cur.childCount - 1; i >= 0; i--) stack.push(cur.children[i]!)
  }
  return out
}

function locateMatchNode(root: TSNode, m: AstMatch, text: string): TSNode | null {
  let node = findExactSpanNode(root, m.startIndex, m.endIndex, text)
  while (node && node.type !== m.nodeType) {
    const parent = node.parent
    if (!parent || parent.startIndex !== m.startIndex || parent.endIndex !== m.endIndex) return null
    node = parent
  }
  return node
}

const ANON_IN_REWRITE = /\$\$\$(?![A-Z_])|(?<!\$)\$_(?![A-Za-z0-9_])/

export { digestOf }

export function rewritePlanToken(pattern: string, rewrite: string, files: Array<[rel: string, digestBefore: string, digestAfter: string]>): string {
  return `ae-${createHash('sha1')
    .update(JSON.stringify({ p: pattern, r: rewrite, f: files }))
    .digest('hex')
    .slice(0, 12)}`
}

export function unifiedDiff(rel: string, before: string, after: string, lineBudget = AST_BOUNDS.diffLinesPerFile): { text: string; omittedLines: number } {
  const patch = structuredPatch(rel, rel, before, after, '', '', { context: 3 })
  const lines: string[] = [`--- a/${rel}`, `+++ b/${rel}`]
  let omitted = 0
  let budget = lineBudget
  for (const h of patch.hunks) {
    const header = `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`
    if (budget <= 0) {
      omitted += h.lines.length + 1
      continue
    }
    lines.push(header)
    budget--
    for (const line of h.lines) {
      if (budget <= 0) {
        omitted++
        continue
      }
      lines.push(line)
      budget--
    }
  }
  return { text: lines.join('\n'), omittedLines: omitted }
}

function countChangedLines(before: string, after: string, edits: Edit[]): number {
  let n = 0
  for (const e of edits) {
    n += Math.max(before.slice(e.start, e.end).split('\n').length, e.newText.split('\n').length)
  }
  return after === before ? 0 : n
}

export async function planAstRewrite(
  scope: AstScope,
  opts: { pattern: string; rewrite: string; signal?: AbortSignal },
): Promise<AstRewritePlan | AstRefusal> {
  if (ANON_IN_REWRITE.test(opts.rewrite)) {
    return {
      refused: `The rewrite uses an anonymous meta-variable ($$$ or $_), which captures nothing and so cannot be inserted. Name it in both the pattern and the rewrite (for example $$$ARGS), or drop it from the rewrite.`,
    }
  }
  const search = await searchAstPattern(scope, {
    pattern: opts.pattern,
    matchCap: AST_BOUNDS.editMaxMatches + 1,
    ...(opts.signal !== undefined && { signal: opts.signal }),
  })
  if (isAstRefusal(search)) return search
  if (search.matches.length > AST_BOUNDS.editMaxMatches) {
    return {
      refused: `More than ${AST_BOUNDS.editMaxMatches} matches in one edit — narrow the scope (path or glob) or the pattern, then run again. Nothing was written.`,
    }
  }
  const byFile = new Map<string, AstMatch[]>()
  for (const m of search.matches) {
    const list = byFile.get(m.rel) ?? []
    list.push(m)
    byFile.set(m.rel, list)
  }
  if (byFile.size > AST_BOUNDS.editMaxFiles) {
    return {
      refused: `Matches in ${byFile.size} files, more than the ${AST_BOUNDS.editMaxFiles}-file bound for one edit — narrow the scope (path or glob), then run again. Nothing was written.`,
    }
  }
  const engine = await loadGrammarEngine()
  if (engine.state === 'unavailable') return { refused: engine.note }

  const patternCache: CompileCache = new Map()
  const rewriteCache: CompileCache = new Map()
  const shapeByLang = new Map<string, { pat: TSNode; rw: TSNode } | null>()
  const encodedPattern = encodePattern(opts.pattern)
  const encodedRewrite = encodePattern(opts.rewrite)
  async function shapeFor(lang: PolyglotLanguage): Promise<{ pat: TSNode; rw: TSNode } | null> {
    const cached = shapeByLang.get(lang.name)
    if (cached !== undefined) return cached
    let shape: { pat: TSNode; rw: TSNode } | null = null
    if (opts.rewrite.trim() !== '') {
      const pat = await compileFor(engine as Parameters<typeof compileFor>[0], lang, encodedPattern, patternCache)
      const rw = await compileFor(engine as Parameters<typeof compileFor>[0], lang, encodedRewrite, rewriteCache)
      if (!('state' in pat) && !('state' in rw) && sameShape(pat.pattern.root, rw.pattern.root)) {
        shape = { pat: pat.pattern.root, rw: rw.pattern.root }
      }
    }
    shapeByLang.set(lang.name, shape)
    return shape
  }
  const releaseCompiled = (): void => {
    for (const cache of [patternCache, rewriteCache]) {
      for (const entry of cache.values()) {
        if (!('state' in entry)) entry.hold.delete()
      }
    }
  }

  const files: AstRewriteFile[] = []
  let unchangedMatches = 0
  let inPlaceMatches = 0
  for (const [rel, list] of [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (opts.signal?.aborted) {
      releaseCompiled()
      return { refused: 'cancelled before planning finished — nothing written.' }
    }
    const first = list[0]!
    const lang = scope.files.find(f => f.rel === rel)?.lang ?? languageForFile(first.abs)
    if (!lang) {
      releaseCompiled()
      return { refused: `${rel}: no grammar for this file (it should not have matched).` }
    }
    let before: string
    try {
      before = readFileSync(first.abs, 'utf8')
    } catch (err) {
      releaseCompiled()
      return { refused: `${rel}: unreadable — ${(err as Error).message}. Nothing was written.` }
    }
    list.sort((a, b) => a.startIndex - b.startIndex || b.endIndex - a.endIndex)
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1]!
      const cur = list[i]!
      if (cur.startIndex < prev.endIndex) {
        releaseCompiled()
        return {
          refused:
            `Ambiguous rewrite in ${rel}: the match at line ${cur.startLine} sits inside the match at line ${prev.startLine} ` +
            `(${JSON.stringify(cur.text.split('\n')[0]!.slice(0, 60))} inside ${JSON.stringify(prev.text.split('\n')[0]!.slice(0, 60))}), ` +
            `so rewriting both would rewrite the same bytes twice. Narrow the pattern so matches do not nest, or split the scope. Nothing was written.`,
        }
      }
    }
    const shape = await shapeFor(lang)
    let tree: { rootNode: TSNode; delete(): void } | null = null
    if (shape) {
      const parsed = await parsePolyglot(engine, lang, before)
      if (!('state' in parsed)) {
        if (parsed.parseErrors.length === 0) tree = parsed.tree
        else parsed.tree.delete()
      }
    }
    const edits: Edit[] = []
    let unchangedInFile = 0
    try {
      for (const m of list) {
        const captureNames = m.captures.map(c => c.key)
        const substituted = substituteRewrite(
          opts.rewrite,
          m.captures.map(c => ({ key: c.key, startIndex: 0, endIndex: 0, text: c.text })),
          captureNames.length > 0 ? captureNames : (search.captureNamesByLang.get(lang.name) ?? []),
        )
        if (typeof substituted !== 'string') {
          releaseCompiled()
          return {
            refused: `${rel}:${m.startLine}: the rewrite ${substituted.refuse.replace(/^out references /, 'references ')} — every meta-variable in the rewrite must be captured by the pattern. Nothing was written.`,
          }
        }
        if (substituted === '') {
          const r = lineExtendedRange(before, m.startIndex, m.endIndex)
          edits.push({ start: r.start, end: r.end, newText: '' })
          continue
        }
        if (shape && tree) {
          const codeNode = locateMatchNode(tree.rootNode, m, before)
          const local: Edit[] = []
          if (codeNode && alignEdits(shape.pat, shape.rw, codeNode, m.captures, local)) {
            local.sort((a, b) => a.start - b.start)
            const nodeText = before.slice(m.startIndex, m.endIndex)
            const guardEdits = [...local, ...uncapturedCommentSpans(codeNode, m.captures)]
              .map(e => ({ start: e.start - m.startIndex, end: e.end - m.startIndex, newText: e.newText }))
              .sort((a, b) => a.start - b.start)
            const overlapping = guardEdits.some((e, i) => i > 0 && e.start < guardEdits[i - 1]!.end)
            const inPlace = overlapping ? null : applyEdits(nodeText, guardEdits)
            if (inPlace !== null && inPlace.replace(/\s+/g, '') === substituted.replace(/\s+/g, '')) {
              if (local.length === 0) {
                unchangedMatches++
                unchangedInFile++
              } else {
                inPlaceMatches++
              }
              edits.push(...local)
              continue
            }
          }
        }
        if (substituted === before.slice(m.startIndex, m.endIndex)) {
          unchangedMatches++
          unchangedInFile++
          continue
        }
        edits.push({ start: m.startIndex, end: m.endIndex, newText: substituted })
      }
    } finally {
      tree?.delete()
    }
    edits.sort((a, b) => a.start - b.start)
    for (let i = 1; i < edits.length; i++) {
      if (edits[i]!.start < edits[i - 1]!.end) {
        releaseCompiled()
        return { refused: `Ambiguous rewrite in ${rel}: two deletions share a line — narrow the pattern. Nothing was written.` }
      }
    }
    const after = applyEdits(before, edits)
    if (after === before) continue
    {
      const reparsed = await parsePolyglot(engine, lang, after)
      if ('state' in reparsed) {
        releaseCompiled()
        return { refused: `${rel}: ${reparsed.note}. Nothing was written.` }
      }
      const broken = reparsed.parseErrors.length > 0
      const firstError = reparsed.parseErrors[0]
      reparsed.tree.delete()
      if (broken) {
        releaseCompiled()
        return {
          refused: `The rewrite would leave ${rel} unparsable as ${lang.name} (${firstError}) — adjust the rewrite so the result is valid code. Nothing was written.`,
        }
      }
    }
    const diff = unifiedDiff(rel, before, after)
    const { hunks, omittedHunks } = buildDiffHunks(rel, before, after)
    files.push({
      rel,
      abs: first.abs,
      lang: lang.name,
      matchCount: list.length - unchangedInFile,
      before,
      after,
      digestBefore: digestOf(before),
      digestAfter: digestOf(after),
      diff: diff.text,
      diffOmittedLines: diff.omittedLines,
      hunks,
      omittedHunks,
      changedLines: countChangedLines(before, after, edits),
      edits,
    })
  }
  releaseCompiled()
  const token = rewritePlanToken(opts.pattern, opts.rewrite, files.map(f => [f.rel, f.digestBefore, f.digestAfter]))
  return {
    token,
    files,
    matchCount: search.matches.length - unchangedMatches,
    unchangedMatches,
    inPlaceMatches,
    search,
  }
}


const MATCH_TEXT_LINES = 4
const MATCH_LINE_CHARS = 160
const CAPTURE_CHARS = 80

export function matchLocation(m: AstMatch): string {
  return m.startLine === m.endLine ? `${m.rel}:${m.startLine}:${m.startCol}` : `${m.rel}:${m.startLine}:${m.startCol}-${m.endLine}:${m.endCol}`
}

function clip(line: string, chars: number): string {
  return line.length > chars ? `${line.slice(0, chars - 1)}…` : line
}

export function renderMatch(m: AstMatch): string[] {
  const codeLines = m.text.split('\n')
  const shown = codeLines.slice(0, MATCH_TEXT_LINES).map(l => clip(l, MATCH_LINE_CHARS))
  const out: string[] = [`${matchLocation(m)} [${m.nodeType}]`]
  out.push(...shown.map(l => `  ${l}`))
  if (codeLines.length > MATCH_TEXT_LINES) out.push(`  … +${codeLines.length - MATCH_TEXT_LINES} more lines`)
  if (m.captures.length > 0) {
    out.push(`  captures: ${m.captures.map(c => `${c.key} = ${clip(c.text.split('\n')[0]!, CAPTURE_CHARS)}${c.text.includes('\n') ? ' …' : ''}`).join(' · ')}`)
  }
  return out
}

export function renderSearchTrailer(scope: AstScope, result: AstSearchResult): string[] {
  const out: string[] = []
  const where = scope.singleFile ? scope.display : `under ${scope.display}${scope.glob ? ` (glob ${scope.glob})` : ''}${scope.lang ? ` (lang ${scope.lang.name})` : ''}`
  const langs = result.languagesSearched.map(([l, n]) => `${n} ${l}`).join(', ')
  out.push(`Searched ${result.filesParsed} of ${scope.files.length} files ${where}${langs ? ` — ${langs}` : ''}${result.filesParsed < scope.files.length && scope.files.length > 0 ? ' (files that cannot contain the pattern were not parsed)' : ''}.`)
  if (result.patternRefusals.length > 0) {
    out.push(`Not searched: ${result.patternRefusals.map(r => `${r.files} ${r.lang} file${r.files === 1 ? '' : 's'} (${r.note})`).join('; ')}.`)
  }
  if (result.parseFailures.length > 0) {
    const shown = result.parseFailures.slice(0, 5).map(f => `${f.rel} (${f.message})`)
    out.push(`Did not parse, never matched: ${shown.join('; ')}${result.parseFailures.length > 5 ? `; +${result.parseFailures.length - 5} more` : ''}.`)
  }
  if (scope.skippedNoGrammar.length > 0) {
    const n = scope.skippedNoGrammar.reduce((sum, [, c]) => sum + c, 0)
    out.push(`Skipped ${n} file${n === 1 ? '' : 's'} with no grammar for the extension: ${describeSkipped(scope.skippedNoGrammar)}.`)
  }
  if (scope.skippedUncarried.length > 0) {
    const n = scope.skippedUncarried.reduce((sum, [, c]) => sum + c, 0)
    out.push(`Skipped ${n} file${n === 1 ? '' : 's'} whose grammar this build does not carry (${describeSkipped(scope.skippedUncarried)}): ${GRAMMAR_PACK_REMEDY}.`)
  }
  if (scope.skippedDenied > 0) out.push(`Skipped ${scope.skippedDenied} file${scope.skippedDenied === 1 ? '' : 's'} hidden by read-deny rules.`)
  if (result.skippedLarge > 0) out.push(`Skipped ${result.skippedLarge} file${result.skippedLarge === 1 ? '' : 's'} over ${AST_BOUNDS.maxFileBytes / 1_000_000}MB.`)
  if (scope.truncatedWalk) out.push(`The directory walk stopped at its file bound — narrow path or glob to search the rest.`)
  if (result.truncatedParse) out.push(`Stopped after ${AST_BOUNDS.maxFilesParsed} parsed files — narrow path or glob to search the rest.`)
  return out
}
