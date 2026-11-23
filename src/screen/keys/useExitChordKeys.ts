import { useKeybindings } from './useKeybinding.js'
import { useExitChord, type ExitState } from './useExitChord.js'

export function useExitChordKeys(
  onExit?: () => void,
  onInterrupt?: () => boolean,
  isActive?: boolean,
): ExitState {
  return useExitChord(useKeybindings, onInterrupt, onExit, isActive)
}
