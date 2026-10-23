import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mountOffscreen, pinSourceRef, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

pinSourceRef()
if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const React = await import('react')
const { Box, Text } = await import('../../src/ink.ts')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
const { LlmHostDialog } = await import('../../src/components/LlmHostDialog.tsx')
const { gridToPng } = await import('../ui/gridToPng.ts')
const at = process.argv.indexOf('--frames')
const frames = at < 0 ? undefined : process.argv[at + 1]
let mounted: Mounted | undefined
const { LLM_HOST_WORDS } = await import('../../src/commands/llmhost/words.ts')
const words = LLM_HOST_WORDS.terminatedPod
assert.equal(words, 'Machine terminated · its disk is deleted.')
function Scene() {
  const [line, setLine] = React.useState('')
  const [hint, setHint] = React.useState<string | null>(null)
  return React.createElement(ThemeProvider, {}, React.createElement(Box, { flexDirection: 'column', width: 100, height: 24 },
    React.createElement(Text, {}, line),
    React.createElement(LlmHostDialog, { width: 100, rowBudget: 20, road, onLine: setLine, onHint: setHint }),
    React.createElement(Text, {}, hint)))
}
const road: NonNullable<Parameters<typeof LlmHostDialog>[0]['road']> = async (_ask, emit) => {
  emit({ title: 'Machine controls', words, host: { id: 'ended-pod', price: 0, startedAt: new Date().toISOString(), status: 'TERMINATED' } })
  return { ok: true, words }
}
try {
  mounted = await mountOffscreen(React.createElement(Scene), 100, 24)
  const m = mounted
  assert.ok(await waitFor(() => m.screen().includes(words), 5000), 'termination result reaches the frame\n' + m.screen())
  if (frames) {
    mkdirSync(frames, { recursive: true })
    writeFileSync(join(frames, 'terminated.txt'), m.screen())
    const grid = m.lines().map((line, y) => Array.from(line.padEnd(100)).map((c, x) => { const style = m.styleAt(x, y); return { c, bg: style?.bg ?? 'default', fg: style?.fg ?? 'default', bold: style?.bold ?? false, rev: style?.inverse ?? false } }))
    writeFileSync(join(frames, 'terminated.json'), JSON.stringify({ grid, cols: 100, rows: 24 }))
    await gridToPng(join(frames, 'terminated.json'), join(frames, 'terminated.png'))
  }
  assert.equal(m.screen().split(words).length - 1, 1, 'the completion says the termination once, not once per event, result and meter')
  assert.equal(m.screen().split('esc closes').length - 1, 1, 'the popup footer owns its close hint')
  console.log('HOST COMPLETION GREEN · termination result and close hint each paint exactly once')
} finally { mounted?.unmount() }
