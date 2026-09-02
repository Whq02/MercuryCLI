// CapOfferCard — the R5 cap-survival offer surface.
//
// Presents the one-keypress handoff (or way-home) decision when the cap
// posture and the live observed window state call for it: the WINDOW (which
// limit), the RESET time, and the SPEND posture (subscription lane vs
// per-token lane). Accept (Enter/y, `confirm:yes`) hands control to the
// pick site, which routes through the transition preview gate and settles via
// the ONE owner (settleModelSelection) — this card never writes state.
// Esc rides Dialog's built-in `confirm:no` (dismiss re-offers only on a
// NEW window state, never nags).
//
// Degradation honesty: an unusable target lane is said plainly,
// with the typed blockers, and accept is inert until it is usable.
//
// Design system: Dialog seam · AMBER warn spine for cap states, TEAL for
// the way home · real model ids never themed · GLYPH, no emoji.
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
  /** Why the card fired — decideCapAction/decideCapReturn's typed trigger. */
  trigger: 'warning' | 'rejected' | 'reset'
  /** Which window (display name, e.g. "weekly limit"), when known. */
  windowName: string | null
  /** The window's reset moment, formatted; null when unknown. */
  resetText: string | null
  /** The lane being offered (real model id — the handoff target, or home). */
  targetModel: string
  /** The non-Anthropic side of the move — the candidate lane on a handoff,
   *  the lane being left on the way home. The spend line speaks ITS family
   *  (the widened candidate law: any readiness-checked family, not only
   *  OpenAI). */
  awayRoute: ProviderUsability['provider']
  /** Live usability of the offered lane (R06 — the card says so). */
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
  // Per-family spend honesty: metered lanes bill per token under their own
  // account; a local server bills nothing; an operator-named endpoint bills
  // per its own terms. Claude stays the subscription lane in every case.
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
  // PD-8: ONE hint line. Dialog's default guide said 'enter to
  // confirm · esc to cancel' UNDER the card's own hint line — two lines
  // that disagreed, and with the lane unusable the shared one advertised
  // an enter this card deliberately keeps inert. The card's line rides
  // Dialog's inputGuide seam instead, so the only line printed is the true
  // one (esc spelled by the same resolver Dialog uses).
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
