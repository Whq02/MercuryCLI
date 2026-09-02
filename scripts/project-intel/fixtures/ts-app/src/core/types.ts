export interface LineItem {
  sku: string
  description: string
  unitCents: number
  quantity: number
}

export interface Order {
  id: string
  customerId: string
  items: LineItem[]
  couponCode?: string
  placedAt: string
}

/** Pricing configuration applied by the pricing engine. */
export interface PricingRules {
  /** Fractional discount applied when an order reaches `bulkThreshold` units. */
  bulkDiscount: number
  /** Minimum total unit count that activates the bulk discount. */
  bulkThreshold: number
  /** Per-coupon fractional discounts, keyed by coupon code. */
  couponRates: Record<string, number>
}

export interface PricedOrder {
  order: Order
  subtotalCents: number
  discountCents: number
  totalCents: number
}
