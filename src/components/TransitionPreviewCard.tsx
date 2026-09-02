// TransitionPreviewCard — the needs_choice confirm surface.
//
// Presents the frozen TransitionPlan for a lossy model switch BEFORE
// settlement: every nonzero disposition class in plain words, the
// exact-replay reassurance, and the plan identity. Confirm (Enter/y,
// `confirm:yes`) hands control back to the pick site, which re-derives
// staleness through confirmTransitionPlan and either settles through the
// ONE owner (settleModelSelection) or re-presents a regenerated plan —
// this card never writes state (law 3: one frozen plan; the plan never
// settles). Esc rides Dialog's built-in `confirm:no`.
//
// Design system: Dialog (the one dialog seam) · status spine AMBER for
// loss counts (warn), never the accent (information ≠ identity) · model
// ids are REAL, never themed · GLYPH bullets, no emoji.
import * as React from 'react'
import { Box, Text } from '../ink.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import type { TransitionPlan } from '../utils/model/modelTransition.js'
import type { ProviderUsability } from '../services/providers/providerUsability.js'
import { Dialog } from './design-system/Dialog.js'
import { AMBER, FAINT, TEAL } from './mercuryPalette.js'
import { GLYPH } from './mercury-ui/glyphs.js'

type Props = {
  plan: TransitionPlan
  fromLabel: string
  toLabel: string
  /** The previous confirm was stale — this is the REGENERATED plan. */
  refreshed?: boolean
  /** R06: the target provider's live usability — an unusable target
   *  warns HERE, before the operator confirms into a dead lane. */
  targetUsability?: ProviderUsability
  onConfirm: () => void
  onCancel: () => void
}

/** The nonzero loss rows, plain words, stable order. */
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
