import type * as React from 'react'
import { isTopOverlayNow, type useRegisterOverlay } from '../overlays/overlayHooks.js'
import type { useInput } from '../themedRenderer.js'
import { escapeFromOutsidePress } from '../renderer/recessLayer.js'
import type { decodeNavKey } from '../widgets/navSemantics.js'
import type { useOpenEventGate } from '../widgets/useOpenEventGate.js'
import {
  MODEL_PICKER_CONTEXT_CHORD,
  MODEL_PICKER_CONTEXT_CHORD_KEY,
  MODEL_PICKER_EFFORT_CHORD_KEY,
  cyclePickerFold,
  firstRowIndex,
  headingIndexOf,
  isCursorStop,
  isModelRow,
  isSearchCharacter,
  lastStop,
  nextStop,
  rowKey,
  type FoldState,
  type PickerLine,
} from '../../models/facts/modelPickerGroups.js'
import type { TensorFoldAct, TensorFoldTyping } from '../tensorfold/tensorfoldRows.js'
import { isLocalModelId, localPickerWindowNotice, type localRecordFor } from '../../models/roads/local/localCatalogue.js'
import { LOCAL_WINDOW_CHOICES, localWindowSettingOf, nextLocalWindowSetting, parseLocalWindowSetting, writeLocalWindowSetting } from '../../models/roads/local/localWindow.js'
import { fmtCtx, type ModelChoice } from './choice.js'
import type { pickerActs, pickerCursor } from './moves.js'

type InputArgs = Parameters<Parameters<typeof useInput>[0]>
type InputKey = InputArgs[1]
type InputEvent = InputArgs[2]
type Setter<T> = React.Dispatch<React.SetStateAction<T>>

export type PickerKeys = Pick<ReturnType<typeof pickerCursor>, 'selectRow' | 'setFilterText' | 'setFold'> &
  Pick<ReturnType<typeof pickerActs>, 'stepWindow' | 'groupHidden' | 'commitCurrent'> & {
    rowAxis: ReturnType<typeof decodeNavKey>
    tfTyping: TensorFoldTyping | null
    setTfTyping: Setter<TensorFoldTyping | null>
    listed: ModelChoice[]
    onTensorFold: ((act: TensorFoldAct) => void) | undefined
    tfConfirm: string | null
    setTfConfirm: Setter<string | null>
    focusedTf: ModelChoice['tensorfold']
    filtering: boolean
    filterFocus: boolean
    pastOpenEvent: ReturnType<typeof useOpenEventGate>
    windowTyping: string | null
    setWindowTyping: Setter<string | null>
    focusedLocal: ReturnType<typeof localRecordFor>
    setWindowStamp: Setter<number>
    overlayToken: ReturnType<typeof useRegisterOverlay>
    filter: string
    onClose: (() => void) | undefined
    setFilterFocus: Setter<boolean>
    lines: PickerLine<ModelChoice>[]
    i: number
    folds: Record<string, FoldState>
    focusedSupports1m: boolean
    setContext1m: Setter<boolean>
    focusedGptWindow: { served: number; ceiling?: number; observed?: string } | null
    context1m: boolean
    setCtxNotice: Setter<string | null>
    focusedNative1m: boolean
    focusedLocalCycles: boolean
    focusedModel: ModelChoice | undefined
    focusedHeading: Extract<PickerLine<ModelChoice>, { kind: 'heading' }> | undefined
    hasEffort: boolean
    onEffort: ((e: string) => void) | undefined
    efforts: string[] | undefined
    ei: number
  }

