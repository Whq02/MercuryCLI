#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { FAKE_BIN, FAKE_SCRIPT, GIB, LINUX_NO_GPU, LINUX_OLD_DRIVER, MAC_16, MAC_32, MAC_32_LOW, MAC_48, QWEN_27B_REPO, QWEN_2B_REPO, QWEN_9B_REPO, RTX_4090, fakeExists, fakeWorld } from './fixtures/world.ts'
import { FAKE_LIBJPEG_WARNING } from './fixtures/fake-tensorfold.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const engine = await import('../../src/services/tensorfold/engine.ts')
const fit = await import('../../src/services/tensorfold/fit.ts')
const install = await import('../../src/services/tensorfold/install.ts')
const refusal = await import('../../src/services/tensorfold/refusal.ts')
const serve = await import('../../src/services/tensorfold/serve.ts')
const starting = await import('../../src/services/tensorfold/starting.ts')
const pull = await import('../../src/services/tensorfold/pull.ts')
const scene = await import('../../src/commands/tensorfold/scene.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 500)}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title)
}
const gib1 = (bytes: number): string => (bytes / GIB).toFixed(1)

section('the engine: found on PATH, --version and capabilities --json with stdout apart from stderr')
{
  const world = fakeWorld('tf-engine')
  const found = await engine.findTensorFoldEngine({ env: world.env, home: world.home, platform: 'darwin', exists: fakeExists, ramBytes: MAC_48.ramBytes, run: async (file: string, args: string[]) => (file === 'osascript' ? '38654705664 Apple M5 Pro' : file === 'sysctl' && args[1] === 'iogpu.wired_limit_mb' ? '0' : file === 'sysctl' && args[1] === 'kern.osproductversion' ? '27.0' : undefined) } as never)
  check('the fake tensorfold on PATH is found by name; the native binary is preferred over a launcher beside it (the service pid must be the engine itself)', found !== null && found.binary === `${FAKE_BIN}/tensorfold` && engine.TENSORFOLD_BINARY_NAMES[0] === 'tensorfold-native', String(found?.binary))
  check('--version reads 1.2.2', found?.version === '1.2.2', String(found?.version))
  check('capabilities --json is read from stdout: the Metal backend and the families', found?.backends[0] === 'metal' && found.families.some(family => family.id === 'qwen3_5' && family.qualified) && found.families.some(family => family.id === 'gemma4' && !family.qualified), JSON.stringify(found?.families.map(family => family.id)))
  check('stderr is kept apart from the JSON: the libjpeg warning is a warning, never parsed', found?.warnings.length === 1 && found.warnings[0] === FAKE_LIBJPEG_WARNING, JSON.stringify(found?.warnings))
  check('the optional libraries ride the engine for the /health detail', found?.optionalLibraries?.some(library => library.name === 'libjpeg-turbo' && library.found && library.note !== undefined) === true, JSON.stringify(found?.optionalLibraries))
  check('the chip is the Metal device name read live, not the capabilities slug', found?.chip === 'Apple M5 Pro', String(found?.chip))
  check('tensorFoldMachine() answers the chip and the usable GiB after the read', engine.tensorFoldMachine().chip === 'Apple M5 Pro' && Math.abs((engine.tensorFoldMachine().usableGib ?? 0) - 36) < 0.01, JSON.stringify(engine.tensorFoldMachine()))
  const none = await engine.findTensorFoldEngine({ env: { ...world.env, PATH: '/usr/bin:/bin' }, home: world.home, platform: 'darwin', exists: () => false })
  check('with nothing on PATH, in the runtime folder or Homebrew, the engine is null (not installed)', none === null)
  const windows = await engine.findTensorFoldEngine({ env: world.env, home: world.home, platform: 'win32' })
  check('on win32 no engine is probed', windows === null)
  const candidates = engine.tensorFoldBinaryCandidates({ env: { PATH: '/x' }, home: '/h', platform: 'darwin' })
  check('both names are tried, on PATH, the runtime folder, ~/.tensorfold/bin and the Homebrew prefixes', candidates.includes('/x/tensorfold') && candidates.includes('/x/tensorfold-native') && candidates.includes('/h/.local/share/mercury-host/runtime/tensorfold/bin/tensorfold-native') && candidates.includes('/h/.tensorfold/bin/tensorfold') && candidates.includes('/opt/homebrew/bin/tensorfold'), candidates.join(','))
  check('a version line with the binary name parses; a bare number too', engine.parseTensorFoldVersion('tensorfold-native 1.2.2\n') === '1.2.2' && engine.parseTensorFoldVersion('1.3.0') === '1.3.0')
  const parsed = engine.parseTensorFoldCapabilities(`${FAKE_LIBJPEG_WARNING}\n{"schema":1,"version":"1.2.2","chip":null,"backends":["cuda"],"families":{"nemotron_h":["mlx-q4g64"]},"serve":{"flags":{"--port":{}}}}`)
  check('a stray line before the JSON does not break the read; a null chip reads as null', parsed?.chip === null && parsed.backends[0] === 'cuda' && parsed.flags.includes('--port'))
  check('the backend words: Metal on a Mac, CUDA on Linux', engine.tensorFoldBackendWords({ backends: ['metal'] }) === 'Metal' && engine.tensorFoldBackendWords(null, 'linux') === 'CUDA')
}

