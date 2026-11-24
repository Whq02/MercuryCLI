import { useState } from 'react'
import { useApp } from '../themedRenderer.js'
import { EXIT_CHORD_WINDOW_MS, useDoublePress } from './useDoublePress.js'
import { useKeybindings } from './useKeybinding.js'

type ExitState = {
  pending: boolean
  keyName: 'Ctrl-C' | 'Ctrl-D' | null
}

export function useExitChord(
  onExit?: () => void,
  onInterrupt?: () => boolean,
  isActive = true,
): ExitState {
  const { exit } = useApp()
  const doExit = onExit ?? exit
  const [exitState, setExitState] = useState<ExitState>({
    pending: false,
    keyName: null,
  })

  const fireInterrupt = useDoublePress(
    pending => setExitState({ pending, keyName: pending ? 'Ctrl-C' : null }),
    doExit,
    undefined,
    EXIT_CHORD_WINDOW_MS,
  )

  const fireExit = useDoublePress(
    pending => setExitState({ pending, keyName: pending ? 'Ctrl-D' : null }),
    doExit,
    undefined,
    EXIT_CHORD_WINDOW_MS,
  )

  useKeybindings(
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
