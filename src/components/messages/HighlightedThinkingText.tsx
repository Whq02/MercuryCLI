import figures from 'figures'
import * as React from 'react'
import { useContext } from 'react'
import { Box, Text } from '../../ink.js'
import { formatBriefTimestamp } from '../../utils/formatBriefTimestamp.js'
import { isDeepthinkEnabled } from '../../utils/thinking.js'
import { keywordGlowPositions } from '../../utils/keywordGlow.js'
import { useSessionAccent } from '../mercury-ui/sessionAccent.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { MessageActionsSelectedContext } from '../messageActions.js'
import { TranscriptNameplate, useMessageMeta } from './TranscriptNameplate.js'

type Props = {
  text: string
  useBriefLayout?: boolean
  timestamp?: string
}

function userPointerColor(isSelected: boolean, accent: string): string {
  if (isSelected) return 'suggestion'
  return accent
}


export function HighlightedThinkingText({
  text,
  useBriefLayout,
  timestamp,
}: Props): React.ReactNode {
  const isSelected = useContext(MessageActionsSelectedContext)
  const { accent } = useSessionAccent()
  const pointerColor = userPointerColor(isSelected, accent)
  const textColor = useMercuryTokens().accentSoft
  const meta = useMessageMeta()
  if (useBriefLayout) {
    const ts = meta?.queued ? 'queued' : timestamp ? formatBriefTimestamp(timestamp) : ''
    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Box flexDirection="row">
          <Text color={'briefLabelYou'}>You</Text>
          {ts ? <Text dimColor> {ts}</Text> : null}
        </Box>
        <Text color={textColor}>{text}</Text>
      </Box>
    )
  }

  const triggers = keywordGlowPositions(text, { deepthink: isDeepthinkEnabled(), supercode: true })

  if (triggers.length === 0) {
    return (
      <Text>
        <TranscriptNameplate />
        <Text color={pointerColor}>{figures.pointer} </Text>
        <Text color={textColor}>{text}</Text>
      </Text>
    )
  }

  const parts: React.ReactNode[] = []
  let cursor = 0
  for (const t of triggers) {
    if (t.start > cursor) {
      parts.push(
        <Text key={`plain-${cursor}`} color={textColor}>
          {text.slice(cursor, t.start)}
        </Text>,
      )
    }
    parts.push(
      <Text key={`glow-${t.start}`} color={accent}>
        {text.slice(t.start, t.end)}
      </Text>,
    )
    cursor = t.end
  }
  if (cursor < text.length) {
    parts.push(
      <Text key={`plain-${cursor}`} color={textColor}>
        {text.slice(cursor)}
      </Text>,
    )
  }

  return (
    <Text>
      <TranscriptNameplate />
      <Text color={pointerColor}>{figures.pointer} </Text>
      {parts}
    </Text>
  )
}
