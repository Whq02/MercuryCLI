import { notBuilt } from '../pi/holes.js'

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
  concurrencyCap?: number,
): AsyncGenerator<A, void, unknown> {
  return notBuilt('src/utils/generators.ts:16')
}
