// ============================================================================
//  mercury-ui/keyHintLabel — THE ONE platform-aware key-label owner for
//  hand-authored key hints (the operator's yardstick:
//  "there's the equivalent mapping that shows up on Windows … it shows the
//  Mac symbol for control, not the Windows control").
//
//  Mercury speaks TWO chord-spelling grammars: registry-resolved hints
//  (useShortcutDisplay → chordToDisplayString) already render platform-true
//  words, while the compact legends/atlas/footers carry hand-authored Mac
//  modifier glyphs (⌃ ⇧ ⌥). This fold makes the authored grammar
//  platform-true at PAINT time:
//
//    · macOS   — IDENTITY, byte-for-byte (the look is liked; stills hold);
//    · elsewhere — the host's own words: ⌃x → ctrl+x · ⇧x → shift+x ·
//      ⌥x → alt+x · ⌘x → super+x (the same vocabulary keystrokeToDisplayString
//      renders off-mac, so one chord never wears two off-mac spellings).
//
//  A RENDER-TIME fold only: apply it where a hint string reaches a Text
//  node, downstream of any logic that keys on the authored spellings (the
//  legend's shed weights, the manifest filters). Never feed it the BRANCH
//  glyph chip — '⌥' as the estate-wide branch MARKER is iconography, not a
//  key hint, and stays itself on every host.
//
//  Non-modifier vocabulary (↵ ← → ↑ ↓ tab esc space ? [ ] letters) is
//  host-neutral and passes through untouched on every platform.
// ============================================================================

import { getPlatform, type Platform } from '../../utils/platform.js'

/** Platform-true spelling for one authored key-hint string. Pure; the
 *  platform stays a parameter (default: the live host) so provers drive
 *  every host without env games. */
export function keyHintLabel(hint: string, platform: Platform = getPlatform()): string {
  if (platform === 'macos') return hint
  return hint
    .replaceAll('⌃', 'ctrl+')
    .replaceAll('⇧', 'shift+')
    .replaceAll('⌥', 'alt+')
    .replaceAll('⌘', 'super+')
}

/** The Mac modifier-glyph alphabet the fold owns — exported for the pin's
 *  totality law (no member may survive an off-mac fold). */
export const MAC_MODIFIER_GLYPHS = ['⌃', '⇧', '⌥', '⌘'] as const
