import assert from 'node:assert/strict'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { runpodFixture } from './runpodFixture.mjs'
import { hfEndpointsFixture } from './hfEndpointsFixture.mjs'
import { KEY, mountOffscreen, waitFor } from '../lib/settingsPopupHarness.ts'
import type { LlmHostQuestion, LlmHostRoad } from '../../src/services/llmHost/index.ts'

assert.ok(process.env.MERCURY_CONFIG_DIR)
const f = await llmhostFixture()
const rp = await runpodFixture()
const hf = await hfEndpointsFixture()
const nativeFetch = globalThis.fetch
globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  if (!['127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Only loopback fixtures are allowed')
  return nativeFetch(input, init)
}, nativeFetch)
let mounted: Awaited<ReturnType<typeof mountOffscreen>> | undefined
let failures = 0
const check = (label: string, ok: boolean, detail = '') => { if (!ok) failures++; console.log((ok ? 'PASS ' : 'FAIL ') + label + (!ok ? '\n' + detail : '')) }
try {
  const { createHostRoad } = await import('../../src/services/host/index.ts')
  const secrets = await import('../../src/services/providers/providerSecrets.ts')
  secrets.writeStoredRunpodApiKey(rp.key)
  secrets.writeStoredHuggingfaceApiKey('fixture-rejected-screen')
  const questions: LlmHostQuestion[] = []
  await createHostRoad({ apiBaseUrl: rp.baseUrl, vendorApiBaseUrls: { huggingface: hf.baseUrl }, sessionId: 'screen-values' })(async plan => {
    questions.push(plan)
    if (plan.step === 'door-models') return 'Qwen3.8-27B'
    if (plan.step === 'door-model') return plan.rows!.find(row => row.value.startsWith('rent:'))?.value ?? null
    return null
  }, () => {}, new AbortController().signal)
  const model = questions.find(row => row.step === 'door-model')!
  const confirm = questions.find(row => row.step === 'rent-confirm')!
  check('F44R-06/08: model facts are not preceded by unrelated account failures', model.found.startsWith('QUALITY') && !model.found.includes('Hugging Face:'), model.found)
  check('F44R-08: a Runpod confirmation carries no unrelated vendor failure', Boolean(confirm) && !JSON.stringify(confirm).includes('vendor-error:huggingface') && !confirm.found.includes('Hugging Face:'), JSON.stringify(confirm))
  const React = await import('react')
  const { LlmHostDialog } = await import('../../src/components/LlmHostDialog.tsx')
  const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
  const { AppStateProvider } = await import('../../src/state/AppState.tsx')
  let settle: (() => void) | undefined
  const loading: LlmHostRoad = async () => { await new Promise<void>(resolve => { settle = resolve }); return { ok: true, words: 'done' } }
  const mount = async (road: LlmHostRoad) => mountOffscreen(React.createElement(AppStateProvider, { children: React.createElement(ThemeProvider, {}, React.createElement(LlmHostDialog, { width: 120, rowBudget: 20, road })) }), 120, 20)
  mounted = await mount(loading)
  await waitFor(() => Boolean(mounted!.screen().trim()), 2000)
  check('F44R-04: the empty wait names models and prices', mounted.screen().includes('Reading models and prices'), mounted.screen())
  settle?.(); mounted.unmount()
  let answer: ((value: string | null) => void) | undefined
  const road: LlmHostRoad = async (ask, emit) => {
    emit({ title: 'Tune', words: 'saved for next rental; no pod changed' })
    await ask({ step: 'rent-confirm', title: 'Confirm the hourly price', found: '$3.99/hr', willRun: '', initial: 'next', rows: [{ value: 'next', label: 'Continue' }] })
    emit({ title: 'Machine controls', words: '', host: { id: 'current', price: 3.99, startedAt: new Date(Date.now() - 6 * 60_000).toISOString(), status: 'RUNNING' } })
    await ask({ step: 'pod-controls', title: 'Machine controls', found: 'Runpod pod current', willRun: '', rows: [{ value: 'close', label: 'Close' }] })
    return { ok: true, words: 'done' }
  }
  mounted = await mount(road)
  await waitFor(() => mounted!.screen().includes('Continue'), 2000)
  mounted.push(KEY.enter)
  assert.ok(await waitFor(() => mounted!.screen().includes('Machine controls'), 2000), mounted.screen())
  check('F44R-11: an old tune-save receipt is not the placement result', !mounted.screen().includes('saved for next rental'), mounted.screen())
  check('F44R-13: machine controls include elapsed time', /6m|6 min/.test(mounted.screen()), mounted.screen())
  assert.equal(rp.state.creates, 0)
} finally { mounted?.unmount(); await rp.close(); await hf.close(); f.close(); globalThis.fetch = nativeFetch }
process.exitCode = failures ? 1 : 0
