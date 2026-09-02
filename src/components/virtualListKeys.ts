// ============================================================================
//  virtualListKeys — the transcript list's React-key law, as pure math.
//
//  The virtual message list keeps its item keys across renders so a streamed
//  append costs one key, not a whole-transcript rebuild. The old cache was
//  append-only: it re-derived keys only when the list SHRANK or its HEAD row
//  changed, so a row inserted or replaced anywhere else kept the key of the
//  row that used to sit at that index. The trailing turn receipt is always
//  the last row of the current turn, so every row that lands before it —
//  the resume recap, a settled reply, a tool group — took the receipt's key
//  while the receipt kept it too: two siblings, one key. React reconciles
//  duplicate sibling keys through its keyed map once the window's start
//  moves (a long, scrolled transcript), where the displaced fiber is neither
//  reused nor deleted — its host node stays mounted as a zombie, one more
//  copy per commit. That is the stacked-copies defect (the same card or
//  reply painted two, three, four times, surviving a resize, the DOM growing
//  until selection crawls).
//
//  The law here: every index's key is EXACT — `keyFn(row, i)` — verified by
//  row identity (an unchanged object keeps its key without re-deriving), and
//  sibling keys are UNIQUE by construction (a colliding identity takes a
//  positional suffix). A pure append keeps the array's identity (the
//  scroll hook's incremental index rides it); any insertion, replacement or
//  shrink yields a new array so the hook re-indexes and drops dead heights.
// ============================================================================

export interface ItemKeyState<T> {
  keys: string[]
  /** The rows the keys were derived from — identity-compared next render. */
  rows: readonly T[]
  keyFn: (row: T, index: number) => string
}

/**
 * Reconcile the cached keys against the rows about to render. Returns the
 * prior state object (mutated: an in-place append) when only appends
 * happened, else a fresh state whose `keys` is a new array.
 */
export function reconcileItemKeys<T>(
  prior: ItemKeyState<T> | null,
  rows: readonly T[],
  keyFn: (row: T, index: number) => string,
): ItemKeyState<T> {
  const n = rows.length
  if (prior === null || prior.keyFn !== keyFn) {
    const keys = new Array<string>(n)
    for (let i = 0; i < n; i++) keys[i] = keyFn(rows[i]!, i)
    return { keys: uniqueKeys(keys, true), rows, keyFn }
  }
  let keys = prior.keys
  let copied = false
  let appended = false
  const priorRows = prior.rows
  for (let i = 0; i < n; i++) {
    const row = rows[i]!
    if (i < keys.length && i < priorRows.length && priorRows[i] === row) continue
    const key = keyFn(row, i)
    if (i < keys.length) {
      if (keys[i] === key) continue
      if (!copied) {
        keys = keys.slice(0, n)
        copied = true
      }
      keys[i] = key
    } else {
      keys.push(key)
      appended = true
    }
  }
  if (keys.length > n) {
    keys = keys.slice(0, n)
    copied = true
  }
  if (copied || appended) keys = uniqueKeys(keys, copied)
  if (keys === prior.keys) {
    prior.rows = rows
    return prior
  }
  return { keys, rows, keyFn }
}

/** Sibling uniqueness: a repeated key takes a positional suffix. `owned`
 *  says the array may be mutated in place; otherwise it is copied first. */
function uniqueKeys(keys: string[], owned: boolean): string[] {
  const seen = new Set<string>()
  let out = keys
  for (let i = 0; i < out.length; i++) {
    let key = out[i]!
    if (seen.has(key)) {
      if (out === keys && !owned) out = keys.slice()
      let n = 2
      let candidate = `${key}#${n}`
      while (seen.has(candidate)) candidate = `${key}#${++n}`
      key = candidate
      out[i] = key
    }
    seen.add(key)
  }
  return out
}
