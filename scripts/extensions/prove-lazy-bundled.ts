import { proofHome } from '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spyOn } from 'bun:test'
import * as crypto from 'node:crypto'
import { removeScratch } from '../lib/removeScratch.ts'
import { setCwdState, setOriginalCwd, setProjectRoot } from '../../src/bootstrap/state.js'
import { enableConfigs } from '../../src/utils/config/globalConfig.js'
import { computeRoster } from '../../src/extensions/roster.js'
import { bootExtensions, reloadExtensions } from '../../src/extensions/reload.js'
import { getExtensionMcpServers } from '../../src/extensions/load/servers.js'
import { setSwitch } from '../../src/extensions/install.js'
import { bundledMetadata, bundledPayloads } from '../../src/extensions/bundled/content.generated.js'
import { bundledRoster } from '../../src/extensions/bundled/index.js'
import { contributionsHash } from '../../src/extensions/manifest.js'
import { hashTree } from '../../src/extensions/tree.js'
import { callMCPToolWithUrlElicitationRetry, clearServerCache, fetchToolsForClient, getServerCacheKey, prefetchAllMcpResources } from '../../src/services/mcp/client.js'
import { StdioClientTransport } from '../../src/services/mcp/sdk.js'
import type { ConnectedMCPServer } from '../../src/services/mcp/types.js'

setCwdState(proofHome)
setOriginalCwd(proofHome)
setProjectRoot(proofHome)
enableConfigs()
const configs: ReturnType<typeof getExtensionMcpServers>[] = []
try {
  const boot = await bootExtensions({ cwd: proofHome })
  const media = boot.set.roster.entries.find(e => e.name === 'mercury-media')!
  assert.equal(media.switchedOn, false)
  assert.ok(media.root && !existsSync(media.root))
  const coldConfigs = getExtensionMcpServers()
  configs.push(coldConfigs)
  assert.equal(Object.keys(coldConfigs).length, 3, JSON.stringify({ counts: boot.counts, health: [...boot.set.healthById] }))
  const cold = await prefetchAllMcpResources(coldConfigs)
  const clients = cold.clients as ConnectedMCPServer[]
  assert.equal(clients.length, 3)
  assert.ok(clients.every(c => c.type === 'connected'))
  const transports = clients.map(c => c.client.transport as StdioClientTransport)
  assert.ok(transports.every(t => t instanceof StdioClientTransport && t.pid === null))
  assert.equal(cold.tools.filter(t => t.mcpInfo?.toolName.startsWith('craft_')).length, 9)
  for (const client of clients) {
    const metadata = client.config.bundledBootstrap!
    assert.equal(client.instructions, metadata.instructions)
    assert.deepEqual(await client.client.request({ method: 'tools/list' }), { tools: metadata.tools })
  }
  console.log('cold session: three enabled Craft extensions, nine tools, unchanged instructions, zero bridge pids')
  const film = clients.find(c => c.name === 'ext:filmcraft:app')!
  const transport = film.client.transport as StdioClientTransport
  const invoke = () => callMCPToolWithUrlElicitationRetry({ client: film, tool: 'craft_status', args: {}, signal: AbortSignal.timeout(10000) })
  const start = performance.now()
  const [first, concurrent] = await Promise.all([invoke(), invoke()])
  const firstMs = performance.now() - start
  assert.match(JSON.stringify(first.content), /FilmCraft/)
  assert.match(JSON.stringify(concurrent.content), /FilmCraft/)
  assert.ok(transport.pid !== null)
  const pid = transport.pid
  assert.equal(transports.filter(t => t.pid !== null).length, 1)
  const secondStart = performance.now()
  await invoke()
  const secondMs = performance.now() - secondStart
  assert.equal(transport.pid, pid)
  const liveTools = await film.client.request({ method: 'tools/list' })
  assert.deepEqual(liveTools.tools, film.config.bundledBootstrap!.tools)
  assert.equal((await fetchToolsForClient(film)).length, 3)
  console.log(`first craft_status (two concurrent calls): ${firstMs.toFixed(2)} ms; second: ${secondMs.toFixed(2)} ms; one reused pid`)
  await reloadExtensions({ cwd: proofHome })
  const reloadedConfigs = getExtensionMcpServers()
  configs.push(reloadedConfigs)
  for (const [name, config] of Object.entries(reloadedConfigs)) assert.equal(getServerCacheKey(name, config), getServerCacheKey(name, coldConfigs[name]!))
  const reloaded = await prefetchAllMcpResources(reloadedConfigs)
  assert.equal(reloaded.clients.find(c => c.name === film.name), film)
  assert.equal(transport.pid, pid)
  console.log('reload keeps the install-grant key and connection identity; no duplicate bridge set')
  const hashSpy = spyOn(crypto, 'createHash')
  const timings: number[] = []
  try {
    for (let i = 0; i < 30; i++) {
      const t = performance.now()
      computeRoster({ cwd: proofHome, sessionPaths: [] })
      timings.push(performance.now() - t)
    }
    assert.equal(hashSpy.mock.calls.length, 0)
  } finally { hashSpy.mockRestore() }
  console.log(`30 rosters: mean ${(timings.reduce((a, b) => a + b, 0) / timings.length).toFixed(3)} ms; zero payload hash calls`)
  assert.ok(!existsSync(media.root!))
  assert.equal(setSwitch(media.id, true).ok, true)
  assert.ok(existsSync(join(media.root!, 'server/server.js')))
  const enabledHashSpy = spyOn(crypto, 'createHash')
  try {
    for (let i = 0; i < 3; i++) assert.equal(computeRoster({ cwd: proofHome }).entries.find(e => e.id === media.id)?.switchedOn, true)
    assert.equal(enabledHashSpy.mock.calls.length, 0)
  } finally { enabledHashSpy.mockRestore() }
  assert.equal(setSwitch(media.id, false).ok, true)
  for (const def of bundledRoster()) {
    if (!def.metadata) continue
    assert.equal(hashTree(def.root), def.metadata.contentHash)
    assert.equal(contributionsHash(def.metadata.manifest, def.root), def.metadata.contributionsHash)
    assert.equal(crypto.createHash('sha256').update(JSON.stringify(bundledPayloads[def.name])).digest('hex').slice(0, 16), bundledMetadata[def.name]!.digest)
  }
  console.log('media writes only on enable; build-time payload and approval digests match the delivered bytes')
  const file = join(film.config.type === 'stdio' ? film.config.env!.MERCURY_EXTENSION_ROOT! : '', 'server/bridge.mjs')
  const original = readFileSync(file)
  try {
    writeFileSync(file, 'tampered')
    assert.throws(() => computeRoster({ cwd: proofHome }), /Bundled extension file changed/)
  } finally { writeFileSync(file, original) }
  console.log('materialized bundled bytes still reject tampering')
} finally {
  for (const config of configs) for (const [name, ref] of Object.entries(config)) await clearServerCache(name, ref)
  removeScratch(proofHome)
}
