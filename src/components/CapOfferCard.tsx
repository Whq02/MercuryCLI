// CapOfferCard — the cap-survival offer surface, family-neutral.
//
// Presents the one-keypress handoff (or way-home) decision when the cap
// posture and the live observed window state call for it: the HOME family
// (the lane the session runs on, or left), the WINDOW (which limit), the
// RESET time, and the SPEND posture of both sides (subscription lane ·
// metered per token · local server · operator endpoint). Accept (Enter/y,
// `confirm:yes`) hands control to the pick site, which routes through the
// transition preview gate and settles via the ONE owner
// (settleModelSelection) — this card never writes state. Esc rides
// Dialog's built-in `confirm:no` (dismiss re-offers only on a NEW window
// state, never nags).
//
// Degradation honesty: an unusable target lane is said plainly, with the
// typed blockers, and accept is inert until it is usable.
//
// Design system: Dialog seam · AMBER warn spine for cap states, TEAL for
// the way home · real model ids never themed · GLYPH, no emoji.
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
  /** Why the card fired — decideCapAction/decideCapReturn's typed trigger. */
  trigger: 'warning' | 'rejected' | 'reset'
  /** Which window (display name, e.g. "weekly limit"), when known. */
  windowName: string | null
  /** The window's reset moment, formatted; null when unknown. */
  resetText: string | null
  /** The lane being offered (real model id — the handoff target, or home). */
  targetModel: string
  /** The HOME family — the lane whose window walled (a handoff) or whose
   *  window reset (the way home). Any family; the card names it. */
  homeRoute: ProviderUsability['provider']
  /** The AWAY side of the move — the candidate lane on a handoff, the lane
   *  being left on the way home. The spend line speaks ITS family. */
  awayRoute: ProviderUsability['provider']
  /** Live usability of the home lane (its credential kind words the spend
   *  posture; on the way home it is also the offered lane). */
  homeUsability: ProviderUsability
  /** Live usability of the away lane (the candidate on a handoff — the
   *  offered lane, said plainly when unusable; the lane being left on the
   *  way home). */
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
  // The offered lane: home on the way home, the candidate on a handoff.
  const targetUsability = home ? homeUsability : awayUsability
  const usable = targetUsability.usable
  const homeName = providerDisplayName(homeRoute)
  const awayName = providerDisplayName(awayRoute)
  // Per-family spend honesty from the ONE composer: a subscription lane, a
  // metered lane, a local server, an operator endpoint — for home and away
  // alike; no family is "the" subscription lane by default.
  const homeSpend = laneSpendPosture(homeRoute, homeUsability.credential, homeName)
  const awaySpend = laneSpendPosture(awayRoute, awayUsability.credential, awayName)
  useKeybinding('confirm:yes', () => (usable ? onAccept() : undefined), {
    context: 'Confirmation',
    isActive: true,
  })
  const title = home ? `${homeName} window reset — return?` : `${homeName} usage window`
  // ONE hint line. Dialog's default guide said 'enter to
  // confirm · esc to cancel' UNDER the card's own hint line — two lines
  // that disagreed, and with the lane unusable the shared one advertised
  // an enter this card deliberately keeps inert. The card's line rides
  // Dialog's inputGuide seam instead, so the only line printed is the true
  // one (esc spelled by the same resolver Dialog uses).
  const escKey = useShortcutDisplay('confirm:no', 'Confirmation', 'esc')
  const stateLine = home
    ? `the ${homeName} window has reset — ${homeSpend.kind === 'subscription' ? 'the subscription lane' : 'the home lane'} is open again`
    : trigger === 'rejected'
      ? `the ${homeName} ${windowName ?? 'usage'} window is reached — ${homeName} requests are refused until reset`
      : `approaching the ${homeName} ${windowName ?? 'usage'} window`
  // The spend line: on a handoff, what the away lane costs and what home
  // stays; on the way home, what returning stops.
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
