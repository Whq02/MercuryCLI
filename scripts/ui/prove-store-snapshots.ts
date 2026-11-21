#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { pinScratchHome, releaseScratchHome } from '../lib/settingsPopupHarness.ts'

const home = pinScratchHome('store-snapshot-proof')
let checked = 0
function stable<T>(name: string, read: () => T): T {
  const first = read()
  assert.ok(Object.is(first, read()), `${name}: two reads without a write must be Object.is equal; cache the selected value at its store`)
  checked++
  return first
}

try {
  const { createStore } = await import('../../src/state/store.js')
  const { signInLedgerEpoch, subscribeSignInEpoch, noteCredentialChange } = await import('../../src/utils/accounts/signInLedger.js')
  const limits = await import('../../src/services/anthropicLimits.js')
  const state = createStore({ line: { text: 'first' }, count: 0 })
  const select = () => state.getState().line
  const first = stable('screen store: selected line', select)
  state.setState(prev => ({ ...prev, count: prev.count + 1 }))
  assert.equal(stable('screen store: unrelated write', select), first)
  state.setState(prev => ({ ...prev, line: { text: 'next' } }))
  assert.notEqual(stable('screen store: changed line', select), first)

  const before = stable('sign-in ledger epoch', signInLedgerEpoch)
  let atChange: number | undefined
  const stop = subscribeSignInEpoch(() => { atChange = stable('sign-in ledger notification', signInLedgerEpoch) })
  try {
    noteCredentialChange()
    await Promise.resolve()
    assert.notEqual(atChange, before)
    assert.equal(atChange, signInLedgerEpoch())
  } finally {
    stop()
  }
  stable('provider limits', () => limits.currentLimits)
  console.log(`${checked} unchanged pairs have identical snapshots`)
} finally {
  await releaseScratchHome(home)
}