export function tensorFoldKeys(input: string, key: InputKey, event: InputEvent, { rowAxis, tfTyping, setTfTyping, listed, onTensorFold, tfConfirm, setTfConfirm, focusedTf, filtering, stepWindow, filterFocus, pastOpenEvent }: PickerKeys): boolean {
  if (tfTyping !== null) {
    event.stopImmediatePropagation()
    if (rowAxis === 'cancel') {
      setTfTyping(null)
      return true
    }
    if (rowAxis === 'activate') {
      const text = tfTyping.text.trim()
      const typed = listed.find(m => rowKey(m) === tfTyping.key)?.tensorfold?.keys.typed
      setTfTyping(null)
      if (text !== '' && typed !== undefined) onTensorFold?.(typed(text))
      return true
    }
    if (key.backspace || key.delete) {
      setTfTyping(typing => (typing === null ? typing : { ...typing, text: typing.text.slice(0, -1) }))
      return true
    }
    if (tfTyping.input === 'code' ? !key.ctrl && !key.meta && /^\d+$/.test(input) : isSearchCharacter(input, key)) setTfTyping(typing => (typing === null ? typing : { ...typing, text: typing.input === 'code' ? (typing.text + input).slice(0, 6) : typing.text + input }))
    return true
  }
  if (rowAxis === 'cancel' && tfConfirm !== null) {
    event.stopImmediatePropagation()
    setTfConfirm(null)
    return true
  }
  const tfKeys = focusedTf?.keys
  if ((rowAxis === 'enterChild' || rowAxis === 'leaveChild') && !filtering && tfKeys?.window !== undefined) {
    event.stopImmediatePropagation()
    stepWindow(tfKeys.window, rowAxis === 'enterChild' ? 1 : -1)
    return true
  }
  if (key.ctrl && !key.meta && input === MODEL_PICKER_CONTEXT_CHORD_KEY && focusedTf !== undefined) {
    event.stopImmediatePropagation()
    if (tfKeys?.window !== undefined) stepWindow(tfKeys.window, 1)
    return true
  }
  if (!filterFocus && !key.ctrl && !key.meta && tfKeys !== undefined && ((input === 's' && tfKeys.stop !== undefined) || (input === 't' && tfKeys.terminate !== undefined) || (input === 'w' && tfKeys.limit !== undefined) || (input === 'c' && !key.ctrl && tfKeys.support !== undefined) || (input === 'n' && tfKeys.share !== undefined))) {
    event.stopImmediatePropagation()
    if (!pastOpenEvent()) return true
    if (input === 's' && tfKeys.stop !== undefined) {
      const repo = tfKeys.stop.act.kind === 'stop' ? tfKeys.stop.act.row.repo : undefined
      if (tfKeys.stop.confirm && repo !== undefined && tfConfirm !== repo) {
        setTfConfirm(repo)
        return true
      }
      setTfConfirm(null)
      onTensorFold?.(tfKeys.stop.act)
      return true
    }
    const act = input === 'w' ? tfKeys.limit : input === 'n' ? tfKeys.share?.act : input === 't' ? tfKeys.terminate?.act : tfKeys.support
    if (act !== undefined) onTensorFold?.(act)
    return true
  }
  return false
}

export function windowTypingKeys(input: string, key: InputKey, event: InputEvent, { rowAxis, windowTyping, setWindowTyping, focusedLocal, setWindowStamp }: PickerKeys): boolean {
  if (windowTyping !== null) {
    event.stopImmediatePropagation()
    if (rowAxis === 'cancel') {
      setWindowTyping(null)
      return true
    }
    if (rowAxis === 'activate') {
      const parsed = parseLocalWindowSetting(windowTyping)
      if (parsed !== undefined && focusedLocal !== undefined) {
        writeLocalWindowSetting(focusedLocal, parsed)
        setWindowStamp(s => s + 1)
      }
      setWindowTyping(null)
      return true
    }
    if (key.backspace || key.delete) {
      setWindowTyping(t => (t ?? '').slice(0, -1))
      return true
    }
    if (/^[0-9kK]$/.test(input) && !key.ctrl && !key.meta) setWindowTyping(t => `${t ?? ''}${input.toLowerCase()}`)
    return true
  }
  return false
}

