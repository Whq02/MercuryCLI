import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkout } from '../src/services/checkout.ts'
import { OrderValidationError } from '../src/util/validate.ts'
import type { Order } from '../src/core/types.ts'

const order = (quantity: number): Order => ({
  id: 'o-9',
  customerId: 'c-2',
  items: [{ sku: 'SKU-B', description: 'gadget', unitCents: 250, quantity }],
  placedAt: '2026-07-02T00:00:00Z',
})

test('promo lowers the bulk threshold to 12', () => {
  const priced = checkout(order(12), true)
  assert.equal(priced.discountCents, Math.round(12 * 250 * 0.12))
})

test('just under the promo threshold earns no bulk discount', () => {
  const priced = checkout(order(11), true)
  assert.equal(priced.discountCents, 0)
})

test('checkout refuses empty orders', () => {
  const empty: Order = {
    id: 'o-0',
    customerId: 'c-3',
    items: [],
    placedAt: '2026-07-02T00:00:00Z',
  }
  assert.throws(() => checkout(empty), OrderValidationError)
})
