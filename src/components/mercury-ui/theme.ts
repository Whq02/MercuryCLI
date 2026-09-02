// ============================================================================
//  mercury-ui/theme — the runtime token bridge.
//
//  Maps the design-system tokens onto Ink-safe semantic tokens, WITHOUT
//  redeclaring any hex. The single source of truth stays
//  src/components/mercuryPalette.ts; this module re-exports those brand
//  constants and layers the design system's *semantic* spine on top:
//    - the honest-state taxonomy (live/off/gated/unavailable/blocked/failed/
//      excluded/planned and the readiness words) → glyph + colour + label;
//    - the Snapshot<T> envelope every data bridge returns.
//
//  do-not-port.md: CSS mechanism (radius/shadow/gradient/animation/grid) is
//  reference-only; only the resolved value/state/glyph crosses into runtime.
//  No-colour safety is structural: every state carries a DISTINCT glyph (and a
//  label), so when a NO_COLOR terminal strips the colour the meaning survives.
// ============================================================================

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

// The honest backend-state taxonomy. Repo grounding decides the label; a planned
// surface still gets UI coverage but must never read as live.
// The readiness vocabulary (Sol 5.6 WS2 — ready · starting · configured ·
// degraded · disabled · stale) extends the set for the capability/readiness
// surfaces: configuration alone must never read `live`/`ready`.
export type SnapshotState =
  | 'live' // proven in current repo/runtime
  | 'ready' // callable RIGHT NOW in this process (probed, not assumed)
  | 'starting' // launch/connect in flight — not yet callable
  | 'configured' // config exists, no successful current-process connection
  | 'degraded' // callable but impaired (auth expiring, partial backends…)
  | 'stale' // evidence exists but predates what it certifies
  | 'off' // implemented but disabled by env/config
  | 'disabled' // explicitly turned off (config/registry/kill) — deliberate
  | 'gated' // architecture exists, needs env/config/auth/daemon/source
  | 'unavailable' // no current data source
  | 'blocked' // action cannot proceed — gate/approval/scope prevents it
  | 'failed' // attempted live system failed
  | 'excluded' // intentionally out of boundary
  | 'planned' // a designed surface, not implemented yet

// The envelope every snapshot helper returns. `data` carries the surface payload.
export type Snapshot<T = Record<never, never>> = {
  state: SnapshotState
  reason?: string
  source?: string
  updatedAt?: string
} & T

// Glyph + colour + label per state. Glyphs are from the geometric vocabulary
// (brand-glyphs.html) and are intentionally distinct so the spine is legible
// with colour stripped. This is the authoritative honest-state mapping.
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
  // ✕ (U+2715) = GLYPH.fail — unambiguous width-1; was ✗ (U+2717, East-Asian
  // Ambiguous, could render 2 cells and desync a status column).
  failed: { glyph: '✕', color: CRIMSON, label: 'failed' },
  excluded: { glyph: '⊝', color: FAINT, label: 'excluded' },
  planned: { glyph: '◇', color: SECOND, label: 'planned' },
}

// A state counts as "honestly active" (a filled chip / on-dot) only when
// proven callable right now — live (repo surfaces) or ready (readiness rows).
export function isActiveState(s: SnapshotState): boolean {
  return s === 'live' || s === 'ready'
}

// The gauge ramp (context + usage pressure) — identical thresholds everywhere:
// < 80 calm teal · 80–95 amber warn · >= 95 crimson block.
export function gaugeColor(pct: number): string {
  return pct < 80 ? TEAL : pct < 95 ? AMBER : CRIMSON
}

// ── the ADAPTIVE spine ──────────────────────────────────────────
// The same taxonomy resolved through MercuryThemeTokens so every family gets a
// deliberate expression (dark ≡ the fixed constants — success/warning/failure
// map to TEAL/AMBER/CRIMSON there, byte-identical). Glyphs and labels are the
// SAME objects as STATE_STYLE — only the colour role varies by family. New kit
// code consumes THESE; the fixed exports above stay for art + the un-migrated
// long tail (the adaptive-ink ratchet tracks the shrink).
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
