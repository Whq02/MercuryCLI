import type { Order, PricedOrder, PricingRules } from './types.ts'
import { earnedDiscountRate } from './rules.ts'
import { roundCents } from '../util/money.ts'

/**
 * Price an order under the given rules: subtotal, earned discount, total.
 * The single pricing entrypoint — every surface that shows money calls this.
 */
export function computeOrderTotal(order: Order, rules: PricingRules): PricedOrder {
  const subtotalCents = order.items.reduce(
    (sum, item) => sum + item.unitCents * item.quantity,
    0,
  )
  const discountCents = roundCents(subtotalCents * earnedDiscountRate(order, rules))
  const totalCents = subtotalCents - discountCents
  return { order, subtotalCents, discountCents, totalCents }
}
