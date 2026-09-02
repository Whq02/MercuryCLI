// Two-option override picker: allow an unsandboxed fallback vs
// strict mode, writing one setting. Disabled sandboxing and policy locks
// each early-return BEFORE the select mounts — the select (and its
// tab-header focus opt-in) lives in its own component so the down-arrow
// opt-in cannot register on a tab with no list, which would let the
// operator move focus off the header and be stranded.

import React from 'react'
import { Box, Text } from '../../ink.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import { Select } from '../CustomSelect/select.js'
import { useTabHeaderFocus } from '../design-system/Tabs.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'

function OverridesSelect({
  onComplete,
}: {
  onComplete: (result?: string) => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const { focusHeader } = useTabHeaderFocus()
  const allowFallback = SandboxManager.areUnsandboxedCommandsAllowed()
  const current = allowFallback ? 'allow' : 'strict'
  const mark = (option: string): React.ReactNode =>
    current === option ? <Text color={tokens.success}> (current)</Text> : null

  const write = (value: 'allow' | 'strict'): void => {
    SandboxManager.setSandboxSettings({
      allowUnsandboxedCommands: value === 'allow',
    })
    onComplete(
      value === 'allow'
        ? 'Unsandboxed fallback allowed: commands that cannot run sandboxed may run with regular permissions.'
        : 'Strict mode: commands that cannot run sandboxed are refused.',
    )
  }

  return (
    <Box flexDirection="column">
      <Select
        options={[
          {
            label: (
              <Text>
                Allow unsandboxed fallback
                {mark('allow')}
              </Text>
            ),
            value: 'allow',
          },
          {
            label: (
              <Text>
                Strict mode
                {mark('strict')}
              </Text>
            ),
            value: 'strict',
          },
        ]}
        defaultValue={current}
        onChange={value => write(value as 'allow' | 'strict')}
        onCancel={() => onComplete()}
        onUpFromFirstItem={focusHeader}
      />
      <Box flexDirection="column" marginTop={1}>
        <Text color={tokens.textSecondary}>
          Allow unsandboxed fallback: a command the sandbox cannot run is
          retried outside it under your regular permission rules.
        </Text>
        <Text color={tokens.textSecondary}>
          Strict mode: a command the sandbox cannot run fails instead of
          escaping the sandbox.
        </Text>
      </Box>
    </Box>
  )
}

export function SandboxOverridesTab({
  onComplete,
}: {
  onComplete: (result?: string) => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  if (!SandboxManager.isSandboxingEnabled()) {
    return (
      <Text color={tokens.textSecondary}>
        Sandboxing is disabled — there is nothing to override.
      </Text>
    )
  }
  if (SandboxManager.areSandboxSettingsLockedByPolicy()) {
    return (
      <Box flexDirection="column">
        <Text color={tokens.textSecondary}>
          Sandbox settings are managed by a higher-priority policy and cannot
          be changed here.
        </Text>
        <Text>
          Unsandboxed fallback:{' '}
          <Text bold>
            {SandboxManager.areUnsandboxedCommandsAllowed()
              ? 'allowed'
              : 'strict'}
          </Text>
        </Text>
      </Box>
    )
  }
  return <OverridesSelect onComplete={onComplete} />
}
