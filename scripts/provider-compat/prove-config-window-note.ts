#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

const HOME = pinScratchHome('mercury-config-window-note')
const PROJECT = join(HOME, 'project')
mkdirSync(PROJECT, { recursive: true })
process.chdir(PROJECT)
for (const key of ['MERCURY_MODEL', 'MERCURY_EFFORT_LEVEL', 'MERCURY_LOCAL_API_KEY', 'MERCURY_LOCAL_BASE_URL']) delete process.env[key]

let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 1400)}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}
const arg = (name: string): string | undefined => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined)
const frameDir = arg('--frames')
if (frameDir) mkdirSync(frameDir, { recursive: true })

const STATED = 'qwen3.8-27b-32k:latest'
const PLAIN = 'qwen3.8-27b:latest'
const GIB = 1024 ** 3
const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
const ollama = createServer((req: IncomingMessage, res: ServerResponse) => {
  let raw = ''
  req.on('data', chunk => {
    raw += String(chunk)
  })
  req.on('end', () => {
    const url = req.url ?? ''
    if (url === '/api/tags') return json(res, 200, { models: [STATED, PLAIN].map(name => ({ name, model: name, size: 17741872134, details: { family: 'qwen35', parameter_size: '27.3B', quantization_level: 'Q4_K_M' } })) })
    if (url === '/api/version') return json(res, 200, { version: '0.40.5' })
    if (url === '/api/ps') return json(res, 200, { models: [] })
    if (url === '/api/show') {
      const asked = String((raw ? (JSON.parse(raw) as { model?: string }) : {}).model ?? '')
      return json(res, 200, { parameters: asked === STATED ? 'temperature                    1\nnum_ctx                        32768' : 'temperature                    1', model_info: { 'general.architecture': 'qwen35', 'qwen35.context_length': 262144 }, capabilities: ['completion', 'tools', 'thinking'], details: { family: 'qwen35' } })
    }
    json(res, 404, { error: 'not found' })
  })
})
await new Promise<void>(done => ollama.listen(0, '127.0.0.1', () => done()))
const address = ollama.address()
process.env.MERCURY_LOCAL_PROBE_TARGETS = `ollama=http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { refreshLocalDiscovery } = await import('../../src/services/providers/local/localDiscovery.ts')
const { localRecordFor } = await import('../../src/services/providers/local/localCatalogue.ts')
const w = await import('../../src/services/providers/local/localWindow.ts')
const { __pinLocalServerTruthForTest } = await import('../../src/services/localServer/localServerTruth.ts')
const { localModelWindowRow, CONFIG_POPUP_HINT, CONFIG_ROW_MARK } = await import('../../src/components/Settings/Config.tsx')
__pinLocalServerTruthForTest({ loaded: [], listed: [], runners: [], launchForm: { kind: 'unknown', note: 'fixture' }, machine: { platform: 'darwin', totalMemoryBytes: 48 * GIB, usableMemoryBytes: 36 * GIB, usableSource: 'about three quarters of unified memory, the Metal default working set (no server log read)' }, readAtMs: Date.now() } as never)
await refreshLocalDiscovery({ force: true })
const stated = localRecordFor(`local/${STATED}`)!
const plain = localRecordFor(`local/${PLAIN}`)!

const FIT_CLAUSE = "the biggest of 32k · 64k · 128k whose projected load (weights + the KV cache of the layers that keep one, at the server's cache type and slots; the server's measured size once the model is loaded) fits the memory usable for models, never above the trained max; 256k only when you choose trained max or a number yourself — the rule /localsetup's step 5 uses"
const MODELFILE_CLAUSE = "the Modelfile's num_ctx, never raised; trained max or a number of yours replaces it"
const TAIL = '; held for the session; a change reloads the model on the next send (the ingested prompt is read again).'
const LAST = ' Ollama takes it as num_ctx on every request.'

section('§1 the row /config paints for a local model: what its note says auto means')
{
  check('the two tags are read as the server states them: one Modelfile names num_ctx 32768, the other names none', stated !== undefined && plain !== undefined && stated.modelfileContext === 32768 && plain.modelfileContext === undefined, JSON.stringify([stated?.modelfileContext, plain?.modelfileContext]))
  const auto = w.chooseLocalWindow(stated, 0, undefined)
  check("under auto the session's window for the Modelfile tag IS that figure: 32k, the Modelfile's num_ctx", auto.window === 32768 && auto.reason === 'set' && auto.words.startsWith("32k · the Modelfile's num_ctx"), JSON.stringify(auto))
  const row = localModelWindowRow(stated, 'local')
  console.log(`  [record] ${STATED}: ${row.valueText} | ${row.note}`)
  check('its note says so, in the words the window itself uses: auto = the Modelfile\'s num_ctx, never raised; trained max or a number of yours replaces it', row.note === `${STATED}: auto = ${MODELFILE_CLAUSE}${TAIL}${LAST}`, row.note)
  check('…and no longer claims the biggest rung that fits', !row.note.includes('the biggest of 32k'), row.note)
  const other = localModelWindowRow(plain, 'local')
  console.log(`  [record] ${PLAIN}: ${other.valueText} | ${other.note}`)
  check('a tag whose Modelfile states no num_ctx keeps the note it had, to the byte', other.note === `${PLAIN}: auto = ${FIT_CLAUSE}${TAIL}${LAST}`, other.note)
  check('…and auto there is still a rung chosen by the fit, not a stated figure', w.chooseLocalWindow(plain, 0, undefined).reason !== 'set', JSON.stringify(w.chooseLocalWindow(plain, 0, undefined)))
  w.writeLocalWindowSetting(stated, 65536)
  const numbered = localModelWindowRow(stated, 'local')
  check('with a number of yours set on the Modelfile tag the value names your number and the note still says what auto would be', numbered.valueText.startsWith('64k') && numbered.setByYou && numbered.note.startsWith(`${STATED}: auto = ${MODELFILE_CLAUSE}${TAIL}`), `${numbered.valueText} | ${numbered.note}`)
  w.writeLocalWindowSetting(stated, undefined)
}

const React = await import('react')
const { Box } = await import('../../src/ink.ts')
const { AppStateProvider } = await import('../../src/state/AppState.tsx')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
const { SettingsPopupSlot } = await import('../../src/components/SettingsPopupSlot.tsx')
const store = await import('../../src/utils/cockpit/settingsPopup.ts')
const { configPopupRequest } = await import('../../src/commands/config/config.tsx')

async function configOn(model: string): Promise<Mounted> {
  const state = { ...(getDefaultAppState() as unknown as Record<string, unknown>), engineModel: model, engineModelForSession: model }
  const element = React.createElement(
    AppStateProvider as never,
    { initialState: state } as never,
    React.createElement(ThemeProvider as never, {}, React.createElement(Box, { flexDirection: 'column', width: 178, height: 51 }, React.createElement(SettingsPopupSlot, { overlay: true }))),
  )
  const m = await mountOffscreen(element, 178, 51)
  store.openSettingsPopup(configPopupRequest({ messages: [], options: {} } as never))
  await waitFor(() => m.screen().includes(CONFIG_POPUP_HINT.slice(-20)), 4000)
  await settle(150)
  m.push('local model window')
  await settle(200)
  m.push(KEY.enter)
  await settle(200)
  return m
}
const flat = (m: Mounted): string => m.lines().map(line => line.replace(/^\s*│\s?/, '').replace(/\s*│\s*$/, '').trim()).filter(line => line !== '').join(' ').replace(/\s+/g, ' ')
const selected = (m: Mounted): string => ((m.lines().find(line => line.includes(`${CONFIG_ROW_MARK} `)) ?? '').split(`${CONFIG_ROW_MARK} `)[1] ?? '').split(/\s{2,}/)[0]?.trim() ?? ''

section('§2 the /config popup at 178x51, the Local model window row selected: the painted note')
for (const [tag, clause, name] of [[STATED, MODELFILE_CLAUSE, 'modelfile-tag'], [PLAIN, FIT_CLAUSE, 'plain-tag']] as const) {
  const m = await configOn(`local/${tag}`)
  if (frameDir) writeFileSync(join(frameDir, `config-window-note-${name}-178x51.txt`), m.lines().join('\n') + '\n')
  const painted = flat(m)
  check(`${tag}: the row is selected and the screen paints "auto = ${clause.slice(0, 44)}…"`, selected(m) === 'Local model window' && painted.includes(`${tag}: auto = ${clause}`.replace(/\s+/g, ' ')), `${selected(m)} · ${painted.slice(painted.indexOf(`${tag}: auto`), painted.indexOf(`${tag}: auto`) + 260)}`)
  store.closeSettingsPopup()
  await settle(60)
  m.unmount()
}

ollama.close()
await releaseScratchHome(HOME)
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} — ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
