#!/usr/bin/env bun
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
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
      frontier: await import('../../src/utils/model/providerFrontier.js'),
      discovery: await import('../../src/services/providers/local/localDiscovery.js'),
      catalogue: await import('../../src/services/providers/local/localCatalogue.js'),
      config: await import('../../src/utils/config/globalConfig.js'),
      model: await import('../../src/utils/model/model.js'),
    }
  } catch (error) {
    check('the helper module imports', false, error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error))
    return undefined
  }
})()
const ready = mods ?? (await finish())
check('the helper module imports', true)
const { helper, hosts, frontier, discovery, catalogue, config, model } = ready
config.enableConfigs()
hosts.rememberTensorFoldPort(helper2b.port)
await discovery.refreshLocalDiscovery({ force: true })
const GIB = 1024 ** 3
const session = catalogue.localRecordFor('local/qwen3.8-27b')

section('§1 the choices: sizes tagged with their engine, memory and fit, the session model only with a multi-slot cache')
{
  const choices = helper.helperModelChoices({ usable: 36 * GIB, banked4b: false, session })
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

section('§2 the setting: off by default; on, the helper\'s own process answers the small jobs through smallFastModelFor')
{
  check('off by default', helper.readHelperModelSetting().size === 'off' && helper.readHelperModelSetting().compaction === false)
  check('helperModelState reports off', JSON.stringify(hosts.helperModelState()) === JSON.stringify({ enabled: false }))
  check('off: titles ride the usual small model', frontier.smallFastModelFor('claude-opus-5-5') === model.getSmallFastModel())
  check('off: nothing in the heading', helper.helperHeadingWords() === undefined)
  helper.writeHelperModelSetting({ size: '2b' })
  const state = hosts.helperModelState()
  check('2B: the state names the engine, the repo and the port of its own process', state.enabled && state.size === '2b' && state.engine === 'tensorfold' && state.repo === helper.HELPER_2B_REPO && state.port === helper2b.port, JSON.stringify(state))
  check('2B: titles, summaries and the judge route to the helper', frontier.smallFastModelFor('claude-opus-5-5') === 'local/qwen3.5-2b' && frontier.smallFastModelFor('local/qwen3.8-27b') === 'local/qwen3.5-2b')
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
  helper.writeHelperModelSetting({ size: 'off', compaction: false })
  check('opt-in with the helper off: the seated model folds, no reason', foldModelFor(short, 'claude-opus-5-5', { forced: false }).reason === undefined)
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

section('§3 the /config rows at 120x40: off → 2B → off, and the compaction row')
{
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
  await settle(300)
  check('→ chooses 2B (TensorFold) with its memory', rowOf(m, 'Helper model ').includes('2B (TensorFold) · ~5.0 GiB · an estimate'), rowOf(m, 'Helper model '))
  check('the jobs words stand under the row', flatScreen(m).includes('titles and summaries ✓ · the judge ✓ · compaction ✗ · a small model can drop details'), flatScreen(m).slice(0, 600))
  check('the setting is written', helper.readHelperModelSetting().size === '2b')
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
}

for (const s of [helper2b.server, session27b.server]) s.close()
await finish()
