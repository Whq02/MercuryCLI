#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { startWorkflowAgentFixture } from '../lib/workflowAgentFixture.ts'

const first = await startWorkflowAgentFixture({ port: 0, gptId: 'fixture-first' })
const second = await startWorkflowAgentFixture({ port: 0, gptId: 'fixture-second' })
try {
  assert.notEqual(new URL(first.base).port, '0', 'the fixture must publish the port the OS actually bound')
  assert.notEqual(first.base, second.base, 'concurrent fixtures own different listeners')
  for (const [fixture, id] of [[first, 'fixture-first'], [second, 'fixture-second']] as const) {
    assert.equal(fixture.env.ANTHROPIC_BASE_URL, fixture.base)
    assert.equal(fixture.env.MERCURY_OPENAI_API_BASE, `${fixture.base}/openai/v1`)
    const models = await fetch(`${fixture.base}/openai/v1/models`).then(r => r.json()) as { models: Array<{ slug: string }> }
    assert.ok(models.models.some(row => row.slug === id), 'each listener answers from its own fixture state')
    await fetch(`${fixture.base}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: id, messages: [] }) }).then(r => r.text())
  }
  assert.equal(first.captured.length, 1)
  assert.equal(second.captured.length, 1)
  assert.equal(first.captured[0]!.model, 'fixture-first')
  assert.equal(second.captured[0]!.model, 'fixture-second')
  console.log('PASS simultaneous workflow fixtures bind ephemeral ports, publish their actual endpoints and keep requests separate')
} finally { await Promise.all([first.close(), second.close()]) }
