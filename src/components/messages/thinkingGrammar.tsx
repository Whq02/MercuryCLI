// The thinking grammar — the ONE spelling of "the model is reasoning", the
// same for every model family and every surface that says it: the settled
// block (AssistantThinkingMessage), the redacted stub
// (AssistantRedactedThinkingMessage), the live quiet-stream line
// (LiveStreamingTail) and the spinner's HUD segment (SpinnerAnimationRow).
// Glyph, word and colour live here and nowhere else; a renderer that needs
// the row draws <ThinkingLabel/>, a renderer that needs only the word or the
// colour imports the token.
//
// · Glyph: the teardrop-spoked asterisk (U+273B, the transcript's own static
//   mark — constants/figures TEARDROP_ASTERISK). The eight-spoked asterisk it
//   replaces (U+2733) carries the Unicode Emoji property, and a host that
//   routes emoji-eligible code points to its colour font (Windows Terminal)
//   paints it as a pictograph even behind the text-presentation selector
//   (its font fallback ignores VS15); U+273B carries no such property and
//   measures one cell everywhere.
// · Word: lowercase — the row is a status murmur, never a heading.
// · Colour: the theme's `subtle` role — the family's readable secondary grey,
//   the role the expanded reasoning body already paints. Never the session
//   accent and never a per-family hue: reasoning is not identity, so the row
//   reads the same beside every model and needs no accent subscription (the
//   themed Text primitive re-resolves the role on its own).

import React from 'react'
import { Text } from '../../ink.js'
import type { Theme } from '../../utils/theme.js'
import { TEARDROP_ASTERISK } from '../../constants/figures.js'

export const THINKING_GLYPH = TEARDROP_ASTERISK
export const THINKING_WORD = 'thinking'
/** The one row spelling — the live line and the settled header alike. */
export const THINKING_LABEL = `${THINKING_GLYPH} ${THINKING_WORD}…`
/** The theme role every thinking surface paints (header, body, HUD word). */
export const THINKING_COLOR: keyof Theme = 'subtle'

/**
 * The thinking row: the label in the grammar's colour and italic. `children`
 * is the trailing affordance a caller appends inside the same run (the
 * collapsed block's disclosure cue) — nothing else belongs on the row.
 */
export function ThinkingLabel({
  children,
}: {
  children?: React.ReactNode
}): React.ReactNode {
  return (
    <Text italic color={THINKING_COLOR}>
      {THINKING_LABEL}
      {children}
    </Text>
  )
}
