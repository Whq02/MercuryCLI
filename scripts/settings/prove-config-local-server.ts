#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

const REPO = join(import.meta.dir, '..', '..')
process.chdir(REPO)
const HOME = pinScratchHome('mercury-config-local-server')
process.env.HOME = HOME
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_LOCAL_BASE_URL
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
  console.log(`\nprove-config-local-server: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

section('§0 the page module exists (red on the base: the component and the reader are absent)')
const mods = await (async () => {
  try {
    return { page: await import('../../src/components/Settings/LocalServer.js'), truth: await import('../../src/services/localServer/localServerTruth.js') }
  } catch (error) {
    check('src/components/Settings/LocalServer.tsx and src/services/localServer import', false, error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error))
    return undefined
  }
})()
const ready = mods ?? (await finish())
check('the page and the reader import', true)
const { __pinLocalServerTruthForTest } = ready.truth
const { LOCAL_SERVER_ROW_IDS, serverRowWords, loadedRowWords, runnerRowWords, expiryWords, tildePath } = ready.page

const GIB = 1024 ** 3
const AGENTS = join(HOME, 'Library', 'LaunchAgents')
mkdirSync(AGENTS, { recursive: true })
const PLIST_PATH = join(AGENTS, 'com.example.ollama-ssd.plist')
const ENV_PAIRS: Array<[string, string]> = [['OLLAMA_CONTEXT_LENGTH', '262144'], ['OLLAMA_FLASH_ATTENTION', '1'], ['OLLAMA_HOST', '127.0.0.1:11434'], ['OLLAMA_KEEP_ALIVE', '30m'], ['OLLAMA_KV_CACHE_TYPE', 'q8_0'], ['OLLAMA_MAX_LOADED_MODELS', '1'], ['OLLAMA_MODELS', '/Volumes/SSD/ollama']]
const PLIST = ['<?xml version="1.0" encoding="UTF-8"?>', '<plist version="1.0">', '<dict>', '\t<key>EnvironmentVariables</key>', '\t<dict>', ...ENV_PAIRS.flatMap(([k, v]) => [`\t\t<key>${k}</key>`, `\t\t<string>${v}</string>`]), '\t</dict>', '\t<key>Label</key>', '\t<string>com.example.ollama-ssd</string>', '</dict>', '</plist>', ''].join('\n')
writeFileSync(PLIST_PATH, PLIST)
const env = Object.fromEntries(ENV_PAIRS)
const kvHeads = (blocks: number): number[] => Array.from({ length: blocks }, (_, i) => ((i + 1) % 4 === 0 ? 4 : 0))
const geometry27 = { kvHeads: kvHeads(64).reduce((a, b) => a + b, 0), keyLength: 256, valueLength: 256, attentionLayers: 16, blockCount: 64 }
const geometry9 = { kvHeads: kvHeads(32).reduce((a, b) => a + b, 0), keyLength: 256, valueLength: 256, attentionLayers: 8, blockCount: 32 }
const now = Date.now()
const TRUTH = {
  server: { kind: 'ollama' as const, root: 'http://127.0.0.1:11434', version: '0.34.4', label: 'Ollama 0.34.4' },
  loaded: [{ name: 'qwen3.5:9b-q4_K_M', sizeBytes: 12227507649, sizeVramBytes: 12227507649, contextLength: 262144, expiresAt: new Date(now + 23 * 60_000).toISOString(), parameterSize: '9.7B', quantization: 'Q4_K_M' }],
  listed: [
    { name: 'qwen3.5:27b', sizeBytes: 17420432728, parameterSize: '27.8B', quantization: 'Q4_K_M', family: 'qwen35', trainedContext: 262144, geometry: geometry27 },
    { name: 'qwen3.5:9b-q4_K_M', sizeBytes: 6594474711, parameterSize: '9.7B', quantization: 'Q4_K_M', family: 'qwen35', trainedContext: 262144, geometry: geometry9 },
  ],
  process: { pid: 16812, command: '/opt/homebrew/opt/ollama/bin/ollama serve', env, envReadable: true },
  runners: [{ pid: 42323, command: 'llama-server -c 262144 -np 1', slots: 1, context: 262144, cacheTypeK: 'q8_0', cacheTypeV: 'q8_0', flashAttention: 'on' }],
  launchForm: { kind: 'launch-agent' as const, path: PLIST_PATH, label: 'com.example.ollama-ssd', env, writable: true, confirmed: true, logPath: join(HOME, 'Library', 'Logs', 'ollama.log'), note: 'launch agent: the environment is written into its EnvironmentVariables and the agent is restarted' },
  machine: { platform: 'darwin' as const, totalMemoryBytes: 48 * GIB, usableMemoryBytes: Math.round(36.9 * GIB), usableSource: `the server's own gpu memory line in ${join(HOME, 'Library', 'Logs', 'ollama.log')} (Metal)` },
  readAtMs: now,
}
__pinLocalServerTruthForTest(TRUTH)
writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ localServer: { maxLoadedModels: 2, parallelSlots: 1 } }, null, 2))

