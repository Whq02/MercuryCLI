import { termWrite } from '../terminalOut.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import type { TerminalResponse } from '../input/input-decoder.js'
import { csi } from '../termio/csi.js'
import { osc } from '../termio/osc.js'
import { startTimeout, stopTimeout } from '../../utils/timers.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

type TerminalQuery<T extends TerminalResponse = TerminalResponse> = Unbuilt

type DecrpmResponse = Unbuilt
type Da1Response = Unbuilt
type Da2Response = Unbuilt
type KittyResponse = Unbuilt
type CursorPosResponse = Unbuilt
type OscResponse = Unbuilt
type XtversionResponse = Unbuilt


export function decrqm(mode: number): TerminalQuery<DecrpmResponse> {
  return notBuilt('src/ink/session/querier.ts:23')
}

export function da1(): TerminalQuery<Da1Response> {
  return notBuilt('src/ink/session/querier.ts:30')
}

export function da2(): TerminalQuery<Da2Response> {
  return notBuilt('src/ink/session/querier.ts:37')
}

export function kittyKeyboard(): TerminalQuery<KittyResponse> {
  return notBuilt('src/ink/session/querier.ts:44')
}

export function cursorPosition(): TerminalQuery<CursorPosResponse> {
  return notBuilt('src/ink/session/querier.ts:51')
}

export function oscColor(code: number): TerminalQuery<OscResponse> {
  return notBuilt('src/ink/session/querier.ts:58')
}

export function xtversion(): TerminalQuery<XtversionResponse> {
  return notBuilt('src/ink/session/querier.ts:66')
}

type PendingQuery = Unbuilt

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

  whenSettled(deadlineMs?: number): Promise<QuerySettleOutcome> {
    return notBuilt('src/ink/session/querier.ts:129')
  }

  private notifySettled(): void {
    return notBuilt('src/ink/session/querier.ts:147')
  }

  send<T extends TerminalResponse>(query: TerminalQuery<T>): Promise<T | undefined> {
    return notBuilt('src/ink/session/querier.ts:154')
  }

  flush(): Promise<void> {
    return notBuilt('src/ink/session/querier.ts:165')
  }

  onResponse(r: TerminalResponse): void {
    return notBuilt('src/ink/session/querier.ts:179')
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
