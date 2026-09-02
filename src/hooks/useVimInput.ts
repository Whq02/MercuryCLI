
import { useRef, useState } from 'react'
import type { Key } from '../ink.js'
import type { TextInputState, VimInputState } from '../types/textInputTypes.js'
import { Cursor } from '../utils/Cursor.js'
import { lastGrapheme } from '../utils/intl.js'
import {
  executeIndent,
  executeJoin,
  executeOpenLine,
  executeOperatorFind,
  executeOperatorMotion,
  executeOperatorTextObj,
  executeReplace,
  executeToggleCase,
  executeX,
} from '../vim/operators.js'
import { transition, type TransitionContext } from '../vim/transitions.js'
import {
  getSessionVimPersistentState,
  type CommandState,
  type PersistentState,
} from '../vim/types.js'
import { useTextInput, type UseTextInputProps } from './useTextInput.js'

export type VimMode = 'INSERT' | 'NORMAL'

export type UseVimInputProps = UseTextInputProps & {
  onModeChange?: (mode: VimMode) => void
  onUndo?: () => void
}

function isMotionExpectingState(state: CommandState): boolean {
  return (
    state.type === 'idle' ||
    state.type === 'count' ||
    state.type === 'operator' ||
    state.type === 'operatorCount'
  )
}

export function useVimInput(props: UseVimInputProps): VimInputState {
  const { inputFilter, onModeChange, onUndo, ...baseProps } = props
  const [mode, setModeState] = useState<VimMode>('INSERT')
  const modeRef = useRef<VimMode>('INSERT')
  const insertedTextRef = useRef('')
  const commandStateRef = useRef<CommandState>({ type: 'idle' })
  const persistentRef = useRef<PersistentState>(getSessionVimPersistentState())
  const replayingRef = useRef(false)

  const base: TextInputState = useTextInput(baseProps)

  function notifyMode(next: VimMode): void {
    modeRef.current = next
    setModeState(next)
    onModeChange?.(next)
  }

  function enterInsertMode(offset?: number): void {
    if (offset !== undefined) props.onOffsetChange(offset)
    insertedTextRef.current = ''
    notifyMode('INSERT')
  }

  function enterNormalMode(): void {
    if (modeRef.current === 'INSERT' && insertedTextRef.current) {
      persistentRef.current.lastChange = {
        type: 'insert',
        text: insertedTextRef.current,
      }
    }
    const offset = props.externalOffset
    if (offset > 0 && props.value[offset - 1] !== '\n') {
      props.onOffsetChange(offset - 1)
    }
    commandStateRef.current = { type: 'idle' }
    notifyMode('NORMAL')
  }

  function setMode(next: VimMode): void {
    if (next === 'INSERT') {
      insertedTextRef.current = ''
    } else {
      commandStateRef.current = { type: 'idle' }
    }
    notifyMode(next)
  }

  function makeContext(): TransitionContext {
    return {
      cursor: Cursor.fromText(props.value, props.columns, props.externalOffset),
      text: props.value,
      setText: text => props.onChange(text),
      setOffset: offset => props.onOffsetChange(offset),
      enterInsert: offset => enterInsertMode(offset),
      getRegister: () => persistentRef.current.register,
      setRegister: (content, linewise) => {
        persistentRef.current.register = content
        persistentRef.current.registerIsLinewise = linewise
      },
      getLastFind: () => persistentRef.current.lastFind,
      setLastFind: (type, char) => {
        persistentRef.current.lastFind = { type, char }
      },
      recordChange: change => {
        if (!replayingRef.current) {
          persistentRef.current.lastChange = change
        }
      },
      onUndo,
      onDotRepeat: () => replayLastChange(),
    }
  }

  function replayLastChange(): void {
    const change = persistentRef.current.lastChange
    if (!change) return
    replayingRef.current = true
    try {
      const ctx = makeContext()
      switch (change.type) {
        case 'insert': {
          const next = ctx.cursor.insert(change.text)
          ctx.setText(next.text)
          ctx.setOffset(next.offset)
          break
        }
        case 'operator':
          executeOperatorMotion(change.op, change.motion, change.count, ctx)
          break
        case 'operatorTextObj':
          executeOperatorTextObj(
            change.op,
            change.scope,
            change.objType,
            change.count,
            ctx,
          )
          break
        case 'operatorFind':
          executeOperatorFind(
            change.op,
            change.find,
            change.char,
            change.count,
            ctx,
          )
          break
        case 'replace':
          executeReplace(change.char, change.count, ctx)
          break
        case 'x':
          executeX(change.count, ctx)
          break
        case 'toggleCase':
          executeToggleCase(change.count, ctx)
          break
        case 'indent':
          executeIndent(change.dir, change.count, ctx)
          break
        case 'openLine':
          executeOpenLine(change.direction, ctx)
          break
        case 'join':
          executeJoin(change.count, ctx)
          break
      }
    } finally {
      replayingRef.current = false
    }
  }

  const onInput = (rawInput: string, key: Key): void => {
    const filtered = inputFilter ? inputFilter(rawInput, key) : rawInput
    const isInsert = modeRef.current === 'INSERT'

    if (key.ctrl) {
      base.onInput(isInsert ? filtered : rawInput, key)
      return
    }

    if (key.escape) {
      if (isInsert) enterNormalMode()
      else commandStateRef.current = { type: 'idle' }
      return
    }

    if (key.return) {
      base.onInput(isInsert ? filtered : rawInput, key)
      return
    }

    if (isInsert) {
      if (key.backspace || key.delete) {
        const buffer = insertedTextRef.current
        if (buffer) {
          insertedTextRef.current = buffer.slice(
            0,
            buffer.length - lastGrapheme(buffer).length,
          )
        }
      } else {
        insertedTextRef.current += filtered
      }
      base.onInput(filtered, key)
      return
    }

    const commandState = commandStateRef.current

    if (
      commandState.type === 'idle' &&
      (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow)
    ) {
      base.onInput(rawInput, key)
      return
    }

    let input = rawInput
    if (key.leftArrow) input = 'h'
    else if (key.rightArrow) input = 'l'
    else if (key.upArrow) input = 'k'
    else if (key.downArrow) input = 'j'
    else if (key.backspace) {
      input = isMotionExpectingState(commandState) ? 'h' : ''
    } else if (key.delete) {
      if (commandState.type === 'count') {
        return
      }
      input = isMotionExpectingState(commandState) ? 'x' : ''
    }

    const wasIdle = commandState.type === 'idle'
    const result = transition(commandState, input, makeContext())
    result.execute?.()
    if (modeRef.current === 'NORMAL') {
      if (result.next) commandStateRef.current = result.next
      else if (result.execute) commandStateRef.current = { type: 'idle' }
    }

    if (wasIdle && input === '?' && props.value === '') {
      props.onChange('?')
    }
  }

  return {
    ...base,
    onInput,
    mode,
    setMode,
  }
}
