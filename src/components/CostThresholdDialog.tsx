import React from 'react'
import { getFocusedSessionConnector } from '../services/engine-connector/focusedConnector.js'
import { Box, Text } from '../ink.js'
import { Select } from './CustomSelect/index.js'
import { CommandCenter } from './mercury-ui/components.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'

type Props = {
  onDone: () => void
}

export function CostThresholdDialog({ onDone }: Props): React.ReactNode {
  const tokens = useMercuryTokens()
  const cost = getFocusedSessionConnector().usage().totalCostUSD
  return (
    <CommandCenter
      view="cost"
      footer="↵ confirm · esc dismisses"
      onClose={onDone}
    >
      <Box flexDirection="column" marginTop={1}>
        <Text color={tokens.textPrimary}>
          {"You've spent "}
          <Text bold color={tokens.accent}>
            ${cost.toFixed(2)}
          </Text>
          {' on the Anthropic API this session.'}
        </Text>
        <Text color={tokens.textSecondary}>
          Track your spending anytime with /usage.
        </Text>
      </Box>
      <Box marginTop={1}>
        <Select
          options={[{ value: 'ok', label: 'Got it' }]}
          onChange={() => onDone()}
          onCancel={onDone}
        />
      </Box>
    </CommandCenter>
  )
}
