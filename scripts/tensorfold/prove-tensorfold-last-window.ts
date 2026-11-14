#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { withProofAccountHome } from '../lib/proofAccountHome.ts'
import { KEY, pinScratchHome, releaseScratchHome } from '../lib/settingsPopupHarness.ts'
import { CARD_COLUMNS, CARD_ROWS, freePort, openPanelCard, type PanelCard } from './fixtures/panelCard.ts'
import { FAKE_BIN, GIB, MAC_48, QWEN_2B_REPO, WIN_16, fakeWorld } from './fixtures/world.ts'

withProofAccountHome('tensorfold-last-window-')
const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const FRAMES = argAfter('--frames')
if (FRAMES !== undefined) mkdirSync(FRAMES, { recursive: true })
const home = pinScratchHome('tensorfold-last-window')
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_LOCAL_API_KEY
delete process.env.MERCURY_LOCAL_BASE_URL

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const hosts = await import('../../src/services/providers/local/tensorfoldHosts.ts')
const inventory = await import('../../src/services/tensorfold/inventory.ts')
const serve = await import('../../src/services/tensorfold/serve.ts')
const engine = await import('../../src/services/tensorfold/engine.ts')
const fit = await import('../../src/services/tensorfold/fit.ts')
const starting = await import('../../src/services/tensorfold/starting.ts')
const models = await import('../../src/services/tensorfold/adapter/models.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 900)}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title)
}
const save = (name: string, p: PanelCard): void => {
  if (FRAMES === undefined) return
  writeFileSync(join(FRAMES, `${name}-${CARD_COLUMNS}x${CARD_ROWS}.txt`), p.lines().map(line => line.replace(/\s+$/, '')).join('\n') + '\n')
}
const STORE = join(home, 'local-setup', 'tensorfold-hosts.json')
const storeText = (): string => (existsSync(STORE) ? readFileSync(STORE, 'utf8') : '')
const remembered = (repo: string): number | undefined => (hosts as { rememberedTensorFoldWindow?: (repo: string) => number | undefined }).rememberedTensorFoldWindow?.(repo)
const QWEN_4B_REPO = models.QWEN_4B_GGUF.repo
const serving = (name: string) => (_card: unknown, lines: readonly string[]): boolean => lines.some(line => line.includes(`serving ${name} on 127.0.0.1:`))

section('1 · a home that never served a model: the store is the one written today, and it names no window')
{
  check('nothing is stored before anything is served', !existsSync(STORE), storeText())
  hosts.rememberTensorFoldPort(8123)
  check('a remembered port writes version, hosts and ports and nothing else', storeText() === '{\n  "version": 1,\n  "hosts": [],\n  "ports": [\n    8123\n  ]\n}\n', storeText())
  hosts.forgetTensorFoldPort(8123)
  check('and forgetting it leaves the three keys', storeText() === '{\n  "version": 1,\n  "hosts": [],\n  "ports": []\n}\n', storeText())
  check('no model has a window to come back to', remembered(QWEN_4B_REPO) === undefined && remembered(QWEN_2B_REPO) === undefined)
}

