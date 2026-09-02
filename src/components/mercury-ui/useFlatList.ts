// ============================================================================
//  useFlatList — the shared engine behind the FLAT operator lists (/cards,
//  /tabula): async load + re-load, windowed ▸ cursor, the
//  STALE-PAINT input discipline, and the one-interaction-grammar primary
//  action.
//
//  Extracted from the CardsView (one-grammar
//  program); relanded it on the kit doctrine:
//   • the EVENT-IDENTITY open gate (useOpenEventGate — the launching
//     keystroke is inert, the very next key acts; the old wall-clock 150ms
//     mount buffer could swallow a legitimate fast first key),
//   • SEMANTIC keys through the ONE vocabulary (navSemantics.ts): a vertical
//     list — ↑↓/Home/End (+ctrl+p/n) move; ← stays the ADVERTISED Mercury
//     close synonym (`leftCloses` — the `esc / ← close` convention);
//   • STABLE-ID selection across reload(): pass `rowId` and the ▸ cursor
//     follows the row's identity when an async re-read reorders/inserts —
//     never a stale array position (position-clamp is the no-rowId fallback),
//   • INPUT-PATH REF MIRRORS (handlers read refs written at data-arrival
//     time; state paints),
//   • esc/← close and motion respond instantly; ACTION keys wait the gate,
//   • ↵ = the row's PRIMARY action on every list (the grammar decision); the
//     surface's letter key stays as the secondary spelling of the same verb,
//   • window/clamp math (clamp-don't-wrap; +N above/below overflow lines),
//   • error ≠ empty: a failed load surfaces `loadError` — it is NEVER
//     rendered as a clean empty list (a memory-trust surface that can't read
//     its store must say so).
//
//  The JSX stays per-surface (no render-tree churn); this hook owns state +
//  input only. mercury-ui rule: no env/file/git reads — the caller passes
//  `load`.
// ============================================================================

import * as React from 'react'
import { useInput } from '../../ink.js'
import { applyNavMotion, decodeNavKey } from './navSemantics.js'
import { paneWindow } from './paneWindow.js'
import { useOpenEventGate } from './useOpenEventGate.js'

export type FlatListNoteKind = 'ok' | 'warn' | 'fail' | 'pending'
export type FlatListNote = { text: string; kind: FlatListNoteKind }

export type FlatListOptions<T> = {
  /** Async row read. Re-invoked by reload() (and after actions that call it). */
  load: () => Promise<T[]>
  /** Visible window height. */
  maxRows: number
  /** esc/← — instant, never buffered. */
  onClose: () => void
  /**
   * The row's PRIMARY action — ↵ and (when set) `primaryChar` both dispatch
   * it, past the mount buffer, against the ref-based absolute selection.
   */
  onPrimary?: (row: T) => void
  /** The letter spelling of the primary (e.g. 'p') — same verb, same path. */
  primaryChar?: string
  /**
   * Whether the engine claims printable-character hotkeys (`r` reload +
   * `primaryChar`). Default true. A TYPE-TO-SEARCH host (the /memory centre)
   * sets false so letters reach its own query editor while ↑↓/↵/esc keep
   * riding the engine — the letter split of the isActive modal gate.
   */
  charKeys?: boolean
  /** Transient note shown when `r` re-reads (e.g. 're-read memory dir'). */
  reloadNote?: string
  /**
   * Gate the engine's key handling (default true). A view that hosts a MODAL
   * input (the /tabula inline note editor) sets this false while composing so
   * typed characters — 'r', arrows, ↵ — reach ONLY the editor's own useInput,
   * never the list (a stray 'r' mid-sentence must not reload the store).
   */
  isActive?: boolean
  /**
   * Stable, data-derived row identity. When set, the ▸ cursor follows the
   * SAME row across reload()/mutation re-reads (selection
   * survives asynchronous refresh by stable identity). Absent ⇒ the cursor
   * keeps its clamped position.
   */
  rowId?: (row: T) => string
}

export type FlatList<T> = {
  /** null while the first read is in flight. */
  raw: T[] | null
  list: T[]
  /** The failed-read message when load() rejected — render it, not an empty card. */
  loadError: string | null
  /** Window derivation (clamp-don't-wrap). */
  visible: T[]
  above: number
  below: number
  clampedSel: number
  /** The selected row (visible[clampedSel] === list[absSel]). */
  selected: T | undefined
  note: FlatListNote | null
  setNote: (n: FlatListNote | null) => void
  /** Serialize a mutating action (promote/ratify) — read+set busyRef.current. */
  busyRef: React.MutableRefObject<boolean>
  /** Bump the read (after a mutation, or `r`). */
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

  // The event-identity open gate (kit doctrine): the launching keystroke is
  // filtered exactly once; a legitimate key 0ms later lands.
  const pastGate = useOpenEventGate()
  const listRef = React.useRef<T[]>([])
  const selRef = React.useRef(0)
  // The selected row's stable identity (rowId mode) — written on every move,
  // consumed at data arrival to re-anchor the cursor by IDENTITY.
  const selKeyRef = React.useRef<string | null>(null)
  const busyRef = React.useRef(false)

  // keep the load callback fresh without re-firing the effect per render
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
        // Selection survives the async refresh by STABLE IDENTITY: re-derive
        // the cursor from the remembered row key; a vanished row falls to the
        // same clamped position (the index fallback, also the no-rowId
        // path).
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
        // error ≠ empty: keep whatever list was last shown out of the way and
        // surface the failure — never a clean "no rows yet" over a dead store.
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
  // THE cursor-following window function (geometry contract — the inline
  // start/clamp math this engine would otherwise re-derive lives in paneWindow now).
  const win = paneWindow(list.length, absSel, maxRows)
  const visible = list.slice(win.start, win.end)
  const above = win.above
  const below = win.below
  const clampedSel = absSel - win.start

  useInput(
    (input, key, event) => {
      // Semantic decode: vertical list with a REAL window (maxRows) so page
      // keys ride; ← stays the ADVERTISED close synonym. Acting consumes
      // declined keys propagate.
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
        // Absolute index against the REF list — same row the ▸ cursor shows
        // (visible[clampedSel] === list[absSel]), immune to a parked commit.
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
