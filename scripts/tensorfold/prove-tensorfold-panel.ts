#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, releaseScratchHome, settle, waitFor } from '../lib/settingsPopupHarness.ts'
import { FAKE_BIN, GIB, LIGHTNING_REPO, MAC_32_LOW, MAC_48, QWEN_27B_REPO, QWEN_2B_REPO, RTX_4090, fakeExists, fakeWorld } from './fixtures/world.ts'
import { FAKE_REPLY_PREFIX } from './fixtures/fake-tensorfold.ts'

const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const FRAMES = argAfter('--frames')
if (FRAMES !== undefined) mkdirSync(FRAMES, { recursive: true })
const home = pinScratchHome('tensorfold-panel')
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_LOCAL_API_KEY
delete process.env.MERCURY_LOCAL_BASE_URL

const React = await import('react')
const h = React.createElement
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { Box } = await import('../../src/ink.ts')
const { AppStateProvider } = await import('../../src/state/AppState.tsx')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
const { builtinCommands, commandSeat } = await import('../../src/commands.ts')
const panel = await import('../../src/commands/tensorfold/tensorfold.tsx')
const road = await import('../../src/commands/tensorfold/road.ts')
const engine = await import('../../src/services/tensorfold/engine.ts')
const serve = await import('../../src/services/tensorfold/serve.ts')
const receipts = await import('../../src/utils/model/seatReceipts.ts')
const scene = await import('../../src/commands/tensorfold/scene.ts')
const refusal = await import('../../src/services/tensorfold/refusal.ts')
const fit = await import('../../src/services/tensorfold/fit.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title)
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
const save = (name: string, columns: number, rows: number, lines: string[]): void => {
  if (FRAMES === undefined) return
  writeFileSync(join(FRAMES, `${name}-${columns}x${rows}.txt`), lines.map(line => line.replace(/\s+$/, '')).join('\n') + '\n')
}
const SIZES: Array<[number, number]> = [[160, 48], [110, 34], [96, 30]]
const shell = (columns: number, rows: number, child: unknown): unknown => h(AppStateProvider as never, {}, h(ThemeProvider as never, {}, h(Box, { flexDirection: 'column', width: columns, height: rows, justifyContent: 'center' }, child as never)))
const seen: Array<{ text: string; level: string; copyText?: string }> = []
receipts.subscribeSeatReceipts(r => seen.push(r))
engine.__pinTensorFoldMachineForTest(MAC_48)
const binary = `${FAKE_BIN}/tensorfold`

section('the command: /tensorfold is registered as a screen command that opens the picker popup')
{
  const command = builtinCommands().find(candidate => candidate.name === 'tensorfold')
  check('registered in src/commands.ts as a local-jsx command on the screen seat', command !== undefined && command.type === 'local-jsx' && commandSeat(command) === 'screen', JSON.stringify(command && { type: command.type, name: command.name }))
  check('its words name the road and take a repository id', command?.description === 'Serve a local model with TensorFold: install, pull, serve, stop, switch' && command.argumentHint === '[repository]')
}

section('the panel through the harness: the two groups, TENSORFOLD unfolded, the live footer; ↓ to the 2B, ↵ serves and switches; esc closes')
{
  const world = fakeWorld('tf-panel')
  const servedFile = join(world.home, 'served.json')
  const port = await freePort()
  writeFileSync(servedFile, JSON.stringify({ repo: '', name: '', port, window: 0, pid: 0, startedAt: '', project: join(world.root, 'never') }))
  const copied: string[] = []
  let switched = ''
  const io = {
    facts: { cacheRoot: world.cache, machine: MAC_48, env: world.env, home: world.home, platform: 'darwin' as const, exists: fakeExists, servedFile, localModels: () => [], hosts: () => [], app: async () => ({ running: false }), diskFreeBytes: () => 37_578_240_000 },
    road: {
      serve: { binary, cwd: world.cwd, sessionId: 'proof', env: world.env, serviceEnv: world.serviceEnv, servedFile, machine: MAC_48, freeMemoryBytes: async () => 40 * GIB, answersAs: async () => undefined, exists: fakeExists } as never,
      prove: { env: { ...world.env, MERCURY_LOCAL_PROBE_TARGETS: 'none' }, persist: (setting: string) => { switched = setting; return { sentence: ' · saved' } }, setAppState: () => undefined, focusedConnector: () => ({ carrier: 'in-process' }) as never },
      supportLine: async () => 'TensorFold 1.2.2 · Metal · Apple M5 Pro · fixture',
      copy: async (text: string) => { copied.push(text) },
    },
    current: () => (switched === '' ? 'claude-opus-5-5' : switched),
  }
  road.__resetTensorFoldRoadForTest()
  let closed: string | undefined
  for (const [columns, rows] of SIZES) {
    const m = await mountOffscreen(shell(columns, rows, h(panel.TensorFoldPanel as never, { onDone: (words?: string) => { closed = words }, io } as never)), columns, rows)
    const up = await waitFor(() => m.lines().some(line => line.includes('TENSORFOLD')), 10_000)
    await settle(300)
    const lines = m.lines()
    save('t06-opened', columns, rows, lines)
    if (columns === 160) {
      check('the panel opens with the TENSORFOLD group unfolded and its status words', up && lines.some(line => line.includes('TENSORFOLD · 1.2.2 · Apple M5 Pro · 36.0 GiB usable · nothing served')), lines.filter(line => line.trim() !== '').slice(0, 12).join(' | '))
      const joined = lines.map(line => line.replace(/[│╭╮╰╯─]/g, ' ').trim()).join('\n')
      check('the three starting rows: Lightning first (the 48 GB default, framed), the 27B, the 2B; the other-checkpoint row; the HOST group beneath', lines.findIndex(line => line.includes('Nemotron Lightning')) < lines.findIndex(line => line.includes('Qwen3.8 27B')) && lines.some(line => line.includes('Qwen3.8 27B') && line.includes('local/qwen3.8-27b') && line.includes('128k ctx')) && lines.some(line => line.includes('Nemotron Lightning') && line.includes('256k ctx')) && lines.some(line => line.includes('Qwen3.5 2B') && line.includes('256k ctx')) && lines.some(line => line.includes('other checkpoint — a Hugging Face repository id')) && lines.some(line => line.includes('TENSORFOLD HOST · no host · a server on your network or a rented GPU pod')), lines.filter(line => line.trim() !== '').join(' | '))
      check('the live footer line: nothing served · Metal', lines.some(line => line.includes('nothing served · Metal')))
      check('the framed card shows what ↵ will run (the pull, then the serve with its name, window and port)', joined.replace(/\s+/g, ' ').includes(`tensorfold pull ${LIGHTNING_REPO}`) && joined.replace(/\s+/g, ' ').includes(`tensorfold serve ${LIGHTNING_REPO} --name nemotron-lightning --context 262144 --port ${port}`), joined.split('\n').filter(line => line.includes('tensorfold')).join(' | '))
    } else {
      check(`${columns}×${rows}: the panel fits the width (no line wider than the terminal)`, up && lines.every(line => [...line].length <= columns), String(lines.find(line => [...line].length > columns)))
    }
    m.unmount()
    await settle(100)
  }
  const [columns, rows] = SIZES[0]!
  const m = await mountOffscreen(shell(columns, rows, h(panel.TensorFoldPanel as never, { onDone: (words?: string) => { closed = words }, io } as never)), columns, rows)
  await waitFor(() => m.lines().some(line => line.includes('TENSORFOLD')), 10_000)
  await settle(300)
  m.push(KEY.down)
  await settle(200)
  m.push(KEY.down)
  await settle(300)
  const framed = m.lines()
  const framedJoined = framed.map(line => line.replace(/[│╭╮╰╯─]/g, ' ').trim()).join(' ').replace(/\s+/g, ' ')
  check('↓ ↓ frames the 2B on disk; its card runs the serve with --prompt-cache-gib 1 on the remembered port', framedJoined.includes(`tensorfold serve ${QWEN_2B_REPO} --name qwen3.5-2b --context 262144 --prompt-cache-gib 1 --port ${port}`), framed.filter(line => line.includes('tensorfold serve') || line.includes('--prompt-cache-gib')).join(' | '))
  save('t09-on-disk', columns, rows, framed)
  m.push(KEY.enter)
  const served = await waitFor(() => m.lines().some(line => line.includes('serving qwen3.5-2b on 127.0.0.1:')), 20_000)
  await settle(400)
  const after = m.lines()
  save('t14-current', columns, rows, after)
  const record = serve.servedTensorFold({ servedFile })
  check('↵ served the 2B on the remembered port and the footer says serving qwen3.5-2b on 127.0.0.1:<port>', served && record.length === 1 && record[0]!.name === 'qwen3.5-2b' && record[0]!.port === port && after.some(line => line.includes(`serving qwen3.5-2b on 127.0.0.1:${port}`)), after.filter(line => line.includes('serving')).join(' | '))
  check('the heading now says 1 serving and the served row is first, current', after.some(line => line.includes('· 1 serving')) && after.some(line => line.includes('Qwen3.5 2B') && line.includes('current')), after.filter(line => line.includes('Qwen3.5 2B') || line.includes('serving')).join(' | '))
  check('the session switched through pickAndProve to local/qwen3.5-2b with a reply from the server', switched === 'local/qwen3.5-2b', switched)
  check("the feed got ● TensorFold serves qwen3.5-2b · 256k on 127.0.0.1:<port> · this session's model", seen.some(r => r.text.startsWith('● TensorFold serves qwen3.5-2b · 256k on 127.0.0.1:') && r.text.endsWith("· this session's model")), JSON.stringify(seen.map(r => r.text)))
  m.push(KEY.esc)
  await settle(300)
  check('esc closes the panel with the live line as its words, and the server keeps serving', closed !== undefined && closed.startsWith('serving qwen3.5-2b on 127.0.0.1:') && serve.servedTensorFold({ servedFile }).length === 1, String(closed))
  m.unmount()
  const facts = await scene.readTensorFoldPanelFacts({ ...io.facts, current: 'local/qwen3.5-2b' }, road.tensorFoldRoadState())
  const row = facts.rows[0]!
  await panel.onTensorFoldAct({ kind: 'stop', row }, facts, io.road as never)
  check("the stop act (the picker sends it after its own s-again confirm on the session's model) stops it through stopService; the stopped receipt carries the door", serve.servedTensorFold({ servedFile }).length === 0 && seen.some(r => r.text === '◌ TensorFold stopped qwen3.5-2b · /tensorfold serves it again'), JSON.stringify(seen.map(r => r.text)))
  await panel.onTensorFoldAct({ kind: 'support', row, window: 262_144 }, facts, io.road as never)
  check('c copies the support line through the clipboard seam (focused on the framed row)', copied[copied.length - 1] === 'TensorFold 1.2.2 · Metal · Apple M5 Pro · fixture' && road.tensorFoldRoadState().notice === 'copied the support line', JSON.stringify(copied))
  await panel.onTensorFoldAct({ kind: 'limit', row: facts.rows[1]!, line: 'sudo sysctl iogpu.wired_limit_mb=27174' }, facts, io.road as never)
  check('w copies the sysctl line — never runs it — and says what to do with it', copied[copied.length - 1] === 'sudo sysctl iogpu.wired_limit_mb=27174' && road.tensorFoldRoadState().notice === 'copied · run it in a terminal (it asks for your password) · then /tensorfold again', String(road.tensorFoldRoadState().notice))
  await panel.onTensorFoldAct({ kind: 'read', repo: 'unsloth/Qwen3.5-9B-GGUF' }, facts, { ...io.road, readHub: async () => ({ refused: "GGUF is llama.cpp's format · /localsetup serves it" }) } as never)
  check("other checkpoint: a GGUF id is refused with GGUF is llama.cpp's format · /localsetup serves it", road.tensorFoldRoadState().other?.refused === "GGUF is llama.cpp's format · /localsetup serves it")
  await panel.onTensorFoldAct({ kind: 'app', serving: 'qwen3.8-27b' }, facts, io.road as never)
  check("the app row: the app is serving X · paste from its API tab · quit the app first to serve with Mercury instead", road.tensorFoldRoadState().notice === 'the app is serving qwen3.8-27b · paste from its API tab · quit the app first to serve with Mercury instead')
  seen.length = 0
  road.__resetTensorFoldRoadForTest()
  const refuseIo = { ...io.road, serve: { ...(io.road.serve as object), serviceEnv: { ...world.serviceEnv, FAKE_TENSORFOLD_SERVE: 'refuse-memory' } } }
  const fresh = await scene.readTensorFoldPanelFacts(io.facts, road.tensorFoldRoadState())
  const handover = await import('../../src/substrate/splashHandover.ts')
  handover.armTensorFoldDeepLink()
  check('the sign-in list\'s TensorFold row arms the ask through the deep link it dispatches; picking another sign-in disarms both', handover.consumeFirstRunServeAsk() === true && (handover.armTensorFoldDeepLink(), handover.disarmTensorFoldDeepLink(), handover.consumeFirstRunServeAsk()) === false)
  handover.armTensorFoldDeepLink()
  const seenBeforeAsk = seen.length
  await panel.onTensorFoldAct({ kind: 'serve', row: fresh.rows.find(candidate => candidate.repo === QWEN_2B_REPO)!, window: 262_144 }, fresh, refuseIo as never)
  const asked = await scene.readTensorFoldPanelFacts(io.facts, road.tensorFoldRoadState())
  check('first run (the sign-in list sent the user here): the first ↵ on a model row serves nothing and asks for a second — the notice names the download, the load into memory and esc', road.tensorFoldRoadState().notice === 'first run: ↵ again loads Qwen3.5 2B (1.7 GB) into memory · esc leaves this machine as it is' && asked.acts[QWEN_2B_REPO] === undefined && seen.length === seenBeforeAsk, `${String(road.tensorFoldRoadState().notice)} · acts ${JSON.stringify(asked.acts[QWEN_2B_REPO] ?? null)} · receipts +${seen.length - seenBeforeAsk}`)
  check('the ask is spent by that one ↵: nothing is armed for the next', handover.consumeFirstRunServeAsk() === false)
  handover.armFirstRunServeAsk()
  const big = fresh.rows.find(candidate => candidate.repo === QWEN_27B_REPO)!
  const { bytesWords } = await import('../../src/services/host/bank.ts')
  const seenBeforeBig = seen.length
  await panel.onTensorFoldAct({ kind: 'serve', row: big, window: 262_144 }, fresh, refuseIo as never)
  check('a row not yet pulled: the ask names the download the row itself shows (the drafter included) and the memory the weights take, in the row\'s own units', big.state === 'not-pulled' && big.downloadBytes !== undefined && road.tensorFoldRoadState().notice === `first run: ↵ again downloads ${bytesWords(big.downloadBytes)} and loads ${big.label} (${bytesWords(big.checkpoint.weightsBytes)}) into memory · esc leaves this machine as it is` && seen.length === seenBeforeBig, `${String(road.tensorFoldRoadState().notice)} · state ${big.state} · ↓ ${String(big.downloadBytes)}`)
  await panel.onTensorFoldAct({ kind: 'serve', row: fresh.rows.find(candidate => candidate.repo === QWEN_2B_REPO)!, window: 262_144 }, fresh, refuseIo as never)
  const refused = await scene.readTensorFoldPanelFacts(io.facts, road.tensorFoldRoadState())
  const warning = seen.find(r => r.level === 'warning')
  check('a refusal from the engine: the row shows refused with the window ↵ serves at; the receipt ends with c copies the support line and carries the line as copy text; the footer legend offers c only now', refused.acts[QWEN_2B_REPO]?.kind === 'refused' && refused.copySupportOffered && warning?.text.endsWith('· /tensorfold · c copies the support line') === true && warning.copyText === 'TensorFold 1.2.2 · Metal · Apple M5 Pro · fixture', JSON.stringify(warning))
  const m2 = await mountOffscreen(shell(columns, rows, h(panel.TensorFoldPanel as never, { onDone: () => undefined, io } as never)), columns, rows)
  await waitFor(() => m2.lines().some(line => line.includes('refused')), 10_000)
  await settle(300)
  save('t17-refused', columns, rows, m2.lines())
  const refusedLines = m2.lines()
  const framedAt = refusedLines.findIndex(line => line.includes('Qwen3.5 2B') && line.includes('local/qwen3.5-2b'))
  check("the panel lands on the refused row and its card shows the engine's line", framedAt >= 0 && refusedLines.slice(framedAt, framedAt + 3).some(line => line.includes('refused')) && refusedLines.some(line => line.includes('one stream at a 262144-token window takes 16.00 GiB')), refusedLines.filter(line => line.includes('refused') || line.includes('Qwen3.5 2B')).join(' | '))
  m2.unmount()
  road.__resetTensorFoldRoadForTest()
  const need = fit.tensorFoldProjectedBytes(fresh.rows.find(candidate => candidate.repo === QWEN_27B_REPO)!.checkpoint, 32_768)
  const limit = refusal.readTensorFoldRefusal('tensorfold: --parallel 1 needs 2.00 GiB for its streams and 8-row prompt scratch at a 32768-token context; 0.50 GiB remains beside the weights and an 8 GiB margin: lower --parallel or --context', { window: 32_768, needBytes: need, machine: MAC_32_LOW })
  const limited = await scene.readTensorFoldPanelFacts({ ...io.facts, machine: MAC_32_LOW }, { acts: { [QWEN_27B_REPO]: scene.refusedActOf('qwen3.8-27b', 32_768, limit) } })
  const m3 = await mountOffscreen(shell(columns, rows, h(panel.TensorFoldPanel as never, { onDone: () => undefined, io: { ...io, facts: { ...io.facts, machine: MAC_32_LOW } } } as never)), columns, rows)
  road.__resetTensorFoldRoadForTest()
  await settle(50)
  ;(road as unknown as { __setActForTest?: unknown }).__setActForTest
  m3.unmount()
  check('the GPU-limit refusal renders the sysctl line and its cost in the card data', limited.acts[QWEN_27B_REPO]?.kind === 'refused' && (limited.acts[QWEN_27B_REPO] as { command?: string }).command === 'sudo sysctl iogpu.wired_limit_mb=27174')
}

section('an installed engine older than the supported release: one line names the newer one and the command that moves to it, and nothing acts')
{
  const world = fakeWorld('tf-newer')
  const servedFile = join(world.home, 'served.json')
  const brewAt = '/opt/homebrew/bin/brew'
  const withBrew = (path: string): boolean => fakeExists(path) || path === brewAt
  const base = { cacheRoot: world.cache, machine: MAC_48, env: world.env, home: world.home, platform: 'darwin' as const, exists: withBrew, servedFile, localModels: () => [], hosts: () => [], app: async () => ({ running: false }), diskFreeBytes: () => 37_578_240_000, keyedAt: async () => false }
  const found = await engine.findTensorFoldEngine({ ...base, exists: fakeExists })
  const supported = (await import('../../src/services/tensorfold/starting.ts')).TENSORFOLD_RELEASE
  const LINE = `TensorFold ${supported} is supported, 1.2.2 is installed · brew upgrade ashhart/tensorfold/tensorfold`
  check('the fixture engine is 1.2.2 and the build supports a newer release', found !== null && found.version === '1.2.2' && supported === '1.2.5', `${found?.version} ${supported}`)
  const page = (await import('node:fs')).readFileSync(join(import.meta.dir, '..', '..', 'docs', 'TENSORFOLD.md'), 'utf8')
  check('the page shows the line with the release this build supports and says Mercury upgrades nothing itself', page.includes(`\`${LINE}\``) && /serves\s+the\s+installed\s+engine\s+as\s+it\s+stands\s+and\s+upgrades\s+nothing\s+itself/.test(page), 'docs/TENSORFOLD.md')
  const older = await scene.readTensorFoldPanelFacts(base)
  check('on a Mac with Homebrew the line names the supported release, the installed one and brew upgrade with the formula', older.newer === LINE, String(older.newer))
  const at = async (version: string): Promise<string | undefined> => (await scene.readTensorFoldPanelFacts({ ...base, engine: { ...found!, version } })).newer
  const none = [await at(supported), await at('1.3.0'), await at('2.0'), await at('unknown'), await at('1.2.5-rc1')]
  check('an engine at the supported release, a newer one and a version that is no dotted number get no line', none.every(line => line === undefined), JSON.stringify(none))
  const [patch, minor, short] = [await at('1.2.4'), await at('1.1.9'), await at('1.2')]
  check('1.2.4, 1.1.9 and 1.2 are each older than 1.2.5', [patch, minor, short].every((line, i) => line === LINE.replace('1.2.2 is installed', `${['1.2.4', '1.1.9', '1.2'][i]} is installed`)), JSON.stringify([patch, minor, short]))
  const absent = await scene.readTensorFoldPanelFacts({ ...base, engine: null })
  check('with no engine installed there is no line: the install row stands as before', absent.newer === undefined && absent.engine === null, String(absent.newer))
  const noBrew = await scene.readTensorFoldPanelFacts({ ...base, exists: fakeExists })
  check('an engine on a Mac where Homebrew is not found gets no line: Mercury names no command it would not run', noBrew.newer === undefined, String(noBrew.newer))
  const linux = await scene.readTensorFoldPanelFacts({ ...base, platform: 'linux' as const, machine: RTX_4090, arch: 'x64', engine: found })
  check('on Linux the command is the release archive\'s own install, in the runtime folder', linux.newer !== undefined && linux.newer.startsWith(`TensorFold ${supported} is supported, 1.2.2 is installed · cd ~/`) && linux.newer.includes(`curl -fLO https://github.com/ashhart/TensorFold/releases/download/v${supported}/`) && linux.newer.includes(' && sha256sum -c ') && linux.newer.includes(' && tar -xzf '), String(linux.newer))
  const adapter = await scene.readTensorFoldPanelFacts({ ...base, engine: { ...found!, servedBy: 'mercury-llamacpp' } })
  check('the adapter\'s engine gets no line', adapter.newer === undefined, String(adapter.newer))
  road.__resetTensorFoldRoadForTest()
  const io = { facts: base, road: {}, current: () => 'claude-opus-5-5' }
  const [columns, rows] = SIZES[0]!
  const m = await mountOffscreen(shell(columns, rows, h(panel.TensorFoldPanel as never, { onDone: () => undefined, io } as never)), columns, rows)
  await waitFor(() => m.lines().some(line => line.includes('TENSORFOLD')), 10_000)
  await settle(300)
  const lines = m.lines()
  save('t18-newer-engine', columns, rows, lines)
  check('the panel paints the line once, on one row, and the heading and the live footer stand as before', lines.filter(line => line.includes(LINE)).length === 1 && lines.filter(line => line.includes('brew upgrade')).length === 1 && lines.some(line => line.includes('TENSORFOLD · 1.2.2 · Apple M5 Pro · 36.0 GiB usable · nothing served')) && lines.some(line => line.includes('nothing served · Metal')), lines.filter(line => line.includes('supported') || line.includes('nothing served')).join(' | '))
  check('nothing acts: no install, pull or serve is in flight and the road holds no notice of its own', Object.keys(road.tensorFoldRoadState().acts).length === 0 && road.tensorFoldRoadState().notice === undefined, JSON.stringify(road.tensorFoldRoadState()))
  m.unmount()
  await settle(100)
  const narrow = SIZES[2]!
  const m2 = await mountOffscreen(shell(narrow[0], narrow[1], h(panel.TensorFoldPanel as never, { onDone: () => undefined, io } as never)), narrow[0], narrow[1])
  await waitFor(() => m2.lines().some(line => line.includes('TENSORFOLD')), 10_000)
  await settle(300)
  const narrowLines = m2.lines()
  save('t18-newer-engine', narrow[0], narrow[1], narrowLines)
  const narrowText = narrowLines.map(line => line.replace(/[│╭╮╰╯─]/g, ' ').trim()).join(' ').replace(/\s+/g, ' ')
  check(`${narrow[0]}×${narrow[1]}: the command stays whole and no row is wider than the terminal`, narrowText.includes('brew upgrade ashhart/tensorfold/tensorfold') && narrowLines.every(line => [...line].length <= narrow[0]), narrowLines.filter(line => line.includes('brew') || line.includes('supported')).join(' | '))
  m2.unmount()
  road.__resetTensorFoldRoadForTest()
  road.setTensorFoldNotice('serving qwen3.5-2b on 127.0.0.1:8080 · switched')
  const m3 = await mountOffscreen(shell(columns, rows, h(panel.TensorFoldPanel as never, { onDone: () => undefined, io } as never)), columns, rows)
  await waitFor(() => m3.lines().some(line => line.includes('TENSORFOLD')), 10_000)
  await settle(300)
  const noticed = m3.lines()
  check("a notice of the panel's own action takes the line's place while it stands", noticed.some(line => line.includes('serving qwen3.5-2b on 127.0.0.1:8080 · switched')) && !noticed.some(line => line.includes('brew upgrade')), noticed.filter(line => line.includes('switched') || line.includes('brew')).join(' | '))
  m3.unmount()
  road.__resetTensorFoldRoadForTest()
}

await releaseScratchHome(home)
console.log(`\n${failures === 0 ? 'GREEN' : `RED (${failures})`}: the /tensorfold panel through the harness`)
process.exit(failures === 0 ? 0 : 1)
