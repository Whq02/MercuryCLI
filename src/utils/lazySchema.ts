/**
 * Wraps a factory so it runs exactly once, at first call, with every later
 * call served from the cache. The tree uses it to move Zod schema
 * construction off module init and onto first access.
 */
export function lazySchema<T>(factory: () => T): () => T {
  let cached: T | undefined
  return () => (cached ??= factory())
}
