export async function returnValue<A>(gen: AsyncGenerator<unknown, A, unknown>): Promise<A> {
  let next = await gen.next()
  while (!next.done) {
    next = await gen.next()
  }
  return next.value
}

type Tracked<A> = {
  generator: AsyncGenerator<A, void, unknown>
  promise: Promise<{ tracked: Tracked<A>; result: IteratorResult<A, void> }>
}

export async function* all<A>(
  generators: Array<AsyncGenerator<A, void, unknown>>,
  concurrencyCap = Infinity,
): AsyncGenerator<A, void, unknown> {
  const waiting = [...generators]
  const live = new Set<Tracked<A>>()
  const ready = new Set<Tracked<A>>()
  let wake: (() => void) | undefined
  let next = 0

  function pull(generator: AsyncGenerator<A, void, unknown>): void {
    const tracked: Tracked<A> = {
      generator,
      promise: generator.next().then(result => ({ tracked, result })),
    }
    const markReady = (): void => {
      ready.add(tracked)
      wake?.()
    }
    void tracked.promise.then(markReady, markReady)
    live.add(tracked)
  }

  while (next < waiting.length && live.size < concurrencyCap) pull(waiting[next++]!)
  while (live.size) {
    if (!ready.size) {
      await new Promise<void>(resolve => { wake = resolve })
      wake = undefined
    }
    const tracked = Array.from(live).find(item => ready.has(item))!
    ready.delete(tracked)
    const { result } = await tracked.promise
    live.delete(tracked)
    if (result.done) {
      if (next < waiting.length) pull(waiting[next++]!)
    } else {
      pull(tracked.generator)
      if (result.value !== undefined) yield result.value
    }
  }
}
