export function lazySchema<T>(factory: () => T): () => T {
  let built: { value: T } | undefined
  return () => {
    built ??= { value: factory() }
    return built.value
  }
}
