import { useRef } from 'react'
import { useNotifications } from '../context/notifications.js'
import type { Key } from '../ink.js'
import { addToHistory } from '../history.js'
import { markBackslashReturnUsed } from '../commands/keysetup/keysetup.js'
import { isBackslashContinuation } from '../input-core/backslashContinuation.js'
import type {
  InlineGhostText,
  TextInputState,
} from '../types/textInputTypes.js'
import {
  Cursor,
  getLastKill,
  recordYank,
  resetKillAccumulation,
  resetYankState,
  type SelectionPaint,
  updateYankLength,
  yankPop,
} from '../utils/Cursor.js'
import { env } from '../utils/env.js'
import { EXIT_CHORD_WINDOW_MS, useDoublePress } from './useDoublePress.js'
import { onInputOf, routeKeyOf, upOrHistoryOf } from './textInput/keys.js'
import { notBuilt, type Unbuilt } from '../pi/holes.js'

const ESCAPE_CLEAR_NOTIFICATION_KEY = 'escape-again-to-clear'

export type UseTextInputProps = Unbuilt

function isYankKey(input: string, key: Key): boolean {
  return Boolean((key.ctrl || key.meta) && input === 'y')
}

export type LiveInputState = { value: string; offset: number }

const liveStateReaders = new WeakMap<(value: string) => void, () => LiveInputState>()

export function bindLiveInputState(
  onChange: (value: string) => void,
  readLiveState: () => LiveInputState,
): void {
  liveStateReaders.set(onChange, readLiveState)
}

export function useTextInput(arg0: UseTextInputProps): TextInputState {
  return notBuilt('src/hooks/useTextInput.ts:85')
}
