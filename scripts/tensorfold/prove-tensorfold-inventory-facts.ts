#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FAKE_BIN, GIB, LIGHTNING_REPO, MAC_16, MAC_32_LOW, MAC_48, QWEN_27B_REPO, QWEN_2B_CONFIG, QWEN_2B_PIN, QWEN_2B_REPO, QWEN_9B_REPO, RTX_4090, fakeWorld, type CacheSeed } from './fixtures/world.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

const inventory = await import('../../src/services/tensorfold/inventory.ts')
const engine = await import('../../src/services/tensorfold/engine.ts')
const fit = await import('../../src/services/tensorfold/fit.ts')
const refusal = await import('../../src/services/tensorfold/refusal.ts')
const scene = await import('../../src/commands/tensorfold/scene.ts')
const picker = await import('../../src/commands/tensorfold/pickerFacts.ts')
const { tensorFoldWillRun } = await import('../../src/services/tensorfold/serve.ts')
type Facts = Awaited<ReturnType<typeof scene.readTensorFoldPanelFacts>>
type Engine = NonNullable<Awaited<ReturnType<typeof engine.findTensorFoldEngine>>>

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title)
}
const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const OUT = argAfter('--facts')
if (OUT !== undefined) mkdirSync(OUT, { recursive: true })
const record = (id: string, facts: Facts, extra: Record<string, unknown> = {}): void => {
  if (OUT === undefined) return
  const rows = facts.rows.map(row => {
    const window = facts.windows[row.repo] ?? row.window
    const state = picker.stateWords(row, facts.acts[row.repo], window, facts.current === picker.modelIdOf(row))
    return { alias: row.label, id: picker.modelIdOf(row), state: state.text, ctx: `${window / 1024}k ctx`, tail: picker.tailWords(row, window).text, card: picker.standInCard(facts, row).split('\n').slice(1) }
  })
  writeFileSync(join(OUT, `${id}.json`), JSON.stringify({ heading: picker.headingStatusOf(facts), live: facts.live, landing: facts.landing, rows, ...extra }, null, 2) + '\n')
}

const ON_DISK: CacheSeed = { repo: QWEN_2B_REPO, config: QWEN_2B_CONFIG, weightsBytes: 4096, sha: QWEN_2B_PIN }
async function fakeEngine(): Promise<Engine> {
  const world = fakeWorld('tf-facts-engine')
  const found = await engine.findTensorFoldEngine({ env: world.env, home: world.home, platform: 'darwin', exists: path => path.startsWith(FAKE_BIN), machine: MAC_48 } as never)
  if (found === null) throw new Error('the fake engine was not found')
  return found
}
const ENGINE = await fakeEngine()
engine.__pinTensorFoldMachineForTest(MAC_48)
const NO_SERVERS = { localModels: () => [], hosts: () => [] }

