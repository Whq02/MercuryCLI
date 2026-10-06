#!/usr/bin/env bun
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

const REPO = join(import.meta.dir, '..', '..')
process.chdir(REPO)
const HOME = pinScratchHome('mercury-config-compact-window-row')

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const React = await import('react')
const { Box } = await import('../../src/ink.js')
const { AppStateProvider } = await import('../../src/state/AppState.js')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.js')
const { SettingsPopupSlot } = await import('../../src/components/SettingsPopupSlot.js')
const store = await import('../../src/utils/cockpit/settingsPopup.js')
const { configPopupRequest } = await import('../../src/commands/config/config.js')
const { CONFIG_POPUP_HINT, CONFIG_ROW_MARK } = await import('../../src/components/Settings/Config.js')
const { enableConfigs, saveGlobalConfig } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()

const COLS = 178
const ROWS = 51
const LEFT = 34
const TOP = 4
const ROW = 'Auto-compact window'
const RUNGS = ['auto', '100k', '200k', '500k', '1m']

function firstRow(m: Mounted): string {
  const inner = Array.from(m.lines()[TOP + 6] ?? '').slice(LEFT + 2, LEFT + 108).join('')
  return inner.trim()
}
const shown = (m: Mounted): string => firstRow(m).replace(`${CONFIG_ROW_MARK} ${ROW}`, '').trim()

async function openPopup(): Promise<Mounted> {
  const element = React.createElement(
    AppStateProvider as never,
    {},
    React.createElement(ThemeProvider as never, {}, React.createElement(Box, { flexDirection: 'column', width: COLS, height: ROWS }, React.createElement(SettingsPopupSlot, { overlay: true }))),
  )
  const m = await mountOffscreen(element, COLS, ROWS)
  store.openSettingsPopup(configPopupRequest({ messages: [], options: {} } as never))
  await waitFor(() => m.screen().includes(CONFIG_POPUP_HINT), 4000)
  await settle(120)
  return m
}

async function selectRow(m: Mounted): Promise<void> {
  m.push('/')
  await settle(60)
  for (const ch of 'compact window') {
    m.push(ch)
    await settle(25)
  }
  await settle(100)
  m.push(KEY.down)
  await settle(120)
}

async function closeAndUnmount(m: Mounted): Promise<void> {
  m.push(KEY.esc)
  await settle(120)
  m.unmount()
  await settle(40)
}

console.log('§1 the /config row exists and shows the saved rung')
{
  saveGlobalConfig(prev => ({ ...prev, autoCompactWindow: undefined }))
  const m = await openPopup()
  await selectRow(m)
  check('the row answers its search name', firstRow(m).startsWith(`${CONFIG_ROW_MARK} ${ROW}`), firstRow(m))
  check('an absent setting shows auto', shown(m) === 'auto', firstRow(m))
  await closeAndUnmount(m)
}
{
  saveGlobalConfig(prev => ({ ...prev, autoCompactWindow: 500_000 }))
  const m = await openPopup()
  await selectRow(m)
  check('a saved 500k shows 500k', shown(m) === '500k', firstRow(m))
  await closeAndUnmount(m)
}

console.log('§2 ←/→ walk the ladder auto → 100K → 200K → 500K → 1M, saving the same setting the resolver reads')
{
  saveGlobalConfig(prev => ({ ...prev, autoCompactWindow: undefined }))
  const m = await openPopup()
  await selectRow(m)
  const walk: string[] = []
  for (let step = 0; step < 4; step++) {
    m.push(KEY.right)
    await settle(200)
    const { getGlobalConfig } = await import('../../src/utils/config/globalConfig.js')
    walk.push(String((getGlobalConfig() as { autoCompactWindow?: number }).autoCompactWindow))
  }
  check('four steps save 100000, 200000, 500000 and 1000000', JSON.stringify(walk) === JSON.stringify(['100000', '200000', '500000', '1000000']), JSON.stringify(walk))
  check('the row shows 1m', shown(m) === '1m', firstRow(m))
  m.push(KEY.left)
  await settle(200)
  m.push(KEY.left)
  await settle(200)
  m.push(KEY.left)
  await settle(200)
  m.push(KEY.left)
  await settle(200)
  const { getGlobalConfig } = await import('../../src/utils/config/globalConfig.js')
  check('four steps back clear the override (auto = the absent setting)', (getGlobalConfig() as { autoCompactWindow?: number }).autoCompactWindow === undefined, String((getGlobalConfig() as { autoCompactWindow?: number }).autoCompactWindow))
  check('the row shows auto again', shown(m) === 'auto', firstRow(m))
  await closeAndUnmount(m)
}

console.log('§3 the row writes what the auto-compact resolver reads')
{
  saveGlobalConfig(prev => ({ ...prev, autoCompactWindow: 200_000 }))
  const { resolveAutoCompactWindow } = await import('../../src/services/compact/autoCompact.js')
  const { getGlobalConfig } = await import('../../src/utils/config/globalConfig.js')
  const resolved = resolveAutoCompactWindow('claude-sonnet-4-5', (getGlobalConfig() as { autoCompactWindow?: number }).autoCompactWindow)
  check('the resolver reads the row-written 200k as a settings-source window', resolved.source === 'settings' && resolved.configured === 200_000, JSON.stringify(resolved))
  saveGlobalConfig(prev => ({ ...prev, autoCompactWindow: undefined }))
  const auto = resolveAutoCompactWindow('claude-sonnet-4-5')
  check('the absent setting resolves as auto', auto.source === 'auto', JSON.stringify(auto))
}

await releaseScratchHome(HOME)
if (failures > 0) {
  console.error(`\nprove-config-compact-window-row: ${failures} FAILED`)
  process.exit(1)
}
console.log('\nprove-config-compact-window-row: all green')
