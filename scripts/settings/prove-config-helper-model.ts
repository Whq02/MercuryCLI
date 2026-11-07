#!/usr/bin/env bun
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

const REPO = join(import.meta.dir, '..', '..')
process.chdir(REPO)
const HOME = pinScratchHome('mercury-config-helper-model')
process.env.HOME = HOME
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
delete process.env.MERCURY_LOCAL_BASE_URL
delete process.env.MERCURY_LOCAL_API_KEY
const frameDir = ((): string | undefined => {
  const index = process.argv.indexOf('--frames')
  return index < 0 ? undefined : process.argv[index + 1]
})()
if (frameDir) mkdirSync(frameDir, { recursive: true })

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}
async function finish(): Promise<never> {
  await releaseScratchHome(HOME)
  console.log(`\nprove-config-helper-model: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

type Route = (req: IncomingMessage, res: ServerResponse) => boolean
function serve(route: Route): Promise<{ server: Server; root: string; port: number }> {
  return new Promise(resolve => {
    const server = createServer((req, res) => {
      req.on('data', () => {})
      req.on('end', () => {
        if (!route(req, res)) {
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end('{}')
        }
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({ server, root: `http://127.0.0.1:${port}`, port })
    })
  })
}
const json = (res: ServerResponse, body: unknown): true => {
  res.writeHead(200, { 'content-type': 'application/json', server: 'TensorFold' })
  res.end(JSON.stringify(body))
  return true
}
const tensorFold = (model: string, window: number): Route => (req, res) => {
  const url = req.url ?? ''
  if (url === '/health') return json(res, { status: 'ok', model, model_ids: [model], max_batch_size: 8, warming: false, memory: { active: 3006477107, cache: 0, peak: 3279555608 }, live: { connections: 0, waiting: 0 }, version: '1.2.2', backend: 'metal', device: 'Apple M5 Pro' })
  if (/\/models$/.test(url)) return json(res, { object: 'list', data: [{ id: model, object: 'model', created: 1, owned_by: 'tensorfold', context_length: window, max_model_len: window, reasoning: { default_enabled: true } }] })
  return false
}
const helper2b = await serve(tensorFold('qwen3.5-2b', 32768))
const session27b = await serve(tensorFold('qwen3.8-27b', 131072))
process.env.MERCURY_LOCAL_PROBE_TARGETS = `tensorfold=${session27b.root}`

section('§0 the modules import (red on the base: no helper setting, no helper module)')
const mods = await (async () => {
  try {
    return {
      helper: await import('../../src/services/providers/local/tensorfoldHelper.js'),
      hosts: await import('../../src/services/providers/local/tensorfoldHosts.js'),
      utility: await import('../../src/utils/model/utilityModel.js'),
      discovery: await import('../../src/services/providers/local/localDiscovery.js'),
      catalogue: await import('../../src/services/providers/local/localCatalogue.js'),
      config: await import('../../src/utils/config/globalConfig.js'),
    }
  } catch (error) {
    check('the helper module imports', false, error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error))
    return undefined
  }
})()
const ready = mods ?? (await finish())
check('the helper module imports', true)
const { helper, hosts, utility, discovery, catalogue, config } = ready
config.enableConfigs()
hosts.rememberTensorFoldPort(helper2b.port)
await discovery.refreshLocalDiscovery({ force: true })
const GIB = 1024 ** 3
const session = catalogue.localRecordFor('local/qwen3.8-27b')

helper.__pinHelperReadsForTest({ engineFound: true, twoBOnDisk: true })

