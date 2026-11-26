import { useMemo, useRef } from 'react'
import { useKeybindings } from '../keys/useKeybinding.js'
import { useOptionalKeybindingContext } from '../keys/KeybindingContext.js'
import { useIsModalOverlayActive } from '../overlays/overlayHooks.js'
import type { ComposerHelpers } from '../composer/input-core/composerHelpers.js'
import { findCommand } from '../../commands/catalogue/commands.js'
import type { Command } from '../../commands/catalogue/commands.js'
import { unknownCommandLine } from '../../engine/user-input/processSlashCommand.js'

const COMMAND_PREFIX = 'command:'

const inertHelpers: ComposerHelpers = {
  setCursorOffset: () => {},
  clearBuffer: () => {},
  resetHistory: () => {},
}

export function CommandKeybindingHandlers({
  onSubmit,
  paintScreenCommandReceipt,
  commands,
  isActive = true,
}: {
  onSubmit: (
    input: string,
    helpers: ComposerHelpers,
    speculationAccept?: undefined,
    options?: { fromKeybinding?: boolean },
  ) => Promise<void>
  paintScreenCommandReceipt: (commandName: string, args: string, text: string) => void
  commands: Command[]
  isActive?: boolean
}): null {
  const keybindings = useOptionalKeybindingContext()
  const overlayActive = useIsModalOverlayActive()

  const commandsRef = useRef(commands)
  commandsRef.current = commands

  const handlers = useMemo(() => {
    const out: Record<string, () => void> = {}
    if (!keybindings) return out
    for (const binding of keybindings.bindings) {
      const action = binding.action
      if (action === null || !action.startsWith(COMMAND_PREFIX)) continue
      if (out[action] !== undefined) continue
      const name = action.slice(COMMAND_PREFIX.length)
      const command = `/${name}`
      out[action] = () => {
        if (findCommand(name, commandsRef.current) === undefined) {
          const trimmed = name.trim()
          paintScreenCommandReceipt(trimmed, '', unknownCommandLine(trimmed, commandsRef.current))
          return
        }
        void onSubmit(command, inertHelpers, undefined, { fromKeybinding: true })
      }
    }
    return out
  }, [keybindings, onSubmit, paintScreenCommandReceipt])

  useKeybindings(handlers, {
    context: 'Chat',
    isActive: isActive && !overlayActive,
  })
  return null
}