section('the machine truth: the Metal working set read live, the wired limit, nvidia-smi, the fallbacks')
{
  const mac = await fit.readTensorFoldMachineTruth({ platform: 'darwin', ramBytes: 48 * GIB, run: async (file: string, args: string[]) => (file === 'osascript' ? '40200896512 Apple M5 Pro\n' : file === 'sysctl' && args[1] === 'iogpu.wired_limit_mb' ? '0\n' : file === 'sysctl' && args[1] === 'kern.osproductversion' ? '27.0\n' : file === 'sysctl' ? 'Apple M5 Pro\n' : undefined) })
  check('darwin: the GPU working set is the Metal reading (37.4 GiB of 48, not a fraction), the chip its name, the limit 0 and the OS version kept', mac.usableSource === 'metal' && gib1(mac.usableBytes) === '37.4' && mac.chip === 'Apple M5 Pro' && mac.wiredLimitMib === 0 && mac.osVersion === '27.0', JSON.stringify(mac))
  const limited = await fit.readTensorFoldMachineTruth({ platform: 'darwin', ramBytes: 32 * GIB, run: async (file, args) => (file === 'sysctl' && args[1] === 'iogpu.wired_limit_mb' ? '28672\n' : file === 'sysctl' ? 'Apple M4 Pro\n' : undefined) })
  check('darwin without Metal: a raised iogpu.wired_limit_mb is the ceiling, named', limited.usableSource === 'wired-limit' && gib1(limited.usableBytes) === '28.0' && limited.wiredLimitMib === 28672, JSON.stringify(limited))
  const bare = await fit.readTensorFoldMachineTruth({ platform: 'darwin', ramBytes: 32 * GIB, run: async () => undefined })
  check('darwin with nothing readable: his 70% of RAM rule, never a hard-coded Metal share', bare.usableSource === 'seventy-percent' && gib1(bare.usableBytes) === '22.4' && bare.chip === 'Apple silicon', JSON.stringify(bare))
  const linux = await fit.readTensorFoldMachineTruth({ platform: 'linux', ramBytes: 64 * GIB, run: async file => (file === 'nvidia-smi' ? 'NVIDIA GeForce RTX 4090, 24564, 580.95.05\n' : undefined) })
  check('linux: nvidia-smi gives the card, its memory less his reserve (1/32, at least 1 GiB) as usable, the driver and CUDA 13', linux.usableSource === 'cuda' && linux.gpu?.name === 'NVIDIA GeForce RTX 4090' && linux.gpu.cuda === '13' && gib1(linux.usableBytes) === '23.0', JSON.stringify(linux))
  const noGpu = await fit.readTensorFoldMachineTruth({ platform: 'linux', ramBytes: 64 * GIB, run: async () => undefined })
  check('linux without nvidia-smi: no GPU found, the 70% fallback', noGpu.gpu === undefined && noGpu.chip === 'no NVIDIA GPU found' && noGpu.usableSource === 'seventy-percent')
  check('an R550 driver reads as CUDA 12', fit.cudaVersionOfDriver('550.54.15') === '12' && fit.cudaVersionOfDriver('580.95') === '13')
  check('the Metal script asks MTLDevice for recommendedMaxWorkingSetSize and the device name', fit.METAL_WORKING_SET_SCRIPT.includes('recommendedMaxWorkingSetSize') && fit.METAL_WORKING_SET_SCRIPT.includes("ObjC.import('Metal')"))
}

