#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { startSearchFixture } from './lib/searchFixture.ts'

const first = await startSearchFixture(0)
const second = await startSearchFixture(0)
try {
  assert.ok(first.port > 0 && second.port > 0, 'publish the actual listener ports: startSearchFixture in scripts/search/lib/searchFixture.ts must return the bound port of server.address() when asked for port 0')
  assert.notEqual(first.base, second.base, 'search proof copies own separate listeners: startSearchFixture in scripts/search/lib/searchFixture.ts must listen on a fresh port per call and build base from it')
  for (const fixture of [first, second]) {
    assert.equal(Number(new URL(fixture.base).port), fixture.port, 'the base URL of startSearchFixture in scripts/search/lib/searchFixture.ts must carry the same port as its port field')
    const response = await fetch(`${fixture.base}/fixture-isolation`)
    await response.text()
  }
  assert.equal(first.hits.length, 1, 'each fixture must record only the request sent to its own listener; check the hits array in startSearchFixture in scripts/search/lib/searchFixture.ts')
  assert.equal(second.hits.length, 1, 'each fixture must record only the request sent to its own listener; check the hits array in startSearchFixture in scripts/search/lib/searchFixture.ts')
  console.log('PASS concurrent search fixtures publish distinct bound endpoints and do not share requests')
} finally { await Promise.all([first.close(), second.close()]) }
