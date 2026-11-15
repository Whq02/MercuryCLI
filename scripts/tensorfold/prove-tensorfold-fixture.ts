#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withProofAccountHome } from '../lib/proofAccountHome.ts'
import { KEY, pinScratchHome, releaseScratchHome } from '../lib/settingsPopupHarness.ts'
import * as panelFixture from './fixtures/panelCard.ts'
import * as worldFixture from './fixtures/world.ts'

withProofAccountHome('tensorfold-fixture-')
const home = pinScratchHome('tensorfold-fixture')
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_LOCAL_API_KEY
delete process.env.MERCURY_LOCAL_BASE_URL

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const inventory = await import('../../src/services/tensorfold/inventory.ts')
const engine = await import('../../src/services/tensorfold/engine.ts')
const install = await import('../../src/services/tensorfold/install.ts')
const identity = await import('../../src/services/tensorfold/adapter/identity.ts')
const road = await import('../../src/commands/tensorfold/road.ts')
const receipts = await import('../../src/utils/model/seatReceipts.ts')

type Panel = Awaited<ReturnType<typeof panelFixture.openPanelCard>>
const fixtures = worldFixture as unknown as Record<string, unknown>
const panels = panelFixture as unknown as Record<string, unknown>
const { GIB, QWEN_2B_CONFIG, QWEN_2B_PIN, QWEN_2B_REPO } = worldFixture
const SCRATCH = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'tf-fixture-proof-'))

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 900)}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title)
}
const refusing = (code: string) => (): never => {
  throw Object.assign(new Error(`${code}: operation not permitted`), { code })
}
const filesUnder = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => (entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)]))

section('1 · the weights of a seeded checkpoint: a symbolic link, a hard link where that is refused, a copy where both are')
{
  const seeds = [{ repo: QWEN_2B_REPO, config: QWEN_2B_CONFIG, weightsBytes: 4096, sha: QWEN_2B_PIN }]
  const seeded = (name: string, io?: Record<string, unknown>): { root: string; blob: string; file: string; error?: string } => {
    const root = join(SCRATCH, name)
    mkdirSync(root, { recursive: true })
    const base = join(root, `models--${QWEN_2B_REPO.replace('/', '--')}`)
    const made = { root, blob: join(base, 'blobs', 'weightsblob'), file: join(base, 'snapshots', QWEN_2B_PIN, 'model.safetensors') }
    try {
      ;(worldFixture.seedHfCache as unknown as (root: string, seeds: unknown, io?: unknown) => void)(root, seeds, io)
      return made
    } catch (error) {
      return { ...made, error: error instanceof Error ? error.message : String(error) }
    }
  }
  const linked = seeded('linked')
  const linkedSeen = linked.error === undefined ? lstatSync(linked.file) : undefined
  check('a seed made as this host allows holds its weights: the symbolic link it held, or a hard link where this account may make none', linkedSeen !== undefined && statSync(linked.file).size === 4096 && (linkedSeen.isSymbolicLink() || linkedSeen.ino === statSync(linked.blob).ino), linked.error ?? '')
  const hard = seeded('hard', { symlink: refusing('EPERM') })
  const hardSeen = hard.error === undefined && existsSync(hard.file) ? lstatSync(hard.file) : undefined
  check('[CHECKPOINT 104] where the symbolic link is refused (EPERM, as on the Windows box) the weights are a hard link to the blob', hardSeen !== undefined && !hardSeen.isSymbolicLink() && hardSeen.isFile() && hardSeen.ino === statSync(hard.blob).ino && statSync(hard.blob).nlink === 2, hard.error ?? (hardSeen === undefined ? 'no file' : `symlink ${hardSeen.isSymbolicLink()} links ${statSync(hard.blob).nlink}`))
  const copied = seeded('copied', { symlink: refusing('EPERM'), link: refusing('EPERM') })
  const copySeen = copied.error === undefined && existsSync(copied.file) ? lstatSync(copied.file) : undefined
  check('where the hard link is refused too they are a copy of the blob', copySeen !== undefined && !copySeen.isSymbolicLink() && copySeen.isFile() && copySeen.ino !== statSync(copied.blob).ino && copySeen.size === 4096 && statSync(copied.blob).nlink === 1, copied.error ?? (copySeen === undefined ? 'no file' : `symlink ${copySeen.isSymbolicLink()} size ${copySeen.size}`))
  const read = [linked, hard, copied].map(made => inventory.readHfSnapshot(made.root, QWEN_2B_REPO))
  check('the product reads the three caches alike: the checkpoint, its weights of 4,096 bytes, nothing half fetched', hardSeen !== undefined && !hardSeen.isSymbolicLink() && copySeen !== undefined && !copySeen.isSymbolicLink() && read.every(snapshot => snapshot !== undefined && snapshot.weightsBytes === 4096 && snapshot.incompleteBytes === 0 && snapshot.config.model_type === 'qwen3_5'), JSON.stringify(read.map(snapshot => snapshot?.weightsBytes)))
  const twice = seeded('linked')
  check('weights already standing where a seed would put its own are still an error, never a second file laid over them (holds on the parent too)', twice.error !== undefined && twice.error.includes('EEXIST'), String(twice.error))
}

