import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { bankDownloadWords } from './bankDownloadFixture.ts'
import { KEY, mountOffscreen, pinSourceRef, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { runpodFixture, fakeSshRunner, liveCatalogue } from './runpodFixture.mjs'
import { vastFixture } from './vastFixture.mjs'
import { lambdaFixture } from './lambdaFixture.mjs'
import { hfFixture, fixtureRepos } from './hfFixture.mjs'
import { hfEndpointsFixture } from './hfEndpointsFixture.mjs'
import { gridToPng } from '../ui/gridToPng.ts'
import type { LlmHostQuestion, LlmHostRoad } from '../../src/services/llmHost/index.ts'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
pinSourceRef()
const option = (name: string) => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1] }
const frames = option('--frames')
if (frames) mkdirSync(frames, { recursive: true })
const f = await llmhostFixture()
process.env.HOME = f.home
if (process.platform === 'win32') process.env.USERPROFILE = f.home
f.state.dialect = 'sglang'
f.state.window = 131072
const rp = await runpodFixture()
const vast = await vastFixture()
const lambda = await lambdaFixture()
rp.state.customGpus = [{ ...liveCatalogue.gpus.find((row: any) => row.id === 'NVIDIA H100 80GB HBM3'), availability: 'HIGH', dataCenters: [{ id: 'EU-NL-1', availability: 'HIGH' }] }]
vast.state.customOffers = [{ id: 101, gpu_name: 'H100', gpu_ram: 80 * 1024, num_gpus: 1, dph_total: 1.2, verification: 'verified', reliability2: 0.999, reliability: 0.999, direct_port_count: 1, rentable: true, rented: false, cuda_max_good: 13, disk_space: 2000, geolocation: 'US' }]
const data = Buffer.from('fixture weights for the integrated popup journey\n')
fixtureRepos.gguf.files = [{ path: 'tiny-Q4_K_M.gguf', size: data.length, git: createHash('sha1').update('blob ' + data.length + '\0').update(data).digest('hex') }]
fixtureRepos.gguf.gguf.context_length = 131072
const hf = await hfFixture()
const endpoints = await hfEndpointsFixture()
process.env.MERCURY_HOST_HF_API_BASE = hf.baseUrl
const shipped = JSON.parse(readFileSync(join(import.meta.dir, '../../assets/host/recipes.json'), 'utf8'))
const shape = shipped.recipes.find((row: any) => row.id === 'gpt-oss-120b-h100')
const recipes = ['DeepSeek Tiny', 'Qwen Tiny'].map((name, index) => ({ ...shape, id: 'qc-' + index, label: name + ' · MXFP4', model: 'fixture/qc-' + index, weightsGb: data.length / 1e9, verified: { by: 'documented', on: '2026-10-22', source: 'https://huggingface.co/fixture/qc-' + index, note: 'fixture' } }))
const recipesFile = join(f.home, 'recipes.json')
writeFileSync(recipesFile, JSON.stringify({ version: shipped.version, publishedAt: shipped.publishedAt, recipes }))
process.env.MERCURY_HOST_RECIPES_FILE = recipesFile
const weightsFile = join(f.home, 'weights.json')
writeFileSync(weightsFile, JSON.stringify(recipes.map(recipe => ({ model: recipe.model, include: '', revision: 'c'.repeat(40), files: [{ path: 'model.bin', size: data.length, sha256: createHash('sha256').update(data).digest('hex') }] }))))
process.env.MERCURY_HOST_WEIGHTS_FILE = weightsFile
const nativeFetch = globalThis.fetch
const escaped: string[] = []
globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  const base = ({ 'https://api.runpod.io': rp.baseUrl.replace('/v2', ''), 'https://console.vast.ai': vast.baseUrl.replace('/api/v0', ''), 'https://cloud.lambda.ai': lambda.baseUrl.replace('/api/v1', '') } as Record<string, string>)[url.origin]
  if (base) return nativeFetch(new Request(base + url.pathname + url.search, request))
  if (url.hostname !== '127.0.0.1' && url.hostname !== '[::1]') { escaped.push(url.origin); throw new Error('QC permits loopback fixtures only') }
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
  const { runHostJob } = await import('../../src/services/host/worker.ts')
  const { hostRecords } = await import('../../src/services/host/store.ts')
  const secrets = await import('../../src/services/providers/providerSecrets.ts')
  const bank = await import('../../src/services/host/bank.ts')
  const { currentHostRecipes } = await import('../../src/services/host/recipesFile.ts')
  const volumes = await import('../../src/services/host/volumes.ts')
  secrets.writeStoredRunpodApiKey(rp.key)
  secrets.writeStoredVastApiKey(vast.key)
  secrets.writeStoredLambdaApiKey(lambda.key)
  bank.rememberBankFolder(join(f.home, 'mercury-model-bank'))
  ssh = fakeSshRunner(f.baseUrl, hostRunner)
  const downloads: string[] = []
  const runner = { ...ssh.runner, run: async (command: string, args: string[], signal: AbortSignal, timeout?: number) => {
    const argv = bankDownloadWords(command, args)
    if (argv) {
      const folder = argv[argv.indexOf('--local-dir') + 1]!
      const recipe = currentHostRecipes().find(row => row.model === argv[2])!
      for (const file of bank.bankFiles(recipe, folder).files) { mkdirSync(dirname(join(folder, file.path)), { recursive: true }); writeFileSync(join(folder, file.path), data) }
      downloads.push(recipe.model)
      return ''
    }
    return ssh!.runner.run(command, args, signal, timeout)
  } }
  const jobs: Promise<void>[] = []
  let question: LlmHostQuestion | undefined
  const implementation = createHostRoad({ apiBaseUrl: rp.baseUrl, vendorApiBaseUrls: { huggingface: endpoints.baseUrl }, runner, sessionId: 'qc-fixture', pauseMs: 10, readyTimeoutMs: 2000, startJob: record => { jobs.push(runHostJob(record.id, record.generation!, { runner, pauseMs: 10, timeoutMs: 4000, keepAlive: false })) } })
  const road: LlmHostRoad = (ask, emit, signal) => implementation(plan => { question = plan; return ask(plan) }, emit, signal)
  let width = 120, height = 40
  const screen = () => mounted?.screen() ?? ''
  const normal = () => screen().replace(/[│\s]+/g, ' ')
  const check = (name: string, truth: unknown) => { assert.ok(truth, name + '\n' + screen()); checks++; console.log('PASS ' + name) }
  const until = async (needle: string) => assert.ok(await waitFor(() => normal().includes(needle), 20000), 'screen reaches ' + needle + '\n' + screen())
  const step = async (name: string) => assert.ok(await waitFor(() => question?.step === name && screen().includes(question.title.slice(0, 28)), 15000), 'question reaches ' + name + '\n' + screen())
  const selected = () => mounted!.lines().find(line => line.includes('› ')) ?? ''
  const select = async (value: string) => {
    const target = question?.rows?.find(row => row.value === value)
    assert.ok(target, 'question offers ' + value)
    const text = target.label.replace(/^─[^\n]*\n/, '').split('\n')[0]!.trim().slice(0, 22)
    for (const key of [KEY.down, KEY.up]) for (let index = 0; index < 100; index++) {
      if (selected().includes(text)) return
      const before = selected()
      mounted!.push(key)
      if (!await waitFor(() => selected() !== before, 1500)) break
    }
    throw new Error('Cannot select ' + value + '\n' + screen())
  }
  const choose = async (value: string) => { await select(value); mounted!.push(KEY.enter) }
  const capture = async (name: string) => {
    check(name + ' has intact borders and no render error, credential or internal jargon', screen().includes('╰') && !screen().includes('RENDER ERROR') && [rp.key, vast.key, lambda.key].every(key => !screen().includes(key)) && !/\b(door|road|seat|fold|lane|ladder|owner|law|pin|prover)s?\b/i.test(screen()))
    if (!frames) return
    writeFileSync(join(frames, name + '.txt'), screen())
    const grid = mounted!.lines().map((line, y) => Array.from(line.padEnd(width)).map((c, x) => ({ c, bg: mounted!.styleAt(x, y)?.bg ?? 'default', fg: mounted!.styleAt(x, y)?.fg ?? 'default', bold: mounted!.styleAt(x, y)?.bold ?? false })))
    const path = join(frames, name + '.json')
    writeFileSync(path, JSON.stringify({ grid, cols: width, rows: height }))
    await gridToPng(path, join(frames, name + '.png'))
  }
  const open = async () => { question = undefined; popup.openSettingsPopup(llmHostPopupRequest(road)); await step('door-models') }
  const close = async () => { mounted!.push(KEY.esc); assert.ok(await waitFor(() => !popup.isSettingsPopupOpen(), 5000), 'Escape closes\n' + screen()) }
  const mount = async (columns: number, rows: number) => { width = columns; height = rows; mounted = await mountOffscreen(React.createElement(AppStateProvider, {}, React.createElement(ThemeProvider, {}, React.createElement(Box, { flexDirection: 'column', width, height }, React.createElement(SettingsPopupSlot)))), width, height) }
  for (const columns of [120, 80]) {
    secrets.writeStoredHuggingfaceApiKey('fixture-rejected-' + columns)
    await mount(columns, columns === 120 ? 40 : 24)
    await open()
    const summary = 'Hugging Face: could not be read (HTTP 401)'
    check('one short HF notice at ' + columns, (normal().match(/Hugging Face: could not be read \(HTTP 401\)/g) ?? []).length === 1 && !normal().includes('GET /whoami-v2'))
    const requests = endpoints.requests.length
    await capture(columns + '-rejected-signin')
    await choose('vendor-error:huggingface'); await step('door-vendor-error')
    check('the full HF error is behind its row', question!.found.includes('HTTP 401') && !question!.found.includes('fixture-rejected-'))
    await choose('back'); await step('door-models')
    await choose('DeepSeek Tiny'); await step('door-model')
    check('the rejected vendor row asks for sign-in rather than a retry', question!.rows!.some(row => row.label === 'Hugging Face · sign in again'))
    await close(); await open()
    check('the next open makes zero further HF requests', endpoints.requests.length === requests)
    await choose('bank'); await step('door-bank')
    check('the Bank has one short HF notice', question!.found.includes(summary) && (normal().match(/Hugging Face: could not be read \(HTTP 401\)/g) ?? []).length === 1)
    await close()
    secrets.writeStoredHuggingfaceApiKey(endpoints.key)
    await open()
    check('changing the saved credential resumes HF reads', endpoints.requests.length > requests && !question!.found.includes(summary))
    await close()
    endpoints.state.failNext = { route: 'GET /v2/provider/fixture-owner', status: 403, times: 1 }
    await open()
    check('an HF endpoint permission refusal names the missing permission rather than asking for the same sign-in', question!.found.includes('Inference Endpoints permission required (HTTP 403)') && !question!.found.includes('sign in again'))
    const forbiddenReads = endpoints.requests.length
    await choose('vendor-error:huggingface'); await step('door-vendor-error')
    check('the HF permission detail keeps HTTP 403 and the token remedy', question!.found.includes('HTTP 403') && question!.found.includes('https://huggingface.co/settings/tokens') && question!.found.includes('paste it with /logins huggingface') && !question!.found.includes(endpoints.key))
    await choose('back'); await step('door-models')
    await capture(columns + '-endpoint-permission')
    await close(); await open()
    check('the endpoint permission failure parks reads until the credential changes', endpoints.requests.length === forbiddenReads)
    await close(); mounted!.unmount(); mounted = undefined
  }
  secrets.writeStoredHuggingfaceApiKey(null)
  for (const [columns, rows] of [[120, 40], [80, 24]]) {
    await mount(columns!, rows!)
    await open()
    await capture(width + '-models')
    mounted!.push('b')
    await until('/ b')
    check('b types in the searchable popup rather than opening Bank', question?.step === 'door-models')
    mounted!.push(KEY.esc); await until('model name')
    mounted!.push('deepseek'); await until('VERIFIED RECIPES')
    check('the verified list narrows before the Hub responds', !question?.search || !screen().includes('Qwen Tiny'))
    assert.ok(await waitFor(() => question?.rows?.some(row => row.value === 'hf:' + fixtureRepos.gguf.id) === true, 15000))
    await select('hf:' + fixtureRepos.gguf.id)
    await capture(width + '-search')
    mounted!.push(KEY.enter); await step('door-model'); await until('RECIPE · unverified')
    await capture(width + '-hf-model')
    check('HF recipe and all provider prices reach the model screen', question!.found.includes('RECIPE · unverified') && question!.rows!.filter(row => row.label.startsWith('Rent · ')).length >= 3)
    const rentals = question!.rows!.filter(row => row.label.startsWith('Rent · '))
    const prices = rentals.map(row => Number(/\$([\d.]+)\/hr/.exec(row.label)![1]))
    check('providers are cheapest first, stamped, and name the download', prices.every((price, index) => !index || price >= prices[index - 1]!) && rentals.every(row => row.label.includes('downloads the weights first') && (row.label.includes('Runpod') ? row.label.includes('verified on a live rental 2026-10-21') : row.label.includes('API only — not yet booted'))))
    check('there is one stock watch across providers', question!.rows!.filter(row => row.value === 'watch').length === 1)
    mounted!.push('b')
    const bankStep = width === 120 ? 'door-bank-confirm' : 'door-bank-again'
    const hotkeyWorks = await waitFor(() => question?.step === bankStep, 3000)
    if (!hotkeyWorks) await capture(width + '-b-no-selection-failure')
    check('b on a freshly opened model works without selecting a rental', hotkeyWorks)
    await step(bankStep)
    await capture(width + '-bank-confirm')
    const beforeBank = jobs.length
    await choose(width === 120 ? 'bank' : 'verify')
    assert.ok(await waitFor(() => jobs.length > beforeBank, 10000), 'bank action queues its own job before completion is checked')
    await Promise.all(jobs); await step('door-model')
    const derived = currentHostRecipes().find(row => row.model === fixtureRepos.gguf.id)!
    check('the background bank job verifies the downloaded HF files against the trusted manifest the derived recipe now carries', bank.bankState(derived).banked && bank.bankState(derived).check === 'manifest')
    await choose('bank'); await step('door-bank')
    await capture(width + '-bank')
    check('the Bank table and all five action keys are offered', ['MODEL', 'SIZE', 'BANKED', 'VERIFIED', 'VOLUME'].every(word => question!.rows![0]!.label.includes(word)) && question!.keys!.map(row => row.key).join() === 'b,v,m,d,k')
    await select(derived.id)
    const beforeVerify = jobs.length
    mounted!.push('v')
    assert.ok(await waitFor(() => jobs.length > beforeVerify, 10000), 'v queues verification at either terminal height')
    await Promise.all(jobs)
    await choose('refresh'); await step('door-bank')
    check('verification keeps the HF bank readable', bank.bankState(derived).verifiedAt !== undefined)
    await select(derived.id); mounted!.push('m')
    await step('fast-load-how')
    await capture(width + '-hf-mirror-how')
    check('an HF model banked with its trusted manifest can be mirrored, and nothing is created before the confirm', rp.state.volumeCreates === (width === 120 ? 0 : 1))
    await close()
    await open(); await choose('DeepSeek Tiny'); await step('door-model')
    await select('bank'); mounted!.push('m'); await step('fast-load-how')
    await capture(width + '-mirror-kind')
    await choose('network'); await step('fast-load-where'); await choose('EU-NL-1'); await step('fast-load-when'); await choose('now'); await step('fast-load-confirm')
    await capture(width + '-mirror-confirm')
    await choose('confirm'); await step('door-model')
    assert.ok(await waitFor(() => volumes.keptVolumes().some(volume => volume.state === 'kept'), 20000))
    await Promise.all(jobs)
    await choose('bank'); await step('door-bank'); await capture(width + '-volume')
    await select('qc-0'); mounted!.push('d'); await step('volume-delete')
    await capture(width + '-drop-confirm'); await choose('delete'); await step('door-bank')
    check('dropping the volume leaves the HF bank intact', bank.bankState(derived).banked && !volumes.keptVolumes().some(volume => volume.state === 'kept'))
    await close()
    await open(); await choose('DeepSeek Tiny'); await step('door-model'); await choose('watch'); await step('rent-confirm')
    await capture(width + '-watch-confirm')
    check('the watch confirm names all providers and the first-hit rule', question!.willRun.includes('first provider') && (question!.found + question!.willRun).includes('Runpod, Vast.ai, Lambda'))
    await close()
    await open(); mounted!.push('deepseek'); assert.ok(await waitFor(() => question?.search?.query === 'deepseek', 10000)); mounted!.push(KEY.esc); await until('model name'); check('Escape clears first and leaves the model list open', popup.isSettingsPopupOpen()); await close()
    check('no bank job remains unfinished', hostRecords().every(record => record.jobKind !== 'bank'))
    mounted!.unmount(); mounted = undefined
  }
  await mount(80, 24)
  const derived = currentHostRecipes().find(row => row.model === fixtureRepos.gguf.id)!
  const { forgetSessionHostRecipes } = await import('../../src/services/host/recipesFile.ts')
  forgetSessionHostRecipes()
  await open(); await choose('bank'); await step('door-bank')
  await capture('80-bank-after-session-reset')
  check('the saved HF bank remains on disk after the session recipe is forgotten', bank.bankState(derived).banked && bank.readBankRegistry().models[volumes.volumeModel(derived)] !== undefined)
  check('the saved HF model remains a selectable Bank row after its session recipe is forgotten', question!.rows!.some(row => row.value === derived.id))
  await close(); mounted!.unmount(); mounted = undefined
  check('no request left the fixture servers', escaped.length === 0)
  assert.equal(downloads.length, 1)
  console.log('LLMHOST QC DRIVE GREEN — ' + checks + ' checks; 120x40 and 80x24, live dialog and loopback fixtures; saved HF Bank row survives session reset')
} finally { mounted?.unmount(); ssh?.close(); await rp.close(); await vast.close(); await lambda.close(); await hf.close(); await endpoints.close(); f.close(); globalThis.fetch = nativeFetch }
