import assert from 'node:assert/strict'
import { existsSync, readFileSync, mkdirSync, writeFileSync, statSync } from 'node:fs'
import { KEY, mountOffscreen, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { runpodFixture, fakeSshRunner, liveCatalogue } from './runpodFixture.mjs'
import { gridToPng } from '../ui/gridToPng.ts'
import { join } from 'node:path'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const source = join(import.meta.dir, '../../src/services/host/tune.ts')
assert.ok(existsSync(source), 'host tuning has a product entry point')
const tune = await import('../../src/services/host/tune.ts')
const { HOST_RECIPES } = await import('../../src/services/host/recipes.ts')
const glm = { ...HOST_RECIPES.find(row => row.id === 'glm53-flash-gguf-b300')!, weightsGb: 195 }
let checks = 0
const check = (name: string, truth: unknown) => { assert.ok(truth, name); console.log('PASS ' + name); checks++ }
const budget = tune.tuneBudget(glm, 288, 1)
const split = (n: number, ctx: number) => budget.candidates.find(row => row.conversations === n && row.contextPerConversation === ctx)
const stateGb = glm.kvBytesPerToken!.conversationBytes! / 1e9
check('one long conversation and four medium ones hold the same context memory; each extra conversation adds only its fixed state', Math.abs(split(4, 262144)!.requiredGb! - split(1, 1048576)!.requiredGb! - 3 * stateGb) < 1e-9 && Math.abs(split(2, 524288)!.requiredGb! - split(1, 1048576)!.requiredGb! - stateGb) < 1e-9)
check('weights are not confused with volume disk size', budget.weightsGb === 195)
check('unknown sizes offer only the recipe default', tune.tuneBudget({ ...glm, weightsGb: undefined, kvBytesPerToken: undefined }, 288, 1).candidates.length === 1)
check('unknown size words make no promise', tune.tuneBudget({ ...glm, weightsGb: undefined }, 288, 1).words.includes('weights size unknown'))
check('balanced quality is explicit', tune.qualityWords(glm).includes('Balanced · 4-bit'))
check('FP8 quality is explicit', tune.qualityWords({ ...glm, label: 'GLM-5.3-Flash · FP8' }).includes('Best quality · 8-bit FP8'))
check('NVFP4 quality carries community provenance', tune.qualityWords(HOST_RECIPES.find(row => row.id === 'glm53-flash-b200-community')!).includes('Fast crew · NVFP4'))
check('unknown variant is never guessed', tune.qualityWords({ ...glm, label: 'Model · mystery' }) === 'mystery')

check('per token the engine keeps the 11 attention layers\' latent and indexer row at q8_0, not all 45 layers', glm.kvBytesPerToken?.bytes === 10472 && glm.kvBytesPerToken.bytes === 11 * (512 + 3 * 128) * 34 / 32 && glm.kvBytesPerToken.verified.source.endsWith('/config.json'))
check('the 34 linear-attention layers cost a fixed f32 state per conversation, whatever its length', glm.kvBytesPerToken?.conversationBytes === 152633344 && glm.kvBytesPerToken.conversationBytes === 34 * (3 * 3 * 64 * 128 + 128 * 128 * 64) * 4)
check('engine overhead is a visible allowance', budget.words.includes('12 GB/GPU engine allowance'))
check('the estimate for the measured launch sits above the 193,464 MiB the B300 run used and inside the GPU', split(4, 131072)!.requiredGb! >= 193464 * 2 ** 20 / 1e9 && split(4, 131072)!.requiredGb! <= 288)
check('the measured launch carries the measured qualifier', split(4, 131072)!.measured && split(4, 131072)!.label.includes('measured to fit'))
check('eight conversations of 64k hold eight states, more than the measured four, so the split is an estimate', !split(8, 65536)!.measured && split(8, 65536)!.label.includes('should fit (estimate)'))
check('the room line counts the context the GPU holds after weights, states and allowance', budget.totalTokens === Math.floor(((288 - 12) * 1 - 195 - 4 * glm.kvBytesPerToken!.conversationBytes! / 1e9) * 1e9 / 10472))
check('a weights size from the files reads as one decimal', tune.tuneBudget({ ...glm, weightsGb: 199.716751456 }, 288, 1).words.includes('weights 199.7 GB · '))
check('a launch whose cache type is not the one the estimate assumed offers only the recipe default', tune.tuneBudget({ ...glm, flags: glm.flags.map(value => value === 'q8_0' ? 'f16' : value) }, 288, 1).candidates.length === 1 && tune.tuneBudget({ ...glm, flags: glm.flags.map(value => value === 'q8_0' ? 'f16' : value) }, 288, 1).words.includes('context memory unknown'))
check('1M is an estimate not a measurement', budget.candidates.find(row => row.conversations === 1)?.label.includes('should fit (estimate)'))
check('larger totals require another card', budget.candidates.find(row => row.conversations === 8 && row.contextPerConversation === 1048576)?.needsCount === 2)
const offer = { recipe: glm, gpuId: 'NVIDIA B300 SXM6 AC', price: 7.99, dataCenter: 'EU-NL-1', availability: 'HIGH' }
const bigger = { ...offer, recipe: { ...glm, count: 2 }, price: 18 }
check('price comes from an actual fitting offer', tune.tuneBudget(glm, 288, 1, [offer, bigger]).candidates.find(row => row.conversations === 8 && row.contextPerConversation === 1048576)?.label.includes('$18.00/hr'))
check('context is bounded by the model config, not a recipe default', budget.candidates.every(row => row.contextPerConversation! <= glm.kvBytesPerToken!.maxContext) && budget.candidates.some(row => row.contextPerConversation === 1048576))
const f = await llmhostFixture()
const rp = await runpodFixture()
let mounted: Mounted | undefined
let ssh: ReturnType<typeof fakeSshRunner> | undefined
try {
  const { exportHostRecipesJson } = await import('../../src/services/host/recipesFile.ts')
  const recipesPath = join(f.home, 'tune-recipes.json')
  writeFileSync(recipesPath, exportHostRecipesJson(HOST_RECIPES.map(row => row.id === glm.id ? glm : row)))
  process.env.MERCURY_HOST_RECIPES_FILE = recipesPath
  const { hostRunner, closeHostTunnel } = await import('../../src/services/host/ssh.ts')
  const { readHostRecord } = await import('../../src/services/host/store.ts')
  const { runHostJob } = await import('../../src/services/host/worker.ts')
  const { createHostRoad } = await import('../../src/services/host/index.ts')
  const { writeStoredRunpodApiKey } = await import('../../src/services/providers/providerSecrets.ts')
  const { getSettingsForSource, updateSettingsForSource } = await import('../../src/utils/settings/settings.ts')
  const { getContextWindowForModel } = await import('../../src/utils/model/capabilities.ts')
  const { resolveLlamacppTotalSlots } = await import('../../src/services/providers/openaicompat/compatProbe.ts')
  const { configuredCompatEndpoints } = await import('../../src/services/providers/openaicompat/compatAccounts.ts')
  const React = await import('react')
  const { Box } = await import('../../src/ink.ts')
  const { AppStateProvider } = await import('../../src/state/AppState.tsx')
  const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
  const { SettingsPopupSlot } = await import('../../src/components/SettingsPopupSlot.tsx')
  const popup = await import('../../src/utils/cockpit/settingsPopup.ts')
  const { llmHostPopupRequest } = await import('../../src/commands/llmhost/llmhost.tsx')
  const modelTitle = 'GLM-5.3-Flash'
  const prefsPath = join(f.home, 'host/preferences.json')
  f.state.dialect = 'llamacpp'; f.state.window = 131072; f.state.slots = 4
  ssh = fakeSshRunner(f.baseUrl, hostRunner, f.state)
  ssh.state.gpus = 'NVIDIA B300, 294912\nDOCKER_ENGINE_PRESENT'
  const notices: string[] = []
  const emit = (event: { words: string }) => { notices.push(event.words) }
  for (const cancelAt of ['tune-quality', 'tune-context', 'tune-thinking', 'tune-confirm']) {
    await tune.runTune(modelTitle, { recipes: [glm] }, async question => question.step === cancelAt ? null : question.step === 'tune-quality' ? glm.id : question.step === 'tune-context' ? '0' : 'high', emit)
    check('cancelling ' + cancelAt + ' writes no preferences', !existsSync(prefsPath))
  }
  const at = process.argv.indexOf('--frames')
  const frames = at < 0 ? undefined : process.argv[at + 1]
  if (frames) mkdirSync(frames, { recursive: true })
  const images: Promise<unknown>[] = []
  for (const width of [120, 80]) {
    const road: import('../../src/services/llmHost/index.ts').LlmHostRoad = async (ask, output, signal) => { const prefs = await tune.runTune(modelTitle, { recipes: HOST_RECIPES.map(row => row.id === glm.id ? glm : row), offers: [offer], signal }, ask, output); return { ok: Boolean(prefs), words: prefs ? 'Tune saved' : 'Tune unchanged' } }
    popup.openSettingsPopup(llmHostPopupRequest(road))
    mounted = await mountOffscreen(React.createElement(AppStateProvider, {}, React.createElement(ThemeProvider, {}, React.createElement(Box, { flexDirection: 'column', width, height: 44 }, React.createElement(SettingsPopupSlot)))), width, 44)
    const m = mounted
    const until = async (text: string) => assert.ok(await waitFor(() => m.screen().includes(text), 15000), text + '\n' + m.screen())
    const choose = async (text: string) => {
      if (!m.lines().some(row => row.includes('› '))) { m.push(KEY.down); assert.ok(await waitFor(() => m.lines().some(row => row.includes('› ')), 3000)) }
      for (let n = 0; n < 40; n++) {
        const selected = m.lines().find(row => row.includes('› ')) ?? ''
        if (selected.includes(text)) { m.push(KEY.enter); return }
        const lines = m.lines(); const target = lines.findIndex(row => row.includes(text)); const cursor = lines.findIndex(row => row.includes('› '))
        m.push(target >= 0 && target < cursor ? KEY.up : KEY.down)
        assert.ok(await waitFor(() => (m.lines().find(row => row.includes('› ')) ?? '') !== selected, 3000), 'select ' + text + '\n' + m.screen())
      }
      throw new Error('Missing ' + text)
    }
    const capture = (name: string) => {
      check(width + ' ' + name + ' paints its exit hint', m.screen().includes('esc') && !m.screen().includes('RENDER ERROR'))
      check(width + ' ' + name + ' keeps the GPU budget visible', m.screen().includes('288 GB/GPU'))
      check(width + ' ' + name + ' names no engine internals', !/\bKV\b|\bslots?\b/i.test(m.screen()))
      if (name === 'context') check(width + ' context names the room in words and keeps it whole', m.lines().some(row => row.includes('room for about 7.3M tokens in all, up to 1M each · esc closes')))
      if (!frames) return
      writeFileSync(join(frames, width + '-' + name + '.txt'), m.screen())
      const grid = m.lines().map((line, y) => Array.from(line.padEnd(width)).map((c, x) => { const style = m.styleAt(x, y); return { c, bg: style?.bg ?? 'default', fg: style?.fg ?? 'default', bold: style?.bold ?? false, rev: style?.inverse ?? false } }))
      const path = join(frames, width + '-' + name + '.json')
      writeFileSync(path, JSON.stringify({ grid, cols: width, rows: 44 }))
      images.push(gridToPng(path, join(frames, width + '-' + name + '.png')))
    }
    await until('QUALITY'); capture('quality'); await choose('Balanced')
    await until('CONVERSATIONS × CONTEXT'); capture('context'); await choose('1 × 1M')
    await until('THINKING'); capture('thinking'); await choose('high')
    await until('Confirm tune'); capture('confirm')
    if (width === 120) { check('nothing saved before final confirm', !existsSync(prefsPath)); await choose('Confirm · save'); await until('Tune saved') }
    else { m.push(KEY.esc); assert.ok(await waitFor(() => !popup.isSettingsPopupOpen(), 3000)); check('escape from confirm leaves earlier settings unchanged', tune.readTunePreferences(modelTitle)?.conversations === 1) }
    if (popup.isSettingsPopupOpen()) { m.push(KEY.esc); assert.ok(await waitFor(() => !popup.isSettingsPopupOpen(), 3000)) }
    mounted.unmount(); mounted = undefined
  }
  check('preferences persist all four choices with a timestamp', tune.readTunePreferences(modelTitle)?.quality === glm.id && tune.readTunePreferences(modelTitle)?.contextPerConversation === 1048576 && tune.readTunePreferences(modelTitle)?.effort === 'high' && Boolean(tune.readTunePreferences(modelTitle)?.updatedAt))
  check('preferences are private', (statSync(prefsPath).mode & 0o777) === 0o600)
  rp.state.customGpus = liveCatalogue.gpus.filter((gpu: any) => gpu.id === offer.gpuId).map((gpu: any) => ({ ...gpu, availability: 'HIGH', dataCenters: [{ id: 'EU-NL-1', availability: 'HIGH' }] }))
  writeStoredRunpodApiKey(rp.key)
  let job: Promise<void> | undefined
  let confirmWords = ''
  const road = createHostRoad({ apiBaseUrl: rp.baseUrl, runner: ssh.runner, pauseMs: 5, readyTimeoutMs: 3000, startJob: record => { job = runHostJob(record.id, record.generation!, { runner: ssh!.runner, pauseMs: 10, timeoutMs: 3000, keepAlive: false }) } })
  const answers: Record<string, string> = { 'door-models': 'other', where: 'rent', 'rental-vendor': 'runpod', budget: '', models: modelTitle, offers: '0' }
  const rented = await road(async question => {
    if (question.step === 'rent-confirm') { confirmWords = question.willRun; check('rent road exposes Tune', question.rows?.some(row => row.value === 'tune')); return 'rent' }
    if (question.step === 'pod-controls') return 'close'
    return answers[question.step] ?? null
  }, emit, new AbortController().signal)
  assert.ok(rented.ok, rented.words)
  await job
  check('rental confirms the saved four dials', confirmWords.includes('1 × 1M') && confirmWords.includes('4-bit') && confirmWords.includes('high'))
  const record = readHostRecord('fixture-pod-1')!
  check('rental background setup reaches ready', record.jobState === 'ready')
  check('rental carries the confirmed tuning snapshot', record.tune?.conversations === 1 && record.tune.contextPerConversation === 1048576)
  check('launch carries total context and parallel from preferences', ssh.state.script.includes("'1048576'") && ssh.state.script.includes("'--parallel' '1'"))
  check('launch carries default thinking from preferences', ssh.state.script.includes('reasoning_effort') && ssh.state.script.includes('high'))
  const model = 'compat/' + record.provider + '/' + f.model
  check('registration persists the per-conversation window', getSettingsForSource('userSettings')?.models?.[model]?.contextWindow === 1048576 && getContextWindowForModel(model) === 1048576)
  const change = updateSettingsForSource('userSettings', () => ({ models: { [model]: { maxOutputTokens: 98765 } } }))
  assert.equal(change.error, null)
  const endpoint = configuredCompatEndpoints().find(row => row.name === record.provider)!
  check('initial slots are read before reload', await resolveLlamacppTotalSlots(endpoint) === 1)
  const beforeCommands = ssh.commands.length
  const beforeCreates = rp.state.creates
  const next = { ...record.tune!, conversations: 8, contextPerConversation: 65536, effort: 'max' as const }
  const done = await tune.retuneHostEngine(record, next, ssh.runner, { pauseMs: 1, timeoutMs: 500, emit })
  check('running pod retunes successfully', done.ok)
  check('retune never allocates a new pod', rp.state.creates === beforeCreates)
  check('retune executes a new detached engine launch', ssh.commands.slice(beforeCommands).some((row: any) => row.args.at(-1).includes('nohup setsid')))
  check('retune keeps a backup before rewriting flags', ssh.state.backup.includes('1048576') && ssh.state.script.includes('--parallel 8') && ssh.state.script.includes('--ctx-size 524288'))
  check('retune never re-downloads or rebuilds weights', !/hf download|cmake|apt-get/.test(ssh.state.script))
  check('retune waits for health then reads props', ssh.commands.slice(beforeCommands).some((row: any) => row.args.at(-1).includes('/health')) && ssh.commands.slice(beforeCommands).some((row: any) => row.args.at(-1).includes('/props')))
  check('retune re-registers the per-slot window', getContextWindowForModel(model) === 65536 && getSettingsForSource('userSettings')?.models?.[model]?.contextWindow === 65536)
  check('retune never reduces the output ceiling', getSettingsForSource('userSettings')?.models?.[model]?.maxOutputTokens === 98765)
  check('retune invalidates and re-reads slot count', await resolveLlamacppTotalSlots(endpoint) === 8)
  check('record carries the applied tune and no reload claim', readHostRecord(record.id)?.tune?.conversations === 8 && readHostRecord(record.id)?.retuning === undefined)
  check('chat explains the reload without promising a time', notices.some(text => text.includes('retuned:') && text.includes('reloading the engine; it answers again once the weights are loaded')) && !notices.some(text => text.includes('~3 min')))
  const savedPrefs = readFileSync(prefsPath, 'utf8')
  ssh.state.failRetune = true
  const failed = await tune.retuneHostEngine(readHostRecord(record.id)!, { ...next, conversations: 1, contextPerConversation: 1048576 }, ssh.runner, { pauseMs: 1, timeoutMs: 60, emit })
  check('failed reload reports old flags restored', !failed.ok && failed.words.includes('old flags restored') && failed.words.includes('previous engine healthy'))
  check('rollback restores old context and parallel', ssh.state.script.includes('--parallel 8') && ssh.state.script.includes('--ctx-size 524288'))
  check('rollback also avoids reinstalling or downloading', !/hf download|cmake|apt-get/.test(ssh.state.script))
  check('failure preserves preferences and applied record', readFileSync(prefsPath, 'utf8') === savedPrefs && readHostRecord(record.id)?.tune?.conversations === 8)
  ssh.state.failRestore = true
  const dead = await tune.retuneHostEngine(readHostRecord(record.id)!, { ...next, conversations: 1, contextPerConversation: 1048576 }, ssh.runner, { pauseMs: 1, timeoutMs: 60 })
  check('a dead server is never reported healthy', !dead.ok && dead.words.includes('server did not come back') && dead.words.includes('old flags restored'))
  ssh.state.failRetune = false; ssh.state.failRestore = false
  let sawTune = false
  let enteredTune = false
  await road(async question => {
    if (question.step === 'door-models') return 'other'; if (question.step === 'where') return 'pod:' + record.id
    if (question.step === 'pod-controls') { sawTune = question.rows?.some(row => row.value === 'tune') ?? false; if (enteredTune) return 'close'; enteredTune = true; return 'tune' }
    if (question.step === 'tune-quality') return glm.id
    if (question.step === 'tune-context') return question.rows?.find(row => row.label.startsWith('1 × 1M'))?.value ?? null
    if (question.step === 'tune-thinking') return 'max'
    if (question.step === 'tune-confirm') return 'confirm'
    return null
  }, emit, new AbortController().signal)
  check('running pod controls expose Tune', sawTune)
  check('the running-pod entry point applies and saves its confirmed tune', readHostRecord(record.id)?.tune?.conversations === 1 && tune.readTunePreferences(modelTitle)?.effort === 'max' && rp.state.creates === beforeCreates)
  const cancel = new AbortController()
  const interrupted = await tune.retuneHostEngine(readHostRecord(record.id)!, next, { ...ssh.runner, async run(command, args, signal, timeout) { const output = await ssh!.runner.run(command, args, signal, timeout); if (args.at(-1)?.includes('restore = False')) cancel.abort(); return output } }, { signal: cancel.signal, pauseMs: 1, timeoutMs: 500 })
  check('cancelling a reload still restores the old flags with a fresh recovery signal', !interrupted.ok && interrupted.words.includes('old flags restored') && ssh.state.script.includes('--parallel 1'))
  let invalidReachable = false
  await tune.confirmTunedRental({ ...offer, recipe: { ...glm, weightsGb: undefined } }, [{ ...offer, recipe: { ...glm, weightsGb: undefined } }], undefined, async question => { invalidReachable = Boolean(question.rows?.some(row => row.value === 'tune')) && !question.rows?.some(row => row.value === 'rent'); return 'cancel' }, emit, new AbortController().signal)
  check('stale sizing leaves Tune reachable but cannot rent an unvalidated split', invalidReachable)
  const qwen = HOST_RECIPES.find(row => row.id === 'qwen38-27b-rtx-pro-6000')!
  let informational = false
  let unknownLimit = false
  const defaults = await tune.runTune('Qwen3.8-27B', { recipes: [qwen] }, async question => {
    if (question.step === 'tune-quality') return qwen.id
    if (question.step === 'tune-context') { unknownLimit = question.willRun.includes('limit not documented for this recipe'); return '0' }
    if (question.step === 'tune-thinking') { informational = question.rows?.length === 1 && question.rows[0]?.label === 'default · /effort changes it per request'; return 'default' }
    return 'confirm'
  }, emit)
  check('SGLang thinking is informational rather than an unsupported launch choice', informational && defaults?.effort === 'default')
  check('undocumented limits stay unknown without invented launch flags', unknownLimit && defaults?.conversations === null && defaults?.contextPerConversation === null && JSON.stringify(tune.tunedRecipe(qwen, defaults).flags) === JSON.stringify(qwen.flags))
  let glmLevels: string[] = []
  await tune.runTune(modelTitle, { recipes: [glm] }, async question => { if (question.step === 'tune-thinking') { glmLevels = question.rows?.map(row => row.value) ?? []; return null } return question.step === 'tune-quality' ? glm.id : '0' }, emit)
  check('GLM thinking offers only the levels its template honours: low and high by name, everything else as max', JSON.stringify(glmLevels) === JSON.stringify(['max', 'high', 'low']))
  let refusedMedium = ''
  try { tune.tunedRecipe(glm, { ...tune.defaultTune(glm), effort: 'medium' }) } catch (error) { refusedMedium = String(error) }
  check('a level the template would quietly turn into max is refused, not launched', refusedMedium.includes('thinking levels max, high, low'))
  const nemotron = HOST_RECIPES.find(row => row.id === 'nemotron35-super-gguf-rtx-pro-6000')!
  let nemotronRows: string[] = []
  await tune.runTune('Nemotron 3.5 Super VL 120B', { recipes: [nemotron] }, async question => { if (question.step === 'tune-thinking') { nemotronRows = question.rows?.map(row => row.label) ?? []; return null } return question.step === 'tune-quality' ? nemotron.id : '0' }, emit)
  const nemotronLaunch = tune.tunedRecipe(nemotron, tune.defaultTune(nemotron))
  check('a llama.cpp model whose template takes no named level shows thinking as information and launches without a reasoning_effort it would ignore', JSON.stringify(nemotronRows) === JSON.stringify(['default · this model has no named thinking levels']) && tune.defaultTune(nemotron).effort === 'default' && !nemotronLaunch.flags.includes('--chat-template-kwargs'))
  const beforeQuality = ssh.commands.length
  const alternative = HOST_RECIPES.find(row => row.id === 'glm53-flash-b200-community')!
  let nextRental = false
  await tune.runTune(modelTitle, { recipes: [glm, alternative], pod: readHostRecord(record.id)!, runner: ssh.runner }, async question => {
    if (question.step === 'tune-quality') return alternative.id
    if (question.step === 'tune-context') return '0'
    if (question.step === 'tune-thinking') return 'default'
    nextRental = question.rows?.[0]?.label.includes('applies at the next rental · no download now') ?? false
    return 'confirm'
  }, emit)
  check('different quality is explicitly deferred without touching the live engine', nextRental && ssh.commands.length === beforeQuality && tune.readTunePreferences(modelTitle)?.quality === alternative.id && readHostRecord(record.id)?.recipe === glm.id)
  closeHostTunnel(record.id)
  await Promise.all(images)
  console.log('HOST TUNE GREEN — ' + checks + ' checks; fixture-only rental, popup, launch, reload and rollback')
} finally { mounted?.unmount(); ssh?.close(); await rp.close(); f.close(); delete process.env.MERCURY_HOST_RECIPES_FILE }
