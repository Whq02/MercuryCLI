import { coolDownWindowMs, liveSearchClock, type SearchClock } from '../../services/search/searchPacing.js'
import { AbortError } from '../../utils/errors.js'

export class FetchPacing {
  private next = 0
  private until = 0
  private refusals = 0
  private lastRefusal = 0
  private turn: Promise<void> = Promise.resolve()

  constructor(readonly clock: SearchClock = liveSearchClock) {}

  remaining(): number {
    return Math.max(0, this.until - this.clock.now())
  }

  refuse(retryAfter: unknown): number {
    const now = this.clock.now()
    this.refusals = now - this.lastRefusal > 1_200_000 ? 1 : this.refusals + 1
    this.lastRefusal = now
    const value = typeof retryAfter === 'string' ? retryAfter : ''
    const seconds = value.trim() === '' ? NaN : Number(value)
    const asked = Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(value) - now) || 0
    this.until = Math.max(this.until, now + Math.max(asked, coolDownWindowMs(this.refusals, this.clock.random)))
    return this.remaining()
  }

  answered(): void {
    this.refusals = 0
    this.until = 0
  }

  async run<T>(intervalMs: number, signal: AbortSignal | undefined, request: (wait: number) => Promise<T>): Promise<T> {
    const prior = this.turn
    let release!: () => void
    this.turn = new Promise<void>(resolve => { release = resolve })
    let holdsTurn = false
    try {
      await untilTurn(prior, signal)
      holdsTurn = true
      if (signal?.aborted) throw new AbortError()
      if (this.remaining() > 0) return await request(this.remaining())
      await this.clock.sleep(Math.max(0, this.next - this.clock.now()), signal)
      if (signal?.aborted) throw new AbortError()
      if (this.remaining() > 0) return await request(this.remaining())
      this.next = this.clock.now() + intervalMs
      return await request(0)
    } finally {
      if (holdsTurn) release()
      else void prior.then(release)
    }
  }
}

function untilTurn(prior: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return prior
  if (signal.aborted) return Promise.reject(new AbortError())
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => reject(new AbortError())
    signal.addEventListener('abort', onAbort, { once: true })
    void prior.then(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    })
  })
}
