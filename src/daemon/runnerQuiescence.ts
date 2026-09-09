export type QuiescenceRequest = {
  subtype: 'quiesce'
  action: 'prepare' | 'commit' | 'cancel'
  token: string
}

export type QuiescenceAnswer =
  | { ok: true; token: string; phase: 'prepared' | 'committed' | 'cancelled' }
  | { ok: false; token: string; reason: string }

export class RunnerQuiescence {
  private preparation: { token: string; revision: number; ready: boolean } | null = null
  private revision = 0
  private committedToken: string | null = null

  constructor(private readonly effects: {
    refusal(): string | null
    flush(): Promise<void>
  }) {}

  get committed(): boolean {
    return this.committedToken !== null
  }

  invalidate(): boolean {
    if (this.committed) return false
    this.revision++
    this.preparation = null
    return true
  }

  async request(request: QuiescenceRequest): Promise<QuiescenceAnswer> {
    const { token, action } = request
    const refused = (reason: string): QuiescenceAnswer => ({ ok: false, token, reason })
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) return refused('invalid preparation token')
    if (this.committed) {
      return token === this.committedToken && action === 'commit'
        ? { ok: true, token, phase: 'committed' }
        : refused('retirement already committed')
    }
    if (action === 'cancel') {
      if (this.preparation !== null && this.preparation.token !== token) return refused('preparation token changed')
      this.invalidate()
      return { ok: true, token, phase: 'cancelled' }
    }
    if (action !== 'prepare' && action !== 'commit') return refused('unknown quiescence action')
    if (action === 'prepare') {
      if (this.preparation !== null) return refused('another preparation is outstanding')
      this.preparation = { token, revision: this.revision, ready: false }
    }
    const preparation = this.preparation
    if (preparation === null || preparation.token !== token || (action === 'commit' && !preparation.ready)) {
      return refused('preparation is absent or invalidated')
    }
    const current = (): boolean => this.preparation === preparation && this.revision === preparation.revision
    try {
      const before = this.effects.refusal()
      if (before !== null) {
        if (current()) this.invalidate()
        return refused(before)
      }
      await this.effects.flush()
      if (!current()) return refused('new activity invalidated preparation')
      const after = this.effects.refusal()
      if (after !== null) {
        this.invalidate()
        return refused(after)
      }
      if (action === 'prepare') {
        preparation.ready = true
        return { ok: true, token, phase: 'prepared' }
      }
      this.committedToken = token
      this.preparation = null
      return { ok: true, token, phase: 'committed' }
    } catch (error) {
      if (current()) this.invalidate()
      return refused(`durable state unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

export type RetirementResult =
  | { outcome: 'parked' }
  | { outcome: 'refused'; reason: string; fenced: boolean }

export class RetirementFence {
  private cancelled = false
  private phase: 'open' | 'preparing' | 'committing' | 'exited' = 'open'
  private pending: Promise<RetirementResult> | null = null
  private token: string | null = null

  constructor(private readonly effects: {
    request(request: QuiescenceRequest): Promise<QuiescenceAnswer>
    refusal(): string | null
    persistIntent(token: string): void
    clearIntent(token: string): void
    expectExit(expected: boolean): void
    observeExit(): Promise<boolean>
    persistParked(token: string): void
  }) {}

  get fenced(): boolean {
    return this.phase === 'preparing' || this.phase === 'committing'
  }

  async demand(): Promise<RetirementResult> {
    if (this.phase === 'preparing') this.cancelled = true
    if (this.pending !== null) return this.pending
    return this.phase === 'exited'
      ? { outcome: 'parked' }
      : { outcome: 'refused', reason: this.fenced ? 'retirement awaits confirmed exit or cancellation' : 'new demand', fenced: this.fenced }
  }

  retire(token: string): Promise<RetirementResult> {
    if (this.pending !== null) return this.pending
    if (this.phase !== 'open') return this.demand()
    this.phase = 'preparing'
    this.token = token
    this.cancelled = false
    const pending = this.run(token)
    this.pending = pending
    void pending.finally(() => { if (this.pending === pending) this.pending = null })
    return pending
  }

  private async cancel(token: string, reason: string): Promise<RetirementResult> {
    try {
      const answer = await this.effects.request({ subtype: 'quiesce', action: 'cancel', token })
      if (answer.ok && answer.token === token && answer.phase === 'cancelled') {
        this.effects.clearIntent(token)
        this.effects.expectExit(false)
        this.phase = 'open'
        this.token = null
      }
    } catch {}
    return { outcome: 'refused', reason, fenced: this.fenced }
  }

  private async finish(token: string): Promise<RetirementResult> {
    if (!await this.effects.observeExit()) {
      return { outcome: 'refused', reason: 'retirement awaits observed process exit', fenced: true }
    }
    this.effects.persistParked(token)
    this.phase = 'exited'
    this.token = null
    return { outcome: 'parked' }
  }

  async reconcileExit(): Promise<RetirementResult> {
    if (this.pending !== null) return this.pending
    if (this.phase !== 'committing' || this.token === null) return this.demand()
    const token = this.token
    const pending = (async (): Promise<RetirementResult> => {
      try {
        return await this.finish(token)
      } catch (error) {
        return { outcome: 'refused', reason: String(error), fenced: true }
      }
    })()
    this.pending = pending
    void pending.finally(() => { if (this.pending === pending) this.pending = null })
    return pending
  }

  private async run(token: string): Promise<RetirementResult> {
    try {
      const first = this.effects.refusal()
      if (first !== null) {
        this.phase = 'open'
        this.token = null
        return { outcome: 'refused', reason: first, fenced: false }
      }
      const prepared = await this.effects.request({ subtype: 'quiesce', action: 'prepare', token })
      if (!prepared.ok || prepared.token !== token || prepared.phase !== 'prepared') {
        return await this.cancel(token, prepared.ok ? 'runner did not prepare this token' : prepared.reason)
      }
      const changed = this.cancelled ? 'new demand cancelled retirement' : this.effects.refusal()
      if (changed !== null) return await this.cancel(token, changed)
      this.effects.persistIntent(token)
      this.phase = 'committing'
      this.effects.expectExit(true)
      const committed = await this.effects.request({ subtype: 'quiesce', action: 'commit', token })
      if (!committed.ok || committed.token !== token || committed.phase !== 'committed') {
        return await this.cancel(token, committed.ok ? 'runner did not commit this token' : committed.reason)
      }
      return await this.finish(token)
    } catch (error) {
      return await this.cancel(token, `retirement not confirmed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
