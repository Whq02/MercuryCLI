import { readFileSync } from 'node:fs'
import { buildDiffHunks } from '../../change-transaction/diffBudget.js'
import { loadGrammarEngine, parsePolyglot, type PolyglotLanguage, type TSNode } from '../../../../platform/grammars/grammarFacility.js'
import { encodePattern, findPatternMatches, substituteRewrite, type CompiledPattern } from '../pattern.js'
import { compileFor } from '../polyglotQuery.js'
import { applyEdits, digestOf, lineExtendedRange, type Edit } from '../transform.js'
import { clipWithEllipsis } from '../../../../platform/text/strings.js'
import { AST_BOUNDS } from './languages.js'
import type { AstScope, AstScopeFile, AstRefusal } from './scope.js'
import { type AstMatch, type AstSearchResult, preFilterToken, materialise, type CompileCache, farOverSizeBound, patternErrorText } from './search.js'
import { type AstRewriteRule, type AstBatchRuleSummary, type AstBatchCoalescedEdit, type AstBatchFileChange, type AstRewriteFile, type AstLeftOutFile, type AstRewritePlan, sameShape, alignEdits, uncapturedCommentSpans, locateMatchNode, ANON_IN_REWRITE, unifiedDiff, countChangedLines, touchesParseError, introducedParseError, batchRewritePlanToken } from './rewriteParts.js'

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

interface BatchRun {
  globalLangFiles: Map<string, number>
  parseFailures: Array<{ rel: string; message: string }>
  recovered: AstSearchResult['recovered']
  plannedFiles: AstRewriteFile[]
  coalesced: AstBatchCoalescedEdit[]
  fileChanges: Map<string, AstBatchFileChange[]>
  filesParsed: number
  filesWithMatches: number
  skippedLarge: number
  truncatedParse: boolean
  totalChangedMatches: number
  totalUnchangedMatches: number
  totalInPlaceMatches: number
  deferredRefusal: string | null
  leftOut: AstLeftOutFile[]
  held: Array<{ rel: string; changed: number; admit?: () => void }>
  heldMatches: number
  damagedOver: boolean
}

function batchRunOf(): BatchRun {
  return {
    globalLangFiles: new Map(),
    parseFailures: [],
    recovered: undefined,
    plannedFiles: [],
    coalesced: [],
    fileChanges: new Map(),
    filesParsed: 0,
    filesWithMatches: 0,
    skippedLarge: 0,
    truncatedParse: false,
    totalChangedMatches: 0,
    totalUnchangedMatches: 0,
    totalInPlaceMatches: 0,
    deferredRefusal: null,
    leftOut: [],
    held: [],
    heldMatches: 0,
    damagedOver: false,
  }
}

