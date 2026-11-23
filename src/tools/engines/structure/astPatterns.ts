import { readFileSync } from 'node:fs'
import { buildDiffHunks } from '../change-transaction/diffBudget.js'
import { loadGrammarEngine, parsePolyglot, patternLanguageForFile, type TSNode } from '../../../platform/grammars/grammarFacility.js'
import { encodePattern, substituteRewrite } from './pattern.js'
import { applyEdits, digestOf, lineExtendedRange, type Edit } from './transform.js'
import { AST_BOUNDS } from './ast-patterns/languages.js'
import { type AstScope, type AstRefusal, isAstRefusal } from './ast-patterns/scope.js'
import { type AstMatch, type CompileCache, searchAstPattern } from './ast-patterns/search.js'
import { type AstRewriteRule, type AstRewriteFile, type AstLeftOutFile, type AstRewritePlan, alignEdits, uncapturedCommentSpans, locateMatchNode, ANON_IN_REWRITE, rewritePlanToken, unifiedDiff, countChangedLines, touchesParseError, introducedParseError } from './ast-patterns/rewriteParts.js'
import { planAstBatchRewrite } from './ast-patterns/batchRewrite.js'
import { spansTerminator, shapeFor, releaseCompiled } from './ast-patterns/singleRewrite.js'

export { AST_BOUNDS, availableAstLanguages, astLanguageNames, GRAMMAR_PACK_REMEDY, resolveAstLanguage, PATTERN_GRAMMAR_LINES, PATTERN_EXAMPLES, LANGUAGE_PATTERN_EXAMPLES } from './ast-patterns/languages.js'
export { isAstRefusal, resolveAstScope, describeSkipped } from './ast-patterns/scope.js'
export type { AstScopeFile, AstScope, AstRefusal } from './ast-patterns/scope.js'
export { searchAstPattern, patternRefusedEverywhere, patternErrorText } from './ast-patterns/search.js'
export type { AstCapture, AstMatch, AstSearchResult } from './ast-patterns/search.js'
export { rewritePlanToken, unifiedDiff } from './ast-patterns/rewriteParts.js'
export type { AstRewriteRule, AstRewriteFile, AstLeftOutFile, AstRewritePlan } from './ast-patterns/rewriteParts.js'
export { renderLeftOut, matchLocation, renderMatch, renderSearchTrailer } from './ast-patterns/render.js'

export { digestOf }