section('2 · the road the panel fixture gives its panel cannot fetch: no install runs, a download can reach only a closed address, no key goes to a card that offers either')
{
  const open = panelFixture.openPanelCard as unknown as (opts: Record<string, unknown>) => Promise<Panel & { offer?: string; road?: Record<string, unknown> }>
  const p = await open({ road: 'adapter', label: 'Qwen3.5 4B', prefix: 'tf-fixture-missing', free: () => 40 * GIB, engine: 'missing' })
  try {
    check('[CHECKPOINT 104] a world whose stand-in engine is not taken as installed: the fixture says, before any key, what the card offers', typeof p.offer === 'string' && p.offer.includes(`mercury ${identity.ADAPTER_FLAG} install`) && p.offer.includes('llama.cpp not installed'), String(p.offer))
    const pressed = p.offer === undefined ? 'not tried: this fixture names no offer, and a key here could start an install' : await p.press(KEY.enter).then(() => 'sent', error => (error instanceof Error ? error.message : String(error)))
    check('the fixture sends no key to that card: ↵ is refused with the offer in its words', pressed.startsWith('the fixture sends no key to a card that offers an install or a download: ') && Object.keys(road.tensorFoldRoadState().acts).length === 0, `${pressed} ${JSON.stringify(road.tensorFoldRoadState().acts)}`)
    const said: string[] = []
    const stop = receipts.subscribeSeatReceipts(receipt => {
      said.push(receipt.text)
    })
    const plan = install.llamaCppInstallPlan({ binary: engine.adapterEntry() }, 'win32', { home: p.world.home })
    const installed = typeof p.road?.install === 'function' ? await road.installTensorFoldThen(plan, p.road as never) : 'not tried: this fixture gives its road no install of its own, and the product\'s would run'
    stop()
    check('the road\'s own install, reached all the same, starts nothing and says so', installed === false && said.some(text => text === `▲ llama.cpp did not install · ${String(panels.PROOF_INSTALLS_NOTHING)} · /tensorfold tries again`), `${String(installed)} ${JSON.stringify(said)}`)
    const pull = p.road?.pull as { binary?: string; env?: NodeJS.ProcessEnv; cacheRoot?: string; home?: string } | undefined
    check('a download from that road would run the world\'s own engine on the world\'s cache, under an environment whose hub is the closed address', pull !== undefined && pull.binary === engine.adapterEntry() && pull.cacheRoot === p.world.cache && pull.home === p.world.home && pull.env?.HF_ENDPOINT === String(fixtures.CLOSED_ADDRESS) && pull.env?.HF_HUB_CACHE === p.world.cache, JSON.stringify({ binary: pull?.binary, cache: pull?.cacheRoot, hub: pull?.env?.HF_ENDPOINT }))
    const sealedEnv = fixtures.SEALED_ENV as Record<string, string> | undefined
    const emptyCache = join(SCRATCH, 'empty-cache')
    mkdirSync(emptyCache, { recursive: true })
    const began = Date.now()
    const pulled = sealedEnv === undefined ? undefined : spawnSync(process.execPath, [engine.adapterEntry(), identity.ADAPTER_FLAG, 'pull', 'mlx-community/Qwen3.5-2B-MLX-4bit'], { encoding: 'utf8', env: { ...p.world.env, HOME: p.world.home, HF_HUB_CACHE: emptyCache }, timeout: 60_000 })
    check('the adapter\'s own pull under the world\'s environment asks the closed address, is refused there and leaves no checkpoint', pulled !== undefined && pulled.status === 1 && `${pulled.stdout}${pulled.stderr}`.includes('from Hugging Face') && /did not answer|Unable to connect|ECONNREFUSED|ConnectionRefused/.test(`${pulled.stderr}`) && filesUnder(emptyCache).every(file => statSync(file).size === 0) && Date.now() - began < 45_000, pulled === undefined ? 'this fixture seals no environment: not tried, the pull would ask Hugging Face itself' : `exit ${pulled.status} after ${Date.now() - began} ms: ${`${pulled.stdout}${pulled.stderr}`.trim().slice(-300)}`)
    const answering = (host: string): Promise<{ port: number; close(): Promise<void> }> =>
      new Promise(listening => {
        const listener = createServer((_request, response) => {
          response.writeHead(200, { 'content-type': 'text/plain' })
          response.end('answered')
        })
        listener.listen(0, host, () => {
          const address = listener.address()
          listening({ port: typeof address === 'object' && address !== null ? address.port : 0, close: () => new Promise<void>(closed => listener.close(() => closed())) })
        })
      })
    const named = await answering('localhost')
    const numbered = await answering('127.0.0.1')
    const ask = (url: string, env: NodeJS.ProcessEnv): Promise<string> =>
      new Promise(answered => {
        const asking = spawn(process.execPath, ['-e', `fetch(${JSON.stringify(url)}, { signal: AbortSignal.timeout(8000) }).then(reply => reply.text()).then(text => console.log(text), error => console.log('refused ' + (error.code ?? error.name)))`], { env, stdio: ['ignore', 'pipe', 'ignore'] })
        let said = ''
        asking.stdout.on('data', chunk => {
          said += String(chunk)
        })
        asking.once('exit', () => answered(said.trim()))
      })
    const unsealed = sealedEnv === undefined ? { ...p.world.env } : Object.fromEntries(Object.entries(p.world.env).filter(([key]) => !(key in sealedEnv)))
    const byName = await ask(`http://localhost:${named.port}/`, p.world.env)
    const byNameUnsealed = await ask(`http://localhost:${named.port}/`, unsealed)
    check('a child given the world\'s environment that asks for a NAME is sent to the closed address and refused there, where the same child without the seal is answered', sealedEnv !== undefined && byName.startsWith('refused') && byNameUnsealed === 'answered', `sealed: ${byName} · unsealed: ${byNameUnsealed}`)
    const byAddress = await ask(`http://127.0.0.1:${numbered.port}/`, p.world.env)
    check('the loopback address itself stays direct under the seal (the adapter reaches its own llama-server by it; holds on the parent too)', byAddress === 'answered', byAddress)
    await named.close()
    await numbered.close()
  } finally {
    await p.close()
  }
  const q = await open({ road: 'tensorfold', label: 'Qwen3.5 2B', prefix: 'tf-fixture-missing-mac', free: () => 40 * GIB, engine: 'missing' })
  try {
    const pressed = q.offer === undefined ? 'not tried' : await q.press(KEY.enter).then(() => 'sent', error => (error instanceof Error ? error.message : String(error)))
    check('the same on TensorFold\'s own road with no engine: the offer is named (Homebrew, not found) and no key is sent', typeof q.offer === 'string' && q.offer.includes('Homebrew') && pressed.startsWith('the fixture sends no key'), `${String(q.offer)} · ${pressed}`)
  } finally {
    await q.close()
  }
  const r = await open({ road: 'adapter', label: 'Qwen3.5 4B', prefix: 'tf-fixture-present', free: () => 40 * GIB })
  try {
    check('a world whose stand-in engine is taken as installed names no offer, and its card runs the serve alone (holds on the parent too, where no offer is ever named)', r.offer === undefined && r.card().run.startsWith(`will run mercury ${identity.ADAPTER_FLAG} serve `) && r.card().legend.includes('↵ serve and switch'), `${String(r.offer)} · ${r.card().run} · ${r.card().legend}`)
  } finally {
    await r.close()
  }
}

rmSync(SCRATCH, { recursive: true, force: true })
await releaseScratchHome(home)
console.log(`\n${checks - failures} of ${checks} checks hold`)
console.log(`prove-tensorfold-fixture: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
