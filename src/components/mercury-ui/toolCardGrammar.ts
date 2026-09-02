// ============================================================================
//  mercury-ui/toolCardGrammar — the tool cards' PROJECTION of the one spine.
//  Every long-running card speaks the same vocabulary everywhere: queued ·
//  starting · running · waiting · ready · succeeded · failed · stopped —
//  resolved through CARD_TO_SPINE onto theme.ts's STATE_STYLE, the
//  authoritative honest-state mapping, so the transcript's row spine and
//  the card nested beneath it wear ONE mark language (prove-status-spine-
//  unity pins it). The rival glyph table this file once held painted ✓/×
//  against the spine's ●/✕ — two success marks and two failure marks in one
//  scroll — and mapped 'stopped' to the green tick; operator-ruled:
//  stopped NEVER paints a green tick — it is the spine's
//  neutral ○. New tool cards must not hand-roll a tone switch.
//
//  The adaptive half (B5's named follow-up, LANDED): cardToneOf(t, state)
//  resolves the SAME projection through stateStyleOf, so a card's tone
//  follows the theme family (dark ≡ the fixed constants, byte-identical);
//  the card consumers ride it via WithCardTone (their render functions are
//  not components — the tiny wrapper owns the hook). cardTone keeps the
//  fixed-palette one-argument read for the TEXT surfaces (doctor) and the
//  kernel pins.
// ============================================================================

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

/** Card word → the spine's state. Settled-good is the spine's ●; failure
 *  its ✕; motion its ◐; stopped the neutral ○ (R3); expiry the spine's
 *  staleness; cancelled/busy the attention hold. */
const CARD_TO_SPINE: Record<string, SnapshotState> = {
  // settled-good
  succeeded: 'ready',
  ok: 'ready',
  ready: 'ready',
  completed: 'ready',
  // settled-bad
  failed: 'failed',
  error: 'failed',
  absent: 'failed',
  'timed-out': 'failed',
  // in motion
  queued: 'starting',
  starting: 'starting',
  running: 'starting',
  waiting: 'starting',
  stopping: 'starting',
  // deliberately ended — never a success mark (R3)
  stopped: 'off',
  // attention / degraded
  cancelled: 'gated',
  busy: 'gated',
  expired: 'stale',
  unavailable: 'unavailable',
}

/** The one state→tone map. Unknown states read neutral, never invented;
 *  'indeterminate' is the one card-only remainder (genuinely unknown-shaped
 *  — the spine has no row for it). */
export function cardTone(state: string | undefined): CardTone {
  if (state === 'indeterminate') return { glyph: '?', tone: SECOND }
  const spine = state !== undefined ? CARD_TO_SPINE[state] : undefined
  if (spine === undefined) return { glyph: '·', tone: FAINT }
  const s = STATE_STYLE[spine]
  return { glyph: s.glyph, tone: s.color }
}

/** The token-aware door: the same projection through stateStyleOf, so the
 *  tone follows the theme family. The one card-only remainder and the
 *  unknown-state neutral ride the matching token roles (SECOND ↔
 *  textSecondary · FAINT ↔ textMuted — dark stays byte-identical). */
export function cardToneOf(t: MercuryThemeTokens, state: string | undefined): CardTone {
  if (state === 'indeterminate') return { glyph: '?', tone: t.textSecondary }
  const spine = state !== undefined ? CARD_TO_SPINE[state] : undefined
  if (spine === undefined) return { glyph: '·', tone: t.textMuted }
  const s = stateStyleOf(t, spine)
  return { glyph: s.glyph, tone: s.color }
}

/** The card consumers' door: tool render functions are NOT components (no
 *  hooks), so this tiny wrapper owns the token read and hands the resolved
 *  tone to a render prop. No JSX on purpose — the grammar stays a .ts. */
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
