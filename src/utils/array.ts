// Small array helpers with no owning subsystem — transcript rendering, the
// diff views, and the turn machine all reach for these. Dependency-free on
// purpose: this module sits under half the tree.

/**
 * Weave a separator between neighbours: [a, b, c] → [a, s(1), b, s(2), c].
 * The callback is handed the index of the element that FOLLOWS it, so JSX
 * callers can key the separator off its right-hand neighbour.
 */
export function intersperse<A>(as: A[], separator: (index: number) => A): A[] {
  const woven: A[] = []
  as.forEach((item, index) => {
    if (index > 0) woven.push(separator(index))
    woven.push(item)
  })
  return woven
}

/** How many members satisfy the predicate — truthiness, not strict boolean. */
export function count<T>(arr: readonly T[], pred: (x: T) => unknown): number {
  let matches = 0
  for (const member of arr) {
    if (pred(member)) matches += 1
  }
  return matches
}

/** Dedupe preserving first-occurrence order (Set semantics: SameValueZero). */
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
