// API-key consent: an API key found in the environment whose
// truncated form has never been approved or rejected. Names the variable,
// shows the truncated tail, defaults to No (recommended); either answer is
// persisted into the matching response list.

import React, { useCallback } from 'react'
import { Box, Text } from '../ink.js'
import { Select } from './CustomSelect/index.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'

export function ApproveApiKey({
  customApiKeyTruncated,
  onDone,
}: {
  customApiKeyTruncated: string
  onDone: (approved: boolean) => void
}): React.ReactNode {
  const tokens = useMercuryTokens()

  const decide = useCallback(
    (approved: boolean) => {
      saveGlobalConfig(current => {
        const responses = current.customApiKeyResponses ?? {
          approved: [],
          rejected: [],
        }
        const list = approved
          ? (responses.approved ?? [])
          : (responses.rejected ?? [])
        if (list.includes(customApiKeyTruncated)) return current
        return {
          ...current,
          customApiKeyResponses: {
            approved: approved
              ? [...(responses.approved ?? []), customApiKeyTruncated]
              : (responses.approved ?? []),
            rejected: approved
              ? (responses.rejected ?? [])
              : [...(responses.rejected ?? []), customApiKeyTruncated],
          },
        }
      })
      onDone(approved)
    },
    [customApiKeyTruncated, onDone],
  )
  void getGlobalConfig

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={tokens.warning}
      paddingX={1}
      gap={1}
    >
      <Text bold color={tokens.warning}>
        Detected a custom API key in your environment
      </Text>
      <Text>
        ANTHROPIC_API_KEY: <Text bold>sk-ant-…{customApiKeyTruncated}</Text>
      </Text>
      <Text>Do you want to use this API key?</Text>
      <Select
        options={[
          { label: 'Yes', value: 'yes' },
          { label: 'No (recommended)', value: 'no' },
        ]}
        defaultValue="no"
        defaultFocusValue="no"
        onChange={value => decide(value === 'yes')}
        onCancel={() => decide(false)}
      />
    </Box>
  )
}

export default ApproveApiKey
