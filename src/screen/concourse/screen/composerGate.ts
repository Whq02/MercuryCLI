import type { ConcourseRowV1 } from '../contracts.js'
import { OLDER_CHATS_ROW_PREFIX } from '../../concourse-model/concourseSnapshot.js'
import { keyHintLabel } from '../../widgets/keyHintLabel.js'
import type { ConcourseRegion } from '../ConcourseLayout.js'

export function liveComposerGateOf(
  sel: ConcourseRowV1 | undefined,
  openAsk: boolean,
  region?: ConcourseRegion,
  credentialWall?: string,
): { ok: true; placeholder: string } | { ok: false; line: string } {
  if (sel === undefined) return { ok: false, line: 'no session selected — n starts one' }
  if (sel.sessionId.startsWith(OLDER_CHATS_ROW_PREFIX)) {
    return {
      ok: false,
      line:
        region === undefined || region === 'list' || region === 'live'
          ? 'older chats — ↵ unfolds the list'
          : 'older chats — tab to the list, ↵ unfolds it',
    }
  }
  if (sel.door !== undefined) return { ok: false, line: 'a door — ↵ opens it; nothing to message' }
  if (sel.sessionId.startsWith('dispatch:') || sel.state === 'queued') return { ok: false, line: 'queued — m stacks a message for its start' }
  if (sel.state === 'parked') return { ok: false, line: 'parked — ↵ brings it back; a sleeping chat takes no queue' }
  if (sel.state === 'attached') return { ok: false, line: 'with you — type in its own chat' }
  if (sel.state === 'stopped') return { ok: false, line: `stopped — nothing listens; ${keyHintLabel('⌃x ⌃x')} archives it` }
  if (sel.state === 'needs-you' || openAsk) return { ok: false, line: 'needs you · ↵↵ to answer' }
  if (credentialWall !== undefined) return { ok: false, line: credentialWall }
  return {
    ok: true,
    placeholder: sel.state === 'working' ? `message ${sel.title} · on its next turn` : `message ${sel.title}`,
  }
}

export function broadcastFaceOf(markedOnBoard: number): { placeholder: string } | null {
  if (markedOnBoard < 2) return null
  return { placeholder: `message ${markedOnBoard} sessions · ↵↵ sends to all marked` }
}

export function broadcastSummaryOf(sent: number, marked: number): string {
  return `sent to ${sent} of ${marked} · ${marked - sent} skipped`
}

export function liveComposerPaintOf(
  gate: { ok: true; placeholder: string } | { ok: false; line: string },
  note: { tone: 'muted' | 'warning'; text: string } | null,
): { restHint: string; note: { tone: 'muted' | 'warning'; text: string } | null } {
  if (gate.ok) return { restHint: gate.placeholder, note }
  return { restHint: '', note: note ?? { tone: 'muted', text: gate.line } }
}
