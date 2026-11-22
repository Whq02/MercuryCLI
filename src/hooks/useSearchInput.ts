import { wordStartAfter, wordStartBefore } from '../utils/intl.js'
import { useCallback, useRef, useState } from 'react'
import { useInput } from '../ink.js'
import { KeyboardEvent } from '../ink/events/keyboard-event.js'
import { useTerminalSize } from './useTerminalSize.js'
import { notBuilt, type Unbuilt } from '../pi/holes.js'

type UseSearchInputOptions = Unbuilt

type UseSearchInputReturn = Unbuilt

const prevWordStart = (text: string, at: number): number => wordStartBefore(text, at)
const nextWordEnd = (text: string, at: number): number => wordStartAfter(text, at)

export function useSearchInput(arg0: UseSearchInputOptions): UseSearchInputReturn {
  return notBuilt('src/hooks/useSearchInput.ts:40')
}
