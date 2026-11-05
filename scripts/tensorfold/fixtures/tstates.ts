import { join } from 'node:path'
import { FAKE_BIN, GIB, LIGHTNING_REPO, MAC_16, MAC_32_LOW, MAC_48, QWEN_27B_REPO, QWEN_2B_CONFIG, QWEN_2B_PIN, QWEN_2B_REPO, QWEN_9B_REPO, RTX_4090, fakeExists, fakeWorld, type CacheSeed } from './world.ts'
import type { TensorFoldHost } from '../../../src/services/tensorfold/contracts.ts'

const engine = await import('../../../src/services/tensorfold/engine.ts')
const fit = await import('../../../src/services/tensorfold/fit.ts')
const refusal = await import('../../../src/services/tensorfold/refusal.ts')
const inventory = await import('../../../src/services/tensorfold/inventory.ts')
const scene = await import('../../../src/commands/tensorfold/scene.ts')

export type Facts = Awaited<ReturnType<typeof scene.readTensorFoldPanelFacts>>
export type Engine = NonNullable<Awaited<ReturnType<typeof engine.findTensorFoldEngine>>>
export type OutsideSeed = { id: string; baseUrl: string; window?: number; servedBytes?: number; server?: 'tensorfold' | 'llamacpp' }
export type TStateOptions = {
  seeds?: CacheSeed[]
  machine?: typeof MAC_48
  engine?: Engine | null
  platform?: NodeJS.Platform
  state?: Parameters<typeof scene.readTensorFoldPanelFacts>[1]
  served?: Facts['served']
  outside?: OutsideSeed[]
  hosts?: TensorFoldHost[]
  current?: string
  brew?: boolean
  diskFree?: number
  keyed?: boolean
  turn?: { model: string; address: string; tokensPerSecond?: number; timeToFirstTokenS?: number }
}

export const ON_DISK: CacheSeed = { repo: QWEN_2B_REPO, config: QWEN_2B_CONFIG, weightsBytes: 4096, sha: QWEN_2B_PIN }
export const SERVED_2B = { repo: QWEN_2B_REPO, name: 'qwen3.5-2b', port: 8080, window: 262_144, pid: 1, startedAt: 't', promptCacheGib: 1 }
export const POD_TUNNEL: TensorFoldHost = { name: 'pod-rtx-5090', baseUrl: 'http://127.0.0.1:18080', origin: 'pod', serving: 'qwen3.8-27b', version: '1.2.2', chip: 'NVIDIA GeForce RTX 5090', window: 131_072 }
export const STUDIO: TensorFoldHost = { name: 'studio.local', baseUrl: 'http://studio.local:8080', origin: 'typed', keyRef: 'studio.local', serving: 'qwen3.8-27b', version: '1.2.2', chip: 'Apple M3 Ultra', window: 131_072, lastReply: { tokensPerSecond: 38 } }
export const GGUF_REFUSED = { input: 'unsloth/Qwen3.5-9B-GGUF', refused: "GGUF is llama.cpp's format · /localsetup serves it" }
export const MEMORY_REFUSAL_LINE = "tensorfold: one stream's 131072-token window of KV pages (8.00 GiB) does not fit the 5.12 GiB left under the load limit; lower --context"
export const LIMIT_REFUSAL_LINE = 'tensorfold: --parallel 1 needs 2.00 GiB for its streams and 8-row prompt scratch at a 32768-token context; 0.50 GiB remains beside the weights and an 8 GiB margin: lower --parallel or --context'
export const KEYED_ADDRESS = '127.0.0.1:8080'
export const SERVED_2B_RECORD: OutsideSeed = { id: 'qwen3.5-2b', baseUrl: 'http://127.0.0.1:8080/v1', window: 262_144, servedBytes: 2_965_982_016 }
export const SERVED_2B_TURN = { model: 'local/qwen3.5-2b', address: '127.0.0.1:8080', tokensPerSecond: 110, timeToFirstTokenS: 0.04 }

export async function fakeEngineFound(): Promise<Engine> {
  const world = fakeWorld('tf-facts-engine')
  const found = await engine.findTensorFoldEngine({ env: world.env, home: world.home, platform: 'darwin', exists: fakeExists, machine: MAC_48 } as never)
  if (found === null) throw new Error('the fake engine was not found')
  return found
}

let pinned: Engine | undefined

export async function fakeEngine(): Promise<Engine> {
  pinned ??= await fakeEngineFound()
  engine.__pinTensorFoldMachineForTest(MAC_48)
  return pinned
}

