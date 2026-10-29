
export function intersperse<A>(as: A[], separator: (index: number) => A): A[] {
  const woven: A[] = []
  as.forEach((item, index) => {
    if (index > 0) woven.push(separator(index))
    woven.push(item)
  })
  return woven
}

export function count<T>(arr: readonly T[], pred: (x: T) => unknown): number {
  let matches = 0
  for (const member of arr) {
    if (pred(member)) matches += 1
  }
  return matches
}

export function uniq<T>(xs: Iterable<T>): T[] {
  const seen = new Set<T>()
  const kept: T[] = []
  for (const x of xs) {
    if (seen.has(x)) continue
    seen.add(x)
    kept.push(x)
  }
  return kept
}
