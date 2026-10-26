import React from 'react'
import { mock } from 'bun:test'
import { KEY, mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, settle, waitFor } from '../lib/settingsPopupHarness.js'

pinSourceRef()
const home = pinScratchHome('memory-toggle-receipt')
let failures = 0
const check = (label: string, ok: boolean): void => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}`)
  if (!ok) failures++
}
await import('../../src/tools/AgentTool/AgentTool.js')
const settings = await import('../../src/utils/settings/settings.js')
const instructions = await import('../../src/services/instructions/engine.js')
let refused = true
const writes: boolean[] = []
const files = Promise.resolve([])
mock.module('../../src/services/instructions/engine.js', () => ({ ...instructions, getInstructionFiles: () => files }))
mock.module('../../src/utils/settings/settings.js', () => ({
  ...settings,
  updateSettingsForSource: (_source: string, patch: { memory: { enabled: boolean } }) => {
    writes.push(patch.memory.enabled)
    return { error: refused ? new Error('fixture write refused') : null }
  },
}))
const { MemoryFileSelector } = await import('../../src/components/memory/MemoryFileSelector.js')
const { AppStateProvider } = await import('../../src/state/AppState.js')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.js')
const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.js')
const { Box, Text } = await import('../../src/ink.js')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
let inputReady = false
function ReadyPicker(): React.ReactNode {
  React.useEffect(() => { inputReady = true }, [])
  return <MemoryFileSelector onSelect={() => {}} onCancel={() => {}} />
}
const view = await mountOffscreen(<AppStateProvider><ThemeProvider><KeybindingSetup><Box width={100} height={32} flexDirection="column"><React.Suspense fallback={<Text>loading</Text>}><ReadyPicker /></React.Suspense></Box></KeybindingSetup></ThemeProvider></AppStateProvider>, 100, 32)
try {
  check('the memory toggle paints and its input effects are mounted', await waitFor(() => inputReady && /Memory: (on|off)/.test(view.screen()), 3000))
  const original = view.screen().match(/Memory: (on|off)/)?.[1]
  view.push(KEY.up)
  check('the memory toggle receives focus before Enter', await waitFor(() => {
    const y = view.lines().findIndex(line => line.includes('Memory: '))
    const x = y < 0 ? -1 : view.lines()[y]!.indexOf('Memory: ')
    return x >= 0 && view.styleAt(x, y)?.inverse === true
  }, 3000))
  view.push(KEY.enter)
  check('the rejected write was attempted', await waitFor(() => writes.length === 1, 3000))
  check('a rejected settings write does not flip the displayed memory switch', view.screen().includes(`Memory: ${original}`))
  refused = false
  view.push(KEY.enter)
  check('a successful retry writes the same intended value and then flips the switch', await waitFor(() => writes.length === 2 && writes[0] === writes[1] && view.screen().includes(`Memory: ${original === 'on' ? 'off' : 'on'}`), 3000))
} finally {
  view.unmount()
  await settle(50)
  await releaseScratchHome(home)
}
console.log(`${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
