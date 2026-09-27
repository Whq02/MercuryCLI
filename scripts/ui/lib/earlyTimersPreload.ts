const EARLY_MS = Number(process.env.PROOF_TIMER_EARLY_MS ?? '10')
const FLOOR_MS = 100
const realSetTimeout = globalThis.setTimeout
const earlySetTimeout = (handler: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]): ReturnType<typeof realSetTimeout> =>
  realSetTimeout(handler, typeof timeout === 'number' && timeout >= FLOOR_MS ? timeout - EARLY_MS : timeout, ...args)
;(globalThis as { setTimeout: unknown }).setTimeout = earlySetTimeout
process.stderr.write(`early-timers preload: every timer of ${FLOOR_MS}ms or more lands ${EARLY_MS}ms early\n`)
