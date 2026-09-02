
import { runtimeKernel } from '../primitives/runtimeKernel.js'

export type ParsedAnchor =
  | { kind: 'full'; digest: string }
  | { kind: 'range'; digest: string; startLine: number; lineCount: number }

export type AnchorCheck =
  | { ok: true }
  | {
      ok: false
      reason: 'stale' | 'malformed'
      currentAnchor?: string
      rereadHint: string
    }

const ANCHOR_RE = /^(fa:[0-9a-f]{12}|ra:[0-9a-f]{12}:L\d+\+\d+)$/

export function normalizeForAnchor(text: string): string {
  const unmarked = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  return unmarked.includes('\r\n') ? unmarked.replaceAll('\r\n', '\n') : unmarked
}

function digest12(normalized: string): string {
  return runtimeKernel().hash.sha256Hex(normalized).slice(0, 12)
}

export function mintFileAnchor(content: string): string {
  return `fa:${digest12(normalizeForAnchor(content))}`
}

export function mintRangeAnchor(
  rangeContent: string,
  startLine: number,
  lineCount: number,
): string {
  return `ra:${digest12(normalizeForAnchor(rangeContent))}:L${startLine}+${lineCount}`
}

export function parseAnchor(anchor: string): ParsedAnchor | null {
  if (!ANCHOR_RE.test(anchor)) return null
  if (anchor.startsWith('fa:')) {
    return { kind: 'full', digest: anchor.slice(3) }
  }
  const m = anchor.match(/^ra:([0-9a-f]{12}):L(\d+)\+(\d+)$/)
  if (!m) return null
  const startLine = Number(m[2])
  const lineCount = Number(m[3])
  if (!Number.isFinite(startLine) || startLine < 1 || lineCount < 1) return null
  return { kind: 'range', digest: m[1]!, startLine, lineCount }
}

export function sliceRange(
  normalizedContent: string,
  startLine: number,
  lineCount: number,
): string {
  const lines = normalizedContent.split('\n')
  return lines.slice(startLine - 1, startLine - 1 + lineCount).join('\n')
}

export function checkAnchor(
  expectedAnchor: string,
  currentFullContent: string,
  filePath: string,
): AnchorCheck {
  const parsed = parseAnchor(expectedAnchor)
  if (!parsed) {
    return {
      ok: false,
      reason: 'malformed',
      rereadHint: `expected_anchor '${expectedAnchor}' is not a valid anchor — re-read ${filePath} and use the (anchor: …) value from the result`,
    }
  }
  const normalized = normalizeForAnchor(currentFullContent)
  if (parsed.kind === 'full') {
    const current = `fa:${digest12(normalized)}`
    if (current === expectedAnchor) return { ok: true }
    return {
      ok: false,
      reason: 'stale',
      currentAnchor: current,
      rereadHint: `re-read ${filePath} (full file) to refresh the anchor`,
    }
  }
  const rangeText = sliceRange(normalized, parsed.startLine, parsed.lineCount)
  const current = `ra:${digest12(rangeText)}:L${parsed.startLine}+${parsed.lineCount}`
  if (current === expectedAnchor) return { ok: true }
  const endLine = parsed.startLine + parsed.lineCount - 1
  return {
    ok: false,
    reason: 'stale',
    currentAnchor: current,
    rereadHint: `re-read lines ${parsed.startLine}-${endLine} of ${filePath} (offset: ${parsed.startLine}, limit: ${parsed.lineCount}) to refresh the anchor`,
  }
}

export function formatAnchorFailure(
  check: Extract<AnchorCheck, { ok: false }>,
  expectedAnchor: string,
): string {
  const lines = [
    check.reason === 'malformed'
      ? 'Malformed anchor: expected_anchor is not a valid anchor string.'
      : 'Stale anchor: the file content no longer matches the read that produced this anchor.',
    `expected_anchor: ${expectedAnchor}`,
  ]
  if (check.currentAnchor) lines.push(`current_anchor: ${check.currentAnchor}`)
  lines.push(`Reread: ${check.rereadHint}`)
  return lines.join('\n')
}
