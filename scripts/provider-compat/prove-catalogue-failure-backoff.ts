import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'catalogue-backoff-'))
delete process.env.MERCURY_HOME

const { saveGlobalConfig } = await import('../../src/utils/config.js')
const { refreshCompatCatalogues, cachedCompatCatalogue } = await import('../../src/services/providers/openaicompat/compatCatalogue.js')
const { configuredCompatEndpoints } = await import('../../src/services/providers/openaicompat/compatAccounts.js')
const { refreshZaiCatalogue } = await import('../../src/services/providers/zai/zaiCatalogue.js')
const realNow = Date.now
let now = 1_000_000
Date.now = () => now
let requests = 0
const fetchImpl = (async () => { requests++; throw new Error('fixture offline') }) as typeof fetch
const env = { MERCURY_LOCAL_PROBE_TARGETS: 'none', ZAI_API_KEY: 'fixture-zai-key', MERCURY_ZAI_API_BASE: 'http://127.0.0.1:1/a/v4' }
try {
  saveGlobalConfig(config => ({ ...config, compatProvider: { east: { baseUrl: 'http://127.0.0.1:1/east/v1' }, west: { baseUrl: 'http://127.0.0.1:1/west/v1' } } }))
  const failures: string[] = []
  for (const road of ['compat', 'zai']) {
    requests = 0
    const refresh = (force = false) => road === 'compat' ? refreshCompatCatalogues({ name: 'east', fetchImpl, env, force }) : refreshZaiCatalogue({ fetchImpl, env, force, now: () => now })
    await refresh()
    const first = requests
    assert.ok(first > 0)
    now += 299_999
    await refresh()
    if (requests !== first) failures.push(`${road}: failed URL retried before 300 seconds`)
    now += 1
    await refresh()
    if (requests !== first * 2) failures.push(`${road}: expiry did not retry exactly once`)
    await refresh(true)
    if (requests !== first * 3) failures.push(`${road}: forced refresh did not retry now`)
  }
  requests = 0
  await refreshCompatCatalogues({ name: 'west', env, fetchImpl })
  assert.ok(requests > 0, 'another URL is not held behind the failed endpoint')
  const east = configuredCompatEndpoints(env).find(endpoint => endpoint.name === 'east')!
  assert.ok(cachedCompatCatalogue(east, env)?.error?.includes('fixture offline'))
  assert.deepEqual(failures, [])
  console.log('catalogue failure backoff, URL isolation and force refresh: PASS')
} finally { Date.now = realNow }
