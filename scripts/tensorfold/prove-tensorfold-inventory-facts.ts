#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { GIB, LIGHTNING_REPO, MAC_16, MAC_48, QWEN_27B_REPO, QWEN_2B_REPO, QWEN_9B_REPO, RTX_4090, fakeWorld, type CacheSeed } from './fixtures/world.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

const inventory = await import('../../src/services/tensorfold/inventory.ts')
const scene = await import('../../src/commands/tensorfold/scene.ts')
const picker = await import('../../src/commands/tensorfold/pickerFacts.ts')
const { tensorFoldPickerRows, TENSORFOLD_MODEL_GROUP } = await import('../../src/components/tensorfold/tensorfoldRows.ts')
const { tensorFoldWillRun } = await import('../../src/services/tensorfold/serve.ts')
const { ON_DISK, fakeEngine, tStateFacts, tStates } = await import('./fixtures/tstates.ts')
type Facts = import('./fixtures/tstates.ts').Facts

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title)
}

const ENGINE = await fakeEngine()

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
  check('the rank on a 48 GB M5 Pro: Lightning (the default starting point) first, the 27B second, the 2B on disk, then the other checkpoint on disk', rows.map(row => row.shortName).join(',') === 'nemotron-lightning,qwen3.8-27b,qwen3.5-2b,gemma-4-12b-it', rows.map(row => row.shortName).join(','))
  check("the 27B's second-row words: steadier on long tasks · prefill ~350 tok/s · takes most of this Mac's memory", rows.find(row => row.repo === QWEN_27B_REPO)?.note === "steadier on long tasks · prefill ~350 tok/s · takes most of this Mac's memory" && rows.find(row => row.repo === LIGHTNING_REPO)?.note === undefined, JSON.stringify(rows.map(row => [row.shortName, row.note])))
  const q2b = rows.find(row => row.repo === QWEN_2B_REPO)!
  check('the 2B is on disk (its snapshot read through refs/main), pinned facts kept, the bytes on disk measured', q2b.state === 'on-disk' && q2b.bytesOnDisk === 4096 && q2b.downloadBytes === undefined && q2b.window === 262_144 && q2b.fit.verdict === 'fits', JSON.stringify(q2b))
  const q27 = rows.find(row => row.repo === QWEN_27B_REPO)!
  check('the 27B is not pulled: its download is the checkpoint plus the drafter (20 GB), the drafter named', q27.state === 'not-pulled' && q27.downloadBytes === 19_930_634_001 && q27.drafter === 'z-lab/Qwen3.8-27B-DFlash2')
  const gemma = rows.find(row => row.repo === 'mlx-community/Gemma-4-12B-it-MLX-4bit')!
  check('a checkpoint without refs/main is read from its newest snapshot; its family, window and geometry come from config.json (8 full-attention layers of 48)', gemma.state === 'on-disk' && gemma.family === 'gemma4' && gemma.checkpoint.trainedMax === 131_072 && gemma.checkpoint.kvBytesPerToken === 8 * 8 * 256 * 4 && gemma.quantisation === '4-bit, group 64' && gemma.label === 'Gemma 4 12b It'.replace('12b It', '12B It'), JSON.stringify({ family: gemma.family, max: gemma.checkpoint.trainedMax, kv: gemma.checkpoint.kvBytesPerToken, label: gemma.label }))
  check('a family the engine does not serve is not listed; a partial pull without weights is not listed', !rows.some(row => row.repo === 'someone/Unknown-Family-MLX-4bit') && !rows.some(row => row.repo === 'TensorFold/Partial-Pull-MLX-4bit'))
  check('bestTensorFoldFit: the first in rank that reaches 64k', inventory.bestTensorFoldFit(rows)?.repo === LIGHTNING_REPO)
  const m2max = await inventory.readTensorFoldInventory(ENGINE, { cacheRoot: world.cache, machine: { ...MAC_48, chip: 'Apple M2 Max' }, served: [], env: world.env, home: world.home })
  check('a 48 GB M2 Max (pre-M5): Lightning first, the 27B second with its words', m2max[0]?.repo === LIGHTNING_REPO && m2max[1]?.repo === QWEN_27B_REPO && m2max[1].note !== undefined, m2max.map(row => row.shortName).join(','))
  const m5max = await inventory.readTensorFoldInventory(ENGINE, { cacheRoot: world.cache, machine: { ...MAC_48, chip: 'Apple M5 Max', ramBytes: 64 * GIB, usableBytes: 52 * GIB }, served: [], env: world.env, home: world.home })
  check('a 64 GB M5 Max: the 27B leads at 256k, Lightning second, no second-row words on the 27B', m5max[0]?.repo === QWEN_27B_REPO && m5max[0].window === 262_144 && m5max[0].note === undefined && m5max[1]?.repo === LIGHTNING_REPO, m5max.map(row => [row.shortName, row.window]).join(','))
  const m4max64 = await inventory.readTensorFoldInventory(ENGINE, { cacheRoot: world.cache, machine: { ...MAC_48, chip: 'Apple M4 Max', ramBytes: 64 * GIB, usableBytes: 52 * GIB }, served: [], env: world.env, home: world.home })
  check('a 64 GB M4 Max (pre-M5): Lightning still first', m4max64[0]?.repo === LIGHTNING_REPO && m4max64[1]?.repo === QWEN_27B_REPO, m4max64.map(row => row.shortName).join(','))
  const small = await inventory.readTensorFoldInventory(ENGINE, { cacheRoot: world.cache, machine: MAC_16, served: [], env: world.env, home: world.home })
  check('on a 16 GiB Mac the 2B is the best fit and lands first; the 27B and Lightning do not fit at 32k', small[0]?.repo === QWEN_2B_REPO && small.find(row => row.repo === QWEN_27B_REPO)?.fit.verdict === 'too-big' && small.find(row => row.repo === LIGHTNING_REPO)?.fit.verdict !== 'fits' && small.find(row => row.repo === QWEN_27B_REPO)?.window === 32_768, JSON.stringify(small.map(row => [row.shortName, row.window, row.fit.verdict])))
  const cuda = await inventory.readTensorFoldInventory(ENGINE, { cacheRoot: world.cache, machine: RTX_4090, served: [], env: world.env, home: world.home })
  check('on an RTX 4090 Lightning is the best fit (256k), the 27B fits 32k only', cuda[0]?.repo === LIGHTNING_REPO && cuda[0].window === 262_144 && cuda.find(row => row.repo === QWEN_27B_REPO)?.window === 32_768)
  const none = await inventory.readTensorFoldInventory(null, { cacheRoot: world.cache, machine: MAC_48, served: [], env: world.env, home: world.home })
  check('with no engine installed the pinned starting points are still sized for this machine (the first-run row and m05)', none.length >= 3 && none[0]?.repo === LIGHTNING_REPO && none[0].window === 262_144 && none.find(row => row.repo === QWEN_27B_REPO)?.window === 131_072 && none.every(row => row.fit.estimate), none.map(row => [row.shortName, row.window]).join(','))
  check('hfCacheRoot honours HF_HUB_CACHE, then HF_HOME/hub, then ~/.cache/huggingface/hub', inventory.hfCacheRoot({ HF_HUB_CACHE: '/a' }, '/h') === '/a' && inventory.hfCacheRoot({ HF_HOME: '/b' }, '/h') === '/b/hub' && inventory.hfCacheRoot({}, '/h') === '/h/.cache/huggingface/hub' && inventory.hfCacheWords('/h/.cache/huggingface/hub', '/h') === '~/.cache/huggingface/hub')
}

