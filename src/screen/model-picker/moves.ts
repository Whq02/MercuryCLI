import type * as React from 'react'
import { focusedOptionSupports1m, stripContext1m, withContext1m } from '../../models/catalogue/modelOptions.js'
import { has1mContext } from '../../engine/compaction-window/contextFill.js'
import {
  composePickerLines,
  firstRowIndex,
  headingIndexOf,
  isCuratedGroup,
  isCursorStop,
  rowKey,
  type FoldState,
  type PickerGroup,
  type PickerLine,
} from '../../models/facts/modelPickerGroups.js'
import type { TensorFoldAct, TensorFoldTyping } from '../tensorfold/tensorfoldRows.js'
import { parseGptModelId, withGptServedWindowSuffix } from '../../models/roads/openai/openaiCatalogue.js'
import type { ModelChoice } from './choice.js'

type Setter<T> = React.Dispatch<React.SetStateAction<T>>

type CursorArgs = {
  setI: Setter<number>
  setCtxNotice: Setter<string | null>
  setWindowTyping: Setter<string | null>
  setTfTyping: Setter<TensorFoldTyping | null>
  setTfConfirm: Setter<string | null>
  lines: PickerLine<ModelChoice>[]
  setContext1m: Setter<boolean>
  ctxStateOf: (p: string | undefined) => boolean
  groups: PickerGroup<ModelChoice>[]
  folds: Record<string, FoldState>
  setFolds: Setter<Record<string, FoldState>>
  fullRowsOf: (group: string) => ModelChoice[] | undefined
  setFilter: Setter<string>
  focusedModel: ModelChoice | undefined
  currentKey: string | undefined
  filter: string
}

export function pickerCursor({ setI, setCtxNotice, setWindowTyping, setTfTyping, setTfConfirm, lines, setContext1m, ctxStateOf, groups, folds, setFolds, fullRowsOf, setFilter, focusedModel, currentKey, filter }: CursorArgs) {
  const selectRow = (n: number): void => {
    setI(n)
    setCtxNotice(null)
    setWindowTyping(null)
    setTfTyping(null)
    setTfConfirm(null)
    const line = lines[n]
    if (line?.kind === 'row') setContext1m(ctxStateOf(line.row.id))
  }
  const landOn = (next: PickerLine<ModelChoice>[], preferKey: string | undefined, fallbackGroup?: string): void => {
    let at = preferKey === undefined ? -1 : next.findIndex(line => line.kind === 'row' && line.key === preferKey)
    if (at < 0 && fallbackGroup !== undefined) at = headingIndexOf(next, fallbackGroup)
    if (at < 0) at = firstRowIndex(next)
    if (at < 0) at = Math.max(0, next.findIndex(line => isCursorStop(line)))
    setI(at)
    setCtxNotice(null)
    setWindowTyping(null)
    setTfTyping(null)
    setTfConfirm(null)
    const line = next[at]
    if (line?.kind === 'row') setContext1m(ctxStateOf(line.row.id))
  }
  const setFilterText = (text: string): void => {
    const next = composePickerLines(groups, folds, text, fullRowsOf)
    setFilter(text)
    const keep = focusedModel !== undefined ? rowKey(focusedModel) : undefined
    landOn(next, text.trim() === '' ? (keep ?? currentKey) : keep)
  }
  const setFold = (group: string, fold: FoldState, keep?: string, reveal = false): void => {
    const nextFolds = { ...folds, [group]: fold }
    const next = composePickerLines(groups, nextFolds, filter, fullRowsOf)
    setFolds(nextFolds)
    const own = groups.find(candidate => candidate.group === group)
    const revealed = keep === undefined && fold !== 'folded' && own !== undefined && (reveal || isCuratedGroup(own))
      ? next.find(line => line.kind === 'row' && line.row.group === group && !lines.some(seen => seen.kind === 'row' && seen.key === line.key))
      : undefined
    landOn(next, revealed?.kind === 'row' ? revealed.key : keep, group)
  }
  return { selectRow, setFilterText, setFold }
}

type ActsArgs = Pick<CursorArgs, 'setCtxNotice' | 'setTfTyping' | 'setTfConfirm' | 'lines'> &
  Pick<ReturnType<typeof pickerCursor>, 'setFold'> & {
    setTfWindows: Setter<Record<string, number>>
    onSelect: ((id: string, door?: string) => void) | undefined
    onTensorFold: ((act: TensorFoldAct) => void) | undefined
    i: number
    filtering: boolean
    context1m: boolean
    focusedGptToggle: boolean
  }

export function pickerActs({ setTfWindows, setTfConfirm, setTfTyping, onSelect, onTensorFold, lines, i, filtering, setFold, setCtxNotice, context1m, focusedGptToggle }: ActsArgs) {
  const stepWindow = (window: { rungs: readonly number[]; at: number; repo: string }, step: 1 | -1): void => {
    const at = window.rungs.indexOf(window.at)
    const next = window.rungs[Math.max(0, Math.min(window.rungs.length - 1, (at < 0 ? 0 : at) + step))]
    if (next === undefined || next === window.at) return
    setTfWindows(prev => ({ ...prev, [window.repo]: next }))
    setTfConfirm(null)
  }
  const tensorFoldEnter = (m: ModelChoice): void => {
    const enter = m.tensorfold?.keys.enter
    if (enter === undefined) return
    if (enter.input !== undefined) {
      setTfTyping({ key: rowKey(m), input: enter.input, text: '' })
      return
    }
    if (enter.act?.kind === 'switch') onSelect?.(enter.act.id)
    else if (enter.act !== undefined) onTensorFold?.(enter.act)
  }
  const groupHidden = (group: string): boolean => lines.some(line => line.kind === 'more' && line.group === group)
  const commitCurrent = (): void => {
    const line = lines[i]
    if (!line) return
    if (line.kind === 'heading') {
      if (filtering) return
      setFold(line.group, line.fold === 'folded' ? 'top' : 'folded')
      return
    }
    if (line.kind === 'more') {
      setFold(line.group, 'full', undefined, true)
      return
    }
    if (line.kind !== 'row') return
    const m = line.row
    if (m.tensorfold !== undefined) {
      tensorFoldEnter(m)
      return
    }
    if (!onSelect) return
    if (m.gated || m.pending) {
      if (m.gatedReason) setCtxNotice(m.pending ? m.gatedReason : `${m.gatedReason} — not selectable`)
      return
    }
    const p = m.id
    if (p && focusedOptionSupports1m(p)) {
      const base = stripContext1m(p)
      onSelect(context1m === has1mContext(p) ? m.id : (context1m ? withContext1m(base) : base), m.door)
    } else if (p && parseGptModelId(p) && focusedGptToggle) {
      onSelect(context1m ? m.id : withGptServedWindowSuffix(m.id), m.door)
    } else {
      onSelect(m.id, m.door)
    }
  }
  return { stepWindow, groupHidden, commitCurrent }
}