section('§1 the choices: sizes tagged with their engine, memory and fit, the session model only with a multi-slot cache')
{
  const choices = helper.helperModelChoices({ usable: 36 * GIB, banked4b: false, session })
  const notInstalled = helper.helperModelChoices({ usable: 36 * GIB, banked4b: false, session, engineFound: false, twoBOnDisk: false })[1]!
  check('2B says install TensorFold when the engine is not found (red on the fold: offered regardless)', !notInstalled.available && notInstalled.reason === helper.HELPER_NOT_INSTALLED_REASON && helper.helperChoiceWords(notInstalled).endsWith('· install TensorFold'), JSON.stringify(notInstalled))
  const notPulled = helper.helperModelChoices({ usable: 36 * GIB, banked4b: false, session, engineFound: true, twoBOnDisk: false })[1]!
  check('2B says pull the 2B in /tensorfold when the engine is found but the 2B is not on disk', !notPulled.available && notPulled.reason === helper.HELPER_2B_NOT_PULLED_REASON, JSON.stringify(notPulled))
  check('four choices: off, 2B, 4B, the session\'s local model', JSON.stringify(choices.map(choice => choice.size)) === JSON.stringify(['off', '2b', '4b', 'session']))
  const twoB = choices[1]!
  check('2B is tagged (TensorFold) with its memory as an estimate and fits', twoB.label === '2B (TensorFold)' && twoB.engine === 'tensorfold' && twoB.memory === '~5.0 GiB · an estimate' && twoB.fit === 'fits' && twoB.available, JSON.stringify(twoB))
  const fourB = choices[2]!
  check('4B is tagged (llama.cpp) and says pull it first when no 4B is banked', fourB.label === '4B (llama.cpp)' && fourB.engine === 'llamacpp' && fourB.reason === 'pull it first · /localsetup' && !fourB.available, JSON.stringify(fourB))
  check('a banked 4B is offered', helper.helperModelChoices({ usable: 36 * GIB, banked4b: true, session })[2]!.available)
  const sessionChoice = choices[3]!
  check('the 27B session model is greyed with the single-slot reason', sessionChoice.label === 'qwen3.8-27b (TensorFold)' && !sessionChoice.available && sessionChoice.reason === helper.HELPER_SINGLE_SLOT_REASON, JSON.stringify(sessionChoice))
  const twoBSession = helper.helperModelChoices({ usable: 36 * GIB, banked4b: false, session: catalogue.localRecordFor('local/qwen3.5-2b') })[3]!
  check('a session model with a multi-slot cache is offered', twoBSession.available && twoBSession.label === 'qwen3.5-2b (TensorFold)' && twoBSession.modelId === 'local/qwen3.5-2b', JSON.stringify(twoBSession))
  const noSession = helper.helperModelChoices({ usable: 36 * GIB, banked4b: false, session: undefined })[3]!
  check('no local session model: the row says so', !noSession.available && noSession.reason === helper.HELPER_NO_SESSION_LOCAL_REASON)
  const tight = helper.helperModelChoices({ usable: 3 * GIB, banked4b: true, session: undefined })
  check('a machine too small greys the sizes with does not fit', tight[1]!.fit === 'does not fit' && !tight[1]!.available && tight[2]!.fit === 'does not fit')
  check('the jobs words: titles and summaries, the judge, compaction opt-in with its reason', helper.helperJobsWords(false) === 'titles and summaries ✓ · the judge ✓ · compaction ✗ · a small model can drop details' && helper.helperJobsWords(true) === 'titles and summaries ✓ · the judge ✓ · compaction ✓')
  check('← → skip unavailable rows', helper.nextHelperModelSetting('off', 1, choices) === '2b' && helper.nextHelperModelSetting('2b', 1, choices) === 'off' && helper.nextHelperModelSetting('off', -1, choices) === '2b')
}

