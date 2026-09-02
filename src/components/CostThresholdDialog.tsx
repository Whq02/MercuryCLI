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

function MercuryCostThreshold({ onDone }: Props): React.ReactNode {
  const cost = getFocusedSessionConnector().usage().totalCostUSD
  const tokens = useMercuryTokens()
  return (
    <CommandCenter
      view="cost threshold"
      footer="acknowledge to continue"
      onClose={onDone}
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
  return <MercuryCostThreshold onDone={onDone} />
}
