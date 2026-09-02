
export interface ItemKeyState<T> {
  keys: string[]
  rows: readonly T[]
  keyFn: (row: T, index: number) => string
}

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