section('§2 the setting: off by default; on, the helper\'s own process answers the default selection of every seat\'s utility calls through utilityCallFor (a named model is itself)')
{
  check('off by default', helper.readHelperModelSetting().size === 'off' && helper.readHelperModelSetting().compaction === false)
  check('helperModelState reports off', JSON.stringify(hosts.helperModelState()) === JSON.stringify({ enabled: false }))
  check('off: titles ride the seat\'s own model', utility.utilityCallFor('claude-opus-5-5').model === 'claude-opus-5-5' && utility.utilityCallFor('local/qwen3.8-27b').model === 'local/qwen3.8-27b')
  check('off: nothing in the heading', helper.helperHeadingWords() === undefined)
  helper.writeHelperModelSetting({ size: '2b' })
  const state = hosts.helperModelState()
  check('2B: the state names the engine, the repo and the port of its own process', state.enabled && state.size === '2b' && state.engine === 'tensorfold' && state.repo === helper.HELPER_2B_REPO && state.port === helper2b.port, JSON.stringify(state))
  check('2B: titles, summaries and the judges route to the helper on a local seat and on an Anthropic seat alike (the user turned it on)', utility.utilityCallFor('local/qwen3.8-27b').model === 'local/qwen3.5-2b' && utility.utilityCallFor('claude-opus-5-5').model === 'local/qwen3.5-2b')
  check('2B: the call carries the helper\'s own road: thinking adaptive and the floor of the helper\'s ladder, not the seat\'s', utility.utilityCallFor('claude-opus-5-5').thinkingConfig.type === 'adaptive', JSON.stringify(utility.utilityCallFor('claude-opus-5-5')))
  check('2B: a hook that names the 27B gets the 27B at its own floor, never the slot, on a local seat', utility.utilityCallFor('local/qwen3.8-27b', { named: true }).model === 'local/qwen3.8-27b')
  process.env.MERCURY_MODEL = 'claude-opus-5-5'
  check('2B: on an Anthropic seat the default selection is the slot and a named model is itself', utility.utilityCallFor().model === 'local/qwen3.5-2b' && utility.utilityCallFor('local/qwen3.8-27b', { named: true }).model === 'local/qwen3.8-27b' && utility.utilityCallFor('claude-opus-5-5', { named: true }).model === 'claude-opus-5-5')
  process.env.MERCURY_MODEL = 'local/qwen3.8-27b'
  check('2B: on a local seat the default selection is the slot and a named local model is itself', utility.utilityCallFor().model === 'local/qwen3.5-2b' && utility.utilityCallFor('local/qwen3.8-27b', { named: true }).model === 'local/qwen3.8-27b' && utility.utilityCallFor('local/qwen3.5-2b', { named: true }).model === 'local/qwen3.5-2b')
  delete process.env.MERCURY_MODEL
  check('2B: the heading suffix', helper.helperHeadingWords() === '· helper 2B')
  check('2B: compaction stays on the session model until opted in', helper.helperCompactionModelId() === undefined)
  helper.writeHelperModelSetting({ compaction: true })
  check('compaction opt-in routes compaction to the helper', helper.helperCompactionModelId() === 'local/qwen3.5-2b')
  const { foldModelFor } = await import('../../src/services/compact/autoCompact.js')
  const { createUserMessage } = await import('../../src/utils/messages/factories.js')
  const short = [createUserMessage({ content: 'a short history' })]
  const long = [createUserMessage({ content: 'x'.repeat(400_000) })]
  helper.writeHelperModelSetting({ compaction: false })
  check('opt-in off: the seated model folds', foldModelFor(short, 'claude-opus-5-5', { forced: false }).source === 'seated')
  helper.writeHelperModelSetting({ compaction: true })
  const folded = foldModelFor(short, 'claude-opus-5-5', { forced: false })
  check('opt-in on, the helper serving, the history under its window: the helper folds', folded.model === 'local/qwen3.5-2b' && folded.source === 'helper', JSON.stringify(folded))
  const over = foldModelFor(long, 'claude-opus-5-5', { forced: false })
  check('opt-in on, the history past the helper\'s window: the seated model folds and the reason says why', over.model === 'claude-opus-5-5' && over.source === 'seated' && over.reason !== undefined && over.reason.includes('the helper local/qwen3.5-2b\'s window does not hold the history'), JSON.stringify(over))
  helper.writeHelperModelSetting({ size: '2b', compaction: true })
  const onLocal = foldModelFor(short, 'local/qwen3.8-27b', { forced: false })
  check('opt-in on with the session on a serving local model that holds the history: the strongest serving local model folds, not the helper (the plan\'s row 7)', onLocal.model === 'local/qwen3.8-27b' && onLocal.source === 'seated' && onLocal.reason === undefined, JSON.stringify(onLocal))
  const onLocalOver = foldModelFor([createUserMessage({ content: 'x'.repeat(600_000) })], 'local/qwen3.8-27b', { forced: false })
  check('the history past the session model\'s window and the helper\'s: the fold falls through to the existing law', onLocalOver.source !== 'helper', JSON.stringify(onLocalOver))
  helper.writeHelperModelSetting({ size: 'off', compaction: false })
  check('opt-in with the helper off: the seated model folds, no reason', foldModelFor(short, 'claude-opus-5-5', { forced: false }).reason === undefined)
}

