import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { runpodFixture, fakeSshRunner } from './runpodFixture.mjs'
import { gridToPng } from '../ui/gridToPng.ts'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const option = (name: string): string | undefined => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1] }
const frames = option('--frames')
if (frames) mkdirSync(frames, { recursive: true })
let checks = 0
const check = (name: string, truth: unknown): void => { assert.ok(truth, name); checks++; console.log('PASS ' + name) }
const bundle = option('--bundle')
if (bundle) {
  const { runArtifactArena, grabScreens } = await import('../streaming/artifactArena.ts')
  const { vshotBudgetMs } = await import('../lib/captureDriver.ts')
  const arena = await runArtifactArena({ distPath: bundle, turns: [], sends: ['4500:/llmhost', '5300:\r'], seconds: 14, cols: 120, rows: 44, keep: true })
  try {
    const shots = grabScreens(arena, 120, 44, [7000, 9000, 11000, 13000].map(vshotBudgetMs))
    if (frames) shots.forEach((shot, index) => writeFileSync(join(frames, 'bundle-' + index + '.txt'), shot.rows.join('\n')))
    check('built /llmhost opens the three-door popup', shots.some(shot => shot.rows.join(' ').includes('Where should the model run?')))
    check('built popup includes rental, SSH and existing-server roads', shots.some(shot => { const text = shot.rows.join(' '); return text.includes('Rent a GPU') && text.includes('reach by SSH') && text.includes('already running') }))
  } finally { arena.cleanup() }
}
const f = await llmhostFixture()
const rp = await runpodFixture()
let mounted: Mounted | undefined
let ssh: ReturnType<typeof fakeSshRunner> | undefined
try {
  const React = await import('react')
  const { Box } = await import('../../src/ink.ts')
  const { AppStateProvider } = await import('../../src/state/AppState.tsx')
  const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
  const { SettingsPopupSlot } = await import('../../src/components/SettingsPopupSlot.tsx')
  const popup = await import('../../src/utils/cockpit/settingsPopup.ts')
  const { llmHostPopupRequest } = await import('../../src/commands/llmhost/llmhost.tsx')
  const { createHostRoad } = await import('../../src/services/host/index.ts')
  const { hostRunner } = await import('../../src/services/host/ssh.ts')
  const { namedCompatModelOptions } = await import('../../src/services/providers/openaicompat/compatCatalogue.ts')
  const { RunpodClient } = await import('../../src/services/host/runpod.ts')
  f.state.dialect = 'sglang'; f.state.window = 524288
  ssh = fakeSshRunner(f.baseUrl, hostRunner)
  const road = createHostRoad({ apiBaseUrl: rp.baseUrl, runner: ssh.runner, pauseMs: 5, readyTimeoutMs: 2000 })
  const open = () => popup.openSettingsPopup(llmHostPopupRequest(road))
  open()
  mounted = await mountOffscreen(React.createElement(AppStateProvider, {}, React.createElement(ThemeProvider, {}, React.createElement(Box, { flexDirection: 'column', width: 120, height: 44 }, React.createElement(SettingsPopupSlot)))), 120, 44)
  const m = mounted
  const until = async (needle: string) => assert.ok(await waitFor(() => m.screen().includes(needle), 15_000), 'screen reaches ' + needle + '\n' + m.screen())
  const heading = async (needle: string) => assert.ok(await waitFor(() => m.lines().slice(0, 4).join(' ').includes(needle), 15000), 'active question reaches ' + needle + '\n' + m.screen())
  const images: Promise<unknown>[] = []
  const capture = (name: string) => {
    check(name + ' paints without errors or a key', !m.screen().includes('RENDER ERROR') && !m.screen().includes(rp.key))
    if (frames) {
      writeFileSync(join(frames, name + '.txt'), m.screen())
      const grid = m.lines().map((line, y) => Array.from(line.padEnd(120)).map((c, x) => { const style = m.styleAt(x, y); return { c, bg: style?.bg ?? 'default', fg: style?.fg ?? 'default', bold: style?.bold ?? false, rev: style?.inverse ?? false } }))
      const path = join(frames, name + '.json')
      writeFileSync(path, JSON.stringify({ grid, cols: 120, rows: 44 }))
      images.push(gridToPng(path, join(frames, name + '.png')))
    }
  }
  const choose = async (needle: string) => {
    for (let n = 0; n < 40; n++) {
      const selected = m.lines().find(line => line.includes('› ')) ?? ''
      if (selected.includes(needle)) { m.push(KEY.enter); return }
      m.push(KEY.down)
      assert.ok(await waitFor(() => (m.lines().find(line => line.includes('› ')) ?? '') !== selected, 5000), 'selection moves toward ' + needle + '\n' + m.screen())
    }
    throw new Error('Missing choice ' + needle)
  }
  const text = async (title: string, value = '') => { await until(title); if (value) { m.push(value); await until(value) } m.push(KEY.enter) }
  const close = async () => { m.push(KEY.esc); if (!await waitFor(() => !popup.isSettingsPopupOpen(), 1000)) m.push(KEY.esc); assert.ok(await waitFor(() => !popup.isSettingsPopupOpen(), 5000)) }
  const tail = async (name?: string) => {
    await heading('4 · choose the model'); await until('524,288 tokens'); await choose(f.model)
    await heading('5 · name the provider')
    if (name) { m.push('\u0015'); m.push(name); await until(name) }
    m.push(KEY.enter)
    await heading('5 · register and check a reply'); await choose('register and check')
    await until('LLMHOST-READY')
  }
  await heading('Where should the model run?'); capture('01-three-doors')
  await choose('Rent a GPU')
  await until('Runpod API key'); m.push(rp.key); await until('********'); capture('02-masked-runpod-key'); m.push(KEY.enter)
  await text('Optional spending budget', '70')
  await until('live Runpod stock'); await until('$31.96/hr'); await until('1× B300'); capture('03-live-offers')
  check('live offers do not include unavailable GB300', !m.screen().includes('GB300'))
  check('listing offers creates nothing', rp.state.creates === 0)
  await choose('NVFP4 · 4× B200')
  await heading('Confirm the hourly price'); await until('community recipe'); await until('524,288'); capture('04-price-confirm')
  check('separate confirmation precedes all paid work', rp.state.creates === 0 && ssh.commands.length === 0)
  await choose('Confirm $31.96/hr')
  await tail()
  await heading('Pod controls'); await until('so far'); capture('05-provider-and-meter')
  check('the model picker catalogue contains the registered provider', namedCompatModelOptions().some(row => row.value === 'compat/llmhost/' + f.model))
  const settingsRaw = readFileSync(join(f.home, 'settings.json'), 'utf8')
  const settings = JSON.parse(settingsRaw)
  check('registration retains SGLang dialect and affinity', settings.compatProvider.llmhost.dialect === 'sglang' && settings.compatProvider.llmhost.sessionAffinityHeader === 'x-session-id')
  check('Runpod key never reaches settings, URL, or SSH commands', !settingsRaw.includes(rp.key) && !JSON.stringify(rp.requests).includes(rp.key) && !JSON.stringify(ssh.commands).includes(rp.key))
  check('account keys are not replaced; public key injected into pod', rp.state.keys.length === 0 && rp.state.createBodies[0].env.PUBLIC_KEY.startsWith('ssh-ed25519 '))
  check('private key exists with owner-only permissions', existsSync(join(f.home, 'host/keys/id_ed25519')) && (statSync(join(f.home, 'host/keys/id_ed25519')).mode & 0o777) === 0o600)
  check('remote engine starts in tmux on loopback with documented model', ssh.commands.some((c: any) => c.command === 'ssh' && c.args.at(-1).includes('tmux new-session') && c.args.at(-1).includes('RadixArk/GLM-5.3-Flash-NVFP4') && c.args.at(-1).includes('127.0.0.1')))
  check('local tunnel is a real child forwarder', ssh.commands.some((c: any) => c.command === 'tunnel'))
  const firstBase = settings.compatProvider.llmhost.baseUrl
  await choose('Reconnect the tunnel'); await heading('4 · choose the model'); await choose(f.model); await heading('5 · register and check a reply'); await choose('register and check'); await heading('Pod controls'); await until('Keep running and close')
  check('reconnect refreshes the saved provider address without another rental', JSON.parse(readFileSync(join(f.home, 'settings.json'), 'utf8')).compatProvider.llmhost.baseUrl !== firstBase && rp.state.creates === 1)
  await choose('Terminate'); await until('Confirm terminate'); capture('06-terminate-confirm')
  check('selecting terminate alone cannot delete', rp.state.deletes === 0)
  await choose('Confirm terminate'); await until('Pod terminated'); capture('07-deleted')
  check('termination verified against live pod list', rp.state.pods.size === 0 && rp.state.deletes === 1)
  await close()

  open(); await heading('Where should the model run?'); await choose('reach by SSH')
  await text('SSH host or config alias', 'fixture-box')
  await text('SSH user', 'root'); await text('SSH port', '2222'); await text('Private key path')
  await heading('Recipes that fit'); capture('08-ssh-fit'); await choose('NVFP4 · 4× B200')
  await text('Local model bank folder'); await heading('Start this model'); capture('09-ssh-confirm'); await choose('Start the engine')
  await tail('sshbox'); capture('10-ssh-ready')
  check('SSH box registers a second provider without rental', namedCompatModelOptions().some(row => row.value === 'compat/sshbox/' + f.model) && rp.state.creates === 1)
  await close()

  open(); await heading('Where should the model run?'); await choose('Rent a GPU'); await text('Optional spending budget', '70')
  await until('live Runpod stock'); await choose('NVFP4 · 4× B200'); await heading('Confirm the hourly price'); await choose('keep things as they are')
  await until('stopped'); capture('11-no-confirm')
  check('no confirmation means no pod', rp.state.creates === 1)
  await close()

  open(); await heading('Where should the model run?'); await choose('Rent a GPU'); await text('Optional spending budget', '70')
  await until('live Runpod stock'); await choose('NVFP4 · 4× B200'); await heading('Confirm the hourly price'); await choose('Confirm $31.96/hr')
  await heading('4 · choose the model'); m.push(KEY.esc); await until('Keep running and close'); capture('12-popup-close-keeps-pod'); await choose('Keep running and close'); await until('pod still running'); await close()
  check('closing popup never silently deletes a pod', rp.state.pods.has('fixture-pod-2') && rp.state.deletes === 1)
  check('pod identity survives on disk outside settings', readFileSync(join(f.home, 'host/pods/fixture-pod-2.json'), 'utf8').includes('fixture-pod-2'))
  open(); await heading('Where should the model run?'); await until('fixture-pod-2'); capture('13-paid-pod-on-return'); await choose('fixture-pod-2')
  await heading('Pod controls'); await choose('Stop ·'); await until('Confirm stop')
  check('stop needs its own confirm keystroke', rp.state.stops === 0)
  await choose('Confirm stop'); await heading('Pod controls'); await until('Stopped · compute ended'); capture('14-stopped-disk-bills')
  check('stopped pod remains listed and its disk retained', rp.state.pods.has('fixture-pod-2') && rp.state.stops === 1)
  await choose('Terminate'); await until('Confirm terminate'); await choose('Confirm terminate'); await until('Pod terminated')
  check('final fixture account has no leftover pods', rp.state.pods.size === 0)
  await close()
  f.state.dialect = 'llamacpp'
  open(); await heading('Where should the model run?'); await choose('Rent a GPU'); await text('Optional spending budget', '70')
  await until('live Runpod stock'); await choose('UD-Q4_K_XL · 1× B300'); await heading('Confirm the hourly price'); await until('llama.cpp (GGUF)'); capture('15-gguf-one-gpu-confirm'); await choose('Confirm $8.99/hr')
  await tail('gguf'); await heading('Pod controls'); capture('16-gguf-ready')
  check('GGUF registration uses llama.cpp dialect', JSON.parse(readFileSync(join(f.home, 'settings.json'), 'utf8')).compatProvider.gguf.dialect === 'llamacpp')
  check('GGUF launch builds the documented fork and preserves max thinking', ssh.commands.some((c: any) => c.command === 'ssh' && c.args.at(-1).includes('llama-server') && c.args.at(-1).includes('86ebfef2c6a0f3359a2a07d2c215d61b0fa885c9') && c.args.at(-1).includes('reasoning_effort')))
  f.state.mode = 'tools'
  const messages: any[] = [f.createUserMessage({ content: 'GGUF tool continuation fixture' })]
  const replies = await f.run('compat/gguf/' + f.model, messages)
  messages.push(...replies, f.createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'fixture-call-0', content: 'done' }] }))
  await f.run('compat/gguf/' + f.model, messages)
  check('llama.cpp keeps reasoning on a tool continuation', f.captures.at(-1)!.body.messages.some((message: any) => message.reasoning_content?.includes('reasoning-0')))
  f.state.mode = 'reply'
  await choose('Terminate'); await until('Confirm terminate'); await choose('Confirm terminate'); await until('Pod terminated'); await close()
  rp.state.noStock = true
  const empty = await new RunpodClient(rp.key, rp.baseUrl).offers(new AbortController().signal)
  check('stock loss offers no unplaceable shape', empty.length === 0)
  rp.state.noStock = false
  check('all live stock reads include GPU count and CUDA floor', rp.requests.filter((r: any) => r.path.endsWith('/catalog/gpus')).every((r: any) => r.search.includes('count=') && r.search.includes('minCudaVersion=13.0')))
  await Promise.all(images)
  console.log('HOST RENT DRIVE GREEN — ' + checks + ' checks; real popup, REST fixture, SSH process shim and compatible reply server; zero billable calls')
} finally { mounted?.unmount(); ssh?.close(); await rp.close(); f.close() }
