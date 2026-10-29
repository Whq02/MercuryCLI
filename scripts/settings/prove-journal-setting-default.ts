#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'
import type { DOMElement } from '../../src/ink.js'

const REPO = join(import.meta.dir, '..', '..')
process.chdir(REPO)
pinSourceRef()
const HOME = pinScratchHome('mercury-journal-setting-default')
const frameDir = ((): string | undefined => {
  const index = process.argv.indexOf('--frames')
  return index < 0 ? undefined : process.argv[index + 1]
})()
if (frameDir) mkdirSync(frameDir, { recursive: true })

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

const React = await import('react')
const { Box, Text } = await import('../../src/ink.js')
const { AppStateProvider } = await import('../../src/state/AppState.js')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.js')
const slot = await import('../../src/components/SettingsPopupSlot.js')
const store = await import('../../src/utils/cockpit/settingsPopup.js')
const { configPopupRequest } = await import('../../src/commands/config/config.js')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.js')
const { journalEnabled } = await import('../../src/mneme/journal.js')
const layout = await import('../../src/components/memory/memoryCentreLayout.js')
const setting = (await import('../../src/mneme/journalSetting.js').catch(() => null)) as { journalSettingOn?: (s: unknown) => boolean } | null

section('§1 one reader: the product\'s journalEnabled() and the setting row read the same predicate — off unless memory.journal is true')
{
  check('the predicate exists and reads off with nothing set, off with {}, on only with true', setting?.journalSettingOn?.(undefined) === false && setting?.journalSettingOn?.({}) === false && setting?.journalSettingOn?.({ memory: {} }) === false && setting?.journalSettingOn?.({ memory: { journal: true } }) === true && setting?.journalSettingOn?.({ memory: { journal: false } }) === false, String(setting?.journalSettingOn))
  resetSettingsCache()
  check('with nothing set on disk the product reads the journal off', existsSync(join(HOME, 'settings.json')) === false && journalEnabled() === false)
  const config = readFileSync(join(REPO, 'src/components/Settings/Config.tsx'), 'utf8')
  check('/config\'s Session journal row reads the shared predicate, not its own default', config.includes('const journalOn = journalSettingOn(merged)') && !config.includes("merged.memory?.journal !== false"))
  const row = layout.journalRow({ enabled: journalEnabled(), entries: [] })
  check('/memory\'s journal row agrees: off, and says what turns it on', row.state === 'off' && row.detail.includes('memory.journal in /config turns it on'), JSON.stringify(row))
}

const TITLE = 'Mercury · config'
const SCENE = { columns: 120, rows: 40, bottom: 4 }
function scaffold(centreRef: React.RefObject<DOMElement | null>): React.ReactNode {
  const body = SCENE.rows - SCENE.bottom
  return React.createElement(
    AppStateProvider as never,
    {},
    React.createElement(
      ThemeProvider as never,
      {},
      React.createElement(
        Box,
        { flexDirection: 'column', width: SCENE.columns, height: SCENE.rows },
        React.createElement(
          Box,
          { ref: centreRef, flexDirection: 'column', height: body, flexShrink: 0, overflow: 'hidden' },
          ...Array.from({ length: body }, (_, index) => React.createElement(Text, { key: index, wrap: 'truncate-end' }, index === 0 ? 'CENTRE' : 'c'.repeat(SCENE.columns))),
        ),
        React.createElement(Box, { height: SCENE.bottom, flexShrink: 0, flexDirection: 'column' }, ...Array.from({ length: SCENE.bottom }, (_, index) => React.createElement(Text, { key: index }, 'B'.repeat(SCENE.columns)))),
        React.createElement(slot.SettingsPopupSlot, { overlay: true, hostRef: centreRef, framed: false }),
      ),
    ),
  )
}
const context = { messages: [], options: {} } as never
const rowOf = (m: Mounted, needle: string): string => m.lines().find(l => l.includes(needle)) ?? ''
const ROW = 'Session journal'

section('§2 /config on a fresh home: the Session journal row reads off with 0 set by you; → turns it on and writes true; /memory agrees')
{
  const centreRef = React.createRef<DOMElement>()
  const m = await mountOffscreen(scaffold(centreRef), SCENE.columns, SCENE.rows)
  await waitFor(() => m.screen().includes('CENTRE') && m.screen().includes('BBBB'), 4000)
  store.openSettingsPopup(configPopupRequest(context))
  const opened = await waitFor(() => m.screen().includes(TITLE) && m.screen().includes('0 set by you'), 6000)
  check('the popup opened with 0 set by you', opened, m.lines().filter(l => l.includes(TITLE)).join(' | '))
  m.push(ROW)
  await settle(150)
  m.push(KEY.enter)
  const filtered = await waitFor(() => m.screen().includes(`› ${ROW}`), 6000)
  await settle(200)
  const row = rowOf(m, `› ${ROW}`)
  check('the Session journal row is selected', filtered && row !== '', row.trim())
  check('it reads off — the real default — not on', /\boff\b/.test(row) && !/\bon\b/.test(row.replace(/journal/g, '')), row.trim())
  check('its description says it is off unless you turn it on', m.screen().includes('off unless you turn it on'), m.lines().filter(l => l.includes('unless')).join(' | '))
  if (frameDir) writeFileSync(join(frameDir, 'config-session-journal-default-120x40.txt'), `${m.lines().join('\n')}\n`)
  m.push(KEY.right)
  const written = await waitFor(() => existsSync(join(HOME, 'settings.json')) && /"journal":\s*true/.test(readFileSync(join(HOME, 'settings.json'), 'utf8')), 6000)
  check('→ once turns it on: settings.json now carries memory.journal true (one press, not two)', written, existsSync(join(HOME, 'settings.json')) ? readFileSync(join(HOME, 'settings.json'), 'utf8') : 'no settings.json')
  await waitFor(() => /\bon\b/.test(rowOf(m, `› ${ROW}`).replace(/journal/g, '')), 6000)
  check('the row reads on and 1 set by you', /\bon\b/.test(rowOf(m, `› ${ROW}`).replace(/journal/g, '')) && m.screen().includes('1 set by you'), `${rowOf(m, `› ${ROW}`).trim()} · ${m.lines().find(l => l.includes('set by you'))?.trim() ?? ''}`)
  resetSettingsCache()
  check('the product\'s own reader agrees: journalEnabled() is true', journalEnabled() === true)
  check('/memory\'s row would read on', layout.journalRow({ enabled: journalEnabled(), entries: [] }).state === 'on')
  store.closeSettingsPopup()
  await waitFor(() => !m.screen().includes(TITLE), 2000)
  m.unmount()
}

await releaseScratchHome(HOME)
console.log(`\njournal setting default: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
