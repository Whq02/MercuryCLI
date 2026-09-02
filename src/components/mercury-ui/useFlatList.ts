
import * as React from 'react'
import { useInput } from '../../ink.js'
import { applyNavMotion, decodeNavKey } from './navSemantics.js'
import { paneWindow } from './paneWindow.js'
import { useOpenEventGate } from './useOpenEventGate.js'

export type FlatListNoteKind = 'ok' | 'warn' | 'fail' | 'pending'
export type FlatListNote = { text: string; kind: FlatListNoteKind }

export type FlatListOptions<T> = {
  load: () => Promise<T[]>
  maxRows: number
  onClose: () => void
  onPrimary?: (row: T) => void
  primaryChar?: string
  charKeys?: boolean
  reloadNote?: string
  isActive?: boolean
  rowId?: (row: T) => string
}

export type FlatList<T> = {
  raw: T[] | null
  list: T[]
  loadError: string | null
  visible: T[]
  above: number
  below: number
  clampedSel: number
  selected: T | undefined
  note: FlatListNote | null
  setNote: (n: FlatListNote | null) => void
  busyRef: React.MutableRefObject<boolean>
  reload: () => void
}

export function useFlatList<T>(opts: FlatListOptions<T>): FlatList<T> {
  const { load, maxRows, onClose, onPrimary, primaryChar, reloadNote, rowId } = opts
  const engineActive = opts.isActive ?? true
  const charKeys = opts.charKeys ?? true
  const [raw, setRaw] = React.useState<T[] | null>(null)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [sel, setSel] = React.useState(0)
  const [loadId, setLoadId] = React.useState(0)
  const [note, setNote] = React.useState<FlatListNote | null>(null)

  const pastGate = useOpenEventGate()
  const listRef = React.useRef<T[]>([])
  const selRef = React.useRef(0)
  const selKeyRef = React.useRef<string | null>(null)
  const busyRef = React.useRef(false)

  const loadRef = React.useRef(load)
  loadRef.current = load
  const rowIdRef = React.useRef(rowId)
  rowIdRef.current = rowId

  React.useEffect(() => {
    let alive = true
    loadRef
      .current()
      .then(rows => {
        if (!alive) return
        listRef.current = rows
        const id = rowIdRef.current
        if (id && selKeyRef.current !== null) {
          const byKey = rows.findIndex(r => id(r) === selKeyRef.current)
          if (byKey >= 0) selRef.current = byKey
        }
        selRef.current = Math.min(selRef.current, Math.max(0, rows.length - 1))
        if (id) selKeyRef.current = rows.length > 0 ? id(rows[selRef.current]!) : null
        setSel(selRef.current)
        setRaw(rows)
        setLoadError(null)
      })
      .catch((e: unknown) => {
        if (!alive) return
        listRef.current = []
        setRaw([])
        setLoadError(String(e))
      })
    return () => {
      alive = false
    }
  }, [loadId])

  const list = raw ?? []
  const absSel = Math.min(Math.max(0, sel), Math.max(0, list.length - 1))
  const win = paneWindow(list.length, absSel, maxRows)
  const visible = list.slice(win.start, win.end)
  const above = win.above
  const below = win.below
  const clampedSel = absSel - win.start

  useInput(
    (input, key, event) => {
      const action = decodeNavKey(input, key, {
        orientation: 'vertical',
        leftCloses: true,
        pageKeys: true,
      })
      if (action === 'cancel') {
        event.stopImmediatePropagation()
        onClose()
        return
      }
      if (action !== null && action !== 'activate') {
        const rows = listRef.current
        const target = applyNavMotion(action, selRef.current, rows.length, {
          orientation: 'vertical',
          pageSize: maxRows,
        })
        if (target !== null) {
          event.stopImmediatePropagation()
          selRef.current = target
          if (rowIdRef.current && rows.length > 0) {
            selKeyRef.current = rowIdRef.current(rows[target]!)
          }
          setSel(target)
          setNote(null)
        }
        return
      }
      if (!pastGate()) return
      if (onPrimary && (action === 'activate' || (charKeys && primaryChar && input === primaryChar))) {
        event.stopImmediatePropagation()
        const rows = listRef.current
        const row = rows[Math.min(selRef.current, Math.max(0, rows.length - 1))]
        if (row !== undefined) onPrimary(row)
        return
      }
      if (charKeys && input === 'r') {
        event.stopImmediatePropagation()
        setNote({ text: reloadNote ?? 're-read', kind: 'pending' })
        setLoadId(n => n + 1)
        return
      }
    },
    { isActive: engineActive },
  )

  return {
    raw,
    list,
    loadError,
    visible,
    above,
    below,
    clampedSel,
    selected: visible[clampedSel],
    note,
    setNote,
    busyRef,
    reload: () => setLoadId(n => n + 1),
  }
}
