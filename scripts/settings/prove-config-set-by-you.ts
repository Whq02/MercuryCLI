#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

const REPO = join(import.meta.dir, '..', '..')
process.chdir(REPO)
const HOME = pinScratchHome('mercury-config-set-by-you')
Object.assign(process.env, { MERCURY_LOCAL_PROBE_TARGETS: 'none', ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', BROWSER: '/usr/bin/true' })

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

const SET: Array<[string, Record<string, unknown>]> = [
  ['Tips', { activity: { tips: { enabled: false } } }],
  ['Reduced motion', { view: { reducedMotion: true } }],
  ['Ping', { view: { ping: false } }],
  ['Account identity', { view: { accountIdentity: false } }],
  ['Instruction profile', { briefs: { profile: 'native' } }],
  ['Shell engine', { shell: { engine: 'brush' } }],
  ['Shell engine sessions', { shell: { sessions: 3 } }],
  ['Patience with a quiet model', { patience: 'patient' }],
  ['Thinking', { engine: { reasoning: false } }],
  ['Usage notice to the model', { engine: { usageNotice: true } }],
  ['Default permission mode', { guardrails: { mode: 'implement' } }],
  ['Pinned memory limit', { memory: { pinnedLimit: 2000 } }],
  ['Memory at start, beyond the pins', { memory: { startLimit: 3000 } }],
  ['Session journal', { memory: { journal: false } }],
  ['Journal on the entry page', { memory: { journalOnEntryPage: true } }],
  ['Respect .gitignore in file picker', { files: { honourGitignore: false } }],
  ['Terminal progress bar', { activity: { progress: false } }],
]
const deepMerge = (into: Record<string, unknown>, from: Record<string, unknown>): Record<string, unknown> => {
  for (const [key, value] of Object.entries(from)) {
    const current = into[key]
    into[key] = typeof value === 'object' && value !== null && !Array.isArray(value) && typeof current === 'object' && current !== null ? deepMerge({ ...(current as Record<string, unknown>) }, value as Record<string, unknown>) : value
  }
  return into
}
const settings = SET.reduce<Record<string, unknown>>((acc, [, part]) => deepMerge(acc, part), {})
writeFileSync(join(HOME, 'settings.json'), JSON.stringify(settings, null, 2))
mkdirSync(join(HOME, 'orchard'), { recursive: true })

const React = await import('react')
const { Box } = await import('../../src/screen/themedRenderer.js')
const { AppStateProvider } = await import('../../src/screen/app-state/AppState.js')
const { ThemeProvider } = await import('../../src/screen/theme/ThemeProvider.js')
const { SettingsPopupSlot } = await import('../../src/screen/overlays/SettingsPopupSlot.js')
const store = await import('../../src/screen/cockpit/settingsPopup.js')
const { configPopupRequest } = await import('../../src/commands/config/config.js')
const { enableConfigs, saveGlobalConfig } = await import('../../src/platform/config/globalConfig.js')
const { CONFIG_ROW_MARK, CONFIG_POPUP_HINT } = await import('../../src/screen/settings/Config.js')
const { resetSettingsCache } = await import('../../src/platform/settings/settingsCache.js')
enableConfigs()
saveGlobalConfig(c => ({ ...c, hasCompletedOnboarding: true, theme: 'dark' }))
resetSettingsCache()

const COLS = 178
const ROWS = 51
const LEFT = 34
const TOP = 4
const LIST_FIRST = TOP + 6
const LIST_ROWS = 34

async function openConfig(): Promise<{ m: Mounted; header: string; rows: string[] }> {
  const element = React.createElement(
    AppStateProvider as never,
    {},
    React.createElement(ThemeProvider as never, {}, React.createElement(Box, { flexDirection: 'column', width: COLS, height: ROWS }, React.createElement(SettingsPopupSlot, { overlay: true }))),
  )
  const m: Mounted = await mountOffscreen(element, COLS, ROWS)
  store.openSettingsPopup(configPopupRequest({ messages: [], options: {} } as never))
  await waitFor(() => m.screen().includes(CONFIG_POPUP_HINT), 4000)
  await settle(150)
  const innerOf = (line: string): string => Array.from(line).slice(LEFT + 2, LEFT + 108).join('')
  const header = m.lines().map(innerOf).find(line => / settings · /.test(line))?.trim() ?? ''
  const total = Number(/(\d+) settings/.exec(header)?.[1] ?? 0)
  const rows: string[] = []
  const record = (): void => {
    const lines = m.lines()
    const visible = Array.from({ length: LIST_ROWS }, (_, i) => innerOf(lines[LIST_FIRST + i] ?? ''))
    const marked = visible.filter(row => row.startsWith(`${CONFIG_ROW_MARK} `))
    if (marked.length === 1) rows.push(marked[0]!)
  }
  record()
  for (let step = 1; step < total; step++) {
    m.push(KEY.down)
    await settle(20)
    record()
  }
  return { m, header, rows }
}
const labelOf = (row: string): string => row.slice(2, 36).trim()
const valueOf = (row: string): string => row.slice(36).replace(/\s+$/, '').trim()

section('§1 seventeen keys set in the settings file: the header counts every row they move')
{
  const { m, header, rows } = await openConfig()
  const setByYou = Number(/(\d+) set by you/.exec(header)?.[1] ?? -1)
  check('the header carries the counts', / settings · \d+ set by you$/.test(header), header + ' | the popup header line is built by configPopupLine in src/screen/settings/config/configLayout.ts; keep its folder, settings and set-by-you parts in that form')
  const moved = SET.map(([label]) => label)
  const found = moved.filter(label => rows.some(row => labelOf(row) === label))
  check('every row the keys back is on the screen', found.length === moved.length, `missing: ${moved.filter(label => !found.includes(label)).join(', ')} | each missing label must be a row in the config popup, built in src/screen/settings/config/configRows*.tsx; check the row label there or that the popup list reached it`)
  check(`the header counts at least those ${moved.length} rows as set by you`, setByYou >= moved.length, `${setByYou} set by you | each row whose settings key is set must report setByYou: true in its row in src/screen/settings/config/configRows*.tsx`)
  check('…and not every row (the untouched rows do not count)', setByYou < rows.length, `${setByYou} of ${rows.length} | rows with no settings key must report setByYou false in src/screen/settings/config/configRows*.tsx`)
  const progress = rows.find(row => labelOf(row) === 'Terminal progress bar')
  check('the Terminal progress bar row reads off with the settings key named', progress !== undefined && /^off/.test(valueOf(progress)) && /activity\.progress false in settings/.test(valueOf(progress)), (progress === undefined ? 'row absent' : valueOf(progress)) + ' | the Terminal progress bar row is in src/screen/settings/config/configRowsEngine.tsx; with activity.progress set it must read off and name activity.progress false in settings')
  const tips = rows.find(row => labelOf(row) === 'Tips')
  check('the Tips row reads off', tips !== undefined && /^off/.test(valueOf(tips)), (tips === undefined ? 'row absent' : valueOf(tips)) + ' | the Tips row is in src/screen/settings/config/configRows*.tsx; with activity.tips.enabled false it must read off')
  m.unmount()
  store.closeSettingsPopup()
  await settle(50)
}

section('§2 the same home with the keys removed: the count falls back')
{
  writeFileSync(join(HOME, 'settings.json'), JSON.stringify({}, null, 2))
  resetSettingsCache()
  const { m, header, rows } = await openConfig()
  const setByYou = Number(/(\d+) set by you/.exec(header)?.[1] ?? -1)
  check('the header count drops below the count of keys that were set', setByYou >= 0 && setByYou < SET.length, header + ' | with settings.json emptied the set-by-you count must drop; see configPopupLine in src/screen/settings/config/configLayout.ts and the setByYou fields of the rows in src/screen/settings/config/configRows*.tsx')
  const progress = rows.find(row => labelOf(row) === 'Terminal progress bar')
  check('the Terminal progress bar row reads on again with no settings pin named', progress !== undefined && /^on/.test(valueOf(progress)) && !/activity\.progress/.test(valueOf(progress)), (progress === undefined ? 'row absent' : valueOf(progress)) + ' | with no activity.progress in settings the row in src/screen/settings/config/configRowsEngine.tsx must read on and not name activity.progress')
  m.unmount()
  store.closeSettingsPopup()
  await settle(50)
}

await releaseScratchHome(HOME)
console.log(`\nprove-config-set-by-you: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
