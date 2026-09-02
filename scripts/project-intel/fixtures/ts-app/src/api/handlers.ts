import type { Order } from '../core/types.ts'
import { checkout } from '../services/checkout.ts'
import { buildInvoice } from '../services/invoicing.ts'

/** POST /checkout — price an order and return the charge summary. */
export function handleCheckout(body: string): string {
  const order = JSON.parse(body) as Order
  const priced = checkout(order, false)
  return JSON.stringify({ orderId: order.id, totalCents: priced.totalCents })
}

/** POST /invoice — render the invoice for an order. */
export function handleInvoice(body: string): string {
  const order = JSON.parse(body) as Order
  return JSON.stringify(buildInvoice(order))
}
