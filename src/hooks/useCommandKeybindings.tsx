
import { useMemo, useRef } from 'react'
import { useKeybindings } from '../keybindings/useKeybinding.js'
import { useOptionalKeybindingContext } from '../keybindings/KeybindingContext.js'
import { useIsModalOverlayActive } from '../context/overlayContext.js'
import type { PromptInputHelpers } from '../types/promptInputHelpers.js'
import { findCommand } from '../commands.js'
import type { Command } from '../commands.js'

const COMMAND_PREFIX = 'command:'

const inertHelpers: PromptInputHelpers = {
  setCursorOffset: () => {},
  clearBuffer: () => {},
  resetHistory: () => {},
}

export function CommandKeybindingHandlers({
  onSubmit,
  commands,
  isActive = true,
}: {
  onSubmit: (
    input: string,
    helpers: PromptInputHelpers,
    speculationAccept?: undefined,
    options?: { fromKeybinding?: boolean },
  ) => Promise<void>
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
        if (findCommand(name, commandsRef.current) === undefined) return
        void onSubmit(command, inertHelpers, undefined, { fromKeybinding: true })
      }
    }
    return out
  }, [keybindings, onSubmit])

  useKeybindings(handlers, {
    context: 'Chat',
    isActive: isActive && !overlayActive,
  })
  return null
}
