
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

export const POSE_GLYPH: Record<Exclude<CritterState, 'working'>, string> = {
  thinking: '◔',
  blocked: GLYPH.warn,
  done: GLYPH.ok,
  sleeping: GLYPH.dot,
  idle: GLYPH.pending,
}

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
