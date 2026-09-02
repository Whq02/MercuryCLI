import figures from 'figures'
import * as React from 'react'
import { useContext } from 'react'
import { Box, Text } from '../../ink.js'
import { formatBriefTimestamp } from '../../utils/formatBriefTimestamp.js'
import {
  findThinkingTriggerPositions,
  getRainbowColor,
  isDeepthinkEnabled,
} from '../../utils/thinking.js'
import { useSessionAccent } from '../mercury-ui/sessionAccent.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { MessageActionsSelectedContext } from '../messageActions.js'
import { TranscriptNameplate } from './TranscriptNameplate.js'

type Props = {
  text: string
  useBriefLayout?: boolean
  timestamp?: string
}

// The user-turn marker. Resting, the ❯ pointer was a neutral `subtle` grey —
// indistinguishable from any other meta text. On Mercury it becomes the live
// session-critter accent, so your own turns carry the Mercury identity hue (the
// design's user-turn caret). The status spine is untouched: the SELECTED state
// still routes through `suggestion` (overlay → accent) and the warm message-
// actions background carries the selection, so selection stays legible.
function userPointerColor(isSelected: boolean, accent: string): string {
  if (isSelected) return 'suggestion'
  return accent
}

// The user's prompt text. The plain path routes it through the `text` role (now warm
// IVORY on Mercury) — but the design wants YOUR turn distinct from the AI's
// warm-ivory speech: the centrally-derived ACCENT BLOOM (tokens.accentSoft,
// one derivation shared with the composer + nameplates),
// so it reads as clearly "yours" and critter-themed without the heaviness of
// the full saturated accent. The plain path keeps `text`.

export function HighlightedThinkingText({
  text,
  useBriefLayout,
  timestamp,
}: Props): React.ReactNode {
  // Brief/assistant mode: chat-style "You" label instead of the ❯ highlight.
  // Parent drops its backgroundColor when this is true, so no grey shows
  // through. No manual wrap needed — Ink wraps inside the parent Box.
  const isSelected = useContext(MessageActionsSelectedContext)
  // Fork: subscribe to the session critter (useSyncExternalStore) so the
  // user-turn caret + prose re-tint LIVE when /critter switches — matches the
  // TranscriptNameplate, which already subscribes. getSessionAccent() (non-hook)
  // would only re-tint on an unrelated re-render, leaving stale color behind.
  const { accent } = useSessionAccent()
  const pointerColor = userPointerColor(isSelected, accent)
  const textColor = useMercuryTokens().accentSoft
  if (useBriefLayout) {
    const ts = timestamp ? formatBriefTimestamp(timestamp) : ''
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

  const triggers = isDeepthinkEnabled()
    ? findThinkingTriggerPositions(text)
    : []

  if (triggers.length === 0) {
    return (
      <Text>
        <TranscriptNameplate />
        <Text color={pointerColor}>{figures.pointer} </Text>
        <Text color={textColor}>{text}</Text>
      </Text>
    )
  }

  // Static rainbow (no shimmer — transcript messages don't animate)
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
    for (let i = t.start; i < t.end; i++) {
      parts.push(
        <Text key={`rb-${i}`} color={getRainbowColor(i - t.start)}>
          {text[i]}
        </Text>,
      )
    }
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
