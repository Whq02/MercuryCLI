import React from 'react'
import { getFocusedSessionConnector } from '../services/engine-connector/focusedConnector.js'
import { Box, Text } from '../ink.js'
import { Select } from './CustomSelect/index.js'
import { Dialog } from './design-system/Dialog.js'
import { CommandCenter } from './mercury-ui/components.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'

type Props = {
  onDone: () => void
}

// The Mercury cost-threshold notice. Same trigger + same acknowledge
// contract as the base dialog (onDone fires on ack or esc), restyled onto the
// warm-ink command-center shell. The headline cost is the REAL session spend —
// the focused chat's usage door, the same source MercuryFrame and /deck
// read — never a hardcoded "$5" placeholder. Dismissable: the shell binds
// esc → onDone, and acknowledging the Select calls onDone too.
function MercuryCostThreshold({ onDone }: Props): React.ReactNode {
  const cost = getFocusedSessionConnector().usage().totalCostUSD
  // adaptive ink — unavoidable modal, tokens-resolved.
  const tokens = useMercuryTokens()
  return (
    <CommandCenter
      view="cost threshold"
      footer="acknowledge to continue"
      onClose={onDone}
      // The Select owns arrow/enter input; the shell still binds esc → onDone.
      captureInput={true}
    >
      <Box flexDirection="column" marginTop={1}>
        <Text>
          <Text color={tokens.textPrimary}>You've spent </Text>
          <Text bold color={tokens.accent}>
            ${cost.toFixed(2)}
          </Text>
          <Text color={tokens.textPrimary}> on the Anthropic API this session.</Text>
        </Text>
        <Box marginTop={1}>
          <Text color={tokens.textSecondary}>Track your spending anytime with /cost.</Text>
        </Box>
        <Box marginTop={1}>
          <Select
            options={[{ value: 'ok', label: 'Got it' }]}
            onChange={onDone}
          />
        </Box>
      </Box>
    </CommandCenter>
  )
}

export function CostThresholdDialog({ onDone }: Props): React.ReactNode {
  // Flag-gated showcase-to-live seam (folds to a constant at build): Mercury
  // renders the Mercury design wired to the real session cost; a bare stamp keeps
  // its original dialog. Mirrors the MercuryHome splash seam in Messages.tsx.
  return <MercuryCostThreshold onDone={onDone} />
}
