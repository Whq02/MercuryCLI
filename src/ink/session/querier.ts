import { termWrite } from '../../render-engine/cockpit/terminalOut.js'
import type { TerminalResponse } from '../input/input-decoder.js'
import { csi } from '../termio/csi.js'
import { osc } from '../termio/osc.js'

// ============================================================================
//  querier — the Mercury terminal query/response mux.
//
//  RESPONSIBILITY: ask the terminal questions over the SHARED stdin stream
//  without timeouts. Terminals answer queries in order, and every terminal
//  since the VT100 answers DA1 (CSI c) — so a DA1 sentinel closes each
//  batch: a query answered before the sentinel is supported; the sentinel
//  arriving first proves the terminal ignored it (resolve undefined).
//
//  The queue is EXPLICIT BATCHES — each flush() closes the open batch. The
//  barrier drains exactly one batch, structurally: earlier callers' queries
//  can never eat a later batch's answers (the mux laws in prove-query-mux +
//  prove-session-contract: isolation · double-DA1 · late-reply drop ·
//  identical-query FIFO · fragmented responses).
//
//  Usage:
//    const [sync, grapheme] = await Promise.all([
//      querier.send(decrqm(2026)),
//      querier.send(decrqm(2027)),
//      querier.flush(),
//    ])
// ============================================================================

/** A terminal query: the outbound request + the inbound-response matcher. */
export type TerminalQuery<T extends TerminalResponse = TerminalResponse> = {
  request: string
  match: (r: TerminalResponse) => r is T
}

type DecrpmResponse = Extract<TerminalResponse, { type: 'decrpm' }>
type Da1Response = Extract<TerminalResponse, { type: 'da1' }>
type Da2Response = Extract<TerminalResponse, { type: 'da2' }>
type KittyResponse = Extract<TerminalResponse, { type: 'kittyKeyboard' }>
type CursorPosResponse = Extract<TerminalResponse, { type: 'cursorPosition' }>
type OscResponse = Extract<TerminalResponse, { type: 'osc' }>
type XtversionResponse = Extract<TerminalResponse, { type: 'xtversion' }>

// ── query builders (the public request vocabulary) ─────────────────────────

/** DECRQM: DEC private mode status (answered by DECRPM, or ignored). */
export function decrqm(mode: number): TerminalQuery<DecrpmResponse> {
  return {
    request: csi(`?${mode}$p`),
    match: (r): r is DecrpmResponse => r.type === 'decrpm' && r.mode === mode,
  }
}

/** Primary Device Attributes (CSI c) — the universal answerer; also the
 *  flush() sentinel. Send explicitly when the DA1 params themselves matter
 *  (the terminal then answers TWICE: the first reply matches this query,
 *  the second fires the sentinel). */
export function da1(): TerminalQuery<Da1Response> {
  return {
    request: csi('c'),
    match: (r): r is Da1Response => r.type === 'da1',
  }
}

/** Secondary Device Attributes (CSI > c) — terminal version. */
export function da2(): TerminalQuery<Da2Response> {
  return {
    request: csi('>c'),
    match: (r): r is Da2Response => r.type === 'da2',
  }
}

/** Current kitty keyboard flags (CSI ? u). */
export function kittyKeyboard(): TerminalQuery<KittyResponse> {
  return {
    request: csi('?u'),
    match: (r): r is KittyResponse => r.type === 'kittyKeyboard',
  }
}

/** DECXCPR cursor position (CSI ? 6 n) — the `?` marker keeps the reply
 *  disambiguable from modified F3 keys (plain CSI row;col R is ambiguous). */
export function cursorPosition(): TerminalQuery<CursorPosResponse> {
  return {
    request: csi('?6n'),
    match: (r): r is CursorPosResponse => r.type === 'cursorPosition',
  }
}

/** OSC dynamic color query (11 = background, 10 = foreground). */
export function oscColor(code: number): TerminalQuery<OscResponse> {
  return {
    request: osc(code, '?'),
    match: (r): r is OscResponse => r.type === 'osc' && r.code === code,
  }
}

/** XTVERSION (CSI > 0 q) — the terminal's name/version through the pty,
 *  surviving SSH where TERM_PROGRAM does not. */
export function xtversion(): TerminalQuery<XtversionResponse> {
  return {
    request: csi('>0q'),
    match: (r): r is XtversionResponse => r.type === 'xtversion',
  }
}

// ── the mux ─────────────────────────────────────────────────────────────────

const SENTINEL = csi('c')

type PendingQuery = {
  match: (r: TerminalResponse) => boolean
  resolve: (r: TerminalResponse | undefined) => void
}

/** One flush()-closed batch: its queries + the sentinel resolver. The OPEN
 *  batch (still accepting sends) has no sentinel yet. */
type Batch = {
  queries: PendingQuery[]
  sentinel: (() => void) | null
}

export class TerminalQuerier {
  /** Closed batches await their sentinels in FIFO order; the tail batch is
   *  open until the next flush(). */
  private batches: Batch[] = [{ queries: [], sentinel: null }]

  /** Request bytes of the OPEN batch, buffered: the whole batch leaves as
   *  ONE write at flush() (requests then sentinel — the byte ORDER of the
   *  stream is exactly the per-send stream's), so the boot identity probe's
   *  4-5 writes collapse to one syscall on the latency-critical path. A
   *  send() alone never reaches the wire — pair with flush(), which was
   *  already the contract (a sentinel-less batch never resolves). */
  private pendingRequests = ''

  constructor(private stdout: NodeJS.WriteStream) {}

  private get openBatch(): Batch {
    return this.batches[this.batches.length - 1]!
  }

  /** Send a query; resolves with its response, or undefined when the batch
   *  sentinel arrives first (the terminal ignored it). Never rejects; never
   *  times out on its own — pair with flush(). */
  send<T extends TerminalResponse>(query: TerminalQuery<T>): Promise<T | undefined> {
    return new Promise(resolve => {
      this.openBatch.queries.push({
        match: query.match,
        resolve: r => resolve(r as T | undefined),
      })
      this.pendingRequests += query.request
    })
  }

  /** Close the open batch with a DA1 sentinel; resolves when the terminal's
   *  DA1 reply lands (at which point every unanswered query in the batch
   *  has resolved undefined). Safe with zero pending queries. */
  flush(): Promise<void> {
    return new Promise(resolve => {
      this.openBatch.sentinel = resolve
      this.batches.push({ queries: [], sentinel: null })
      const bytes = this.pendingRequests + SENTINEL
      this.pendingRequests = ''
      // Probes ride the ONE door when the engine mount bound it (E4);
      // otherwise the classic direct write (byte-identical flag-off).
      termWrite(this.stdout, bytes, 'probe')
    })
  }

  /** Dispatch one parsed response. First-match-wins across batches in FIFO
   *  order (an explicit da1() query catches the first of the terminal's two
   *  DA1 replies; the second fires the sentinel). An unmatched DA1 fires the
   *  FIRST closed batch: its unanswered queries resolve undefined, later
   *  batches stay intact. Unsolicited responses drop silently. */
  onResponse(r: TerminalResponse): void {
    for (const batch of this.batches) {
      const idx = batch.queries.findIndex(q => q.match(r))
      if (idx !== -1) {
        const [q] = batch.queries.splice(idx, 1)
        q!.resolve(r)
        return
      }
    }
    if (r.type === 'da1') {
      const idx = this.batches.findIndex(b => b.sentinel !== null)
      if (idx === -1) return
      const [batch] = this.batches.splice(idx, 1)
      for (const q of batch!.queries) q.resolve(undefined)
      batch!.sentinel!()
    }
  }
}
