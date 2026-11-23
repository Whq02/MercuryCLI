import { termWrite } from '../terminalOut.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import type { TerminalResponse } from '../input/input-decoder.js'
import { csi } from '../termio/csi.js'
import { osc } from '../termio/osc.js'
import { startTimeout, stopTimeout } from '../../utils/timers.js'

type TerminalQuery<T extends TerminalResponse = TerminalResponse> = {
  request: string
  match: (r: TerminalResponse) => r is T
  stringReply?: boolean
}

type DecrpmResponse = Extract<TerminalResponse, { type: 'decrpm' }>
type Da1Response = Extract<TerminalResponse, { type: 'da1' }>
type Da2Response = Extract<TerminalResponse, { type: 'da2' }>
type KittyResponse = Extract<TerminalResponse, { type: 'kittyKeyboard' }>
type CursorPosResponse = Extract<TerminalResponse, { type: 'cursorPosition' }>
type OscResponse = Extract<TerminalResponse, { type: 'osc' }>
type XtversionResponse = Extract<TerminalResponse, { type: 'xtversion' }>

export function decrqm(mode: number): TerminalQuery<DecrpmResponse> {
  return {
    request: csi(`?${mode}$p`),
    match: (r): r is DecrpmResponse => r.type === 'decrpm' && r.mode === mode,
  }
}

export function da1(): TerminalQuery<Da1Response> {
  return {
    request: csi('c'),
    match: (r): r is Da1Response => r.type === 'da1',
  }
}

export function da2(): TerminalQuery<Da2Response> {
  return {
    request: csi('>c'),
    match: (r): r is Da2Response => r.type === 'da2',
  }
}

export function kittyKeyboard(): TerminalQuery<KittyResponse> {
  return {
    request: csi('?u'),
    match: (r): r is KittyResponse => r.type === 'kittyKeyboard',
  }
}

export function cursorPosition(): TerminalQuery<CursorPosResponse> {
  return {
    request: csi('?6n'),
    match: (r): r is CursorPosResponse => r.type === 'cursorPosition',
  }
}

export function oscColor(code: number): TerminalQuery<OscResponse> {
  return {
    request: osc(code, '?'),
    match: (r): r is OscResponse => r.type === 'osc' && r.code === code,
    stringReply: true,
  }
}

export function xtversion(): TerminalQuery<XtversionResponse> {
  return {
    request: csi('>0q'),
    match: (r): r is XtversionResponse => r.type === 'xtversion',
    stringReply: true,
  }
}

const SENTINEL = csi('c')

type PendingQuery = {
  match: (r: TerminalResponse) => boolean
  resolve: (r: TerminalResponse | undefined) => void
  stringReply: boolean
}

type Batch = {
  queries: PendingQuery[]
  sentinel: (() => void) | null
  flushedAt: number
  timer?: ReturnType<typeof setTimeout>
}

const DEFAULT_QUERY_SETTLE_MS = 250

export function terminalQuerySettleMs(): number {
  const raw = flagEnv('MERCURY_TERMINAL_QUERY_SETTLE_MS')
  const parsed = raw === undefined ? NaN : parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_QUERY_SETTLE_MS
}

const queriers = new WeakMap<object, TerminalQuerier>()

export function terminalQuerierFor(stdout: NodeJS.WriteStream): TerminalQuerier | undefined {
  return queriers.get(stdout)
}

type QuerySettleOutcome = 'settled' | 'deadline'

export class TerminalQuerier {
  private batches: Batch[] = [{ queries: [], sentinel: null, flushedAt: 0 }]

  private settleWaiters: Array<() => void> = []

  private pendingRequests = ''

  constructor(private stdout: NodeJS.WriteStream) {
    queriers.set(stdout, this)
  }

  private get openBatch(): Batch {
    return this.batches[this.batches.length - 1]!
  }

  settled(): boolean {
    return this.batches.every(batch => batch.sentinel === null)
  }

  stringReplyOwed(): boolean {
    return this.batches.some(batch => batch.sentinel !== null && batch.queries.some(query => query.stringReply))
  }

  whenSettled(deadlineMs: number = terminalQuerySettleMs()): Promise<QuerySettleOutcome> {
    if (this.settled()) return Promise.resolve('settled')
    const oldest = this.batches.find(batch => batch.sentinel !== null)
    if (!oldest) return Promise.resolve('settled')
    const remaining = deadlineMs - (Date.now() - oldest.flushedAt)
    if (remaining <= 0) return Promise.resolve('deadline')
    return new Promise<QuerySettleOutcome>(resolve => {
      const onSettled = (): void => {
        stopTimeout(timer)
        resolve('settled')
      }
      const timer = startTimeout(() => {
        const idx = this.settleWaiters.indexOf(onSettled)
        if (idx !== -1) this.settleWaiters.splice(idx, 1)
        resolve('deadline')
      }, remaining)
      this.settleWaiters.push(onSettled)
    })
  }

  private notifySettled(): void {
    if (!this.settled()) return
    const waiters = this.settleWaiters.splice(0)
    for (const waiter of waiters) waiter()
  }

  send<T extends TerminalResponse>(query: TerminalQuery<T>): Promise<T | undefined> {
    return new Promise<T | undefined>(resolve => {
      this.openBatch.queries.push({
        match: query.match,
        resolve: r => resolve(r !== undefined && query.match(r) ? r : undefined),
        stringReply: query.stringReply === true,
      })
      this.pendingRequests += query.request
    })
  }

  flush(): Promise<void> {
    return new Promise<void>(resolve => {
      const batch = this.openBatch
      batch.sentinel = resolve
      batch.flushedAt = Date.now()
      const timer = startTimeout(() => this.closeBatch(batch), 250)
      timer.unref?.()
      batch.timer = timer
      this.batches.push({ queries: [], sentinel: null, flushedAt: 0 })
      const wire = this.pendingRequests + SENTINEL
      this.pendingRequests = ''
      termWrite(this.stdout, wire)
    })
  }

  onResponse(r: TerminalResponse): void {
    const now = Date.now()
    for (const batch of [...this.batches]) {
      if (batch.sentinel !== null && now - batch.flushedAt >= 250) {
        this.closeBatch(batch)
      }
    }
    for (const batch of this.batches) {
      const index = batch.queries.findIndex(query => query.match(r))
      if (index !== -1) {
        const [matched] = batch.queries.splice(index, 1)
        matched.resolve(r)
        return
      }
    }
    if (r.type === 'da1') {
      const oldest = this.batches.find(batch => batch.sentinel !== null)
      if (oldest) this.closeBatch(oldest)
    }
  }

  private closeBatch(batch: Batch): void {
    const index = this.batches.indexOf(batch)
    if (index === -1) return
    this.batches.splice(index, 1)
    if (batch.timer !== undefined) stopTimeout(batch.timer)
    for (const query of batch.queries) query.resolve(undefined)
    batch.sentinel?.()
    this.notifySettled()
  }
}
