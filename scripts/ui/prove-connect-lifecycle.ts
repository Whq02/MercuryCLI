import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { createElement } from 'react'
import { KEY, mountOffscreen, pinSourceRef, settle, waitFor } from '../lib/settingsPopupHarness.js'

pinSourceRef()

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }
for (const name of ['GOOGLE_API_KEY', 'GEMINI_API_KEY', 'MERCURY_GEMINI_OAUTH_CLIENT_ID', 'MERCURY_GEMINI_OAUTH_CLIENT_SECRET']) delete process.env[name]

const geminiAccounts = await import('../../src/services/providers/gemini/geminiAccounts.js')
const geminiLogin = await import('../../src/services/providers/gemini/geminiLogin.js')
const hfLogin = await import('../../src/services/providers/huggingface/huggingfaceLogin.js')
const kimiLogin = await import('../../src/services/providers/moonshot/moonshotLogin.js')

type Outcome = { ok: boolean; stored: boolean; receipt: string }
const pending: Array<{ resolve: (outcome: Outcome) => void; reject: (error: Error) => void }> = []
const store = (): Promise<Outcome> => new Promise((resolve, reject) => pending.push({ resolve, reject }))
let cancelCount = 0
let pasted = ''
const begin = () => {
  let reject!: (error: Error) => void
  const result = new Promise<never>((_, fail) => { reject = fail })
  return {
    authorizeUrl: 'https://accounts.google.com/fixture',
    result,
    completeWithRedirect: (value: string) => { pasted = value },
    cancel: () => { cancelCount++; reject(new Error('fixture cancelled')) },
  }
}
mock.module('../../src/services/providers/gemini/geminiAccounts.js', () => ({
  ...geminiAccounts,
  beginGeminiBrowserConnect: begin,
  beginGeminiPlanBrowserConnect: begin,
}))
mock.module('../../src/services/providers/gemini/geminiLogin.js', () => ({ ...geminiLogin, storeGeminiApiKeyLogin: store }))
const failDevice = async () => { throw new Error('fixture sign-in failed') }
mock.module('../../src/services/providers/huggingface/huggingfaceLogin.js', () => ({ ...hfLogin, storeHuggingfaceTokenLogin: store, runHuggingfaceDeviceLogin: failDevice }))
mock.module('../../src/services/providers/moonshot/moonshotLogin.js', () => ({ ...kimiLogin, storeMoonshotApiKeyLogin: store, runKimiDeviceLogin: failDevice }))
mock.module('../../src/utils/browser.js', () => ({ openBrowser: async () => true, openPath: async () => true }))

const { GeminiConnect } = await import('../../src/components/GeminiConnect.js')
const { HuggingfaceConnect } = await import('../../src/components/HuggingfaceConnect.js')
const { KimiConnect } = await import('../../src/components/KimiConnect.js')
const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.js')
const { AppStateProvider } = await import('../../src/state/AppState.js')
const { PopupCompactContext } = await import('../../src/context/popupFormContext.js')

async function mount(Component: typeof GeminiConnect, results: unknown[]) {
  return mountOffscreen(createElement(AppStateProvider, null,
    createElement(KeybindingSetup, null,
      createElement(PopupCompactContext.Provider, { value: { compact: true, setMarker: () => {} } },
        createElement(Component, { onResult: result => results.push(result) })))), 100, 30)
}
const press = async (board: Awaited<ReturnType<typeof mount>>, key: string): Promise<void> => { board.push(key); await settle(80) }

for (const Component of [GeminiConnect, HuggingfaceConnect, KimiConnect]) {
  const results: unknown[] = []
  const board = await mount(Component, results)
  try {
    await settle(150)
    await press(board, KEY.down)
    await press(board, KEY.enter)
    await press(board, 'fixture-private-key-value')
    assert(!board.screen().includes('fixture-private-key-value'), `${Component.name}: key masked`)
    const before = pending.length
    await press(board, KEY.enter)
    await press(board, KEY.enter)
    assert.equal(pending.length, before + 1, `${Component.name}: one store in flight`)
    pending[before]!.reject(new Error('fixture store failed'))
    assert(await waitFor(() => board.screen().includes('fixture store failed'), 2000), `${Component.name}: rejection shown`)
    await press(board, KEY.enter)
    assert.equal(pending.length, before + 2, `${Component.name}: failed store can retry`)
    await press(board, KEY.esc)
    pending[before + 1]!.resolve({ ok: true, stored: true, receipt: 'fixture stored' })
    await settle(100)
    assert.deepEqual(results, [{ ok: true, receipt: 'fixture stored' }], `${Component.name}: a store landing after Back is disclosed`)
    console.log(`PASS ${Component.name}: masked key, one submit, rejection, retry, landed store disclosed`)
  } finally { board.unmount() }
}

for (const leg of ['plan', 'oauth'] as const) {
  if (leg === 'oauth') geminiAccounts.writeGeminiOauthClientConfig({ clientId: 'fixture-client.apps.googleusercontent.com' })
  const results: unknown[] = []
  const board = await mount(GeminiConnect, results)
  try {
    await settle(150)
    if (leg === 'oauth') { await press(board, KEY.down); await press(board, KEY.down) }
    await press(board, KEY.enter)
    assert(await waitFor(() => board.screen().includes('paste the redirected URL'), 2000))
    await press(board, 'fixture-authorization-code')
    assert(!board.screen().includes('fixture-authorization-code'), `${leg}: redirect code masked`)
    await press(board, KEY.enter)
    assert.equal(pasted, 'fixture-authorization-code', `${leg}: original code delivered`)
    const before = cancelCount
    board.unmount()
    await settle(100)
    assert.equal(cancelCount, before + 1, `${leg}: listener cancelled`)
    assert.equal(results.length, 0, `${leg}: unmount cancellation cannot settle the parent`)
    console.log(`PASS ${leg}: masked redirect, original submitted, cancelled listener, stale rejection`)
  } finally { board.unmount() }
}

for (const Component of [HuggingfaceConnect, KimiConnect]) {
  const results: unknown[] = []
  const board = await mount(Component, results)
  try {
    await settle(150)
    await press(board, KEY.enter)
    if (Component === KimiConnect) await press(board, KEY.enter)
    assert(await waitFor(() => results.length > 0, 2000), `${Component.name}: rejected device login settles`)
    assert.deepEqual(results, [{ ok: false, receipt: 'fixture sign-in failed' }])
    console.log(`PASS ${Component.name}: device rejection returned`)
  } finally { board.unmount() }
}

{
  const board = await mount(GeminiConnect, [])
  try {
    await settle(150)
    for (let i = 0; i < 3; i++) await press(board, KEY.down)
    await press(board, KEY.enter)
    await press(board, KEY.enter)
    await press(board, 'fixture-client-secret')
    assert(board.screen().includes('***************secret'), board.screen())
    await press(board, KEY.esc)
    await press(board, KEY.enter)
    assert(!board.screen().includes('***************secret'), 'client secret cleared when leaving its field')
    console.log('PASS Gemini client secret cleared on back')
  } finally { board.unmount() }
}

console.log('PASS connect lifecycle')
process.exit(0)