section('the inventory from the Hugging Face cache')
{
  const seeds: CacheSeed[] = [
    ON_DISK,
    { repo: 'someone/Unknown-Family-MLX-4bit', config: { model_type: 'mystery', max_position_embeddings: 8192 }, weightsBytes: 1024 },
    { repo: 'mlx-community/Gemma-4-12B-it-MLX-4bit', config: { model_type: 'gemma4', max_position_embeddings: 131072, num_hidden_layers: 48, num_key_value_heads: 8, head_dim: 256, layer_types: Array.from({ length: 48 }, (_, i) => (i % 6 === 5 ? 'full_attention' : 'sliding_attention')), quantization: { bits: 4, group_size: 64 } }, weightsBytes: 7 * GIB, refs: false },
    { repo: 'TensorFold/Partial-Pull-MLX-4bit', config: { model_type: 'qwen3_5' }, weightsBytes: 0, incompleteBytes: 2048 },
  ]
  const world = fakeWorld('tf-inventory', { seeds })
  const rows = await inventory.readTensorFoldInventory(ENGINE, { cacheRoot: world.cache, machine: MAC_48, served: [], env: world.env, home: world.home })
  check('the rank: the 27B (best fit) first, Lightning, the 2B on disk, then the other checkpoint on disk', rows.map(row => row.shortName).join(',') === 'qwen3.8-27b,nemotron-lightning,qwen3.5-2b,gemma-4-12b-it', rows.map(row => row.shortName).join(','))
  const q2b = rows.find(row => row.repo === QWEN_2B_REPO)!
  check('the 2B is on disk (its snapshot read through refs/main), pinned facts kept, the bytes on disk measured', q2b.state === 'on-disk' && q2b.bytesOnDisk === 4096 && q2b.downloadBytes === undefined && q2b.window === 262_144 && q2b.fit.verdict === 'fits', JSON.stringify(q2b))
  const q27 = rows.find(row => row.repo === QWEN_27B_REPO)!
  check('the 27B is not pulled: its download is the checkpoint plus the drafter (20 GB), the state cell words ↓ 20 GB', q27.state === 'not-pulled' && q27.downloadBytes === 19_930_634_001 && picker.downloadWords(q27) === '↓ 20 GB' && q27.drafter === 'z-lab/Qwen3.8-27B-DFlash2')
  const gemma = rows.find(row => row.repo === 'mlx-community/Gemma-4-12B-it-MLX-4bit')!
  check('a checkpoint without refs/main is read from its newest snapshot; its family, window and geometry come from config.json (8 full-attention layers of 48)', gemma.state === 'on-disk' && gemma.family === 'gemma4' && gemma.checkpoint.trainedMax === 131_072 && gemma.checkpoint.kvBytesPerToken === 8 * 8 * 256 * 4 && gemma.quantisation === '4-bit, group 64' && gemma.label === 'Gemma 4 12b It'.replace('12b It', '12B It'), JSON.stringify({ family: gemma.family, max: gemma.checkpoint.trainedMax, kv: gemma.checkpoint.kvBytesPerToken, label: gemma.label }))
  check('a family the engine does not serve is not listed; a partial pull without weights is not listed', !rows.some(row => row.repo === 'someone/Unknown-Family-MLX-4bit') && !rows.some(row => row.repo === 'TensorFold/Partial-Pull-MLX-4bit'))
  check('bestTensorFoldFit: the first in rank that reaches 64k', inventory.bestTensorFoldFit(rows)?.repo === QWEN_27B_REPO)
  const small = await inventory.readTensorFoldInventory(ENGINE, { cacheRoot: world.cache, machine: MAC_16, served: [], env: world.env, home: world.home })
  check('on a 16 GiB Mac the 2B is the best fit and lands first; the 27B and Lightning do not fit at 32k', small[0]?.repo === QWEN_2B_REPO && small.find(row => row.repo === QWEN_27B_REPO)?.fit.verdict === 'too-big' && small.find(row => row.repo === LIGHTNING_REPO)?.fit.verdict !== 'fits' && small.find(row => row.repo === QWEN_27B_REPO)?.window === 32_768, JSON.stringify(small.map(row => [row.shortName, row.window, row.fit.verdict])))
  const cuda = await inventory.readTensorFoldInventory(ENGINE, { cacheRoot: world.cache, machine: RTX_4090, served: [], env: world.env, home: world.home })
  check('on an RTX 4090 Lightning is the best fit (256k), the 27B fits 32k only', cuda[0]?.repo === LIGHTNING_REPO && cuda[0].window === 262_144 && cuda.find(row => row.repo === QWEN_27B_REPO)?.window === 32_768)
  const none = await inventory.readTensorFoldInventory(null, { cacheRoot: world.cache, machine: MAC_48, served: [], env: world.env, home: world.home })
  check('with no engine installed the pinned starting points are still sized for this machine (the first-run row and m05)', none.length >= 3 && none[0]?.repo === QWEN_27B_REPO && none[0].window === 131_072 && none.every(row => row.fit.estimate))
  check('hfCacheRoot honours HF_HUB_CACHE, then HF_HOME/hub, then ~/.cache/huggingface/hub', inventory.hfCacheRoot({ HF_HUB_CACHE: '/a' }, '/h') === '/a' && inventory.hfCacheRoot({ HF_HOME: '/b' }, '/h') === '/b/hub' && inventory.hfCacheRoot({}, '/h') === '/h/.cache/huggingface/hub' && inventory.hfCacheWords('/h/.cache/huggingface/hub', '/h') === '~/.cache/huggingface/hub')
}