export async function tStateFacts(id: string, opts: TStateOptions = {}): Promise<Facts> {
  const found = await fakeEngine()
  const world = fakeWorld(`tf-${id}`, { seeds: opts.seeds ?? [ON_DISK] })
  const machine = opts.machine ?? MAC_48
  return scene.readTensorFoldPanelFacts(
    {
      cacheRoot: world.cache,
      machine,
      engine: opts.engine === undefined ? found : opts.engine,
      env: world.env,
      home: world.home,
      platform: opts.platform ?? machine.platform,
      servedFile: join(world.home, 'served.json'),
      served: opts.served ?? [],
      localModels: () => (opts.outside ?? []).map(server => ({ id: server.id, server: server.server ?? ('tensorfold' as const), baseUrl: server.baseUrl, ...(server.window !== undefined ? { contextWindow: { tokens: server.window, source: 'served' as const } } : {}), ...(server.servedBytes !== undefined ? { servedBytes: server.servedBytes } : {}) })) as never,
      hosts: () => opts.hosts ?? [],
      helper: () => undefined,
      app: async () => ({ running: false }),
      ...(opts.current !== undefined ? { current: opts.current } : {}),
      exists: (path: string) => (opts.brew === false ? false : path === '/opt/homebrew/bin/brew'),
      diskFreeBytes: () => opts.diskFree ?? 37_578_240_000,
      keyedAt: async () => opts.keyed === true,
      lastTurn: () => opts.turn,
    },
    opts.state ?? { acts: {} },
  )
}

export const KEY_RIGHT = '\u001b[C'
export const KEY_LEFT = '\u001b[D'

export type TState = { frame: string; facts: Facts; land?: string; keys?: string[]; unfoldHost?: boolean }

