
import React from 'react'
import { Box, Text } from '../../ink.js'
import {
  agentModelPickOutcome,
  getAgentModelPickerRows,
  type AgentModelPickerRow,
} from '../../utils/model/agentModelPicker.js'
import { AMBER } from '../mercuryPalette.js'
import { Select } from '../CustomSelect/index.js'

export function ModelSelector({
  initialModel,
  onComplete,
  onCancel,
}: {
  initialModel?: string
  onComplete: (model: string | undefined) => void
  onCancel?: () => void
}): React.ReactNode {
  const [notice, setNotice] = React.useState<string | null>(null)
  const rows = React.useMemo(() => getAgentModelPickerRows(), [])
  const byValue = React.useMemo(() => new Map(rows.map(row => [row.value, row])), [rows])
  const options = React.useMemo(() => {
    const catalogueOptions = rows.map(row => {
      const detail = row.unavailable ?? row.description
      return {
        value: row.value,
        label: row.kind === 'connect' ? `${row.label} …` : row.label,
        description: detail === '' ? row.group : `${row.group} · ${detail}`,
      }
    })
    return initialModel !== undefined && !byValue.has(initialModel)
      ? [
          {
            label: initialModel,
            value: initialModel,
            description: 'Current model (custom id)',
          },
          ...catalogueOptions,
        ]
      : catalogueOptions
  }, [rows, byValue, initialModel])

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text dimColor>
          The model this agent runs on when it is launched — the full catalogue; rows without a credential name their sign-in.
        </Text>
      </Box>
      {notice !== null ? (
        <Box marginBottom={1}>
          <Text color={AMBER}>{notice}</Text>
        </Box>
      ) : null}
      <Select
        options={options}
        defaultValue={initialModel ?? 'inherit'}
        onChange={value => {
          const row = byValue.get(value)
          if (row === undefined) {
            onComplete(value)
            return
          }
          const outcome = agentModelPickOutcome(row)
          if (outcome.kind === 'needs-sign-in') {
            setNotice(`${outcome.hint} — /logins opens the sign-in catalogue`)
            return
          }
          onComplete(row.value)
        }}
        onCancel={() => {
          if (onCancel) onCancel()
          else onComplete(undefined)
        }}
      />
    </Box>
  )
}

export default ModelSelector
