import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'
import { gridToPng } from '../ui/gridToPng.ts'
import type { LlmHostQuestion } from '../../src/services/llmHost/index.ts'

const frameDir = (): string | undefined => { const at = process.argv.indexOf('--frames'); return at < 0 ? undefined : process.argv[at + 1] }
async function save(mounted: Mounted, name: string, width: number, height: number): Promise<void> {
  const directory = frameDir()!
  mkdirSync(directory, { recursive: true })
  const screen = mounted.screen()
  assert.ok(!screen.includes('RENDER ERROR'), screen)
  assert.ok(!/\b(door|road|seat|fold|lane|ladder|owner|law|pin|prover)s?\b/i.test(screen), screen)
  writeFileSync(join(directory, name + '.txt'), screen)
  const grid = mounted.lines().map((line, y) => Array.from(line.padEnd(width)).map((c, x) => ({ c, bg: mounted.styleAt(x, y)?.bg ?? 'default', fg: mounted.styleAt(x, y)?.fg ?? 'default', bold: mounted.styleAt(x, y)?.bold ?? false })))
  const path = join(directory, name + '.json')
  writeFileSync(path, JSON.stringify({ grid, cols: width, rows: height }))
  await gridToPng(path, join(directory, name + '.png'))
}

export async function captureHostQuestion(plan: LlmHostQuestion, name: string): Promise<void> {
  if (!frameDir()) return
  const React = await import('react')
  const { Box } = await import('../../src/ink.ts')
  const { AppStateProvider } = await import('../../src/state/AppState.tsx')
  const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
  const { SettingsPopupSlot } = await import('../../src/components/SettingsPopupSlot.tsx')
  const popup = await import('../../src/utils/cockpit/settingsPopup.ts')
  const { llmHostPopupRequest } = await import('../../src/commands/llmhost/llmhost.tsx')
  for (const [width, height] of [[120, 44], [80, 28]] as const) {
    popup.openSettingsPopup(llmHostPopupRequest(async ask => { await ask(plan); return { ok: false, words: '' } }))
    const mounted = await mountOffscreen(React.createElement(AppStateProvider, {}, React.createElement(ThemeProvider, {}, React.createElement(Box, { flexDirection: 'column', width, height }, React.createElement(SettingsPopupSlot)))), width, height)
    try {
      assert.ok(await waitFor(() => mounted.screen().includes(plan.title.slice(0, 20)), 10000), mounted.screen())
      await save(mounted, name + '-' + width, width, height)
      mounted.push(KEY.esc)
      assert.ok(await waitFor(() => !popup.isSettingsPopupOpen(), 5000), mounted.screen())
    } finally { mounted.unmount() }
  }
}

export async function captureHostNotice(words: string, name: string): Promise<void> {
  if (!frameDir()) return
  const React = await import('react')
  const { Box } = await import('../../src/ink.ts')
  const { AppStateProvider } = await import('../../src/state/AppState.tsx')
  const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
  const { UserTextMessage } = await import('../../src/components/messages/UserTextMessage.tsx')
  for (const [width, height] of [[120, 32], [80, 40]] as const) {
    const mounted = await mountOffscreen(React.createElement(AppStateProvider, {}, React.createElement(ThemeProvider, {}, React.createElement(Box, { flexDirection: 'column', width, height }, React.createElement(UserTextMessage, { addMargin: false, param: { type: 'text', text: words }, notice: true, verbose: true })))), width, height)
    try {
      assert.ok(await waitFor(() => mounted.screen().includes('bill'), 10000), mounted.screen())
      await save(mounted, name + '-' + width, width, height)
    } finally { mounted.unmount() }
  }
}
