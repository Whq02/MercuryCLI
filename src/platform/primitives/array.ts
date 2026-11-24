export function intersperse<A>(as: A[], separator: (index: number) => A): A[] {
  if (as.length === 0) return []
  const out: A[] = [as[0]!]
  for (let i = 1; i < as.length; i++) {
    out.push(separator(i), as[i]!)
  }
  return out
}

export function count<T>(arr: readonly T[], pred: (x: T) => unknown): number {
  let n = 0
  for (const x of arr) {
    if (pred(x)) n += 1
  }
  return n
}
