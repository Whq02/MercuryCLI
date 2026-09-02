// resources/adapters/transaction — canonical mutation transactions
// Owner-relative: the ring is
// conversation-lifetime state derived from the exactly-once receipt feed
// plus explicit multi-stage transactions. Children are refs into the
// receipt/file/evidence kinds — never embedded object graphs.

import {
  transactionById,
  transactionsFor,
} from '../../primitives/transactionPlane.js'
import type { TransactionRecord } from '../../primitives/transaction.js'
import {
  formatRef,
  type ParsedRef,
  type ResourceAdapter,
  type ResourceChild,
  type ResourceContext,
  type ResourceResult,
} from '../contracts.js'

function describeTransaction(t: TransactionRecord): string {
  return (
    `${t.kind} · ${t.state}` +
    (t.failure ? ` — ${t.failure.code}: ${t.failure.message.slice(0, 80)}` : '') +
    ` · ${t.resultRefs.length} result ref(s)`
  )
}

function transactionChildren(t: TransactionRecord): ResourceChild[] {
  const children: ResourceChild[] = []
  if (t.effectRef) {
    children.push({ ref: t.effectRef, title: 'effect', summary: `observed effect → ${t.effectRef}` })
  }
  for (const ref of t.inputRefs.slice(0, 8)) {
    children.push({ ref, title: 'input', summary: `input → ${ref}` })
  }
  for (const ref of t.resultRefs.slice(0, 8)) {
    children.push({ ref, title: 'result', summary: `result → ${ref}` })
  }
  for (const ref of t.evidenceRefs.slice(-8)) {
    children.push({ ref, title: 'evidence', summary: `evidence → ${ref}` })
  }
  if (t.executionRef) {
    children.push({ ref: t.executionRef, title: 'execution', summary: `execution → ${t.executionRef}` })
  }
  return children
}

export const transactionAdapter: ResourceAdapter = {
  kind: 'transaction',
  describe:
    'canonical mutation transactions — lifecycle over receipts + staged ops (mercury://transaction/<id>)',
  async resolve(ref: ParsedRef, ctx: ResourceContext): Promise<ResourceResult> {
    if (ref.id === '') {
      const children = await this.list!(ctx)
      return {
        state: 'ok',
        resource: {
          ref: 'mercury://transaction',
          kind: 'transaction',
          title: 'transactions',
          summary: `${children.length} transaction(s) this conversation`,
          mutable: false,
          children,
        },
      }
    }
    const record = transactionById(ctx.owner, ref.id)
    if (!record) {
      const known = transactionsFor(ctx.owner)
      return {
        state: known.length >= 128 ? 'expired' : 'absent',
        note:
          known.length >= 128
            ? `transaction '${ref.id}' is not retained — the bounded ring holds the newest 128`
            : `no transaction '${ref.id}' for this conversation`,
      }
    }
    return {
      state: 'ok',
      resource: {
        ref: ref.canonical,
        kind: 'transaction',
        title: `${record.kind} (${record.state})`,
        summary: describeTransaction(record),
        version: `u${record.updatedAt}`,
        mutable: !['settled', 'failed', 'cancelled', 'stale'].includes(record.state),
        children: transactionChildren(record),
        structured: {
          id: record.id,
          kind: record.kind,
          state: record.state,
          createdAt: record.createdAt,
          expectedVersions: record.expectedVersions,
          failure: record.failure ?? null,
        },
      },
    }
  },
  async list(ctx: ResourceContext): Promise<ResourceChild[]> {
    return transactionsFor(ctx.owner)
      .slice(-50)
      .reverse()
      .map(t => ({
        ref: formatRef('transaction', t.id),
        title: `${t.kind} (${t.state})`,
        summary: describeTransaction(t),
      }))
  },
}
