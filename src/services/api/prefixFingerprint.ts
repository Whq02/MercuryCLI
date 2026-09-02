
import { createHash } from 'node:crypto'

export interface PrefixSegmentFingerprint {
  index: number
  kind: 'tools' | 'system'
  bytes: number
  digest: string
  marked: boolean
}

export interface PrefixFingerprint {
  fullPrefixDigest: string
  domainDigest: string
  segments: PrefixSegmentFingerprint[]
  markerPositions: number[]
  totalBytes: number
  estTokens: number
}

function digest16(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16)
}

export function fingerprintCacheablePrefix(input: {
  systemBlocks: ReadonlyArray<{ text: string; cache_control?: unknown }>
  tools?: ReadonlyArray<unknown>
}): PrefixFingerprint {
  const segments: PrefixSegmentFingerprint[] = []
  const toolsJson = JSON.stringify(input.tools ?? [])
  segments.push({
    index: 0,
    kind: 'tools',
    bytes: Buffer.byteLength(toolsJson, 'utf8'),
    digest: digest16(toolsJson),
    marked: false,
  })
  input.systemBlocks.forEach((b, i) => {
    segments.push({
      index: i + 1,
      kind: 'system',
      bytes: Buffer.byteLength(b.text, 'utf8'),
      digest: digest16(b.text),
      marked: b.cache_control !== undefined,
    })
  })
  const markerPositions = segments.filter(s => s.marked).map(s => s.index)
  const lastMarker = markerPositions.length > 0 ? markerPositions[markerPositions.length - 1]! : segments.length - 1
  const prefixSegments = segments.filter(s => s.index <= lastMarker)
  const totalBytes = segments.reduce((a, s) => a + s.bytes, 0)
  return {
    fullPrefixDigest: digest16(prefixSegments.map(s => s.digest).join(' ')),
    domainDigest: digest16(segments.filter(s => s.marked).map(s => s.digest).join(' ')),
    segments,
    markerPositions,
    totalBytes,
    estTokens: Math.round(totalBytes / 3.6),
  }
}

export function diffPrefixFingerprints(
  a: PrefixFingerprint,
  b: PrefixFingerprint,
): { identical: boolean; firstDivergence?: { index: number; kind: string; aDigest: string; bDigest: string } } {
  if (a.fullPrefixDigest === b.fullPrefixDigest) return { identical: true }
  const n = Math.max(a.segments.length, b.segments.length)
  for (let i = 0; i < n; i++) {
    const sa = a.segments[i]
    const sb = b.segments[i]
    if (!sa || !sb || sa.digest !== sb.digest) {
      return {
        identical: false,
        firstDivergence: {
          index: i,
          kind: sa?.kind ?? sb?.kind ?? 'missing',
          aDigest: sa?.digest ?? '(absent)',
          bDigest: sb?.digest ?? '(absent)',
        },
      }
    }
  }
  return { identical: false }
}