section('§1 the pure words')
{
  check('the server row: label, host, launch agent', serverRowWords(TRUTH, false) === 'Ollama 0.34.4 · 127.0.0.1:11434 · launch agent com.example.ollama-ssd', serverRowWords(TRUTH, false))
  check('the loaded row: name, window, size, expiry', loadedRowWords(TRUTH, now) === 'qwen3.5:9b-q4_K_M · 256k window · 11.4 GiB · unloads in 23 min', loadedRowWords(TRUTH, now))
  check('the runner row: slots, context, cache, flash attention', runnerRowWords(TRUTH) === '1 slot · 256k context · q8_0 cache · flash attention on', runnerRowWords(TRUTH))
  check('expiry words: kept loaded for a far date, hours past two hours, unloading when past', expiryWords('2100-01-01T00:00:00Z', now) === 'kept loaded' && expiryWords(new Date(now + 3 * 3600_000).toISOString(), now) === 'unloads in 3 h' && expiryWords(new Date(now - 1000).toISOString(), now) === 'unloading' && expiryWords(undefined, now) === undefined)
  check('probing off and no server read honestly', serverRowWords(null, true).startsWith('probing off') && serverRowWords({ ...TRUTH, server: undefined }, false).startsWith('no local server answering'))
  check('tildePath folds the home', tildePath('/Users/x/Library/a.plist', '/Users/x') === '~/Library/a.plist')
}

const React = await import('react')
const { Box } = await import('../../src/ink.js')
const { AppStateProvider } = await import('../../src/state/AppState.js')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.js')
const { SettingsPopupSlot } = await import('../../src/components/SettingsPopupSlot.js')
const store = await import('../../src/utils/cockpit/settingsPopup.js')
const { configPopupRequest } = await import('../../src/commands/config/config.js')
const { CONFIG_POPUP_HINT, CONFIG_ROW_MARK } = await import('../../src/components/Settings/Config.js')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()

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

