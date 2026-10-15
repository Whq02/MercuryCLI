#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, waitFor } from '../lib/settingsPopupHarness.ts'
pinSourceRef()
const home = pinScratchHome('filtered-picker-first-')
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const React = await import('react')
const { MercuryModelPicker } = await import('../../src/components/MercuryModelPicker.tsx')
const { App } = await import('../../src/components/App.tsx')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.tsx')
const { resetOverlayStackForTests } = await import('../../src/context/overlayStack.ts')
const h = React.createElement
const rows = [{ id: 'gpt-6-luna', name: 'GPT-6 Luna', tag: '', ctx: '400k', group: 'OpenAI' }]
let picked = ''
const scene = (models: typeof rows) => h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined } as never, h(KeybindingSetup, null, h(MercuryModelPicker, { models, initialFilter: 'gpt 6 luna', current: 'claude-fable-5-1', onSelect: (id: string) => { picked = id } })))
if (process.argv.includes('--scene')) {
  function Live(): React.ReactNode {
    const [models, setModels] = React.useState<typeof rows>([])
    React.useEffect(() => { setModels(rows) }, [])
    return scene(models)
  }
  const { render } = await import('../../src/ink.ts')
  await render(h(Live), { patchConsole: false })
  await new Promise(() => {})
}
const m = await mountOffscreen(scene([]), 120, 40)
let failed = false
try {
  await waitFor(() => m.screen().includes('Mercury · model'), 6000)
  m.resize(scene(rows), 120, 40)
  await waitFor(() => m.screen().includes('GPT-6 Luna'), 6000)
  const frame = m.screen()
  const match = /↵ switch/.test(frame) && !/↵ fold/.test(frame)
  console.log(`${match ? 'PASS' : 'FAIL'} the asynchronously loaded filter lands on its first model, not the provider heading`)
  if (!match) { failed = true; console.log(frame) }
  const frames = process.argv.indexOf('--frames')
  if (frames >= 0) { const dir = process.argv[frames + 1]!; mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'filtered-first-match.txt'), frame) }
  m.push(KEY.enter)
  await waitFor(() => picked !== '', 3000)
  console.log(`${picked === 'gpt-6-luna' ? 'PASS' : 'FAIL'} Enter selects the matching model: ${picked || 'no selection'}`)
  if (picked !== 'gpt-6-luna') failed = true
} finally { m.unmount(); resetOverlayStackForTests(); await releaseScratchHome(home) }
if (failed) process.exit(1)
console.log('prove-filtered-picker-first-match: GREEN')
process.exit(0)