section('install plans: Homebrew on a Mac, the verified archive on Linux, the words on Windows')
{
  const brew = install.tensorFoldInstallPlan(MAC_48, { platform: 'darwin', env: { PATH: '/nowhere' }, exists: path => path === '/opt/homebrew/bin/brew' })
  check('a Mac with Homebrew: brew install ashhart/tensorfold/tensorfold, the footer naming where brew was found', brew.kind === 'brew' && brew.commands[0] === 'brew install ashhart/tensorfold/tensorfold' && brew.found === 'not installed · Homebrew found at /opt/homebrew/bin/brew' && brew.words === 'Homebrew · ashhart/tensorfold', JSON.stringify(brew))
  const noBrew = install.tensorFoldInstallPlan(MAC_48, { platform: 'darwin', env: { PATH: '/nowhere' }, exists: () => false })
  check('a Mac without Homebrew: the install row is unavailable with brew.sh as the next move', noBrew.kind === 'needs-brew' && noBrew.needs === 'Homebrew · brew.sh installs it, then /tensorfold again' && noBrew.found === 'not installed · Homebrew not found', JSON.stringify(noBrew))
  const archive = install.tensorFoldInstallPlan(RTX_4090, { platform: 'linux', arch: 'x64', home: '/home/u' })
  check('Linux with an R580 driver: the archive road into the runtime folder, checksum verified, the tree kept whole with --strip-components=1, the archive and sidecar removed', archive.kind === 'archive' && archive.commands.join('\n') === ['cd ~/.local/share/mercury-host/runtime/tensorfold', 'curl -fLO https://github.com/ashhart/TensorFold/releases/download/v1.2.2/tensorfold-1.2.2-linux-x86_64.tar.gz', 'curl -fLO https://github.com/ashhart/TensorFold/releases/download/v1.2.2/tensorfold-1.2.2-linux-x86_64.tar.gz.sha256', 'sha256sum -c tensorfold-1.2.2-linux-x86_64.tar.gz.sha256', 'tar -xzf tensorfold-1.2.2-linux-x86_64.tar.gz --strip-components=1', 'rm tensorfold-1.2.2-linux-x86_64.tar.gz tensorfold-1.2.2-linux-x86_64.tar.gz.sha256'].join('\n') && (archive.kind === 'archive' && archive.folder === '/home/u/.local/share/mercury-host/runtime/tensorfold') && archive.found === 'not installed · NVIDIA driver 580.95 (CUDA 13)', JSON.stringify(archive))
  const runs = install.installRuns(archive)
  check('the archive runs are five commands in the runtime folder, nothing through a shell', runs.length === 5 && archive.kind === 'archive' && runs.every(run => run.cwd === archive.folder) && runs[2]!.command === 'sha256sum' && runs[3]!.args.includes('--strip-components=1'), JSON.stringify(runs))
  const arm = install.tensorFoldInstallPlan(RTX_4090, { platform: 'linux', arch: 'arm64', home: '/home/u' })
  check('an arm64 Linux box takes the aarch64 archive', arm.kind === 'archive' && arm.archive === 'tensorfold-1.2.2-linux-aarch64.tar.gz')
  const noGpu = install.tensorFoldInstallPlan(LINUX_NO_GPU, { platform: 'linux' })
  check('Linux without a GPU: the install row is unavailable, the footer says no NVIDIA GPU found', noGpu.kind === 'no-gpu' && noGpu.found === 'not installed · no NVIDIA GPU found')
  const old = install.tensorFoldInstallPlan(LINUX_OLD_DRIVER, { platform: 'linux' })
  check('Linux with an R550 driver: unavailable, TensorFold needs R580 or newer', old.kind === 'old-driver' && old.found === 'not installed · driver 550.54 · TensorFold needs R580 or newer', JSON.stringify(old))
  const win = install.tensorFoldInstallPlan({ platform: 'win32' }, { platform: 'win32' })
  check('Windows: no Windows release yet; TensorFold runs on a host', win.kind === 'windows' && win.words === 'no Windows release yet' && win.found === 'nothing served here · TensorFold runs on a host')
  const brewRun = await install.installTensorFold(brew, () => undefined, { spawnImpl: ((command: string, args: string[]) => { throw new Error(`refused ${command} ${args.join(' ')}`) }) as never })
  check('installing runs brew with install and the formula (the spawn seam sees it)', !brewRun.ok && brewRun.line === 'refused /opt/homebrew/bin/brew install ashhart/tensorfold/tensorfold', JSON.stringify(brewRun))
}

