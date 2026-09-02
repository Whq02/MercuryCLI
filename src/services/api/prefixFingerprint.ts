// ============================================================================
//  prefixFingerprint — the cacheable-prefix instrument.
//
//
//  "Verify the composer" made concrete: a SAFE digest of the exact serialized
//  cacheable prefix — per-segment digests/sizes, marker positions, and the
//  full-prefix digest through the FINAL cache marker. Never prompt text.
//  The field's hit-size wobble (114,537 / 117,768 / 117,792 / 117,836 /
//  138,464) becomes decidable: two fingerprints either match segment-for-
//  segment or name exactly which segment moved. NO composer rewrite is
//  admissible without this instrument showing a current failing segment.
//
//  Scope: the request PREFIX (tools + system blocks). Message-level markers
//  are the dynamic tail's domain — deliberately outside this instrument
//  (E06: dynamic-tail changes must leave the prefix fingerprint unchanged,
//  which this function guarantees by construction: it never reads messages).
//
//  Pure — node:crypto only.
// ============================================================================

import { createHash } from 'node:crypto'

export interface PrefixSegmentFingerprint {
  /** Position in the serialized prefix: 0 = tools, then system blocks. */
  index: number
  kind: 'tools' | 'system'
  bytes: number
  /** sha256[0:16] of the segment's serialized form — never the text. */
  digest: string
  /** Carries a cache_control marker. */
  marked: boolean
}

export interface PrefixFingerprint {
  /** Digest over every segment digest through the FINAL cache marker —
   *  the exact cacheable-prefix identity two requests must share to hit. */
  fullPrefixDigest: string
  /** Digest over the MARKED segments only (the cache-domain subset). */
  domainDigest: string
  segments: PrefixSegmentFingerprint[]
  /** Indices (into segments) that carry cache markers. */
  markerPositions: number[]
  totalBytes: number
  /** Bounded estimate (bytes/3.6) — labeled estimate, never a billing claim. */
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

/** Name the FIRST segment whose digest differs — the E07 decision aid. */
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
