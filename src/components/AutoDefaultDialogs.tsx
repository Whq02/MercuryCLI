import React, { useEffect } from 'react'
import { Box, Text } from '../ink.js'
import type { PermissionMode } from '../types/permissions.js'
import { saveGlobalConfig } from '../utils/config.js'
import { permissionModeTitle } from '../utils/permissions/PermissionMode.js'
import { AUTO_DEFAULT_NOTICE_TEXT } from '../utils/permissions/shouldShowAutoDefaultNotice.js'
import { updateSettingsForSource } from '../utils/settings/settings.js'
import { Select } from './CustomSelect/select.js'
import { IVORY } from './mercuryPalette.js'
import { CommandCenter } from './mercury-ui/components.js'

// ============================================================================
// AutoDefaultDialogs — the flow-default UX pair.
// ----------------------------------------------------------------------------
//   - AutoDefaultNudgeDialog: a ONE-SHOT offer to make flow the user's
//     default permission mode. Its gate lives in
//     utils/permissions/shouldShowAutoDefaultNudge.ts; either answer marks it
//     seen, so it can never nag twice.
//   - AutoDefaultNotice: a one-shot informational notice for sessions whose
//     mode is already flow; it persists "seen" on mount so it shows exactly
//     once even if dismissed by unmount.
// Both wear the warm-ink CommandCenter shell.
// ============================================================================

const AUTO_MODE_DESCRIPTION =
  'Flow lets Mercury handle permission prompts automatically. Mercury checks each tool call for risky actions and prompt injection before executing, runs the ones it assesses as lower-risk, and asks you about the rest.'

type NudgeProps = {
  currentMode: PermissionMode
  onDone: (accepted: boolean) => void
}

export function AutoDefaultNudgeDialog({
  currentMode,
  onDone,
}: NudgeProps): React.ReactNode {
  const handleChoice = (choice: 'accept' | 'decline'): void => {
    if (choice === 'accept') {
      updateSettingsForSource('userSettings', {
        permissions: { defaultMode: 'flow' },
      })
    }
    // Seen is recorded on EITHER answer — declining must silence the nudge
    // just as thoroughly as accepting.
    saveGlobalConfig(c =>
      c.hasSeenAutoDefaultNudge === true
        ? c
        : { ...c, hasSeenAutoDefaultNudge: true },
    )
    onDone(choice === 'accept')
  }

  const options = [
    {
      label: 'Yes, set Flow as my default permission mode',
      value: 'accept',
    },
    {
      label: `No, keep ${permissionModeTitle(currentMode).toLowerCase()}`,
      value: 'decline',
    },
  ]

  return (
    <CommandCenter
      view="flow"
      subtitle="Make Flow your default permission mode?"
      footer="↑↓ choose · enter select · esc keep"
      onClose={() => handleChoice('decline')}
      captureInput={false}
    >
      <Box marginTop={1} marginBottom={1}>
        <Text color={IVORY}>{AUTO_MODE_DESCRIPTION}</Text>
      </Box>
      <Select
        options={options}
        onChange={(v: string) => handleChoice(v as 'accept' | 'decline')}
        onCancel={() => handleChoice('decline')}
      />
    </CommandCenter>
  )
}

export function AutoDefaultNotice({
  onDone,
}: {
  onDone: () => void
}): React.ReactNode {
  // Persist "seen" at mount, not at dismiss — a notice that unmounts without
  // an explicit answer still counts as shown.
  useEffect(() => {
    saveGlobalConfig(c =>
      c.hasSeenAutoDefaultNotice === true
        ? c
        : { ...c, hasSeenAutoDefaultNotice: true },
    )
  }, [])

  return (
    <CommandCenter
      view="flow"
      subtitle="Flow is the default permission mode"
      footer="enter / esc dismiss"
      onClose={onDone}
      captureInput={false}
    >
      <Box marginTop={1} marginBottom={1} flexDirection="column">
        <Text color={IVORY}>{AUTO_DEFAULT_NOTICE_TEXT}</Text>
      </Box>
      <Select
        options={[{ label: 'Got it', value: 'ok' }]}
        onChange={onDone}
        onCancel={onDone}
      />
    </CommandCenter>
  )
}