section('fit: the floor, the ladder, every verdict an estimate')
{
  const { QWEN_27B, NEMOTRON_LIGHTNING, QWEN_2B } = starting
  const l27 = fit.tensorFoldLadder(QWEN_27B, MAC_48)
  check('48 GiB Mac (36.0 usable): the 27B with its drafter fits 32k, 64k and 128k, not 256k (36.5 GiB)', l27.map(rung => rung.fit.verdict).join(',') === 'fits,fits,fits,needs-gpu-limit' && gib1(l27[3]!.fit.neededGib * GIB) === '36.5' && fit.chosenTensorFoldWindow(l27) === 131_072, JSON.stringify(l27.map(rung => [rung.window, rung.fit.verdict, gib1(rung.fit.neededGib * GIB)])))
  const parts = l27[2]!.fit.parts!
  check('the memory parts at 128k: weights 15 + drafter 3.6 + cache 8 + runtime 2, the prompt cache capped at 16', parts.weightsGib.toFixed(0) === '15' && parts.drafterGib!.toFixed(1) === '3.6' && parts.cacheGib === 8 && parts.runtimeGib === 2 && parts.promptCacheCapGib === 16 && parts.promptCacheGib === undefined, JSON.stringify(parts))
  check('every verdict is labelled an estimate', l27.every(rung => rung.fit.estimate === true))
  const l2b = fit.tensorFoldLadder(QWEN_2B, MAC_48)
  check('the 2B: 256k fits at 7.6 GiB (weights 1.6 + cache 3 + prompt cache 1 + runtime 2)', fit.chosenTensorFoldWindow(l2b) === 262_144 && gib1(l2b[3]!.fit.neededGib * GIB) === '7.6' && l2b[3]!.fit.parts!.promptCacheGib === 1 && l2b[3]!.fit.parts!.cacheGib === 3, JSON.stringify(l2b[3]))
  const lightning = fit.tensorFoldLadder(NEMOTRON_LIGHTNING, MAC_48)
  check('Lightning: 256k at 20.8 GiB', fit.chosenTensorFoldWindow(lightning) === 262_144 && gib1(lightning[3]!.fit.neededGib * GIB) === '20.8')
  const small27 = fit.tensorFoldLadder(QWEN_27B, MAC_16)
  check('16 GiB Mac: the 27B is too big at every window (its floor is past 70% of 16 GiB)', small27.every(rung => rung.fit.verdict === 'too-big') && small27[0]!.fit.remedy === 'choose a smaller model', JSON.stringify(small27[0]!.fit))
  const smallLightning = fit.tensorFoldLadder(NEMOTRON_LIGHTNING, MAC_16)
  check('16 GiB Mac: Lightning does not fit either (19.4 GiB at 32k against 12.0 usable)', smallLightning.every(rung => rung.fit.verdict !== 'fits') && gib1(smallLightning[0]!.fit.neededGib * GIB) === '19.4', JSON.stringify(smallLightning[0]!.fit))
  check('16 GiB Mac: the 2B fits at 256k', fit.chosenTensorFoldWindow(fit.tensorFoldLadder(QWEN_2B, MAC_16)) === 262_144)
  const mac32 = fit.tensorFoldLadder(QWEN_27B, MAC_32)
  check('32 GiB Mac: the 27B needs the GPU limit raised even where the projection fits (22.5 GiB at 32k under 24.0 usable)', mac32[0]!.fit.verdict === 'needs-gpu-limit' && gib1(mac32[0]!.fit.neededGib * GIB) === '22.5' && mac32[0]!.fit.reason === 'needs the GPU limit raised on a Mac under 48 GB', JSON.stringify(mac32[0]!.fit))
  check('32 GiB Mac: the remedy is the sysctl line when the need plus 4 GiB leaves macOS at least 4 GiB', mac32[0]!.fit.remedy?.startsWith('sudo sysctl iogpu.wired_limit_mb=27174 · resets at reboot; restart the engine after it') === true, String(mac32[0]!.fit.remedy))
  const offer = fit.wiredLimitOfferFor(mac32[0]!.fit.neededGib * GIB, MAC_32)
  check('the offer: the need plus 4 GiB rounded up to a MiB (27174), leaving 5.5 GiB — under 8 GiB, so tight', offer?.limitMib === 27174 && gib1(offer.leavesBytes) === '5.5' && offer.tight === true, JSON.stringify(offer))
  const tooTight = fit.wiredLimitOfferFor(29 * GIB, MAC_32)
  check('a need that would leave macOS under 4 GiB gets no sysctl: lower the window or choose a smaller model', tooTight === null && fit.wiredLimitRemedyWords(null) === 'lower the window or choose a smaller model')
  const cuda27 = fit.tensorFoldLadder(QWEN_27B, RTX_4090)
  check('an RTX 4090 (23.0 usable): the 27B fits only 32k (22.5 GiB)', cuda27.map(rung => rung.fit.verdict).join(',') === 'fits,too-big,too-big,too-big' && fit.chosenTensorFoldWindow(cuda27) === 32_768, JSON.stringify(cuda27.map(rung => rung.fit.verdict)))
  check('an RTX 4090: Lightning reaches 256k at 20.8 GiB', fit.chosenTensorFoldWindow(fit.tensorFoldLadder(NEMOTRON_LIGHTNING, RTX_4090)) === 262_144)
  check('the best fit must reach 64k: a ladder fitting only 32k does not', !fit.reachesAgentFloor(cuda27) && fit.reachesAgentFloor(l27))
  check('the rungs are the local window ladder under the trained maximum', fit.tensorFoldRungs({ trainedMax: 131_072 }).join(',') === '32768,65536,131072')
}

