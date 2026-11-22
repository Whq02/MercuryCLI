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
import { notBuilt } from '../pi/holes.js'

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
  return notBuilt('src/hooks/useVimInput.ts:74')
}
