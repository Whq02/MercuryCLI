#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { startSearchFixture } from './lib/searchFixture.ts'

const first = await startSearchFixture(0)
const second = await startSearchFixture(0)
try {
  assert.ok(first.port > 0 && second.port > 0, 'publish the actual listener ports')
  assert.notEqual(first.base, second.base, 'search proof copies own separate listeners')
  for (const fixture of [first, second]) {
    assert.equal(Number(new URL(fixture.base).port), fixture.port)
    const response = await fetch(`${fixture.base}/fixture-isolation`)
    await response.text()
  }
  assert.equal(first.hits.length, 1)
  assert.equal(second.hits.length, 1)
  console.log('PASS concurrent search fixtures publish distinct bound endpoints and do not share requests')
} finally { await Promise.all([first.close(), second.close()]) }
