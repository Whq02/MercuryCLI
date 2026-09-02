// The three-tab settings shell: status / config / usage inside a
// bordered pane, opened at the caller's default tab. Escape (the
// confirmation-cancel action, Settings context) closes with a dismissal —
// except while a submenu owns the screen (tabs hidden) or while the config
// tab owns escape (search mode with the keyboard, header unfocused).

import React, { Suspense, useMemo, useState } from 'react'
import type { LocalJSXCommandContext } from '../../commands.js'
import { useIsInsideModal, useModalOrTerminalSize } from '../../context/modalContext.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useExitOnCtrlCD } from '../../hooks/useExitOnCtrlCD.js'
import { useKeybinding, useKeybindings } from '../../keybindings/useKeybinding.js'
import type { CommandResultDisplay } from '../../types/command.js'
import { Pane } from '../design-system/Pane.js'
import { Tab, Tabs } from '../design-system/Tabs.js'
import { Config } from './Config.js'
import { Status, buildDiagnostics } from './Status.js'
import { Usage } from './Usage.js'

export type SettingsTabName = 'Status' | 'Config' | 'Usage'

export function Settings({
  onClose,
  context,
  defaultTab,
}: {
  onClose: (
    result?: unknown,
    options?: { display?: CommandResultDisplay },
  ) => void
  context: LocalJSXCommandContext
  defaultTab: SettingsTabName
}): React.ReactNode {
  const { rows } = useTerminalSize()
  const isInsideModal = useIsInsideModal()
  const modalSize = useModalOrTerminalSize({ rows, columns: 80 })
  const [tabsHidden, setTabsHidden] = useState(false)
  const [configOwnsEscape, setConfigOwnsEscape] = useState(false)

  // Diagnostics kick off once at mount; failures degrade to an empty list.
  const diagnosticsPromise = useMemo(
    () => buildDiagnostics().catch((): [] => []),
    [],
  )

  // Content height: inside a modal the modal's rows plus one; otherwise the
  // 80%-of-terminal band clamped to [15, 30].
  const contentHeight = isInsideModal
    ? modalSize.rows + 1
    : Math.max(15, Math.min(Math.floor(rows * 0.8), 30))

  useKeybinding(
    'confirm:no',
    () => {
      onClose()
    },
    {
      context: 'Settings',
      isActive: !tabsHidden && !configOwnsEscape,
    },
  )
  useExitOnCtrlCD(useKeybindings)

  return (
    <Pane>
      <Tabs
        title="Settings"
        defaultTab={defaultTab}
        hidden={tabsHidden}
        initialHeaderFocused={defaultTab !== 'Config'}
        contentHeight={
          !tabsHidden && !isInsideModal ? contentHeight : undefined
        }
      >
        <Tab title="Status">
          <Status context={context} diagnosticsPromise={diagnosticsPromise} />
        </Tab>
        <Tab title="Config">
          {/* The config tab suspends on the instruction-file read. */}
          <Suspense fallback={null}>
            <Config
              onClose={onClose}
              context={context}
              setTabsHidden={setTabsHidden}
              onIsSearchModeChange={setConfigOwnsEscape}
              contentHeight={contentHeight}
            />
          </Suspense>
        </Tab>
        <Tab title="Usage">
          <Usage />
        </Tab>
      </Tabs>
    </Pane>
  )
}
