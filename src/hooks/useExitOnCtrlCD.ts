import { useState } from 'react'
import { useApp } from '../ink.js'
import { EXIT_CHORD_WINDOW_MS, useDoublePress } from './useDoublePress.js'
import type {
  KeybindingHandlerResult,
  UseKeybindingOptions,
} from '../keybindings/useKeybinding.js'
import { notBuilt, type Unbuilt } from '../pi/holes.js'

export type ExitState = Unbuilt

type UseKeybindingsHook = (...args: Unbuilt[]) => Unbuilt

export function useExitOnCtrlCD(
  useKeybindingsHook: UseKeybindingsHook,
  onInterrupt?: () => boolean,
  onExit?: () => void,
  isActive?: boolean,
): ExitState {
  return notBuilt('src/hooks/useExitOnCtrlCD.ts:20')
}
