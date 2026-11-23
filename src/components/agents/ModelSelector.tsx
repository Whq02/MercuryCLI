import React, { useState } from 'react'
import { Box, Text } from '../../ink.js'
import {
  type AgentModelPickerRow,
  agentModelPickOutcome,
  getAgentModelPickerRows,
} from '../../services/model/agentModelPicker.js'
import { parseUserSpecifiedModel } from '../../services/model/model.js'
import { AMBER } from '../mercuryPalette.js'
import { type OptionWithDescription, Select } from '../CustomSelect/select.js'

const CUSTOM_DESCRIPTION = 'Current model (custom id)'

function optionOf(row: AgentModelPickerRow): OptionWithDescription<string> {
  const detail = row.unavailable ?? row.description
  return {
    value: row.value,
    label: row.kind === 'connect' ? `${row.label} …` : row.label,
    description: detail === '' ? row.group : `${row.group} · ${detail}`,
  }
}

export function ModelSelector({
  initialModel,
  onComplete,
  onCancel,
}: {
  initialModel?: string
  onComplete: (model: string | undefined) => void
  onCancel?: () => void
}): React.ReactNode {
  const [rows] = useState(() => getAgentModelPickerRows())
  const [initial] = useState(() =>
    initialModel === undefined ? 'inherit' : parseUserSpecifiedModel(initialModel),
  )
  const [notice, setNotice] = useState<string | null>(null)

  const catalogue = rows.map(optionOf)
  const options = rows.some(row => row.value === initial)
    ? catalogue
    : [{ value: initial, label: initial, description: CUSTOM_DESCRIPTION }, ...catalogue]

  const choose = (value: string): void => {
    const row = rows.find(candidate => candidate.value === value)
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
  }

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
        defaultValue={initial}
        defaultFocusValue={initial}
        onChange={choose}
        onCancel={() => (onCancel ? onCancel() : onComplete(undefined))}
      />
    </Box>
  )
}

export default ModelSelector
