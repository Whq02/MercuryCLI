
import { flagEnabled } from './flagRegistry.js'

interface Entry<T> {
  apply: (current: T) => Promise<{ next: T; result: unknown }>
  resolve: (value: unknown) => void
  reject: (err: unknown) => void
}

export interface GroupCommitLane<T> {
  submit: <R>(fn: (current: T) => Promise<{ next: T; result: R }>) => Promise<R>
}

export interface GroupCommitOptions<T, C = void> {
  acquire: () => Promise<() => Promise<void>>
  read: () => Promise<{ value: T; context: C }>
  publish: (next: T, context: C) => Promise<void>
  beforePublish?: () => void
}

function batchingEnabled(): boolean {
  return flagEnabled('MERCURY_GROUP_COMMIT')
}

export function groupCommitLane<T, C = void>(opts: GroupCommitOptions<T, C>): GroupCommitLane<T> {
  let queue: Array<Entry<T>> = []
  let scheduled = false
  let chain: Promise<void> = Promise.resolve()

  const drain = async (): Promise<void> => {
    scheduled = false
    if (queue.length === 0) return
    const batch = batchingEnabled() ? queue : queue.splice(0, 1)
    if (batchingEnabled()) queue = []
    else if (queue.length > 0) {
      scheduled = true
      const more = chain.then(drain, drain)
      chain = more.then(
        () => undefined,
        () => undefined,
      )
    }

    let release: (() => Promise<void>) | undefined
    const applied: Array<{ entry: Entry<T>; ok: boolean; value?: unknown; err?: unknown }> = []
    try {
      release = await opts.acquire()
      const { value, context } = await opts.read()
      let current = value
      const initial = current
      for (const entry of batch) {
        try {
          const { next, result } = await entry.apply(current)
          current = next
          applied.push({ entry, ok: true, value: result })
        } catch (err) {
          applied.push({ entry, ok: false, err })
        }
      }
      if (!Object.is(current, initial)) {
        opts.beforePublish?.()
        await opts.publish(current, context)
      }
    } catch (err) {
      const own = new Map(applied.filter(a => !a.ok).map(a => [a.entry, a.err]))
      for (const entry of batch) entry.reject(own.has(entry) ? own.get(entry) : err)
      return
    } finally {
      if (release) {
        try {
          await release()
        } catch {
        }
      }
    }
    for (const a of applied) {
      if (a.ok) a.entry.resolve(a.value)
      else a.entry.reject(a.err)
    }
  }

  return {
    submit: <R>(fn: (current: T) => Promise<{ next: T; result: R }>): Promise<R> =>
      new Promise<R>((resolve, reject) => {
        queue.push({
          apply: fn as unknown as Entry<T>['apply'],
          resolve: resolve as (value: unknown) => void,
          reject,
        })
        if (scheduled) return
        scheduled = true
        const op = chain.then(drain, drain)
        chain = op.then(
          () => undefined,
          () => undefined,
        )
      }),
  }
}
