// /help — a tabbed browser in the command-center shell. This file owns only
// the command partitioning, the height budget, the pick/close callbacks and
// the shell; the four tab bodies are siblings. The panel never advertises an
// external documentation URL: the panel is the help.

import * as React from 'react'
import { exitChordNoticeText } from '../PromptInput/ExitChordNotice.js'
import { useMemo } from 'react'
import { builtinCommands, type Command } from '../../commands.js'
import { useIsInsideModal } from '../../context/modalContext.js'
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { CommandCenter } from '../mercury-ui/components.js'
import { Tab, Tabs } from '../design-system/Tabs.js'
import { Commands } from './Commands.js'
import { General } from './General.js'
import { ShortcutsTab } from './ShortcutsTab.js'

export function HelpV2({
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
  const exitState = useExitOnCtrlCDWithKeybindings()

  const dismiss = () => onClose('Help closed', { display: 'system' })
  useKeybinding('help:dismiss', dismiss, { context: 'Help' })

  // At least half the terminal rows, allowed to grow to min(rows − 6, 30) —
  // the plain half-height rule starved the list to one visible entry on a
  // 24-row terminal. Always leave 6 rows of transcript visible.
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

  return (
    <CommandCenter
      view="help"
      onClose={dismiss}
      captureInput={false}
      closeKeys="esc"
      footer={
        exitState.pending
          ? exitChordNoticeText(exitState.keyName)
          : undefined
      }
    >
      <Tabs defaultTab="general" contentHeight={insideModal ? undefined : budget}>
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
