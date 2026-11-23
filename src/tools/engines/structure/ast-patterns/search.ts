import { readFileSync, statSync } from 'node:fs'
import { loadGrammarEngine, parsePolyglot, type ParseErrorRegion, type TSNode } from '../../../../platform/grammars/grammarFacility.js'
import { encodePattern, findPatternMatches, type CaptureSpan, type CompiledPattern } from '../pattern.js'
import { compileFor, type PatternRefusal } from '../polyglotQuery.js'
import { AST_BOUNDS, PATTERN_GRAMMAR_LINES, PATTERN_EXAMPLES, LANGUAGE_PATTERN_EXAMPLES } from './languages.js'
import type { AstScope, AstRefusal } from './scope.js'
import { passedOver } from '../../../../platform/errors/passedOver.js'

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
  hasSyntaxError?: boolean
}

export interface AstSearchResult {
  matches: AstMatch[]
  capped: boolean
  filesParsed: number
  filesWithMatches: number
  parseFailures: Array<{ rel: string; message: string }>
  recovered?: Array<{ rel: string; lang: string; source?: string; errors?: ParseErrorRegion[]; diagnostics: number; notes: string[] }>
  patternRefusals: Array<{ lang: string; files: number; note: string }>
  captureNamesByLang: Map<string, string[]>
  skippedLarge: number
  truncatedParse: boolean
  languagesSearched: Array<[lang: string, files: number]>
  compiledSomewhere: boolean
}

export function preFilterToken(pattern: string): string | null {
  const tokens = pattern
    .split(/\$\$\$[A-Z_][A-Z0-9_]*|\$\$\$|\$[A-Z_][A-Z0-9_]*/)
    .flatMap(part => part.split(/[^A-Za-z0-9_]+/))
    .filter(tok => tok.length >= 3)
    .sort((a, b) => b.length - a.length)
  return tokens[0] ?? null
}

