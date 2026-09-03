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

const CAP_OFFER_ENTER_ARM_MS = 400

export interface CapOfferChoice {
  route: string
  model: string
}

type Props = {
  trigger: 'warning' | 'rejected' | 'reset'
  windowName: string | null
  resetText: string | null
  targetModel: string
  homeRoute: ProviderUsability['provider']
  awayRoute: ProviderUsability['provider']
  homeUsability: ProviderUsability
  awayUsability: ProviderUsability
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
  useRegisterOverlay('cap-offer')
  const mountedAtRef = React.useRef(Date.now())
  const home = trigger === 'reset'
  const list = !home && rows !== undefined && rows.length > 1 ? rows : null
  const [highlight, setHighlight] = React.useState(0)
  const highlighted = list !== null ? (list[Math.min(highlight, list.length - 1)] as CapFailoverListedFamily) : null
  const targetUsability = home ? homeUsability : awayUsability
  const usable = highlighted !== null ? highlighted.usable && !highlighted.atCap : targetUsability.usable
  const chosen: CapOfferChoice =
    highlighted !== null
      ? { route: highlighted.route, model: highlighted.model }
      : { route: home ? homeRoute : awayRoute, model: targetModel }
  const homeName = providerDisplayName(homeRoute)
  const awayName = highlighted !== null ? providerDisplayName(highlighted.route) : providerDisplayName(awayRoute)
  const homeSpend = laneSpendPosture(homeRoute, homeUsability.credential, homeName)
  const awaySpend =
    highlighted !== null
      ? laneSpendPosture(highlighted.route, highlighted.credential ?? 'none', awayName)
      : laneSpendPosture(awayRoute, awayUsability.credential, awayName)
  useKeybinding(
    'confirm:yes',
    () => {
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
  const escKey = useShortcutDisplay('confirm:no', 'Confirmation', 'esc')
  const chooseWords = list !== null ? `↑↓ choose ${GLYPH.dot} ` : ''
  const windowNoun = windowName ?? 'usage window'
  const stateLine = home
    ? `the ${homeName} window has reset — ${homeSpend.kind === 'subscription' ? 'the subscription lane' : 'the home lane'} is open again`
    : trigger === 'rejected'
      ? windowNoun === 'credits'
        ? `the ${homeName} credits are exhausted — ${homeName} requests are refused until reset`
        : `the ${homeName} ${windowNoun} is reached — ${homeName} requests are refused until reset`
      : `approaching the ${homeName} ${windowNoun}`
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
