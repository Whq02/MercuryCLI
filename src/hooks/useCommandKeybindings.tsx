// Command bindings: every `command:*` binding becomes a handler
// submitting the corresponding slash command — IMMEDIATE, with the typed
// draft left untouched (inert composer helpers + the keybinding marker).

import { useMemo } from 'react'
import { useKeybindings } from '../keybindings/useKeybinding.js'
import { useOptionalKeybindingContext } from '../keybindings/KeybindingContext.js'
import { useIsModalOverlayActive } from '../context/overlayContext.js'
import type { PromptInputHelpers } from '../types/promptInputHelpers.js'

const COMMAND_PREFIX = 'command:'

const inertHelpers: PromptInputHelpers = {
  setCursorOffset: () => {},
  clearBuffer: () => {},
  resetHistory: () => {},
}

export function CommandKeybindingHandlers({
  onSubmit,
  isActive = true,
}: {
  onSubmit: (
    input: string,
    helpers: PromptInputHelpers,
    speculationAccept?: undefined,
    options?: { fromKeybinding?: boolean },
  ) => Promise<void>
  isActive?: boolean
}): null {
  const keybindings = useOptionalKeybindingContext()
  const overlayActive = useIsModalOverlayActive()

  const handlers = useMemo(() => {
    const out: Record<string, () => void> = {}
    if (!keybindings) return out
    for (const binding of keybindings.bindings) {
      const action = binding.action
      if (action === null || !action.startsWith(COMMAND_PREFIX)) continue
      if (out[action] !== undefined) continue
      const command = `/${action.slice(COMMAND_PREFIX.length)}`
      out[action] = () => {
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
