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

  const recordChoice = useCallback(
    (approved: boolean): void => {
      const current = getGlobalConfig()
      const responses = current.customApiKeyResponses
      const list = approved ? (responses?.approved ?? []) : (responses?.rejected ?? [])
      if (!list.includes(customApiKeyTruncated)) {
        saveGlobalConfig(prev => {
          const prevResponses = prev.customApiKeyResponses
          const prevApproved = prevResponses?.approved ?? []
          const prevRejected = prevResponses?.rejected ?? []
          const targetList = approved ? prevApproved : prevRejected
          if (targetList.includes(customApiKeyTruncated)) return prev
          return {
            ...prev,
            customApiKeyResponses: {
              ...prevResponses,
              approved: approved ? [...prevApproved, customApiKeyTruncated] : prevApproved,
              rejected: approved ? prevRejected : [...prevRejected, customApiKeyTruncated],
            },
          }
        })
      }
      onDone(approved)
    },
    [customApiKeyTruncated, onDone],
  )

  const handleChange = useCallback(
    (value: 'yes' | 'no'): void => {
      recordChoice(value === 'yes')
    },
    [recordChoice],
  )

  const handleCancel = useCallback((): void => {
    recordChoice(false)
  }, [recordChoice])

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={tokens.warning}
      paddingX={1}
      gap={1}
    >
      <Text bold color={tokens.warning}>
        An Anthropic API key is set in your environment
      </Text>
      <Text>
        ANTHROPIC_API_KEY: <Text bold>sk-ant-…{customApiKeyTruncated}</Text>
      </Text>
      <Text>Use this key for Anthropic usage-based billing?</Text>
      <Select<'yes' | 'no'>
        defaultValue="no"
        defaultFocusValue="no"
        options={[
          { label: 'Yes, use it', value: 'yes' },
          { label: 'No, ignore it', value: 'no' },
        ]}
        onChange={handleChange}
        onCancel={handleCancel}
      />
    </Box>
  )
}

export default ApproveApiKey