for (const [columns, rows] of [[178, 51], [80, 21]] as const) {
  const size = `${columns}x${rows}`
  section(`§2 the /config popup at ${size}: the local-server section under the Local account row`)
  const m = await mount(columns, rows)
  m.push('local server')
  await settle(150)
  m.push(KEY.enter)
  await settle(150)
  const labels = ['Local server', 'Loaded models', 'Runner', 'Launch form', 'Loaded models at once', 'Parallel requests per model', 'Keep an idle model loaded', 'Default context length', 'Apply to the server']
  const screen = m.lines()
  const positions = labels.map(label => screen.findIndex(line => line.includes(`  ${label}`) || line.includes(`${CONFIG_ROW_MARK} ${label}`)))
  check(`${size}: the nine rows stand in order`, positions.every((p, i) => p >= 0 && (i === 0 || p > positions[i - 1]!)), positions.join(','))
  check(`${size}: the first section row is selected after the search`, selectedLabel(m) === 'Local server', selectedLabel(m))
  const wide = columns >= 100
  check(`${size}: the server row carries the live truth${wide ? '' : ' (the tail truncates honestly at 80 columns)'}`, rowOf(m, 'Local server').includes('Ollama 0.34.4 · 127.0.0.1:11434') && (!wide || rowOf(m, 'Local server').includes('launch agent com.example.ollama-ssd')), rowOf(m, 'Local server'))
  check(`${size}: the loaded row names the model, its window and its memory`, rowOf(m, 'Loaded models ').includes('qwen3.5:9b-q4_K_M · 256k window') && (!wide || rowOf(m, 'Loaded models ').includes('11.4 GiB · unloads in 23 min')), rowOf(m, 'Loaded models '))
  check(`${size}: the runner row shows the slot and the context`, rowOf(m, 'Runner').includes('1 slot') && rowOf(m, 'Runner').includes('256k context'), rowOf(m, 'Runner'))
  check(`${size}: a set knob shows its value beside the running one and its variable`, rowOf(m, 'Loaded models at once').includes('2 · running 1 · apply to take effect') && (!wide || rowOf(m, 'Loaded models at once').includes('OLLAMA_MAX_LOADED_MODELS')), rowOf(m, 'Loaded models at once'))
  check(`${size}: an unset knob shows the running value and the runner fact`, rowOf(m, 'Default context length').includes('256k · running'), rowOf(m, 'Default context length'))
  check(`${size}: the apply row counts the changes and names the review door`, rowOf(m, 'Apply to the server').includes('2 changes + a restart') && (!wide || rowOf(m, 'Apply to the server').includes('→ reviews the file before anything is written')), rowOf(m, 'Apply to the server'))
  save(`config-local-server-${size}`, m)
  for (let step = 0; step < 4; step++) {
    m.push(KEY.down)
    await settle(60)
  }
  check(`${size}: four downs select the first knob and its memory words show, the usable ceiling named with its source`, selectedLabel(m) === 'Loaded models at once' && flatScreen(m).includes('the box has 48.0 GiB, 36.9 GiB usable for models') && flatScreen(m).includes("the server's own gpu memory line"), selectedLabel(m))
  save(`config-local-server-knob-${size}`, m)
  for (let step = 0; step < 4; step++) {
    m.push(KEY.down)
    await settle(60)
  }
  check(`${size}: the apply row is selected`, selectedLabel(m) === 'Apply to the server', selectedLabel(m))
  m.push(KEY.right)
  await settle(200)
  const review = m.screen()
  const flat = m.lines().map(line => line.replace(/^\s*│\s?/, '').replace(/\s*│\s*$/, '').trim()).filter(line => line !== '').join(' ')
  check(`${size}: → opens the review: the file under ~, the backup, the exact lines, the restart, the hint on its last row`, review.includes('Apply 2 changes to the local server') && flat.includes('~/Library/LaunchAgents/com.example.ollama-ssd.plist · backup beside it: com.example.ollama-ssd.plist.bak') && flat.includes('-    <string>1</string>') && flat.includes('+    <string>2</string>') && flat.includes('+    <key>OLLAMA_NUM_PARALLEL</key>') && flat.includes('then launchctl bootout gui/') && flat.includes('↵ writes the file and restarts the server · esc back, nothing written'), review)
  save(`config-local-server-apply-${size}`, m)
  m.push(KEY.esc)
  await settle(150)
  check(`${size}: esc leaves the review with nothing written and no backup`, readFileSync(PLIST_PATH, 'utf8') === PLIST && !existsSync(`${PLIST_PATH}.bak`) && selectedLabel(m) === 'Apply to the server', selectedLabel(m))
  m.push(KEY.esc)
  await settle(150)
  m.unmount()
  store.closeSettingsPopup()
  await settle(50)
}

