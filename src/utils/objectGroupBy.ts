/**
 * `Object.groupBy` with a null-prototype result: a key such as `constructor`
 * or `__proto__` cannot collide with an inherited member.
 */
export function objectGroupBy<T, K extends PropertyKey>(
  items: Iterable<T>,
  keySelector: (item: T, index: number) => K,
): Partial<Record<K, T[]>> {
  const groups = Object.create(null) as Partial<Record<K, T[]>>
  let index = 0
  for (const item of items) {
    const key = keySelector(item, index++)
    const bucket = groups[key]
    if (bucket) bucket.push(item)
    else groups[key] = [item]
  }
  return groups
}