export function navigationKeys(event: InputEvent, { rowAxis, overlayToken, filter, setFilterText, onClose, pastOpenEvent, setFilterFocus, filterFocus, selectRow, lines, i, commitCurrent, filtering, setFold, folds, groupHidden }: PickerKeys): boolean {
  if (rowAxis === 'cancel') {
    if (overlayToken !== null && !isTopOverlayNow(overlayToken)) return true
    event.stopImmediatePropagation()
    if (filter !== '' && !escapeFromOutsidePress()) {
      setFilterText('')
      return true
    }
    onClose?.()
    return true
  }
  if (rowAxis === 'focusNext' || rowAxis === 'focusPrevious') {
    event.stopImmediatePropagation()
    if (!pastOpenEvent()) return true
    setFilterFocus(!filterFocus)
    return true
  }
  if (rowAxis === 'moveNext') { event.stopImmediatePropagation(); selectRow(nextStop(lines, i, 1)); return true }
  if (rowAxis === 'movePrevious') { event.stopImmediatePropagation(); selectRow(nextStop(lines, i, -1)); return true }
  if (rowAxis === 'first') { event.stopImmediatePropagation(); selectRow(Math.max(0, lines.findIndex(line => isCursorStop(line)))); return true }
  if (rowAxis === 'last') { event.stopImmediatePropagation(); selectRow(lastStop(lines)); return true }
  if (rowAxis === 'activate') {
    if (!pastOpenEvent()) return true
    event.stopImmediatePropagation()
    commitCurrent()
    return true
  }
  if (rowAxis === 'enterChild' || rowAxis === 'leaveChild') {
    event.stopImmediatePropagation()
    if (filtering) return true
    const line = lines[i]
    if (line?.kind === 'more') {
      setFold(line.group, rowAxis === 'enterChild' ? 'full' : 'folded', undefined, true)
      return true
    }
    if (!line || (line.kind !== 'row' && line.kind !== 'heading')) return true
    const group = line.kind === 'row' ? line.row.group : line.group
    const fold = folds[group] ?? 'top'
    if (rowAxis === 'leaveChild') {
      if (line.kind === 'row') selectRow(headingIndexOf(lines, group))
      else if (fold !== 'folded') setFold(group, 'folded')
      return true
    }
    const hidden = groupHidden(group)
    const next = cyclePickerFold(fold, 'open', hidden)
    if (next !== fold) setFold(group, next, line.kind === 'row' ? line.key : undefined)
    else if (line.kind === 'heading') selectRow(firstRowIndex(lines, i))
    return true
  }
  return false
}