section('t-states as facts: the heading, the live line, the landing, the row cells and the card lines')
async function factsFor(id: string, opts: { seeds?: CacheSeed[]; machine?: typeof MAC_48; engine?: Engine | null; platform?: NodeJS.Platform; state?: Parameters<typeof scene.readTensorFoldPanelFacts>[1]; served?: Facts['served']; outside?: Array<{ id: string; baseUrl: string; window?: number }>; current?: string; brew?: boolean; diskFree?: number }): Promise<Facts> {
  const world = fakeWorld(`tf-${id}`, { seeds: opts.seeds ?? [ON_DISK] })
  const machine = opts.machine ?? MAC_48
  return scene.readTensorFoldPanelFacts(
    {
      cacheRoot: world.cache,
      machine,
      engine: opts.engine === undefined ? ENGINE : opts.engine,
      env: world.env,
      home: world.home,
      platform: opts.platform ?? machine.platform,
      servedFile: join(world.home, 'served.json'),
      served: opts.served ?? [],
      localModels: () => (opts.outside ?? []).map(server => ({ id: server.id, server: 'tensorfold' as const, baseUrl: server.baseUrl, ...(server.window !== undefined ? { contextWindow: { tokens: server.window, source: 'served' as const } } : {}) })) as never,
      hosts: () => [],
      ...(opts.current !== undefined ? { current: opts.current } : {}),
      exists: (path: string) => (opts.brew === false ? false : path === '/opt/homebrew/bin/brew'),
      diskFreeBytes: () => opts.diskFree ?? 37_578_240_000,
    },
    opts.state ?? { acts: {}, windows: {} },
  )
}
const cardOf = (facts: Facts, repo: string): string[] => picker.standInCard(facts, facts.rows.find(row => row.repo === repo)!).split('\n')
{
  const t01 = await factsFor('t01', { engine: null })
  record('t01-not-installed-macos', t01)
  check('t01 not installed: heading not installed · Apple M5 Pro · 36.0 GiB usable; the live line names where brew was found; the install road is brew; the best fit lands', picker.headingStatusOf(t01) === 'not installed · Apple M5 Pro · 36.0 GiB usable' && t01.live === 'not installed · Homebrew found at /opt/homebrew/bin/brew' && t01.install?.kind === 'brew' && t01.landing === QWEN_27B_REPO, `${picker.headingStatusOf(t01)} | ${t01.live} | ${t01.landing}`)
  const will = picker.standInRows(t01).models.find(model => model.id === 'local/qwen3.8-27b')!.tag
  check("t01: the landed row's card runs the serve after the pulls (the install row alone carries brew install)", will.includes(`tensorfold pull ${QWEN_27B_REPO}`) && will.includes('tensorfold pull z-lab/Qwen3.8-27B-DFlash2') && will.includes(`tensorfold serve ${QWEN_27B_REPO} --drafter z-lab/Qwen3.8-27B-DFlash2 --name qwen3.8-27b --context 131072 --port 8080`) && picker.standInRows(t01).models.find(model => model.id === 'tensorfold:install')!.tag.includes('brew install ashhart/tensorfold/tensorfold'), will)
  const t02 = await factsFor('t02', { engine: null, state: { acts: { install: { kind: 'installing', line: '==> Downloading https://github.com/ashhart/TensorFold/releases/download/v1.2.2/tensorfold-1.2.2-macos-arm64.tar.gz' } }, windows: {} } })
  record('t02-installing-macos', t02)
  check('t02 installing: the live line says installing TensorFold 1.2.2 with Homebrew; the install act carries the brew line', t02.live === 'installing TensorFold 1.2.2 with Homebrew' && t02.acts.install?.kind === 'installing' && picker.pickerFactsOf(t02).install?.state === 'installing' && picker.pickerFactsOf(t02).install?.progress?.startsWith('==> Downloading') === true, t02.live)
  const t03 = await factsFor('t03', { engine: null, brew: false })
  record('t03-no-homebrew-macos', t03)
  check('t03 no Homebrew: the install row is unavailable, needs Homebrew · brew.sh installs it, then /tensorfold again; the live line says Homebrew not found; the same starting rows', t03.install?.kind === 'needs-brew' && t03.install.needs === 'Homebrew · brew.sh installs it, then /tensorfold again' && t03.live === 'not installed · Homebrew not found' && t03.landing === 'install' && t03.rows.length === 3 && picker.pickerFactsOf(t03).install?.state === 'unavailable', t03.live)
  const t04 = await factsFor('t04', { engine: null, machine: RTX_4090, seeds: [] })
  record('t04-not-installed-linux', t04)
  check('t04 Linux RTX 4090: heading not installed · the card · 23.0 GiB usable; the archive road with its six commands; Lightning lands at 256k, the 27B at 32k; the live line names the driver', picker.headingStatusOf(t04) === 'not installed · NVIDIA GeForce RTX 4090 · 23.0 GiB usable' && t04.install?.kind === 'archive' && t04.install.commands.length === 6 && t04.live === 'not installed · NVIDIA driver 580.95 (CUDA 13)' && t04.rows[0]?.repo === LIGHTNING_REPO && t04.rows[0].window === 262_144 && t04.rows.find(row => row.repo === QWEN_27B_REPO)?.window === 32_768 && t04.landing === 'install', `${picker.headingStatusOf(t04)} | ${t04.live}`)
  const t05 = await factsFor('t05', { engine: null, platform: 'win32', machine: { ...MAC_48, platform: 'win32' } })
  record('t05-windows', t05)
  check('t05 Windows: the heading reads no Windows release yet, no rows, no install road, the live line says TensorFold runs on a host, the landing is the rent row', picker.headingStatusOf(t05) === 'no Windows release yet' && t05.rows.length === 0 && t05.install?.kind === 'windows' && t05.live === 'nothing served here · TensorFold runs on a host' && t05.landing === 'rent' && picker.pickerFactsOf(t05).install === undefined, `${picker.headingStatusOf(t05)} | ${t05.live}`)
  const t06 = await factsFor('t06', {})
  record('t06-opened', t06)
  check('t06 installed, nothing served: heading 1.2.2 · Apple M5 Pro · 36.0 GiB usable · nothing served; live nothing served · Metal; the 27B lands at 128k; the 2B on disk', picker.headingStatusOf(t06) === '1.2.2 · Apple M5 Pro · 36.0 GiB usable · nothing served' && t06.live === 'nothing served · Metal' && t06.landing === QWEN_27B_REPO && t06.rows.map(row => `${row.shortName}:${picker.stateWords(row, undefined, row.window, false).text}:${row.window / 1024}k:${picker.tailWords(row, row.window).text}`).join(' | ') === 'qwen3.8-27b:↓ 20 GB:128k:28.5 GiB | nemotron-lightning:↓ 19 GB:256k:20.8 GiB | qwen3.5-2b:on disk:256k:7.6 GiB', t06.rows.map(row => `${row.shortName}:${picker.stateWords(row, undefined, row.window, false).text}:${row.window / 1024}k:${picker.tailWords(row, row.window).text}`).join(' | '))
  const card06 = cardOf(t06, QWEN_27B_REPO)
  check('t06 card: window 32k 64k [128k] 256k · ←→ changes it; memory weights 15 + drafter 3.6 + cache 8 + runtime 2 GiB · prompt cache ≤16 GiB; pull into the cache (~/.cache/huggingface/hub at home; the fixture\'s HF_HUB_CACHE here) · 38 GB free on this disk; will run the pulls then the serve', card06[1] === 'window    32k 64k [128k] 256k · ←→ changes it' && card06[2] === 'memory    weights 15 + drafter 3.6 + cache 8 + runtime 2 GiB · prompt cache ≤16 GiB' && card06[3].startsWith('pull      into ') && card06[3].endsWith('/hub · 38 GB free on this disk') && inventory.hfCacheWords('/h/.cache/huggingface/hub', '/h') === '~/.cache/huggingface/hub' && card06[4] === `will run  tensorfold pull ${QWEN_27B_REPO}` && card06[6] === `          tensorfold serve ${QWEN_27B_REPO} --drafter z-lab/Qwen3.8-27B-DFlash2 --name qwen3.8-27b --context 131072 --port 8080`, card06.join('\n'))
  const t08 = await factsFor('t08', { state: { acts: {}, windows: { [QWEN_27B_REPO]: 262_144 } } })
  record('t08-window-does-not-fit', t08)
  const row08 = t08.rows.find(row => row.repo === QWEN_27B_REPO)!
  check('t08 ←→ past what fits: state does not fit, 256k ctx, 36.5 GiB amber; the strip says 256k needs 36.5 GiB, 36.0 GiB usable · ← 128k fits', picker.stateWords(row08, undefined, 262_144, false).text === 'does not fit' && picker.stateWords(row08, undefined, 262_144, false).tone === 'amber' && picker.tailWords(row08, 262_144).text === '36.5 GiB' && picker.tailWords(row08, 262_144).tone === 'amber' && picker.windowStripWords(undefined, row08, 262_144, 36) === '256k needs 36.5 GiB, 36.0 GiB usable · ← 128k fits', picker.windowStripWords(undefined, row08, 262_144, 36))
  const t09 = await factsFor('t09', {})
  const card09 = cardOf(t09, QWEN_2B_REPO)
  record('t09-on-disk', t09)
  check('t09 the 2B on disk: window 32k 64k 128k [256k] · ←→ changes it; memory weights 1.6 + cache 3 + prompt cache 1 + runtime 2 GiB; no pull line; the serve with --prompt-cache-gib 1', card09[1] === 'window    32k 64k 128k [256k] · ←→ changes it' && card09[2] === 'memory    weights 1.6 + cache 3 + prompt cache 1 + runtime 2 GiB' && card09[3] === `will run  tensorfold serve ${QWEN_2B_REPO} --name qwen3.5-2b --context 262144 --prompt-cache-gib 1 --port 8080`, card09.join('\n'))
  const refusedGguf = { input: 'unsloth/Qwen3.5-9B-GGUF', refused: "GGUF is llama.cpp's format · /localsetup serves it" }
  const t11 = await factsFor('t11', { state: { acts: {}, windows: {}, other: refusedGguf } })
  record('t11-other-refused', t11)
  check("t11 other checkpoint refused: the typed id and GGUF is llama.cpp's format · /localsetup serves it", t11.other?.refused === "GGUF is llama.cpp's format · /localsetup serves it" && picker.standInRows(t11).models.find(model => model.id === 'tensorfold:other')!.tag.includes('refused   GGUF is llama.cpp\'s format · /localsetup serves it'))
  const nine = inventory.rowOfCheckpoint({ repo: QWEN_9B_REPO, label: 'Qwen3.5 9B', shortName: 'qwen3.5-9b', family: 'qwen3_5', weightsBytes: 5_950_221_072, downloadBytes: 5_977_074_591, kvBytesPerToken: 8 * 4 * 256 * 4, trainedMax: 262_144, promptCacheGib: 1, qualified: false }, MAC_48, { onDisk: false, bytesOnDisk: 0, drafterOnDisk: true })
  const t10b = await factsFor('t10b', { state: { acts: {}, windows: {}, other: { input: QWEN_9B_REPO, read: nine } } })
  record('t10b-other-read', t10b)
  check('t10b other checkpoint read: Qwen3.5 9B ↓ 6 GB 256k ctx 16.5 GiB, weights 5.5 + cache 8 + prompt cache 1 + runtime 2 GiB, the pull then the serve', picker.stateWords(nine, undefined, nine.window, false).text === '↓ 6 GB' && nine.window === 262_144 && picker.tailWords(nine, nine.window).text === '16.5 GiB' && picker.memoryWords(nine) === 'weights 5.5 + cache 8 + prompt cache 1 + runtime 2 GiB' && tensorFoldWillRun(nine, 262_144).join('\n') === `tensorfold pull ${QWEN_9B_REPO}\ntensorfold serve ${QWEN_9B_REPO} --name qwen3.5-9b --context 262144 --prompt-cache-gib 1 --port 8080`, `${picker.tailWords(nine, nine.window).text} ${picker.memoryWords(nine)}`)
  const pulling = scene.pullActOf(QWEN_27B_REPO, [{ at: 0, bytes: 0 }, { at: 148_000, bytes: 6.1e9 }], 19_930_634_001, 131_072)
  const t12 = await factsFor('t12', { state: { acts: { [QWEN_27B_REPO]: pulling }, windows: {} } })
  record('t12-pulling', t12)
  check('t12 pulling: state pulling 30%; the live line pulling Qwen3.8 27B · 6.1 GB of 20 GB · 41 MB/s · about 6 min; the landing stays on the pulling row', picker.stateWords(t12.rows[0]!, t12.acts[QWEN_27B_REPO], 131_072, false).text === 'pulling 30%' && t12.live === 'pulling Qwen3.8 27B · 6.1 GB of 20 GB · 41 MB/s · about 6 min' && t12.landing === QWEN_27B_REPO, `${picker.stateWords(t12.rows[0]!, t12.acts[QWEN_27B_REPO], 131_072, false).text} | ${t12.live}`)
  const t13 = await factsFor('t13', { state: { acts: { [QWEN_27B_REPO]: { kind: 'starting', name: 'qwen3.8-27b', port: 8080, seconds: 41 } }, windows: {} } })
  record('t13-starting', t13)
  check('t13 starting: heading … · 1 starting; state starting; the live line starting qwen3.8-27b on 127.0.0.1:8080 · loading · 41 s', picker.headingStatusOf(t13) === '1.2.2 · Apple M5 Pro · 36.0 GiB usable · 1 starting' && picker.stateWords(t13.rows[0]!, t13.acts[QWEN_27B_REPO], 131_072, false).text === 'starting' && t13.live === 'starting qwen3.8-27b on 127.0.0.1:8080 · loading · 41 s', `${picker.headingStatusOf(t13)} | ${t13.live}`)
  const servedRow = { repo: QWEN_2B_REPO, name: 'qwen3.5-2b', port: 8080, window: 262_144, pid: 1, startedAt: 't', promptCacheGib: 1 }
  const t14 = await factsFor('t14', { served: [servedRow], current: 'local/qwen3.5-2b' })
  const row14 = t14.rows[0]!
  record('t14-current', t14)
  check('t14 served and switched: heading … · 1 serving; the served row first, current, 256k; the card window strip ←→ restarts it at another window and service tensorfold · started by Mercury · prompt cache 1 GiB; the live line serving qwen3.5-2b on 127.0.0.1:8080', picker.headingStatusOf(t14) === '1.2.2 · Apple M5 Pro · 36.0 GiB usable · 1 serving' && row14.repo === QWEN_2B_REPO && row14.state === 'serving' && picker.stateWords(row14, undefined, 262_144, true).text === 'current' && picker.windowStripWords(undefined, row14, 262_144, 36) === '←→ restarts it at another window' && cardOf(t14, QWEN_2B_REPO).includes('service   tensorfold · started by Mercury · prompt cache 1 GiB') && t14.live.startsWith('serving qwen3.5-2b on 127.0.0.1:8080 · idle') && t14.landing === QWEN_2B_REPO, `${picker.headingStatusOf(t14)} | ${t14.live} | ${cardOf(t14, QWEN_2B_REPO).join(' / ')}`)
  const t14b = await factsFor('t14b', { served: [servedRow], current: 'local/qwen3.5-2b', state: { acts: {}, windows: { [QWEN_2B_REPO]: 131_072 } } })
  const card14b = cardOf(t14b, QWEN_2B_REPO)
  record('t14b-restart-window', t14b)
  check('t14b ←→ on the served row: the strip says ↵ restarts it at 128k; memory weights 1.6 + cache 1.5 + prompt cache 1 + runtime 2 GiB; will run stop qwen3.5-2b on 127.0.0.1:8080 then the serve at 131072', picker.windowStripWords(undefined, t14b.rows[0]!, 131_072, 36) === '↵ restarts it at 128k' && card14b.includes('memory    weights 1.6 + cache 1.5 + prompt cache 1 + runtime 2 GiB') && card14b.some(line => line.endsWith(`tensorfold serve ${QWEN_2B_REPO} --name qwen3.5-2b --context 131072 --prompt-cache-gib 1 --port 8080`)), card14b.join(' / '))
  const t15 = await factsFor('t15', { served: [servedRow], current: 'local/qwen3.5-2b' })
  const card15 = cardOf(t15, LIGHTNING_REPO)
  record('t15-switch', t15)
  check('t15 another row framed while serving: its will run starts with stop qwen3.5-2b on 127.0.0.1:8080', card15.some(line => line === 'will run  stop qwen3.5-2b on 127.0.0.1:8080') && card15.some(line => line.endsWith(`tensorfold serve ${LIGHTNING_REPO} --name nemotron-lightning --context 262144 --port 8080`)), card15.join(' / '))
  const t15b = await factsFor('t15b', { served: [servedRow], current: 'local/qwen3.5-2b', state: { acts: { [QWEN_2B_REPO]: { kind: 'stop-confirm' } }, windows: {} } })
  record('t15b-stop-confirm', t15b)
  check("t15b s on this session's model: stop s again stops it · this session uses it", cardOf(t15b, QWEN_2B_REPO).includes('stop      s again stops it · this session uses it'))
  const t16 = await factsFor('t16', { outside: [{ id: 'qwen3.5-2b', baseUrl: 'http://127.0.0.1:8087/v1', window: 32_768 }] })
  record('t16-serving-outside', t16, { outside: t16.outside })
  check('t16 started outside Mercury: heading … · 1 serving; the outside row lands; the live line serving qwen3.5-2b on 127.0.0.1:8087 · idle; its window line says set when it started outside Mercury, which does not stop or restart it', picker.headingStatusOf(t16).endsWith('· 1 serving') && t16.outside[0]?.port === 8087 && t16.outside[0].window === 32_768 && t16.landing === 'outside:8087' && t16.live === 'serving qwen3.5-2b on 127.0.0.1:8087 · idle' && picker.standInRows(t16).models.find(model => model.id === 'tensorfold:outside:8087')!.tag === 'window    32k · set when it started outside Mercury, which does not stop or restart it', `${picker.headingStatusOf(t16)} | ${t16.live}`)
  check('t16: the next serve while 8087 answers outside stays on 8080 (another port is only taken when the preferred one is busy)', t16.port.next === 8080)
  const memoryRefusal = refusal.readTensorFoldRefusal("tensorfold: one stream's 131072-token window of KV pages (8.00 GiB) does not fit the 5.12 GiB left under the load limit; lower --context", { window: 131_072, ladder: fit.tensorFoldLadder(t06.rows[0]!.checkpoint, MAC_48) })
  const t17 = await factsFor('t17', { state: { acts: { [QWEN_27B_REPO]: scene.refusedActOf('qwen3.8-27b', 131_072, memoryRefusal) }, windows: { [QWEN_27B_REPO]: 65_536 } } })
  const card17 = cardOf(t17, QWEN_27B_REPO)
  record('t17-refused-memory', t17)
  check("t17 refused: state refused, 64k ctx, 24.5 GiB; the engine's line verbatim; the strip 64k takes 4.0 GiB of cache · 5.12 GiB left; the serve at 65536", picker.stateWords(t17.rows[0]!, t17.acts[QWEN_27B_REPO], 65_536, false).text === 'refused' && picker.tailWords(t17.rows[0]!, 65_536).text === '24.5 GiB' && card17[1] === "refused   one stream's 131072-token window of KV pages (8.00 GiB) does not fit the 5.12 GiB left under the load limit; lower --context" && card17[2] === 'window    32k [64k] 128k 256k · 64k takes 4.0 GiB of cache · 5.12 GiB left' && card17.some(line => line.endsWith('--context 65536 --port 8080')), card17.join(' / '))
  check('t17 the picker act carries the strip and the window for the one builder', picker.pickerFactsOf(t17).acts?.[QWEN_27B_REPO]?.phase === 'refused' && (picker.pickerFactsOf(t17).acts?.[QWEN_27B_REPO] as { strip?: string }).strip === '64k takes 4.0 GiB of cache · 5.12 GiB left')
  const need = fit.tensorFoldProjectedBytes(t06.rows[0]!.checkpoint, 32_768)
  const limitRefusal = refusal.readTensorFoldRefusal('tensorfold: --parallel 1 needs 2.00 GiB for its streams and 8-row prompt scratch at a 32768-token context; 0.50 GiB remains beside the weights and an 8 GiB margin: lower --parallel or --context', { window: 32_768, needBytes: need, machine: MAC_32_LOW, ladder: fit.tensorFoldLadder(t06.rows[0]!.checkpoint, MAC_32_LOW) })
  const t17b = await factsFor('t17b', { machine: MAC_32_LOW, state: { acts: { [QWEN_27B_REPO]: scene.refusedActOf('qwen3.8-27b', 32_768, limitRefusal) }, windows: { [QWEN_27B_REPO]: 32_768 } } })
  const row17b = t17b.rows.find(row => row.repo === QWEN_27B_REPO)!
  const card17b = picker.standInCard(t17b, row17b).split('\n')
  record('t17b-wired-limit', t17b)
  check("t17b macOS's GPU limit on a 32 GiB Mac: refused … macOS lets the GPU wire 21.3 of 32.0 GiB (iogpu.wired_limit_mb 0) · it needs 22.5 GiB; the strip already the smallest window; will run sudo sysctl iogpu.wired_limit_mb=27174; cost asks for your password (sudo) · leaves 5.5 GiB for macOS · resets at reboot; restart the engine after it · tight — quit other apps first", card17b[1] === 'refused   TensorFold refused qwen3.8-27b at 32k · macOS lets the GPU wire 21.3 of 32.0 GiB (iogpu.wired_limit_mb 0) · it needs 22.5 GiB' && card17b[2] === 'window    [32k] 64k 128k 256k · already the smallest window' && card17b.includes('will run  sudo sysctl iogpu.wired_limit_mb=27174') && card17b.includes('cost      asks for your password (sudo) · leaves 5.5 GiB for macOS · resets at reboot; restart the engine after it · tight — quit other apps first'), card17b.join(' / '))
  check('t17b: the 2B lands on the 32 GiB Mac (the 27B needs the raised limit, Lightning is the best fit at 256k)', t17b.rows[0]?.repo === LIGHTNING_REPO && t17b.rows[0].window === 262_144 && row17b.fit.verdict === 'needs-gpu-limit', JSON.stringify(t17b.rows.map(row => [row.shortName, row.window, row.fit.verdict])))
  check('t17b: the picker act carries the limit command and its cost; c copies the support line is offered while a refusal shows', (picker.pickerFactsOf(t17b).acts?.[QWEN_27B_REPO] as { limit?: { command: string } }).limit?.command === 'sudo sysctl iogpu.wired_limit_mb=27174' && t17b.copySupportOffered && !t06.copySupportOffered)
  const t19 = await factsFor('t19', { outside: [{ id: 'llama', baseUrl: 'http://127.0.0.1:8080/v1' }] })
  record('t19-port-busy', t19)
  const t19llama = await scene.readTensorFoldPanelFacts({ cacheRoot: fakeWorld('tf-t19b').cache, machine: MAC_48, engine: ENGINE, localModels: () => [{ id: 'qwen', server: 'llamacpp', baseUrl: 'http://127.0.0.1:8080/v1' }] as never, hosts: () => [], servedFile: '/nonexistent/served.json' })
  check('t19 8080 answers as llama.cpp: the next serve takes 8081; the port line 8081 · 8080 answers as llama.cpp · Mercury remembers it; the serve line ends --port 8081', t19llama.port.next === 8081 && picker.portWords(t19llama) === '8081 · 8080 answers as llama.cpp · Mercury remembers it' && picker.standInCard(t19llama, t19llama.rows.find(row => row.repo === QWEN_2B_REPO)!).includes('--port 8081'), JSON.stringify(t19llama.port))
  const exitRefusal = refusal.readTensorFoldRefusal('serving qwen3.5-2b at http://127.0.0.1:8080/v1 (loaded in 1.2s)\n', { exit: { code: null, signal: 'SIGKILL' } })
  const t20 = await factsFor('t20', { state: { acts: { [QWEN_2B_REPO]: { kind: 'exited', name: 'qwen3.5-2b', port: 8080, line: `${exitRefusal.line} · its log: Service logs tensorfold` } }, windows: {} } })
  record('t20-exited', t20)
  const row20 = t20.rows.find(row => row.repo === QWEN_2B_REPO)!
  check('t20 exited: state exited; exited signal 9 (killed) · its log: Service logs tensorfold; the serve again', picker.stateWords(row20, t20.acts[QWEN_2B_REPO], 262_144, false).text === 'exited' && picker.standInCard(t20, row20).split('\n')[1] === 'exited    signal 9 (killed) · its log: Service logs tensorfold' && t20.landing === QWEN_2B_REPO, picker.standInCard(t20, row20))
  const t21 = await factsFor('t21', { machine: MAC_16 })
  record('t21-small-mac', t21)
  check('t21 a 16 GiB Mac: heading 1.2.2 · Apple M4 · 12.0 GiB usable · nothing served; the 2B lands; the 27B and Lightning do not fit at 32k (22.5 and 19.4 GiB)', picker.headingStatusOf(t21) === '1.2.2 · Apple M4 · 12.0 GiB usable · nothing served' && t21.landing === QWEN_2B_REPO && t21.rows.map(row => `${row.shortName}:${picker.stateWords(row, undefined, row.window, false).text}:${row.window / 1024}k:${picker.tailWords(row, row.window).text}`).join(' | ') === 'qwen3.5-2b:on disk:256k:7.6 GiB | qwen3.8-27b:does not fit:32k:22.5 GiB | nemotron-lightning:does not fit:32k:19.4 GiB', t21.rows.map(row => `${row.shortName}:${picker.stateWords(row, undefined, row.window, false).text}:${row.window / 1024}k:${picker.tailWords(row, row.window).text}`).join(' | '))
  const t18 = { ...t06, keyed: { address: '127.0.0.1:8080' } }
  check('t18 a keyed server on 8080: the heading 1.2.2 · 127.0.0.1:8080 asks for a key; the live line … answers with a key · /health shows status only', picker.headingStatusOf(t18) === '1.2.2 · 127.0.0.1:8080 asks for a key' && scene.liveLineOf(t18) === '127.0.0.1:8080 answers with a key · /health shows status only')
  const tight = await factsFor('tight', { state: { acts: { [QWEN_27B_REPO]: { kind: 'tight', needBytes: 28.5 * GIB, freeBytes: 10 * GIB, offers: ['ollama stop frees its model'] } }, windows: {} } })
  check('memory tight: the act carries the offers for the card', tight.acts[QWEN_27B_REPO]?.kind === 'tight' && (tight.acts[QWEN_27B_REPO] as { offers: readonly string[] }).offers[0] === 'ollama stop frees its model')
}

console.log(`\n${failures === 0 ? 'GREEN' : `RED (${failures})`}: TensorFold inventory and the t-states as facts`)
process.exit(failures === 0 ? 0 : 1)
