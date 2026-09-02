import { useRef, useState } from 'react'

// ============================================================================
//  useStableSelection — the ONE identity-stable cursor core.
//
//  Selection survives filtering and asynchronous refresh by STABLE IDENTITY,
// never a stale array index: the cursor is stored as the selected row's
//  data-derived key; each render re-derives the index from the LIVE rows. A
//  vanished row falls to the same list POSITION (clamped) instead of snapping
//  to the top — the useInteractiveList idiom, extracted so every hand-rolled
//  `useState(0)` selection over live data can ride the same law.
//
//  This hook owns identity + healing ONLY — no input handling, no windowing.
//  Surfaces keep their own useInput/keybinding wiring and call `select`.
// ============================================================================

export function useStableSelection<Row>(
  rows: readonly Row[],
  rowId: (row: Row) => string,
  options?: { initialIndex?: number },
): {
  /** The live selected index (derived from identity each render, clamped). */
  index: number
  /** The selected row, or null on an empty list. */
  selected: Row | null
  /** Move the cursor to an index (clamped; remembers the row's identity). */
  select: (i: number) => void
  /** Move the cursor to the row with this id (no-op when absent). */
  selectId: (id: string) => void
} {
  const clampIndex = (i: number): number =>
    Math.min(Math.max(0, i), Math.max(0, rows.length - 1))
  const initial = clampIndex(options?.initialIndex ?? 0)
  const [selKey, setSelKey] = useState<string | null>(() =>
    rows.length > 0 ? rowId(rows[initial]!) : null,
  )
  // Cursor POSITION memory: when the selected row disappears, fall to the same
  // list position (clamped) instead of snapping to the top.
  const lastIndexRef = useRef(initial)

  // Derive the index from the stable key each render; heal a vanished key.
  let index = selKey === null ? -1 : rows.findIndex(r => rowId(r) === selKey)
  if (index < 0) index = clampIndex(lastIndexRef.current)
  lastIndexRef.current = index
  const derivedKey = rows.length > 0 ? rowId(rows[index]!) : null
  if (derivedKey !== selKey) setSelKey(derivedKey)

  const select = (i: number): void => {
    if (rows.length === 0) return
    const idx = clampIndex(i)
    setSelKey(rowId(rows[idx]!))
    lastIndexRef.current = idx
  }

  const selectId = (id: string): void => {
    const idx = rows.findIndex(r => rowId(r) === id)
    if (idx >= 0) select(idx)
  }

  return {
    index,
    selected: rows.length > 0 ? (rows[index] ?? null) : null,
    select,
    selectId,
  }
}
