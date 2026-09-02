// ============================================================================
//  mercury-ui/DeckCompanion — the deck-strip companion row.
//
//  One line of the SESSION COMPANION (see useCompanion.ts — the shared state
//  machine): mood-pose glyph · accent creature name · speech (the live moment
//  line or tip, dimming toward expiry). The creature and its name ARE the
//  row; when it has nothing to say, the row says nothing. A line is painted
//  only when it FITS the row at the live terminal size (companionBudget —
//  the row reports its budget to the engine, which chooses fitting lines
//  only): never truncated, never wrapped, never spilled. Mounted by DeckPane
//  only when isDeckCompanionEnabled() holds — an opted-out session never
//  runs the hook.
// ============================================================================

import * as React from 'react'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import type { CritterState } from '../../utils/cockpit/critterData.js'
import { FAINT } from '../mercuryPalette.js'
import { Text } from '../../ink.js'
import { deckRowLineBudget, dockLineBudget, fitsBudget } from './companionBudget.js'
import { WorkingGlyph } from './LiveGlyphs.js'
import { GLYPH } from './glyphs.js'
import { useCompanion, useCompanionSpeechBudget } from './useCompanion.js'

export { isDeckCompanionEnabled } from './useCompanion.js'

/** Pose → glyph (working handled by the rotating WorkingGlyph). Same width-1
 *  vocabulary as the rest of the deck; no emoji. */
export const POSE_GLYPH: Record<Exclude<CritterState, 'working'>, string> = {
  thinking: '◔',
  blocked: GLYPH.warn,
  done: GLYPH.ok,
  sleeping: GLYPH.dot,
  idle: GLYPH.pending,
}

/** The COMPACT companion chip (the narrow-deck header slot from the operator's
 *  80×24 mockup): pose glyph · creature — no speech (the speech line beside
 *  the mini art owns the talking). Inlined into the compact deck header row;
 *  the full row stays the ≥100-col form. */
export function DeckCompanionChip(): React.ReactNode {
  const c = useCompanion()
  return (
    <Text>
      {c.pose === 'working' ? (
        <WorkingGlyph color={c.tone} />
      ) : (
        <Text color={c.tone}>{POSE_GLYPH[c.pose]}</Text>
      )}
      <Text> </Text>
      <Text color={c.critter.accent}>{c.critter.name}</Text>
    </Text>
  )
}

/** The dock's SPEECH line (compact header, beside the mini art): the live
 *  line in its mood tone; a blank of the same height while silent, so speech
 *  never shifts the layout. Identity already lives in the row-1 chip. */
export function CompanionSpeechLine(): React.ReactNode {
  const c = useCompanion()
  const budget = dockLineBudget(useTerminalSize().columns)
  useCompanionSpeechBudget(budget)
  const line = c.quip && fitsBudget(c.quip.text, budget) ? c.quip : null
  return line ? (
    <Text color={line.fading ? FAINT : c.tone} dimColor={line.fading} italic>
      {`"${line.text}"`}
    </Text>
  ) : (
    <Text color={FAINT}>{' '}</Text>
  )
}

export function DeckCompanion(): React.ReactNode {
  const c = useCompanion()
  const budget = deckRowLineBudget(useTerminalSize().columns, c.critter.name)
  useCompanionSpeechBudget(budget)
  const line = c.quip && fitsBudget(c.quip.text, budget) ? c.quip : null
  return (
    <Text>
      {c.pose === 'working' ? (
        <WorkingGlyph color={c.tone} />
      ) : (
        <Text color={c.tone}>{POSE_GLYPH[c.pose]}</Text>
      )}
      <Text> </Text>
      <Text color={c.critter.accent}>{c.critter.name}</Text>
      {line ? (
        <>
          <Text color={FAINT}> · </Text>
          <Text color={line.fading ? FAINT : c.tone} dimColor={line.fading} italic>
            {`"${line.text}"`}
          </Text>
        </>
      ) : null}
    </Text>
  )
}
