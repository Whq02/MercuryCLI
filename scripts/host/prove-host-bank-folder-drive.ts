import './loopbackOnly.ts'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { KEY, mountOffscreen, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const f = await llmhostFixture()
process.env.HOME = f.home
if (process.platform === 'win32') process.env.USERPROFILE = f.home
let mounted: Mounted | undefined
try {
  const { bankDoor } = await import(f.root + '/src/models/hosting/fastLoad.ts')
  const bank = await import(f.root + '/src/models/hosting/bank.ts')
  const first = bank.rememberBankFolder(join(f.home, 'first-bank'))
  const second = join(f.home, 'second-bank')
  const questions: any[] = []
  const { enableConfigs } = await import('../../src/platform/settings/config.ts')
  enableConfigs()
  const React = await import('react')
  const { Box } = await import('../../src/screen/themedRenderer.ts')
  const { AppStateProvider } = await import('../../src/screen/app-state/AppState.tsx')
  const { ThemeProvider } = await import('../../src/screen/theme/ThemeProvider.tsx')
  const { SettingsPopupSlot } = await import('../../src/screen/overlays/SettingsPopupSlot.tsx')
  const popup = await import('../../src/screen/cockpit/settingsPopup.ts')
  const { llmHostPopupRequest } = await import('../../src/commands/llmhost/llmhost.tsx')
  const road = async (ask: any, emit: any, signal: AbortSignal) => bankDoor(async (q: any) => { questions.push(q); return ask(q) }, emit, signal, { runner: { run: async () => { throw new Error('No process should run') } }, sessionId: 'folder-proof', api: () => undefined, connect: async () => false })
  const width = process.argv.includes('--80') ? 80 : 120
  const height = width === 80 ? 24 : 44
  mounted = await mountOffscreen(React.createElement(AppStateProvider, {}, React.createElement(ThemeProvider, {}, React.createElement(Box, { flexDirection: 'column', width, height }, React.createElement(SettingsPopupSlot)))), width, height)
  popup.openSettingsPopup(llmHostPopupRequest(road))
  assert.ok(await waitFor(() => questions.some(q => q.step === 'door-bank'), 15000), mounted!.screen())
  assert.ok(questions.at(-1).rows.some((row: any) => row.value === 'change-folder'), 'Bank needs a Change folder row even after remembering a folder')
  const selected = () => mounted!.lines().find(line => line.includes('› ')) ?? ''
  for (let n = 0; n < 80 && !selected().includes('Change folder'); n++) { const before = selected(); mounted!.push(KEY.down); assert.ok(await waitFor(() => selected() !== before, 3000), `bank list cursor did not advance on step ${n} (selected=${selected()}); check door-bank popup`) }
  assert.ok(selected().includes('Change folder'), `cursor did not land on Change folder row (selected=${selected()}); check door-bank rows`)
  mounted!.push(KEY.enter)
  assert.ok(await waitFor(() => questions.at(-1)?.step === 'door-bank-folder', 10000), `selecting Change folder did not open door-bank-folder within 10000ms (step=${questions.at(-1)?.step}); check bank folder flow`)
  assert.equal(questions.at(-1).initial, bank.shortFolder(first))
  assert.equal(questions.at(-1).found, bank.shortFolder(first), 'Change folder shows the saved bank location')
  assert.equal(questions.at(-1).willRun, 'Existing weights stay in their current folder.', 'Change folder says the existing weights stay where they are')
  assert.ok(await waitFor(() => mounted!.screen().includes('Where should the bank live?'), 5000), 'door-bank-folder prompt heading did not paint within 5000ms; check bank folder view')
  const beforeClear = mounted!.screen()
  mounted!.push('\u0015')
  assert.ok(await waitFor(() => mounted!.screen() !== beforeClear, 5000), 'Ctrl+U did not clear bank folder input within 5000ms; check popup input')
  mounted!.push('~/second-bank')
  assert.ok(await waitFor(() => mounted!.screen().includes('second-bank'), 5000), 'bank folder input did not paint second-bank within 5000ms; check popup input')
  mounted!.push(KEY.enter)
  assert.ok(await waitFor(() => questions.at(-1)?.step === 'door-bank' && questions.at(-1).found.includes('second-bank'), 10000), `submitting bank folder did not return to door-bank with second-bank (step=${questions.at(-1)?.step}); check bank folder submit`)
  assert.equal(bank.readBankRegistry().folder, second)
  assert.equal(bank.bankFolder(), second)
  mounted!.push(KEY.esc)
  assert.ok(await waitFor(() => !popup.isSettingsPopupOpen(), 5000), 'door-bank popup did not close within 5000ms after Esc; check popup close')
  const beforeReopen = questions.length
  popup.openSettingsPopup(llmHostPopupRequest(road))
  assert.ok(await waitFor(() => questions.length > beforeReopen && questions.at(-1)?.step === 'door-bank' && mounted!.screen().includes('Bank'), 5000), `reopening Bank did not reach door-bank within 5000ms (step=${questions.at(-1)?.step}); check door-bank reopen`)
  for (let page = 0; page < 8 && !mounted!.screen().includes('second-bank'); page++) {
    const before = mounted!.screen()
    mounted!.push('\u001b[6~')
    assert.ok(await waitFor(() => mounted!.screen() !== before, 5000), 'the Bank folder is reachable by the displayed details pager')
  }
  assert.ok(mounted!.screen().includes('second-bank'), 'reopened door-bank screen did not show saved second-bank folder; check bank registry persistence')
  console.log('PASS Change folder shows the saved location, remembers the choice and re-reads the Bank immediately and on reopen')
} finally { mounted?.unmount(); f.close() }
