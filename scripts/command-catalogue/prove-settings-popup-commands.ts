#!/usr/bin/env bun
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pinScratchHome } from '../lib/settingsPopupHarness.ts'

const REPO = join(import.meta.dir, '..', '..')
process.chdir(REPO)
const HOME = pinScratchHome('mercury-settings-popup-commands')

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

const store = await import('../../src/utils/cockpit/settingsPopup.js')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()

const VIEWS = ['config', 'usage', 'status'] as const

section('§1 the three commands are local screen-seat commands that open the one popup store')
for (const view of VIEWS) {
  const index = (await import(`../../src/commands/${view}/index.js`)).default as Record<string, unknown>
  check(`/${view} is a local command`, index.type === 'local', String(index.type))
  check(`/${view} runs on the screen seat`, index.seat === 'screen', String(index.seat))
  check(`/${view} is user-private (its line never enters a model conversation)`, index.userPrivate === true, String(index.userPrivate))
  check(`/${view} declares supportsNonInteractive false`, index.supportsNonInteractive === false, String(index.supportsNonInteractive))
  let opened: { view: string; width: number; rows: number | null } | null = null
  const unsubscribe = store.subscribeSettingsPopup(() => {
    const request = store.settingsPopupRequest()
    if (request !== null) opened = { view: request.view, width: request.width, rows: request.rows }
  })
  try {
    const load = index.load as () => Promise<{ call: (args: string, context: unknown) => Promise<{ type: string }> }>
    const module = await load()
    const result = await module.call('', { messages: [], options: {} })
    check(`/${view}'s body returns skip (the popup is the receipt)`, result.type === 'skip', JSON.stringify(result))
    check(`/${view} opens the store with its own view`, opened !== null && opened.view === view, JSON.stringify(opened))
  } catch (error) {
    check(`/${view}'s body runs`, false, String(error).slice(0, 160))
  } finally {
    unsubscribe()
    store.closeSettingsPopup()
  }
}

const config = (await import('../../src/commands/config/index.js')).default as Record<string, unknown>
check('/config keeps its settings alias', Array.isArray(config.aliases) && (config.aliases as string[]).includes('settings'))
check('/config carries no immediate getter (a screen command runs now, busy or not)', !('immediate' in config))
const request = store.settingsPopupRequest()
{
  const module = await (config.load as () => Promise<{ call: (args: string, context: unknown) => Promise<unknown> }>)()
  await module.call('', { messages: [], options: {} })
  const opened = store.settingsPopupRequest()
  check('/config asks for 110 columns and 44 rows', opened?.width === 110 && opened?.rows === 44, JSON.stringify({ width: opened?.width, rows: opened?.rows }))
  check("/config's hint row is the page's, verbatim", opened?.hint === '↑↓ select · ←/→ change · ↵ save · / search · esc or click outside closes', opened?.hint)
  store.closeSettingsPopup()
}
void request

section('§2 no local-jsx command mounts the settings shell any more')
{
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.tsx?$/.test(entry)) files.push(path)
    }
  }
  walk(join(REPO, 'src', 'commands'))
  const mounts = files.filter(file => /<Settings[\s>]/.test(readFileSync(file, 'utf8')) || /Settings\s+openToken=/.test(readFileSync(file, 'utf8')))
  check('no command file renders <Settings …> (the shell is the popup slot\'s)', mounts.length === 0, mounts.map(f => relative(REPO, f)).join(', '))
  const jsxSettings = files.filter(file => {
    const text = readFileSync(file, 'utf8')
    return /type: 'local-jsx'/.test(text) && /name: '(config|usage|status)'/.test(text)
  })
  check('none of the three is a local-jsx command', jsxSettings.length === 0, jsxSettings.map(f => relative(REPO, f)).join(', '))
  const shell = readFileSync(join(REPO, 'src/components/Settings/Settings.tsx'), 'utf8')
  check('the shell imports neither ./Status.js nor ./Usage.js (the bodies arrive through the store)', !shell.includes("from './Status.js'") && !shell.includes("from './Usage.js'"))
  check('the shell keeps its exports (Settings, nextSettingsOpen)', shell.includes('export function Settings(') && shell.includes('export function nextSettingsOpen('))
  check('the slot mounts the shell from the store', readFileSync(join(REPO, 'src/components/SettingsPopupSlot.tsx'), 'utf8').includes('<Settings key={open} request={request} geometry={geometry} />'))
  const layout = readFileSync(join(REPO, 'src/components/FullscreenLayout.tsx'), 'utf8')
  check('the layout mounts the slot over everything (after the modal pane) and on the sequential road', layout.includes('{modalPane}\n              <SettingsPopupSlot overlay={true} />') && layout.includes('{modal ?? null}\n          <SettingsPopupSlot overlay={false} />'))
}

rmSync(HOME, { recursive: true, force: true })
console.log(`\nprove-settings-popup-commands: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