section('short names and the pinned starting points')
{
  check('the pinned short names', starting.tensorFoldShortName(QWEN_2B_REPO) === 'qwen3.5-2b' && starting.tensorFoldShortName(QWEN_27B_REPO) === 'qwen3.8-27b' && starting.tensorFoldShortName('TensorFold/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-MLX-4bit') === 'nemotron-lightning')
  check('another checkpoint: the repository name lowercased, vendor prefix and quantisation suffix dropped', starting.tensorFoldShortName(QWEN_9B_REPO) === 'qwen3.5-9b' && starting.tensorFoldShortName('unsloth/Gemma-4-12B-it-MLX-8bit') === 'gemma-4-12b-it', `${starting.tensorFoldShortName(QWEN_9B_REPO)} ${starting.tensorFoldShortName('unsloth/Gemma-4-12B-it-MLX-8bit')}`)
  check('the labels', starting.tensorFoldLabel(QWEN_9B_REPO) === 'Qwen3.5 9b'.replace('9b', '9B') || starting.tensorFoldLabel(QWEN_9B_REPO) === 'Qwen3.5 9B', starting.tensorFoldLabel(QWEN_9B_REPO))
  check('the rank: the 27B, Lightning, the 2B; the 2B pinned to its revision; the 27B paired with its drafter', starting.TENSORFOLD_STARTING_POINTS.map(point => point.shortName).join(',') === 'qwen3.8-27b,nemotron-lightning,qwen3.5-2b' && starting.QWEN_2B.pin === '93760be4f1f69842a46bc13dbdc0f19e291392a3' && starting.QWEN_27B.drafter?.repo === 'z-lab/Qwen3.8-27B-DFlash2')
  check('a repo id is owner/name; a GGUF repo is refused before any download', starting.isRepoId('mlx-community/Qwen3.5-9B-MLX-4bit') && !starting.isRepoId('qwen3.5-9b') && starting.isGgufRepo('unsloth/Qwen3.5-9B-GGUF'))
  check('the pull lines: the 2B pinned, the 27B then its drafter', pull.pullCommandLines(QWEN_2B_REPO).join(' | ') === `tensorfold pull ${QWEN_2B_REPO}@93760be4f1f69842a46bc13dbdc0f19e291392a3` && pull.pullCommandLines(QWEN_27B_REPO).join(' | ') === `tensorfold pull ${QWEN_27B_REPO} | tensorfold pull z-lab/Qwen3.8-27B-DFlash2`)
}

section('will run: the exact lines ↵ runs')
{
  const row27 = { repo: QWEN_27B_REPO, shortName: 'qwen3.8-27b', family: 'qwen3_5', state: 'not-pulled' as const, fit: { verdict: 'fits' as const, neededGib: 28.5, availableGib: 36, estimate: true as const }, window: 131_072, qualified: true, drafter: 'z-lab/Qwen3.8-27B-DFlash2' }
  check('the 27B not on disk: pull both, serve with the drafter, the name, the window and the port', serve.tensorFoldWillRun(row27, 131_072).join('\n') === [`tensorfold pull ${QWEN_27B_REPO}`, 'tensorfold pull z-lab/Qwen3.8-27B-DFlash2', `tensorfold serve ${QWEN_27B_REPO} --drafter z-lab/Qwen3.8-27B-DFlash2 --name qwen3.8-27b --context 131072 --port 8080`].join('\n'), serve.tensorFoldWillRun(row27, 131_072).join(' | '))
  const row2b = { repo: QWEN_2B_REPO, shortName: 'qwen3.5-2b', family: 'qwen3_5', state: 'on-disk' as const, fit: { verdict: 'fits' as const, neededGib: 7.6, availableGib: 36, estimate: true as const }, window: 262_144, qualified: true, promptCacheGib: 1 }
  check('the 2B on disk: the serve alone, with --prompt-cache-gib 1', serve.tensorFoldWillRun(row2b, 262_144).join('\n') === `tensorfold serve ${QWEN_2B_REPO} --name qwen3.5-2b --context 262144 --prompt-cache-gib 1 --port 8080`, serve.tensorFoldWillRun(row2b, 262_144).join(' | '))
  check('a row with a remembered port serves there', serve.tensorFoldWillRun({ ...row2b, port: 8081 }, 131_072)[0]!.endsWith('--context 131072 --prompt-cache-gib 1 --port 8081'))
  const other = { repo: QWEN_9B_REPO, shortName: 'qwen3.5-9b', family: 'qwen3_5', state: 'not-pulled' as const, fit: row2b.fit, window: 262_144, qualified: false }
  check('another qwen3_5 checkpoint takes the opt-in prompt cache of 1 GiB', serve.tensorFoldWillRun(other, 262_144)[1] === `tensorfold serve ${QWEN_9B_REPO} --name qwen3.5-9b --context 262144 --prompt-cache-gib 1 --port 8080`, serve.tensorFoldWillRun(other, 262_144).join(' | '))
  const spec = serve.tensorFoldServiceSpec('/bin/tensorfold', starting.QWEN_2B, 262_144, 8081, '/p')
  check('the service spec: name tensorfold, lifecycle project, readiness http /health, restart never, TF_DRAIN_S inside stopService\'s wait', spec.name === 'tensorfold' && spec.lifecycle === 'project' && spec.restart === 'never' && spec.readiness[0]?.kind === 'http' && spec.readiness[0].url === 'http://127.0.0.1:8081/health' && spec.env?.TF_DRAIN_S === '4' && spec.env.TENSORFOLD_NO_UPDATE_CHECK === '1', JSON.stringify(spec))
}

