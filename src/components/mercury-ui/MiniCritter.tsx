// ============================================================================
//  mercury-ui/MiniCritter — the SESSION COMPANION's small form + speech bubble.
//
//  The operator's 80×24 mockup: a tiny critter centered above the
//  conversation, flanked by ✧ ── flourishes, SPEAKING in a small rounded
//  bubble beside its art when the companion has something to say. Mounted by
//  MercuryHero as the sub-hero tier (rows < the big-hero floor) and only when
//  the companion is live (default-on; /companion or the
//  MERCURY_DECK_COMPANION env pin toggles it).
//
//  The art is the SAME renderer as every other critter surface (CritterArt's
//  half-block pairer over the authored 11×6 SQUARE-DOCK grids — the square
//  tier's gaze-tracked eyes at dock size, colors derived from the live
//  accent, /critter morphs + the fable recolor for free; chat-feel item 5
//  retired the old mini grid from this mount). The bubble is the talking
//  half of the companion: mood-toned
//  border, an italic moment line or tip, dims for its fade tail, gone at
//  expiry — the row keeps its height while silent so speech never shifts
//  the layout. A line is painted only when it FITS the bubble at the live
//  width (companionBudget): the mount reports its budget to the engine,
//  which chooses fitting lines only — never truncated, never spilled.
// ============================================================================

import * as React from 'react'
import { critterDefForKey, squareDockArtFor } from '../../utils/cockpit/critterData.js'
import { FAINT } from '../mercuryPalette.js'
import { useMercuryTokens } from './useMercuryTokens.js'
import { Box, Text } from '../../ink.js'
import { AnimatedCritterArt } from './AnimatedCritterArt.js'
import { GLYPH } from './glyphs.js'
import { useCompanion, useCompanionEnabled, useCompanionSpeechBudget } from './useCompanion.js'
import { cycleSessionCritter } from './sessionAccent.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { fitsBudget, heroBubbleLineBudget, miniBubbleLineBudget, MINI_BUBBLE_MIN_COLS } from './companionBudget.js'

/**
 * The mini companion row. `cols` is the mount's context width (drives the
 * bubble budget); the flourishes flank the art at its vertical center.
 * `bare` renders the ART ONLY (no flourishes, no bubble) — the compact deck
 * header dock, where the speech line lives beside the art instead.
 * Callers gate the mount on isDeckCompanionEnabled() + their own geometry.
 */
export function MiniCritter({ cols, bare = false }: { cols: number; bare?: boolean }): React.ReactNode {
  const c = useCompanion()
  // The flourish sparks wear the DERIVED accent-bloom — they follow
  // the live critter instead of pinning the crab's coral.
  const { accentSoft } = useMercuryTokens()
  const def = critterDefForKey(c.critter.key)
  // MEMOIZED: this component re-renders on every companion commit
  // (quips, tone, fades); a fresh def object per render made CritterArt's
  // memo miss on all of them and re-reconcile the whole art grid for zero
  // pixel change. Stable identity per (key, accent) restores the memo bail.
  // THE DOCK IS THE SQUARE TIER (chat-feel item 5): the 11×6 square-dock
  // grid rebinds onto the def's square slot — gaze-tracked hero-class eyes
  // at the 80x24 dock geometry; the 11-wide mini retired from this mount.
  const miniDef = React.useMemo(
    () => ({
      ...def,
      hue: c.critter.accent,
      hueDeep: c.critter.accentDeep,
      square: squareDockArtFor(c.critter.key),
    }),
    [def, c.critter.accent, c.critter.accentDeep, c.critter.key],
  )
  // CONSISTENT ACROSS MOUNTS: the mini used the STATIC
  // renderer, so the sub-hero and deck-dock critter neither blinked nor slept
  // while the same creature did both in the hero and the berth — one session,
  // two different animals. It now rides the same AnimatedCritterArt as every
  // other mount, under the same gates.
  //
  // CLICK-TO-CYCLE AT EVERY SIZE: the mini art is the same pointer target
  // the hero and the berth are — one owner (cycleSessionCritter), picks
  // STICK. The click box hugs the art itself, so the bubble/flourishes stay
  // inert text.
  if (bare) {
    return <BareMiniArt miniDef={miniDef} />
  }
  return <SpeakingMiniRow c={c} miniDef={miniDef} cols={cols} accentSoft={accentSoft} />
}

