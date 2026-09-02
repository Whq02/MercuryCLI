import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertValidOrder, OrderValidationError } from '../src/util/validate.ts'
import type { Order } from '../src/core/types.ts'

const base: Order = {
  id: 'o-5',
  customerId: 'c-9',
  items: [{ sku: 'SKU-Z', description: 'gizmo', unitCents: 100, quantity: 1 }],
  placedAt: '2026-07-03T00:00:00Z',
}

test('a well-formed order passes', () => {
  assertValidOrder(base)
})

test('non-positive quantities are refused', () => {
  const bad = { ...base, items: [{ ...base.items[0]!, quantity: 0 }] }
  assert.throws(() => assertValidOrder(bad), OrderValidationError)
})

test('fractional unit prices are refused', () => {
  const bad = { ...base, items: [{ ...base.items[0]!, unitCents: 99.5 }] }
  assert.throws(() => assertValidOrder(bad), OrderValidationError)
})
