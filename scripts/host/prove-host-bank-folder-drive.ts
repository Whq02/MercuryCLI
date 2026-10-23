import assert from 'node:assert/strict'
import { join } from 'node:path'
import { KEY, mountOffscreen, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const f = await llmhostFixture()
process.env.HOME = f.home
let mounted: Mounted | undefined
try {
  const { bankDoor } = await import(f.root + '/src/services/host/fastLoad.ts')
  const bank = await import(f.root + '/src/services/host/bank.ts')
  const first = bank.rememberBankFolder(join(f.home, 'first-bank'))
  const second = join(f.home, 'second-bank')
  const questions: any[] = []
  const { enableConfigs } = await import('../../src/utils/config.ts')
  enableConfigs()
  const React = await import('react')
  const { Box } = await import('../../src/ink.ts')
  const { AppStateProvider } = await import('../../src/state/AppState.tsx')
  const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
  const { SettingsPopupSlot } = await import('../../src/components/SettingsPopupSlot.tsx')
  const popup = await import('../../src/utils/cockpit/settingsPopup.ts')
  const { llmHostPopupRequest } = await import('../../src/commands/llmhost/llmhost.tsx')
  const road = async (ask: any, emit: any, signal: AbortSignal) => bankDoor(async (q: any) => { questions.push(q); return ask(q) }, emit, signal, { runner: { run: async () => { throw new Error('No process should run') } }, sessionId: 'folder-proof', api: () => undefined, connect: async () => false })
  mounted = await mountOffscreen(React.createElement(AppStateProvider, {}, React.createElement(ThemeProvider, {}, React.createElement(Box, { flexDirection: 'column', width: 120, height: 44 }, React.createElement(SettingsPopupSlot)))), 120, 44)
  popup.openSettingsPopup(llmHostPopupRequest(road))
  assert.ok(await waitFor(() => questions.some(q => q.step === 'door-bank'), 15000), mounted!.screen())
  assert.ok(questions.at(-1).rows.some((row: any) => row.value === 'change-folder'), 'Bank needs a Change folder row even after remembering a folder')
  const selected = () => mounted!.lines().find(line => line.includes('› ')) ?? ''
  for (let n = 0; n < 80 && !selected().includes('Change folder'); n++) { const before = selected(); mounted!.push(KEY.down); assert.ok(await waitFor(() => selected() !== before, 3000)) }
  assert.ok(selected().includes('Change folder'))
  mounted!.push(KEY.enter)
  assert.ok(await waitFor(() => questions.at(-1)?.step === 'door-bank-folder', 10000))
  assert.equal(questions.at(-1).initial, bank.shortFolder(first))
  assert.ok(questions.at(-1).found.includes('mercury-model-bank'))
  assert.ok(await waitFor(() => mounted!.screen().includes('Where should the bank live?'), 5000))
  const beforeClear = mounted!.screen()
  mounted!.push('\u0015')
  assert.ok(await waitFor(() => mounted!.screen() !== beforeClear, 5000))
  mounted!.push('~/second-bank')
  assert.ok(await waitFor(() => mounted!.screen().includes('second-bank'), 5000))
  mounted!.push(KEY.enter)
  assert.ok(await waitFor(() => questions.at(-1)?.step === 'door-bank' && questions.at(-1).found.includes('second-bank'), 10000))
  assert.equal(bank.readBankRegistry().folder, second)
  assert.equal(bank.bankFolder(), second)
  mounted!.push(KEY.esc)
  assert.ok(await waitFor(() => !popup.isSettingsPopupOpen(), 5000))
  popup.openSettingsPopup(llmHostPopupRequest(road))
  assert.ok(await waitFor(() => mounted!.screen().includes('second-bank'), 5000))
  console.log('PASS Change folder uses the first-use candidates, remembers the choice and re-reads the Bank immediately and on reopen')
} finally { mounted?.unmount(); f.close() }
