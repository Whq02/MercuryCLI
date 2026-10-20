import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { runpodFixture, fakeSshRunner, liveCatalogue } from '../host/runpodFixture.mjs'
import { gridToPng } from './gridToPng.ts'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const option = (name: string) => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1] }
const frames = option('--frames')
const cols = Number(option('--cols') ?? 120)
const height = 44
if (frames) mkdirSync(frames, { recursive: true })
let failures = 0
const check = (name: string, truth: unknown) => { console.log((truth ? 'PASS ' : 'FAIL ') + name); if (!truth) failures++ }
async function capture(m: Mounted, name: string) {
  check(name + ' has no render error', !m.screen().includes('RENDER ERROR'))
  if (!frames) return
  writeFileSync(join(frames, name + '-' + cols + '.txt'), m.screen())
  const grid = m.lines().map((line, y) => Array.from(line.padEnd(cols)).map((c, x) => { const s = m.styleAt(x, y); return { c, bg: s?.bg ?? 'default', fg: s?.fg ?? 'default', bold: s?.bold ?? false, rev: s?.inverse ?? false } }))
  const path = join(frames, name + '-' + cols + '.json')
  writeFileSync(path, JSON.stringify({ grid, cols, rows: height }))
  await gridToPng(path, join(frames, name + '-' + cols + '.png'))
}
const f = await llmhostFixture()
const rp = await runpodFixture()
let mounted: Mounted | undefined
let ssh: ReturnType<typeof fakeSshRunner> | undefined
try {
  const React = await import('react')
  const { Box, Text } = await import('../../src/ink.ts')
  const { AppStateProvider } = await import('../../src/state/AppState.tsx')
  const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
  const { SettingsPopupSlot, settingsPopupGeometry } = await import('../../src/components/SettingsPopupSlot.tsx')
  const popup = await import('../../src/utils/cockpit/settingsPopup.ts')
  const { llmHostPopupRequest } = await import('../../src/commands/llmhost/llmhost.tsx')
  const { createHostRoad } = await import('../../src/services/host/index.ts')
  const { hostRunner } = await import('../../src/services/host/ssh.ts')
  const { runHostJob } = await import('../../src/services/host/worker.ts')
  const { patchHostRecord, readHostRecord, writeHostRecord } = await import('../../src/services/host/store.ts')
  const { deliverHostNotices } = await import('../../src/services/host/notices.ts')
  const { getCommandQueue } = await import('../../src/utils/messageQueueManager.ts')
  const { runLlmHost } = await import('../../src/services/llmHost/index.ts')
  const steps: string[] = []
  const questions: any[] = []
  f.state.dialect = 'sglang'
  const single = await runLlmHost(async question => {
    steps.push(question.step)
    return ({ address: f.baseUrl, dialect: 'sglang', key: '', model: f.model, name: 'single', confirm: 'run' } as Record<string, string>)[question.step] ?? null
  }, () => {}, new AbortController().signal)
  check('one listed model does not ask a one-answer question', single.ok && !steps.includes('model'))
  check('registration still asks before requesting a reply', steps.includes('confirm'))
  ssh = fakeSshRunner(f.baseUrl, hostRunner)
  ssh.state.holdHealth = true
  const jobs: Promise<void>[] = []
  const road = createHostRoad({ apiBaseUrl: rp.baseUrl, runner: ssh.runner, pauseMs: 20, readyTimeoutMs: 5000, sessionId: 'polish-session', startJob: record => { jobs.push(runHostJob(record.id, record.generation!, { runner: ssh!.runner, pauseMs: 25, timeoutMs: 30_000, keepAlive: false })) } })
  const open = () => popup.openSettingsPopup(llmHostPopupRequest((ask, emit, signal) => road(question => { questions.push(question); return ask(question) }, emit, signal)))
  open()
  mounted = await mountOffscreen(React.createElement(AppStateProvider, {}, React.createElement(ThemeProvider, {}, React.createElement(Box, { width: cols, height, flexDirection: 'column' }, React.createElement(SettingsPopupSlot)))), cols, height)
  const m = mounted
  const until = async (text: string) => assert.ok(await waitFor(() => m.screen().includes(text), 15000), 'screen reaches ' + text + '\n' + m.screen())
  const choose = async (text: string) => {
    for (let n = 0; n < 30; n++) {
      const selected = m.lines().find(line => line.includes('› ')) ?? ''
      if (selected.includes(text)) { m.push(KEY.enter); return }
      m.push(KEY.down)
      assert.ok(await waitFor(() => (m.lines().find(line => line.includes('› ')) ?? '') !== selected, 3000), 'selection moves toward ' + text + '\n' + m.screen())
    }
    throw new Error('Choice not found: ' + text)
  }
  const text = async (title: string, value = '') => { await until(title); if (value) { m.push(value); await until(value) } m.push(KEY.enter) }
  const close = async () => { m.push(KEY.esc); assert.ok(await waitFor(() => !popup.isSettingsPopupOpen(), 3000)) }
  await until('Where should the model run?'); await capture(m, 'host-doors')
  const geometry = settingsPopupGeometry(llmHostPopupRequest(), cols, height)
  console.log('MEASURE host columns=' + cols + ' left=' + geometry.left + ' content=' + geometry.inner)
  check('hosting uses the available width with only the frame gutter', geometry.left === 1 && geometry.inner >= cols - 6)
  await choose('Rent a GPU'); await until('Runpod API key'); m.push(rp.key); await until('********'); await capture(m, 'host-key'); m.push(KEY.enter)
  await text('Optional spending budget', '70'); await until('Choose a model'); await capture(m, 'host-models')
  await choose('Qwen3.8-27B'); await until('Confirm the hourly price'); await capture(m, 'host-confirm')
  const confirm = questions.at(-1)
  check('one stocked shape skips the shape question and spends nothing before confirm', confirm.step === 'rent-confirm' && !questions.some(q => q.step === 'offers') && rp.state.creates === 0)
  check('confirmation replaces the generic wait with per-step estimates and uncertainty', !confirm.willRun.includes('20–90') && /engine|builds|installs/.test(confirm.willRun) && /downloads/.test(confirm.willRun) && /loads/.test(confirm.willRun))
  check('the confirmation paints its storage and billing words at this width', m.lines().map(line => line.replaceAll('│', '')).join(' ').replace(/\s+/g, ' ').includes('billing starts') && m.screen().includes('disk'))
  await choose('Confirm $2.49/hr'); await until('Pod controls')
  assert.ok(await waitFor(() => readHostRecord('fixture-pod-1')?.step?.startsWith('downloading weights'), 10000))
  patchHostRecord('fixture-pod-1', { startedAt: new Date(Date.now() - 3600_000).toISOString(), step: 'downloading weights 18.70 GB of 187 GB' })
  await until('downloading weights'); await capture(m, 'host-setup-log')
  check('setup tells Escape closes without cancelling the job', m.screen().includes('setup keeps running'))
  await close()
  open(); await until('fixture-pod-1'); await choose('Pods I’m paying for'); await until('Live account list'); await until('fixture-pod-1'); await capture(m, 'host-paid-pods')
  check('paid pod rows name the step, elapsed time and estimated cost so far', m.screen().includes('downloading') && m.screen().includes('so far') && /1[.:]00|1\.0h|60 min/.test(m.screen()))
  await close()
  ssh.state.holdHealth = false
  await Promise.all(jobs)
  assert.ok(readHostRecord('fixture-pod-1')?.jobState === 'ready')
  const settings = JSON.parse(readFileSync(join(f.home, 'settings.json'), 'utf8'))
  check('worker associates its provider with the pod for later termination', settings.compatProvider['pod-fixture-pod-1'].hostPodId === 'fixture-pod-1')
  deliverHostNotices('polish-session')
  const ready = getCommandQueue().filter(row => row.mode === 'task-notification').map(row => String(row.value)).find(words => words.includes('ready')) ?? ''
  check('ready notice names its /model row and how to pick it', ready.includes('/model') && ready.includes('pod-fixture-pod-1') && /pick|select|choose/.test(ready))
  const notice = await mountOffscreen(React.createElement(Text, null, ready), cols, height)
  try { await waitFor(() => notice.screen().includes('ready'), 3000); await capture(notice, 'host-ready-notice') } finally { notice.unmount() }
  open(); await until('fixture-pod-1'); await choose('fixture-pod-1'); await until('Pod controls'); await capture(m, 'host-ready-controls'); await choose('Terminate'); await until('Confirm terminate'); await choose('Confirm terminate'); await until('Pod terminated'); await close()
  writeHostRecord({ id: 'watch-polish', name: 'GLM-5.3-Flash', recipe: 'glm53-flash-gguf-b300', jobKind: 'watch', jobState: 'queued', price: 8.99, maxPrice: 8.99, startedAt: new Date(Date.now() - 300_000).toISOString(), status: 'WATCHING', step: 'Waiting for stock at $8.99/hr or less' })
  open(); await until('Where should the model run?'); await choose('Pods I’m paying for'); await until('Live account list'); await until('watch-polish'); await capture(m, 'host-watch-row'); await close()
  rp.state.customGpus = liveCatalogue.gpus.filter((row: any) => ['NVIDIA H200', 'NVIDIA RTX PRO 6000 Blackwell Server Edition'].includes(row.id)).map((row: any) => ({ ...row, availability: 'HIGH', dataCenters: [{ id: 'EU-FIXTURE', availability: 'HIGH' }] }))
  open(); await until('Where should the model run?'); await choose('Rent a GPU'); await text('Optional spending budget'); await until('Choose a model'); await choose('Qwen3.8-27B'); await until('Choose a GPU shape'); await capture(m, 'host-shapes')
  check('shape verification is visible at this width', m.screen().includes('documented'))
  await close()
  const { hostSetupEstimate } = await import('../../src/commands/llmhost/words.ts')
  const knownEstimate = hostSetupEstimate({ engine: 'llamacpp', diskGb: 300, weightsGb: 187 })
  check('known weights estimate is derived per step and discloses its download assumption', knownEstimate.includes('builds llama.cpp ~10 min') && knownEstimate.includes('downloads 187 GB ~20 min') && knownEstimate.includes('loads ~3 min') && knownEstimate.includes('~35 min total') && knownEstimate.includes('~10 GB/min'))
  const estimateView = await mountOffscreen(React.createElement(Text, null, knownEstimate), cols, height)
  try { await waitFor(() => estimateView.screen().includes('builds llama.cpp'), 3000); await capture(estimateView, 'host-known-size-estimate') } finally { estimateView.unmount() }
  console.log('BETA40 HOST POLISH ' + (failures ? 'RED' : 'GREEN') + ' — ' + failures + ' failures')
  process.exitCode = failures ? 1 : 0
} finally { mounted?.unmount(); ssh?.close(); await rp.close(); f.close() }
