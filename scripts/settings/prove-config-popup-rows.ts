#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

const REPO = join(import.meta.dir, '..', '..')
process.chdir(REPO)
const HOME = pinScratchHome('mercury-config-popup-rows')

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

const EDITOR_LINK_KEYS = ['diffTool', 'autoConnectIde', 'autoInstallIdeExtension', 'ideHintShownCount', 'hasIdeAutoConnectDialogBeenShown', 'hasIdeOnboardingBeenShown']
const EDITOR_WORD = /\bIDE\b/i

section('§1 the global config schema declares no editor-link setting')
{
  const schema = await import('../../src/utils/config/schema.js')
  const keys = schema.GLOBAL_CONFIG_KEYS as readonly string[]
  const leaked = EDITOR_LINK_KEYS.filter(key => keys.includes(key))
  check('the global-config key allowlist carries none of the editor-link keys', leaked.length === 0, leaked.join(','))
  const defaults = schema.createDefaultGlobalConfig() as Record<string, unknown>
  const defaulted = EDITOR_LINK_KEYS.filter(key => key in defaults)
  check('the default global config mints none of them', defaulted.length === 0, defaulted.join(','))
  const source = readFileSync(join(REPO, 'src/utils/config/schema.ts'), 'utf8')
  const named = EDITOR_LINK_KEYS.filter(key => source.includes(key))
  check('the schema source names none of them (no declared-but-unread key)', named.length === 0, named.join(','))
  check('the schema source declares no DiffTool type', !/\bDiffTool\b/.test(source))
  check('the config barrel re-exports no DiffTool type', !/\bDiffTool\b/.test(readFileSync(join(REPO, 'src/utils/config.ts'), 'utf8')))
  check('the frozen contract inventory carries no DiffTool row', !readFileSync(join(REPO, 'scripts/ownership/contract-inventory.json'), 'utf8').includes('type:DiffTool'))
  const configSource = readFileSync(join(REPO, 'src/components/Settings/Config.tsx'), 'utf8')
  check('the /config catalogue reads no editor-link key and no editor install state', !EDITOR_LINK_KEYS.some(key => configSource.includes(key)) && !configSource.includes('ideInstallationStatus') && !configSource.includes("=== 'ide'"))
}

section('§2 the rendered /config popup at 178×51: every row walked, none names an editor link')
{
  const React = await import('react')
  const { Box } = await import('../../src/ink.js')
  const { AppStateProvider } = await import('../../src/state/AppState.js')
  const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.js')
  const { SettingsPopupSlot } = await import('../../src/components/SettingsPopupSlot.js')
  const store = await import('../../src/utils/cockpit/settingsPopup.js')
  const { configPopupRequest } = await import('../../src/commands/config/config.js')
  const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
  const { CONFIG_ROW_MARK, CONFIG_POPUP_HINT } = await import('../../src/components/Settings/Config.js')
  enableConfigs()
  const COLS = 178
  const ROWS = 51
  const LEFT = 34
  const TOP = 4
  const LIST_FIRST = TOP + 6
  const LIST_ROWS = 34
  const element = React.createElement(
    AppStateProvider as never,
    {},
    React.createElement(ThemeProvider as never, {}, React.createElement(Box, { flexDirection: 'column', width: COLS, height: ROWS }, React.createElement(SettingsPopupSlot, { overlay: true }))),
  )
  const m: Mounted = await mountOffscreen(element, COLS, ROWS)
  store.openSettingsPopup(configPopupRequest({ messages: [], options: {} } as never))
  const up = await waitFor(() => m.screen().includes(CONFIG_POPUP_HINT), 4000)
  check('the popup painted with the hint row', up)
  await settle(120)
  const innerOf = (line: string): string => Array.from(line).slice(LEFT + 2, LEFT + 108).join('')
  const labelOf = (row: string): string => row.slice(2, 36).trim()
  const listRows = (): string[] => {
    const lines = m.lines()
    return Array.from({ length: LIST_ROWS }, (_, i) => innerOf(lines[LIST_FIRST + i] ?? ''))
  }
  const total = Number(/(\d+) settings/.exec(m.screen())?.[1] ?? 0)
  check('the context line names the row count', total > 0, `${total} settings`)
  const labels: string[] = []
  const rows: string[] = []
  const record = (): void => {
    const marked = listRows().filter(row => row.startsWith(`${CONFIG_ROW_MARK} `))
    if (marked.length === 1) {
      labels.push(labelOf(marked[0]!))
      rows.push(marked[0]!)
    }
  }
  record()
  for (let step = 1; step < total; step++) {
    m.push(KEY.down)
    await settle(25)
    record()
  }
  check(`${total} distinct rows were walked and read`, labels.length === total && new Set(labels).size === total, `${labels.length} read, ${new Set(labels).size} distinct of ${total}`)
  const editorRows = labels.filter(label => EDITOR_WORD.test(label))
  check('no row names an IDE', editorRows.length === 0, editorRows.join(' | '))
  check('no row offers a diff tool', !labels.includes('Diff tool'), labels.filter(l => /diff/i.test(l)).join(' | '))
  const editorValues = rows.filter(row => EDITOR_WORD.test(row))
  check('no row value names an IDE either', editorValues.length === 0, editorValues.join(' | '))
  const frame = m.screen()
  check('the whole frame carries the word nowhere', !EDITOR_WORD.test(frame), (frame.match(/.{0,30}\bIDE\b.{0,30}/i) ?? []).join(' | '))
  m.unmount()
  store.closeSettingsPopup()
  await settle(50)
}

await releaseScratchHome(HOME)
console.log(`\nprove-config-popup-rows: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
