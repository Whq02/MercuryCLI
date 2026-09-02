// The tabbed sandbox settings surface; owns the Mode tab. When
// dependency ERRORS exist only the Dependencies tab renders; otherwise
// Mode, then Dependencies when warnings exist, then Overrides, then Config.
// The cancel binding (Settings context) completes with a skip display.

import React from 'react'
import { Box, Text } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import type { CommandResultDisplay } from '../../types/command.js'
import {
  SandboxManager,
  type SandboxDependencyCheck,
} from '../../utils/sandbox/sandbox-adapter.js'
import { getSettings_DEPRECATED } from '../../utils/settings/settings.js'
import { Select } from '../CustomSelect/select.js'
import { Pane } from '../design-system/Pane.js'
import { Tab, Tabs, useTabHeaderFocus } from '../design-system/Tabs.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { SandboxConfigTab } from './SandboxConfigTab.js'
import { SandboxDependenciesTab } from './SandboxDependenciesTab.js'
import { SandboxOverridesTab } from './SandboxOverridesTab.js'

type SandboxMode = 'auto-allow' | 'regular' | 'disabled'

type OnComplete = (
  result?: string,
  options?: { display?: CommandResultDisplay },
) => void

function currentMode(): SandboxMode {
  if (!SandboxManager.isSandboxEnabledInSettings()) return 'disabled'
  if (SandboxManager.isAutoAllowBashIfSandboxedEnabled()) return 'auto-allow'
  return 'regular'
}

function allowAllUnixSocketsOn(): boolean {
  const settings = getSettings_DEPRECATED() as {
    sandbox?: { network?: { allowAllUnixSockets?: boolean } }
  }
  return settings.sandbox?.network?.allowAllUnixSockets === true
}

function SandboxModeTab({
  onComplete,
  depCheck,
}: {
  onComplete: OnComplete
  depCheck: SandboxDependencyCheck
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const { focusHeader } = useTabHeaderFocus()
  const mode = currentMode()
  const socketWarning =
    depCheck.warnings.length > 0 && !allowAllUnixSocketsOn()

  const mark = (option: SandboxMode): React.ReactNode =>
    mode === option ? <Text color={tokens.success}> (current)</Text> : null

  const apply = (option: SandboxMode): void => {
    switch (option) {
      case 'auto-allow':
        SandboxManager.setSandboxSettings({
          enabled: true,
          autoAllowBashIfSandboxed: true,
        })
        onComplete(
          'Sandboxing on with auto-allow: commands run sandboxed without permission prompts; anything that cannot run sandboxed falls back to your regular permission rules.',
        )
        return
      case 'regular':
        SandboxManager.setSandboxSettings({
          enabled: true,
          autoAllowBashIfSandboxed: false,
        })
        onComplete(
          'Sandboxing on with regular permissions: commands run sandboxed and your permission rules still apply to each one.',
        )
        return
      case 'disabled':
        SandboxManager.setSandboxSettings({
          enabled: false,
          autoAllowBashIfSandboxed: false,
        })
        onComplete('Sandboxing off: commands run with regular permissions only.')
    }
  }

  return (
    <Box flexDirection="column">
      {socketWarning ? (
        <Box marginBottom={1}>
          <Text color={tokens.warning}>
            Unix domain sockets cannot be blocked on this system — see the
            Dependencies tab.
          </Text>
        </Box>
      ) : null}
      <Select
        options={[
          {
            label: (
              <Text>
                Sandboxed with auto-allow
                {mark('auto-allow')}
              </Text>
            ),
            value: 'auto-allow',
          },
          {
            label: (
              <Text>
                Sandboxed with regular permissions
                {mark('regular')}
              </Text>
            ),
            value: 'regular',
          },
          {
            label: (
              <Text>
                No sandbox
                {mark('disabled')}
              </Text>
            ),
            value: 'disabled',
          },
        ]}
        defaultValue={mode}
        onChange={value => apply(value as SandboxMode)}
        onCancel={() => onComplete(undefined, { display: 'skip' })}
        onUpFromFirstItem={focusHeader}
      />
      <Box flexDirection="column" marginTop={1}>
        <Text color={tokens.textSecondary}>
          Auto-allow: attempts run sandboxed first and fall back to regular
          permissions when the sandbox cannot run them; explicit ask/deny
          rules always win.
        </Text>
      </Box>
      {mode !== 'disabled' ? null : (
        <Box marginTop={1}>
          <Text color={tokens.textSecondary}>
            Sandboxing is currently off.
          </Text>
        </Box>
      )}
    </Box>
  )
}

export function SandboxSettings({
  onComplete,
  depCheck,
}: {
  onComplete: OnComplete
  depCheck: SandboxDependencyCheck
}): React.ReactNode {
  useKeybinding(
    'confirm:no',
    () => {
      onComplete(undefined, { display: 'skip' })
    },
    { context: 'Settings' },
  )

  const errorsOnly = depCheck.errors.length > 0

  // Tab children must be DIRECT (the tab walker does not descend into
  // fragments) — build the list as an array.
  const tabs: React.ReactNode[] = []
  if (errorsOnly) {
    tabs.push(
      <Tab key="deps" title="Dependencies">
        <SandboxDependenciesTab depCheck={depCheck} />
      </Tab>,
    )
  } else {
    tabs.push(
      <Tab key="mode" title="Mode">
        <SandboxModeTab onComplete={onComplete} depCheck={depCheck} />
      </Tab>,
    )
    if (depCheck.warnings.length > 0) {
      tabs.push(
        <Tab key="deps" title="Dependencies">
          <SandboxDependenciesTab depCheck={depCheck} />
        </Tab>,
      )
    }
    tabs.push(
      <Tab key="overrides" title="Overrides">
        <SandboxOverridesTab onComplete={onComplete} />
      </Tab>,
      <Tab key="config" title="Config">
        <SandboxConfigTab />
      </Tab>,
    )
  }

  return (
    <Pane>
      <Tabs title="Sandbox" defaultTab="Mode">
        {tabs}
      </Tabs>
    </Pane>
  )
}
