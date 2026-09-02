import type { Order, PricingRules } from './types.ts'

export function defaultRules(): PricingRules {
  return {
    bulkDiscount: 0.08,
    bulkThreshold: 24,
    couponRates: { WELCOME10: 0.1, VIP20: 0.2 },
  }
}

export function totalUnits(order: Order): number {
  return order.items.reduce((n, item) => n + item.quantity, 0)
}

export function earnedDiscountRate(order: Order, rules: PricingRules): number {
  let rate = 0
  if (totalUnits(order) >= rules.bulkThreshold) rate += rules.bulkDiscount
  if (order.couponCode) rate += rules.couponRates[order.couponCode] ?? 0
  return Math.min(rate, 0.45)
}
