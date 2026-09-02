// resources/adapters/receipt — ChangeReceipts from the slice-1 ring
// (mercury://receipt/<id-or-seq>, listing at mercury://receipt).
// Conversation-lifetime state: a receipt from a previous process reads as
// EXPIRED, never as silently missing.

import {
  receiptById,
  receiptCursor,
  receiptsFor,
} from '../../changeTransaction/receipts.js'
import { changeTransactionEnabled } from '../../changeTransaction/contracts.js'
import {
  formatRef,
  type ParsedRef,
  type ResourceAdapter,
  type ResourceContext,
  type ResourceResult,
} from '../contracts.js'

export const receiptAdapter: ResourceAdapter = {
  kind: 'receipt',
  describe: 'ChangeReceipts — observed mutations with intent (mercury://receipt/<id>)',
  async resolve(ref: ParsedRef, ctx: ResourceContext): Promise<ResourceResult> {
    if (!changeTransactionEnabled()) {
      return { state: 'unavailable', note: 'change receipts are disabled (MERCURY_CHANGE_RECEIPTS=0)' }
    }
    const all = receiptsFor(ctx.owner)
    if (ref.id === '') {
      return {
        state: 'ok',
        resource: {
          ref: 'mercury://receipt',
          kind: 'receipt',
          title: 'change receipts',
          summary: `${all.length} retained receipt(s) · cursor ${receiptCursor(ctx.owner)}`,
          version: `c${receiptCursor(ctx.owner)}`,
          mutable: false,
          children: all.slice(-50).map(r => ({
            ref: formatRef('receipt', r.id),
            title: `#${r.seq} ${r.effect.operation} (${r.effect.outcome})`,
            summary: r.effect.evidence.slice(0, 120),
          })),
        },
      }
    }
    const receipt =
      receiptById(ctx.owner, ref.id) ??
      (Number.isInteger(Number(ref.id))
        ? all.find(r => r.seq === Number(ref.id))
        : undefined)
    if (!receipt) {
      const cursor = receiptCursor(ctx.owner)
      const seq = Number(ref.id)
      if (Number.isInteger(seq) && seq >= 1 && seq <= cursor) {
        return {
          state: 'expired',
          note: `receipt #${seq} existed but fell off the bounded ring (retention ${all.length}, cursor ${cursor}) — the durable record is the run sidecar`,
        }
      }
      return { state: 'absent', note: `no receipt '${ref.id}' in this conversation` }
    }
    return {
      state: 'ok',
      resource: {
        ref: ref.canonical,
        kind: 'receipt',
        title: `receipt #${receipt.seq} — ${receipt.effect.operation}`,
        summary: `${receipt.effect.outcome} · ${receipt.effect.changedPaths.length} path(s) · ${receipt.toolName}`,
        version: `s${receipt.seq}`,
        mutable: false,
        text: [
          `tool: ${receipt.toolName} (${receipt.toolUseId ?? 'no tool-use id'})`,
          `intent: ${receipt.intent.operation} ← ${receipt.intent.source}`,
          `targets: ${receipt.intent.targetPaths.join(', ') || '(none)'}`,
          ...(receipt.intent.expectedAnchor ? [`carried anchor: ${receipt.intent.expectedAnchor}`] : []),
          `outcome: ${receipt.effect.outcome}`,
          `changed: ${receipt.effect.changedPaths.join(', ') || '(nothing)'}`,
          `evidence: ${receipt.effect.evidence}`,
          `window: ${new Date(receipt.startedAt).toISOString()} → ${new Date(receipt.completedAt).toISOString()}`,
        ].join('\n'),
        structured: {
          seq: receipt.seq,
          operation: receipt.effect.operation,
          outcome: receipt.effect.outcome,
          changedPaths: receipt.effect.changedPaths,
        },
      },
    }
  },
}
