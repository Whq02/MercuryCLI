import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeOrderTotal } from '../src/core/pricing.ts'
import { defaultRules } from '../src/core/rules.ts'
import type { Order, PricingRules } from '../src/core/types.ts'

const order = (quantity: number, couponCode?: string): Order => ({
  id: 'o-1',
  customerId: 'c-1',
  items: [{ sku: 'SKU-A', description: 'widget', unitCents: 250, quantity }],
  ...(couponCode ? { couponCode } : {}),
  placedAt: '2026-07-01T00:00:00Z',
})

test('small orders earn no discount', () => {
  const priced = computeOrderTotal(order(2), defaultRules())
  assert.equal(priced.totalCents, 500)
  assert.equal(priced.discountCents, 0)
})

test('the bulk threshold earns the bulk rate', () => {
  const priced = computeOrderTotal(order(24), defaultRules())
  assert.equal(priced.discountCents, Math.round(24 * 250 * 0.08))
})

test('coupon and bulk discounts stack, capped at 45%', () => {
  const rules: PricingRules = {
    bulkDiscount: 0.5,
    bulkThreshold: 1,
    couponRates: {},
  }
  const priced = computeOrderTotal(order(1), rules)
  assert.equal(priced.discountCents, 113) // 250 * 0.45 cap, rounded half-up
})
