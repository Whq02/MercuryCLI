import '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { installFixture, proofHome, root, serverPath } from './fixture.ts'
import { runMediaSetup } from '../../src/services/media/setup.js'
import { readMediaSettings } from '../../src/services/media/settings.js'
import { updateSettingsForSource } from '../../src/utils/settings/settings.js'
import { connectMediaHost, mediaHostStatePath } from '../../src/services/media/host.js'
import { writeHostRecord } from '../../src/services/host/store.js'
import { sweepHostIdle, HOST_IDLE_LIMIT_MS } from '../../src/services/host/idle.js'
import { setOriginalCwd, setProjectRoot } from '../../src/bootstrap/state.js'

setOriginalCwd(proofHome)
setProjectRoot(proofHome)

let requests = 0
const now = Date.now()
let activityAt = now
const server = createServer((req, res) => {
  requests++
  assert.equal(req.headers.authorization, 'Bearer ' + 'a'.repeat(64))
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(req.url === '/health' ? { ok: true } : { at: activityAt, now: Date.now() }))
})
try {
  installFixture()
  assert.equal(updateSettingsForSource('projectSettings', { media: { host: 'project-cannot-select-a-rental' } }).error, null)
  assert.equal(readMediaSettings().host, undefined)
  await runMediaSetup(['inspect-model', join(proofHome, 'model.safetensors')], () => {}, undefined, { root, serverPath, host: 'not-a-rental' })
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'called.jsonl'), 'utf8').trim()), ['inspect-model', join(proofHome, 'model.safetensors')])
  const record = { id: 'boundary-rental', name: 'fixture GPU', recipe: 'fixture', price: 1, startedAt: new Date(now - 3 * HOST_IDLE_LIMIT_MS).toISOString(), advancedAt: now - 3 * HOST_IDLE_LIMIT_MS, status: 'RUNNING', jobState: 'ready' as const, target: { host: 'gpu.example' } }
  writeHostRecord(record)
  const statePath = mediaHostStatePath(record.id)
  mkdirSync(dirname(statePath), { recursive: true })
  const state = { id: record.id, name: 'Runpod pod boundary-rental', token: 'a'.repeat(64), port: 30080, url: 'https://example.com' }
  writeFileSync(statePath, JSON.stringify(state))
  await assert.rejects(connectMediaHost(record.id, new AbortController().signal), /Media setup returned an unreadable response/)
  assert.equal(requests, 0)
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  state.url = 'http://127.0.0.1:' + (server.address() as { port: number }).port
  writeFileSync(statePath, JSON.stringify(state))
  let releases = 0
  const options = { records: [record], now, lastTurnAt: () => undefined, release: async () => { releases++ } }
  assert.deepEqual(await sweepHostIdle(options), [])
  assert.equal(releases, 0)
  assert.ok(requests >= 2)
  activityAt = now - 3 * HOST_IDLE_LIMIT_MS
  writeFileSync(join(dirname(statePath), 'activity.json'), JSON.stringify({ at: activityAt }))
  assert.equal((await sweepHostIdle(options)).length, 1)
  assert.equal(releases, 1)
  console.log('media host boundaries: no project-selected rental, local import preflight, loopback-only token destination, active remote jobs defer idle release and genuine two-hour idle still releases')
} finally {
  server.closeAllConnections()
  await new Promise<void>(done => server.close(() => done()))
  rmSync(proofHome, { recursive: true, force: true })
}