export function materialise(rel: string, abs: string, lang: string, node: TSNode, captures: CaptureSpan[]): AstMatch {
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

export type CompileCache = Map<string, { pattern: CompiledPattern; hold: { delete(): void } } | PatternRefusal>

export function farOverSizeBound(abs: string): boolean {
  try {
    return statSync(abs).size > AST_BOUNDS.maxFileBytes * 3
  } catch (error) {
    passedOver(error)
    return false
  }
}

export async function searchAstPattern(
  scope: AstScope,
  opts: { pattern: string; signal?: AbortSignal; matchCap?: number; recover?: boolean; retainSource?: boolean; recoveredApart?: boolean },
): Promise<AstSearchResult | AstRefusal> {
  const engine = await loadGrammarEngine()
  if (engine.state === 'unavailable') return { refused: engine.note }
  const cap = Math.max(1, opts.matchCap ?? AST_BOUNDS.matchCap)
  const encoded = encodePattern(opts.pattern)
  const preToken = preFilterToken(opts.pattern)
  const compileCache: CompileCache = new Map()
  const refusedLangs = new Map<string, { files: number; note: string; textOnly?: boolean }>()
  const captureNamesByLang = new Map<string, string[]>()
  const langFiles = new Map<string, number>()
  const matches: AstMatch[] = []
  const parseFailures: Array<{ rel: string; message: string }> = []
  let recovered: AstSearchResult['recovered']
  let filesParsed = 0
  let filesWithMatches = 0
  let skippedLarge = 0
  let capped = false
  let truncatedParse = false
  let compiledSomewhere = false
  let apart = 0

  for (const file of scope.files) {
    if (opts.signal?.aborted) break
    if (matches.length - apart >= cap) {
      capped = true
      break
    }
    if (filesParsed >= AST_BOUNDS.maxFilesParsed) {
      truncatedParse = true
      break
    }
    let text: string | undefined
    if (file.lang.patternOnly && preToken && !compileCache.has(file.lang.name)) {
      if (farOverSizeBound(file.abs)) {
        skippedLarge++
        continue
      }
      try {
        text = readFileSync(file.abs, 'utf8')
      } catch (error) {
        parseFailures.push({ rel: file.rel, message: `unreadable: ${error instanceof Error ? error.message : String(error)}` })
        continue
      }
      if (text.length > AST_BOUNDS.maxFileBytes) {
        skippedLarge++
        continue
      }
      if (!text.includes(preToken)) {
        langFiles.set(file.lang.name, (langFiles.get(file.lang.name) ?? 0) + 1)
        continue
      }
    }
    const compiled = await compileFor(engine, file.lang, encoded, compileCache)
    if ('state' in compiled) {
      const entry = refusedLangs.get(file.lang.name) ?? { files: langFiles.get(file.lang.name) ?? 0, note: compiled.note, ...(compiled.textOnly && { textOnly: true }) }
      entry.files++
      refusedLangs.set(file.lang.name, entry)
      langFiles.delete(file.lang.name)
      continue
    }
    compiledSomewhere = true
    if (!captureNamesByLang.has(file.lang.name)) {
      captureNamesByLang.set(file.lang.name, compiled.pattern.captureNames)
    }
    if (text === undefined) {
      if (file.lang.patternOnly && farOverSizeBound(file.abs)) {
        skippedLarge++
        continue
      }
      try {
        text = readFileSync(file.abs, 'utf8')
      } catch (error) {
        parseFailures.push({ rel: file.rel, message: `unreadable: ${error instanceof Error ? error.message : String(error)}` })
        continue
      }
      if (text.length > AST_BOUNDS.maxFileBytes) {
        skippedLarge++
        continue
      }
    }
    langFiles.set(file.lang.name, (langFiles.get(file.lang.name) ?? 0) + 1)
    if (preToken && !text.includes(preToken)) continue
    filesParsed++
    const parsed = await parsePolyglot(engine, file.lang, text, opts.recover === false ? undefined : { errorRegions: true })
    if ('state' in parsed) {
      parseFailures.push({ rel: file.rel, message: parsed.note })
      continue
    }
    if (parsed.parseErrors.length > 0) {
      if (opts.recover === false) {
        parseFailures.push({ rel: file.rel, message: `does not parse as ${file.lang.name}: ${parsed.parseErrors[0]}` })
        parsed.tree.delete()
        continue
      }
      ;(recovered ??= []).push({ rel: file.rel, lang: file.lang.name, diagnostics: parsed.errorRegions?.length ?? 0, notes: parsed.parseErrors })
    }
    const own = opts.recoveredApart === true && parsed.parseErrors.length > 0
    const spent = own && matches.length >= cap
    const found = findPatternMatches(compiled.pattern, parsed.tree.rootNode, text, own ? Math.max(1, cap - matches.length) : cap - (matches.length - apart))
    if (found.matches.length > 0) {
      filesWithMatches++
      if (parsed.parseErrors.length > 0 && opts.retainSource && !spent) Object.assign(recovered![recovered!.length - 1]!, { source: text, errors: parsed.errorRegions ?? [] })
    }
    if (own) apart += found.matches.length
    for (const m of found.matches) {
      const match = materialise(file.rel, file.abs, file.lang.name, m.node, m.captures)
      if (parsed.parseErrors.length > 0) match.hasSyntaxError = m.node.type === 'ERROR' || m.node.isMissing || m.node.hasError
      matches.push(match)
    }
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
    ...(recovered ? { recovered } : {}),
    patternRefusals: [...refusedLangs.entries()]
      .sort((a, b) => Number(a[1].textOnly === true) - Number(b[1].textOnly === true))
      .map(([lang, e]) => ({ lang, files: e.files, note: e.note })),
    captureNamesByLang,
    skippedLarge,
    truncatedParse,
    languagesSearched: [...langFiles.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    compiledSomewhere,
  }
}

export function patternRefusedEverywhere(scope: AstScope, result: AstSearchResult): boolean {
  return result.patternRefusals.length > 0 && !result.compiledSomewhere && result.filesParsed === 0 && scope.files.length > 0
}

export function patternErrorText(pattern: string, result: AstSearchResult): string {
  const first = result.patternRefusals[0]
  const where = first ? ` as ${first.lang} (${first.note.replace(/^the pattern does not parse as [^ ]+ \(/, '').replace(/\)$/, '')})` : ''
  const others = result.patternRefusals.slice(1).map(r => r.lang)
  const shown = JSON.stringify(pattern.length > 120 ? `${pattern.slice(0, 117)}…` : pattern)
  const own = first ? LANGUAGE_PATTERN_EXAMPLES[first.lang] : undefined
  return [
    `The pattern ${shown} did not parse${where}${others.length > 0 ? `; nor as ${others.join(', ')}` : ''}.`,
    ...(own
      ? [
          `A pattern is ONE complete node of the target language, written as code. In ${first!.lang}: ${own.map(e => JSON.stringify(e)).join(', ')}.`,
          'Meta-variable names are UPPERCASE: $NAME for one node, $$$NAME for a sequence ($$X and $$$name are literal text).',
        ]
      : [
          PATTERN_GRAMMAR_LINES[0]!,
          `Meta-variable names are UPPERCASE: $NAME for one node, $$$NAME for a sequence ($$X and $$$name are literal text). Try one of: ${PATTERN_EXAMPLES.map(e => JSON.stringify(e)).join(', ')}.`,
        ]),
  ].join('\n')
}