section('§3 ←/→ on a knob writes the user setting; esc reverts it')
{
  const m = await mount(178, 51)
  m.push('loaded models at once')
  await settle(150)
  m.push(KEY.enter)
  await settle(150)
  check('the knob row is selected alone', selectedLabel(m) === 'Loaded models at once', selectedLabel(m))
  m.push(KEY.right)
  await settle(200)
  const written = JSON.parse(readFileSync(join(HOME, 'settings.json'), 'utf8')) as { localServer?: { maxLoadedModels?: number; parallelSlots?: number } }
  check('→ steps the ladder from 2 to 3 and persists it, the other knob untouched', written.localServer?.maxLoadedModels === 3 && written.localServer.parallelSlots === 1 && rowOf(m, 'Loaded models at once').includes('3 · running 1'), JSON.stringify(written))
  m.push(KEY.esc)
  await settle(300)
  const reverted = JSON.parse(readFileSync(join(HOME, 'settings.json'), 'utf8')) as { localServer?: { maxLoadedModels?: number; parallelSlots?: number } }
  check('esc reverts the knob to its mount-time value and keeps the other', reverted.localServer?.maxLoadedModels === 2 && reverted.localServer.parallelSlots === 1, JSON.stringify(reverted))
  m.push(KEY.esc)
  await settle(100)
  m.unmount()
  store.closeSettingsPopup()
  await settle(50)
}

section('§4 an over-memory choice: red words with the figures on the knob rows, the Apply row refuses with no door')
{
  const { updateSettingsForSource } = await import('../../src/utils/settings/settings.js')
  updateSettingsForSource('userSettings', { localServer: { maxLoadedModels: 2, parallelSlots: 4, contextLength: 262144 } } as never)
  const REFUSAL = 'does not fit · 73.4 of 36.9 GiB usable — lower the window or the count'
  for (const [columns, rows] of [[178, 51], [80, 21]] as const) {
    const size = `${columns}x${rows}`
    const m = await mount(columns, rows)
    m.push('apply to the server')
    await settle(150)
    m.push(KEY.enter)
    await settle(150)
    const applyRow = rowOf(m, 'Apply to the server')
    check(`${size}: the Apply row refuses with the figures and the models`, applyRow.includes(columns >= 100 ? REFUSAL : 'does not fit · 73.4 of 36.9 GiB'), applyRow)
    const y = m.lines().findIndex(line => line.includes('Apply to the server'))
    const x = (m.lines()[y] ?? '').indexOf('does not fit')
    const style = y >= 0 && x >= 0 ? m.styleAt(x, y) : null
    const plain = y >= 0 ? m.styleAt((m.lines()[y] ?? '').indexOf('Apply to the server'), y) : null
    check(`${size}: the refusal is painted in a different ink from the label (the failure ink)`, style !== null && plain !== null && style.fg !== plain.fg, JSON.stringify([style, plain]))
    if (columns >= 100) check(`${size}: the note under the row says nothing is applied until it fits and names the ceiling's source`, flatScreen(m).includes('nothing is applied until it fits') && flatScreen(m).includes("the server's own gpu memory line"), flatScreen(m))
    save(`config-local-server-refused-${size}`, m)
    m.push(KEY.right)
    await settle(150)
    check(`${size}: → on the refused row opens nothing (no review, the row stays selected)`, selectedLabel(m) === 'Apply to the server' && !m.screen().includes('Apply 3 changes'), selectedLabel(m))
    m.push(KEY.esc)
    await settle(100)
    m.unmount()
    store.closeSettingsPopup()
    await settle(50)
  }
  const wide = await mount(178, 51)
  wide.push('loaded models at once')
  await settle(150)
  wide.push(KEY.enter)
  await settle(150)
  const knobRow = rowOf(wide, 'Loaded models at once')
  check('the knob row carries the same red figures beside its value', knobRow.includes('2 · running 1 · does not fit · 73.4 of 36.9 GiB usable'), knobRow)
  wide.push(KEY.left)
  await settle(200)
  check('← to one loaded model: 50.2 of 36.9 GiB still does not fit (four 256k slots on the 27B)', rowOf(wide, 'Loaded models at once').includes('1 · running · does not fit · 50.2 of 36.9 GiB usable'), rowOf(wide, 'Loaded models at once'))
  wide.push(KEY.esc)
  await settle(200)
  wide.unmount()
  store.closeSettingsPopup()
  await settle(50)
  updateSettingsForSource('userSettings', { localServer: { maxLoadedModels: 2, parallelSlots: 1, contextLength: undefined } } as never)
}

