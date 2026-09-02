// ============================================================================
//  utils/toolResultSummary — the INLINE short-result seam (the 1to1 ledger's
//  one open transcript delta: "a short-result string … would let the └ result
//  move inline" onto the tool card).
//
//  PURE + React-free by design (the bun-run proof-loadability discipline): a
//  name-keyed dispatcher over the tools' STRUCTURED toolUseResult shapes (the
//  UI-facing `Output` each tool's call() returns — never the model-facing
//  string). The wordings mirror each tool's own compact renderToolResultMessage
//  branch (Read "Read N lines", Grep "Found N matches", Glob "Found N files")
//  so the inline form and the downstream form can never disagree; Bash gets
//  the one summary that never existed: its single short stdout line.
//
//  MULTI-AUTH LAW: this seam is dialect-blind by construction, and must stay
//  so. A tool round reaches it identically whichever wire served the turn —
//  Anthropic Messages, OpenAI Responses, or a chat-completions carrier —
//  because both consumers key on the tool-use BLOCK's name (canonical
//  vocabulary, minted by the transport codecs) and every field read here is
//  written by Mercury's own tool executor, never by a wire. Nothing here may
//  read wire content, model ids, stop reasons, or usage: this seam summarizes
//  no token counts and must never invent one — a count a wire did not report
//  is shown nowhere, not as 0.
//
//  A `null` means "no safe one-liner — render the full downstream block".
//  Defensive field checks stand in for the outputSchema.safeParse crash-guard
//  (corrupt resumed transcripts, any build/dialect vintage): any unexpected
//  shape — a string result, a wire's `{}` placeholder, a missing field —
//  falls through to null, never throws. Errors/kills never reach this seam
//  (the card gates on !erroredToolUseIDs; error results route to
//  UserToolErrorMessage upstream).
// ============================================================================

import { displayWidth } from '../components/mercury-ui/glyphs.js'

/** Longest inline summary — beyond this the downstream block reads better (display columns, not code units). */
export const MAX_INLINE_SUMMARY = 64

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null
}

function bashSummary(out: Record<string, unknown>): string | null {
  const { stdout, stderr, interrupted, isImage, persistedOutputPath, backgroundTaskId } = out
  if (typeof stdout !== 'string') return null
  if (typeof stderr === 'string' && stderr.trim() !== '') return null
  if (interrupted === true || isImage === true) return null
  if (persistedOutputPath != null || backgroundTaskId != null) return null
  const text = stdout.trim()
  // Empty stdout is NOT summarizable: a failing-but-non-error command (exit 1,
  // no output — `test -f missing`) and a truly quiet success are
  // indistinguishable here; the downstream block owns returnCodeInterpretation
  // (audit C2 — '(no output)' masked failures).
  if (text === '') return null
  if (text.includes('\n')) return null
  if (displayWidth(text) > MAX_INLINE_SUMMARY) return null
  return text
}

function readSummary(out: Record<string, unknown>): string | null {
  const file = asRecord(out['file'])
  switch (out['type']) {
    case 'text': {
      const n = file?.['numLines']
      return typeof n === 'number' ? `Read ${n} line${n === 1 ? '' : 's'}` : null
    }
    case 'image':
      return 'Read image'
    case 'pdf':
      return 'Read PDF'
    case 'notebook': {
      const cells = file?.['cells']
      // 0/missing cells is an ERROR shape in FileReadTool's own renderer —
      // fall through to the full block (audit L3).
      if (!Array.isArray(cells) || cells.length === 0) return null
      return `Read ${cells.length} cell${cells.length === 1 ? '' : 's'}`
    }
    case 'file_unchanged':
      return 'Unchanged since last read'
    default:
      return null
  }
}

function grepSummary(out: Record<string, unknown>): string | null {
  // Wordings mirror GrepTool/UI.tsx's SearchResultSummary exactly (audit
  // U11/U12): content mode counts LINES (with -A/-B/-C those include context
  // lines — 'matches' would lie), count mode leads with numMatches.
  const numFiles = out['numFiles']
  if (typeof numFiles !== 'number') return null
  const mode = out['mode']
  if (mode === 'content') {
    const n = out['numLines']
    if (typeof n === 'number') return `Found ${n} line${n === 1 ? '' : 's'}`
    return null
  }
  if (mode === 'count') {
    const m = out['numMatches']
    if (typeof m === 'number') return `Found ${m} match${m === 1 ? '' : 'es'}`
    return null
  }
  if (mode === 'files_with_matches' || mode === undefined) {
    return `Found ${numFiles} file${numFiles === 1 ? '' : 's'}`
  }
  return null
}

function globSummary(out: Record<string, unknown>): string | null {
  const n = out['numFiles']
  if (typeof n !== 'number') return null
  // Mirrors GlobTool/UI.tsx — it never marks truncation in the count line
  // (audit U19: an invented '+' made collapsed vs expanded disagree).
  return `Found ${n} file${n === 1 ? '' : 's'}`
}

/** The one dispatcher both consumers share (the tool card's inline `└` and
 *  the downstream block's suppression) — same inputs, same string, so the two
 *  sites can never disagree about whether a result was inlined. */
export function summarizeToolResult(toolName: string, toolUseResult: unknown): string | null {
  const out = asRecord(toolUseResult)
  if (!out) return null
  try {
    switch (toolName) {
      case 'Bash':
        return bashSummary(out)
      case 'Read':
        return readSummary(out)
      case 'Grep':
        return grepSummary(out)
      case 'Glob':
        return globSummary(out)
      default:
        return null
    }
  } catch {
    return null
  }
}
