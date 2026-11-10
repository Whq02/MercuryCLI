import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { fakeSshRunner, liveCatalogue, runpodFixture } from './runpodFixture.mjs'
import type { LlmHostQuestion } from '../../src/services/llmHost/index.ts'
import type { HostRecord } from '../../src/services/host/store.ts'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const f = await llmhostFixture()
const rp = await runpodFixture()
const nativeFetch = globalThis.fetch
const escaped: string[] = []
globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (!['127.0.0.1', '[::1]'].includes(url.hostname)) { escaped.push(url.href); throw new Error('Only loopback fixtures are allowed') }
  return nativeFetch(input, init)
}, nativeFetch)
let ssh: ReturnType<typeof fakeSshRunner> | undefined
let checks = 0
let failures = 0
const check = (name: string, truth: unknown): void => { checks++; if (!truth) failures++; console.log((truth ? 'PASS ' : 'FAIL ') + name) }
try {
  const { HOST_RECIPES } = await import('../../src/services/host/recipes.ts')
  const { createHostRoad } = await import('../../src/services/host/index.ts')
  const { hostRunner } = await import('../../src/services/host/ssh.ts')
  const { writeStoredRunpodApiKey } = await import('../../src/services/providers/providerSecrets.ts')
  const tune = await import('../../src/services/host/tune.ts')
  const a = HOST_RECIPES.find(row => row.id === 'tensorfold-qwen35-2b-rtx-3090')!
  const b = HOST_RECIPES.find(row => row.id === 'tensorfold-qwen35-2b-rtx-a6000')!
  assert.ok(a && b)
  const title = a.label.split(' · ')[0]!
  const prefsPath = join(f.home, 'host/preferences.json')
  const beforePrefs = (): string => existsSync(prefsPath) ? readFileSync(prefsPath, 'utf8') : ''
  rp.state.customGpus = liveCatalogue.gpus.filter((row: any) => ['NVIDIA GeForce RTX 3090', 'NVIDIA RTX A6000'].includes(row.id)).map((row: any) => ({ ...row, availability: 'HIGH', dataCenters: [{ id: 'EU-NL-1', availability: 'HIGH' }] }))
  check('the fixture offers both distinct GPU shapes', rp.state.customGpus.length === 2)
  ssh = fakeSshRunner(f.baseUrl, hostRunner)
  writeStoredRunpodApiKey(rp.key)
  const queued: HostRecord[] = []
  const road = createHostRoad({ apiBaseUrl: rp.baseUrl, runner: ssh.runner, startJob: record => { queued.push(record) } })
  const seed = async () => {
    await tune.runTune(title, { recipes: [a, b] }, async q => q.step === 'tune-quality' ? b.id : q.step === 'tune-context' ? '0' : q.step === 'tune-thinking' ? 'default' : 'confirm', () => {})
    assert.equal(tune.readTunePreferences(title)?.quality, b.id)
  }
  const rent = async (cancel: boolean): Promise<LlmHostQuestion> => {
    let confirmation: LlmHostQuestion | undefined
    await road(async q => {
      if (q.step === 'door-models') return 'other'
      if (q.step === 'where') return 'rent'
      if (q.step === 'rental-vendor') return 'runpod'
      if (q.step === 'budget') return ''
      if (q.step === 'models') return title
      if (q.step === 'offers') return q.rows!.find(row => row.label.includes('1× RTX 3090'))!.value
      if (q.step === 'rent-confirm') { confirmation = q; return cancel ? 'cancel' : 'rent' }
      return null
    }, () => {}, new AbortController().signal)
    assert.ok(confirmation)
    return confirmation
  }
  const empty = beforePrefs()
  const opened = await rent(true)
  check('opening and cancelling an unsaved rental never writes tuning preferences', beforePrefs() === empty && rp.state.creates === 0)
  check('without saved tuning the confirmation names the selected RTX 3090', opened.found.includes('1× RTX 3090') && !opened.found.includes('RTX A6000'))
  await seed()
  const saved = beforePrefs()
  const cancelled = await rent(true)
  check('a remembered A6000 cannot replace the 3090 the user chose on the shape screen', cancelled.found.includes('1× RTX 3090') && !cancelled.found.includes('RTX A6000'))
  check('cancelling the changed shape preserves saved tuning byte for byte and creates nothing', beforePrefs() === saved && rp.state.creates === 0)
  const confirmed = await rent(false)
  check('the accepted confirmation still names the selected 3090 and its price', confirmed.found.includes('1× RTX 3090') && confirmed.found.includes('$0.50/hr'))
  check('the create request buys the selected 3090, never the saved A6000', rp.state.creates === 1 && rp.state.createBodies[0].gpu.id === 'NVIDIA GeForce RTX 3090')
  check('the queued setup and saved confirmation carry that same recipe', queued.length === 1 && queued[0]!.recipe === a.id && queued[0]!.tune?.quality === a.id && tune.readTunePreferences(title)?.quality === a.id)
  await seed()
  const offers = [{ recipe: a, gpuId: 'NVIDIA GeForce RTX 3090', price: 0.5, dataCenter: 'EU-NL-1' }, { recipe: b, gpuId: 'NVIDIA RTX A6000', price: 0.59, dataCenter: 'EU-NL-1' }]
  let confirmations = 0
  let tuneInitial: string | undefined
  let changedFound = ''
  const changed = await tune.confirmTunedRental(offers[0]!, offers, undefined, async q => {
    if (q.step === 'rent-confirm') { confirmations++; if (confirmations === 1) return 'tune'; changedFound = q.found; return 'rent' }
    if (q.step === 'tune-quality') { tuneInitial = q.initial; return b.id }
    if (q.step === 'tune-context') return '0'
    if (q.step === 'tune-thinking') return 'default'
    return q.step === 'tune-confirm' ? 'confirm' : null
  }, () => {}, new AbortController().signal)
  check('Tune opens on the recipe actually shown in the rental confirmation', tuneInitial === a.id)
  check('an explicit confirmed Tune change can choose another shape and returns to its own price confirmation', confirmations === 2 && changed?.recipe.id === b.id && changedFound.includes('RTX A6000') && changedFound.includes('$0.59/hr'))
  check('no request escaped the fixtures', escaped.length === 0)
  console.log(`RENTAL SELECTED SHAPE ${failures ? 'RED' : 'GREEN'} — ${checks} checks, ${failures} failed; no real rental`)
} finally { ssh?.close(); await rp.close(); f.close(); globalThis.fetch = nativeFetch }
process.exitCode = failures ? 1 : 0
