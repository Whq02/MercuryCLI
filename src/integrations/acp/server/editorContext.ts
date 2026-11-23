

export interface EditorContextWire {
  v: 1
  sessionId: string
  workspaceFolders?: string[]
  activeFile?: {
    path: string
    languageId?: string
    selection?: { startLine: number; endLine: number; text?: string }
  }
  openFiles?: string[]
  diagnostics?: Array<{ path: string; line: number; severity: string; message: string }>
}

const EDITOR_CONTEXT_URI = 'mercury://editor-context'
const EDITOR_CONTEXT_SELECTION_LIMIT = 8_000
const EDITOR_CONTEXT_LIST_LIMIT = 30
const EDITOR_CONTEXT_DIAGNOSTIC_LIMIT = 25

export function editorContextOf(raw: unknown): EditorContextWire | null {
  const r = raw as Record<string, unknown> | null
  if (r === null || typeof r !== 'object' || typeof r.sessionId !== 'string') return null
  const strings = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : undefined
  const active = r.activeFile as Record<string, unknown> | undefined
  const sel = active?.selection as Record<string, unknown> | undefined
  const diags = Array.isArray(r.diagnostics)
    ? (r.diagnostics as Array<Record<string, unknown>>)
        .filter(d => typeof d?.path === 'string' && typeof d.message === 'string')
        .map(d => ({
          path: d.path as string,
          line: typeof d.line === 'number' ? d.line : 0,
          severity: typeof d.severity === 'string' ? d.severity : 'Info',
          message: d.message as string,
        }))
    : undefined
  const folders = strings(r.workspaceFolders)
  const open = strings(r.openFiles)
  return {
    v: 1,
    sessionId: r.sessionId,
    ...(folders !== undefined ? { workspaceFolders: folders } : {}),
    ...(active && typeof active.path === 'string'
      ? {
          activeFile: {
            path: active.path,
            ...(typeof active.languageId === 'string' ? { languageId: active.languageId } : {}),
            ...(sel && typeof sel.startLine === 'number' && typeof sel.endLine === 'number'
              ? {
                  selection: {
                    startLine: sel.startLine,
                    endLine: sel.endLine,
                    ...(typeof sel.text === 'string' ? { text: sel.text } : {}),
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(open !== undefined ? { openFiles: open } : {}),
    ...(diags !== undefined ? { diagnostics: diags } : {}),
  }
}

export function editorContextResource(
  ctx: EditorContextWire | null,
): { type: 'resource'; resource: { uri: string; text: string; mimeType: string } } | null {
  if (ctx === null) return null
  const lines: string[] = []
  if (ctx.workspaceFolders && ctx.workspaceFolders.length > 0) {
    lines.push(`workspace: ${ctx.workspaceFolders.slice(0, 10).join(', ')}`)
  }
  if (ctx.activeFile) {
    const lang = ctx.activeFile.languageId ? ` (${ctx.activeFile.languageId})` : ''
    const sel = ctx.activeFile.selection
    if (sel) {
      lines.push(`active file: ${ctx.activeFile.path}${lang} · selection lines ${sel.startLine}-${sel.endLine}`)
      if (sel.text !== undefined && sel.text !== '') {
        lines.push(
          sel.text.length > EDITOR_CONTEXT_SELECTION_LIMIT
            ? `${sel.text.slice(0, EDITOR_CONTEXT_SELECTION_LIMIT)}\n… (selection truncated)`
            : sel.text,
        )
      }
    } else {
      lines.push(`active file: ${ctx.activeFile.path}${lang}`)
    }
  }
  if (ctx.openFiles && ctx.openFiles.length > 0) {
    const shown = ctx.openFiles.slice(0, EDITOR_CONTEXT_LIST_LIMIT)
    const more = ctx.openFiles.length - shown.length
    lines.push(`open files: ${shown.join(', ')}${more > 0 ? ` (+${more} more)` : ''}`)
  }
  if (ctx.diagnostics && ctx.diagnostics.length > 0) {
    const shown = ctx.diagnostics.slice(0, EDITOR_CONTEXT_DIAGNOSTIC_LIMIT)
    lines.push('diagnostics:')
    for (const d of shown) lines.push(`  ${d.path}:${d.line} ${d.severity}: ${d.message}`)
    if (ctx.diagnostics.length > shown.length) lines.push(`  … (+${ctx.diagnostics.length - shown.length} more)`)
  }
  if (lines.length === 0) return null
  return {
    type: 'resource',
    resource: { uri: EDITOR_CONTEXT_URI, text: lines.join('\n'), mimeType: 'text/plain' },
  }
}
