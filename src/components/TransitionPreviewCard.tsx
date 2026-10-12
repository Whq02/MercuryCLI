import * as React from 'react'
import { Box, Text } from '../ink.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import type { TransitionPlan } from '../utils/model/modelTransition.js'
import type { ProviderUsability } from '../services/providers/providerUsability.js'
import { Dialog } from './design-system/Dialog.js'
import { AMBER, FAINT, TEAL } from './mercuryPalette.js'
import { GLYPH } from './mercury-ui/glyphs.js'
import { providerDisplayName } from '../services/providers/routeLaw.js'
import { renderModelName } from '../utils/model/model.js'
import { TRANSITION_CARRIED_WORDS, transitionLossRows } from '../services/providers/transitionPreview.js'

const fmtTokens = (n: number): string => n.toLocaleString('en-US')

function windowSourceWords(plan: TransitionPlan): string {
  const fact = plan.window
  if (fact === undefined) return ''
  switch (fact.windowSource) {
    case 'live-current':
      return plan.targetRoute === 'unrecognised' ? "the catalogue's figure for this account" : `the ${providerDisplayName(plan.targetRoute)} catalogue's figure for this account`
    case 'static-pin':
      return 'a pinned figure'
    case 'capability':
      return 'the capability table'
    case 'fallback':
      return 'the conservative default'
    default:
      return 'the 1M window'
  }
}

export function windowRowWords(plan: TransitionPlan, fromLabel: string, toLabel: string): string | null {
  const fact = plan.window
  if (fact === undefined || fact.fits) return null
  const counted = fact.countModel !== undefined ? `the last count on ${renderModelName(fact.countModel)}` : 'estimated'
  const room = fact.count < fact.window ? ', which leaves no room for a reply' : ''
  return `the conversation is about ${fmtTokens(fact.count)} tokens by Mercury's count (${counted}); ${toLabel}'s window is ${fmtTokens(fact.window)} tokens (${windowSourceWords(plan)})${room} — confirm folds the conversation on ${fromLabel} before the first request on ${toLabel}`
}

type Props = {
  plan: TransitionPlan
  fromLabel: string
  toLabel: string
  refreshed?: boolean
  targetUsability?: ProviderUsability
  onConfirm: () => void
  onCancel: () => void
}

export function TransitionPreviewCard({
  plan,
  fromLabel,
  toLabel,
  refreshed,
  targetUsability,
  onConfirm,
  onCancel,
}: Props): React.ReactNode {
  useKeybinding('confirm:yes', onConfirm, { context: 'Confirmation', isActive: true })
  const rows = transitionLossRows(plan, toLabel)
  const windowRow = windowRowWords(plan, fromLabel, toLabel)
  return (
    <Dialog
      title="Model switch preview"
      subtitle={`${fromLabel} ${GLYPH.handoff} ${toLabel}`}
      onCancel={onCancel}
    >
      <Box flexDirection="column">
        {refreshed ? (
          <Text color={AMBER}>
            {GLYPH.warn} the conversation changed while this preview was open — the counts below were worked out again
          </Text>
        ) : null}
        {targetUsability && !targetUsability.usable ? (
          <Text>
            <Text color={AMBER}>{GLYPH.warn}</Text> the {targetUsability.provider} lane is not
            usable right now: {targetUsability.blockers.join(' · ')}
          </Text>
        ) : null}
        {targetUsability?.delegationCapped ? (
          <Text color={FAINT}>
            {GLYPH.dot} the smaller window applies to crewmates on Claude too; they cannot take the work over
          </Text>
        ) : null}
        {windowRow !== null ? (
          <Text>
            <Text color={AMBER}>{GLYPH.warn}</Text> {windowRow}
          </Text>
        ) : null}
        {rows.map(r => (
          <Text key={r.words}>
            <Text color={AMBER}>{GLYPH.warn}</Text> <Text color={AMBER} bold>{r.n}</Text> {r.words}
          </Text>
        ))}
        <Text color={TEAL}>
          {GLYPH.ok} {TRANSITION_CARRIED_WORDS}
        </Text>
        {plan.itemsTruncated ? (
          <Text color={FAINT}>
            {GLYPH.dot} the counts above are complete; only the first items were listed
          </Text>
        ) : null}
        <Text color={FAINT}>{`confirm switches to ${toLabel} from your next message ${GLYPH.dot} cancel keeps ${fromLabel}`}</Text>
      </Box>
    </Dialog>
  )
}
