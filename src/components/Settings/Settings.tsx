
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

  const diagnosticsPromise = useMemo(
    () => buildDiagnostics().catch((): [] => []),
    [],
  )

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
          {}
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
