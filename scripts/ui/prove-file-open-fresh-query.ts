import assert from 'node:assert/strict'
import { createElement } from 'react'
import { KEY, mountOffscreen, pinSourceRef, settle, waitFor } from '../lib/settingsPopupHarness.js'
import type { SuggestionItem } from '../../src/components/PromptInput/PromptInputFooterSuggestions.js'

pinSourceRef()
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }
const { MercuryFileOpen } = await import('../../src/components/MercuryFileOpen.js')
const { AppStateProvider } = await import('../../src/state/AppState.js')
const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.js')
const requests: Array<{ query: string; resolve: (items: SuggestionItem[]) => void; reject: (error: Error) => void }> = []
const picked: string[] = []
const loadFiles = (query: string): Promise<SuggestionItem[]> => new Promise((resolve, reject) => requests.push({ query, resolve, reject }))
const board = await mountOffscreen(createElement(AppStateProvider, null,
  createElement(KeybindingSetup, null,
    createElement(MercuryFileOpen, { loadFiles, onPick: path => picked.push(path), onClose: () => {} }))), 100, 36)
const press = async (key: string): Promise<void> => { board.push(key); await settle(80) }
const items = (name: string): SuggestionItem[] => [{ id: name, displayText: name }]
try {
  assert(await waitFor(() => requests.length === 1, 2000))
  requests[0]!.resolve(items('old.ts'))
  assert(await waitFor(() => board.screen().includes('@old.ts'), 2000))
  await press('a')
  assert.equal(requests[1]?.query, 'a')
  await press(KEY.enter)
  assert.deepEqual(picked, [], 'pending query must not insert a result from the previous query')
  assert(!board.screen().includes('@old.ts'), 'pending query retires the previous rows')
  await press('b')
  assert.equal(requests[2]?.query, 'ab')
  requests[2]!.resolve(items('latest.ts'))
  assert(await waitFor(() => board.screen().includes('@latest.ts'), 2000))
  requests[1]!.resolve(items('stale.ts'))
  await settle(80)
  assert(!board.screen().includes('@stale.ts'), 'out-of-order completion stays retired')
  await press(KEY.enter)
  assert.deepEqual(picked, ['@latest.ts '])
  await press('c')
  requests[3]!.reject(new Error('fixture lookup failed'))
  assert(await waitFor(() => board.screen().includes('no files'), 2000))
  await press(KEY.enter)
  assert.equal(picked.length, 1, 'failed lookup cannot insert stale results')
  console.log('PASS file quick-open: pending query, out-of-order completion, fresh insertion, failed lookup')
} finally { board.unmount() }
process.exit(0)