export async function planAstRewrite(
  scope: AstScope,
  opts: { pattern?: string; rewrite?: string; rules?: ReadonlyArray<AstRewriteRule>; signal?: AbortSignal },
): Promise<AstRewritePlan | AstRefusal> {
  if (opts.rules !== undefined) {
    return planAstBatchRewrite(scope, opts.rules, opts.signal)
  }
  const singlePattern = opts.pattern ?? ''
  const singleRewrite = opts.rewrite ?? ''
  if (ANON_IN_REWRITE.test(singleRewrite)) {
    return {
      refused: `The rewrite uses an anonymous meta-variable ($$$ or $_), which captures nothing and so cannot be inserted. Name it in both the pattern and the rewrite (for example $$$ARGS), or drop it from the rewrite.`,
    }
  }
  const search = await searchAstPattern(scope, {
    pattern: singlePattern,
    matchCap: AST_BOUNDS.editMaxMatches + 1,
    retainSource: true,
    recoveredApart: true,
    ...(opts.signal !== undefined && { signal: opts.signal }),
  })
  if (isAstRefusal(search)) return search
  const tooManyMatches = `More than ${AST_BOUNDS.editMaxMatches} matches in one edit — narrow the scope (path or glob) or the pattern, then run again. Nothing was written.`
  const tooManyFiles = (count: number): string => `Matches in ${count} files, more than the ${AST_BOUNDS.editMaxFiles}-file bound for one edit — narrow the scope (path or glob), then run again. Nothing was written.`
  const damaged = new Set(search.recovered?.map(file => file.rel))
  const byFile = new Map<string, AstMatch[]>()
  let parsedMatches = 0
  for (const m of search.matches) {
    const list = byFile.get(m.rel) ?? []
    list.push(m)
    byFile.set(m.rel, list)
    if (!damaged.has(m.rel)) parsedMatches++
  }
  if (parsedMatches > AST_BOUNDS.editMaxMatches) return { refused: tooManyMatches }
  const parsedFiles = [...byFile.keys()].filter(rel => !damaged.has(rel)).length
  if (parsedFiles > AST_BOUNDS.editMaxFiles) return { refused: tooManyFiles(parsedFiles) }
  const pastBound =
    search.matches.length > AST_BOUNDS.editMaxMatches
      ? { note: `more than ${AST_BOUNDS.editMaxMatches} matches in one edit`, refusal: tooManyMatches }
      : byFile.size > AST_BOUNDS.editMaxFiles
        ? { note: `more than the ${AST_BOUNDS.editMaxFiles}-file bound for one edit`, refusal: tooManyFiles(byFile.size) }
        : null
  const engine = await loadGrammarEngine()
  if (engine.state === 'unavailable') return { refused: engine.note }

  const patternCache: CompileCache = new Map()
  const rewriteCache: CompileCache = new Map()
  const shapeByLang = new Map<string, { pat: TSNode; rw: TSNode; standIn?: RegExp } | null>()
  const terminatorByLang = new Map<string, boolean>()
  const encodedPattern = encodePattern(singlePattern)
  const encodedRewrite = encodePattern(singleRewrite)

  const files: AstRewriteFile[] = []
  const leftOut: AstLeftOutFile[] = []
  let leftOutMatches = 0
  let unchangedMatches = 0
  let inPlaceMatches = 0
  for (const [rel, list] of [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (opts.signal?.aborted) {
      releaseCompiled(patternCache, rewriteCache)
      return { refused: 'cancelled before planning finished — nothing written.' }
    }
    const first = list[0]!
    const lang = scope.files.find(f => f.rel === rel)?.lang ?? patternLanguageForFile(first.abs)
    if (!lang) {
      releaseCompiled(patternCache, rewriteCache)
      return { refused: `${rel}: no grammar for this file (it should not have matched).` }
    }
    const recovery = search.recovered?.find(file => file.rel === rel)
    if (recovery && pastBound) {
      leftOut.push({ rel, ...pastBound })
      leftOutMatches += list.length
      continue
    }
    const spans = recovery?.errors ?? []
    let before: string
    try {
      before = recovery?.source ?? readFileSync(first.abs, 'utf8')
    } catch (err) {
      releaseCompiled(patternCache, rewriteCache)
      return { refused: `${rel}: unreadable — ${(err as Error).message}. Nothing was written.` }
    }
    list.sort((a, b) => a.startIndex - b.startIndex || b.endIndex - a.endIndex)
    let nested: AstLeftOutFile | null = null
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1]!
      const cur = list[i]!
      if (cur.startIndex < prev.endIndex) {
        const refusal =
          `Ambiguous rewrite in ${rel}: the match at line ${cur.startLine} sits inside the match at line ${prev.startLine} ` +
          `(${JSON.stringify(cur.text.split('\n')[0]!.slice(0, 60))} inside ${JSON.stringify(prev.text.split('\n')[0]!.slice(0, 60))}), ` +
          `so rewriting both would rewrite the same bytes twice. Narrow the pattern so matches do not nest, or split the scope. Nothing was written.`
        if (!recovery) {
          releaseCompiled(patternCache, rewriteCache)
          return { refused: refusal }
        }
        nested = { rel, note: `${cur.startLine}:${cur.startCol} the match sits inside the match at line ${prev.startLine}`, refusal }
        break
      }
    }
    if (nested) {
      leftOut.push(nested)
      leftOutMatches += list.length
      continue
    }
    if (recovery) {
      const dirty = list.find(match => match.hasSyntaxError || spans.length === 0 || spans.some(error => touchesParseError(match.startIndex, match.endIndex, error)))
      if (dirty) {
        leftOut.push({ rel, note: `${dirty.startLine}:${dirty.startCol} the match touches a syntax-error region`, refusal: `Cannot rewrite ${rel}:${dirty.startLine}:${dirty.startCol}: the match touches a syntax-error region. Nothing was written.` })
        leftOutMatches += list.length
        continue
      }
    }
    const shape = await shapeFor(engine, shapeByLang, singleRewrite, encodedPattern, encodedRewrite, patternCache, rewriteCache, lang)
    const keepsTerminator = await spansTerminator(engine, terminatorByLang, encodedPattern, patternCache, lang)
    let tree: { rootNode: TSNode; delete(): void } | null = null
    if (shape) {
      const parsed = await parsePolyglot(engine, lang, before)
      if (!('state' in parsed)) {
        if (parsed.parseErrors.length === 0 || recovery) tree = parsed.tree
        else parsed.tree.delete()
      }
    }
    const edits: Edit[] = []
    let unchangedInFile = 0
    let inPlaceInFile = 0
    try {
      for (const m of list) {
        const captureNames = m.captures.map(c => c.key)
        const substituted = substituteRewrite(
          singleRewrite,
          m.captures.map(c => ({ key: c.key, startIndex: 0, endIndex: 0, text: c.text })),
          captureNames.length > 0 ? captureNames : (search.captureNamesByLang.get(lang.name) ?? []),
        )
        if (typeof substituted !== 'string') {
          releaseCompiled(patternCache, rewriteCache)
          return {
            refused: `${rel}:${m.startLine}: the rewrite ${substituted.refuse.replace(/^out references /, 'references ')} — every meta-variable in the rewrite must be captured by the pattern. Nothing was written.`,
          }
        }
        const codeLength = before.slice(m.startIndex, m.endIndex).trimEnd().length
        const codeEnd = codeLength > 0 ? m.startIndex + codeLength : m.endIndex
        if (substituted === '') {
          const r = lineExtendedRange(before, m.startIndex, codeEnd)
          edits.push({ start: r.start, end: r.end, newText: '' })
          continue
        }
        if (shape && tree) {
          const codeNode = locateMatchNode(tree.rootNode, m, before)
          const local: Edit[] = []
          if (codeNode && alignEdits(shape.pat, shape.rw, codeNode, m.captures, local, shape.standIn)) {
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
                inPlaceInFile++
              }
              edits.push(...local)
              continue
            }
          }
        }
        let replacedEnd = codeEnd
        if (keepsTerminator && before[codeEnd - 1] === ';' && !substituted.trimEnd().endsWith(';')) {
          replacedEnd = m.startIndex + before.slice(m.startIndex, codeEnd - 1).trimEnd().length
        }
        const replacement = replacedEnd < m.endIndex ? substituted.trimEnd() : substituted
        if (replacement === before.slice(m.startIndex, replacedEnd)) {
          unchangedMatches++
          unchangedInFile++
          continue
        }
        edits.push({ start: m.startIndex, end: replacedEnd, newText: replacement })
      }
    } finally {
      tree?.delete()
    }
    edits.sort((a, b) => a.start - b.start)
    let sharing: AstLeftOutFile | null = null
    for (let i = 1; i < edits.length; i++) {
      if (edits[i]!.start < edits[i - 1]!.end) {
        const refusal = `Ambiguous rewrite in ${rel}: two deletions share a line — narrow the pattern. Nothing was written.`
        if (!recovery) {
          releaseCompiled(patternCache, rewriteCache)
          return { refused: refusal }
        }
        const match = list.find(m => edits[i]!.start <= m.endIndex && edits[i]!.end >= m.startIndex) ?? first
        sharing = { rel, note: `${match.startLine}:${match.startCol} two deletions share a line`, refusal }
        break
      }
    }
    if (sharing) {
      leftOut.push(sharing)
      leftOutMatches += list.length - unchangedInFile
      inPlaceMatches -= inPlaceInFile
      continue
    }
    if (recovery) {
      const touching = edits.find(edit => spans.some(error => touchesParseError(edit.start, edit.end, error)))
      if (touching) {
        const match = list.find(m => touching.start <= m.endIndex && touching.end >= m.startIndex) ?? first
        leftOut.push({ rel, note: `${match.startLine}:${match.startCol} the match touches a syntax-error region`, refusal: `Cannot rewrite ${rel}:${match.startLine}:${match.startCol}: the match touches a syntax-error region. Nothing was written.` })
        leftOutMatches += list.length - unchangedInFile
        inPlaceMatches -= inPlaceInFile
        continue
      }
    }
    const after = applyEdits(before, edits)
    if (after === before) continue
    {
      const reparsed = await parsePolyglot(engine, lang, after, recovery ? { errorRegions: true } : undefined)
      if ('state' in reparsed) {
        releaseCompiled(patternCache, rewriteCache)
        return { refused: `${rel}: ${reparsed.note}. Nothing was written.` }
      }
      const broken = reparsed.parseErrors.length > 0
      const firstError = reparsed.parseErrors[0]
      reparsed.tree.delete()
      if (recovery && broken && reparsed.errorRegions?.length) {
        const introduced = introducedParseError(before, after, edits, spans, reparsed.errorRegions)
        if (introduced) {
          leftOut.push({ rel, note: `${introduced.line}:${introduced.column} the rewrite would introduce a syntax error${introduced.missing ? `, missing ${introduced.type}` : ''}`, refusal: `The rewrite introduces a syntax error in ${rel} at ${introduced.line}:${introduced.column} (${introduced.missing ? `missing ${introduced.type}` : 'syntax error'}). Nothing was written.` })
          leftOutMatches += list.length - unchangedInFile
          inPlaceMatches -= inPlaceInFile
          continue
        }
      } else if (broken) {
        releaseCompiled(patternCache, rewriteCache)
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
  releaseCompiled(patternCache, rewriteCache)
  if (files.length === 0 && leftOut.length > 0 && unchangedMatches === 0) return { refused: leftOut[0]!.refusal }
  const token = rewritePlanToken(singlePattern, singleRewrite, files.map(f => [f.rel, f.digestBefore, f.digestAfter]), leftOut.map(f => f.rel))
  return {
    token,
    files,
    matchCount: search.matches.length - unchangedMatches - leftOutMatches,
    unchangedMatches,
    inPlaceMatches,
    search,
    ...(leftOut.length > 0 ? { leftOut } : {}),
  }
}