export function chordKeys(input: string, key: InputKey, event: InputEvent, { focusedSupports1m, pastOpenEvent, setContext1m, focusedGptWindow, context1m, setCtxNotice, focusedNative1m, focusedLocal, focusedLocalCycles, setWindowTyping, setWindowStamp, focusedModel, focusedHeading, hasEffort, onEffort, efforts, ei }: PickerKeys): boolean {
  const chord = key.ctrl && !key.meta ? input : ''
  if (chord === MODEL_PICKER_CONTEXT_CHORD_KEY && focusedSupports1m) {
    if (!pastOpenEvent()) return true
    event.stopImmediatePropagation()
    setContext1m(v => !v)
    return true
  }
  if (chord === MODEL_PICKER_CONTEXT_CHORD_KEY && focusedGptWindow && focusedGptWindow.ceiling !== undefined) {
    if (!pastOpenEvent()) return true
    event.stopImmediatePropagation()
    const big = !context1m
    setContext1m(big)
    setCtxNotice(
      big
        ? `${fmtCtx(focusedGptWindow.ceiling)} ctx active · default ${fmtCtx(focusedGptWindow.served)} · ${MODEL_PICKER_CONTEXT_CHORD} toggles`
        : `${fmtCtx(focusedGptWindow.served)} ctx active · max ${fmtCtx(focusedGptWindow.ceiling)} · ${MODEL_PICKER_CONTEXT_CHORD} toggles`,
    )
    return true
  }
  if (chord === MODEL_PICKER_CONTEXT_CHORD_KEY && focusedGptWindow) {
    if (!pastOpenEvent()) return true
    event.stopImmediatePropagation()
    setCtxNotice(`${fmtCtx(focusedGptWindow.served)} ctx · no alternate window`)
    return true
  }
  if (chord === MODEL_PICKER_CONTEXT_CHORD_KEY && focusedNative1m) {
    if (!pastOpenEvent()) return true
    event.stopImmediatePropagation()
    setCtxNotice('1M ctx · no alternate window')
    return true
  }
  if (chord === MODEL_PICKER_CONTEXT_CHORD_KEY && focusedLocal !== undefined && focusedLocalCycles) {
    if (!pastOpenEvent()) return true
    event.stopImmediatePropagation()
    setCtxNotice(null)
    const current = localWindowSettingOf(focusedLocal)
    if (current === 'max') {
      setWindowTyping('')
      return true
    }
    const next = typeof current === 'number' && !LOCAL_WINDOW_CHOICES.includes(current) ? undefined : nextLocalWindowSetting(current, 1)
    writeLocalWindowSetting(focusedLocal, next)
    setWindowStamp(s => s + 1)
    return true
  }
  if (chord === MODEL_PICKER_CONTEXT_CHORD_KEY && focusedModel !== undefined && isModelRow(focusedModel) && isLocalModelId(focusedModel.id)) {
    if (!pastOpenEvent()) return true
    event.stopImmediatePropagation()
    setCtxNotice(localPickerWindowNotice(focusedModel.id))
    return true
  }
  if (chord === MODEL_PICKER_CONTEXT_CHORD_KEY && focusedModel !== undefined && isModelRow(focusedModel)) {
    if (!pastOpenEvent()) return true
    event.stopImmediatePropagation()
    setCtxNotice(focusedModel.ctx !== '' ? `${focusedModel.ctx} · stated by the provider · not a toggle` : 'context window unknown · the provider states none · not a toggle')
    return true
  }
  if (chord === MODEL_PICKER_CONTEXT_CHORD_KEY && focusedModel !== undefined) {
    if (!pastOpenEvent()) return true
    event.stopImmediatePropagation()
    setCtxNotice(focusedModel.choice ?? `${focusedModel.name} · not a model · no context window`)
    return true
  }
  if (chord === MODEL_PICKER_CONTEXT_CHORD_KEY && focusedHeading !== undefined) {
    if (!pastOpenEvent()) return true
    event.stopImmediatePropagation()
    setCtxNotice('no context window on a provider heading · ↓ reaches its rows')
    return true
  }
  if (chord === MODEL_PICKER_EFFORT_CHORD_KEY && hasEffort) {
    if (!pastOpenEvent()) return true
    event.stopImmediatePropagation()
    onEffort?.(efforts![(ei + 1) % efforts!.length]!)
    return true
  }
  return false
}

export function filterKeys(input: string, key: InputKey, event: InputEvent, { filterFocus, setFilterText, filter, pastOpenEvent, setFilterFocus }: PickerKeys): void {
  if (filterFocus) {
    if (key.backspace || key.delete) {
      event.stopImmediatePropagation()
      setFilterText(filter.slice(0, -1))
      return
    }
    if (input.length > 0 && !key.ctrl && !key.meta && !key.tab) {
      event.stopImmediatePropagation()
      if (!pastOpenEvent()) return
      setFilterText(filter + input)
    }
    return
  }
  if (input === '/' && !key.ctrl && !key.meta) {
    event.stopImmediatePropagation()
    if (!pastOpenEvent()) return
    setFilterFocus(true)
    return
  }
  if (isSearchCharacter(input, key)) {
    event.stopImmediatePropagation()
    if (!pastOpenEvent()) return
    setFilterFocus(true)
    setFilterText(filter + input)
  }
}
