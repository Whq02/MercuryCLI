#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, releaseScratchHome, settle, waitFor } from '../lib/settingsPopupHarness.ts'
import { FAKE_BIN, GIB, MAC_32_LOW, MAC_48, QWEN_27B_REPO, QWEN_2B_REPO, fakeExists, fakeWorld } from './fixtures/world.ts'
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
  writeFileSync(join(FRAMES, `${name}-${columns}x${rows}.txt`), lines.join('\n') + '\n')
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
      check('the three starting rows: the 27B first (the best fit, framed), Lightning, the 2B; the other-checkpoint row; the HOST group beneath', lines.some(line => line.includes('Qwen3.8 27B') && line.includes('local/qwen3.8-27b') && line.includes('128k ctx')) && lines.some(line => line.includes('Nemotron Lightning')) && lines.some(line => line.includes('Qwen3.5 2B') && line.includes('256k ctx')) && lines.some(line => line.includes('other checkpoint — a Hugging Face repository id')) && lines.some(line => line.includes('TENSORFOLD HOST · no host · a server on your network or a rented GPU pod')), lines.filter(line => line.trim() !== '').join(' | '))
      check('the live footer line: nothing served · Metal', lines.some(line => line.includes('nothing served · Metal')))
      check('the framed card shows what ↵ will run (the pulls, then the serve with its drafter, name, window and port)', joined.replace(/\s+/g, ' ').includes(`tensorfold serve ${QWEN_27B_REPO} --drafter z-lab/Qwen3.8-27B-DFlash2 --name qwen3.8-27b --context 131072 --port ${port}`), joined.split('\n').filter(line => line.includes('tensorfold')).join(' | '))
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
  check("s on this session's model asks once more (the stop-confirm act), the server still up", road.tensorFoldRoadState().acts[QWEN_2B_REPO]?.kind === 'stop-confirm' && serve.servedTensorFold({ servedFile }).length === 1)
  await panel.onTensorFoldAct({ kind: 'stop', row }, facts, io.road as never)
  check('s again stops it through stopService; the stopped receipt carries the door', serve.servedTensorFold({ servedFile }).length === 0 && seen.some(r => r.text === '◌ TensorFold stopped qwen3.5-2b · /tensorfold serves it again'), JSON.stringify(seen.map(r => r.text)))
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

await releaseScratchHome(home)
console.log(`\n${failures === 0 ? 'GREEN' : `RED (${failures})`}: the /tensorfold panel through the harness`)
process.exit(failures === 0 ? 0 : 1)
