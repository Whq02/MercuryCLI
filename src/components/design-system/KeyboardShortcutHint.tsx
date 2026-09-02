import React from 'react'
import Text from '../../ink/components/Text.js'

type Props = {
  /** Display text for the key — a single key, a `+` chord, or `/` alternatives. */
  shortcut: string
  /** The verb shown after the key: what pressing it does. */
  action: string
  /** Render as "(key action)" rather than bare. Off by default. */
  parens?: boolean
  /** Bold the key portion. Off by default. */
  bold?: boolean
}

/** base key names → the kit's lowercase/glyph vocabulary (the kit footer
 *  grammar: `↵ confirm · esc cancel`). Word tokens not in the map lowercase;
 *  glyph tokens (↑ ↓ ← →) and single characters pass through untouched. */
const KIT_KEY: Record<string, string> = {
  Enter: '↵',
  Return: '↵',
  Esc: 'esc',
  Escape: 'esc',
  Space: 'space',
  Tab: 'tab',
  Backspace: 'backspace',
  Delete: 'del',
  PageUp: 'pgup',
  PageDown: 'pgdn',
  Home: 'home',
  End: 'end',
}

function kitToken(tok: string): string {
  if (KIT_KEY[tok]) return KIT_KEY[tok]
  return /^[A-Za-z]{2,}$/.test(tok) ? tok.toLowerCase() : tok
}

/** Normalize a shortcut display string into the kit vocabulary, preserving
 *  its structure: space-separated words, `/`-alternatives, `+`-chords.
 *  Exported for proof use (prove-hint-grammar). */
export function kitShortcut(s: string): string {
  return s
    .split(' ')
    .map(word =>
      word
        .split('/')
        .map(alt => alt.split('+').map(kitToken).join('+'))
        .join('/'),
    )
    .join(' ')
}

/**
 * Renders a keyboard shortcut hint.
 *
 * ONE grammar for every hint in the
 * product — `↵ confirm` / `esc cancel` (the kit's lowercase footer
 * vocabulary) replaces a bare stamp's capitalized `Enter to confirm` /
 * `Esc to cancel`. ConfigurableShortcutHint delegates here, so the entire
 * design-system estate (settings · rules · hooks · agents · extensions + the
 * dialog long tail) converges through this seam — the deferred F3 residual,
 * executed at the shared primitive per the estate philosophy. Bare-stamp builds
 * keep the original wording byte-identically.
 *
 * Callers wanting the usual dim look wrap this in <Text dimColor> themselves.
 *
 * @example
 * // "esc cancel", never "Esc to cancel"
 * <Text dimColor><KeyboardShortcutHint shortcut="Esc" action="cancel" /></Text>
 */
export function KeyboardShortcutHint({
  shortcut,
  action,
  parens = false,
  bold = false,
}: Props): React.ReactNode {  const display = kitShortcut(shortcut)
  const shortcutText = bold ? <Text bold>{display}</Text> : display
  const joiner = ' '
  if (parens) {
    return (
      <Text>
        ({shortcutText}
        {joiner}
        {action})
      </Text>
    )
  }
  return (
    <Text>
      {shortcutText}
      {joiner}
      {action}
    </Text>
  )
}