function ruleStatesOf(rules: ReadonlyArray<AstRewriteRule>): RuleState[] {
  return rules.map((rule, index) => ({
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
}

function releaseCompiled(ruleStates: RuleState[]): void {
  for (const r of ruleStates) {
    for (const cache of [r.patternCache, r.rewriteCache]) {
      for (const entry of cache.values()) {
        if (!('state' in entry)) entry.hold.delete()
      }
    }
  }
}

async function spansTerminatorFor(engine: Parameters<typeof parsePolyglot>[0], r: RuleState, lang: PolyglotLanguage): Promise<boolean> {
  const cached = r.terminatorByLang.get(lang.name)
  if (cached !== undefined) return cached
  const pat = await compileFor(engine as Parameters<typeof compileFor>[0], lang, r.encodedPattern, r.patternCache)
  const spans = !('state' in pat) && pat.pattern.spansTerminator === true
  r.terminatorByLang.set(lang.name, spans)
  return spans
}

async function shapeForRule(engine: Parameters<typeof parsePolyglot>[0], r: RuleState, lang: PolyglotLanguage): Promise<{ pat: TSNode; rw: TSNode; standIn?: RegExp } | null> {
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

function pushCandidate(candidates: CandidateEdit[], r: RuleState, m: AstMatch, substituted: string, before: string, shape: { pat: TSNode; rw: TSNode; standIn?: RegExp } | null, keepsTerminator: boolean, parsed: { tree: { rootNode: TSNode } }): void {
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
    return
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
        return
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

function mergeCandidates(candidates: CandidateEdit[], rules: ReadonlyArray<AstRewriteRule>, file: AstScopeFile, recoveryEntry: object | undefined): { merged: MergedEdit[]; left: AstLeftOutFile | null; deferredRefusal: string | null } {
  let left: AstLeftOutFile | null = null
  let deferredRefusal: string | null = null
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
  return { merged, left, deferredRefusal }
}

async function planBatchFile(
  engine: Parameters<typeof parsePolyglot>[0],
  file: AstScopeFile,
  before: string,
  matchingRules: Array<{ r: RuleState; compiled: { pattern: CompiledPattern; hold: { delete(): void } } }>,
  rules: ReadonlyArray<AstRewriteRule>,
  ruleStates: RuleState[],
  run: BatchRun,
): Promise<void> {
  run.filesParsed++
  const parsed = await parsePolyglot(engine, file.lang, before, { errorRegions: true })
  if ('state' in parsed) {
    run.parseFailures.push({ rel: file.rel, message: parsed.note })
    return
  }
  try {
    const hasErrors = parsed.parseErrors.length > 0
    const recoveryEntry = hasErrors ? { rel: file.rel, lang: file.lang.name, errors: parsed.errorRegions ?? [], diagnostics: parsed.errorRegions?.length ?? 0, notes: parsed.parseErrors } : undefined
    if (recoveryEntry) (run.recovered ??= []).push({ rel: recoveryEntry.rel, lang: recoveryEntry.lang, diagnostics: recoveryEntry.diagnostics, notes: recoveryEntry.notes })

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
        else run.deferredRefusal ??= `More than ${AST_BOUNDS.editMaxMatches} matches in one edit — narrow the scope (path or glob) or the rules, then run again. Nothing was written.`
        break
      }
      if (found.matches.length === 0) continue
      const shape = await shapeForRule(engine, r, file.lang)
      const keepsTerminator = await spansTerminatorFor(engine, r, file.lang)
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
          run.deferredRefusal ??= `Rule ${r.index} at ${file.rel}:${m.startLine}: the rewrite ${substituted.refuse.replace(/^out references /, 'references ')} — every meta-variable in the rewrite must be captured by the pattern. Nothing was written.`
          break
        }
        pushCandidate(candidates, r, m, substituted, before, shape, keepsTerminator, parsed)
      }
      if (run.deferredRefusal !== null || left) break
    }
    if (left) {
      markUnreadRules()
      run.leftOut.push(left)
      return
    }
    if (over) {
      markUnreadRules()
      run.damagedOver = true
      run.held.push({ rel: file.rel, changed: 0 })
      return
    }
    if (run.deferredRefusal !== null || candidates.length === 0) return
    if (recoveryEntry && (run.damagedOver || run.totalChangedMatches + run.heldMatches > AST_BOUNDS.editMaxMatches || run.plannedFiles.length + run.held.length > AST_BOUNDS.editMaxFiles)) {
      run.held.push({ rel: file.rel, changed: 0 })
      return
    }

    run.filesWithMatches++
    const merging = mergeCandidates(candidates, rules, file, recoveryEntry)
    const merged = merging.merged
    left = merging.left
    run.deferredRefusal = merging.deferredRefusal
    if (left) {
      run.leftOut.push(left)
      return
    }
    if (run.deferredRefusal !== null) return

    const unchangedItems = merged.filter(c => c.unchanged)
    const changedItems = merged.filter(c => !c.unchanged)
    for (const u of unchangedItems) {
      run.totalUnchangedMatches++
      for (const ri of u.ruleIndices) ruleStates[ri]!.unchangedMatches++
    }
    if (changedItems.length === 0) return

    const edits = changedItems.flatMap(c => c.subEdits).sort((a, b) => a.start - b.start)
    for (let i = 1; i < edits.length; i++) {
      if (edits[i]!.start < edits[i - 1]!.end) {
        const sharing = `Ambiguous rewrite in ${file.rel}: two deletions share a line — narrow the rules so their matches do not overlap. Nothing was written.`
        const item = changedItems.find(c => edits[i]!.start <= c.matchEnd && edits[i]!.end >= c.matchStart) ?? changedItems[0]!
        if (recoveryEntry) left = { rel: file.rel, note: `${item.startLine}:${item.startCol} two deletions share a line`, refusal: sharing }
        else run.deferredRefusal = sharing
        break
      }
    }
    if (left) {
      run.leftOut.push(left)
      return
    }
    if (run.deferredRefusal !== null) return

    if (recoveryEntry) {
      const touching = edits.find(edit => recoveryEntry.errors.some(error => touchesParseError(edit.start, edit.end, error)))
      if (touching) {
        const item = changedItems.find(c => touching.start <= c.matchEnd && touching.end >= c.matchStart) ?? changedItems[0]!
        run.leftOut.push({ rel: file.rel, note: `${item.startLine}:${item.startCol} the match touches a syntax-error region`, refusal: `Cannot rewrite ${file.rel}:${item.startLine}:${item.startCol} (rule ${item.ruleIndices[0]}): the match touches a syntax-error region. Nothing was written.` })
        return
      }
    }

    const after = applyEdits(before, edits)
    if (after === before) return

    const reparsed = await parsePolyglot(engine, file.lang, after, recoveryEntry ? { errorRegions: true } : undefined)
    if ('state' in reparsed) {
      run.deferredRefusal = `${file.rel}: ${reparsed.note}. Nothing was written.`
      return
    }
    const broken = reparsed.parseErrors.length > 0
    const firstError = reparsed.parseErrors[0]
    reparsed.tree.delete()
    if (recoveryEntry && broken && reparsed.errorRegions?.length) {
      const introduced = introducedParseError(before, after, edits, recoveryEntry.errors, reparsed.errorRegions)
      if (introduced) {
        run.leftOut.push({ rel: file.rel, note: `${introduced.line}:${introduced.column} the rewrite would introduce a syntax error${introduced.missing ? `, missing ${introduced.type}` : ''}`, refusal: `The rewrite introduces a syntax error in ${file.rel} at ${introduced.line}:${introduced.column} (${introduced.missing ? `missing ${introduced.type}` : 'syntax error'}). Nothing was written.` })
        return
      }
    } else if (broken) {
      run.deferredRefusal = `The rewrite would leave ${file.rel} unparsable as ${file.lang.name} (${firstError}) — adjust the rewrite so the result is valid code. Nothing was written.`
      return
    }

    const original = before
    const admit = (): void => {
      for (const item of changedItems) {
        if (item.inPlace) run.totalInPlaceMatches++
        if (item.ruleIndices.length > 1) {
          run.coalesced.push({ rel: file.rel, line: item.startLine, col: item.startCol, ruleIndices: [...item.ruleIndices] })
        }
        for (const ri of item.ruleIndices) {
          ruleStates[ri]!.changedMatches++
          ruleStates[ri]!.filesChanged.add(file.rel)
        }
      }
      run.fileChanges.set(
        file.rel,
        changedItems.map(item => ({ line: item.startLine, col: item.startCol, ruleIndices: [...item.ruleIndices] })),
      )
      const diff = unifiedDiff(file.rel, original, after)
      const { hunks, omittedHunks } = buildDiffHunks(file.rel, original, after)
      run.plannedFiles.push({
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
      run.heldMatches += changedItems.length
      run.held.push({ rel: file.rel, changed: changedItems.length, admit })
      return
    }
    run.totalChangedMatches += changedItems.length
    if (run.totalChangedMatches > AST_BOUNDS.editMaxMatches) {
      run.deferredRefusal = `More than ${AST_BOUNDS.editMaxMatches} matches in one edit — narrow the scope (path or glob) or the rules, then run again. Nothing was written.`
      return
    }
    admit()
  } finally {
    parsed.tree.delete()
  }
}

function closeBatchPlan(scope: AstScope, rules: ReadonlyArray<AstRewriteRule>, ruleStates: RuleState[], run: BatchRun): AstRewritePlan | AstRefusal {
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

  if (run.deferredRefusal !== null) return { refused: run.deferredRefusal }
  if (run.held.length > 0) {
    const pastMatches = run.damagedOver || run.totalChangedMatches + run.heldMatches > AST_BOUNDS.editMaxMatches
    if (pastMatches || run.plannedFiles.length + run.held.length > AST_BOUNDS.editMaxFiles) {
      const refusal = pastMatches
        ? `More than ${AST_BOUNDS.editMaxMatches} matches in one edit — narrow the scope (path or glob) or the rules, then run again. Nothing was written.`
        : `Matches in ${run.plannedFiles.length + run.held.length} files, more than the ${AST_BOUNDS.editMaxFiles}-file bound for one edit — narrow the scope (path or glob), then run again. Nothing was written.`
      if (run.plannedFiles.length === 0) return { refused: refusal }
      const note = pastMatches ? `more than ${AST_BOUNDS.editMaxMatches} matches in one edit` : `more than the ${AST_BOUNDS.editMaxFiles}-file bound for one edit`
      for (const file of run.held) run.leftOut.push({ rel: file.rel, note, refusal })
    } else {
      for (const file of run.held) {
        run.totalChangedMatches += file.changed
        file.admit?.()
      }
    }
  }
  if (run.plannedFiles.length === 0 && run.leftOut.length > 0 && run.totalUnchangedMatches === 0) return { refused: run.leftOut[0]!.refusal }
  if (run.plannedFiles.length > AST_BOUNDS.editMaxFiles) {
    return {
      refused: `Matches in ${run.plannedFiles.length} files, more than the ${AST_BOUNDS.editMaxFiles}-file bound for one edit — narrow the scope (path or glob), then run again. Nothing was written.`,
    }
  }

  run.plannedFiles.sort((a, b) => a.rel.localeCompare(b.rel))
  run.coalesced.sort((a, b) => a.rel.localeCompare(b.rel) || a.line - b.line || a.col - b.col)

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
    filesParsed: run.filesParsed,
    filesWithMatches: run.filesWithMatches,
    parseFailures: run.parseFailures,
    ...(run.recovered ? { recovered: run.recovered } : {}),
    patternRefusals: attributedRefusals,
    captureNamesByLang: new Map(),
    skippedLarge: run.skippedLarge,
    truncatedParse: run.truncatedParse,
    languagesSearched: [...run.globalLangFiles.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    compiledSomewhere: ruleStates.some(r => r.compiledSomewhere),
  }

  run.leftOut.sort((a, b) => a.rel.localeCompare(b.rel))
  const token = batchRewritePlanToken(rules, scope, run.plannedFiles.map(f => [f.rel, f.digestBefore, f.digestAfter]), run.leftOut.map(f => f.rel))
  return {
    token,
    files: run.plannedFiles,
    matchCount: run.totalChangedMatches,
    unchangedMatches: run.totalUnchangedMatches,
    inPlaceMatches: run.totalInPlaceMatches,
    search,
    batch: {
      rules: ruleSummaries,
      coalesced: run.coalesced,
      unmatchedRules,
      fileChanges: run.fileChanges,
    },
    ...(run.leftOut.length > 0 ? { leftOut: run.leftOut } : {}),
  }
}

export async function planAstBatchRewrite(
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

  const ruleStates: RuleState[] = ruleStatesOf(rules)

  const run = batchRunOf()

  for (const file of scope.files) {
    if (signal?.aborted) {
      releaseCompiled(ruleStates)
      return { refused: 'cancelled before planning finished — nothing written.' }
    }
    if (run.filesParsed >= AST_BOUNDS.maxFilesParsed) {
      run.truncatedParse = true
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
              run.skippedLarge++
              fileCountedLarge = true
            }
            r.skippedBeforeCompile = true
            continue
          }
          try {
            before = readFileSync(file.abs, 'utf8')
          } catch (err) {
            releaseCompiled(ruleStates)
            return { refused: `${file.rel}: unreadable — ${(err as Error).message}. Nothing was written.` }
          }
          if (before.length > AST_BOUNDS.maxFileBytes) {
            if (!fileCountedLarge) {
              run.skippedLarge++
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
        releaseCompiled(ruleStates)
        return {
          refused: `Rule ${r.index} (${JSON.stringify(r.rule.pattern)} → ${JSON.stringify(r.rule.rewrite)}): the rewrite ${subCheck.refuse.replace(/^out references /, 'references ')} — every meta-variable in the rewrite must be captured by the pattern. Nothing was written.`,
        }
      }
      compiledForFile.push({ r, compiled })
    }

    if (fileCountedLarge) continue
    if (compiledForFile.length === 0) {
      if (fileAcceptedByAnyRule && ruleStates.some(r => !r.refusedLangs.has(file.lang.name))) {
        run.globalLangFiles.set(file.lang.name, (run.globalLangFiles.get(file.lang.name) ?? 0) + 1)
      }
      continue
    }
    if (before === undefined) {
      if (file.lang.patternOnly && farOverSizeBound(file.abs)) {
        run.skippedLarge++
        continue
      }
      try {
        before = readFileSync(file.abs, 'utf8')
      } catch (err) {
        releaseCompiled(ruleStates)
        return { refused: `${file.rel}: unreadable — ${(err as Error).message}. Nothing was written.` }
      }
      if (before.length > AST_BOUNDS.maxFileBytes) {
        run.skippedLarge++
        continue
      }
    }
    for (const { r } of compiledForFile) {
      r.langFiles.set(file.lang.name, (r.langFiles.get(file.lang.name) ?? 0) + 1)
    }
    run.globalLangFiles.set(file.lang.name, (run.globalLangFiles.get(file.lang.name) ?? 0) + 1)
    if (run.deferredRefusal !== null) continue

    const matchingRules = compiledForFile.filter(({ r }) => !r.preToken || before!.includes(r.preToken))
    if (matchingRules.length === 0) continue
    await planBatchFile(engine, file, before, matchingRules, rules, ruleStates, run)
  }

  releaseCompiled(ruleStates)

  return closeBatchPlan(scope, rules, ruleStates, run)
}
