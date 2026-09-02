// The blocking approval gate for dangerous managed settings. Lists setting
// NAMES only — printing a value here could echo an API-key helper command or
// a token-bearing env variable. Exit, cancel and the confirm-no binding all
// mean reject.

import * as React from 'react'
import { Box, Text } from '../../ink.js'
import type { SettingsJson } from '../../utils/settings/types.js'
import { Dialog } from '../design-system/Dialog.js'
import { Select } from '../CustomSelect/select.js'
import {
  dangerousSettingNames,
  extractDangerousSettings,
} from './utils.js'

export function ManagedSettingsSecurityDialog({
  settings,
  onAccept,
  onReject,
}: {
  settings: SettingsJson
  onAccept: () => void
  onReject: () => void
}): React.ReactNode {
  const names = dangerousSettingNames(extractDangerousSettings(settings))

  return (
    <Dialog title="Managed settings need your approval" onCancel={onReject}>
      <Text wrap="wrap">
        Your organisation has configured managed settings that could execute
        arbitrary code on this machine or intercept prompts and responses.
      </Text>
      <Box flexDirection="column" marginY={1} paddingLeft={2}>
        {names.map(name => (
          <Text key={name} bold>
            {name}
          </Text>
        ))}
      </Box>
      <Text wrap="wrap" dimColor>
        Accept only if you trust your IT administration and expect these
        settings.
      </Text>
      <Select
        options={[
          { label: 'Trust these settings', value: 'trust' },
          { label: 'Exit', value: 'exit' },
        ]}
        onChange={value => {
          if (value === 'trust') onAccept()
          else onReject()
        }}
        onCancel={onReject}
      />
    </Dialog>
  )
}
