import { termWrite } from '../../render-engine/cockpit/terminalOut.js'
import type { TerminalResponse } from '../input/input-decoder.js'
import { csi } from '../termio/csi.js'
import { osc } from '../termio/osc.js'


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
  }
}

export function xtversion(): TerminalQuery<XtversionResponse> {
  return {
    request: csi('>0q'),
    match: (r): r is XtversionResponse => r.type === 'xtversion',
  }
}


const SENTINEL = csi('c')

type PendingQuery = {
  match: (r: TerminalResponse) => boolean
  resolve: (r: TerminalResponse | undefined) => void
}

type Batch = {
  queries: PendingQuery[]
  sentinel: (() => void) | null
}

export class TerminalQuerier {
  private batches: Batch[] = [{ queries: [], sentinel: null }]

  private pendingRequests = ''

  constructor(private stdout: NodeJS.WriteStream) {}

  private get openBatch(): Batch {
    return this.batches[this.batches.length - 1]!
  }

  send<T extends TerminalResponse>(query: TerminalQuery<T>): Promise<T | undefined> {
    return new Promise(resolve => {
      this.openBatch.queries.push({
        match: query.match,
        resolve: r => resolve(r as T | undefined),
      })
      this.pendingRequests += query.request
    })
  }

  flush(): Promise<void> {
    return new Promise(resolve => {
      this.openBatch.sentinel = resolve
      this.batches.push({ queries: [], sentinel: null })
      const bytes = this.pendingRequests + SENTINEL
      this.pendingRequests = ''
      termWrite(this.stdout, bytes, 'probe')
    })
  }

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
