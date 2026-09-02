
import { useState } from 'react'
import { useApp } from '../ink.js'
import { EXIT_CHORD_WINDOW_MS, useDoublePress } from './useDoublePress.js'
import type {
  KeybindingHandlerResult,
  UseKeybindingOptions,
} from '../keybindings/useKeybinding.js'

export type ExitState = {
  pending: boolean
  keyName: 'Ctrl-C' | 'Ctrl-D' | null
}

type UseKeybindingsHook = (
  handlers: Record<string, () => KeybindingHandlerResult>,
  options?: UseKeybindingOptions,
) => void

export function useExitOnCtrlCD(
  useKeybindingsHook: UseKeybindingsHook,
  onInterrupt?: () => boolean,
  onExit?: () => void,
  isActive = true,
): ExitState {
  const { exit } = useApp()
  const [exitState, setExitState] = useState<ExitState>({
    pending: false,
    keyName: null,
  })
  const doExit = onExit ?? exit

  const fireInterrupt = useDoublePress(
    pending =>
      setExitState({ pending, keyName: pending ? 'Ctrl-C' : null }),
    () => doExit(),
    undefined,
    EXIT_CHORD_WINDOW_MS,
  )
  const fireExit = useDoublePress(
    pending =>
      setExitState({ pending, keyName: pending ? 'Ctrl-D' : null }),
    () => doExit(),
    undefined,
    EXIT_CHORD_WINDOW_MS,
  )

  useKeybindingsHook(
    {
      'app:interrupt': () => {
        if (onInterrupt?.() === true) return
        fireInterrupt()
      },
      'app:exit': () => {
        fireExit()
      },
    },
    { context: 'Global', isActive },
  )

  return exitState
}
