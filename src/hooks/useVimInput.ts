import { useRef, useState } from 'react'
import { usePublish } from './effects.js'
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
  type RecordedChange,
  type CommandState,
  type PersistentState,
} from '../vim/types.js'
import { useTextInput, type UseTextInputProps } from './useTextInput.js'

export type VimMode = 'INSERT' | 'NORMAL'

export type UseVimInputProps = UseTextInputProps & {
  onModeChange?: (mode: VimMode) => void
  onUndo?: () => void
  initialMode?: VimMode
}

function isMotionExpectingState(state: CommandState): boolean {
  return (
    state.type === 'idle' ||
    state.type === 'count' ||
    state.type === 'operator' ||
    state.type === 'operatorCount'
  )
}

type ChangeKind = RecordedChange['type']

type Replayer<Kind extends ChangeKind> = (
  change: Extract<RecordedChange, { type: Kind }>,
  ctx: TransitionContext,
) => void

const REPLAYERS: { [Kind in ChangeKind]: Replayer<Kind> } = {
  insert: ({ text }, ctx) => {
    const next = ctx.cursor.insert(text)
    ctx.setText(next.text)
    ctx.setOffset(next.offset)
  },
  operator: ({ op, motion, count }, ctx) => executeOperatorMotion(op, motion, count, ctx),
  operatorTextObj: ({ op, scope, objType, count }, ctx) => executeOperatorTextObj(op, scope, objType, count, ctx),
  operatorFind: ({ op, find, char, count }, ctx) => executeOperatorFind(op, find, char, count, ctx),
  replace: ({ char, count }, ctx) => executeReplace(char, count, ctx),
  x: ({ count }, ctx) => executeX(count, ctx),
  toggleCase: ({ count }, ctx) => executeToggleCase(count, ctx),
  indent: ({ dir, count }, ctx) => executeIndent(dir, count, ctx),
  openLine: ({ direction }, ctx) => executeOpenLine(direction, ctx),
  join: ({ count }, ctx) => executeJoin(count, ctx),
}

function replay(change: RecordedChange, ctx: TransitionContext): void {
  const run = REPLAYERS[change.type] as (change: RecordedChange, ctx: TransitionContext) => void
  run(change, ctx)
}

