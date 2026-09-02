import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { Markdown } from '../Markdown.js'
import { FAINT, IVORY, TEAL } from '../mercuryPalette.js'
import { useSessionAccent } from '../mercury-ui/sessionAccent.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { scribeStreamName, type ScribeAuthor } from '../mercury-ui/scribeChatTabs.js'
import { useMessageMeta, formatClock, userHandle } from './TranscriptNameplate.js'


export function ChatLine({
  author,
  body,
  addMargin = true,
}: {
  author: ScribeAuthor
  body: string
  addMargin?: boolean
}): React.ReactNode {
  const critter = useSessionAccent()
  const { accentSoft: userBloom } = useMercuryTokens()
  const meta = useMessageMeta()
  const clock = formatClock(meta?.timestamp)
  const name = scribeStreamName(author, userHandle())
  const nameColor =
    author === 'scribe'
      ? critter.accent
      : author === 'implement'
        ? TEAL
        : userBloom
  const nameplate = (
    <Text>
      {clock ? <Text color={FAINT}>{clock} </Text> : null}
      <Text color={FAINT}>[</Text>
      <Text color={nameColor}>{name}</Text>
      <Text color={FAINT}>] </Text>
    </Text>
  )
  return (
    <Box marginTop={addMargin ? 1 : 0} width="100%">
      <Markdown color={IVORY} leadingInline={nameplate}>
        {body}
      </Markdown>
    </Box>
  )
}

const CLOCK_SLOT = '         '

export function ScribeStreamingNameplate(): React.ReactNode {
  const critter = useSessionAccent()
  const name = scribeStreamName('scribe', userHandle())
  return (
    <Text>
      {CLOCK_SLOT}
      <Text color={FAINT}>[</Text>
      <Text color={critter.accent}>{name}</Text>
      <Text color={FAINT}>] </Text>
    </Text>
  )
}

export function MercuryStreamingNameplate(): React.ReactNode {
  const critter = useSessionAccent()
  return (
    <Text>
      {CLOCK_SLOT}
      <Text color={FAINT}>[</Text>
      <Text color={critter.accent}>Mercury</Text>
      <Text color={FAINT}>] </Text>
    </Text>
  )
}
