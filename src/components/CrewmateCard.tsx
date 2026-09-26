import * as React from 'react'
import { Box, Text } from '../ink.js'
import { crewElapsedLabel, crewModelLabel, crewStatusWords, crewTokensLabel, type CrewAgentFacts } from '../services/engine-connector/crewFacts.js'
import { crewmateCardKeys, MAIN_CHAT_CARD_LINE } from '../utils/cockpit/crewmateWords.js'
import { GLYPH } from './mercury-ui/glyphs.js'
import { useNowTick } from './mercury-ui/components.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { useSessionAccent } from './mercury-ui/sessionAccent.js'
import type { CrewmateInView } from './tasks/useCrewmateView.js'

export function crewmateFactsLine(facts: CrewAgentFacts | null, nowMs: number): string[] {
  if (facts === null) return []
  const parts = [crewModelLabel(facts), crewStatusWords(facts, nowMs)]
  const tokens = crewTokensLabel(facts)
  if (tokens !== null) parts.push(tokens)
  parts.push(crewElapsedLabel(facts, nowMs))
  parts.push(`started ${new Date(facts.startedAt).toLocaleTimeString('en-GB', { hour12: false })}`)
  return parts
}

export function CrewmateCard({ crewmate, width }: { crewmate: CrewmateInView; width: number }): React.ReactNode {
  const tokens = useMercuryTokens()
  const { accent } = useSessionAccent()
  const now = useNowTick(1000)
  const facts = crewmate.facts
  const running = facts !== null ? facts.running : false
  const line = crewmateFactsLine(facts, now)
  const detail = facts?.description ?? facts?.activity ?? null
  return (
    <Box flexDirection="column" flexShrink={0} width={width}>
      <Text wrap="truncate-end">
        <Text color={crewmate.pinned ? tokens.warning : accent} bold>
          {crewmate.pinned ? GLYPH.star : GLYPH.circledBullet} {crewmate.name}
        </Text>
        {line.map((part, index) => (
          <Text key={index} color={index === 1 ? (running ? tokens.success : tokens.textSecondary) : tokens.textSecondary}>
            {' · '}
            {part}
          </Text>
        ))}
        {crewmate.pinned ? <Text color={tokens.warning}>{'   '}{MAIN_CHAT_CARD_LINE}</Text> : null}
      </Text>
      <Text wrap="truncate-end">
        {detail !== null ? <Text color={tokens.textMuted}>{detail}{'   '}</Text> : null}
        <Text color={tokens.textSecondary}>{crewmateCardKeys(crewmate.pinned)}</Text>
      </Text>
    </Box>
  )
}