section('§2b the helper is its own process beside the session\'s server, started by the product when a session opens with the slot set or with the first small job: role helper, the 27B\'s record untouched')
{
  helper.__resetHelperForTest()
  const sessionRecord = { repo: 'TensorFold/Qwen3.8-27B-MLX-4bit', name: 'qwen3.8-27b', port: session27b.port, window: 131072, pid: 4242, startedAt: '2026-11-05T00:00:00.000Z' }
  const started: Array<Record<string, unknown>> = []
  const stopped: string[] = []
  let helperRecord: { repo: string; name: string; port: number; window: number; pid: number; startedAt: string } | undefined
  helper.__pinHelperServeSeamForTest(async () => ({
    start: async request => {
      started.push({ ...request })
      helperRecord = { repo: request.repo, name: request.name ?? 'x', port: helper2b.port, window: request.window, pid: 777, startedAt: '2026-11-05T00:00:01.000Z' }
      return helperRecord
    },
    stop: async name => {
      stopped.push(name)
      helperRecord = undefined
    },
    served: () => (helperRecord === undefined ? [] : [helperRecord]),
  }))
  hosts.forgetTensorFoldPort(helper2b.port)
  await discovery.refreshLocalDiscovery({ force: true })
  helper.writeHelperModelSetting({ size: '2b' })
  check('before the start the helper is not serving and a named model never consults it', hosts.helperModelState().port === undefined && utility.utilityCallFor('local/qwen3.8-27b', { named: true }).model === 'local/qwen3.8-27b')
  const quiet = async (ms: number): Promise<void> => { await new Promise(resolve => setTimeout(resolve, ms)) }
  const until = async (done: () => boolean, ms = 5_000): Promise<void> => {
    const begun = Date.now()
    while (!done() && Date.now() - begun < ms) await quiet(25)
  }
  process.env.MERCURY_MODEL = 'local/qwen3.8-27b'
  const { armLocalWarm, disarmLocalWarm } = await import('../../src/services/providers/local/localWarm.js')
  helper.__pinHelperReadsForTest({ engineFound: true, twoBOnDisk: false })
  armLocalWarm(() => ({ messages: [], systemPrompt: [], tools: [] } as never), { io: { settleMs: 0 } })
  await quiet(500)
  disarmLocalWarm()
  check('a stored 2B that is not available (not on disk) is not started when a local session opens: the start goes through the availability gate', started.length === 0, JSON.stringify(started))
  helper.__pinHelperReadsForTest({ engineFound: true, twoBOnDisk: true })
  armLocalWarm(() => ({ messages: [], systemPrompt: [], tools: [] } as never), { io: { settleMs: 0 } })
  const startedBy = Date.now()
  await until(() => started.length > 0)
  disarmLocalWarm()
  delete process.env.MERCURY_MODEL
  check('a local session opening with the slot set starts the helper itself: no start after the unavailable open, one start after the warm-up settle armed with the 2B available (the trigger is the settle)', started.length === 1, JSON.stringify(started))
  console.log(`  the start the seam saw: role=${started[0]?.role} name=${started[0]?.name} · recorded after armLocalWarm on the 27B seat, ${Date.now() - startedBy} ms after arming`)
  const config = readFileSync(join(REPO, 'src/components/Settings/Config.tsx'), 'utf8')
  check('/config\'s row only writes the setting, records it and bumps: no start on the row', /writeHelperModelSetting\(\{ size: next \}, writeGlobal\)\n\s*recordSet\('helperModel'/.test(config) && !config.includes('ensureHelperServing'))
  const request = started[0]
  check('the helper started once, with role helper, its own name, window, port and prompt cache', started.length === 1 && request?.role === 'helper' && request.name === 'qwen3.5-2b' && request.repo === helper.HELPER_2B_REPO && request.window === 32768 && request.promptCacheGib === 1 && typeof request.port === 'number', JSON.stringify(request))
  check('the session\'s 27B record is untouched (never stopped)', stopped.length === 0 && sessionRecord.port === session27b.port)
  check('the helper\'s served record is its own', (await helper.helperServedRecord())?.name === 'qwen3.5-2b' && (await helper.helperServedRecord())?.port === helper2b.port)
  check('after the start the helper answers the local seat\'s small jobs', hosts.helperModelState().port === helper2b.port && utility.utilityCallFor('local/qwen3.8-27b').model === 'local/qwen3.5-2b')
  await helper.stopHelperServing()
  check('stopping the helper stops only the helper\'s name through its role', JSON.stringify(stopped) === JSON.stringify(['qwen3.5-2b']) && (await helper.helperServedRecord()) === undefined)
  hosts.forgetTensorFoldPort(helper2b.port)
  await discovery.refreshLocalDiscovery({ force: true })
  process.env.MERCURY_MODEL = 'claude-opus-5-5'
  armLocalWarm(() => ({ messages: [], systemPrompt: [], tools: [] } as never), { io: { settleMs: 0 } })
  const cloudStartedBy = Date.now()
  while (started.length < 2 && Date.now() - cloudStartedBy < 5_000) await new Promise(resolve => setTimeout(resolve, 25))
  disarmLocalWarm()
  delete process.env.MERCURY_MODEL
  check('a cloud session opening with the slot set starts the helper too: the setting is the user\'s choice on every road', started.length === 2 && started[1]?.role === 'helper' && started[1].name === 'qwen3.5-2b', JSON.stringify(started))
  await helper.stopHelperServing()
  hosts.forgetTensorFoldPort(helper2b.port)
  await discovery.refreshLocalDiscovery({ force: true })
  check('the helper stopped and nothing is serving before the first small job', hosts.helperModelState().port === undefined && started.length === 2)
  process.env.MERCURY_MODEL = 'claude-opus-5-5'
  const firstJob = utility.utilityCallFor()
  check('the first small job with the setting on and nothing serving runs on the seat\'s model (never blocked on a model load)', firstJob.model === 'claude-opus-5-5', JSON.stringify(firstJob))
  await until(() => started.length > 2)
  check('that job fired the start once: role helper, the 2B by name', started.length === 3 && started[2]?.role === 'helper' && started[2].name === 'qwen3.5-2b', JSON.stringify(started))
  await until(() => hosts.helperModelState().port === helper2b.port)
  const secondJob = utility.utilityCallFor()
  await quiet(300)
  check('the next small job rides the helper, and no second start fired', secondJob.model === 'local/qwen3.5-2b' && started.length === 3, JSON.stringify({ secondJob, started }))
  delete process.env.MERCURY_MODEL
  await helper.stopHelperServing()
  helper.__pinHelperServeSeamForTest(undefined)
  helper.writeHelperModelSetting({ size: 'off', compaction: false })
  hosts.forgetTensorFoldPort(helper2b.port)
  await discovery.refreshLocalDiscovery({ force: true })
}

const React = await import('react')
const { Box } = await import('../../src/ink.js')
const { AppStateProvider } = await import('../../src/state/AppState.js')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.js')
const { SettingsPopupSlot } = await import('../../src/components/SettingsPopupSlot.js')
const store = await import('../../src/utils/cockpit/settingsPopup.js')
const { configPopupRequest } = await import('../../src/commands/config/config.js')
const { CONFIG_POPUP_HINT, CONFIG_ROW_MARK } = await import('../../src/components/Settings/Config.js')

async function mount(columns: number, rows: number): Promise<Mounted> {
  const element = React.createElement(
    AppStateProvider as never,
    {},
    React.createElement(ThemeProvider as never, {}, React.createElement(Box, { flexDirection: 'column', width: columns, height: rows }, React.createElement(SettingsPopupSlot, { overlay: true }))),
  )
  const m = await mountOffscreen(element, columns, rows)
  store.openSettingsPopup(configPopupRequest({ messages: [], options: {} } as never))
  await waitFor(() => m.screen().includes(CONFIG_POPUP_HINT.slice(-20)), 4000)
  await settle(150)
  return m
}
const save = (name: string, m: Mounted): void => {
  if (frameDir) writeFileSync(join(frameDir, `${name}.txt`), m.lines().join('\n') + '\n')
}
const rowOf = (m: Mounted, label: string): string => m.lines().find(line => line.includes(label)) ?? ''
const flatScreen = (m: Mounted): string => m.lines().map(line => line.replace(/^\s*│\s?/, '').replace(/\s*│\s*$/, '').trim()).filter(line => line !== '').join(' ')
const selectedLabel = (m: Mounted): string => ((m.lines().find(line => line.includes(`${CONFIG_ROW_MARK} `)) ?? '').split(`${CONFIG_ROW_MARK} `)[1] ?? '').split(/\s{2,}/)[0]?.trim() ?? ''

section('§3 the /config rows at 120x40: off → 2B → off, and the compaction row; stepping the row writes the setting and starts nothing')
{
  const started: Array<Record<string, unknown>> = []
  helper.__pinHelperServeSeamForTest(async () => ({
    start: async request => {
      started.push({ ...request })
      return { repo: request.repo, name: request.name ?? 'x', port: helper2b.port, window: request.window, pid: 777, startedAt: '2026-11-05T00:00:01.000Z' }
    },
    stop: async () => undefined,
    served: () => [],
  }))
  const m = await mount(120, 40)
  m.push('helper model')
  await settle(200)
  m.push(KEY.enter)
  await settle(200)
  check('the search lands on the Helper model row', selectedLabel(m) === 'Helper model', selectedLabel(m))
  check('off by default, the choices listed under the row with their engines', rowOf(m, 'Helper model ').includes('off') && flatScreen(m).includes('2B (TensorFold)') && flatScreen(m).includes('4B (llama.cpp)'), flatScreen(m).slice(0, 400))
  check('the compaction row stands beside with its reason', rowOf(m, 'Helper model for compaction').includes('off · a small model can drop details'), rowOf(m, 'Helper model for compaction'))
  save('config-helper-model-off-120x40', m)
  m.push(KEY.right)
  await settle(500)
  check('→ chooses 2B (TensorFold) with its memory', rowOf(m, 'Helper model ').includes('2B (TensorFold) · ~5.0 GiB · an estimate'), rowOf(m, 'Helper model '))
  check('the line under the row says when the helper starts and what it costs, then the jobs words', flatScreen(m).includes('starts with the next small job · ~5.0 GiB · an estimate · titles and summaries ✓ · the judge ✓ · compaction ✗ · a small model can drop details'), flatScreen(m).slice(0, 600))
  check('the setting is written', helper.readHelperModelSetting().size === '2b')
  check('stepping the row to 2B starts nothing: the seam saw no start', started.length === 0, JSON.stringify(started))
  save('config-helper-model-2b-120x40', m)
  m.push(KEY.right)
  await settle(300)
  check('→ again skips the unavailable 4B and the greyed session model, back to off', rowOf(m, 'Helper model ').includes('off') && helper.readHelperModelSetting().size === 'off', rowOf(m, 'Helper model '))
  m.push(KEY.down)
  await settle(150)
  m.push(KEY.right)
  await settle(300)
  check('→ on the compaction row opts in and keeps the reason', rowOf(m, 'Helper model for compaction').includes('on · a small model can drop details') && helper.readHelperModelSetting().compaction === true, rowOf(m, 'Helper model for compaction'))
  save('config-helper-model-compaction-120x40', m)
  m.push(KEY.esc)
  await settle(100)
  m.unmount()
  check('the whole visit started nothing', started.length === 0, JSON.stringify(started))
  helper.__pinHelperServeSeamForTest(undefined)
  helper.__resetHelperForTest()
}

for (const s of [helper2b.server, session27b.server]) s.close()
await finish()
