import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinSourceRef, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { runpodFixture, fakeSshRunner, liveCatalogue } from './runpodFixture.mjs'
import { hfFixture } from './hfFixture.mjs'
import { gridToPng } from '../ui/gridToPng.ts'
import type { LlmHostQuestion, LlmHostRoad } from '../../src/services/llmHost/index.ts'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const baseline = Boolean(pinSourceRef())
const option = (name: string) => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1] }
const frames = option('--frames')
if (frames) mkdirSync(frames, { recursive: true })
const f = await llmhostFixture()
process.env.HOME = f.home
process.env.USERPROFILE = f.home
const rp = await runpodFixture()
const hf = await hfFixture()
process.env.MERCURY_HOST_HF_API_BASE = hf.baseUrl
const nativeFetch = globalThis.fetch
const escaped: string[] = []
globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  if (url.origin === 'https://api.runpod.io') return nativeFetch(new Request(rp.baseUrl.replace('/v2', '') + url.pathname + url.search, request))
  if (url.hostname !== '127.0.0.1' && url.hostname !== '[::1]') { escaped.push(url.origin); throw new Error('Plain-words drive permits loopback fixtures only') }
  return nativeFetch(request)
}, nativeFetch)
let mounted: Mounted | undefined
let ssh: ReturnType<typeof fakeSshRunner> | undefined
let checks = 0
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
  const { writeStoredRunpodApiKey } = await import('../../src/services/providers/providerSecrets.ts')
  const { currentHostRecipes, rememberSessionHostRecipe } = await import('../../src/services/host/recipesFile.ts')
  const { writeHostRecord, readHostRecord } = await import('../../src/services/host/store.ts')
  const bank = await import('../../src/services/host/bank.ts')
  writeStoredRunpodApiKey(rp.key)
  const recipes = currentHostRecipes()
  const recipe = recipes.find(row => row.id === 'qwen38-27b-rtx-pro-6000')!
  const since = new Date(Date.now() - 3600_000).toISOString()
  rp.state.pods.set('fixture-paused', { id: 'fixture-paused', name: 'Qwen rental', status: 'RUNNING', cost: 2.49, createdAt: since, startedAt: since })
  writeHostRecord({ id: 'fixture-paused', name: recipe.label, recipe: recipe.id, status: 'RUNNING', price: 2.49, startedAt: since, jobState: 'paused', step: 'paused', error: 'SSH connection refused · machine kept · $2.49/hr · Resume or Terminate' })
  const h100 = liveCatalogue.gpus.find((row: any) => row.id === 'NVIDIA H100 80GB HBM3')!
  rp.state.customGpus = [...liveCatalogue.gpus, { ...h100, availability: 'HIGH', dataCenters: [{ id: 'EU-NL-1', availability: 'HIGH' }] }]
  ssh = fakeSshRunner(f.baseUrl, hostRunner)
  const queued: string[] = []
  const implementation = createHostRoad({ apiBaseUrl: rp.baseUrl, runner: ssh.runner, sessionId: 'plain-words-proof', startJob: record => { queued.push(record.id) } })
  let question: LlmHostQuestion | undefined
  const road: LlmHostRoad = (ask, emit, signal) => implementation(plan => { question = plan; return ask(plan) }, emit, signal)
  let width = 120, height = 40
  const screen = () => mounted!.screen()
  const check = (name: string, truth: unknown) => { assert.ok(truth, name + '\n' + screen()); checks++; console.log('PASS ' + name) }
  const step = async (name: string) => assert.ok(await waitFor(() => question?.step === name && screen().includes(question.title.slice(0, 24)), 15000), 'question reaches ' + name + '\n' + screen())
  const selected = () => mounted!.lines().find(line => line.includes('› ')) ?? ''
  let tracked: { plan: LlmHostQuestion; at: number | null } | undefined
  const select = async (value: string) => {
    const plan = question!
    const rows = plan.search?.query ? plan.rows!.filter(row => row.label.split(' · ')[0]!.toLowerCase().includes(plan.search!.query.toLowerCase())) : plan.rows ?? []
    const target = rows.findIndex(row => row.value === value)
    assert.ok(target >= 0, 'question offers ' + value)
    if (tracked?.plan !== plan) { const initial = plan.initial === undefined ? -1 : rows.findIndex(row => row.value === plan.initial); tracked = { plan, at: initial < 0 ? plan.search?.query && rows.length ? 0 : null : initial } }
    while (tracked.at !== target) {
      const before = selected()
      const down = tracked.at === null || tracked.at < target
      mounted!.push(down ? KEY.down : KEY.up)
      tracked.at = tracked.at === null ? (down ? 0 : rows.length - 1) : tracked.at + (down ? 1 : -1)
      assert.ok(await waitFor(() => selected() !== before, 3000), 'cursor moves to ' + value + '\n' + screen())
    }
  }
  const choose = async (value: string) => { await select(value); mounted!.push(KEY.enter) }
  const open = async () => { question = undefined; popup.openSettingsPopup(llmHostPopupRequest(road)); await step('door-models') }
  const close = async () => { mounted!.push(KEY.esc); if (popup.isSettingsPopupOpen() && question?.search?.query) mounted!.push(KEY.esc); assert.ok(await waitFor(() => !popup.isSettingsPopupOpen(), 5000), 'Escape closes\n' + screen()) }
  const capture = async (name: string) => {
    check(name + ' renders with an exit and no credentials', screen().includes('esc') && screen().includes('╰') && !screen().includes('RENDER ERROR') && !screen().includes(rp.key))
    const plan = question!
    const text = [plan.title, plan.found, plan.willRun, ...(plan.lines ?? []), ...(plan.rows ?? []).map(row => row.label)].join('\n')
    if (!baseline) check(name + ' omits developer stamps and routine narration', !/\b(?:measured|documented|unverified)\b|community recipe|not booted|cannot promise|RECIPE ·|verified \d{4}|not yet proven|header checked|header unread/i.test(text))
    if (!frames) return
    writeFileSync(join(frames, name + '.txt'), screen())
    writeFileSync(join(frames, name + '-plan.json'), JSON.stringify(plan, null, 2))
    const grid = mounted!.lines().map((line, y) => Array.from(line.padEnd(width)).map((c, x) => ({ c, bg: mounted!.styleAt(x, y)?.bg ?? 'default', fg: mounted!.styleAt(x, y)?.fg ?? 'default', bold: mounted!.styleAt(x, y)?.bold ?? false })))
    const path = join(frames, name + '.json')
    writeFileSync(path, JSON.stringify({ grid, cols: width, rows: height }))
    await gridToPng(path, join(frames, name + '.png'))
  }
  const folder = bank.rememberBankFolder(join(f.home, 'bank'))
  const tiny = { ...recipe, id: 'tiny-bank', label: 'Tiny bank · GGUF Q4_K_M', model: 'fixture/tiny-bank', engine: 'llamacpp' as const, weightFile: 'tiny.gguf', weightsGb: 0.000004, weightManifest: undefined }
  rememberSessionHostRecipe(tiny)
  const path = bank.bankModelPath(folder, tiny)
  mkdirSync(path, { recursive: true }); writeFileSync(join(path, 'tiny.gguf'), 'fixture weights')
  await bank.sealBank(tiny, folder, new AbortController().signal)
  await bank.verifyBank(tiny, folder, new AbortController().signal)
  writeFileSync(join(path, 'tiny.gguf'), 'changed weights')
  await assert.rejects(bank.verifyBank(tiny, folder, new AbortController().signal), /hash differs/)
  bank.recordBankFailure(tiny, path, 'tiny.gguf · hash differs from SHA256SUMS')
  let firstOrder: string[] | undefined
  for (const [columns, rows] of [[120, 40], [80, 24]]) {
    width = columns!; height = rows!
    mounted = await mountOffscreen(React.createElement(AppStateProvider, { children: React.createElement(ThemeProvider, {}, React.createElement(Box, { flexDirection: 'column', width, height }, React.createElement(SettingsPopupSlot))) }), width, height)
    await open()
    const order = question!.rows!.map(row => row.value)
    if (firstOrder) assert.deepEqual(order, firstOrder)
    firstOrder = order
    await capture(width + '-models')
    await choose('Qwen3.8-27B'); await step('door-model'); await capture(width + '-model')
    await choose('rent:0'); await step('rent-confirm'); await capture(width + '-confirm')
    check('rental has shape, exact rate, disk consequence and unselected consent', question!.found.includes('RTX PRO 6000') && question!.found.includes('$2.49/hr') && /disk|storage/.test(question!.willRun + question!.rows!.map(row => row.label).join(' ')) && !selected())
    await choose('weights-source'); await step('weights-source'); await capture(width + '-sources')
    assert.deepEqual(question!.rows!.map(row => row.value), ['huggingface', 'private-repo', 'bank', 'volume', 'back'])
    await choose('huggingface'); await step('rent-confirm'); await choose('cancel'); await close()
    await open(); await choose('bank'); await step('door-bank'); await capture(width + '-bank')
    const bankPlan = question
    await choose(tiny.id)
    assert.ok(await waitFor(() => question !== bankPlan && question?.step === 'door-bank' && screen().includes('MODEL'), 5000), 'Bank detail settles before capture')
    if (!baseline || width === 120) assert.ok(await waitFor(() => screen().includes('hash differs'), 5000), 'Bank detail retains the hash failure\n' + screen())
    await capture(width + '-bank-error'); await close()
    await open(); await choose('pods'); await step('paid-pods'); await capture(width + '-machines')
    await choose('fixture-paused'); await step('pod-controls'); await capture(width + '-paused')
    check('paused machine retains billing and Resume/Terminate controls', screen().includes('$2.49/hr') && question!.rows!.some(row => row.value === 'resume') && question!.rows!.some(row => row.value === 'terminate') && readHostRecord('fixture-paused')?.jobState === 'paused')
    await close()
    await open(); for (const char of 'deepseek') mounted!.push(char)
    assert.ok(await waitFor(() => question?.rows?.some(row => row.value === 'hf:unsloth/DeepSeek-V4.1-Flash-GGUF') === true, 15000), 'search results arrive')
    await select('hf:unsloth/DeepSeek-V4.1-Flash-GGUF'); await capture(width + '-search')
    mounted!.push(KEY.enter); await step('door-model'); await capture(width + '-derived-model')
    check('derived model preserves hardware and price', question!.rows!.some(row => row.value.startsWith('rent:') && row.label.includes('2× H100') && row.label.includes('$7.98/hr')))
    await close(); mounted.unmount(); mounted = undefined
  }
  assert.equal(queued.length, 0)
  assert.equal(rp.state.creates, 0)
  assert.equal(escaped.length, 0)
  if (frames) writeFileSync(join(frames, 'order.json'), JSON.stringify(firstOrder))
  console.log('PLAIN WORDS DRIVE GREEN — ' + checks + ' checks; 120×40 and 80×24; model, search, source, rental consent, Bank hash failure and paused machine; loopback only; zero creates')
} finally { mounted?.unmount(); ssh?.close(); await rp.close(); await hf.close(); f.close(); globalThis.fetch = nativeFetch }
