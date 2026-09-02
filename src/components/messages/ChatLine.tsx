import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { Markdown } from '../Markdown.js'
import { FAINT, IVORY, TEAL } from '../mercuryPalette.js'
import { useSessionAccent } from '../mercury-ui/sessionAccent.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { scribeStreamName, type ScribeAuthor } from '../mercury-ui/scribeChatTabs.js'
import { useMessageMeta, formatClock, userHandle } from './TranscriptNameplate.js'

// ============================================================================
//  ChatLine — the ONE chat-line renderer shared by BOTH scribe-mode agents.
//
//  The unified-chatroom redesign (#47, MERCURY_SCRIBE_CHATROOM) shows the REAL messages
//  of the foreground Scribe AND the daemon-hosted Implementer as token-IDENTICAL
//  nameplated chat lines, so a Scribe line and an Implementer line read the same
//  way — a multi-user chatroom the operator observes. Before this there were two
//  divergent stamping sites (the Scribe's inline-nameplate Markdown vs the
//  Implementer's hand-rolled summary-only block); this is the unification.
//
//  Mimics the SOLO assistant recipe EXACTLY (AssistantTextMessage.tsx:195-209): a
//  `<Box marginTop={1}>` wrapping `<Markdown color={IVORY} leadingInline={nameplate}>`
//  so the `HH:MM:SS [name]` stamp lands inline on prose line 1 and a wrapped line
//  falls back to column 0 (no hanging indent). The nameplate is byte-identical to
//  TranscriptNameplate.tsx:167-173 (FAINT clock+brackets, identity-color name).
//
//  HONEST: the timestamp is the message's REAL stored ts (useMessageMeta → formatClock),
//  never Date.now(); a missing stamp self-omits the clock but the [name] always shows
//  (identity is role-derived, never invented). The author is passed by the caller from
//  the VERIFIED message source (teammate_id / assistant turn), NEVER from prose — so a
//  Scribe turn can never render as [Mercury-Implement] (the fabrication anchor, #47 S3).
// ============================================================================

/** Render one chat line for `author` with `body` (markdown text). The caller MUST
 *  derive `author` from the verified message source, not its prose. */
export function ChatLine({
  author,
  body,
  addMargin = true,
}: {
  author: ScribeAuthor
  body: string
  /** Match the solo recipe's leading margin (the first line in a run may set false). */
  addMargin?: boolean
}): React.ReactNode {
  const critter = useSessionAccent()
  // The ONE derived accent-bloom — the operator handle's tint.
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
  // The nameplate <Text> — byte-identical to TranscriptNameplate.tsx:167-173 (FAINT
  // clock+brackets, identity-color name, trailing spaces after the clock and after `]`).
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

/**
 * The width of the finalized clock prefix (`HH:MM:SS ` — pad2 24h, always 9
 * cells). The IN-FLIGHT nameplates below RESERVE this width as a blank slot
 * the streaming turn has no stored timestamp yet and
 * fabricating one is forbidden (never Date.now() at render), but
 * WITHOUT the slot the clock's arrival at finalize widened line 1 by 9
 * cells and REWRAPPED the whole settled paragraph (the S1 baseline's
 * biggest visible discontinuity). With it, settle fills the slot in place —
 * a row-coordinate no-op — and streaming prose sits on the same column grid
 * as every finalized line above it.
 */
const CLOCK_SLOT = '         ' // 9 spaces = stringWidth('HH:MM:SS ')

/**
 * The `[Mercury-Amanuensis]` nameplate for the IN-FLIGHT streaming block
 * (#47 S5). The foreground is always the Scribe; identity is stamped live,
 * the clock's WIDTH is reserved (see CLOCK_SLOT) and its digits fade in on
 * finalize. Passed as `leadingInline` to StreamingMarkdown so the stamp
 * lands on prose line 1 — geometry-identical to the finalized Scribe line.
 */
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

/**
 * The `[Mercury]` nameplate for the IN-FLIGHT NON-scribe streaming block
 * The finalized fork prose leads with `HH:MM:SS [Mercury]`
 * (TranscriptNameplate, name=`Mercury`/color=critter.accent); the live turn
 * has no stored timestamp yet, so the clock's WIDTH is reserved blank
 * and its digits fade in on finalize
 * (honest: never Date.now() at render; geometry never changes at settle).
 * Must NOT read MessageMetaContext (it is null at the streaming site, where
 * TranscriptNameplate self-omits) — it reads only the session accent,
 * exactly like ScribeStreamingNameplate above.
 */
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
