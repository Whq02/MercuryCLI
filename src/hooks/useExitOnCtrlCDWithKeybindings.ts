
import { useKeybindings } from '../keybindings/useKeybinding.js'
import { useExitOnCtrlCD, type ExitState } from './useExitOnCtrlCD.js'

export type { ExitState }

export function useExitOnCtrlCDWithKeybindings(
  onExit?: () => void,
  onInterrupt?: () => boolean,
  isActive?: boolean,
): ExitState {
  return useExitOnCtrlCD(useKeybindings, onInterrupt, onExit, isActive)
}
