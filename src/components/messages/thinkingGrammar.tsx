// The thinking grammar — the ONE spelling of "the model is reasoning", the
// same for every model family and every surface that says it: the settled
// block (AssistantThinkingMessage), the redacted stub
// (AssistantRedactedThinkingMessage), the live quiet-stream line
// (LiveStreamingTail) and the spinner's HUD segment (SpinnerAnimationRow).
// Glyph, word and colour live here and nowhere else; a renderer that needs
// the row draws <ThinkingLabel/>, a renderer that needs only the word or the
// colour imports the token.
//
// · Glyph: U+2733 carries the Unicode Emoji property, so a terminal that
//   routes emoji-eligible codepoints to its colour font (Windows Terminal)
//   paints the bare codepoint as a colour emoji. VS15 (U+FE0E) forces text
//   presentation and is zero-width under stringWidth, so the token measures
//   one cell. The selector is an escape so it cannot be silently dropped.
// · Word: lowercase — the row is a status murmur, never a heading.
// · Colour: the theme's `subtle` role — the family's readable secondary grey,
//   the role the expanded reasoning body already paints. Never the session
//   accent and never a per-family hue: reasoning is not identity, so the row
//   reads the same beside every model and needs no accent subscription (the
//   themed Text primitive re-resolves the role on its own).

import React from 'react'
import { Text } from '../../ink.js'
import type { Theme } from '../../utils/theme.js'

export const THINKING_GLYPH = '✳\uFE0E'
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
