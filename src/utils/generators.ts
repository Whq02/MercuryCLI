
export async function lastX<A>(gen: AsyncGenerator<A, unknown, unknown>): Promise<A> {
  let last: A | undefined
  let yielded = false
  for await (const value of gen) {
    last = value
    yielded = true
  }
  if (!yielded) {
    throw new Error('lastX: the generator yielded no values')
  }
  return last as A
}

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
  concurrencyCap: number = Number.POSITIVE_INFINITY,
): AsyncGenerator<A, void, unknown> {
  const waiting = [...generators]
  const live = new Set<Tracked<A>>()

  const track = (generator: AsyncGenerator<A, void, unknown>): Tracked<A> => {
    const tracked: Tracked<A> = {
      generator,
      promise: null as never,
    }
    tracked.promise = generator.next().then(result => ({ tracked, result }))
    return tracked
  }

  while (live.size < concurrencyCap && waiting.length > 0) {
    live.add(track(waiting.shift() as AsyncGenerator<A, void, unknown>))
  }

  while (live.size > 0) {
    const { tracked, result } = await Promise.race([...live].map(entry => entry.promise))
    live.delete(tracked)
    if (result.done) {
      if (waiting.length > 0) {
        live.add(track(waiting.shift() as AsyncGenerator<A, void, unknown>))
      }
      continue
    }
    tracked.promise = tracked.generator.next().then(next => ({ tracked, result: next }))
    live.add(tracked)
    if (result.value !== undefined) {
      yield result.value
    }
  }
}

export async function toArray<A>(gen: AsyncGenerator<A, unknown, unknown>): Promise<A[]> {
  const values: A[] = []
  for await (const value of gen) {
    values.push(value)
  }
  return values
}

export async function* fromArray<T>(values: T[]): AsyncGenerator<T, void, unknown> {
  for (const value of values) {
    yield value
  }
}
