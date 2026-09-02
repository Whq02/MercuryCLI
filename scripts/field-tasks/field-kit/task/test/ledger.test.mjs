import test from 'node:test'
import assert from 'node:assert/strict'
import { sheetTotal, formatPence } from '../src/ledger.mjs'

test('deliveries earn', () => {
  assert.equal(sheetTotal([{ kind: 'delivery', pence: 500 }]), 500)
})

test('fees cost', () => {
  assert.equal(sheetTotal([{ kind: 'delivery', pence: 500 }, { kind: 'fee', pence: 45 }]), 455)
})

test('refunds cost too — a refund hands money back', () => {
  assert.equal(
    sheetTotal([
      { kind: 'delivery', pence: 500 },
      { kind: 'refund', pence: 120 },
      { kind: 'fee', pence: 45 },
    ]),
    335,
  )
})

test('unknown kinds refuse loudly', () => {
  assert.throws(() => sheetTotal([{ kind: 'tips', pence: 10 }]), /unknown entry kind/)
})

test('formatting is stable', () => {
  assert.equal(formatPence(335), '£3.35')
  assert.equal(formatPence(-45), '-£0.45')
  assert.equal(formatPence(5), '£0.05')
})