section('the t-states as facts through the one builder: the heading, the live line, the landing, the row cells and the card lines (the frames are prove-tensorfold-t-frames)')
type Built = ReturnType<typeof tensorFoldPickerRows>
const built = (facts: Facts): Built => tensorFoldPickerRows(picker.pickerFactsOf(facts), { view: 'tensorfold', ...(facts.current !== undefined ? { current: facts.current } : {}) })
const heading = (facts: Facts): string => built(facts).headings[TENSORFOLD_MODEL_GROUP]!.status ?? ''
const choice = (facts: Facts, id: string): Built['rows'][number] => {
  const hit = built(facts).rows.find(row => row.id === id)
  if (hit === undefined) throw new Error(`${id} is not a row`)
  return hit
}
const cellsOf = (facts: Facts, id: string): string => {
  const row = choice(facts, id)
  return `${row.name}:${row.tensorfold?.state?.text ?? ''}:${row.ctx}:${row.tensorfold?.memory?.text ?? ''}`
}
const cardOf = (facts: Facts, id: string): string[] => choice(facts, id).tensorfold!.card(400).map(line => line.map(seg => seg.text).join('').replace(/\s+$/, ''))
const order = (facts: Facts): string => built(facts).rows.filter(row => row.action !== true).map(row => row.id).join(',')
{
  const states = new Map((await tStates()).map(state => [state.frame.split('-')[0]!, state.facts]))
  const facts = (id: string): Facts => {
    const hit = states.get(id)
    if (hit === undefined) throw new Error(`no t-state ${id}`)
    return hit
  }
  const t01 = facts('t01')
  check('t01 not installed: the heading not installed · Apple M5 Pro · 36.0 GiB usable; the live line names where brew was found; the install road is brew; Lightning (the 48 GB default) lands first, the 27B second', heading(t01) === 'not installed · Apple M5 Pro · 36.0 GiB usable' && t01.live === 'not installed · Homebrew found at /opt/homebrew/bin/brew' && t01.install?.kind === 'brew' && order(t01).startsWith('local/nemotron-lightning,local/qwen3.8-27b,'), `${heading(t01)} | ${t01.live} | ${order(t01)}`)
  check("t01: the landed row's card runs the serve after the pull; the install row carries brew install", cardOf(t01, 'local/nemotron-lightning').join('\n').includes(`tensorfold pull ${LIGHTNING_REPO}`) && cardOf(t01, 'local/nemotron-lightning').some(line => line.endsWith(`tensorfold serve ${LIGHTNING_REPO} --name nemotron-lightning --context 262144 --port 8080`)) && cardOf(t01, 'tensorfold:install').join('\n').includes('brew install ashhart/tensorfold/tensorfold'), cardOf(t01, 'local/nemotron-lightning').join(' / '))
  check("t01: the 27B's second-row words ride the facts for the builder", t01.rows.find(row => row.repo === QWEN_27B_REPO)?.note === "steadier on long tasks · prefill ~350 tok/s · takes most of this Mac's memory")
  const t02 = facts('t02')
  check('t02 installing: the live line says installing TensorFold 1.2.2 with Homebrew; the install row is ◐ installing with the brew line in its card', t02.live === 'installing TensorFold 1.2.2 with Homebrew' && cellsOf(t02, 'tensorfold:install').includes(':◐ installing:') && cardOf(t02, 'tensorfold:install').some(line => line.startsWith('brew      ==> Downloading')), `${t02.live} | ${cardOf(t02, 'tensorfold:install').join(' / ')}`)
  const t03 = facts('t03')
  check('t03 no Homebrew: the install row is unavailable with needs Homebrew · brew.sh installs it, then /tensorfold again; the live line says Homebrew not found; the same three starting rows', cellsOf(t03, 'tensorfold:install').includes(':unavailable:') && cardOf(t03, 'tensorfold:install')[0] === 'needs     Homebrew · brew.sh installs it, then /tensorfold again' && t03.live === 'not installed · Homebrew not found' && t03.rows.length === 3, `${t03.live} | ${cardOf(t03, 'tensorfold:install').join(' / ')}`)
  const t04 = facts('t04')
  check('t04 Linux RTX 4090: heading not installed · the card · 23.0 GiB usable; the archive road with its six commands; Lightning lands at 256k, the 27B at 32k; the live line names the driver', heading(t04) === 'not installed · NVIDIA GeForce RTX 4090 · 23.0 GiB usable' && t04.install?.kind === 'archive' && t04.install.commands.length === 6 && cardOf(t04, 'tensorfold:install').length >= 6 && t04.live === 'not installed · NVIDIA driver 580.95 (CUDA 13)' && order(t04).startsWith('local/nemotron-lightning,local/qwen3.8-27b,') && cellsOf(t04, 'local/nemotron-lightning') === 'Nemotron Lightning:↓ 19 GB:256k ctx:20.8 GiB' && cellsOf(t04, 'local/qwen3.8-27b') === 'Qwen3.8 27B:↓ 20 GB:32k ctx:22.5 GiB', `${heading(t04)} | ${t04.live} | ${order(t04)}`)
  const t05 = facts('t05')
  check('t05 Windows: the heading reads no Windows release yet, no model rows, no install road, the live line says TensorFold runs on a host, the rent row carries the pod and serves lines', heading(t05) === 'no Windows release yet' && t05.rows.length === 0 && t05.install?.kind === 'windows' && t05.live === 'nothing served here · TensorFold runs on a host' && built(t05).rows.every(row => row.action === true) && cardOf(t05, 'tensorfold:rent')[0] === 'pod       RTX 5090 32 GB on Runpod or Vast.ai · the price shows in /llmhost · billing starts when it boots' && cardOf(t05, 'tensorfold:rent')[1] === 'serves    Qwen3.8 27B at 128k with TensorFold 1.2.2 for CUDA', `${heading(t05)} | ${t05.live} | ${cardOf(t05, 'tensorfold:rent').join(' / ')}`)
  const t06 = facts('t06')
  check('t06 installed, nothing served: heading 1.2.2 · Apple M5 Pro · 36.0 GiB usable · nothing served; live nothing served · Metal; Lightning first at 256k, the 27B at 128k, the 2B on disk', heading(t06) === '1.2.2 · Apple M5 Pro · 36.0 GiB usable · nothing served' && t06.live === 'nothing served · Metal' && order(t06) === 'local/nemotron-lightning,local/qwen3.8-27b,local/qwen3.5-2b' && [cellsOf(t06, 'local/nemotron-lightning'), cellsOf(t06, 'local/qwen3.8-27b'), cellsOf(t06, 'local/qwen3.5-2b')].join(' | ') === 'Nemotron Lightning:↓ 19 GB:256k ctx:20.8 GiB | Qwen3.8 27B:↓ 20 GB:128k ctx:28.5 GiB | Qwen3.5 2B:on disk:256k ctx:7.6 GiB', `${heading(t06)} | ${order(t06)} | ${cellsOf(t06, 'local/qwen3.8-27b')}`)
  const card06 = cardOf(t06, 'local/qwen3.8-27b')
  check('t06 card: window 32k 64k [128k] 256k · ←→ changes it; memory weights 15 + drafter 3.6 + cache 8 + runtime 2 GiB · prompt cache ≤16 GiB; pull into the cache · 38 GB free on this disk; will run the pulls then the serve', card06[0] === 'window    32k 64k [128k] 256k · ←→ changes it' && card06[1] === 'memory    weights 15 + drafter 3.6 + cache 8 + runtime 2 GiB · prompt cache ≤16 GiB' && card06[2]!.startsWith('pull      into ') && card06[2]!.endsWith('/hub · 38 GB free on this disk') && card06[3] === `will run  tensorfold pull ${QWEN_27B_REPO}` && card06[5] === `          tensorfold serve ${QWEN_27B_REPO} --drafter z-lab/Qwen3.8-27B-DFlash2 --name qwen3.8-27b --context 131072 --port 8080`, card06.join('\n'))
  const t09 = cardOf(t06, 'local/qwen3.5-2b')
  check('t09 the 2B on disk: window 32k 64k 128k [256k] · ←→ changes it; memory weights 1.6 + cache 3 + prompt cache 1 + runtime 2 GiB; no pull line; the serve with --prompt-cache-gib 1', t09[0] === 'window    32k 64k 128k [256k] · ←→ changes it' && t09[1] === 'memory    weights 1.6 + cache 3 + prompt cache 1 + runtime 2 GiB' && t09[2] === `will run  tensorfold serve ${QWEN_2B_REPO} --name qwen3.5-2b --context 262144 --prompt-cache-gib 1 --port 8080`, t09.join('\n'))
  const t10b = facts('t10b')
  check('t10b other checkpoint read: Qwen3.5 9B ↓ 6 GB 256k ctx 16.5 GiB, weights 5.5 + cache 8 + prompt cache 1 + runtime 2 GiB, the pull then the serve', cellsOf(t10b, 'local/qwen3.5-9b') === 'Qwen3.5 9B:↓ 6 GB:256k ctx:16.5 GiB' && cardOf(t10b, 'local/qwen3.5-9b')[1] === 'memory    weights 5.5 + cache 8 + prompt cache 1 + runtime 2 GiB' && tensorFoldWillRun(t10b.other!.read!, 262_144).join('\n') === `tensorfold pull ${QWEN_9B_REPO}\ntensorfold serve ${QWEN_9B_REPO} --name qwen3.5-9b --context 262144 --prompt-cache-gib 1 --port 8080`, `${cellsOf(t10b, 'local/qwen3.5-9b')} | ${cardOf(t10b, 'local/qwen3.5-9b').join(' / ')}`)
  const t11 = facts('t11')
  check("t11 other checkpoint refused: GGUF is llama.cpp's format · /localsetup serves it", t11.other?.refused === "GGUF is llama.cpp's format · /localsetup serves it" && cardOf(t11, 'tensorfold:other')[0] === "refused   GGUF is llama.cpp's format · /localsetup serves it", cardOf(t11, 'tensorfold:other').join(' / '))
  const t12 = facts('t12')
  check('t12 pulling: state pulling 30%; the live line pulling Qwen3.8 27B · 6.1 GB of 20 GB · 41 MB/s · about 6 min; the pulling row stays first', cellsOf(t12, 'local/qwen3.8-27b').includes(':pulling 30%:') && t12.live === 'pulling Qwen3.8 27B · 6.1 GB of 20 GB · 41 MB/s · about 6 min' && order(t12).startsWith('local/qwen3.8-27b,'), `${cellsOf(t12, 'local/qwen3.8-27b')} | ${t12.live}`)
  const t13 = facts('t13')
  check('t13 starting: heading … · 1 starting; state starting; the live line starting qwen3.8-27b on 127.0.0.1:8080 · loading · 41 s', heading(t13) === '1.2.2 · Apple M5 Pro · 36.0 GiB usable · 1 starting' && cellsOf(t13, 'local/qwen3.8-27b').includes(':starting:') && t13.live === 'starting qwen3.8-27b on 127.0.0.1:8080 · loading · 41 s', `${heading(t13)} | ${t13.live}`)
  const t14 = facts('t14')
  check('t14 served and switched: heading … · 1 serving; the served row first, current, 256k, 2.8 GiB in use (measured); the card ←→ restarts it at another window and service tensorfold · started by Mercury · prompt cache 1 GiB; the live line serving qwen3.5-2b on 127.0.0.1:8080 · first reply in 40 ms · ~110 tok/s', heading(t14) === '1.2.2 · Apple M5 Pro · 36.0 GiB usable · 1 serving' && order(t14).startsWith('local/qwen3.5-2b,') && cellsOf(t14, 'local/qwen3.5-2b') === 'Qwen3.5 2B:current:256k ctx:2.8 GiB in use' && cardOf(t14, 'local/qwen3.5-2b')[0] === 'window    32k 64k 128k [256k] · ←→ restarts it at another window' && cardOf(t14, 'local/qwen3.5-2b')[1] === 'service   tensorfold · started by Mercury · prompt cache 1 GiB' && t14.live === 'serving qwen3.5-2b on 127.0.0.1:8080 · first reply in 40 ms · ~110 tok/s', `${heading(t14)} | ${t14.live} | ${cardOf(t14, 'local/qwen3.5-2b').join(' / ')}`)
  const t15 = facts('t15')
  check('t15 another row framed while serving: its will run starts with stop qwen3.5-2b on 127.0.0.1:8080', cardOf(t15, 'local/nemotron-lightning').some(line => line === 'will run  stop qwen3.5-2b on 127.0.0.1:8080') && cardOf(t15, 'local/nemotron-lightning').some(line => line.endsWith(`tensorfold serve ${LIGHTNING_REPO} --name nemotron-lightning --context 262144 --port 8080`)), cardOf(t15, 'local/nemotron-lightning').join(' / '))
  const t16 = facts('t16')
  check('t16 started outside Mercury: heading 33.2 of 36.0 GiB usable left · 1 serving; the outside row is first; the live line serving qwen3.5-2b on 127.0.0.1:8087 · idle; its window line says set when it started outside Mercury, which does not stop or restart it', heading(t16) === '1.2.2 · Apple M5 Pro · 33.2 of 36.0 GiB usable left · 1 serving' && t16.outside[0]?.port === 8087 && order(t16).startsWith('local/qwen3.5-2b,') && cellsOf(t16, 'local/qwen3.5-2b') === 'qwen3.5-2b:serving:32k ctx:2.8 GiB in use' && t16.live === 'serving qwen3.5-2b on 127.0.0.1:8087 · idle' && cardOf(t16, 'local/qwen3.5-2b')[0] === 'window    32k · set when it started outside Mercury, which does not stop or restart it', `${heading(t16)} | ${t16.live} | ${cardOf(t16, 'local/qwen3.5-2b').join(' / ')}`)
  check('t16: the next serve while 8087 answers outside stays on 8080 (another port is only taken when the preferred one is busy)', t16.port.next === 8080)
  const t16b = facts('t16b')
  check("t16b a rented pod's tunnel on loopback is a HOST row, never an outside server: one outside row (8087), the pod under TENSORFOLD HOST, the landing never the tunnel", t16b.outside.length === 1 && t16b.outside[0]?.port === 8087 && t16b.hosts.some(host => host.origin === 'pod' && host.baseUrl === 'http://127.0.0.1:18080') && t16b.landing !== 'local/qwen3.8-27b' && !order(t16b).split(',').some(id => id.endsWith(':18080') || id.endsWith('qwen3.8-27b-outside')))
  const t17 = facts('t17')
  const card17 = cardOf(t17, 'local/qwen3.8-27b')
  check("t17 refused: state refused, 64k ctx, 24.5 GiB; the engine's line verbatim; the strip 64k takes 4.0 GiB of cache · 5.12 GiB left; the serve at 65536", cellsOf(t17, 'local/qwen3.8-27b') === 'Qwen3.8 27B:refused:64k ctx:24.5 GiB' && card17[0] === "refused   one stream's 131072-token window of KV pages (8.00 GiB) does not fit the 5.12 GiB left under the load limit; lower --context" && card17[1] === 'window    32k [64k] 128k 256k · 64k takes 4.0 GiB of cache · 5.12 GiB left' && card17.some(line => line.endsWith('--context 65536 --port 8080')), card17.join(' / '))
  check('t17 the picker act carries the strip and the window for the one builder', picker.pickerFactsOf(t17).acts?.[QWEN_27B_REPO]?.phase === 'refused' && (picker.pickerFactsOf(t17).acts?.[QWEN_27B_REPO] as { strip?: string }).strip === '64k takes 4.0 GiB of cache · 5.12 GiB left')
  const t17b = facts('t17b')
  const card17b = cardOf(t17b, 'local/qwen3.8-27b')
  check("t17b macOS's GPU limit on a 32 GiB Mac: refused … macOS lets the GPU wire 21.3 of 32.0 GiB (iogpu.wired_limit_mb 0) · it needs 22.5 GiB; the strip already the smallest window; will run sudo sysctl iogpu.wired_limit_mb=27174; cost asks for your password (sudo) · leaves 5.5 GiB for macOS · resets at reboot; restart the engine after it · tight — quit other apps first", card17b[0] === 'refused   TensorFold refused qwen3.8-27b at 32k · macOS lets the GPU wire 21.3 of 32.0 GiB (iogpu.wired_limit_mb 0) · it needs 22.5 GiB' && card17b[1] === 'window    [32k] 64k 128k 256k · already the smallest window' && card17b.includes('will run  sudo sysctl iogpu.wired_limit_mb=27174') && card17b.includes('cost      asks for your password (sudo) · leaves 5.5 GiB for macOS · resets at reboot; restart the engine after it · tight — quit other apps first'), card17b.join(' / '))
  check('t17b: the refused 27B leads (the row with the act); Lightning (the best fit at 256k) beneath it; the 27B needs the raised limit', order(t17b).startsWith('local/qwen3.8-27b,local/nemotron-lightning') && t17b.rows.find(row => row.repo === QWEN_27B_REPO)?.fit.verdict === 'needs-gpu-limit' && t17b.rows[0]?.repo === LIGHTNING_REPO, order(t17b))
  check('t17b: the picker act carries the limit command and its cost; c copies the support line is offered while a refusal shows', (picker.pickerFactsOf(t17b).acts?.[QWEN_27B_REPO] as { limit?: { command: string } }).limit?.command === 'sudo sysctl iogpu.wired_limit_mb=27174' && t17b.copySupportOffered && !t06.copySupportOffered)
  const t18 = facts('t18')
  check('t18 a keyed server on 8080, read live from the port: the heading 1.2.2 · 127.0.0.1:8080 asks for a key; the live line … answers with a key · /health shows status only; the next serve on 8081', heading(t18) === '1.2.2 · 127.0.0.1:8080 asks for a key' && t18.live === '127.0.0.1:8080 answers with a key · /health shows status only' && t18.keyed?.address === '127.0.0.1:8080' && t18.port.next === 8081 && cardOf(t18, 'local/nemotron-lightning').includes('port      8081 · 8080 is the keyed TensorFold server · Mercury remembers it'), `${heading(t18)} | ${t18.live} | ${JSON.stringify(t18.port)}`)
  const t19 = facts('t19')
  check('t19 8080 answers as llama.cpp: the next serve takes 8081; the port line 8081 · 8080 answers as llama.cpp · Mercury remembers it; the serve line ends --port 8081', t19.port.next === 8081 && cardOf(t19, 'local/qwen3.5-2b').includes('port      8081 · 8080 answers as llama.cpp · Mercury remembers it') && cardOf(t19, 'local/qwen3.5-2b').some(line => line.endsWith('--port 8081')), cardOf(t19, 'local/qwen3.5-2b').join(' / '))
  const t20 = facts('t20')
  check('t20 exited: state exited; exited signal 9 (killed) · its log: Service logs tensorfold; the serve again', cellsOf(t20, 'local/qwen3.5-2b').includes(':exited:') && cardOf(t20, 'local/qwen3.5-2b')[0] === 'exited    signal 9 (killed) · its log: Service logs tensorfold' && t20.landing === QWEN_2B_REPO, cardOf(t20, 'local/qwen3.5-2b').join(' / '))
  const t21 = facts('t21')
  check('t21 a 16 GiB Mac: heading 1.2.2 · Apple M4 · 12.0 GiB usable · nothing served; the 2B lands first; the 27B and Lightning do not fit at 32k (22.5 and 19.4 GiB)', heading(t21) === '1.2.2 · Apple M4 · 12.0 GiB usable · nothing served' && order(t21) === 'local/qwen3.5-2b,local/nemotron-lightning,local/qwen3.8-27b' && [cellsOf(t21, 'local/qwen3.5-2b'), cellsOf(t21, 'local/qwen3.8-27b'), cellsOf(t21, 'local/nemotron-lightning')].join(' | ') === 'Qwen3.5 2B:on disk:256k ctx:7.6 GiB | Qwen3.8 27B:does not fit:32k ctx:22.5 GiB | Nemotron Lightning:does not fit:32k ctx:19.4 GiB', `${heading(t21)} | ${order(t21)}`)
  const tight = await tStateFacts('tight', { state: { acts: { [QWEN_27B_REPO]: { kind: 'tight', needBytes: 28.5 * GIB, freeBytes: 10 * GIB, offers: ['ollama stop frees its model'] } } } })
  check('memory tight: the row reads refused with the need, what is free and the offer in its card', cellsOf(tight, 'local/qwen3.8-27b').includes(':refused:') && cardOf(tight, 'local/qwen3.8-27b')[0] === 'refused   28.5 GiB needed · 10.0 GiB free on this Mac · ollama stop frees its model', cardOf(tight, 'local/qwen3.8-27b').join(' / '))
}

console.log(`\n${failures === 0 ? 'GREEN' : `RED (${failures})`}: TensorFold inventory and the t-states as facts`)
process.exit(failures === 0 ? 0 : 1)
