// ============================================================================
//  terminalExperience —.6.1: the ONE typed
//  resolution surface for Mercury-owned visible terminal behavior.
//
// The law: never claim, render, advertise, or restore a
//  terminal behavior from configuration alone when the effective behavior
//  depends on capability, screen mode, ownership, or an observed settlement.
//  This module is the projection HOME for the experience controls: the
//  MERCURY_* product names are decoded HERE and nowhere else — components
//  stop reading visible-behavior env independently. (The external CLAUDE_*
//  compat rungs is retired.)
//
//  Precedence per control: canonical-env > default. Controls
//  whose decision needs runtime capability (fullscreen · mouse tracking ·
//  ground) keep their OWNING engines (fullscreen.ts · oasisBg.ts) — this
//  module documents the delegation and re-exports the projection, never a
//  second decision engine (guardrail: no renderer rewrite, no second stack).
//  Defaults are byte-identical to the pre-resolver reads.
// ============================================================================

import { flagEnv } from '../../substrate/flagRegistry.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

export type ExperienceSource = 'canonical-env' | 'default'

export interface ResolvedExperienceControl {
  effective: boolean
  source: ExperienceSource
}

export interface TerminalExperienceResolution {
  /** OSC 0/2 terminal-title updates (set at boot, cleared at shutdown). */
  terminalTitle: ResolvedExperienceControl
  /** Screen-reader friendly rendering (disables cursor-hide + live paint). */
  accessibility: ResolvedExperienceControl
  /** The transcript virtual-scroll surface. */
  virtualScroll: ResolvedExperienceControl
}

/** Positive-sense control: '0' turns it off; any other defined value turns
 *  it on; unset falls to the default. */
function positiveControl(canonical: string, defaultOn: boolean): ResolvedExperienceControl {
  const c = flagEnv(canonical)
  if (c !== undefined) return { effective: c !== '0', source: 'canonical-env' }
  return { effective: defaultOn, source: 'default' }
}

/** Positive-sense opt-in control: a defined value must be truthy to arm. */
function positiveOptIn(canonical: string, defaultOn: boolean): ResolvedExperienceControl {
  const c = flagEnv(canonical)
  if (c !== undefined) return { effective: c !== '0' && isEnvTruthy(c), source: 'canonical-env' }
  return { effective: defaultOn, source: 'default' }
}

/**
 * Resolve the experience controls LIVE (each call re-reads env — the
 * authority-toggle law: gates re-read live, never latch a stale module
 * constant). Callers that need render-stable values memoize at their own
 * mount, exactly as the previous direct reads did.
 */
export function resolveTerminalExperience(): TerminalExperienceResolution {
  return {
    terminalTitle: positiveControl('MERCURY_TERMINAL_TITLE', true),
    accessibility: positiveOptIn('MERCURY_ACCESSIBILITY', false),
    virtualScroll: positiveControl('MERCURY_VIRTUAL_SCROLL', true),
  }
}

// ── owner-delegated controls (projection only — the engines stay put) ───────
//  · fullscreen + mouse tracking: src/utils/fullscreen.ts (capability-aware,
//    tmux control-mode detection, MERCURY_FULLSCREEN) — consult shouldEnterFullscreen /
//    shouldEnableMouse there.
//  · ground: src/utils/cockpit/oasisBg.ts (MERCURY_OASIS_BG canonical-
//    first; the standalone splash asset mirrors the same canonical-first
//    law — parity pinned by the splash ground-matrix prover).
//  · message actions: src/components/messageActions.tsx (no env control —
//    an authored action table; recorded so nobody invents a flag for it).
