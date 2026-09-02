
export {
  TERRA,
  IVORY,
  SECOND,
  FAINT,
  TEAL,
  AMBER,
  CRIMSON,
  CLAW,
  OASIS,
  BELLY,
  DUNE,
  SAND,
  NIGHT,
  NIGHT_SOFT,
  ASH,
  ASH_RAISED,
  DUNE_FAINT,
  SURFACE_PANEL,
  SURFACE_RAISED,
  mercuryPalette,
} from '../mercuryPalette.js'

import { AMBER, CRIMSON, FAINT, SECOND, TEAL } from '../mercuryPalette.js'

export type SnapshotState =
  | 'live'
  | 'ready'
  | 'starting'
  | 'configured'
  | 'degraded'
  | 'stale'
  | 'off'
  | 'disabled'
  | 'gated'
  | 'unavailable'
  | 'blocked'
  | 'failed'
  | 'excluded'
  | 'planned'

export type Snapshot<T = Record<never, never>> = {
  state: SnapshotState
  reason?: string
  source?: string
  updatedAt?: string
} & T

export const STATE_STYLE: Record<
  SnapshotState,
  { glyph: string; color: string; label: string }
> = {
  live: { glyph: '●', color: TEAL, label: 'live' },
  ready: { glyph: '●', color: TEAL, label: 'ready' },
  starting: { glyph: '◐', color: AMBER, label: 'starting' },
  configured: { glyph: '◌', color: SECOND, label: 'configured' },
  degraded: { glyph: '◑', color: AMBER, label: 'degraded' },
  stale: { glyph: '↻', color: AMBER, label: 'stale' },
  off: { glyph: '○', color: FAINT, label: 'off' },
  disabled: { glyph: '○', color: FAINT, label: 'disabled' },
  gated: { glyph: '⦿', color: AMBER, label: 'gated' },
  unavailable: { glyph: '—', color: FAINT, label: 'unavailable' },
  blocked: { glyph: '◉', color: CRIMSON, label: 'blocked' },
  failed: { glyph: '✕', color: CRIMSON, label: 'failed' },
  excluded: { glyph: '⊝', color: FAINT, label: 'excluded' },
  planned: { glyph: '◇', color: SECOND, label: 'planned' },
}

export function isActiveState(s: SnapshotState): boolean {
  return s === 'live' || s === 'ready'
}

export function gaugeColor(pct: number): string {
  return pct < 80 ? TEAL : pct < 95 ? AMBER : CRIMSON
}

import type { MercuryThemeTokens } from '../../utils/mercuryTokens.js'

type StateRole = 'success' | 'warning' | 'failure' | 'textSecondary' | 'textMuted'
const STATE_ROLE: Record<SnapshotState, { glyph: string; role: StateRole; label: string }> = {
  live: { glyph: '●', role: 'success', label: 'live' },
  ready: { glyph: '●', role: 'success', label: 'ready' },
  starting: { glyph: '◐', role: 'warning', label: 'starting' },
  configured: { glyph: '◌', role: 'textSecondary', label: 'configured' },
  degraded: { glyph: '◑', role: 'warning', label: 'degraded' },
  stale: { glyph: '↻', role: 'warning', label: 'stale' },
  off: { glyph: '○', role: 'textMuted', label: 'off' },
  disabled: { glyph: '○', role: 'textMuted', label: 'disabled' },
  gated: { glyph: '⦿', role: 'warning', label: 'gated' },
  unavailable: { glyph: '—', role: 'textMuted', label: 'unavailable' },
  blocked: { glyph: '◉', role: 'failure', label: 'blocked' },
  failed: { glyph: '✕', role: 'failure', label: 'failed' },
  excluded: { glyph: '⊝', role: 'textMuted', label: 'excluded' },
  planned: { glyph: '◇', role: 'textSecondary', label: 'planned' },
}

export function stateStyleOf(
  t: MercuryThemeTokens,
  state: SnapshotState,
): { glyph: string; color: string; label: string } {
  const s = STATE_ROLE[state]
  return { glyph: s.glyph, color: t[s.role], label: s.label }
}

export function gaugeColorOf(t: MercuryThemeTokens, pct: number): string {
  return pct < 80 ? t.success : pct < 95 ? t.warning : t.failure
}
