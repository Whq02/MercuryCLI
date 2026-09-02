import type { Order } from '../core/types.ts'
import { computeOrderTotal } from '../core/pricing.ts'
import { defaultRules } from '../core/rules.ts'

export interface RevenueReport {
  orders: number
  grossCents: number
  discountCents: number
  netCents: number
}

/** Aggregate revenue across a day's orders under the standing rules. */
export function dailyRevenue(orders: Order[]): RevenueReport {
  const report: RevenueReport = {
    orders: orders.length,
    grossCents: 0,
    discountCents: 0,
    netCents: 0,
  }
  for (const order of orders) {
    const priced = computeOrderTotal(order, defaultRules())
    report.grossCents += priced.subtotalCents
    report.discountCents += priced.discountCents
    report.netCents += priced.totalCents
  }
  return report
}
