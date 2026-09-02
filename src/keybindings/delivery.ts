// ============================================================================
//  delivery —.6.3b: the pure chord
//  DELIVERY algebra — what the operator's terminal can actually put on the
//  wire for an authored chord, and which chords COLLAPSE to the same bytes.
//
//  The legacy C0 projection (no extended-keys protocol): ctrl+shift+LETTER
//  emits the SAME byte as ctrl+LETTER (0x0F for both Ctrl+O and
//  Ctrl+Shift+O), tab IS ctrl+i, enter IS ctrl+m, escape IS ctrl+[. A
//  terminal speaking an extended protocol (kitty / CSI-u / modifyOtherKeys)
//  disambiguates. Mercury's extended-keys fact is the capabilities latch:
//  seeded by the identity sniff (supportsExtendedKeys' terminal list) and
//  UPGRADED by the boot kitty-keyboard probe — a live reply closes the
//  UI-045 declared≠proved gap this header used to carry.
//
//  Consumers: the atlas (delivery + collision columns for /keys, help,
//  binding validation) and the wave-0 collision census. Pure, React-free.
// ============================================================================

export type ChordDeliveryStatus = 'deliverable' | 'aliases-to' | 'unverified'

export interface ChordDelivery {
  status: ChordDeliveryStatus
  /** The canonical sibling this chord's bytes collapse onto (aliases-to). */
  sibling?: string
  reason: string
}

/** The legacy byte-class of ONE chord segment — segments in the same class
 *  are indistinguishable on a legacy wire. null = no collapse class. */
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

/** The canonical spelling a collapsed segment ARRIVES as on a legacy wire. */
function legacyArrivalOf(segment: string): string | null {
  const c = segment.toLowerCase().trim()
  const shifted = /^ctrl\+shift\+([a-z])$/.exec(c)
  if (shifted) return `ctrl+${shifted[1]}`
  return null
}

/**
 * Classify one authored chord (space-separated sequence segments classify
 * individually; the worst segment wins) under the given keyboard-protocol
 * fact. Pure: same inputs ⇒ same classification.
 */
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
