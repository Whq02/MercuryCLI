import type { Order } from '../core/types.ts'
import { computeOrderTotal } from '../core/pricing.ts'
import { defaultRules } from '../core/rules.ts'
import { formatCents } from '../util/money.ts'

export interface Invoice {
  orderId: string
  lines: string[]
  totalLine: string
}

/** Render a plain-text invoice for an order under the standing rules. */
export function buildInvoice(order: Order): Invoice {
  const priced = computeOrderTotal(order, defaultRules())
  const lines = order.items.map(
    item => `${item.quantity} x ${item.description} @ ${formatCents(item.unitCents)}`,
  )
  return {
    orderId: order.id,
    lines,
    totalLine: `TOTAL ${formatCents(priced.totalCents)} (saved ${formatCents(priced.discountCents)})`,
  }
}