section('2 · the run the Windows machine made (Mercury\'s engine, 16 GB, the 4B): refused at 128k, served at 32k, stopped, served again')
{
  const p = await openPanelCard({ road: 'adapter', label: 'Qwen3.5 4B', prefix: 'tf-last-window-adapter', free: () => 7.4 * GIB })
  const before = p.card()
  check('never served, the 4B stands at 128k, the largest window that fits', before.row === 'Qwen3.5 4B local/qwen3.5-4b on disk 128k ctx 9.6 GiB' && before.strip.includes('[128k]'), before.all)
  await p.press(KEY.enter)
  await p.until(card => card.refused !== undefined, 10_000)
  const refused = p.card()
  check('↵ at 128k is refused for memory', refused.row === 'Qwen3.5 4B local/qwen3.5-4b refused 128k ctx 9.6 GiB' && refused.refused !== undefined && refused.refused.startsWith('refused 9.6 GiB needed · 7.4 GiB free on this machine'), refused.all)
  check('a refused start remembers nothing', remembered(QWEN_4B_REPO) === undefined, storeText())
  await p.press(KEY.left, 2)
  await p.press(KEY.enter)
  const up = await p.until(serving('qwen3.5-4b'), 40_000)
  const served = p.card()
  save('adapter-served-at-32k', p)
  check('← ← to 32k and ↵: it is served at 32k', up && served.row.startsWith('Qwen3.5 4B local/qwen3.5-4b current 32k ctx ') && serve.servedTensorFold({ servedFile: p.servedFile })[0]?.window === 32_768, served.all)
  check('the store now holds the window beside the ports, under the model\'s id in lower case', remembered(QWEN_4B_REPO) === 32_768 && remembered(QWEN_4B_REPO.toUpperCase()) === 32_768 && storeText().includes('"windows": {\n    "mlx-community/qwen3.5-4b-mlx-4bit": 32768\n  }'), storeText())
  await p.reopen()
  await p.press('s')
  await p.press('s')
  await p.until(card => card.row.includes(' on disk '), 20_000)
  const stopped = p.card()
  save('adapter-stopped', p)
  check('s, s stops it and the row stands at 32k, the window it was last served at: on disk 32k ctx 6.6 GiB', stopped.row === 'Qwen3.5 4B local/qwen3.5-4b on disk 32k ctx 6.6 GiB' && stopped.strip.includes('[32k]') && serve.servedTensorFold({ servedFile: p.servedFile }).length === 0, stopped.all)
  check('what ↵ will run names 32768, where it named 131072', stopped.run.includes('--context 32768') && stopped.legend.includes('↵ serve and switch'), `${stopped.run} | ${stopped.legend}`)
  await p.press(KEY.enter)
  const again = await p.until((card, lines) => serving('qwen3.5-4b')(card, lines) || card.refused !== undefined, 40_000)
  const second = p.card()
  save('adapter-served-again', p)
  check('↵ serves it again at 32k, where it was refused again at 128k', again && second.refused === undefined && second.row.startsWith('Qwen3.5 4B local/qwen3.5-4b current 32k ctx ') && serve.servedTensorFold({ servedFile: p.servedFile })[0]?.window === 32_768, second.all)
  await p.press('s')
  await p.press('s')
  await p.until(card => card.row.includes(' on disk ') || card.refused !== undefined, 20_000)
  await p.reopen()
  const opened = p.card()
  save('adapter-opened-again', p)
  check('stopped once more and the panel opened again: still on disk 32k ctx 6.6 GiB', opened.row === 'Qwen3.5 4B local/qwen3.5-4b on disk 32k ctx 6.6 GiB' && opened.strip.includes('[32k]') && opened.run.includes('--context 32768'), opened.all)
  await p.press(KEY.right)
  const moved = p.card()
  check('→ still moves it: on disk 64k ctx 7.6 GiB', moved.row === 'Qwen3.5 4B local/qwen3.5-4b on disk 64k ctx 7.6 GiB' && moved.run.includes('--context 65536'), moved.all)
  await p.close()
}

const point = starting.startingPointOf(QWEN_2B_REPO)!
const need = (window: number): number => fit.tensorFoldProjectedBytes(point, window)

section('3 · the same on TensorFold\'s own engine (a Mac, the 2B): refused at 256k, served at 32k, stopped')
{
  const p = await openPanelCard({ road: 'tensorfold', label: 'Qwen3.5 2B', prefix: 'tf-last-window', free: () => need(262_144) - 2.2 * GIB })
  await p.press(KEY.enter)
  await p.until(card => card.refused !== undefined, 10_000)
  await p.press(KEY.left, 3)
  await p.press(KEY.enter)
  const up = await p.until(serving('qwen3.5-2b'), 30_000)
  const served = p.card()
  check('refused at 256k, ← ← ← to 32k and ↵: it is served at 32k', up && served.row.startsWith('Qwen3.5 2B local/qwen3.5-2b current 32k ctx ') && serve.servedTensorFold({ servedFile: p.servedFile })[0]?.window === 32_768, served.all)
  await p.reopen()
  await p.press('s')
  await p.press('s')
  await p.until(card => card.row.includes(' on disk '), 20_000)
  const stopped = p.card()
  save('stopped', p)
  check('s, s: the row stands on disk 32k ctx 5.0 GiB and ↵ will run 32768, where it went back to 256k and 7.6 GiB', stopped.row === 'Qwen3.5 2B local/qwen3.5-2b on disk 32k ctx 5.0 GiB' && stopped.strip.includes('[32k]') && stopped.run.includes('--context 32768'), stopped.all)
  check('each model keeps its own window in the store', remembered(QWEN_2B_REPO) === 32_768 && remembered(QWEN_4B_REPO) === 32_768 && storeText().includes('"mlx-community/qwen3.5-2b-mlx-4bit": 32768') && storeText().includes('"mlx-community/qwen3.5-4b-mlx-4bit": 32768'), storeText())
  await p.close()
}

