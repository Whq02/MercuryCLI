import { useKeybindings } from './useKeybinding.js'
import { useExitOnCtrlCD, type ExitState } from './useExitChord.js'

export function useExitOnCtrlCDWithKeybindings(
  onExit?: () => void,
  onInterrupt?: () => boolean,
  isActive?: boolean,
): ExitState {
  return useExitOnCtrlCD(useKeybindings, onInterrupt, onExit, isActive)
}
