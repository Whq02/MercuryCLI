#!/usr/bin/env bun
import React from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

pinSourceRef()
const home = pinScratchHome('card-editor-key')

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`)
}

const { AppStateProvider } = await import('../../src/state/AppState.tsx')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.tsx')
const { Box } = await import('../../src/ink.ts')
const { Select } = await import('../../src/components/CustomSelect/select.tsx')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()

const h = React.createElement
const CTRL_G = '\x07'
const CTRL_X = '\x18'
const CTRL_E = '\x05'
const OTHER = '__other__'

const mount = (element: React.ReactNode): Promise<Mounted> =>
  mountOffscreen(h(AppStateProvider, null, h(ThemeProvider, null, h(KeybindingSetup, null, h(Box, { width: 100, height: 24, flexDirection: 'column' }, element)))), 100, 24)
async function press(view: Mounted, data: string): Promise<void> {
  view.push(data)
  await settle(120)
}
const optionsWith = (onChange: (value: string) => void): unknown[] => [
  { label: 'one', value: 'one' },
  { type: 'input', label: 'Other', value: OTHER, placeholder: 'Type something.', initialValue: '', onChange },
]

section('the card\'s Other field: the key its footer names opens the editor with what is typed, and the composer\'s chord still does')
{
  const opened: string[] = []
  let typed = ''
  const view = await mount(
    h(Select, {
      options: optionsWith((value: string) => { typed = value }),
      onChange: () => {},
      onCancel: () => {},
      onOpenEditor: (value: string) => { opened.push(value) },
    } as never),
  )
  try {
    await waitFor(() => view.screen().includes('Other') || view.screen().includes('Type something'), 5_000)
    await press(view, CTRL_G)
    check('with the mark on a plain option the key opens nothing', opened.length === 0, JSON.stringify(opened))
    await press(view, KEY.down)
    for (const letter of 'memo') await press(view, letter)
    check('the Other field holds what was typed', typed === 'memo', JSON.stringify(typed))
    const beforeKey = opened.length
    await press(view, CTRL_G)
    check('ctrl+g on the Other field hands the editor what was typed', opened.length === beforeKey + 1 && opened.at(-1) === 'memo', JSON.stringify(opened))
    const beforeChord = opened.length
    await press(view, CTRL_X)
    await press(view, CTRL_E)
    check('ctrl+x ctrl+e on the Other field does the same, once', opened.length === beforeChord + 1 && opened.at(-1) === 'memo', JSON.stringify(opened))
    check('neither key typed into the field', typed === 'memo', JSON.stringify(typed))
  } finally {
    view.unmount()
  }
}

section('a list that offers no editor: the key is nobody\'s')
{
  let typed = ''
  const view = await mount(h(Select, { options: optionsWith((value: string) => { typed = value }), onChange: () => {}, onCancel: () => {} } as never))
  try {
    await waitFor(() => view.screen().includes('Other') || view.screen().includes('Type something'), 5_000)
    await press(view, KEY.down)
    for (const letter of 'memo') await press(view, letter)
    await press(view, CTRL_G)
    check('ctrl+g leaves the field as it was and the list standing', typed === 'memo' && view.screen().includes('one'), `${JSON.stringify(typed)} · ${view.screen().slice(0, 120)}`)
  } finally {
    view.unmount()
  }
}

section('both card fields listen where the key is bound')
{
  const root = join(import.meta.dir, '..', '..', 'src')
  const option = readFileSync(join(root, 'components', 'CustomSelect', 'select-input-option.tsx'), 'utf8')
  const preview = readFileSync(join(root, 'components', 'permissions', 'AskUserQuestionPermissionRequest', 'PreviewQuestionView.tsx'), 'utf8')
  const bindings = readFileSync(join(root, 'keybindings', 'defaultBindings.ts'), 'utf8')
  const confirmation = bindings.slice(bindings.indexOf('  Confirmation: {'), bindings.indexOf('  Tabs: {'))
  check('ctrl+g is the Confirmation context\'s key for the editor', confirmation.includes("'ctrl+g': 'chat:externalEditor'"))
  check('the list\'s text option listens in Chat and in Confirmation', /useKeybinding\('chat:externalEditor', openEditor, \{ context: 'Chat'/.test(option) && /useKeybinding\('chat:externalEditor', openEditor, \{ context: 'Confirmation'/.test(option))
  check('the preview card\'s notes field listens in Chat and in Confirmation', /useKeybinding\('chat:externalEditor', editNotesInEditor, \{ context: 'Chat'/.test(preview) && /useKeybinding\('chat:externalEditor', editNotesInEditor, \{ context: 'Confirmation'/.test(preview))
}

await releaseScratchHome(home)
console.log(`\n${checks - failures} passed, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
