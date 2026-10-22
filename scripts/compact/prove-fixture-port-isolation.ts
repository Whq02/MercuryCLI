#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { startFoldFamiliesFixture } from './foldFamiliesFixture.ts'

const first = await startFoldFamiliesFixture({ port: 0 })
const second = await startFoldFamiliesFixture({ port: 0 })
try {
  assert.notEqual(new URL(first.base).port, '0', 'publish the bound port, not the requested zero')
  assert.notEqual(first.base, second.base, 'concurrent family fixtures must not share a listener')
  for (const [fixture, model] of [[first, 'fixture-first'], [second, 'fixture-second']] as const) {
    assert.equal(fixture.env.MERCURY_DEEPSEEK_API_BASE, `${fixture.base}/deepseek`)
    const response = await fetch(`${fixture.base}/deepseek/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [] }),
    })
    assert.equal(response.status, 200)
    await response.text()
    assert.equal(fixture.captured.length, 1)
    assert.equal(fixture.captured[0]!.model, model)
  }
  console.log('PASS compact family fixtures publish distinct bound ports and retain only their own requests')
} finally { await Promise.all([first.close(), second.close()]) }
