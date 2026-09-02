// Sovereign-mode consent (step 9): a blocking warning shown
// before entering the mode without recorded standing consent. Decline-first
// option order; accepting persists consent into USER settings; declining
// exits 1; escape exits 0 — both via synchronous graceful shutdown.

import React from 'react'
import { Box, Text } from '../ink.js'
import { Select } from './CustomSelect/index.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { updateSettingsForSource } from '../utils/settings/settings.js'
import { gracefulShutdownSync } from '../utils/gracefulShutdown.js'

export function BypassPermissionsModeDialog({
  onAccept,
}: {
  onAccept: () => void
}): React.ReactNode {
  const tokens = useMercuryTokens()

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={tokens.failure}
      paddingX={1}
      gap={1}
    >
      <Text bold color={tokens.failure}>
        WARNING: Mercury running in Sovereign Mode
      </Text>
      <Box flexDirection="column">
        <Text>
          In Sovereign Mode, Mercury will not ask for your approval before
          running potentially dangerous commands.
        </Text>
        <Text>
          This mode should only be used in a sandboxed container or VM that has
          restricted internet access and can easily be restored if damaged.
        </Text>
        <Text>
          By proceeding, you accept all responsibility for actions taken while
          running in Sovereign Mode.
        </Text>
      </Box>
      <Select
        options={[
          { label: 'No, exit', value: 'decline' },
          { label: 'Yes, I accept', value: 'accept' },
        ]}
        onChange={value => {
          if (value === 'accept') {
            updateSettingsForSource('userSettings', {
              skipDangerousModePermissionPrompt: true,
            })
            onAccept()
          } else {
            gracefulShutdownSync(1)
          }
        }}
        onCancel={() => gracefulShutdownSync(0)}
      />
    </Box>
  )
}

export default BypassPermissionsModeDialog