function BareMiniArt({ miniDef }: { miniDef: React.ComponentProps<typeof AnimatedCritterArt>['def'] }): React.ReactNode {
  return (
    <Box onClick={cycleSessionCritter}>
      <AnimatedCritterArt def={miniDef} square />
    </Box>
  )
}

function SpeakingMiniRow({
  c,
  miniDef,
  cols,
  accentSoft,
}: {
  c: ReturnType<typeof useCompanion>
  miniDef: React.ComponentProps<typeof AnimatedCritterArt>['def']
  cols: number
  accentSoft: string
}): React.ReactNode {
  // Speech budget (companionBudget): the bubble's chrome beside the art and
  // the flourishes; below MINI_BUBBLE_MIN_COLS the bubble folds into a plain
  // one-line caption under the art. The engine only chooses lines that fit
  // the budget this mount reports; a line is never truncated here.
  const bubbleFits = cols >= MINI_BUBBLE_MIN_COLS
  const budget = miniBubbleLineBudget(cols)
  useCompanionSpeechBudget(budget)
  const line = c.quip && fitsBudget(c.quip.text, budget) ? c.quip : null
  return (
    <Box flexDirection="column" alignItems="center">
      <Box flexDirection="row" alignItems="center">
        <Text>
          <Text color={accentSoft}>{GLYPH.sparkFaint}</Text>
          <Text color={FAINT}>{' ── '}</Text>
        </Text>
        <Box onClick={cycleSessionCritter}>
          <AnimatedCritterArt def={miniDef} square />
        </Box>
        <Text>
          <Text color={FAINT}>{' ── '}</Text>
          <Text color={accentSoft}>{GLYPH.sparkFaint}</Text>
        </Text>
        {line && bubbleFits ? (
          <>
            <Text color={line.fading ? FAINT : c.tone}>─</Text>
            <Box
              borderStyle="round"
              borderColor={line.fading ? FAINT : c.tone}
              paddingX={1}
              flexShrink={0}
            >
              <Text italic dimColor={line.fading}>
                {line.text}
              </Text>
            </Box>
          </>
        ) : null}
      </Box>
      {line && !bubbleFits ? (
        <Text italic color={line.fading ? FAINT : c.tone}>
          {`"${line.text}"`}
        </Text>
      ) : null}
    </Box>
  )
}

/**
 * The COCKPIT berth's companion line: the cockpit sheds MercuryHero for
 * PinnedCritterBerth, so the berth carries the companion itself. Self-gating
 * leaf so the layout mounts it unconditionally: companion off ⇒ null
 * (byte-identical berth card); armed ⇒ a constant one-row presence (the
 * mood-toned dot + the creature's name while silent, the live line via
 * HeroCompanionBubble), so arming never causes row-count flicker and an
 * ARMED companion is never indistinguishable from off.
 */
export function BerthCompanionLine(): React.ReactNode {
  const on = useCompanionEnabled()
  if (!on) return null
  return <HeroCompanionBubble />
}

/**
 * The hero-side speech bubble (wide cockpit): the SAME talking, mounted as a
 * row sibling of the big hero art. While SILENT it paints nothing — the
 * mascot stands alone (operator ruling: no name tag beside the
 * critter); the hero's fixed-height slot owns the geometry either way, so
 * a line appearing or fading never shifts the art.
 */
export function HeroCompanionBubble(): React.ReactNode {
  const c = useCompanion()
  // The berth's budget for a line at the live width (companionBudget); the
  // engine chooses fitting lines only, and this mount paints a line only
  // when it fits — never truncated.
  const budget = heroBubbleLineBudget(useTerminalSize().columns)
  useCompanionSpeechBudget(budget)
  const line = c.quip && fitsBudget(c.quip.text, budget) ? c.quip : null
  if (!line) {
    return null
  }
  return (
    <Box flexDirection="row" alignItems="center" flexShrink={0}>
      <Text color={line.fading ? FAINT : c.tone}>─</Text>
      <Box
        borderStyle="round"
        borderColor={line.fading ? FAINT : c.tone}
        paddingX={1}
        flexShrink={0}
      >
        <Text italic dimColor={line.fading}>
          {line.text}
        </Text>
      </Box>
    </Box>
  )
}