section('4 · the rule row by row: a remembered window is taken when it is a rung of the ladder and the model is not serving')
{
  const world = fakeWorld('tf-last-window-rows')
  const rowOf = async (lastWindow: number | undefined, served: readonly { repo: string; name: string; port: number; window: number; pid: number; startedAt: string }[] = []) =>
    (await inventory.readTensorFoldInventory(null, { cacheRoot: world.cache, machine: MAC_48, served, env: world.env, home: world.home, lastWindow: (repo: string) => (repo === QWEN_2B_REPO ? lastWindow : undefined) } as never)).find(row => row.repo === QWEN_2B_REPO)!
  const never = await rowOf(undefined)
  check('a model never served stands at the largest window that fits, as it did', never.window === 262_144 && never.window === fit.chosenTensorFoldWindow(fit.tensorFoldLadder(point, MAC_48)), String(never.window))
  const rung = await rowOf(65_536)
  check('a remembered rung is the row\'s window, with that window\'s memory', rung.window === 65_536 && Math.abs(rung.fit.neededGib - need(65_536) / GIB) < 0.01 && rung.fit.neededGib < never.fit.neededGib, JSON.stringify({ window: rung.window, neededGib: rung.fit.neededGib, need: need(65_536) / GIB }))
  const noRung = await rowOf(100_000)
  check('a remembered number that is no rung of this ladder is not taken', noRung.window === 262_144, String(noRung.window))
  const live = await rowOf(32_768, [{ repo: QWEN_2B_REPO, name: 'qwen3.5-2b', port: 8080, window: 131_072, pid: 1, startedAt: '' }])
  check('a serving model reads the window it is served at, whatever is remembered', live.window === 131_072, String(live.window))
  const found = await engine.findTensorFoldEngine({ env: world.env, home: world.home, platform: 'darwin', exists: () => false, adapter: engine.adapterEntry(), machine: WIN_16 } as never)
  const adapterRow = async (lastWindow: number | undefined) => (await inventory.readTensorFoldInventory(found, { cacheRoot: world.cache, machine: WIN_16, served: [], env: world.env, home: world.home, lastWindow: (repo: string) => (repo === QWEN_4B_REPO ? lastWindow : undefined) } as never)).find(row => row.repo === QWEN_4B_REPO)!
  check('the same on Mercury\'s engine: the 4B never served at 128k, remembered at 32k', (await adapterRow(undefined)).window === 131_072 && (await adapterRow(32_768)).window === 32_768, `${(await adapterRow(undefined)).window} ${(await adapterRow(32_768)).window}`)
  writeFileSync(STORE, JSON.stringify({ version: 1, hosts: [], ports: [], windows: { 'a/b': 'large', 'c/d': 0, 'e/f': -4096, 'g/h': 65536 } }))
  check('a stored window that is no whole positive number is not read', remembered('a/b') === undefined && remembered('c/d') === undefined && remembered('e/f') === undefined && remembered('g/h') === 65_536)
  rmSync(world.root, { recursive: true, force: true })
}

section('5 · what is remembered: the window of a session\'s start that came up, and nothing else')
{
  const world = fakeWorld('tf-last-window-starts')
  const servedFile = join(world.home, 'served.json')
  const calls: Array<[string, number]> = []
  const binary = `${FAKE_BIN}/tensorfold`
  const io = (free: number, serviceEnv: Record<string, string> = {}) => ({ binary, cwd: world.cwd, sessionId: 'proof', env: world.env, serviceEnv: { ...world.serviceEnv, ...serviceEnv }, servedFile, machine: MAC_48, app: async () => ({ running: false }), freeMemoryBytes: async () => free, rememberPort: () => undefined, forgetPort: () => undefined, rememberWindow: (repo: string, window: number) => void calls.push([repo, window]) }) as never
  const tight = await serve.startTensorFold({ repo: QWEN_2B_REPO, window: 262_144, port: await freePort() }, io(need(262_144) - 2.2 * GIB)).then(() => 'served', (error: unknown) => (error instanceof serve.TensorFoldStartError && error.tight !== null ? 'tight' : String(error)))
  check('a start refused for memory remembers nothing', tight === 'tight' && calls.length === 0, `${tight} ${JSON.stringify(calls)}`)
  const refusedByEngine = await serve.startTensorFold({ repo: QWEN_2B_REPO, window: 262_144, port: await freePort() }, io(40 * GIB, { FAKE_TENSORFOLD_SERVE: 'refuse-memory' })).then(() => 'served', (error: unknown) => (error instanceof serve.TensorFoldStartError && error.refusal !== null ? 'refused' : String(error)))
  check('a start the engine refuses remembers nothing', refusedByEngine === 'refused' && calls.length === 0, `${refusedByEngine} ${JSON.stringify(calls)}`)
  const session = await serve.startTensorFold({ repo: QWEN_2B_REPO, window: 65_536, port: await freePort() }, io(40 * GIB))
  check('a session\'s start that comes up remembers its model and its window, once', session.window === 65_536 && JSON.stringify(calls) === JSON.stringify([[QWEN_2B_REPO, 65_536]]), JSON.stringify(calls))
  const afterSession = calls.length
  const helper = await serve.startTensorFold({ repo: QWEN_2B_REPO, window: 32_768, name: 'qwen3.5-2b', port: await freePort(), promptCacheGib: 1, role: 'helper' }, io(40 * GIB))
  check('the helper\'s start remembers nothing: its window is not the one a person chose', helper.window === 32_768 && calls.length === afterSession, JSON.stringify(calls))
  await serve.stopTensorFold('qwen3.5-2b', { servedFile, role: 'helper', forgetPort: () => undefined })
  await serve.stopTensorFold('qwen3.5-2b', { servedFile, forgetPort: () => undefined })
  check('a stop remembers nothing more', calls.length === afterSession && serve.servedTensorFold({ servedFile }).length === 0, JSON.stringify(calls))
  rmSync(world.root, { recursive: true, force: true })
}

await releaseScratchHome(home)
console.log(`\nprove-tensorfold-last-window: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
