import type { Order, PricedOrder, PricingRules } from '../core/types.ts'
import { computeOrderTotal } from '../core/pricing.ts'
import { defaultRules } from '../core/rules.ts'
import { assertValidOrder } from '../util/validate.ts'

/** Seasonal override used by the storefront during promotions. */
const PROMO_RULES: PricingRules = {
  bulkDiscount: 0.12,
  bulkThreshold: 12,
  couponRates: { WELCOME10: 0.1, VIP20: 0.2, SUMMER15: 0.15 },
}

/** Validate and price an order for purchase. */
export function checkout(order: Order, promo = false): PricedOrder {
  assertValidOrder(order)
  return computeOrderTotal(order, promo ? PROMO_RULES : defaultRules())
}
