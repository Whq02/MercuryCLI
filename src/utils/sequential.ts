/**
 * Wraps an async function so concurrent calls run one at a time in arrival
 * order, each receiving its own return value. Used for operations that
 * conflict when concurrent — file writes, store updates.
 */
export function sequential<Args extends unknown[], Result>(
  fn: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result> {
  type Job = { run: () => Promise<void> }
  const queue: Job[] = []
  let draining = false

  const drain = async (): Promise<void> => {
    if (draining) return
    draining = true
    try {
      // Re-check after finishing: items may have been enqueued mid-drain.
      while (queue.length > 0) {
        const job = queue.shift() as Job
        await job.run()
      }
    } finally {
      draining = false
    }
    if (queue.length > 0) void drain()
  }

  return function (this: unknown, ...args: Args): Promise<Result> {
    const receiver = this
    return new Promise<Result>((resolve, reject) => {
      queue.push({
        run: async () => {
          try {
            // The invocation context is preserved per call.
            resolve(await fn.apply(receiver, args))
          } catch (err) {
            // A rejection settles only this call; the queue continues.
            reject(err)
          }
        },
      })
      void drain()
    })
  }
}