section('the refusal reader: the last stderr line, AddressInUse, the memory lines, the GPU-limit reading')
{
  const port = refusal.readTensorFoldRefusal('serving nothing\ntensorfold: cannot listen on 127.0.0.1:8080 (AddressInUse)\n')
  check('AddressInUse: kind port, the host and port, the engine prefix stripped', port.kind === 'port' && port.port === 8080 && port.host === '127.0.0.1' && port.line === 'cannot listen on 127.0.0.1:8080 (AddressInUse)', JSON.stringify(port))
  const ladder = fit.tensorFoldLadder(starting.QWEN_27B, MAC_48)
  const memory = refusal.readTensorFoldRefusal("warning: something\ntensorfold: one stream's 131072-token window of KV pages (8.00 GiB) does not fit the 5.12 GiB left under the load limit; lower --context\n", { window: 131_072, ladder })
  check('a memory refusal: the line verbatim, the need and the room read, the window stepped down to the rung whose cache fits the room (64k takes 4.0 GiB)', memory.kind === 'memory' && memory.needGib === 8 && memory.leftGib === 5.12 && memory.nextWindow === 65_536 && memory.cacheGibAt === 4 && memory.line.startsWith("one stream's 131072-token window"), JSON.stringify(memory))
  check('its next step names the window ↵ serves at', refusal.refusalNextStep(memory) === '↵ serves it at 64k')
  const family = refusal.readTensorFoldRefusal('tensorfold: nemotron_h: one stream at a 262144-token window takes 1.50 GiB, more than the 0.80 GiB left under the load limit; lower --context', { window: 262_144, ladder: fit.tensorFoldLadder(starting.NEMOTRON_LIGHTNING, MAC_48) })
  check('the shared Metal refusal reads the same way', family.kind === 'memory' && family.needGib === 1.5 && family.leftGib === 0.8 && family.nextWindow === 131_072, JSON.stringify(family))
  const q27 = refusal.readTensorFoldRefusal('tensorfold: --parallel 1 needs 8.00 GiB for its streams and 8-row prompt scratch at a 131072-token context; 5.12 GiB remains beside the weights and an 8 GiB margin: lower --parallel or --context', { window: 131_072, ladder })
  check("the 27B's own refusal: the room is what remains beside the weights", q27.kind === 'memory' && q27.needGib === 8 && q27.leftGib === 5.12 && q27.nextWindow === 65_536, JSON.stringify(q27))
  const need = fit.tensorFoldProjectedBytes(starting.QWEN_27B, 32_768)
  const gpu = refusal.readTensorFoldRefusal('tensorfold: --parallel 1 needs 2.00 GiB for its streams and 8-row prompt scratch at a 32768-token context; 0.50 GiB remains beside the weights and an 8 GiB margin: lower --parallel or --context', { window: 32_768, ladder: fit.tensorFoldLadder(starting.QWEN_27B, MAC_32_LOW), needBytes: need, machine: MAC_32_LOW })
  check("the GPU-limit reading: a memory refusal on a Mac whose working set is under the need becomes macOS's GPU limit", gpu.kind === 'gpu-limit' && gpu.wired !== undefined && gib1(gpu.wired.usableGib * GIB) === '21.3' && gpu.wired.limitMib === 0, JSON.stringify(gpu.wired))
  check('its words: TensorFold refused qwen3.8-27b at 32k · macOS lets the GPU wire 21.3 of 32.0 GiB (iogpu.wired_limit_mb 0) · it needs 22.5 GiB', refusal.refusedWords(gpu, 'qwen3.8-27b') === 'TensorFold refused qwen3.8-27b at 32k · macOS lets the GPU wire 21.3 of 32.0 GiB (iogpu.wired_limit_mb 0) · it needs 22.5 GiB', refusal.refusedWords(gpu, 'qwen3.8-27b'))
  const offer = gpu.wired!.offer!
  check('the sysctl line is printed, never run: sudo sysctl iogpu.wired_limit_mb=27174', refusal.wiredLimitCommand(offer) === 'sudo sysctl iogpu.wired_limit_mb=27174')
  check('its cost: the password, what it leaves macOS, resets at reboot, restart the engine after it, tight under 8 GiB', refusal.wiredLimitCostWords(offer) === 'asks for your password (sudo) · leaves 5.5 GiB for macOS · resets at reboot; restart the engine after it · tight — quit other apps first', refusal.wiredLimitCostWords(offer))
  const noOffer = refusal.readTensorFoldRefusal('tensorfold: --parallel 1 needs 2.00 GiB for its streams and 8-row prompt scratch at a 32768-token context; 0.50 GiB remains beside the weights and an 8 GiB margin: lower --parallel or --context', { window: 32_768, needBytes: 29 * GIB, machine: MAC_32_LOW })
  check('when the raise would leave macOS under 4 GiB: no sysctl, lower the window or choose a smaller model', noOffer.kind === 'gpu-limit' && noOffer.wired?.offer === null && refusal.refusalNextStep(noOffer) === 'lower the window or choose a smaller model')
  const cache = refusal.readTensorFoldRefusal("tensorfold: --prompt-cache-gib 1 would take this server past 70% of this Mac's memory: it holds 6.0 GiB once loaded, 70% of 8 GiB is 5.6 GiB, and 2 GiB stays free for prompt buffers, so 0 GiB is left for kept prompt states. Pass a smaller one, leave --prompt-cache-gib out for the default 0 GiB, or add --prompt-cache-over-cap to keep 1 GiB anyway.")
  check('the prompt-cache cap refusal is its own kind', cache.kind === 'cache-cap')
  check('not in the cache, the driver and an unknown family are read', refusal.readTensorFoldRefusal('tensorfold: x/y is not in the Hugging Face cache; the native engine does not download: run tensorfold pull x/y first').kind === 'not-pulled' && refusal.readTensorFoldRefusal("tensorfold: this NVIDIA driver runs CUDA 12.4, and TensorFold's GPU kernels need CUDA 13.0: install NVIDIA driver R580 or newer").kind === 'driver' && refusal.readTensorFoldRefusal('tensorfold: the native CUDA engine has no backend for llama checkpoints yet').kind === 'family')
  const killed = refusal.readTensorFoldRefusal('serving qwen3.5-2b at http://127.0.0.1:8080/v1 (loaded in 1.2s)\n', { exit: { code: null, signal: 'SIGKILL' } })
  check('a server killed after it served: exited, signal 9 (killed)', killed.kind === 'exited' && killed.line === 'signal 9 (killed)', JSON.stringify(killed))
  check('the last stderr line skips warnings and progress lines', refusal.lastStderrLine('warning: a\n[tensorfold] b\ntensorfold: the problem\n\n') === 'tensorfold: the problem')
}

