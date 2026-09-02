// workspaceEditApply — PURE WorkspaceEdit math for the IDE-hands bridge
// (LSPTool rename/codeActions apply). Zero harness imports and zero I/O so
// `bun run` proofs can table-test every decision directly
// (scripts/lsp/prove-lsp-apply-safety.ts).
//
// Safety doctrine (the reason this module exists):
//   · Only LITERAL text edits are applied. Resource operations (create/
//     rename/delete files) and versioned document asserts are REFUSED with a
//     named reason — the tool must never grow silent file-lifecycle powers.
//   · Overlapping edits inside one file are REFUSED (an overlap means the
//     server's edit set is ambiguous under any application order).
//   · Application is offset-DESCENDING so earlier edits can't shift later
//     ranges; the offsets come from the SAME text snapshot the caller synced
//     to the server, and the caller re-verifies disk === snapshot before any
//     write (the drift-abort contract in mercuryOps).

export interface LspPositionLike {
  line: number
  character: number
}
export interface LspRangeLike {
  start: LspPositionLike
  end: LspPositionLike
}
export interface LspTextEditLike {
  range: LspRangeLike
  newText: string
}

/** WorkspaceEdit as servers actually send it (both encodings). */
export interface WorkspaceEditLike {
  changes?: Record<string, LspTextEditLike[]>
  documentChanges?: unknown[]
}

export interface NormalizedFileEdits {
  uri: string
  edits: LspTextEditLike[]
}

export type NormalizeResult =
  | { ok: true; files: NormalizedFileEdits[] }
  | { ok: false; reason: string }

/**
 * Normalize a WorkspaceEdit into per-URI literal edit lists.
 * documentChanges TextDocumentEdits are folded in (version asserts ignored —
 * the caller's own disk-drift verification is stricter); resource operations
 * refuse the whole edit.
 */
export function normalizeWorkspaceEdit(
  edit: WorkspaceEditLike | null | undefined,
): NormalizeResult {
  if (!edit) return { ok: false, reason: 'server returned no edit' }
  const byUri = new Map<string, LspTextEditLike[]>()

  const add = (uri: string, edits: LspTextEditLike[]) => {
    const list = byUri.get(uri) ?? []
    list.push(...edits)
    byUri.set(uri, list)
  }

  for (const [uri, edits] of Object.entries(edit.changes ?? {})) {
    if (Array.isArray(edits)) add(uri, edits)
  }

  for (const change of edit.documentChanges ?? []) {
    if (!change || typeof change !== 'object') {
      return { ok: false, reason: 'malformed documentChanges entry' }
    }
    const c = change as {
      kind?: string
      textDocument?: { uri?: string }
      edits?: LspTextEditLike[]
    }
    if (typeof c.kind === 'string') {
      return {
        ok: false,
        reason: `resource operation '${c.kind}' not supported — apply refused (no file create/rename/delete powers)`,
      }
    }
    if (!c.textDocument?.uri || !Array.isArray(c.edits)) {
      return { ok: false, reason: 'malformed TextDocumentEdit entry' }
    }
    add(c.textDocument.uri, c.edits)
  }

  const files = [...byUri.entries()]
    .map(([uri, edits]) => ({ uri, edits }))
    .filter(f => f.edits.length > 0)
  if (files.length === 0) {
    return { ok: false, reason: 'edit set is empty — nothing to apply' }
  }
  return { ok: true, files }
}

function lineStartsOf(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    if (ch === 10) starts.push(i + 1)
    else if (ch === 13) {
      if (text.charCodeAt(i + 1) === 10) i++
      starts.push(i + 1)
    }
  }
  return starts
}

export function offsetAtPosition(text: string, pos: LspPositionLike): number {
  const starts = lineStartsOf(text)
  if (pos.line < 0) return 0
  if (pos.line >= starts.length) return text.length
  const lineStart = starts[pos.line] ?? text.length
  const nextStart =
    pos.line + 1 < starts.length ? (starts[pos.line + 1] ?? text.length) : text.length
  return Math.min(lineStart + Math.max(0, pos.character), nextStart)
}

export type ApplyResult =
  | { ok: true; text: string; editCount: number }
  | { ok: false; reason: string }

/**
 * Apply literal edits to a text snapshot. Refuses overlapping ranges;
 * applies in descending start-offset order.
 */
export function applyEditsToText(
  text: string,
  edits: LspTextEditLike[],
): ApplyResult {
  const resolved = edits.map(e => ({
    start: offsetAtPosition(text, e.range.start),
    end: offsetAtPosition(text, e.range.end),
    newText: e.newText,
  }))
  for (const r of resolved) {
    if (r.end < r.start) {
      return { ok: false, reason: 'edit has end before start' }
    }
  }
  const ordered = [...resolved].sort((a, b) => a.start - b.start || a.end - b.end)
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1]!
    const cur = ordered[i]!
    // Same-position pure insertions are the only tolerated adjacency; any
    // range intersection is ambiguous.
    if (cur.start < prev.end) {
      return {
        ok: false,
        reason: `overlapping edits at offsets ${prev.start}-${prev.end} and ${cur.start}-${cur.end} — apply refused`,
      }
    }
  }
  let out = text
  for (let i = ordered.length - 1; i >= 0; i--) {
    const e = ordered[i]!
    out = out.slice(0, e.start) + e.newText + out.slice(e.end)
  }
  return { ok: true, text: out, editCount: ordered.length }
}

const PREVIEW_MAX_LINES_PER_FILE = 8
const PREVIEW_MAX_TOTAL_LINES = 60

/**
 * Human preview of a normalized edit set against the caller's text snapshots:
 * one `file:line  old → new` row per edit (capped, with honest truncation
 * counts — silent caps read as "covered everything").
 */
export function formatEditPreview(
  files: NormalizedFileEdits[],
  textForUri: (uri: string) => string | undefined,
  displayPath: (uri: string) => string,
): string {
  const lines: string[] = []
  let totalEdits = 0
  let shownLines = 0
  for (const file of files) {
    totalEdits += file.edits.length
    const text = textForUri(file.uri)
    const header = `${displayPath(file.uri)} — ${file.edits.length} edit${file.edits.length === 1 ? '' : 's'}`
    lines.push(header)
    shownLines++
    if (text === undefined) {
      lines.push('  (unreadable — will be re-verified at apply)')
      shownLines++
      continue
    }
    let shownForFile = 0
    for (const edit of file.edits) {
      if (
        shownForFile >= PREVIEW_MAX_LINES_PER_FILE ||
        shownLines >= PREVIEW_MAX_TOTAL_LINES
      ) {
        const remaining = file.edits.length - shownForFile
        if (remaining > 0) lines.push(`  … ${remaining} more in this file`)
        shownLines++
        break
      }
      const start = offsetAtPosition(text, edit.range.start)
      const end = offsetAtPosition(text, edit.range.end)
      const before = text.slice(start, end).replace(/\n/g, '\\n')
      const after = edit.newText.replace(/\n/g, '\\n')
      lines.push(
        `  :${edit.range.start.line + 1}:${edit.range.start.character + 1}  ${truncate(before, 40)} → ${truncate(after, 40)}`,
      )
      shownForFile++
      shownLines++
    }
  }
  lines.unshift(
    `${totalEdits} edit${totalEdits === 1 ? '' : 's'} across ${files.length} file${files.length === 1 ? '' : 's'}:`,
  )
  return lines.join('\n')
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}
