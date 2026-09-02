import * as React from 'react'
import { useMemo } from 'react'
import { Box, Text } from '../../../ink.js'
import { Select } from '../../CustomSelect/select.js'
import { useAppState } from '../../../state/AppState.js'
import { handlePlanModeTransition } from '../../../bootstrap/state.js'
import { getModeColor } from '../../../utils/permissions/PermissionMode.js'
import type { Theme } from '../../../utils/theme.js'
import { PermissionDialog } from '../PermissionDialog.js'
import { usePermissionRequestLogging } from '../hooks.js'
import type { PermissionRequestProps } from '../PermissionRequest.js'

type EnterPlanOptionValue = 'yes' | 'no'

const PLAN_STEPS = [
  'Explore the codebase thoroughly',
  'Identify existing patterns',
  'Design an implementation strategy',
  'Present a plan for approval',
]

export function EnterPlanModePermissionRequest({
  toolUseConfirm,
  onDone,
  onReject,
  workerBadge,
}: PermissionRequestProps): React.ReactNode {
  const currentMode = useAppState(state => state.toolPermissionContext.mode)

  usePermissionRequestLogging(
    toolUseConfirm,
    useMemo(() => ({ completion_type: 'tool_use_single', language_name: 'none' }), []),
  )

  function handleChange(value: EnterPlanOptionValue): void {
    if (value === 'yes') {
      handlePlanModeTransition(currentMode, 'strategy')
      onDone()
      toolUseConfirm.onAllow({}, [{ type: 'setMode', mode: 'strategy', destination: 'session' }])
      return
    }
    onDone()
    onReject()
    toolUseConfirm.onReject()
  }

  return (
    <PermissionDialog
      title="Enter strategy mode?"
      color={getModeColor('strategy') as keyof Theme}
      workerBadge={workerBadge}
    >
      <Box flexDirection="column">
        <Text>Mercury wants to explore and design an implementation approach first.</Text>
        <Text dimColor>In strategy mode it will:</Text>
        {PLAN_STEPS.map(step => (
          <Text key={step} dimColor>
            {'  - '}
            {step}
          </Text>
        ))}
        <Text>No code changes happen until the plan is approved.</Text>
        <Select
          options={[
            { label: 'Yes, enter strategy mode', value: 'yes' },
            { label: 'No, start implementing now', value: 'no' },
          ]}
          onChange={handleChange}
          onCancel={() => handleChange('no')}
        />
      </Box>
    </PermissionDialog>
  )
}
