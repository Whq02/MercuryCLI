import { readFileSync } from 'node:fs'
import { buildDiffHunks } from '../services/changeTransaction/diffBudget.js'
import { loadGrammarEngine, parsePolyglot, patternLanguageForFile, type PolyglotLanguage, type TSNode } from '../services/structure/grammarFacility.js'
import { encodePattern, findPatternMatches, substituteRewrite, type CompiledPattern } from '../services/structure/pattern.js'
import { compileFor } from '../services/structure/polyglotQuery.js'
import { applyEdits, digestOf, lineExtendedRange, type Edit } from '../services/structure/transform.js'
import { clipWithEllipsis } from './stringUtils.js'
import { AST_BOUNDS } from './astPatterns/languages.js'
import { type AstScope, type AstRefusal, isAstRefusal } from './astPatterns/scope.js'
import { type AstMatch, type AstSearchResult, preFilterToken, materialise, type CompileCache, farOverSizeBound, searchAstPattern, patternErrorText } from './astPatterns/search.js'
import { type AstRewriteRule, type AstBatchRuleSummary, type AstBatchCoalescedEdit, type AstBatchFileChange, type AstRewriteFile, type AstLeftOutFile, type AstRewritePlan, sameShape, alignEdits, uncapturedCommentSpans, locateMatchNode, ANON_IN_REWRITE, rewritePlanToken, unifiedDiff, countChangedLines, touchesParseError, introducedParseError, batchRewritePlanToken } from './astPatterns/rewriteParts.js'

export { AST_BOUNDS, availableAstLanguages, astLanguageNames, GRAMMAR_PACK_REMEDY, resolveAstLanguage, PATTERN_GRAMMAR_LINES, PATTERN_EXAMPLES, LANGUAGE_PATTERN_EXAMPLES } from './astPatterns/languages.js'
export { isAstRefusal, resolveAstScope, describeSkipped } from './astPatterns/scope.js'
export type { AstScopeFile, AstScope, AstRefusal } from './astPatterns/scope.js'
export { searchAstPattern, patternRefusedEverywhere, patternErrorText } from './astPatterns/search.js'
export type { AstCapture, AstMatch, AstSearchResult } from './astPatterns/search.js'
export { rewritePlanToken, unifiedDiff } from './astPatterns/rewriteParts.js'
export type { AstRewriteRule, AstRewriteFile, AstLeftOutFile, AstRewritePlan } from './astPatterns/rewriteParts.js'
export { renderLeftOut, matchLocation, renderMatch, renderSearchTrailer } from './astPatterns/render.js'

export { digestOf }