export function useVimInput(props: UseVimInputProps): VimInputState {
  const { onModeChange, onUndo, initialMode, inputFilter, ...textInputProps } = props
  const [mode, setModeState] = useState<VimMode>('INSERT')
  const modeRef = useRef<VimMode>('INSERT')
  const pendingFollowRef = useRef<VimMode | undefined>(undefined)
  const onModeChangeRef = useRef(onModeChange)
  onModeChangeRef.current = onModeChange
  const commandStateRef = useRef<CommandState>({ type: 'idle' })
  const insertedTextRef = useRef<string>('')

  if (initialMode !== undefined && initialMode !== modeRef.current) {
    if (initialMode === 'INSERT') {
      insertedTextRef.current = ''
    } else {
      commandStateRef.current = { type: 'idle' }
    }
    modeRef.current = initialMode
    pendingFollowRef.current = initialMode
    setModeState(initialMode)
  }

  const base: TextInputState = useTextInput(textInputProps)

  const replayingRef = useRef<boolean>(false)
  const persistent: PersistentState = getSessionVimPersistentState()

  const setMode = (nextMode: VimMode): void => {
    if (nextMode === modeRef.current) return
    modeRef.current = nextMode
    setModeState(nextMode)
    onModeChangeRef.current?.(nextMode)
  }

  usePublish(() => {
    const followed = pendingFollowRef.current
    if (followed === undefined) return
    pendingFollowRef.current = undefined
    onModeChangeRef.current?.(followed)
  }, [mode])

  const recordChange = (change: RecordedChange): void => {
    if (replayingRef.current) return
    persistent.lastChange = change
  }

  const enterInsertMode = (offset?: number): void => {
    if (offset !== undefined) {
      base.setOffset(offset)
    }
    insertedTextRef.current = ''
    commandStateRef.current = { type: 'idle' }
    setMode('INSERT')
  }

  const enterNormalMode = (): void => {
    if (insertedTextRef.current.length > 0) {
      recordChange({ type: 'insert', text: insertedTextRef.current })
      insertedTextRef.current = ''
    }
    if (base.offset > 0 && props.value[base.offset - 1] !== '\n') {
      base.setOffset(base.offset - 1)
    }
    commandStateRef.current = { type: 'idle' }
    setMode('NORMAL')
  }

  const replayLastChange = (ctx: TransitionContext): void => {
    const change = persistent.lastChange
    if (!change) return
    replayingRef.current = true
    try {
      replay(change, ctx)
    } finally {
      replayingRef.current = false
    }
  }

  const onInput = (input: string, key: Key): void => {
    if (key.escape) {
      if (modeRef.current === 'INSERT') {
        enterNormalMode()
      } else {
        commandStateRef.current = { type: 'idle' }
      }
      return
    }

    if (modeRef.current === 'INSERT') {
      const filtered = inputFilter ? inputFilter(input, key) : input
      if (key.ctrl || key.return) {
        base.onInput(filtered, key)
        return
      }
      if (key.backspace || key.delete) {
        if (insertedTextRef.current.length > 0) {
          const last = lastGrapheme(insertedTextRef.current)
          insertedTextRef.current = insertedTextRef.current.slice(
            0,
            insertedTextRef.current.length - last.length,
          )
        }
      } else if (
        !key.meta &&
        !key.upArrow &&
        !key.downArrow &&
        !key.leftArrow &&
        !key.rightArrow &&
        !key.tab &&
        !key.pageUp &&
        !key.pageDown &&
        !key.home &&
        !key.end &&
        filtered.length > 0
      ) {
        insertedTextRef.current += filtered
      }
      base.onInput(filtered, key)
      return
    }

    if (key.ctrl || key.return) {
      base.onInput(input, key)
      return
    }

    const currentState = commandStateRef.current
    if (
      currentState.type === 'idle' &&
      (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow)
    ) {
      base.onInput(input, key)
      return
    }

    let mappedInput = inputFilter ? inputFilter(input, key) : input
    if (key.leftArrow) {
      mappedInput = 'h'
    } else if (key.downArrow) {
      mappedInput = 'j'
    } else if (key.upArrow) {
      mappedInput = 'k'
    } else if (key.rightArrow) {
      mappedInput = 'l'
    } else if (key.backspace) {
      if (!isMotionExpectingState(currentState)) {
        commandStateRef.current = { type: 'idle' }
        return
      }
      mappedInput = 'h'
    } else if (key.delete) {
      if (currentState.type === 'count') return
      mappedInput = 'x'
    }

    if (currentState.type === 'idle' && mappedInput === '?' && props.value === '') {
      props.onChange('?')
      base.setOffset(1)
      return
    }

    if (mappedInput === '') return

    const ctx: TransitionContext = {
      cursor: Cursor.fromText(props.value, props.columns, base.offset),
      text: props.value,
      setText: props.onChange,
      setOffset: base.setOffset,
      enterInsert: (offset: number) => enterInsertMode(offset),
      getRegister: () => persistent.register,
      setRegister: (content: string, linewise: boolean) => {
        persistent.register = content
        persistent.registerIsLinewise = linewise
      },
      getLastFind: () => persistent.lastFind,
      setLastFind: (type, char) => {
        persistent.lastFind = { type, char }
      },
      recordChange,
      onDotRepeat: () => replayLastChange(ctx),
      onUndo,
    }

    const result = transition(currentState, mappedInput, ctx)
    commandStateRef.current = result.next ?? { type: 'idle' }
    result.execute?.()
  }

  return {
    ...base,
    onInput,
    mode,
    setMode,
  }
}
