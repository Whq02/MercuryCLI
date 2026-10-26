import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { KEY, mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, waitFor, settle } from '../lib/settingsPopupHarness.ts'
pinSourceRef()
const home = pinScratchHome('local-gguf-input')
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const React = await import('react')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
const { AppStateProvider } = await import('../../src/state/AppState.tsx')
const { LocalSetupDialog } = await import('../../src/components/LocalSetupDialog.tsx')
type Road = import('../../src/components/LocalSetupDialog.tsx').LocalSetupRoad
let typed = ''
let aborted = false
const road: Road = (consent, signal) => (async function* () {
  const ask = { step: '2', title: 'Hugging Face', found: 'Repository id', willRun: '', input: 'author/model-GGUF', keys: 'type repository id · ↵ list files · esc keeps your model' }
  const answer = await consent(ask)
  if (typeof answer !== 'object') return
  typed = answer.pick
  yield { kind: 'result', step: '2', outcome: 'ran', words: typed }
  const pick = await consent({ step: '4', title: 'GGUF files', found: typed, willRun: '', rows: [{ tag: 'Any-Q6_K.gguf', words: '29 GB · 34.1 GiB memory · fits · 128k' }, { tag: 'Any-BF16.gguf', words: '70 GB · 73.1 GiB memory · does not fit' }], keys: '↑↓ choose · ↵ pick · esc keeps your model' })
  if (typeof pick !== 'object') return
  await new Promise<void>(resolve => { signal?.addEventListener('abort', () => { aborted = true; resolve() }, { once: true }) })
})()
const element = React.createElement(AppStateProvider, null, React.createElement(ThemeProvider, null, React.createElement(LocalSetupDialog, { road, width: 110, rowBudget: 24 })))
if (process.argv.includes('--pty')) {
  const { render } = await import('../../src/ink.js')
  render(element)
  await new Promise<void>(() => {})
}
const mounted = await mountOffscreen(element, 110, 26)
try {
  assert.ok(await waitFor(() => mounted.screen().includes('author/model-GGUF'), 4000), mounted.screen())
  mounted.push('fixture/Any-GGUx')
  mounted.push(KEY.left)
  mounted.push('\x1b[3~')
  mounted.push('F')
  assert.ok(await waitFor(() => mounted.screen().includes('fixture/Any-GGUF'), 4000), mounted.screen())
  const at = process.argv.indexOf('--frame')
  if (at >= 0) writeFileSync(process.argv[at + 1]!, mounted.screen())
  mounted.push(KEY.enter)
  assert.ok(await waitFor(() => typed === 'fixture/Any-GGUF' && mounted.screen().includes('Any-Q6_K.gguf'), 4000), mounted.screen())
  mounted.push(KEY.enter)
  await settle(100)
  assert.ok(!aborted)
  mounted.push(KEY.down)
  mounted.push(KEY.enter)
  await settle(100)
  mounted.push(KEY.esc)
  assert.ok(await waitFor(() => aborted, 2000))
  console.log('PASS repository editing, Enter selection, no preselection and Escape cancellation in rendered dialog')
} finally { mounted.unmount(); await releaseScratchHome(home) }
