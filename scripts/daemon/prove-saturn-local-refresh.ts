import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeTally } from './dupline-world.ts'

const root = mkdtempSync(join(tmpdir(), 'saturn-local-refresh-'))
process.env.MERCURY_CONFIG_DIR = join(root, 'home')
process.env.MERCURY_DAEMON_DIR = join(root, 'daemon')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_LOCAL_API_KEY
delete process.env.MERCURY_LOCAL_BASE_URL
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
mkdirSync(process.env.MERCURY_DAEMON_DIR, { recursive: true })
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { tickSaturnOnce } = await import('../../src/daemon/saturnTicker.ts')
const { liveFactsForSessionFire, deriveScheduleAccountForModel } = await import('../../src/daemon/saturnAccount.ts')
const { saturnBoxSchedulesPath, readBoxSchedules } = await import('../../src/daemon/saturnBoxSchedules.ts')
const tally = makeTally('prove-saturn-local-refresh')
let probes = 0
const server = createServer((req, res) => {
  req.resume()
  if (req.url === '/api/tags') probes++
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(req.url === '/api/tags' ? { models: [{ name: 'fixture:1', model: 'fixture:1' }] } : req.url === '/api/show' ? { capabilities: ['completion', 'tools'], model_info: { 'general.architecture': 'fixture', 'fixture.context_length': 32768 } } : {}))
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
process.env.MERCURY_LOCAL_PROBE_TARGETS = `ollama=http://127.0.0.1:${(server.address() as { port: number }).port}`
const now = Date.now()
const seed = (): void => writeFileSync(saturnBoxSchedulesPath(), JSON.stringify({ version: 1, schedules: [{ schema: 1, id: 'abcd1234', when: { kind: 'at', atMs: now - 1000 }, modelKey: 'local/fixture:1', action: { kind: 'birth', birth: { workspaceDir: root, modelKey: 'local/fixture:1', presence: 'headless' } }, account: { family: 'local', source: 'keyless' }, createdAt: now - 2000, createdBy: 'operator:test' }], heldFires: [] }))
let births = 0
const ports = {
  now: () => now, records: () => [], dir: process.env.MERCURY_DAEMON_DIR,
  deriveAccount: deriveScheduleAccountForModel, liveFacts: liveFactsForSessionFire,
  birth: async () => { births++; return { ok: true, sessionId: 'born-fixture' } },
  deliver: async () => ({ ok: true }), screenOpen: () => false,
}
try {
  seed()
  const up = await tickSaturnOnce(ports)
  console.log(JSON.stringify({ up, probes, births, holds: readBoxSchedules().heldFires }))
  tally.check('reachable local server births without prior discovery', up.fired === 1 && births === 1)
  tally.check('one discovery serves the tick', probes === 1)
  await new Promise<void>(resolve => server.close(() => resolve()))
  seed()
  const down = await tickSaturnOnce(ports)
  tally.check('stale reachable cache does not fire after server stops', down.held === 1 && births === 1)
  tally.check('the existing unreachable reason holds', readBoxSchedules().heldFires[0]?.reason === 'unreachable')
} finally {
  server.close()
  rmSync(root, { recursive: true, force: true })
}
tally.finish()
