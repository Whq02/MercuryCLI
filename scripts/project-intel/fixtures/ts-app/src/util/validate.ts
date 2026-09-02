import type { Order } from '../core/types.ts'

export class OrderValidationError extends Error {}

/** Refuse structurally broken orders before any money math runs. */
export function assertValidOrder(order: Order): void {
  if (order.items.length === 0) {
    throw new OrderValidationError(`order ${order.id} has no items`)
  }
  for (const item of order.items) {
    if (item.quantity <= 0) {
      throw new OrderValidationError(`${item.sku}: non-positive quantity`)
    }
    if (!Number.isInteger(item.unitCents) || item.unitCents < 0) {
      throw new OrderValidationError(`${item.sku}: bad unit price`)
    }
  }
}
