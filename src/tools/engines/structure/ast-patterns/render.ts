import { clipWithEllipsis } from '../../../../platform/text/strings.js'
import { AST_BOUNDS, GRAMMAR_PACK_REMEDY } from './languages.js'
import { type AstScope, describeSkipped } from './scope.js'
import type { AstMatch, AstSearchResult } from './search.js'
import type { AstLeftOutFile } from './rewriteParts.js'

export function renderLeftOut(leftOut: AstLeftOutFile[] | undefined): string[] {
  if (!leftOut?.length) return []
  return [`Left unchanged: ${leftOut.slice(0, 5).map(file => `${file.rel} (${file.note})`).join('; ')}${leftOut.length > 5 ? `; +${leftOut.length - 5} more` : ''}.`]
}


const MATCH_TEXT_LINES = 4
const MATCH_LINE_CHARS = 160
const CAPTURE_CHARS = 80

export function matchLocation(m: AstMatch): string {
  return m.startLine === m.endLine ? `${m.rel}:${m.startLine}:${m.startCol}` : `${m.rel}:${m.startLine}:${m.startCol}-${m.endLine}:${m.endCol}`
}

export function renderMatch(m: AstMatch): string[] {
  const codeLines = m.text.split('\n')
  const shown = codeLines.slice(0, MATCH_TEXT_LINES).map(l => clipWithEllipsis(l, MATCH_LINE_CHARS))
  const out: string[] = [`${matchLocation(m)} [${m.nodeType}]`]
  out.push(...shown.map(l => `  ${l}`))
  if (codeLines.length > MATCH_TEXT_LINES) out.push(`  … +${codeLines.length - MATCH_TEXT_LINES} more lines`)
  if (m.captures.length > 0) {
    out.push(`  captures: ${m.captures.map(c => `${c.key} = ${clipWithEllipsis(c.text.split('\n')[0]!, CAPTURE_CHARS)}${c.text.includes('\n') ? ' …' : ''}`).join(' · ')}`)
  }
  return out
}

export function renderSearchTrailer(scope: AstScope, result: AstSearchResult): string[] {
  const out: string[] = []
  const where = scope.singleFile ? scope.display : `under ${scope.display}${scope.glob ? ` (glob ${scope.glob})` : ''}${scope.lang ? ` (lang ${scope.lang.name})` : ''}`
  const langs = result.languagesSearched.map(([l, n]) => `${n} ${l}`).join(', ')
  out.push(`Searched ${result.filesParsed} of ${scope.files.length} files ${where}${langs ? ` — ${langs}` : ''}${result.filesParsed < scope.files.length && scope.files.length > 0 ? ' (files that cannot contain the pattern were not parsed)' : ''}.`)
  if (result.recovered) {
    for (const file of result.recovered.slice(0, 5)) {
      const omitted = Math.max(0, file.diagnostics - file.notes.length)
      out.push(`Searched recovered tree: ${file.rel} (${file.lang}; ${file.notes.join('; ')}${omitted ? `; +${omitted} more diagnostics` : ''}). Matches may include parser recovery; code inside a syntax error may go unmatched.`)
    }
    if (result.recovered.length > 5) out.push(`+${result.recovered.length - 5} more files searched over recovered trees.`)
  }
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
  if (scope.skippedUnreadable && scope.skippedUnreadable.count > 0) {
    const { count, firstPath, firstError } = scope.skippedUnreadable
    out.push(`${count} folders or files could not be read and were not searched (first: ${firstPath}: ${firstError})`)
  }
  if (result.skippedLarge > 0) out.push(`Skipped ${result.skippedLarge} file${result.skippedLarge === 1 ? '' : 's'} over ${AST_BOUNDS.maxFileBytes / 1_000_000}MB.`)
  if (scope.truncatedWalk) out.push(`The directory walk stopped at its file bound — narrow path or glob to search the rest.`)
  if (result.truncatedParse) out.push(`Stopped after ${AST_BOUNDS.maxFilesParsed} parsed files — narrow path or glob to search the rest.`)
  return out
}
