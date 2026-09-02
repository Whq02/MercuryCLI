import { BUS_PROTOCOL_TYPE, type BusEnvelopeKind } from '../swarm/busEnvelopes.js'

export type CrewChatTone = 'ok' | 'work' | 'warn' | 'block' | 'info'

export interface CrewChatRow {
  ts: number
  route: string
  glyph: string
  tone: CrewChatTone
  gist: string
}

export const CREW_CHAT_ROWS = 4

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

export function crewChatKindView(kind: string, preview: string): KindView {
  switch (kind) {
    case 'dispatch':
      return { glyph: '○', tone: 'info' }
    case 'progress': {
      const head = preview.trimStart().split(/[\s:]/, 1)[0]?.toLowerCase() ?? ''
      if (head === 'done') return { glyph: '●', tone: 'ok' }
      if (head === 'failed') return { glyph: '●', tone: 'block' }
      if (head === 'blocked') return { glyph: '⚠\uFE0E', tone: 'warn' }
      return { glyph: '◐', tone: 'work' }
    }
    case 'escalate':
      return { glyph: '⚠\uFE0E', tone: 'warn' }
    case 'control':
      return { glyph: '·', tone: 'info' }
    default:
      return { glyph: '·', tone: 'info' }
  }
}

const firstLine = (s: string): string => s.split('\n', 1)[0] ?? s

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
