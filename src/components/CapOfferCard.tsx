import * as React from 'react'
import { Box, Text } from '../ink.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js'
import { laneSpendPosture } from '../services/capFailover.js'
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
  homeRoute: ProviderUsability['provider']
  awayRoute: ProviderUsability['provider']
  homeUsability: ProviderUsability
  awayUsability: ProviderUsability
  onAccept: () => void
  onDismiss: () => void
}

export function CapOfferCard({
  trigger,
  windowName,
  resetText,
  targetModel,
  homeRoute,
  awayRoute,
  homeUsability,
  awayUsability,
  onAccept,
  onDismiss,
}: Props): React.ReactNode {
  const home = trigger === 'reset'
  const targetUsability = home ? homeUsability : awayUsability
  const usable = targetUsability.usable
  const homeName = providerDisplayName(homeRoute)
  const awayName = providerDisplayName(awayRoute)
  const homeSpend = laneSpendPosture(homeRoute, homeUsability.credential, homeName)
  const awaySpend = laneSpendPosture(awayRoute, awayUsability.credential, awayName)
  useKeybinding('confirm:yes', () => (usable ? onAccept() : undefined), {
    context: 'Confirmation',
    isActive: true,
  })
  const title = home ? `${homeName} window reset — return?` : `${homeName} usage window`
  const escKey = useShortcutDisplay('confirm:no', 'Confirmation', 'esc')
  const stateLine = home
    ? `the ${homeName} window has reset — ${homeSpend.kind === 'subscription' ? 'the subscription lane' : 'the home lane'} is open again`
    : trigger === 'rejected'
      ? `the ${homeName} ${windowName ?? 'usage'} window is reached — ${homeName} requests are refused until reset`
      : `approaching the ${homeName} ${windowName ?? 'usage'} window`
  const spendLine = home
    ? awaySpend.kind === 'local'
      ? `returning to ${homeName} — the local lane cost nothing to leave`
      : awaySpend.kind === 'subscription'
        ? `returning to ${homeName} — the ${awayName} subscription lane stops carrying this session`
        : `returning to ${homeName} — stops billing on the ${awayName} lane`
    : `${awaySpend.words}; ${homeSpend.words}`
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
          {GLYPH.dot} {spendLine}
        </Text>
        {!usable ? (
          <Text>
            <Text color={AMBER}>{GLYPH.warn}</Text> the {targetUsability.provider} lane is not
            usable right now: {targetUsability.blockers.join(' · ')}
          </Text>
        ) : null}
        {trigger === 'rejected' && homeRoute === 'anthropic' ? (
          <Text color={FAINT}>
            {GLYPH.dot} a capped window also caps Claude-backed delegation (subagents are not
            failover candidates)
          </Text>
        ) : null}
      </Box>
    </Dialog>
  )
}