section('§5 the Ollama app form: the review lists launchctl setenv per knob, the quit, the open and the revert road; esc sets nothing')
{
  __pinLocalServerTruthForTest({ ...TRUTH, process: { pid: 777, command: '/Applications/Ollama.app/Contents/Resources/ollama serve', env: { OLLAMA_HOST: '127.0.0.1:11434', OLLAMA_MAX_LOADED_MODELS: '1' }, envReadable: true }, launchForm: { kind: 'app', env: { OLLAMA_MAX_LOADED_MODELS: '1' }, writable: true, logPath: join(HOME, '.ollama', 'logs', 'server.log'), note: 'the Ollama app: each variable is set with launchctl setenv, then the app is quit and opened again (its FAQ road)' } })
  const m = await mount(178, 51)
  m.push('apply to the server')
  await settle(150)
  m.push(KEY.enter)
  await settle(150)
  check('the Apply row names the app restart', rowOf(m, 'Apply to the server').includes('2 changes + the app restarts · → reviews the lines first'), rowOf(m, 'Apply to the server'))
  m.push(KEY.right)
  await settle(200)
  const flat = m.lines().map(line => line.replace(/^\s*│\s?/, '').replace(/\s*│\s*$/, '').trim()).filter(line => line !== '').join(' ')
  check('the review: the two setenv lines with their previous values, the quit, the wait, the open, the revert road, the app hint', m.screen().includes('Apply 2 changes to the Ollama app') && flat.includes('launchctl setenv OLLAMA_MAX_LOADED_MODELS 2  (was 1)') && flat.includes('launchctl setenv OLLAMA_NUM_PARALLEL 1  (was unset)') && flat.includes('osascript -e tell application "Ollama" to quit · wait for 127.0.0.1:11434 to close · open -a Ollama · wait for /api/version') && flat.includes('revert road: launchctl setenv OLLAMA_MAX_LOADED_MODELS 1 · launchctl unsetenv OLLAMA_NUM_PARALLEL') && flat.includes('↵ sets the variables and restarts the app · esc back, nothing set'), flat)
  save('config-local-server-app-178x51', m)
  m.push(KEY.esc)
  await settle(150)
  check('esc leaves the review with the row still selected', selectedLabel(m) === 'Apply to the server', selectedLabel(m))
  m.push(KEY.esc)
  await settle(100)
  m.unmount()
  store.closeSettingsPopup()
  await settle(50)
}

section('§6 no server: the section says so and the apply row opens nothing')
{
  __pinLocalServerTruthForTest({ ...TRUTH, server: undefined, loaded: [], listed: [], process: undefined, runners: [] })
  const m = await mount(178, 51)
  m.push('local server')
  await settle(150)
  m.push(KEY.enter)
  await settle(150)
  check('the server row reads probing off (the proof pins none) and the apply row has no door', rowOf(m, 'Local server').includes('probing off') && rowOf(m, 'Apply to the server').includes('probing off'))
  for (let step = 0; step < 8; step++) {
    m.push(KEY.down)
    await settle(40)
  }
  m.push(KEY.enter)
  await settle(150)
  check('↵ on the apply row without a plan saves and closes instead of opening a dead menu', !m.screen().includes('Apply to the server') || !store.isSettingsPopupOpen())
  m.unmount()
  store.closeSettingsPopup()
  await settle(50)
  check('the row ids are the nine the docs name', LOCAL_SERVER_ROW_IDS.length === 9)
}

await finish()
