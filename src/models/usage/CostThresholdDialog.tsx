import React from 'react'
import { getFocusedSessionConnector } from '../../engine/connector/focusedConnector.js'
import { Box, Text } from '../../screen/themedRenderer.js'
import { Select } from '../../screen/select/index.js'
import { CommandCenter } from '../../screen/widgets/components.js'
import { useMercuryTokens } from '../../screen/widgets/useMercuryTokens.js'

type Props = {
  onDone: () => void
}

function MercuryCostThreshold({ onDone }: Props): React.ReactNode {
  const tokens = useMercuryTokens()
  const cost = getFocusedSessionConnector().usage().totalCostUSD
  return (
    <CommandCenter
      view="cost threshold"
      footer="↵ acknowledge to continue · esc close"
      onClose={onDone}
      captureInput
    >
      <Box flexDirection="column" marginTop={1}>
        <Text>
          <Text color={tokens.textPrimary}>{"You've spent "}</Text>
          <Text bold color={tokens.accent}>
            ${cost.toFixed(2)}
          </Text>
          <Text color={tokens.textPrimary}>{' on the Anthropic API this session.'}</Text>
        </Text>
        <Box marginTop={1}>
          <Text color={tokens.textSecondary}>Track your spending anytime with /usage.</Text>
        </Box>
        <Box marginTop={1}>
          <Select options={[{ value: 'ok', label: 'Got it' }]} onChange={onDone} />
        </Box>
      </Box>
    </CommandCenter>
  )
}

export function CostThresholdDialog({ onDone }: Props): React.ReactNode {
  return <MercuryCostThreshold onDone={onDone} />
}
