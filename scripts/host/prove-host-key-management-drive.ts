import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { KEY, mountOffscreen, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { runpodFixture } from './runpodFixture.mjs'
import { vastFixture } from './vastFixture.mjs'
import { lambdaFixture } from './lambdaFixture.mjs'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const f = await llmhostFixture()
const rp = await runpodFixture(), vast = await vastFixture(), lambda = await lambdaFixture()
let mounted: Mounted | undefined
const nativeFetch = globalThis.fetch
globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : input)
  assert.ok(['127.0.0.1', '[::1]'].includes(url.hostname), 'only loopback requests')
  return nativeFetch(input, init)
}, nativeFetch)
try {
  assert.ok(existsSync(f.root + '/src/models/hosting/vendorKeys.ts'), 'connected host vendors need key management controls')
  const { vendorKeyRows, manageVendorKey } = await import(f.root + '/src/models/hosting/vendorKeys.ts')
  const { saveVendorKey, vendorKey, vendorLabel } = await import(f.root + '/src/models/hosting/vendors/client.ts')
  const { writeStoredHuggingfaceApiKey } = await import(f.root + '/src/models/sign-in/account-ledger/providerSecrets.ts')
  const React = await import('react')
  const { Box } = await import('../../src/screen/themedRenderer.ts')
  const { AppStateProvider } = await import('../../src/screen/app-state/AppState.tsx')
  const { ThemeProvider } = await import('../../src/screen/theme/ThemeProvider.tsx')
  const { SettingsPopupSlot } = await import('../../src/screen/overlays/SettingsPopupSlot.tsx')
  const popup = await import('../../src/screen/cockpit/settingsPopup.ts')
  const { llmHostPopupRequest } = await import('../../src/commands/llmhost/llmhost.tsx')
  const width = process.argv.includes('--80') ? 80 : 120
  const height = width === 80 ? 24 : 44
  mounted = await mountOffscreen(React.createElement(AppStateProvider, {}, React.createElement(ThemeProvider, {}, React.createElement(Box, { flexDirection: 'column', width, height }, React.createElement(SettingsPopupSlot)))), width, height)
  const until = async (text: string) => assert.ok(await waitFor(() => mounted!.screen().includes(text), 15000), text + '\n' + mounted!.screen())
  const selected = () => mounted!.lines().find(line => line.includes('› ')) ?? ''
  const choose = async (text: string) => {
    for (let n = 0; n < 12 && !selected().includes(text); n++) { const before = selected(); mounted!.push(KEY.down); assert.ok(await waitFor(() => selected() !== before, 2000), `key management cursor did not move toward ${text} on step ${n}; check manageVendorKey popup`) }
    assert.ok(selected().includes(text), text + '\n' + mounted!.screen())
    mounted!.push(KEY.enter)
  }
  for (const [id, fixture] of [['runpod', rp], ['vast', vast], ['lambda', lambda]] as const) {
    saveVendorKey(id, 'fixture-old-' + id)
    assert.ok(vendorKeyRows().some((row: any) => row.value === 'key:' + id && row.label.includes('Replace key / Remove key')), `vendorKeyRows missing Replace/Remove row for ${id}; check vendorKeyRows`)
    let changed = 0
    const open = () => popup.openSettingsPopup(llmHostPopupRequest(async (ask, emit, signal) => {
      const result = await manageVendorKey(id, ask, emit, signal, { apiBaseUrl: fixture.baseUrl, changed: () => { changed++ } })
      return { ok: true, words: result ? 'Key changed' : 'Key unchanged' }
    }))
    const close = async () => { mounted!.push(KEY.esc); assert.ok(await waitFor(() => !popup.isSettingsPopupOpen(), 3000), `vendor key popup for ${id} did not close within 3000ms after Esc; check popup close`) }
    open(); await until('Replace key'); await choose('Replace key'); await until('new key is checked'); mounted!.push('fixture-invalid'); await until('********'); mounted!.push(KEY.enter); await until('Key unchanged'); await close()
    assert.equal(vendorKey(id), 'fixture-old-' + id)
    assert.equal(changed, 0)
    open(); await until('Replace key'); await choose('Replace key'); await until('new key is checked'); mounted!.push(fixture.key); await until('********'); mounted!.push(KEY.enter); await until('Key changed'); await close()
    assert.equal(vendorKey(id), fixture.key)
    assert.equal(changed, 1)
    open(); await until('Replace key'); await choose('Remove key'); await until('Rented machines and disks keep billing'); await choose('Remove key'); await until('Key changed'); await close()
    assert.equal(vendorKey(id), undefined)
    assert.equal(changed, 2)
    assert.ok(!vendorKeyRows().some((row: any) => row.value === 'key:' + id), `vendorKeyRows still listed ${id} after key removal; check vendorKeyRows`)
    assert.equal(fixture.state.creates, 0)
    console.log('PASS ' + vendorLabel(id) + ': rejected replacement keeps old key; valid replacement verifies; removal disconnects without renting')
  }
  writeStoredHuggingfaceApiKey('fixture-hf-signout')
  assert.ok(vendorKeyRows().some((row: any) => row.value === 'key:huggingface' && row.label.includes('Sign out with /logins huggingface')), 'vendorKeyRows missing /logins huggingface sign-out row; check vendorKeyRows')
  const notices: string[] = []
  await manageVendorKey('huggingface', async () => { throw new Error('HF must use its existing sign-out') }, (notice: any) => notices.push(notice.words), new AbortController().signal)
  assert.ok(notices[0]?.includes('/logins huggingface'), `HF manageVendorKey notice missing /logins huggingface guidance (got=${notices[0]}); check manageVendorKey`)
  assert.equal(vendorKey('huggingface'), 'fixture-hf-signout')
  console.log('PASS HF sign-out uses the existing login owner; no duplicate credential removal')
} finally { mounted?.unmount(); await rp.close(); await vast.close(); await lambda.close(); f.close(); globalThis.fetch = nativeFetch }
