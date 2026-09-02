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

export interface PricingRules {
  bulkDiscount: number
  bulkThreshold: number
  couponRates: Record<string, number>
}

export interface PricedOrder {
  order: Order
  subtotalCents: number
  discountCents: number
  totalCents: number
}
