#!/usr/bin/env bun
import { join } from 'node:path'
import { pinScratchHome, releaseScratchHome } from '../lib/settingsPopupHarness.ts'

const REPO = join(import.meta.dir, '..', '..')
process.chdir(REPO)
const HOME = pinScratchHome('mercury-settings-popup-commands')

let failures = 0
function check(label: string, ok: boolean, detail = '', hint = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!ok && hint ? ` — ${hint}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

const store = await import('../../src/screen/cockpit/settingsPopup.js')
const { enableConfigs } = await import('../../src/platform/config/globalConfig.js')
enableConfigs()

const VIEWS = ['config', 'usage'] as const

section('§1 the two commands are local screen-seat commands that open the one popup store')
for (const view of VIEWS) {
  const index = (await import(`../../src/commands/${view}/index.js`)).default as Record<string, unknown>
  check(`/${view} is a local command`, index.type === 'local', String(index.type), `set type: 'local' in src/commands/${view}/index.ts`)
  check(`/${view} runs on the screen seat`, index.seat === 'screen', String(index.seat), `set seat: 'screen' in src/commands/${view}/index.ts`)
  check(`/${view} is user-private (its line never enters a model conversation)`, index.userPrivate === true, String(index.userPrivate), `set userPrivate: true in src/commands/${view}/index.ts`)
  check(`/${view} declares supportsNonInteractive false`, index.supportsNonInteractive === false, String(index.supportsNonInteractive), `set supportsNonInteractive: false in src/commands/${view}/index.ts`)
  let opened: { view: string; width: number; rows: number | null } | null = null
  const unsubscribe = store.subscribeSettingsPopup(() => {
    const request = store.settingsPopupRequest()
    if (request !== null) opened = { view: request.view, width: request.width, rows: request.rows }
  })
  try {
    const load = index.load as () => Promise<{ call: (args: string, context: unknown) => Promise<{ type: string }> }>
    const module = await load()
    const result = await module.call('', { messages: [], options: {} })
    check(`/${view}'s body returns skip (the popup is the receipt)`, result.type === 'skip', JSON.stringify(result), `call in src/commands/${view}/${view}.tsx must open the popup with openSettingsPopup and return { type: 'skip' }`)
    check(`/${view} opens the store with its own view`, opened !== null && opened.view === view, JSON.stringify(opened), `call in src/commands/${view}/${view}.tsx must pass view: '${view}' to openSettingsPopup (src/screen/cockpit/settingsPopup.ts)`)
  } catch (error) {
    check(`/${view}'s body runs`, false, String(error).slice(0, 160), `the load or call of src/commands/${view}/${view}.tsx threw; fix the error shown`)
  } finally {
    unsubscribe()
    store.closeSettingsPopup()
  }
}

const config = (await import('../../src/commands/config/index.js')).default as Record<string, unknown>
check('/config keeps its settings alias', Array.isArray(config.aliases) && (config.aliases as string[]).includes('settings'), '', "add aliases: ['settings'] to src/commands/config/index.ts")
check('/config carries no immediate getter (a screen command runs now, busy or not)', !('immediate' in config), '', 'remove the immediate getter from src/commands/config/index.ts')
const request = store.settingsPopupRequest()
{
  const module = await (config.load as () => Promise<{ call: (args: string, context: unknown) => Promise<unknown> }>)()
  await module.call('', { messages: [], options: {} })
  const opened = store.settingsPopupRequest()
  check('/config asks for 110 columns and 44 rows', opened?.width === 110 && opened?.rows === 44, JSON.stringify({ width: opened?.width, rows: opened?.rows }), 'configPopupRequest in src/commands/config/config.tsx takes CONFIG_POPUP_WIDTH and CONFIG_POPUP_ROWS from src/screen/settings/config/configLayout.ts; fix them there')
  check("/config's hint row is the page's, verbatim", opened?.hint === '↑↓ select · pgup/pgdn page · ←/→ change · ↵ save · / search · esc or click outside closes', opened?.hint, 'CONFIG_POPUP_HINT in src/screen/settings/config/configLayout.ts must read as the page text')
  store.closeSettingsPopup()
}
void request


await releaseScratchHome(HOME)
console.log(`\nprove-settings-popup-commands: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
