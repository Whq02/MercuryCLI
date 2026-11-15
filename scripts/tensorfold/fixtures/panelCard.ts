import { rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { delimiter, join } from 'node:path'
import { KEY, mountOffscreen, settle, waitFor, type Mounted } from '../../lib/settingsPopupHarness.ts'
import { ADAPTER_ENTRY, FIXTURES, MAC_48, SEALED_ENV, WIN_16, fakeWorld, placeStandIn, type FakeWorld, type StandIn } from './world.ts'

export const CARD_COLUMNS = 120
export const CARD_ROWS = 40

export type Card = { row: string; refused: string | undefined; strip: string; run: string; legend: string; all: string }
export type PanelRoad = 'tensorfold' | 'adapter'
export const PROOF_INSTALLS_NOTHING = 'a proof installs nothing: its engine is the fixture\'s stand-in'
export type PanelCard = {
  world: FakeWorld
  servedFile: string
  port: number
  offer: string | undefined
  road: Record<string, unknown>
  lines(): string[]
  card(): Card
  press(key: string, times?: number): Promise<void>
  until(pred: (card: Card, lines: readonly string[]) => boolean, ms?: number): Promise<boolean>
  reopen(): Promise<void>
  close(): Promise<void>
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => resolve(typeof address === 'object' && address !== null ? address.port : 0))
    })
  })
}

const bare = (line: string): string => line.replace(/[│╭╮╰╯─]/g, ' ').replace(/\s+/g, ' ').trim()
const NEXT_ROW = /^(?:.* local\/\S+ .*|other checkpoint.*|[▸▾].*)$/

export function cardOf(lines: readonly string[], label: string): Card {
  const words = lines.map(bare).filter(line => line !== '')
  const at = words.findIndex(line => line.startsWith(`${label} `))
  const rest = at < 0 ? [] : words.slice(at + 1)
  const end = rest.findIndex(line => NEXT_ROW.test(line))
  const body = at < 0 ? [] : [words[at]!, ...(end < 0 ? rest.slice(0, 10) : rest.slice(0, end))]
  const run = body.findIndex(line => line.startsWith('will run '))
  return {
    row: words[at] ?? '',
    refused: body.find(line => line.startsWith('refused ')),
    strip: body.find(line => line.startsWith('window ')) ?? '',
    run: run < 0 ? '' : `${body[run]} ${body[run + 1] ?? ''}`,
    legend: words.find(line => line.startsWith('↑↓ select')) ?? '',
    all: body.join(' | '),
  }
}

export function fetchOffered(card: Pick<Card, 'legend' | 'all'>): string | undefined {
  if (/↵ (?:install|pull)/.test(card.legend)) return card.legend
  return card.all.split(' | ').find(line => /^will run .*\b(?:install|pull)\b/.test(line))
}

