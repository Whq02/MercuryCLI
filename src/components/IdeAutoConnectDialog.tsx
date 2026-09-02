// IDE auto-connect prompts. The enable prompt runs once outside a
// supported IDE terminal; either answer persists both the choice and the
// shown flag. The disable prompt appears when auto-connect is on but the
// terminal is not a supported IDE terminal; only "yes" persists it off.

import React from 'react'
import { Box, Text } from '../ink.js'
import { Select } from './CustomSelect/index.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { isSupportedTerminal } from '../utils/ide.js'

export function shouldShowAutoConnectDialog(): boolean {
  if (isSupportedTerminal()) return false
  const config = getGlobalConfig()
  if (config.autoConnectIde) return false
  return config.hasIdeAutoConnectDialogBeenShown !== true
}

export function shouldShowDisableAutoConnectDialog(): boolean {
  if (isSupportedTerminal()) return false
  return getGlobalConfig().autoConnectIde === true
}

export function IdeAutoConnectDialog({
  onComplete,
}: {
  onComplete: () => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={tokens.info}
      paddingX={1}
      gap={1}
    >
      <Text bold>Automatically connect to your IDE?</Text>
      <Text>
        When an IDE with the Mercury extension is available, Mercury can
        connect to it on startup.
      </Text>
      <Select
        options={[
          { label: 'Yes, connect automatically', value: 'yes' },
          { label: 'No', value: 'no' },
        ]}
        defaultFocusValue="yes"
        onChange={value => {
          saveGlobalConfig(current => ({
            ...current,
            autoConnectIde: value === 'yes',
            hasIdeAutoConnectDialogBeenShown: true,
          }))
          onComplete()
        }}
        onCancel={() => onComplete()}
      />
      <Text dimColor>
        You can change this any time in /settings or with the --ide flag.
      </Text>
    </Box>
  )
}

export function IdeDisableAutoConnectDialog({
  onComplete,
}: {
  onComplete: (disabled: boolean) => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={tokens.info}
      paddingX={1}
      gap={1}
    >
      <Text bold>Disable automatic IDE connection?</Text>
      <Text>
        Auto-connect is currently on. Mercury connects to an available IDE on
        startup.
      </Text>
      <Select
        options={[
          { label: 'No, keep auto-connect on', value: 'no' },
          { label: 'Yes, disable auto-connect', value: 'yes' },
        ]}
        defaultFocusValue="no"
        onChange={value => {
          if (value === 'yes') {
            saveGlobalConfig(current => ({
              ...current,
              autoConnectIde: false,
            }))
          }
          onComplete(value === 'yes')
        }}
        onCancel={() => onComplete(false)}
      />
      <Text dimColor>
        You can change this any time in /settings or with the --ide flag.
      </Text>
    </Box>
  )
}

export default IdeAutoConnectDialog
