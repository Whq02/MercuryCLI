import { useRef, useState } from 'react'
import { isTopOverlayNow, useRegisterOverlay } from '../../context/overlayContext.js'
import { useInput, type DOMElement } from '../../ink.js'
import {
  applyNavMotion,
  decodeNavKey,
  skipDisabled,
  type NavOrientation,
} from './navSemantics.js'
import { useOpenEventGate } from './useOpenEventGate.js'
import { useStableSelection } from './useStableSelection.js'
import { popupPageRows } from '../CustomSelect/popup-list.js'


export type AsyncListNote = { pending: string; result: Promise<string | null | undefined> }

type ListAction<Row> = {
  key: string
  run: (row: Row | null) => string | null | undefined | AsyncListNote
  hint: string
  when?: (row: Row) => boolean
}

type InteractiveListRowProps = {
  id: string
  selected: boolean
  unavailable: boolean
  reasonUnavailable?: string
  onSelect: () => void
  onActivate: () => void
  rowRef: (node: DOMElement | null) => void
}

export function useInteractiveList<Row>({
  rows,
  rowId,
  onClose,
  actions = [],
  active = true,
  initialId,
  unavailable,
  reasonUnavailable,
  idNamespace = 'list',
  orientation = 'vertical',
  pageSize,
}: {
  rows: readonly Row[]
  rowId: (row: Row) => string
  onClose: () => void
  actions?: ListAction<Row>[]
  active?: boolean
  initialId?: string
  unavailable?: (row: Row) => boolean
  reasonUnavailable?: (row: Row) => string
  idNamespace?: string
  orientation?: NavOrientation
  pageSize?: number
}): {
  selectedIndex: number
  selectedRow: Row | null
  note: string | null
  ready: boolean
  hints: string | undefined
  motionHint: string
  moveTo: (i: number) => void
  activate: (i: number) => void
  rowProps: (row: Row, i: number) => InteractiveListRowProps
} {
  const rowNodes = useRef(new Map<number, DOMElement>())
  const renderedRows = useRef(new Set<number>())
  renderedRows.current = new Set()
  const visibleRowCount = (): number => Math.max(1, popupPageRows([...rowNodes.current].filter(([index]) => renderedRows.current.has(index)).map(([,node]) => node)) || renderedRows.current.size)
  const clampIndex = (i: number): number => Math.min(Math.max(0, i), Math.max(0, rows.length - 1))
  const initialIndex = ((): number => {
    if (rows.length === 0) return 0
    let idx = initialId != null ? rows.findIndex(r => rowId(r) === initialId) : 0
    if (idx < 0) idx = 0
    if (unavailable && unavailable(rows[idx]!)) {
      const firstAvailable = rows.findIndex(r => !unavailable(r))
      if (firstAvailable >= 0) idx = firstAvailable
    }
    return idx
  })()
  const stable = useStableSelection(rows, rowId, { initialIndex })
  const selectedIndex = stable.index
  const selectedRow = stable.selected
  const liveIndexRef = useRef(selectedIndex)
  liveIndexRef.current = selectedIndex
  const [note, setNote] = useState<string | null>(null)
  const noteSeqRef = useRef(0)
  const pendingActionSeqRef = useRef<number | null>(null)
  const applyActionResult = (res: string | null | undefined | AsyncListNote): void => {
    const seq = ++noteSeqRef.current
    if (res != null && typeof res === 'object') {
      pendingActionSeqRef.current = seq
      setNote(res.pending)
      void res.result.then(
        resolved => {
          if (pendingActionSeqRef.current === seq) pendingActionSeqRef.current = null
          if (noteSeqRef.current === seq) setNote(resolved ?? null)
        },
        () => {
          if (pendingActionSeqRef.current === seq) pendingActionSeqRef.current = null
          if (noteSeqRef.current === seq) setNote(null)
        },
      )
      return
    }
    setNote(res ?? null)
  }

  const pastBuffer = useOpenEventGate()
  const ready = pastBuffer()
  const overlayToken = useRegisterOverlay('list', active, { ownsPageKeys: true })

  const isUnavailable = (row: Row): boolean => unavailable?.(row) ?? false

  const select = (i: number): void => {
    if (!active || rows.length === 0) return
    let idx = clampIndex(i)
    if (isUnavailable(rows[idx]!)) {
      const healed = skipDisabled(liveIndexRef.current, idx, rows.length, k => isUnavailable(rows[k]!))
      if (healed === idx || isUnavailable(rows[healed]!)) return
      idx = healed
    }
    stable.select(idx)
    liveIndexRef.current = idx
    noteSeqRef.current++
    setNote(null)
  }

  const runPrimary = (row: Row | null): void => {
    if (pendingActionSeqRef.current !== null) return
    if (row != null && isUnavailable(row)) return
    const primary = actions.find(a => a.key === 'return' && (row == null || (a.when?.(row) ?? true)))
    if (primary) applyActionResult(primary.run(row))
  }

  const activate = (i: number): void => {
    if (!active || rows.length === 0) return
    const idx = clampIndex(i)
    select(idx)
    runPrimary(rows[idx])
  }

  useInput(
    (input, key, event) => {
      if (!active) return
      const action = decodeNavKey(input, key, { orientation, pageKeys: true })
      if (action === 'cancel') {
        if (overlayToken !== null && !isTopOverlayNow(overlayToken)) return
        event.stopImmediatePropagation()
        onClose()
        return
      }
      if (action !== null && action !== 'activate') {
        const target = applyNavMotion(action, liveIndexRef.current, rows.length, { orientation, pageSize: pageSize ?? visibleRowCount() })
        if (target !== null) {
          event.stopImmediatePropagation()
          select(
            skipDisabled(liveIndexRef.current, target, rows.length, i =>
              isUnavailable(rows[i]),
            ),
          )
        }
        return
      }
      if (!pastBuffer()) return
      const liveRow = rows[liveIndexRef.current] ?? selectedRow
      if (action === 'activate') {
        event.stopImmediatePropagation()
        runPrimary(liveRow)
        return
      }
      if (key.ctrl || key.meta || key.super) return
      for (const a of actions) {
        if (
          (a.key === 'backspace' && (key.backspace || key.delete)) ||
          (a.key.length === 1 && input === a.key)
        ) {
          event.stopImmediatePropagation()
          if (liveRow != null && isUnavailable(liveRow)) return
          if (liveRow != null && a.when && !a.when(liveRow)) return
          applyActionResult(a.run(liveRow))
          return
        }
      }
    },
    { isActive: active },
  )

  const hints =
    actions.length > 0
      ? actions
          .filter(a => selectedRow == null || (a.when?.(selectedRow) ?? true))
          .map(a => `${a.key === 'return' ? '↵' : a.key === 'backspace' ? '⌫' : a.key} ${a.hint}`)
          .concat(rows.length > 1 ? ['pgup/pgdn page'] : [])
          .join(' · ') || undefined
      : undefined

  const rowProps = (row: Row, i: number): InteractiveListRowProps => {
    renderedRows.current.add(i)
    return ({
    id: `${idNamespace}:row:${rowId(row)}`,
    selected: i === selectedIndex,
    unavailable: isUnavailable(row),
    reasonUnavailable: isUnavailable(row) ? reasonUnavailable?.(row) : undefined,
    onSelect: () => select(i),
    onActivate: () => activate(i),
    rowRef: node => { if (node) rowNodes.current.set(i, node); else rowNodes.current.delete(i) },
    })
  }

  return {
    selectedIndex,
    selectedRow,
    note,
    ready,
    hints,
    motionHint:
      orientation === 'vertical' ? '↑↓' : orientation === 'horizontal' ? '←→' : '←→ ↑↓',
    moveTo: select,
    activate,
    rowProps,
  }
}
