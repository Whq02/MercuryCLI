// SlotOfferCard — the WITHIN-FAMILY quota-wall offer (the slot rung of
// the cap-survival ladder).
//
// Fires when the ACTIVE slot's usage window is reached and the family's
// OTHER slot is signed in with headroom (decideSlotWallAction — postures
// off and offer both ASK; auto switches unattended and never mounts this).
// One keypress (Enter/y, `confirm:yes`) flips the ACTIVE slot through the
// one switch owner — no model change, no session change: the next turn
// rides the other slot's credential. Esc dismisses (re-offers only on a
// NEW wall, never nags — the composer keys dismissals like the cap card).
//
// Design system: Dialog seam · AMBER warn spine (a wall state) · GLYPH, no
// emoji · labels are the slot owners' own words, never a secret.
import * as React from 'react'
import { Box, Text } from '../ink.js'
import { useRegisterOverlay } from '../context/overlayContext.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js'
import { Dialog } from './design-system/Dialog.js'
import { AMBER, FAINT } from './mercuryPalette.js'
import { GLYPH } from './mercury-ui/glyphs.js'

/** A confirm surface that appears WITHOUT a gesture must not consume a
 *  keystroke typed at the composer it replaced: Enter arms only after this
 *  window (FN-016 R7) — before it, the press is swallowed, never a slot
 *  flip. Escape dismisses from the first frame (dismissal is safe). */
const SLOT_OFFER_ENTER_ARM_MS = 400

type Props = {
  /** 'anthropic' | 'openai' — display words only. */
  familyName: string
  /** The walled ACTIVE slot's label (the seat being left). */
  fromLabel: string
  /** The offered slot's label (signed in). */
  toLabel: string
  /** Whether the offered slot's clear window is a real OBSERVATION
   *  (FN-016 R18): true speaks headroom; false speaks the unobserved
   *  window as such — the claim must be observable or unspoken. */
  headroomObserved: boolean
  /** The walled window's reset moment, formatted; null when unstated. */
  resetText: string | null
  onAccept: () => void
  onDismiss: () => void
}

export function SlotOfferCard({
  familyName,
  fromLabel,
  toLabel,
  headroomObserved,
  resetText,
  onAccept,
  onDismiss,
}: Props): React.ReactNode {
  // The card OWNS the keyboard while it stands (FN-016 R7): registering
  // with the overlay stack makes useIsOverlayActive() true, which stands
  // the chat-cancel Escape down — Escape dismisses THIS card and never
  // doubles as the running turn's interrupt.
  useRegisterOverlay('slot-offer')
  const mountedAtRef = React.useRef(Date.now())
  useKeybinding(
    'confirm:yes',
    () => {
      // Un-armed Enter is swallowed, not forwarded: the composer this card
      // replaced is unmounted, and a buffered submit must not flip the
      // account slot.
      if (Date.now() - mountedAtRef.current < SLOT_OFFER_ENTER_ARM_MS) return
      onAccept()
    },
    {
      context: 'Confirmation',
      isActive: true,
    },
  )
  const escKey = useShortcutDisplay('confirm:no', 'Confirmation', 'esc')
  return (
    <Dialog
      title={`${familyName} usage window — switch account slot?`}
      subtitle={`${GLYPH.handoff} ${toLabel}`}
      onCancel={onDismiss}
      inputGuide={() => (
        <Text italic dimColor>
          {`enter switches the active slot ${GLYPH.dot} ${escKey} stays put`}
        </Text>
      )}
    >
      <Box flexDirection="column">
        <Text>
          <Text color={AMBER}>{GLYPH.warn}</Text> the {fromLabel} usage window is reached —
          requests on it are refused until reset
        </Text>
        {resetText ? (
          <Text color={FAINT}>
            {GLYPH.dot} resets {resetText}
          </Text>
        ) : null}
        {headroomObserved ? (
          <Text color={FAINT}>
            {GLYPH.dot} the {toLabel} slot is signed in with headroom — same family, same
            session; the next turn rides it
          </Text>
        ) : (
          <Text color={FAINT}>
            {GLYPH.dot} the {toLabel} slot is signed in — its own usage window is
            unobserved from this seat (it may hold its own limits); same family, same
            session; the next turn rides it
          </Text>
        )}
        <Text color={FAINT}>
          {GLYPH.dot} nothing signs out: both slots stay connected, and the switch back is
          the same one key when the window resets
        </Text>
      </Box>
    </Dialog>
  )
}
