// CapOfferCard — the cap-survival offer surface, family-neutral.
//
// Presents the handoff (or way-home) decision when the cap posture and the
// live observed window state call for it: the HOME family (the lane the
// session runs on, or left), the WINDOW that binds (which limit — the
// shared window, or the per-model weekly pool the seat's own model meters),
// the RESET time, and the SPEND posture of both sides (subscription lane ·
// metered per token · local server · operator endpoint).
//
// THE LIST: a handoff names EVERY other signed-in family with a row to land
// on — its family name, the row the switch would land on (the family's
// newest usable model through the exact-id owner) and its own usage state
// where the family reports one — highlighted by default in the sign-in
// ledger's order (the neutral law: no family favoured); a family that is
// itself at its cap is listed last and marked, never offered first. ↑↓
// moves the highlight, ↵ opens the transition preview for the highlighted
// row, Esc stays put. With exactly one other family the card reads as the
// single-target card. Accept (Enter/y, `confirm:yes`) hands the CHOSEN row
// to the pick site, which routes through the transition preview gate and
// settles via the ONE owner (settleModelSelection) — this card never writes
// state. Esc rides Dialog's built-in `confirm:no` (an answered card re-arms
// only on a MATERIAL change of the window, never a jitter).
//
// Degradation honesty: an unusable target lane is said plainly, with the
// typed blockers, and accept is inert until it is usable.
//
// Design system: Dialog seam · AMBER warn spine for cap states, TEAL for
// the way home and the highlight · real model ids never themed · GLYPH, no
// emoji.
import * as React from 'react'
import { Box, Text } from '../ink.js'
import { useRegisterOverlay } from '../context/overlayContext.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js'
import {
  capUsageWords,
  laneSpendPosture,
  type CapFailoverListedFamily,
} from '../services/capFailover.js'
import type { ProviderUsability } from '../services/providers/providerUsability.js'
import { providerDisplayName } from '../services/providers/routeLaw.js'
import { formatResetTime } from '../utils/format.js'
import { Dialog } from './design-system/Dialog.js'
import { AMBER, FAINT, TEAL } from './mercuryPalette.js'
import { GLYPH } from './mercury-ui/glyphs.js'

/** A confirm surface that appears WITHOUT a gesture must not consume a
 *  keystroke typed at the composer it replaced: Enter arms only after this
 *  window — before it, the press is swallowed, never a switch. Escape
 *  dismisses from the first frame (dismissal is safe). */
const CAP_OFFER_ENTER_ARM_MS = 400

/** The lane the operator chose — the exact id the settlement owner takes. */
export interface CapOfferChoice {
  route: string
  model: string
}

