// ============================================================================
//  utils/cockpit/crewChatRows — the mini-chat feed's React-free derive (#71).
//
//  The Helm lanes rail grows a CHAT section while the scribe router is
//  engaged: the last few bus envelopes as compact nameplated one-liners, so
//  the operator can visually assess router-agent activity without opening
//  /daemon or scrolling the transcript. One source, ONE row shape:
//
//    · SCRIBE — the team-'scribe' inbox tails (implementer + team-lead),
//      parsing scribe_protocol envelope JSON out of TeammateMessage.text.
//
//  Pure data in → bounded display rows out (glyph + tone + route + gist), so
//  the whole feed is provable under bun without a PTY. The component maps
//  tones to mercuryPalette tokens; no color lives here.
// ============================================================================
import { BUS_PROTOCOL_TYPE, type BusEnvelopeKind } from '../swarm/busEnvelopes.js'

/** Semantic tone — the component maps these to TEAL/AMBER/CRIMSON/SECOND/IVORY. */
export type CrewChatTone = 'ok' | 'work' | 'warn' | 'block' | 'info'

export interface CrewChatRow {
  ts: number
  /** Short route, e.g. `tank→dps1` or `impl→lead`. */
  route: string
  /** Status-vocabulary glyph: ○ dispatch · ◐ working · ● done/failed · ⚠ escalate/blocked · · control/note. */
  glyph: string
  tone: CrewChatTone
  /** One-line gist (already first-lined; the component truncates to width). */
  gist: string
}

/** Rail-budget row cap — the CHAT lane never grows past this (+N more is NOT
 *  shown for chat: it is a rolling feed, older lines simply age out).
 *  5→4: ChatRow went two-line for gist legibility — 4 readable
 *  envelopes (8 rail lines) beat 5 illegible ones (5 lines). */
export const CREW_CHAT_ROWS = 4

// Compact seat/agent names for a 24-col rail route. Unknown names pass
// through truncated to 4 so a route never eats the gist.
const SHORT_NAMES: Record<string, string> = {
  'team-lead': 'lead',
  implementer: 'impl',
  healer: 'heal',
  scribe: 'lead',
}
export function shortCrewName(name: string): string {
  const n = name.trim()
  const mapped = SHORT_NAMES[n.toLowerCase()]
  if (mapped) return mapped
  return n.length <= 4 ? n : n.slice(0, 4)
}

interface KindView {
  glyph: string
  tone: CrewChatTone
}

/** kind (+ a progress status sniffed from the preview head) → glyph + tone. */
export function crewChatKindView(kind: string, preview: string): KindView {
  switch (kind) {
    case 'dispatch':
      return { glyph: '○', tone: 'info' }
    case 'progress': {
      const head = preview.trimStart().split(/[\s:]/, 1)[0]?.toLowerCase() ?? ''
      if (head === 'done') return { glyph: '●', tone: 'ok' }
      if (head === 'failed') return { glyph: '●', tone: 'block' }
      if (head === 'blocked') return { glyph: '⚠\uFE0E', tone: 'warn' }
      return { glyph: '◐', tone: 'work' } // working / accepted / anything in flight
    }
    case 'escalate':
      return { glyph: '⚠\uFE0E', tone: 'warn' }
    case 'control':
      return { glyph: '·', tone: 'info' }
    default:
      return { glyph: '·', tone: 'info' } // note / unknown
  }
}

const firstLine = (s: string): string => s.split('\n', 1)[0] ?? s

// A minimal structural parse of a scribe_protocol envelope out of a mailbox
// message body. Tolerant by design: anything that isn't a well-formed
// envelope renders as a plain 'note' row with the raw first line (the
// operator still sees THAT something moved — honesty over suppression).
interface ParsedEnvelope {
  kind: BusEnvelopeKind | 'note'
  preview: string
}
export function parseEnvelopePreview(text: string): ParsedEnvelope | null {
  if (!text.startsWith('{')) return null
  try {
    const p = JSON.parse(text) as Record<string, unknown>
    if (p['type'] !== BUS_PROTOCOL_TYPE || typeof p['kind'] !== 'string') return null
    const kind = p['kind'] as BusEnvelopeKind
    const str = (k: string): string => (typeof p[k] === 'string' ? (p[k] as string) : '')
    switch (kind) {
      case 'dispatch':
        return { kind, preview: str('title') || firstLine(str('task')) }
      case 'progress':
        return { kind, preview: `${str('status')}${str('detail') ? ` ${str('detail')}` : ''}` }
      case 'escalate':
        return { kind, preview: str('reason') }
      case 'control':
        return { kind, preview: `${str('command')}${str('detail') ? ` ${str('detail')}` : ''}` }
      case 'note':
        return { kind, preview: firstLine(str('text')) }
      default:
        return null
    }
  } catch {
    return null
  }
}

/** Inbox tails (inbox name = the TO side) → newest-first bounded rows.
 *
 *  `sinceMs` is the ENGAGEMENT EPOCH: inbox
 *  FILES persist across sessions, and without a boundary the cockpit CHAT
 *  glance rendered 18-day-old escalates as tonight's conversation ("Blocked
 *  creating /U…" from Jun 18 painted beside a live session). Messages
 *  timestamped before the epoch are not this engagement's traffic — drop
 *  them. 0/undefined ⇒ no filter (caller opts out explicitly). */
export function crewChatRowsFromMailbox(
  inboxes: ReadonlyArray<{
    inbox: string
    messages: ReadonlyArray<{ from: string; text: string; timestamp: string }>
  }>,
  cap: number = CREW_CHAT_ROWS,
  sinceMs?: number,
): CrewChatRow[] {
  const rows: CrewChatRow[] = []
  for (const { inbox, messages } of inboxes) {
    for (const m of messages) {
      const ts = Date.parse(m.timestamp)
      if (Number.isNaN(ts)) continue
      if (sinceMs !== undefined && sinceMs > 0 && ts < sinceMs) continue
      const env = parseEnvelopePreview(m.text)
      // Non-envelope protocol chatter (permission/shutdown/idle JSON) is
      // machinery, not crew conversation — skip JSON bodies that aren't
      // scribe envelopes; keep PLAIN text (a human-readable reply).
      if (env === null && m.text.startsWith('{')) continue
      const kind = env?.kind ?? 'note'
      const preview = env?.preview ?? firstLine(m.text)
      const { glyph, tone } = crewChatKindView(kind, preview)
      rows.push({
        ts,
        route: `${shortCrewName(m.from)}→${shortCrewName(inbox)}`,
        glyph,
        tone,
        gist: preview,
      })
    }
  }
  return rows.sort((a, b) => b.ts - a.ts).slice(0, cap)
}
