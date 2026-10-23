import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinSourceRef, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { vastFixture } from './vastFixture.mjs'
import { gridToPng } from '../ui/gridToPng.ts'
import type { LlmHostQuestion, LlmHostRoad } from '../../src/services/llmHost/index.ts'

if (!process.env.MERCURY_CONFIG_DIR || process.env.MERCURY_HOME) throw new Error('Use a scratch MERCURY_CONFIG_DIR with MERCURY_HOME unset')
pinSourceRef()
const at = process.argv.indexOf('--frames')
const frames = at < 0 ? undefined : process.argv[at + 1]
if (frames) mkdirSync(frames, { recursive: true })
const f = await llmhostFixture()
const vast = await vastFixture()
const nativeFetch = globalThis.fetch
const escaped: string[] = []
let injected: unknown
let injectedLeft = 0
const volumeAttempts: number[] = []
globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  if (url.hostname !== '127.0.0.1' && url.hostname !== '[::1]') { escaped.push(url.origin); throw new Error('Only loopback fixtures are allowed') }
  if (url.pathname === '/api/v0/volumes') {
    volumeAttempts.push(Date.now())
    if (injectedLeft-- > 0) throw injected
  }
  return nativeFetch(request)
}, nativeFetch)
let mounted: Mounted | undefined
let checks = 0, failures = 0
const check = (name: string, condition: unknown) => { checks++; if (!condition) failures++; console.log((condition ? 'PASS ' : 'FAIL ') + name) }
try {
  const { VastClient } = await import('../../src/services/host/vendors/vast.ts')
  const { saveVendorKey } = await import('../../src/services/host/vendors/client.ts')
  const { createHostRoad } = await import('../../src/services/host/index.ts')
  const { writeKeptVolume, readKeptVolume } = await import('../../src/services/host/volumes.ts')
  const { writeHostRecord, readHostRecord } = await import('../../src/services/host/store.ts')
  const { HostVendorNetworkError } = await import('../../src/services/host/vendors/http.ts')
  const { hostScreenRead } = await import('../../src/services/host/retry.ts')
  saveVendorKey('vast', vast.key)
  vast.state.pods.set(7001, { id: 7001, label: 'Fixture model', actual_status: 'running', start_date: Math.floor(Date.now() / 1000) - 3600, dph_total: 2.1, public_ipaddr: '127.0.0.1' })
  const client = new VastClient(vast.key, vast.baseUrl, { requestTimeoutMs: 80 })
  const offer = (await client.offers(new AbortController().signal))[0]!
  const disk = { id: '20118481', name: 'fixture_weights', kind: 'vast' as const, machineId: 9103, dataCenter: 'fixture', size: 100, price: 20, state: 'kept' as const, model: offer.recipe.model, include: '', createdAt: new Date().toISOString() }
  writeKeptVolume(disk)
  vast.state.volumes.set(20118481, { id: 20118481, label: disk.name, status: 'active', machine_id: 9103, disk_space: 100, storage_cost: 0.2, start_date: 1792490400 })
  writeHostRecord({ id: '7001', name: 'Fixture model', vendor: 'vast', recipe: offer.recipe.id, status: 'RUNNING', jobState: 'ready', price: 2.1, startedAt: new Date().toISOString() })
  const route = 'GET /api/v0/volumes'
  const volumeReads = () => volumeAttempts
  const fail = (status: string | number, times = 1000) => { vast.state.failNext = { route, status, times } }
  const road = (sessionId: string): LlmHostRoad => createHostRoad({ vendorApiBaseUrls: { vast: vast.baseUrl }, sessionId, rental: { client, offer } })
  const plans = async (session: string) => {
    const seen: LlmHostQuestion[] = []
    const result = await road(session)(async plan => { seen.push(plan); if (plan.step === 'door-models' || plan.step === 'where') return 'pods'; if (plan.step === 'paid-pods' && plan.rows?.some(row => row.value === 'vendor-error:vast')) return 'vendor-error:vast'; return null }, () => {}, new AbortController().signal)
    return { seen, result, paid: seen.find(row => row.step === 'paid-pods'), detail: seen.find(row => row.step === 'door-vendor-error') }
  }
  for (const status of ['timeout', 'body-timeout', 'disconnect', 401, 403] as const) {
    fail(status)
    const before = volumeReads().length
    const { paid, detail } = await plans('failure-' + status)
    check(status + ': instances remain listed independently', paid?.rows?.some(row => row.value === 'vast:7001') && paid.found.includes('Vast.ai: 1 instances'))
    check(status + ': only the weights disks are unread', paid?.found.includes('Vast.ai: weights disks unread; storage may still bill') && !paid.found.includes('Vast.ai: could not be read'))
    check(status + ': the detail names the exact request and cause', detail?.found.includes('Vast.ai GET /api/v0/volumes') && (typeof status === 'number' ? detail.found.includes('HTTP ' + status) : status === 'disconnect' ? /ECONNRESET|UND_ERR_SOCKET|socket|connection/i.test(detail.found) : detail.found.includes('timed out after 0.08 s (TimeoutError)')))
    check(status + ': no absent-disk or ended-machine inference', readKeptVolume(disk.id)?.state === 'kept' && Boolean(readHostRecord('7001')))
    check(status + ': bounded transient retries, not permission retries (observed ' + (volumeReads().length - before) + ')', volumeReads().length - before === (typeof status === 'number' ? 1 : 6))
    if (typeof status !== 'number') check(status + ': Retry is offered', detail?.rows?.some(row => row.value === 'retry'))
    if (typeof status === 'number') check('volume ' + status + ' never parks instance reads', (await plans('failure-' + status)).paid?.rows?.some(row => row.value === 'vast:7001'))
  }
  fail('timeout', 1)
  const beforeRecovery = volumeReads().length
  const recovered = await plans('one-failure')
  const recoveredReads = volumeReads().slice(beforeRecovery)
  check('one timeout recovers before any error words appear', !recovered.paid?.found.includes('unread') && !recovered.paid?.rows?.some(row => row.value === 'vendor-error:vast') && recovered.paid?.rows?.some(row => row.value === 'vast:7001'))
  check('screen recovery backs off before its second request', recoveredReads.length === 3 && recoveredReads[1]! - recoveredReads[0]! >= 320)
  vast.state.failNext = null

  for (const code of ['ETIMEDOUT', 'ECONNRESET', 'UND_ERR_CONNECT_TIMEOUT', 'ENOTFOUND', 'CERT_HAS_EXPIRED']) {
    injected = new TypeError('fetch failed', { cause: new AggregateError([Object.assign(new Error('fixture ' + vast.key), { code })], 'connect failed') })
    injectedLeft = 1
    let error: unknown
    try { await client.volumes() } catch (caught) { error = caught }
    check('nested ' + code + ' is preserved and credentials are redacted', error instanceof HostVendorNetworkError && error.message.includes(code) && !error.message.includes(vast.key))
  }
  injected = new TypeError('fetch failed', { cause: new Error('x'.repeat(165) + vast.key + '\nremote failure') }); injectedLeft = 1
  await client.volumes().then(() => check('fallback cause is redacted before clipping', false), error => check('fallback cause is redacted before clipping', error.message.includes('[redacted]') && !error.message.includes('fixture-vast') && !error.message.includes('\n')))
  injected = new DOMException('Aborted', 'AbortError'); injectedLeft = 1
  await client.volumes().then(() => check('abort is distinguished', false), error => check('abort is distinguished', error.message.includes('aborted')))
  if (hostScreenRead) {
    const cancel = new AbortController()
    let reads = 0
    const timer = setTimeout(() => cancel.abort(new Error('fixture cancel')), 10)
    try { await hostScreenRead(async () => { reads++; throw new HostVendorNetworkError('network error', 'ECONNRESET') }, cancel.signal) } catch (error) { check('cancellation interrupts screen backoff', cancel.signal.aborted && error instanceof Error && (error === cancel.signal.reason || error.cause === cancel.signal.reason) && reads === 1) } finally { clearTimeout(timer) }
  }

  const React = await import('react')
  const { Box } = await import('../../src/ink.ts')
  const { AppStateProvider } = await import('../../src/state/AppState.tsx')
  const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
  const { SettingsPopupSlot } = await import('../../src/components/SettingsPopupSlot.tsx')
  const popup = await import('../../src/utils/cockpit/settingsPopup.ts')
  const { llmHostPopupRequest } = await import('../../src/commands/llmhost/llmhost.tsx')
  for (const [width, height] of [[120, 40], [80, 24]] as const) {
    let question: LlmHostQuestion | undefined
    const implementation = road('frame-' + width)
    const driven: LlmHostRoad = (ask, emit, signal) => implementation(plan => { question = plan; return ask(plan) }, emit, signal)
    mounted = await mountOffscreen(React.createElement(AppStateProvider, {}, React.createElement(ThemeProvider, {}, React.createElement(Box, { flexDirection: 'column', width, height }, React.createElement(SettingsPopupSlot)))), width, height)
    const screen = () => mounted!.screen()
    const step = async (name: string) => assert.ok(await waitFor(() => question?.step === name && screen().includes(question.title.slice(0, 24)), 15000), name + '\n' + screen())
    let tracked: { plan: LlmHostQuestion; at: number | null } | undefined
    const choose = async (value: string) => {
      const plan = question!
      const rows = plan.rows ?? []
      const target = rows.findIndex(row => row.value === value)
      assert.ok(target >= 0, value + '\n' + screen())
      if (tracked?.plan !== plan) { const initial = rows.findIndex(row => row.value === plan.initial); tracked = { plan, at: initial < 0 ? null : initial } }
      while (tracked.at !== target) {
        const before = screen()
        const down = tracked.at === null || tracked.at < target
        mounted!.push(down ? KEY.down : KEY.up)
        tracked.at = tracked.at === null ? down ? 0 : rows.length - 1 : tracked.at + (down ? 1 : -1)
        assert.ok(await waitFor(() => screen() !== before, 3000), 'cursor moves')
      }
      mounted!.push(KEY.enter)
    }
    const capture = async (name: string) => {
      check(name + ': rendered frame has borders and no credential', screen().includes('╰') && !screen().includes(vast.key) && !screen().includes('RENDER ERROR'))
      if (!frames) return
      const base = join(frames, width + 'x' + height + '-' + name)
      writeFileSync(base + '.txt', screen())
      const grid = mounted!.lines().map((line, y) => Array.from(line.padEnd(width)).map((c, x) => ({ c, bg: mounted!.styleAt(x, y)?.bg ?? 'default', fg: mounted!.styleAt(x, y)?.fg ?? 'default', bold: mounted!.styleAt(x, y)?.bold ?? false })))
      writeFileSync(base + '.json', JSON.stringify({ grid, cols: width, rows: height }))
      await gridToPng(base + '.json', base + '.png')
    }
    const close = async () => { mounted!.push(KEY.esc); assert.ok(await waitFor(() => !popup.isSettingsPopupOpen(), 5000)); question = undefined }
    const open = async () => { popup.openSettingsPopup(llmHostPopupRequest(driven)); await step('door-models') }
    fail('timeout')
    await open()
    await choose('pods'); await step('paid-pods'); await capture('failed')
    check(width + ': instance is visible in the failed frame', screen().includes('7001'))
    await close(); await open(); await capture('first-screen-failed')
    const keys = question?.rows?.find(row => row.value === 'keys')
    if (keys) check(width + ': volume failure does not mark a readable key as broken', keys.label.includes('Vast.ai ✓') && !keys.label.includes('could not be read'))
    check(width + ': a volume-only failure does not make the machine count incomplete', !question?.rows?.find(row => row.value === 'pods')?.label.includes('+?'))
    await choose('pods'); await step('paid-pods')
    await choose('vendor-error:vast'); await step('door-vendor-error'); await capture('detail')
    if (question?.rows?.some(row => row.value === 'retry')) {
      vast.state.failNext = null
      await choose('retry'); await step('paid-pods'); await capture('recovered')
      check(width + ': explicit Retry refreshes machines and volumes', question.rows?.some(row => row.value === 'vastvolume:' + disk.id) && question.rows?.some(row => row.value === 'vast:7001') && !question.found.includes('unread') && !question.rows.some(row => row.value === 'vendor-error:vast'))
      await close(); await open(); await capture('first-screen-recovered')
      check(width + ': the reopened first screen has no stale volume error', !question?.found.includes('unread') && !question?.rows?.some(row => row.value === 'vendor-error:vast'))
    }
    await close()
    mounted.unmount(); mounted = undefined
    vast.state.failNext = null
  }
  check('no real endpoint or paid mutation was called', escaped.length === 0 && vast.state.creates === 0 && vast.state.deletes === 0 && vast.state.stops === 0 && vast.requests.every(row => row.method === 'GET' || row.path === '/api/v0/bundles/'))
  console.log('VAST SCREEN READS ' + (failures ? 'RED' : 'GREEN') + ' · ' + checks + ' checks · ' + failures + ' failures')
  process.exitCode = failures ? 1 : 0
} finally { mounted?.unmount(); globalThis.fetch = nativeFetch; await vast.close(); f.close() }
