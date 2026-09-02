// Time-based double-press exit on the interrupt/exit chords —
// time-based deliberately: the first interrupt press must ALSO trigger the
// interrupt behaviour, which a chord would suppress. The two keys are
// hard-coded and cannot be rebound. The registry arrives as a parameter
// purely to break an import cycle.

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
  // The exit override resolves once and serves both chords.
  const doExit = onExit ?? exit

  // Both exit chords ride the 3 s exit window, not the 800 ms editing
  // rhythm (Esc's double-tap keeps that).
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
        // The feature's interrupt callback runs first; true = handled, and
        // the double-press is not advanced.
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