export async function tStates(): Promise<TState[]> {
  const t06 = await tStateFacts('t06', {})
  const checkpoint27b = t06.rows.find(row => row.repo === QWEN_27B_REPO)!.checkpoint
  const nine = inventory.rowOfCheckpoint({ repo: QWEN_9B_REPO, label: 'Qwen3.5 9B', shortName: 'qwen3.5-9b', family: 'qwen3_5', weightsBytes: 5_950_221_072, downloadBytes: 5_977_074_591, kvBytesPerToken: 8 * 4 * 256 * 4, trainedMax: 262_144, promptCacheGib: 1, qualified: false }, MAC_48, { onDisk: false, bytesOnDisk: 0, drafterOnDisk: true })
  const pulling = scene.pullActOf(QWEN_27B_REPO, [{ at: 0, bytes: 0 }, { at: 148_000, bytes: 6.1e9 }], 19_930_634_001, 131_072)
  const memoryRefusal = refusal.readTensorFoldRefusal(MEMORY_REFUSAL_LINE, { window: 131_072, ladder: fit.tensorFoldLadder(checkpoint27b, MAC_48) })
  const limitRefusal = refusal.readTensorFoldRefusal(LIMIT_REFUSAL_LINE, { window: 32_768, needBytes: fit.tensorFoldProjectedBytes(checkpoint27b, 32_768), machine: MAC_32_LOW, ladder: fit.tensorFoldLadder(checkpoint27b, MAC_32_LOW) })
  const exitRefusal = refusal.readTensorFoldRefusal('serving qwen3.5-2b at http://127.0.0.1:8080/v1 (loaded in 1.2s)\n', { exit: { code: null, signal: 'SIGKILL' } })
  const serving: TStateOptions = { served: [SERVED_2B], current: 'local/qwen3.5-2b', outside: [SERVED_2B_RECORD], turn: SERVED_2B_TURN }
  return [
    { frame: 't01-not-installed-macos', facts: await tStateFacts('t01', { engine: null }) },
    { frame: 't02-installing-macos', facts: await tStateFacts('t02', { engine: null, state: { acts: { install: { kind: 'installing', line: '==> Downloading https://github.com/ashhart/TensorFold/releases/download/v1.2.2/tensorfold-1.2.2-macos-arm64.tar.gz' } } } }), land: 'install TensorFold' },
    { frame: 't03-no-homebrew-macos', facts: await tStateFacts('t03', { engine: null, brew: false }), land: 'install TensorFold' },
    { frame: 't04-not-installed-linux', facts: await tStateFacts('t04', { engine: null, machine: RTX_4090, seeds: [] }), land: 'install TensorFold' },
    { frame: 't05-windows', facts: await tStateFacts('t05', { engine: null, platform: 'win32', machine: { ...MAC_48, platform: 'win32' } }), land: 'rent a GPU pod' },
    { frame: 't06-opened', facts: t06 },
    { frame: 't08-window-past-fit', facts: t06, land: 'local/qwen3.8-27b', keys: [KEY_RIGHT] },
    { frame: 't09-on-disk', facts: t06, land: 'local/qwen3.5-2b' },
    { frame: 't10-other-typing', facts: t06, land: 'other checkpoint', keys: ['\r', ...QWEN_9B_REPO] },
    { frame: 't10b-other-read', facts: await tStateFacts('t10b', { state: { acts: {}, other: { input: QWEN_9B_REPO, read: nine } } }), land: 'local/qwen3.5-9b' },
    { frame: 't11-other-refused', facts: await tStateFacts('t11', { state: { acts: {}, other: GGUF_REFUSED } }), land: 'other checkpoint' },
    { frame: 't12-pulling', facts: await tStateFacts('t12', { state: { acts: { [QWEN_27B_REPO]: pulling } } }) },
    { frame: 't13-starting', facts: await tStateFacts('t13', { state: { acts: { [QWEN_27B_REPO]: { kind: 'starting', name: 'qwen3.8-27b', port: 8080, seconds: 41 } } } }) },
    { frame: 't14-current', facts: await tStateFacts('t14', serving) },
    { frame: 't14b-restart-window', facts: await tStateFacts('t14b', serving), keys: [KEY_LEFT] },
    { frame: 't15-switch', facts: await tStateFacts('t15', serving), land: 'local/nemotron-lightning' },
    { frame: 't15b-stop-confirm', facts: await tStateFacts('t15b', serving), keys: ['s'] },
    { frame: 't16-serving-outside', facts: await tStateFacts('t16', { outside: [{ id: 'qwen3.5-2b', baseUrl: 'http://127.0.0.1:8087/v1', window: 32_768, servedBytes: 2_965_982_016 }] }) },
    { frame: 't16b-pod-tunnel', facts: await tStateFacts('t16b', { outside: [{ id: 'qwen3.5-2b', baseUrl: 'http://127.0.0.1:8087/v1', window: 32_768, servedBytes: 2_965_982_016 }, { id: 'qwen3.8-27b', baseUrl: 'http://127.0.0.1:18080/v1', window: 131_072 }], hosts: [POD_TUNNEL], turn: { model: 'compat/pod-rtx-5090/qwen3.8-27b', address: '127.0.0.1:18080', promptTokens: 4_570, completionTokens: 180, tokensPerSecond: 78.4, timeToFirstTokenS: 0.41 } }), unfoldHost: true },
    { frame: 't17-refused-memory', facts: await tStateFacts('t17', { state: { acts: { [QWEN_27B_REPO]: scene.refusedActOf('qwen3.8-27b', 131_072, memoryRefusal) } } }) },
    { frame: 't17b-wired-limit', facts: await tStateFacts('t17b', { machine: MAC_32_LOW, state: { acts: { [QWEN_27B_REPO]: scene.refusedActOf('qwen3.8-27b', 32_768, limitRefusal) } } }), land: 'local/qwen3.8-27b' },
    { frame: 't18-keyed-server', facts: await tStateFacts('t18', { keyed: true }) },
    { frame: 't19-port-busy', facts: await tStateFacts('t19', { outside: [{ id: 'llama', baseUrl: 'http://127.0.0.1:8080/v1', server: 'llamacpp' }] }), land: 'local/qwen3.5-2b' },
    { frame: 't20-exited', facts: await tStateFacts('t20', { state: { acts: { [QWEN_2B_REPO]: { kind: 'exited', name: 'qwen3.5-2b', port: 8080, line: `${exitRefusal.line} · its log: Service logs tensorfold` } } } }), land: 'local/qwen3.5-2b' },
    { frame: 't21-small-mac', facts: await tStateFacts('t21', { machine: MAC_16 }) },
    { frame: 't22-host-server', facts: await tStateFacts('t22', { hosts: [STUDIO] }), unfoldHost: true, land: 'local/qwen3.8-27b' },
    { frame: 't23-host-rent', facts: await tStateFacts('t23', { hosts: [STUDIO] }), unfoldHost: true, land: 'rent a GPU pod' },
  ]
}

export { GIB, LIGHTNING_REPO, MAC_16, MAC_32_LOW, MAC_48, QWEN_27B_REPO, QWEN_2B_REPO, QWEN_9B_REPO, RTX_4090 }