section('the feed lines: one line each, the next move last, the support line on error receipts')
{
  check('serves', scene.FEED.serves('qwen3.5-2b', 262_144, 8080) === "● TensorFold serves qwen3.5-2b · 256k on 127.0.0.1:8080 · this session's model")
  check('serves on the next port', scene.FEED.servesElsewhere('qwen3.5-2b', 8081, 8080, 262_144) === '● TensorFold serves qwen3.5-2b on 127.0.0.1:8081 · 8080 was in use · 256k')
  check('pulled', scene.FEED.pulled('Qwen3.8 27B', 19_930_634_001) === '● TensorFold pulled Qwen3.8 27B · 20 GB · starting it', scene.FEED.pulled('Qwen3.8 27B', 19_930_634_001))
  check('stopped', scene.FEED.stopped('qwen3.5-2b') === '◌ TensorFold stopped qwen3.5-2b · /tensorfold serves it again')
  const refused = refusal.readTensorFoldRefusal("tensorfold: one stream's 262144-token window of KV pages (16.0 GiB) does not fit the 12.5 GiB left under the load limit; lower --context")
  check('refused, ending with c copies the support line', scene.FEED.refused('qwen3.8-27b', 262_144, refused) === '▲ TensorFold refused qwen3.8-27b at 256k (needs 16.0 GiB, 12.5 GiB left) · /tensorfold · c copies the support line', scene.FEED.refused('qwen3.8-27b', 262_144, refused))
  check('exited, ending with c copies the support line', scene.FEED.exited('qwen3.5-2b', 8080) === '▲ TensorFold exited · qwen3.5-2b on 127.0.0.1:8080 · /tensorfold starts it again · c copies the support line')
  check('not installed and not served carry their door', scene.FEED.notInstalled() === '▲ TensorFold is not installed · /tensorfold installs it' && scene.FEED.notServed('qwen3.5-2b') === '▲ qwen3.5-2b is not served · /tensorfold serves it')
  check('the port and GPU-limit receipts end with the support line too', scene.FEED.portBusy(8080).endsWith('· c copies the support line') && scene.FEED.gpuLimit('qwen3.8-27b', 32_768).endsWith('· c copies the support line') && scene.FEED.tight(30 * GIB, 10 * GIB, ['ollama stop frees its model']).includes('ollama stop frees its model'))
  check("the design's eight lines fit 96 columns; the two error receipts carry the support suffix past it (114 and 108 columns, named in the receipt)", [scene.FEED.serves('qwen3.5-2b', 262_144, 8080), scene.FEED.servesElsewhere('qwen3.5-2b', 8081, 8080, 262_144), scene.FEED.pulled('Qwen3.8 27B', 19_930_634_001), scene.FEED.stopped('qwen3.5-2b'), scene.FEED.notInstalled(), scene.FEED.notServed('qwen3.5-2b')].every(line => [...line].length <= 96) && [...scene.FEED.refused('qwen3.8-27b', 262_144, refused)].length === 114 && [...scene.FEED.exited('qwen3.5-2b', 8080)].length === 108, `${[...scene.FEED.refused('qwen3.8-27b', 262_144, refused)].length} ${[...scene.FEED.exited('qwen3.5-2b', 8080)].length}`)
  const words = scene.pullActOf(QWEN_27B_REPO, [{ at: 0, bytes: 0 }, { at: 10_000, bytes: 410_000_000 }], 19_930_634_001, 131_072)
  check('the pull act: the percent from the cache growth and the pace from the samples', words.kind === 'pulling' && words.percent === 2 && Math.round(words.pace.bytesPerSecond! / 1e6) === 41 && words.pace.secondsLeft !== undefined && Math.round(words.pace.secondsLeft / 60) === 8, JSON.stringify(words))
  check('the footer while pulling: pulling Qwen3.8 27B · 6.1 of 20 GB · 41 MB/s · about 6 min', pull.pullProgressWords('Qwen3.8 27B', 6.1e9, 19.93e9, { bytesPerSecond: 41e6, secondsLeft: 337 }) === 'pulling Qwen3.8 27B · 6.1 GB of 20 GB · 41 MB/s · about 6 min', pull.pullProgressWords('Qwen3.8 27B', 6.1e9, 19.93e9, { bytesPerSecond: 41e6, secondsLeft: 337 }))
  const hubGguf = await pull.readHubRepo('unsloth/Qwen3.5-9B-GGUF', { fetchImpl: (async () => { throw new Error('never fetched') }) as never })
  check("a GGUF repository is refused before any request: GGUF is llama.cpp's format · /localsetup serves it", 'refused' in hubGguf && hubGguf.refused === "GGUF is llama.cpp's format · /localsetup serves it")
  const notRepo = await pull.readHubRepo('qwen', {})
  check('not a repository id is refused', 'refused' in notRepo && notRepo.refused === 'not a repository id · owner/name')
  const hub = await pull.readHubRepo(QWEN_9B_REPO, { fetchImpl: (async (url: string) => new Response(String(url).includes('/api/models/') ? JSON.stringify({ siblings: [{ rfilename: 'model.safetensors', size: 5_950_221_072 }, { rfilename: 'config.json', size: 1_000 }] }) : JSON.stringify({ model_type: 'qwen3_5', max_position_embeddings: 262144, num_hidden_layers: 32, num_key_value_heads: 4, head_dim: 256, full_attention_interval: 4 }), { status: 200 })) as never, families: new Set(['qwen3_5']) })
  check('a readable repository: sized from the Hub, its family from config.json, the opt-in prompt cache for qwen3_5', 'checkpoint' in hub && hub.checkpoint.weightsBytes === 5_950_221_072 && hub.checkpoint.family === 'qwen3_5' && hub.checkpoint.kvBytesPerToken === 8 * 4 * 256 * 4 && hub.checkpoint.promptCacheGib === 1 && hub.checkpoint.shortName === 'qwen3.5-9b', JSON.stringify(hub))
  const unknown = await pull.readHubRepo('x/y-MLX-4bit', { fetchImpl: (async (url: string) => new Response(String(url).includes('/api/models/') ? JSON.stringify({ siblings: [{ rfilename: 'model.safetensors', size: 10 }] }) : JSON.stringify({ model_type: 'llama' }), { status: 200 })) as never, families: new Set(['qwen3_5']) })
  check('a family the engine lacks is refused with the family named', 'refused' in unknown && unknown.refused === 'TensorFold has no engine for llama checkpoints')
}

console.log(`\n${failures === 0 ? 'GREEN' : `RED (${failures})`}: TensorFold engine, machine, install, fit, refusals and words`)
process.exit(failures === 0 ? 0 : 1)