async function planAstBatchRewrite(
  scope: AstScope,
  rules: ReadonlyArray<AstRewriteRule>,
  signal?: AbortSignal,
): Promise<AstRewritePlan | AstRefusal> {
  if (rules.length === 0) {
    return { refused: 'Pass either pattern and rewrite for one rule, or a non-empty rules array of { pattern, rewrite } pairs, never both.' }
  }
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i]!
    if (rule.pattern.trim() === '') {
      return { refused: `Rule ${i}: pattern is empty — give a structural pattern such as "oldName($$$ARGS)".` }
    }
    if (ANON_IN_REWRITE.test(rule.rewrite)) {
      return {
        refused: `Rule ${i} (${JSON.stringify(rule.pattern)}): The rewrite uses an anonymous meta-variable ($$$ or $_), which captures nothing and so cannot be inserted. Name it in both the pattern and the rewrite (for example $$$ARGS), or drop it from the rewrite.`,
      }
    }
  }
  const engine = await loadGrammarEngine()
  if (engine.state === 'unavailable') return { refused: engine.note }

  interface RuleState {
    index: number
    rule: AstRewriteRule
    encodedPattern: ReturnType<typeof encodePattern>
    encodedRewrite: ReturnType<typeof encodePattern>
    preToken: string | null
    patternCache: CompileCache
    rewriteCache: CompileCache
    shapeByLang: Map<string, { pat: TSNode; rw: TSNode; standIn?: RegExp } | null>
    terminatorByLang: Map<string, boolean>
    refusedLangs: Map<string, { files: number; note: string; textOnly?: boolean }>
    langFiles: Map<string, number>
    compiledSomewhere: boolean
    skippedBeforeCompile: boolean
    matched: boolean
    changedMatches: number
    unchangedMatches: number
    filesChanged: Set<string>
  }

  const ruleStates: RuleState[] = rules.map((rule, index) => ({
    index,
    rule: { pattern: rule.pattern, rewrite: rule.rewrite },
    encodedPattern: encodePattern(rule.pattern),
    encodedRewrite: encodePattern(rule.rewrite),
    preToken: preFilterToken(rule.pattern),
    patternCache: new Map(),
    rewriteCache: new Map(),
    shapeByLang: new Map(),
    terminatorByLang: new Map(),
    refusedLangs: new Map(),
    langFiles: new Map(),
    compiledSomewhere: false,
    skippedBeforeCompile: false,
    matched: false,
    changedMatches: 0,
    unchangedMatches: 0,
    filesChanged: new Set(),
  }))

  const releaseCompiled = (): void => {
    for (const r of ruleStates) {
      for (const cache of [r.patternCache, r.rewriteCache]) {
        for (const entry of cache.values()) {
          if (!('state' in entry)) entry.hold.delete()
        }
      }
    }
  }

  async function spansTerminatorFor(r: RuleState, lang: PolyglotLanguage): Promise<boolean> {
    const cached = r.terminatorByLang.get(lang.name)
    if (cached !== undefined) return cached
    const pat = await compileFor(engine as Parameters<typeof compileFor>[0], lang, r.encodedPattern, r.patternCache)
    const spans = !('state' in pat) && pat.pattern.spansTerminator === true
    r.terminatorByLang.set(lang.name, spans)
    return spans
  }

  async function shapeForRule(r: RuleState, lang: PolyglotLanguage): Promise<{ pat: TSNode; rw: TSNode; standIn?: RegExp } | null> {
    const cached = r.shapeByLang.get(lang.name)
    if (cached !== undefined) return cached
    let shape: { pat: TSNode; rw: TSNode; standIn?: RegExp } | null = null
    if (r.rule.rewrite.trim() !== '') {
      const pat = await compileFor(engine as Parameters<typeof compileFor>[0], lang, r.encodedPattern, r.patternCache)
      const rw = await compileFor(engine as Parameters<typeof compileFor>[0], lang, r.encodedRewrite, r.rewriteCache)
      if (!('state' in pat) && !('state' in rw) && !pat.pattern.tagMetavars && !rw.pattern.tagMetavars && sameShape(pat.pattern.root, rw.pattern.root, pat.pattern.standIn, rw.pattern.standIn)) {
        shape = { pat: pat.pattern.root, rw: rw.pattern.root, ...(pat.pattern.standIn && { standIn: pat.pattern.standIn }) }
      }
    }
    r.shapeByLang.set(lang.name, shape)
    return shape
  }

  interface CandidateEdit {
    ruleIndex: number
    pattern: string
    startLine: number
    startCol: number
    matchStart: number
    matchEnd: number
    matchNewText: string
    unchanged: boolean
    inPlace: boolean
    subEdits: Edit[]
  }

  interface MergedEdit extends CandidateEdit {
    ruleIndices: number[]
  }

  const globalLangFiles = new Map<string, number>()
  const parseFailures: Array<{ rel: string; message: string }> = []
  let recovered: AstSearchResult['recovered']
  const plannedFiles: AstRewriteFile[] = []
  const coalesced: AstBatchCoalescedEdit[] = []
  const fileChanges = new Map<string, AstBatchFileChange[]>()
  let filesParsed = 0
  let filesWithMatches = 0
  let skippedLarge = 0
  let truncatedParse = false
  let totalChangedMatches = 0
  let totalUnchangedMatches = 0
  let totalInPlaceMatches = 0
  let deferredRefusal: string | null = null
  const leftOut: AstLeftOutFile[] = []
  const held: Array<{ rel: string; changed: number; admit?: () => void }> = []
  let heldMatches = 0
  let damagedOver = false

  for (const file of scope.files) {
    if (signal?.aborted) {
      releaseCompiled()
      return { refused: 'cancelled before planning finished — nothing written.' }
    }
    if (filesParsed >= AST_BOUNDS.maxFilesParsed) {
      truncatedParse = true
      break
    }
    let before: string | undefined
    let fileCountedLarge = false
    let fileAcceptedByAnyRule = false
    const compiledForFile: Array<{ r: RuleState; compiled: { pattern: CompiledPattern; hold: { delete(): void } } }> = []

    for (const r of ruleStates) {
      if (file.lang.patternOnly && r.preToken && !r.patternCache.has(file.lang.name)) {
        if (before === undefined) {
          if (farOverSizeBound(file.abs)) {
            if (!fileCountedLarge) {
              skippedLarge++
              fileCountedLarge = true
            }
            r.skippedBeforeCompile = true
            continue
          }
          try {
            before = readFileSync(file.abs, 'utf8')
          } catch (err) {
            releaseCompiled()
            return { refused: `${file.rel}: unreadable — ${(err as Error).message}. Nothing was written.` }
          }
          if (before.length > AST_BOUNDS.maxFileBytes) {
            if (!fileCountedLarge) {
              skippedLarge++
              fileCountedLarge = true
            }
            r.skippedBeforeCompile = true
            continue
          }
        }
        if (!before.includes(r.preToken)) {
          r.langFiles.set(file.lang.name, (r.langFiles.get(file.lang.name) ?? 0) + 1)
          fileAcceptedByAnyRule = true
          continue
        }
      }
      const compiled = await compileFor(engine, file.lang, r.encodedPattern, r.patternCache)
      if ('state' in compiled) {
        const entry = r.refusedLangs.get(file.lang.name) ?? {
          files: r.langFiles.get(file.lang.name) ?? 0,
          note: compiled.note,
          ...(compiled.textOnly && { textOnly: true }),
        }
        entry.files++
        r.refusedLangs.set(file.lang.name, entry)
        r.langFiles.delete(file.lang.name)
        continue
      }
      r.compiledSomewhere = true
      const subCheck = substituteRewrite(r.rule.rewrite, [], compiled.pattern.captureNames)
      if (typeof subCheck !== 'string') {
        releaseCompiled()
        return {
          refused: `Rule ${r.index} (${JSON.stringify(r.rule.pattern)} → ${JSON.stringify(r.rule.rewrite)}): the rewrite ${subCheck.refuse.replace(/^out references /, 'references ')} — every meta-variable in the rewrite must be captured by the pattern. Nothing was written.`,
        }
      }
      compiledForFile.push({ r, compiled })
    }

    if (fileCountedLarge) continue
    if (compiledForFile.length === 0) {
      if (fileAcceptedByAnyRule && ruleStates.some(r => !r.refusedLangs.has(file.lang.name))) {
        globalLangFiles.set(file.lang.name, (globalLangFiles.get(file.lang.name) ?? 0) + 1)
      }
      continue
    }
    if (before === undefined) {
      if (file.lang.patternOnly && farOverSizeBound(file.abs)) {
        skippedLarge++
        continue
      }
      try {
        before = readFileSync(file.abs, 'utf8')
      } catch (err) {
        releaseCompiled()
        return { refused: `${file.rel}: unreadable — ${(err as Error).message}. Nothing was written.` }
      }
      if (before.length > AST_BOUNDS.maxFileBytes) {
        skippedLarge++
        continue
      }
    }
    for (const { r } of compiledForFile) {
      r.langFiles.set(file.lang.name, (r.langFiles.get(file.lang.name) ?? 0) + 1)
    }
    globalLangFiles.set(file.lang.name, (globalLangFiles.get(file.lang.name) ?? 0) + 1)
    if (deferredRefusal !== null) continue

    const matchingRules = compiledForFile.filter(({ r }) => !r.preToken || before!.includes(r.preToken))
    if (matchingRules.length === 0) continue

    filesParsed++
    const parsed = await parsePolyglot(engine, file.lang, before, { errorRegions: true })
    if ('state' in parsed) {
      parseFailures.push({ rel: file.rel, message: parsed.note })
      continue
    }
    try {
      const hasErrors = parsed.parseErrors.length > 0
      const recoveryEntry = hasErrors ? { rel: file.rel, lang: file.lang.name, errors: parsed.errorRegions ?? [], diagnostics: parsed.errorRegions?.length ?? 0, notes: parsed.parseErrors } : undefined
      if (recoveryEntry) (recovered ??= []).push({ rel: recoveryEntry.rel, lang: recoveryEntry.lang, diagnostics: recoveryEntry.diagnostics, notes: recoveryEntry.notes })

      const candidates: CandidateEdit[] = []
      let left: AstLeftOutFile | null = null
      let over = false
      const markUnreadRules = (): void => {
        for (const { r, compiled } of matchingRules) {
          if (!r.matched && findPatternMatches(compiled.pattern, parsed.tree.rootNode, before!, 1).matches.length > 0) r.matched = true
        }
      }
      for (const { r, compiled } of matchingRules) {
        const found = findPatternMatches(compiled.pattern, parsed.tree.rootNode, before, AST_BOUNDS.editMaxMatches + 1)
        if (found.matches.length > 0) r.matched = true
        if (found.matches.length > AST_BOUNDS.editMaxMatches) {
          if (recoveryEntry) over = true
          else deferredRefusal ??= `More than ${AST_BOUNDS.editMaxMatches} matches in one edit — narrow the scope (path or glob) or the rules, then run again. Nothing was written.`
          break
        }
        if (found.matches.length === 0) continue
        const shape = await shapeForRule(r, file.lang)
        const keepsTerminator = await spansTerminatorFor(r, file.lang)
        for (const rawMatch of found.matches) {
          const m = materialise(file.rel, file.abs, file.lang.name, rawMatch.node, rawMatch.captures)
          const hasSyntaxError = hasErrors && (rawMatch.node.type === 'ERROR' || rawMatch.node.isMissing || rawMatch.node.hasError)
          if (recoveryEntry && (hasSyntaxError || recoveryEntry.errors.length === 0 || recoveryEntry.errors.some(error => touchesParseError(m.startIndex, m.endIndex, error)))) {
            left = { rel: file.rel, note: `${m.startLine}:${m.startCol} the match touches a syntax-error region`, refusal: `Cannot rewrite ${file.rel}:${m.startLine}:${m.startCol} (rule ${r.index}): the match touches a syntax-error region. Nothing was written.` }
            break
          }
          const substituted = substituteRewrite(
            r.rule.rewrite,
            m.captures.map(c => ({ key: c.key, startIndex: 0, endIndex: 0, text: c.text })),
            compiled.pattern.captureNames,
          )
          if (typeof substituted !== 'string') {
            deferredRefusal ??= `Rule ${r.index} at ${file.rel}:${m.startLine}: the rewrite ${substituted.refuse.replace(/^out references /, 'references ')} — every meta-variable in the rewrite must be captured by the pattern. Nothing was written.`
            break
          }
          const codeLength = before.slice(m.startIndex, m.endIndex).trimEnd().length
          const codeEnd = codeLength > 0 ? m.startIndex + codeLength : m.endIndex
          if (substituted === '') {
            const ext = lineExtendedRange(before, m.startIndex, codeEnd)
            candidates.push({
              ruleIndex: r.index,
              pattern: r.rule.pattern,
              startLine: m.startLine,
              startCol: m.startCol,
              matchStart: ext.start,
              matchEnd: ext.end,
              matchNewText: '',
              unchanged: false,
              inPlace: false,
              subEdits: [{ start: ext.start, end: ext.end, newText: '' }],
            })
            continue
          }
          if (shape) {
            const codeNode = locateMatchNode(parsed.tree.rootNode, m, before)
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
                  candidates.push({
                    ruleIndex: r.index,
                    pattern: r.rule.pattern,
                    startLine: m.startLine,
                    startCol: m.startCol,
                    matchStart: m.startIndex,
                    matchEnd: codeEnd,
                    matchNewText: before.slice(m.startIndex, codeEnd),
                    unchanged: true,
                    inPlace: false,
                    subEdits: [],
                  })
                } else {
                  const matchNewText = applyEdits(
                    before.slice(m.startIndex, codeEnd),
                    local.map(e => ({ start: e.start - m.startIndex, end: e.end - m.startIndex, newText: e.newText })),
                  )
                  candidates.push({
                    ruleIndex: r.index,
                    pattern: r.rule.pattern,
                    startLine: m.startLine,
                    startCol: m.startCol,
                    matchStart: m.startIndex,
                    matchEnd: codeEnd,
                    matchNewText,
                    unchanged: false,
                    inPlace: true,
                    subEdits: local,
                  })
                }
                continue
              }
            }
          }
          let replacedEnd = codeEnd
          if (keepsTerminator && before[codeEnd - 1] === ';' && !substituted.trimEnd().endsWith(';')) {
            replacedEnd = m.startIndex + before.slice(m.startIndex, codeEnd - 1).trimEnd().length
          }
          const replacement = replacedEnd < m.endIndex ? substituted.trimEnd() : substituted
          const isUnchanged = replacement === before.slice(m.startIndex, replacedEnd)
          candidates.push({
            ruleIndex: r.index,
            pattern: r.rule.pattern,
            startLine: m.startLine,
            startCol: m.startCol,
            matchStart: m.startIndex,
            matchEnd: replacedEnd,
            matchNewText: replacement,
            unchanged: isUnchanged,
            inPlace: false,
            subEdits: isUnchanged ? [] : [{ start: m.startIndex, end: replacedEnd, newText: replacement }],
          })
        }
        if (deferredRefusal !== null || left) break
      }
      if (left) {
        markUnreadRules()
        leftOut.push(left)
        continue
      }
      if (over) {
        markUnreadRules()
        damagedOver = true
        held.push({ rel: file.rel, changed: 0 })
        continue
      }
      if (deferredRefusal !== null || candidates.length === 0) continue
      if (recoveryEntry && (damagedOver || totalChangedMatches + heldMatches > AST_BOUNDS.editMaxMatches || plannedFiles.length + held.length > AST_BOUNDS.editMaxFiles)) {
        held.push({ rel: file.rel, changed: 0 })
        continue
      }

      filesWithMatches++
      candidates.sort((a, b) => a.matchStart - b.matchStart || a.matchEnd - b.matchEnd || a.ruleIndex - b.ruleIndex)
      const merged: MergedEdit[] = []
      for (const cand of candidates) {
        let coalescedHere = false
        for (const prev of merged) {
          if (prev.matchStart === cand.matchStart && prev.matchEnd === cand.matchEnd && prev.matchNewText === cand.matchNewText) {
            if (!prev.ruleIndices.includes(cand.ruleIndex)) prev.ruleIndices.push(cand.ruleIndex)
            coalescedHere = true
            break
          }
          const overlaps =
            prev.matchStart === prev.matchEnd || cand.matchStart === cand.matchEnd
              ? prev.matchStart <= cand.matchEnd && cand.matchStart <= prev.matchEnd
              : prev.matchStart < cand.matchEnd && cand.matchStart < prev.matchEnd
          if (overlaps) {
            const firstRule = prev.ruleIndices[0]!
            const patA = clipWithEllipsis(rules[firstRule]!.pattern.replace(/\s+/g, ' '), 60)
            const patB = clipWithEllipsis(cand.pattern.replace(/\s+/g, ' '), 60)
            const overlapping =
              `Overlapping rewrites in ${file.rel}: rule ${firstRule} (${JSON.stringify(patA)}) at ${prev.startLine}:${prev.startCol} ` +
              `and rule ${cand.ruleIndex} (${JSON.stringify(patB)}) at ${cand.startLine}:${cand.startCol} touch the same source span with different replacements. ` +
              `Narrow the rules so their matches do not overlap. Nothing was written.`
            if (recoveryEntry) left = { rel: file.rel, note: `${cand.startLine}:${cand.startCol} rule ${firstRule} and rule ${cand.ruleIndex} touch the same source span with different replacements`, refusal: overlapping }
            else deferredRefusal = overlapping
            break
          }
        }
        if (deferredRefusal !== null || left) break
        if (!coalescedHere) merged.push({ ...cand, ruleIndices: [cand.ruleIndex] })
      }
      if (left) {
        leftOut.push(left)
        continue
      }
      if (deferredRefusal !== null) continue

      const unchangedItems = merged.filter(c => c.unchanged)
      const changedItems = merged.filter(c => !c.unchanged)
      for (const u of unchangedItems) {
        totalUnchangedMatches++
        for (const ri of u.ruleIndices) ruleStates[ri]!.unchangedMatches++
      }
      if (changedItems.length === 0) continue

      const edits = changedItems.flatMap(c => c.subEdits).sort((a, b) => a.start - b.start)
      for (let i = 1; i < edits.length; i++) {
        if (edits[i]!.start < edits[i - 1]!.end) {
          const sharing = `Ambiguous rewrite in ${file.rel}: two deletions share a line — narrow the rules so their matches do not overlap. Nothing was written.`
          const item = changedItems.find(c => edits[i]!.start <= c.matchEnd && edits[i]!.end >= c.matchStart) ?? changedItems[0]!
          if (recoveryEntry) left = { rel: file.rel, note: `${item.startLine}:${item.startCol} two deletions share a line`, refusal: sharing }
          else deferredRefusal = sharing
          break
        }
      }
      if (left) {
        leftOut.push(left)
        continue
      }
      if (deferredRefusal !== null) continue

      if (recoveryEntry) {
        const touching = edits.find(edit => recoveryEntry.errors.some(error => touchesParseError(edit.start, edit.end, error)))
        if (touching) {
          const item = changedItems.find(c => touching.start <= c.matchEnd && touching.end >= c.matchStart) ?? changedItems[0]!
          leftOut.push({ rel: file.rel, note: `${item.startLine}:${item.startCol} the match touches a syntax-error region`, refusal: `Cannot rewrite ${file.rel}:${item.startLine}:${item.startCol} (rule ${item.ruleIndices[0]}): the match touches a syntax-error region. Nothing was written.` })
          continue
        }
      }

      const after = applyEdits(before, edits)
      if (after === before) continue

      const reparsed = await parsePolyglot(engine, file.lang, after, recoveryEntry ? { errorRegions: true } : undefined)
      if ('state' in reparsed) {
        deferredRefusal = `${file.rel}: ${reparsed.note}. Nothing was written.`
        continue
      }
      const broken = reparsed.parseErrors.length > 0
      const firstError = reparsed.parseErrors[0]
      reparsed.tree.delete()
      if (recoveryEntry && broken && reparsed.errorRegions?.length) {
        const introduced = introducedParseError(before, after, edits, recoveryEntry.errors, reparsed.errorRegions)
        if (introduced) {
          leftOut.push({ rel: file.rel, note: `${introduced.line}:${introduced.column} the rewrite would introduce a syntax error${introduced.missing ? `, missing ${introduced.type}` : ''}`, refusal: `The rewrite introduces a syntax error in ${file.rel} at ${introduced.line}:${introduced.column} (${introduced.missing ? `missing ${introduced.type}` : 'syntax error'}). Nothing was written.` })
          continue
        }
      } else if (broken) {
        deferredRefusal = `The rewrite would leave ${file.rel} unparsable as ${file.lang.name} (${firstError}) — adjust the rewrite so the result is valid code. Nothing was written.`
        continue
      }

      const original = before
      const admit = (): void => {
        for (const item of changedItems) {
          if (item.inPlace) totalInPlaceMatches++
          if (item.ruleIndices.length > 1) {
            coalesced.push({ rel: file.rel, line: item.startLine, col: item.startCol, ruleIndices: [...item.ruleIndices] })
          }
          for (const ri of item.ruleIndices) {
            ruleStates[ri]!.changedMatches++
            ruleStates[ri]!.filesChanged.add(file.rel)
          }
        }
        fileChanges.set(
          file.rel,
          changedItems.map(item => ({ line: item.startLine, col: item.startCol, ruleIndices: [...item.ruleIndices] })),
        )
        const diff = unifiedDiff(file.rel, original, after)
        const { hunks, omittedHunks } = buildDiffHunks(file.rel, original, after)
        plannedFiles.push({
          rel: file.rel,
          abs: file.abs,
          lang: file.lang.name,
          matchCount: changedItems.length,
          before: original,
          after,
          digestBefore: digestOf(original),
          digestAfter: digestOf(after),
          diff: diff.text,
          diffOmittedLines: diff.omittedLines,
          hunks,
          omittedHunks,
          changedLines: countChangedLines(original, after, edits),
          edits,
        })
      }
      if (recoveryEntry) {
        heldMatches += changedItems.length
        held.push({ rel: file.rel, changed: changedItems.length, admit })
        continue
      }
      totalChangedMatches += changedItems.length
      if (totalChangedMatches > AST_BOUNDS.editMaxMatches) {
        deferredRefusal = `More than ${AST_BOUNDS.editMaxMatches} matches in one edit — narrow the scope (path or glob) or the rules, then run again. Nothing was written.`
        continue
      }
      admit()
    } finally {
      parsed.tree.delete()
    }
  }

  releaseCompiled()

  if (scope.files.length > 0) {
    for (const r of ruleStates) {
      if (!r.compiledSomewhere && !r.skippedBeforeCompile && r.refusedLangs.size > 0) {
        const refusals = [...r.refusedLangs.entries()]
          .sort((a, b) => Number(a[1].textOnly === true) - Number(b[1].textOnly === true))
          .map(([lang, e]) => ({ lang, files: e.files, note: e.note }))
        const ruleSearch: AstSearchResult = {
          matches: [],
          capped: false,
          filesParsed: 0,
          filesWithMatches: 0,
          parseFailures: [],
          patternRefusals: refusals,
          captureNamesByLang: new Map(),
          skippedLarge: 0,
          truncatedParse: false,
          languagesSearched: [],
          compiledSomewhere: false,
        }
        return { refused: `Rule ${r.index}: ${patternErrorText(r.rule.pattern, ruleSearch)}` }
      }
    }
  }

  if (deferredRefusal !== null) return { refused: deferredRefusal }
  if (held.length > 0) {
    const pastMatches = damagedOver || totalChangedMatches + heldMatches > AST_BOUNDS.editMaxMatches
    if (pastMatches || plannedFiles.length + held.length > AST_BOUNDS.editMaxFiles) {
      const refusal = pastMatches
        ? `More than ${AST_BOUNDS.editMaxMatches} matches in one edit — narrow the scope (path or glob) or the rules, then run again. Nothing was written.`
        : `Matches in ${plannedFiles.length + held.length} files, more than the ${AST_BOUNDS.editMaxFiles}-file bound for one edit — narrow the scope (path or glob), then run again. Nothing was written.`
      if (plannedFiles.length === 0) return { refused: refusal }
      const note = pastMatches ? `more than ${AST_BOUNDS.editMaxMatches} matches in one edit` : `more than the ${AST_BOUNDS.editMaxFiles}-file bound for one edit`
      for (const file of held) leftOut.push({ rel: file.rel, note, refusal })
    } else {
      for (const file of held) {
        totalChangedMatches += file.changed
        file.admit?.()
      }
    }
  }
  if (plannedFiles.length === 0 && leftOut.length > 0 && totalUnchangedMatches === 0) return { refused: leftOut[0]!.refusal }
  if (plannedFiles.length > AST_BOUNDS.editMaxFiles) {
    return {
      refused: `Matches in ${plannedFiles.length} files, more than the ${AST_BOUNDS.editMaxFiles}-file bound for one edit — narrow the scope (path or glob), then run again. Nothing was written.`,
    }
  }

  plannedFiles.sort((a, b) => a.rel.localeCompare(b.rel))
  coalesced.sort((a, b) => a.rel.localeCompare(b.rel) || a.line - b.line || a.col - b.col)

  const ruleSummaries: AstBatchRuleSummary[] = ruleStates.map(r => ({
    ruleIndex: r.index,
    pattern: r.rule.pattern,
    rewrite: r.rule.rewrite,
    changedMatches: r.changedMatches,
    unchangedMatches: r.unchangedMatches,
    filesChanged: r.filesChanged.size,
    patternRefusals: [...r.refusedLangs.entries()]
      .sort((a, b) => Number(a[1].textOnly === true) - Number(b[1].textOnly === true))
      .map(([lang, e]) => ({ lang, files: e.files, note: e.note })),
  }))

  const unmatchedRules = ruleStates.filter(r => !r.matched).map(r => r.index)

  const attributedRefusals = ruleStates.flatMap(r =>
    [...r.refusedLangs.entries()]
      .sort((a, b) => Number(a[1].textOnly === true) - Number(b[1].textOnly === true))
      .map(([lang, e]) => ({ lang, files: e.files, note: `rule ${r.index}: ${e.note}` })),
  )

  const search: AstSearchResult = {
    matches: [],
    capped: false,
    filesParsed,
    filesWithMatches,
    parseFailures,
    ...(recovered ? { recovered } : {}),
    patternRefusals: attributedRefusals,
    captureNamesByLang: new Map(),
    skippedLarge,
    truncatedParse,
    languagesSearched: [...globalLangFiles.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    compiledSomewhere: ruleStates.some(r => r.compiledSomewhere),
  }

  leftOut.sort((a, b) => a.rel.localeCompare(b.rel))
  const token = batchRewritePlanToken(rules, scope, plannedFiles.map(f => [f.rel, f.digestBefore, f.digestAfter]), leftOut.map(f => f.rel))
  return {
    token,
    files: plannedFiles,
    matchCount: totalChangedMatches,
    unchangedMatches: totalUnchangedMatches,
    inPlaceMatches: totalInPlaceMatches,
    search,
    batch: {
      rules: ruleSummaries,
      coalesced,
      unmatchedRules,
      fileChanges,
    },
    ...(leftOut.length > 0 ? { leftOut } : {}),
  }
}

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
  async function spansTerminator(lang: PolyglotLanguage): Promise<boolean> {
    const cached = terminatorByLang.get(lang.name)
    if (cached !== undefined) return cached
    const pat = await compileFor(engine as Parameters<typeof compileFor>[0], lang, encodedPattern, patternCache)
    const spans = !('state' in pat) && pat.pattern.spansTerminator === true
    terminatorByLang.set(lang.name, spans)
    return spans
  }
  async function shapeFor(lang: PolyglotLanguage): Promise<{ pat: TSNode; rw: TSNode; standIn?: RegExp } | null> {
    const cached = shapeByLang.get(lang.name)
    if (cached !== undefined) return cached
    let shape: { pat: TSNode; rw: TSNode; standIn?: RegExp } | null = null
    if (singleRewrite.trim() !== '') {
      const pat = await compileFor(engine as Parameters<typeof compileFor>[0], lang, encodedPattern, patternCache)
      const rw = await compileFor(engine as Parameters<typeof compileFor>[0], lang, encodedRewrite, rewriteCache)
      if (!('state' in pat) && !('state' in rw) && !pat.pattern.tagMetavars && !rw.pattern.tagMetavars && sameShape(pat.pattern.root, rw.pattern.root, pat.pattern.standIn, rw.pattern.standIn)) {
        shape = { pat: pat.pattern.root, rw: rw.pattern.root, ...(pat.pattern.standIn && { standIn: pat.pattern.standIn }) }
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
  const leftOut: AstLeftOutFile[] = []
  let leftOutMatches = 0
  let unchangedMatches = 0
  let inPlaceMatches = 0
  for (const [rel, list] of [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (opts.signal?.aborted) {
      releaseCompiled()
      return { refused: 'cancelled before planning finished — nothing written.' }
    }
    const first = list[0]!
    const lang = scope.files.find(f => f.rel === rel)?.lang ?? patternLanguageForFile(first.abs)
    if (!lang) {
      releaseCompiled()
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
      releaseCompiled()
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
          releaseCompiled()
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
    const shape = await shapeFor(lang)
    const keepsTerminator = await spansTerminator(lang)
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
          releaseCompiled()
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
          releaseCompiled()
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
        releaseCompiled()
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
