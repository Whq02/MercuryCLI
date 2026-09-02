// Release-channel downgrade check: switching to the conservative
// channel may install an older version than the one running. Borderless —
// it renders inside the settings submenu dialog.

import React from 'react'
import { Box, Text } from '../ink.js'
import { Select } from './CustomSelect/index.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'

export type ChannelDowngradeChoice = 'downgrade' | 'stay' | 'cancel'

export function ChannelDowngradeDialog({
  currentVersion,
  onChoice,
}: {
  currentVersion: string
  onChoice: (choice: ChannelDowngradeChoice) => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold color={tokens.warning}>
        Switch to the stable channel?
      </Text>
      <Text>
        The stable channel may currently carry an older version than the one
        you are running ({currentVersion}).
      </Text>
      <Select
        options={[
          { label: 'Switch now (may downgrade)', value: 'downgrade' },
          {
            label: `Stay on ${currentVersion} until stable catches up`,
            value: 'stay',
          },
        ]}
        onChange={value => onChoice(value as ChannelDowngradeChoice)}
        onCancel={() => onChoice('cancel')}
      />
    </Box>
  )
}

export default ChannelDowngradeDialog
