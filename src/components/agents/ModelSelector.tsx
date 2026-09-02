// The agent model chooser over THE ONE catalogue owner (the
// multiauth mandate: any model from the available catalogue, provider-
// neutral in the catalogue's own order). Rows ride getAgentModelPickerRows
// (getModelOptions' agent projection); UNAVAILABLE rows stay visible
// wearing their reason and picking one — or a connect/attach action row —
// names the sign-in door on a notice instead of committing (the draft is
// never abandoned mid-form; /logins is the chat's own door). An initial
// model outside the catalogue is prepended as its own row under its raw id
// (the landed custom-id law); the default highlight is the CURRENT value,
// else Inherit — never a hardcoded family.

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
      // Model rows carry no description (the neutrality ruling) — the row
      // detail is the group alone then; unavailable reasons and action-row
      // copy still ride after it.
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
            // The prepended custom id — the operator's own spelling stands.
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
