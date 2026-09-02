
import { displayWidth } from '../components/mercury-ui/glyphs.js'

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
  return `Found ${n} file${n === 1 ? '' : 's'}`
}

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
