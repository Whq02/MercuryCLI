import * as React from 'react'
import { Box, Text } from '../ink.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js'
import type { ProviderUsability } from '../services/providers/providerUsability.js'
import { providerDisplayName } from '../services/providers/routeLaw.js'
import { Dialog } from './design-system/Dialog.js'
import { AMBER, FAINT, TEAL } from './mercuryPalette.js'
import { GLYPH } from './mercury-ui/glyphs.js'

type Props = {
  trigger: 'warning' | 'rejected' | 'reset'
  windowName: string | null
  resetText: string | null
  targetModel: string
  awayRoute: ProviderUsability['provider']
  targetUsability: ProviderUsability
  onAccept: () => void
  onDismiss: () => void
}

export function CapOfferCard({
  trigger,
  windowName,
  resetText,
  targetModel,
  awayRoute,
  targetUsability,
  onAccept,
  onDismiss,
}: Props): React.ReactNode {
  const usable = targetUsability.usable
  const awayName = providerDisplayName(awayRoute)
  const awaySpend =
    awayRoute === 'local'
      ? 'the local lane runs on your own server — no API billing'
      : awayRoute === 'openai-compat'
        ? `the ${awayName} lane bills per its endpoint's own terms`
        : `the ${awayName} lane bills per token under your ${awayName} account`
  useKeybinding('confirm:yes', () => (usable ? onAccept() : undefined), {
    context: 'Confirmation',
    isActive: true,
  })
  const home = trigger === 'reset'
  const title = home ? 'Claude window reset — return home?' : 'Claude usage window'
  const escKey = useShortcutDisplay('confirm:no', 'Confirmation', 'esc')
  const stateLine = home
    ? 'the home window has reset — the subscription lane is open again'
    : trigger === 'rejected'
      ? `the ${windowName ?? 'usage'} window is reached — Claude requests are rejected until reset`
      : `approaching the ${windowName ?? 'usage'} window`
  return (
    <Dialog
      title={title}
      subtitle={`${GLYPH.handoff} ${targetModel}`}
      onCancel={onDismiss}
      inputGuide={() => (
        <Text italic dimColor>
          {usable
            ? `enter opens the transition preview ${GLYPH.dot} ${escKey} stays put`
            : `${escKey} dismisses ${GLYPH.dot} the offer returns when the lane is usable`}
        </Text>
      )}
    >
      <Box flexDirection="column">
        <Text>
          <Text color={home ? TEAL : AMBER}>{home ? GLYPH.ok : GLYPH.warn}</Text> {stateLine}
        </Text>
        {resetText ? (
          <Text color={FAINT}>
            {GLYPH.dot} {home ? 'window reset confirmed' : `resets ${resetText}`}
          </Text>
        ) : null}
        <Text color={FAINT}>
          {GLYPH.dot}{' '}
          {home
            ? awayRoute === 'local'
              ? 'Claude is the subscription lane — the local lane cost nothing to leave'
              : `Claude is the subscription lane — returning stops billing on the ${awayName} lane`
            : `${awaySpend}; Claude is your subscription lane`}
        </Text>
        {!usable ? (
          <Text>
            <Text color={AMBER}>{GLYPH.warn}</Text> the {targetUsability.provider} lane is not
            usable right now: {targetUsability.blockers.join(' · ')}
          </Text>
        ) : null}
        {trigger === 'rejected' ? (
          <Text color={FAINT}>
            {GLYPH.dot} a capped window also caps Claude-backed delegation (subagents are not
            failover candidates)
          </Text>
        ) : null}
      </Box>
    </Dialog>
  )
}
