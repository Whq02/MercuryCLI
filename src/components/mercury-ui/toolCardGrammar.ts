
import type * as React from 'react'
import { FAINT, SECOND } from '../mercuryPalette.js'
import { useMercuryTokens } from './useMercuryTokens.js'
import { STATE_STYLE, stateStyleOf } from './theme.js'
import type { SnapshotState } from './theme.js'
import type { MercuryThemeTokens } from '../../utils/mercuryTokens.js'

export interface CardTone {
  glyph: string
  tone: string
}

const CARD_TO_SPINE: Record<string, SnapshotState> = {
  succeeded: 'ready',
  ok: 'ready',
  ready: 'ready',
  completed: 'ready',
  failed: 'failed',
  error: 'failed',
  absent: 'failed',
  'timed-out': 'failed',
  queued: 'starting',
  starting: 'starting',
  running: 'starting',
  waiting: 'starting',
  stopping: 'starting',
  stopped: 'off',
  cancelled: 'gated',
  busy: 'gated',
  expired: 'stale',
  unavailable: 'unavailable',
}

export function cardTone(state: string | undefined): CardTone {
  if (state === 'indeterminate') return { glyph: '?', tone: SECOND }
  const spine = state !== undefined ? CARD_TO_SPINE[state] : undefined
  if (spine === undefined) return { glyph: '·', tone: FAINT }
  const s = STATE_STYLE[spine]
  return { glyph: s.glyph, tone: s.color }
}

export function cardToneOf(t: MercuryThemeTokens, state: string | undefined): CardTone {
  if (state === 'indeterminate') return { glyph: '?', tone: t.textSecondary }
  const spine = state !== undefined ? CARD_TO_SPINE[state] : undefined
  if (spine === undefined) return { glyph: '·', tone: t.textMuted }
  const s = stateStyleOf(t, spine)
  return { glyph: s.glyph, tone: s.color }
}

export function WithCardTone({
  state,
  children,
}: {
  state: string | undefined
  children: (tone: CardTone) => React.ReactNode
}): React.ReactNode {
  const t = useMercuryTokens()
  return children(cardToneOf(t, state))
}
