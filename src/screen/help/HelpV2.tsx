
import * as React from 'react'
import { exitChordNoticeText } from '../composer/ExitChordNotice.js'
import { useMemo, useRef, useState } from 'react'
import { builtinCommands, type Command } from '../../commands/catalogue/commands.js'
import { useIsInsideModal, useModalScrollRef } from '../overlays/modalContext.js'
import { useExitChord } from '../keys/useExitChord.js'
import { useTerminalSize } from '../fullscreen-layout/useTerminalSize.js'
import { useKeybinding } from '../keys/useKeybinding.js'
import type { LocalJSXCommandOnDone } from '../../commands/catalogue/command.js'
import { useInput } from '../themedRenderer.js'
import { usePopupScrollWindow } from '../select/popup-list.js'
import { CommandCenter } from '../widgets/components.js'
import { Tab, Tabs } from '../theme/Tabs.js'
import { Commands } from './Commands.js'
import { General } from './General.js'
import { ShortcutsTab } from './ShortcutsTab.js'

const TAB_IDS = ['general', 'commands', 'custom-commands', 'shortcuts'] as const

export function Help({
  commands,
  onClose,
}: {
  commands: Command[]
  onClose: (
    value?: unknown,
    options?: Parameters<LocalJSXCommandOnDone>[1],
  ) => void
}): React.ReactNode {
  const { rows, columns } = useTerminalSize()
  const insideModal = useIsInsideModal()
  const exitState = useExitChord()
  const modalScroll = useModalScrollRef()
  const noScroll = useRef(null)
  const bodyWindow = usePopupScrollWindow(modalScroll ?? noScroll)

  const [tab, setTab] = useState('general')
  const dismiss = () => onClose('Help closed', { display: 'system' })
  useKeybinding('help:dismiss', dismiss, { context: 'Help' })

  const budget = Math.min(
    Math.max(Math.floor(rows / 2), Math.min(rows - 6, 30)),
    Math.max(rows - 6, 1),
  )

  const { builtins, custom } = useMemo(() => {
    const builtinNames = new Set(
      builtinCommands().map(command => command.userFacingName?.() ?? ''),
    )
    const visible = commands.filter(command => !command.isHidden)
    return {
      builtins: visible.filter(command =>
        builtinNames.has(command.userFacingName?.() ?? ''),
      ),
      custom: visible.filter(
        command => !builtinNames.has(command.userFacingName?.() ?? ''),
      ),
    }
  }, [commands])

  const stage = (commandName: string) =>
    onClose(undefined, { nextInput: `/${commandName} `, display: 'skip' })

  const bodyScrolls = bodyWindow.total > bodyWindow.rows
  const tabRowSelectable = tab === 'general' || tab === 'shortcuts'
  useInput(
    (_input, key, event) => {
      const delta = key.downArrow || key.pageDown ? 1 : key.upArrow || key.pageUp ? -1 : 0
      if (delta === 0) return
      event.stopImmediatePropagation()
      const at = TAB_IDS.indexOf(tab as (typeof TAB_IDS)[number])
      setTab(TAB_IDS[(at + delta + TAB_IDS.length) % TAB_IDS.length]!)
    },
    { isActive: tabRowSelectable && !bodyScrolls },
  )

  return (
    <CommandCenter
      view="help"
      onClose={dismiss}
      captureInput={false}
      bodyRestsAtTop
      bodyOwnsPageKeys={tab === 'commands' || tab === 'custom-commands'}
      closeKeys="esc"
      footer={
        exitState.pending
          ? exitChordNoticeText(exitState.keyName)
          : tabRowSelectable && !bodyScrolls
            ? '↑↓ switch tabs'
            : undefined
      }
    >
      <Tabs selectedTab={tab} onTabChange={setTab} contentHeight={insideModal ? undefined : budget}>
        <Tab title="general" id="general">
          <General />
        </Tab>
        <Tab title="commands" id="commands">
          <Commands
            commands={builtins}
            maxHeight={budget}
            columns={columns}
            title="Browse default commands"
            onCancel={dismiss}
            onPick={stage}
          />
        </Tab>
        <Tab title="custom-commands" id="custom-commands">
          <Commands
            commands={custom}
            maxHeight={budget}
            columns={columns}
            title="Browse custom commands"
            onCancel={dismiss}
            onPick={stage}
            emptyMessage="This project has no custom commands yet."
          />
        </Tab>
        <Tab title="shortcuts" id="shortcuts">
          <ShortcutsTab />
        </Tab>
      </Tabs>
    </CommandCenter>
  )
}
