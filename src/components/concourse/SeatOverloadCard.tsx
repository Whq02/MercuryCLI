import React, { useMemo } from 'react'
import { Box, Text } from '../../ink.js'
import { describeSeatReading } from '../../services/switchboard/capacityCheck.js'
import { PermissionDialog } from '../permissions/PermissionDialog.js'
import { PermissionPrompt, type PermissionPromptOption } from '../permissions/PermissionPrompt.js'


export function needsSeatOverloadAsk(live: number, ceiling: number): boolean {
  return live >= ceiling
}

type SeatOverloadAnswer = 'yes' | 'no'

export function SeatOverloadCard({
  live,
  ceiling,
  onAnswer,
}: {
  live: number
  ceiling: number
  onAnswer: (allowed: boolean) => void
}): React.ReactNode {
  const options = useMemo<PermissionPromptOption<SeatOverloadAnswer>[]>(
    () => [
      { label: 'Yes — queue it; it starts when a seat frees', value: 'yes' },
      { label: 'No, dispatch nothing (esc)', value: 'no' },
    ],
    [],
  )
  return (
    <Box flexDirection="column" flexShrink={0}>
      <PermissionDialog title="Past the machine's reading">
        <Box flexDirection="column" flexShrink={0}>
          <Box flexShrink={0}>
            <Text wrap="wrap">
              session <Text bold>{live + 1}</Text> over {describeSeatReading(ceiling)}
            </Text>
          </Box>
          <Box flexShrink={0}>
            <Text dimColor wrap="wrap">
              every seat is taken right now — this dispatch would run past the reading. Yes queues it
              (it starts the moment a seat frees; the seats cell reads {live + 1}/{ceiling}· while
              over). No dispatches nothing — your words stay in the composer.
            </Text>
          </Box>
          <PermissionPrompt
            options={options}
            onSelect={value => onAnswer(value === 'yes')}
            onCancel={() => onAnswer(false)}
          />
        </Box>
      </PermissionDialog>
    </Box>
  )
}
