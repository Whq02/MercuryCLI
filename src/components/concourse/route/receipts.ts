import type { ControlNoteState } from '../contracts.js';

export const rowReceiptClock = (): string => {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
export const rowReceipt = (what: string): string => `${what} — you · ${rowReceiptClock()}`
export const noteFromReceipt = (receipt: { outcome?: string; detail?: string }): ControlNoteState =>
  receipt.outcome === 'applied'
    ? 'applied'
    : receipt.outcome === 'noop'
      ? { state: 'applied', reason: receipt.detail ?? 'no change' }
      : receipt.outcome === 'failed'
        ? {
            state: 'failed',
            reason: receipt.detail ?? 'the daemon did not answer',
            next: '↵ retries the same request',
          }
        : {
            state: 'refused',
            ...(receipt.detail !== undefined ? { reason: receipt.detail } : {}),
            next: 'the draft is kept · ↵ retries',
          }
