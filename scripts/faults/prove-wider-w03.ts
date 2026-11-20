#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { FAKE_BIN, GIB, MAC_48, QWEN_2B_REPO, fakeWorld } from '../tensorfold/fixtures/world.ts'

;(globalThis as Record<string, unknown>).MACRO ??= { VERSION: '1.0.0' }
delete process.env.MERCURY_LOCAL_API_KEY
delete process.env.MERCURY_LOCAL_BASE_URL
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const serve = await import('../../src/services/tensorfold/serve.ts')
const road = await import('../../src/commands/tensorfold/road.ts')
const scene = await import('../../src/commands/tensorfold/scene.ts')
const panel = await import('../../src/commands/tensorfold/tensorfold.tsx')
const engine = await import('../../src/services/tensorfold/engine.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => resolve(typeof address === 'object' && address !== null ? address.port : 0))
    })
  })
}

const binary = `${FAKE_BIN}/tensorfold`
const noApp = async (): Promise<{ running: boolean }> => ({ running: false })
engine.__pinTensorFoldMachineForTest(MAC_48)

console.log('w03-1: startTensorFold and stopTensorFold surface side-step failures in result and notice')
{
  const world = fakeWorld('wider-w03-1')
  const servedFile = join(world.home, 'served.json')
  const keyPath = join(world.home, 'api-key')
  const makeKeyFile = () => {
    writeFileSync(keyPath, `mercury[inference]: ${'k'.repeat(32)}\n`, { mode: 0o600 })
    return { path: keyPath, key: 'k'.repeat(32), line: `mercury[inference]: ${'k'.repeat(32)}` }
  }
  const port = await freePort()
  process.env.PATH = world.env.PATH!
  const baseServeIo = {
    binary,
    cwd: world.cwd,
    sessionId: 'proof',
    env: world.env,
    serviceEnv: { ...world.serviceEnv, FAKE_TENSORFOLD_BIND_LOOPBACK: '1' },
    servedFile,
    machine: MAC_48,
    app: noApp,
    freeMemoryBytes: async () => 40 * GIB,
    answersAs: async () => undefined,
    keyFile: makeKeyFile,
    machineName: () => 'studio-w03',
    rememberHost: async () => undefined,
    forgetHost: async () => undefined,
    rememberPort: () => undefined,
    rememberWindow: () => undefined,
    forgetPort: () => undefined,
  }

  const clean = await serve.startTensorFold({ repo: QWEN_2B_REPO, window: 262_144, port }, baseServeIo)
  const cleanWarnings = (clean as { warnings?: readonly string[] }).warnings
  check('clean start returns empty warnings list', Array.isArray(cleanWarnings) && cleanWarnings.length === 0, JSON.stringify(cleanWarnings))
  const cleanStopped = await serve.stopTensorFold('qwen3.5-2b', { servedFile, forgetPort: () => undefined, forgetHost: async () => undefined })
  const cleanStopWarnings = (cleanStopped as { warnings?: readonly string[] } | void)?.warnings
  check('clean stop returns empty warnings list', Array.isArray(cleanStopWarnings) && cleanStopWarnings.length === 0, JSON.stringify(cleanStopWarnings))

  road.__resetTensorFoldRoadForTest()
  const facts = await scene.readTensorFoldPanelFacts({ cacheRoot: world.cache, machine: MAC_48, engine: null, env: world.env, home: world.home, servedFile, localModels: () => [], hosts: () => [] })
  const row = { ...facts.rows.find(candidate => candidate.repo === QWEN_2B_REPO)!, port }
  const servedOutcome = await road.serveTensorFoldRow(
    row,
    262_144,
    {
      serve: {
        ...baseServeIo,
        rememberPort: () => { throw new Error('port-store-ro') },
        rememberWindow: () => { throw new Error('window-store-ro') },
        announce: async () => { throw new Error('mdns-down') },
      },
      prove: { env: { ...world.env, MERCURY_LOCAL_PROBE_TARGETS: 'none' }, persist: () => ({ sentence: ' · saved' }), setAppState: () => undefined, focusedConnector: () => ({ carrier: 'in-process' }) as never },
    },
    { share: true },
  )
  const startWarnings = (servedOutcome?.served as { warnings?: readonly string[] } | undefined)?.warnings ?? []
  const startNotice = road.tensorFoldRoadState().notice ?? ''
  check(
    'start side-step failures (rememberPort, rememberWindow, announce) are returned and put in the notice while start succeeds',
    servedOutcome !== null &&
      startWarnings.some(w => w.includes('port-store-ro')) &&
      startWarnings.some(w => w.includes('window-store-ro')) &&
      startWarnings.some(w => w.includes('mdns-down')) &&
      startNotice.includes('port-store-ro') &&
      startNotice.includes('window-store-ro') &&
      startNotice.includes('mdns-down'),
    JSON.stringify({ startWarnings, startNotice }),
  )
  await serve.stopTensorFold('qwen3.5-2b', { servedFile, forgetPort: () => undefined, forgetHost: async () => undefined })

  await serve.startTensorFold(
    { repo: QWEN_2B_REPO, window: 262_144, port, share: true },
    {
      ...baseServeIo,
      announce: async () => ({
        code: '123456',
        stop: () => Promise.reject(new Error('pairing-close-failed')),
      }),
    },
  )
  road.__resetTensorFoldRoadForTest()
  const liveFacts = await scene.readTensorFoldPanelFacts({ cacheRoot: world.cache, machine: MAC_48, engine: null, env: world.env, home: world.home, servedFile, localModels: () => [], hosts: () => [] })
  const liveRow = liveFacts.rows.find(candidate => candidate.repo === QWEN_2B_REPO)!
  await panel.onTensorFoldAct(
    { kind: 'stop', row: liveRow },
    liveFacts,
    {
      serve: {
        servedFile,
        forgetPort: () => { throw new Error('forget-port-ro') },
        forgetHost: async () => { throw new Error('forget-host-ro') },
      },
    },
  )
  const stopNotice = road.tensorFoldRoadState().notice ?? ''
  check(
    'stop side-step failures (pairing.stop, forgetPort, forgetShared) surface in the TensorFold notice while stop succeeds',
    serve.servedTensorFold({ servedFile }).length === 0 &&
      stopNotice.includes('stopped qwen3.5-2b') &&
      stopNotice.includes('pairing-close-failed') &&
      stopNotice.includes('forget-port-ro') &&
      stopNotice.includes('forget-host-ro'),
    JSON.stringify({ stopNotice, remaining: serve.servedTensorFold({ servedFile }).length }),
  )

  await serve.startTensorFold({ repo: QWEN_2B_REPO, window: 262_144, port }, baseServeIo)
  road.__resetTensorFoldRoadForTest()
  const shareFacts = await scene.readTensorFoldPanelFacts({ cacheRoot: world.cache, machine: MAC_48, engine: null, env: world.env, home: world.home, servedFile, localModels: () => [], hosts: () => [] })
  const shareRow = shareFacts.rows.find(candidate => candidate.repo === QWEN_2B_REPO)!
  await panel.onTensorFoldAct(
    { kind: 'share', row: shareRow },
    shareFacts,
    {
      serve: {
        ...baseServeIo,
        rememberPort: () => { throw new Error('share-port-ro') },
        announce: async () => ({ code: '654321', stop: () => undefined }),
      },
      prove: { env: { ...world.env, MERCURY_LOCAL_PROBE_TARGETS: 'none' }, persist: () => ({ sentence: ' · saved' }), setAppState: () => undefined, focusedConnector: () => ({ carrier: 'in-process' }) as never },
    },
  )
  const shareNotice = road.tensorFoldRoadState().notice ?? ''
  check(
    'share act keeps both the pairing code and start side-step warnings in the notice',
    shareNotice.includes('654321') && shareNotice.includes('share-port-ro'),
    JSON.stringify(shareNotice),
  )
  await serve.stopTensorFold('qwen3.5-2b', { servedFile, forgetPort: () => undefined, forgetHost: async () => undefined })
}

console.log(`\n${failures === 0 ? 'GREEN' : `RED (${failures})`}: prove-wider-w03`)
process.exit(failures === 0 ? 0 : 1)
