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

function lossRows(plan: TransitionPlan): Array<{ n: number; words: string }> {
  const c = plan.counts
  const rows: Array<{ n: number; words: string }> = []
  if (c['thinking-continuity-reset'] > 0) {
    rows.push({
      n: c['thinking-continuity-reset'],
      words: `thinking span(s) reset — reasoning never round-trips to the ${plan.targetRoute} wire`,
    })
  }
  if (c['stateless-replay-reset'] > 0) {
    rows.push({
      n: c['stateless-replay-reset'],
      words: 'continuation record(s) reset — content replays from the transcript',
    })
  }
  if (c['image-degraded'] > 0) {
    rows.push({ n: c['image-degraded'], words: "image(s) degrade to '[image]' placeholders" })
  }
  if (c['unknown-block-degraded'] > 0) {
    rows.push({
      n: c['unknown-block-degraded'],
      words: 'unsupported block(s) degrade to placeholders',
    })
  }
  return rows
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
  const rows = lossRows(plan)
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
            {GLYPH.warn} the history moved since the preview — this plan was regenerated;
            confirm reads the CURRENT truth
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
            {GLYPH.dot} the capped window also caps Claude-backed delegation (subagents are
            not failover candidates)
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
          {GLYPH.ok} text and tool results replay exactly
        </Text>
        {plan.itemsTruncated ? (
          <Text color={FAINT}>
            {GLYPH.dot} item detail truncated at the plan cap — the counts above are total
          </Text>
        ) : null}
        <Text color={FAINT}>plan {plan.planDigest.slice(0, 8)} {GLYPH.dot} confirm applies through the settlement owner</Text>
      </Box>
    </Dialog>
  )
}