export async function openPanelCard(opts: { road: PanelRoad; label: string; prefix: string; free: () => number; serviceEnv?: Record<string, string>; standIn?: StandIn; engine?: 'missing' }): Promise<PanelCard> {
  const React = await import('react')
  const h = React.createElement
  const { Box } = await import('../../../src/ink.ts')
  const { AppStateProvider } = await import('../../../src/state/AppState.tsx')
  const { ThemeProvider } = await import('../../../src/components/design-system/ThemeProvider.tsx')
  const panel = await import('../../../src/commands/tensorfold/tensorfold.tsx')
  const road = await import('../../../src/commands/tensorfold/road.ts')
  const scene = await import('../../../src/commands/tensorfold/scene.ts')
  const engine = await import('../../../src/services/tensorfold/engine.ts')
  const serve = await import('../../../src/services/tensorfold/serve.ts')
  const adapter = opts.road === 'adapter'
  const machine = adapter ? WIN_16 : MAC_48
  engine.__pinTensorFoldMachineForTest(machine)
  const missing = opts.engine === 'missing'
  let world: FakeWorld
  let binary: string
  let found: unknown
  if (adapter) {
    const models = await import('../../../src/services/tensorfold/adapter/models.ts')
    const llama = await import('../../../src/services/tensorfold/adapter/llama.ts')
    const script = join(FIXTURES, 'fake-llama-server.ts')
    world = fakeWorld(opts.prefix, { seeds: [], ggufSeeds: [models.QWEN_4B_GGUF.gguf, models.QWEN_2B_GGUF.gguf], env: { FAKE_LLAMA_SCRIPT: script, FAKE_TENSORFOLD_BUN: process.execPath, ...SEALED_ENV }, ...(opts.standIn !== undefined ? { standIn: opts.standIn } : {}) })
    if (missing) {
      world.env.PATH = ['/usr/bin', '/bin'].join(delimiter)
      world.serviceEnv.PATH = world.env.PATH
    } else {
      placeStandIn('llama-server', llama.llamaRuntimeBin(world.home), world.standIn)
    }
    binary = engine.adapterEntry()
    found = await engine.findTensorFoldEngine({ env: world.env, home: world.home, platform: world.standIn === 'program' ? 'win32' : 'darwin', exists: () => false, adapter: binary, machine } as never)
  } else {
    world = fakeWorld(opts.prefix, { env: { ...SEALED_ENV }, ...(opts.standIn !== undefined ? { standIn: opts.standIn } : {}) })
    binary = world.tensorfold
  }
  const exists = missing ? (): boolean => false : world.exists
  const servedFile = join(world.home, 'served.json')
  const port = await freePort()
  writeFileSync(servedFile, JSON.stringify({ repo: '', name: '', port, window: 0, pid: 0, startedAt: '', project: join(world.root, 'never') }))
  let switched = ''
  const io = {
    facts: {
      cacheRoot: world.cache,
      machine,
      env: world.env,
      home: world.home,
      servedFile,
      localModels: () => [],
      hosts: () => [],
      app: async () => ({ running: false }),
      diskFreeBytes: () => 37_578_240_000,
      ...(adapter ? { platform: 'win32' as const, engine: found, helper: () => undefined } : { platform: 'darwin' as const, exists }),
    },
    road: {
      install: async () => ({ ok: false as const, step: 'install', line: PROOF_INSTALLS_NOTHING }),
      pull: { binary, env: { ...world.env, HOME: world.home }, home: world.home, cacheRoot: world.cache, logDir: join(world.root, 'pulls'), ...(adapter ? {} : { exists }) },
      serve: {
        binary: adapter ? ADAPTER_ENTRY : binary,
        cwd: world.cwd,
        sessionId: 'proof',
        env: { ...world.env, HOME: world.home },
        serviceEnv: { ...world.serviceEnv, HOME: world.home, ...(adapter ? { FAKE_ADAPTER_RAM_BYTES: String(machine.ramBytes) } : {}), ...opts.serviceEnv },
        servedFile,
        machine,
        app: async () => ({ running: false }),
        freeMemoryBytes: async () => opts.free(),
        answersAs: async () => undefined,
        ...(adapter ? {} : { exists }),
      } as never,
      prove: {
        env: { ...world.env, MERCURY_LOCAL_PROBE_TARGETS: 'none' },
        persist: (setting: string) => {
          switched = setting
          return { sentence: ' · saved' }
        },
        setAppState: () => undefined,
        focusedConnector: () => ({ carrier: 'in-process' }) as never,
      },
      supportLine: async () => 'fixture',
      copy: async () => undefined,
    },
    current: () => (switched === '' ? 'claude-opus-5-5' : switched),
  }
  road.__resetTensorFoldRoadForTest()
  const shell = (): unknown => h(AppStateProvider as never, {}, h(ThemeProvider as never, {}, h(Box, { flexDirection: 'column', width: CARD_COLUMNS, height: CARD_ROWS, justifyContent: 'center' }, h(panel.TensorFoldPanel as never, { onDone: () => undefined, io } as never))))
  const plan = (await scene.readTensorFoldPanelFacts(io.facts as never, road.tensorFoldRoadState())).install
  let offer: string | undefined = plan === null ? undefined : `${'commands' in plan ? plan.commands.join(' · ') : plan.words} (${plan.found})`
  let mounted: Mounted = await mountOffscreen(shell(), CARD_COLUMNS, CARD_ROWS)
  const card = (): Card => cardOf(mounted.lines(), opts.label)
  const ready = async (): Promise<void> => {
    if (offer !== undefined) return
    await waitFor(() => mounted.lines().some(line => line.includes('TENSORFOLD')), 10_000)
    await settle(300)
    for (let step = 0; step < 4 && card().strip === ''; step++) {
      mounted.push(KEY.down)
      await settle(200)
    }
    await settle(200)
    offer = fetchOffered(card())
  }
  await ready()
  return {
    world,
    servedFile,
    port,
    get offer() {
      return offer
    },
    road: io.road,
    lines: () => mounted.lines(),
    card,
    press: async (key, times = 1) => {
      for (let n = 0; n < times; n++) {
        const offered = offer ?? (key === KEY.enter ? fetchOffered(card()) : undefined)
        if (offered !== undefined) throw new Error(`the fixture sends no key to a card that offers an install or a download: ${offered}`)
        mounted.push(key)
        await settle(250)
      }
    },
    until: async (pred, ms = 20_000) => {
      const seen = await waitFor(() => pred(card(), mounted.lines()), ms)
      await settle(300)
      return seen
    },
    reopen: async () => {
      mounted.push(KEY.esc)
      await settle(300)
      mounted.unmount()
      await settle(200)
      mounted = await mountOffscreen(shell(), CARD_COLUMNS, CARD_ROWS)
      await ready()
    },
    close: async () => {
      mounted.unmount()
      for (const served of serve.servedTensorFold({ servedFile })) await serve.stopTensorFold(served.name, { servedFile }).catch(() => undefined)
      rmSync(world.root, { recursive: true, force: true })
    },
  }
}
