import * as React from 'react'
import { Box, Text } from '../ink.js'
import { useRegisterOverlay } from '../context/overlayContext.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js'
import { Dialog } from './design-system/Dialog.js'
import { AMBER, FAINT } from './mercuryPalette.js'
import { GLYPH } from './mercury-ui/glyphs.js'

const SLOT_OFFER_ENTER_ARM_MS = 400

type Props = {
  familyName: string
  fromLabel: string
  toLabel: string
  headroomObserved: boolean
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
  useRegisterOverlay('slot-offer')
  const mountedAtRef = React.useRef(Date.now())
  useKeybinding(
    'confirm:yes',
    () => {
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