type Props = {
  /** Why the card fired — decideCapAction/decideCapReturn's typed trigger. */
  trigger: 'warning' | 'rejected' | 'reset'
  /** Which window binds (display name, e.g. "weekly Fable limit"), when known. */
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
  /** The handoff's LIST — every other signed-in family with a row to land
   *  on, offerable lanes first in sign-in order, then the lanes at their own
   *  cap (marked). Absent, or a single row, paints the single-target card. */
  rows?: CapFailoverListedFamily[]
  onAccept: (chosen: CapOfferChoice) => void
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
  rows,
  onAccept,
  onDismiss,
}: Props): React.ReactNode {
  // The card OWNS the keyboard while it stands: registering with the
  // overlay stack stands the chat-cancel Escape down — Escape dismisses THIS
  // card and never doubles as a running turn's interrupt.
  useRegisterOverlay('cap-offer')
  const mountedAtRef = React.useRef(Date.now())
  const home = trigger === 'reset'
  const list = !home && rows !== undefined && rows.length > 1 ? rows : null
  const [highlight, setHighlight] = React.useState(0)
  const highlighted = list !== null ? (list[Math.min(highlight, list.length - 1)] as CapFailoverListedFamily) : null
  // The offered lane: home on the way home, the candidate on a handoff (the
  // highlighted row when the card lists).
  const targetUsability = home ? homeUsability : awayUsability
  const usable = highlighted !== null ? highlighted.usable && !highlighted.atCap : targetUsability.usable
  const chosen: CapOfferChoice =
    highlighted !== null
      ? { route: highlighted.route, model: highlighted.model }
      : { route: home ? homeRoute : awayRoute, model: targetModel }
  const homeName = providerDisplayName(homeRoute)
  const awayName = highlighted !== null ? providerDisplayName(highlighted.route) : providerDisplayName(awayRoute)
  // Per-family spend honesty from the ONE composer: a subscription lane, a
  // metered lane, a local server, an operator endpoint — for home and away
  // alike; no family is "the" subscription lane by default.
  const homeSpend = laneSpendPosture(homeRoute, homeUsability.credential, homeName)
  const awaySpend =
    highlighted !== null
      ? laneSpendPosture(highlighted.route, highlighted.credential ?? 'none', awayName)
      : laneSpendPosture(awayRoute, awayUsability.credential, awayName)
  useKeybinding(
    'confirm:yes',
    () => {
      // Un-armed Enter is swallowed, not forwarded: the composer this card
      // replaced is unmounted, and a buffered submit must not open a switch.
      if (Date.now() - mountedAtRef.current < CAP_OFFER_ENTER_ARM_MS) return
      if (usable) onAccept(chosen)
    },
    { context: 'Confirmation', isActive: true },
  )
  useKeybinding(
    'confirm:previous',
    () => {
      if (list !== null) setHighlight(h => (h - 1 + list.length) % list.length)
    },
    { context: 'Confirmation', isActive: list !== null },
  )
  useKeybinding(
    'confirm:next',
    () => {
      if (list !== null) setHighlight(h => (h + 1) % list.length)
    },
    { context: 'Confirmation', isActive: list !== null },
  )
  const title = home ? `${homeName} window reset — return?` : `${homeName} usage window`
  // ONE hint line. Dialog's default guide said 'enter to
  // confirm · esc to cancel' UNDER the card's own hint line — two lines
  // that disagreed, and with the lane unusable the shared one advertised
  // an enter this card deliberately keeps inert. The card's line rides
  // Dialog's inputGuide seam instead, so the only line printed is the true
  // one (esc spelled by the same resolver Dialog uses).
  const escKey = useShortcutDisplay('confirm:no', 'Confirmation', 'esc')
  const chooseWords = list !== null ? `↑↓ choose ${GLYPH.dot} ` : ''
  // The binding window as a noun phrase the wire named ('5h window', 'weekly
  // limit', 'weekly Fable limit', 'credits') — never a second 'window' after it.
  const windowNoun = windowName ?? 'usage window'
  const stateLine = home
    ? `the ${homeName} window has reset — ${homeSpend.kind === 'subscription' ? 'the subscription lane' : 'the home lane'} is open again`
    : trigger === 'rejected'
      ? windowNoun === 'credits'
        ? `the ${homeName} credits are exhausted — ${homeName} requests are refused until reset`
        : `the ${homeName} ${windowNoun} is reached — ${homeName} requests are refused until reset`
      : `approaching the ${homeName} ${windowNoun}`
  // The spend line: on a handoff, what the away lane costs and what home
  // stays; on the way home, what returning stops.
  const spendLine = home
    ? awaySpend.kind === 'local'
      ? `returning to ${homeName} — the local lane cost nothing to leave`
      : awaySpend.kind === 'subscription'
        ? `returning to ${homeName} — the ${awayName} subscription lane stops carrying this session`
        : `returning to ${homeName} — stops billing on the ${awayName} lane`
    : `${awaySpend.words}; ${homeSpend.words}`
  const highlightedBlockers =
    highlighted !== null ? highlighted.blockers : targetUsability.usable ? [] : targetUsability.blockers
  return (
    <Dialog
      title={title}
      subtitle={`${GLYPH.handoff} ${chosen.model}`}
      onCancel={onDismiss}
      inputGuide={() => (
        <Text italic dimColor>
          {usable ? (
            <>
              {chooseWords}
              {`enter opens the transition preview ${GLYPH.dot} ${escKey} stays put`}
            </>
          ) : (
            `${chooseWords}${escKey} dismisses ${GLYPH.dot} the offer returns when the lane is usable`
          )}
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
        {list !== null ? (
          <Box flexDirection="column" marginTop={1} marginBottom={1}>
            {list.map((row, index) => {
              const focused = index === Math.min(highlight, list.length - 1)
              const name = providerDisplayName(row.route)
              const rowReset =
                row.window?.resetsAtMs !== undefined
                  ? (formatResetTime(row.window.resetsAtMs / 1000) ?? null)
                  : null
              const usage = capUsageWords(row.window, rowReset)
              const usageColor = row.atCap || row.window?.state === 'warning' ? AMBER : FAINT
              return (
                <Text key={row.route} dimColor={row.atCap && !focused}>
                  <Text color={TEAL}>{focused ? GLYPH.cursor : ' '}</Text>{' '}
                  <Text bold={focused}>{name}</Text> {GLYPH.handoff} {row.model} {GLYPH.dot}{' '}
                  <Text color={usageColor}>
                    {row.atCap ? `${GLYPH.warn} ` : ''}
                    {usage}
                  </Text>
                </Text>
              )
            })}
          </Box>
        ) : null}
        <Text color={FAINT}>
          {GLYPH.dot} {spendLine}
        </Text>
        {!usable ? (
          <Text>
            <Text color={AMBER}>{GLYPH.warn}</Text> the {awayName} lane is not
            usable right now: {highlightedBlockers.length > 0 ? highlightedBlockers.join(' · ') : 'at its own usage cap'}
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
