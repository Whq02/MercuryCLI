import { useRef, useState } from 'react'


export function useStableSelection<Row>(
  rows: readonly Row[],
  rowId: (row: Row) => string,
  options?: { initialIndex?: number },
): {
  index: number
  selected: Row | null
  select: (i: number) => void
  selectId: (id: string) => void
} {
  const clampIndex = (i: number): number =>
    Math.min(Math.max(0, i), Math.max(0, rows.length - 1))
  const initial = clampIndex(options?.initialIndex ?? 0)
  const [selKey, setSelKey] = useState<string | null>(() =>
    rows.length > 0 ? rowId(rows[initial]!) : null,
  )
  const lastIndexRef = useRef(initial)

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
