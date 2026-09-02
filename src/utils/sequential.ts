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
            resolve(await fn.apply(receiver, args))
          } catch (err) {
            reject(err)
          }
        },
      })
      void drain()
    })
  }
}
