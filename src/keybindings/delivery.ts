
export type ChordDeliveryStatus = 'deliverable' | 'aliases-to' | 'unverified'

export interface ChordDelivery {
  status: ChordDeliveryStatus
  sibling?: string
  reason: string
}

export function legacyByteClass(segment: string): string | null {
  const c = segment.toLowerCase().trim()
  const shifted = /^ctrl\+shift\+([a-z])$/.exec(c)
  if (shifted) return `C0:${shifted[1]}`
  const plain = /^ctrl\+([a-z])$/.exec(c)
  if (plain) return `C0:${plain[1]}`
  if (c === 'tab') return 'C0:i'
  if (c === 'enter' || c === 'return') return 'C0:m'
  if (c === 'escape' || c === 'esc') return 'C0:['
  return null
}

function legacyArrivalOf(segment: string): string | null {
  const c = segment.toLowerCase().trim()
  const shifted = /^ctrl\+shift\+([a-z])$/.exec(c)
  if (shifted) return `ctrl+${shifted[1]}`
  return null
}

export function classifyChordDelivery(
  canonicalChord: string,
  extendedKeys: boolean,
): ChordDelivery {
  const segments = canonicalChord.trim().split(/\s+/)
  for (const segment of segments) {
    const arrival = legacyArrivalOf(segment)
    if (arrival === null) continue
    if (extendedKeys) {
      return {
        status: 'deliverable',
        reason: 'extended-keys terminal (identity-declared or probe-proved)',
      }
    }
    return {
      status: 'aliases-to',
      sibling: segments.length === 1 ? arrival : canonicalChord.replace(segment, arrival),
      reason: `legacy wire collapses ${segment} onto ${arrival} (same C0 byte)`,
    }
  }
  return { status: 'deliverable', reason: 'plain chord — every protocol delivers it' }
}
