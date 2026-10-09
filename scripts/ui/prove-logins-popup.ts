#!/usr/bin/env bun
import React from 'react'
import { mock } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import stringWidth from 'string-width'
import { KEY, mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'
import type { DOMElement } from '../../src/ink.js'

pinSourceRef()
const home = pinScratchHome('mercury-logins-popup')
for (const name of Object.keys(process.env)) if (/^(ANTHROPIC_|CLAUDE_|OPENAI_|ZAI_|XAI_|META_|OPENROUTER_|GOOGLE_|GEMINI_|MOONSHOT_|DEEPSEEK_|HF_|HUGGINGFACE_)/.test(name)) delete process.env[name]
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const frameArg = process.argv.indexOf('--frames')
const frames = frameArg < 0 ? undefined : process.argv[frameArg + 1]
if (frames) mkdirSync(frames, { recursive: true })
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
async function stub(path: string, overrides: Record<string, unknown>): Promise<void> {
  const actual = await import(path)
  mock.module(path, () => ({ ...actual, ...overrides }))
}
await stub('../../src/context/notifications.js', { useNotifications: () => ({ addNotification() {}, removeNotification() {} }) })
await stub('../../src/hooks/useCatalogueEpoch.js', { useCatalogueEpoch: () => 0 })
await stub('../../src/utils/model/computedDefault.js', { mostRecentSignInFamily: () => undefined })
await stub('../../src/utils/browser.js', { openBrowser: async () => true })
let estate = 'absent'
const ids = ['anthropic', 'openai', 'openrouter', 'gemini', 'huggingface', 'moonshot', 'zai', 'deepseek', 'xai', 'meta', 'local', 'openai-compat', 'zen']
await stub('../../src/services/providers/providerUsability.js', {
  resolveProviderUsability: () => Object.fromEntries(ids.map((id, i) => {
    const usable = estate === 'full' || (estate === 'mixed' && i % 2 === 0)
    return [id, { usable, credential: usable ? (id === 'local' ? 'keyless' : ['anthropic', 'openai', 'gemini', 'huggingface', 'moonshot'].includes(id) ? 'oauth' : 'api-key') : 'none', blockers: [`not signed in — /logins ${id} connects this family`], limit: 'allowed' }]
  })),
})
const { executeSlotRemoval: removeSlot } = await import('../../src/services/providers/accountSlots.js')
const removed = new Set<string>()
const removedCalls: string[] = []
const routeFor: Record<string, string> = { anthropic: 'anthropic-managed-key', openai: 'openai-subscription', openrouter: 'openrouter-stored-key', gemini: 'gemini-oauth', huggingface: 'huggingface-oauth', moonshot: 'moonshot-oauth', zai: 'zai-stored-key', deepseek: 'deepseek-stored-key', xai: 'xai-stored-key', meta: 'meta-stored-key', local: 'local-stored-key', 'openai-compat': 'compat-stored-key', zen: 'zen-stored-key' }
await stub('../../src/services/providers/accountSlots.js', {
  deriveFamilySlotGroups: () => ids.map((id, index) => {
    const signed = estate === 'full' || (estate === 'mixed' && index % 2 === 0)
    const slots = signed ? [{ family: id, id: `${id}:fixture`, name: id, kind: ['openai', 'gemini', 'huggingface', 'moonshot'].includes(id) ? 'subscription' : 'api-key', kindLabel: id === 'openai' ? 'ChatGPT subscription' : 'API key', identity: `${id}@example.com`, active: true, signedIn: true, envPinned: false, removal: { route: routeFor[id] } }] : []
    if (id === 'anthropic' && signed) slots.push({ ...slots[0]!, id: 'anthropic:oauth', kind: 'oauth', kindLabel: 'Claude subscription', removal: { route: 'anthropic-oauth', dir: home }, scope: { foreignHarness: false, isCurrent: true } } as never)
    if (id === 'openai' && signed) slots.push({ ...slots[0]!, id: 'openai:key', kind: 'api-key', kindLabel: 'API key', identity: 'stored key', active: false, removal: { route: 'openai-stored-key' } })
    return { family: { id, available: true, credentialed: signed }, slots: slots.filter(slot => !removed.has(slot.id)) }
  }),
  executeSlotRemoval: (slot: Parameters<typeof removeSlot>[0]) => {
    const remove = () => { removedCalls.push(slot.id); removed.add(slot.id) }
    return removeSlot(slot, { clearManagedAnthropicKey: remove, signOutAnthropicOauth: remove, disconnectOpenaiSubscription: remove, clearStoredOpenaiKey: remove, clearStoredOpenrouterKey: remove, disconnectGeminiOauth: remove, disconnectHuggingfaceOauth: remove, disconnectMoonshotOauth: remove, clearStoredZaiKey: remove, clearStoredDeepseekKey: remove, clearStoredXaiKey: remove, clearStoredMetaKey: remove, clearStoredLocalKey: remove, clearStoredCompatKey: remove, openaiApiKeyAfter: () => undefined })
  },
})
let switches = 0
const { switchActiveSlot: switchSlot } = await import('../../src/services/providers/slotSwitch.js')
await stub('../../src/services/providers/slotSwitch.js', { switchActiveSlot: () => switchSlot('openai', { reads: { openaiSubscription: () => ({ label: 'ChatGPT subscription' }), openaiKey: () => ({ source: 'stored' }), openaiActiveKind: () => 'chatgpt-subscription', openaiWallOf: () => ({ state: 'allowed' }) as never }, writes: { writeOpenaiPreference: () => { switches++ } } }) })
let seed = 'idle'
let submits: string[] = []
let successKey = false
let deviceStarts = 0
let deviceCancelled: (() => boolean) | undefined
await stub('../../src/components/mercury-ui/screens/anthropicLoginModel.js', {
  useAnthropicLoginModel: () => {
    const [flow, setFlow] = React.useState({ name: seed, url: `https://example.com/oauth/authorize?state=${'fixture'.repeat(24)}` })
    return {
      flow, pastePromptUp: true, copied: false, shadowWarning: null, accountLabel: 'owner@example.com',
      start: () => setFlow(f => ({ ...f, name: 'waiting' })),
      submitCode: (code: string) => { submits.push(code); setFlow(f => ({ ...f, name: 'success' })); return true },
      retry: () => setFlow(f => ({ ...f, name: 'waiting' })), copyUrl() {},
    }
  },
})
await stub('../../src/services/providers/moonshot/moonshotLogin.js', {
  runKimiDeviceLogin: (options: { cancelled: () => boolean; onEvent: (event: unknown) => void }) => {
    deviceStarts++
    deviceCancelled = options.cancelled
    options.onEvent({ phase: 'waiting', polls: 0, start: { userCode: 'ABCD-EFGH', verificationUri: 'https://example.com/kimi/device', expiresAtMs: 1_900_000_000_000 } })
    return new Promise(() => {})
  },
})
await stub('../../src/services/providers/moonshot/moonshotAccounts.js', { moonshotStoredRegion: () => undefined })
let xaiCancelled: (() => boolean) | undefined
await stub('../../src/services/providers/xai/xaiLogin.js', {
  runXaiDeviceLogin: (options: { cancelled: () => boolean; onEvent: (event: unknown) => void }) => {
    xaiCancelled = options.cancelled
    options.onEvent({ phase: 'waiting', polls: 0, start: { userCode: 'GROK-CODE', verificationUri: 'https://example.com/grok/device', expiresAtMs: 1_900_000_000_000 } })
    return new Promise(() => {})
  },
})
await stub('../../src/services/providers/deepseek/deepseekLogin.js', {
  storeDeepseekApiKeyLogin: async (value: string) => { submits.push(value); return { stored: successKey, ok: successKey, receipt: successKey ? 'DeepSeek connected — fixture receipt.' : 'Fixture refused the key — correct it here.' } },
})
await stub('../../src/services/providers/huggingface/huggingfaceLogin.js', {
  runHuggingfaceDeviceLogin: (options: { onEvent: (event: unknown) => void }) => {
    options.onEvent({ phase: 'waiting', polls: 0, start: { userCode: 'HF-CODE', verificationUri: 'https://example.com/hf/device', expiresAtMs: 1_900_000_000_000 } })
    return new Promise(() => {})
  },
})
let browserCancels = 0
const browserHandles = () => ({ authorizeUrl: `https://example.com/authorize?state=${'fixture'.repeat(24)}`, result: new Promise(() => {}), cancel() { browserCancels++ }, completeWithRedirect() {} })
await stub('../../src/services/providers/openai/openaiAccounts.js', { beginOpenaiBrowserConnect: browserHandles, beginOpenaiDeviceConnect: async () => ({ userCode: 'OA-CODE', verifyHint: 'https://example.com/device', result: new Promise(() => {}) }) })
await stub('../../src/services/providers/openrouter/openrouterAccounts.js', { beginOpenrouterConnect: browserHandles })
await stub('../../src/services/providers/gemini/geminiAccounts.js', { beginGeminiBrowserConnect: browserHandles })
const { Box, Text } = await import('../../src/ink.js')
const { AppStateProvider } = await import('../../src/state/AppState.js')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.js')
const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.js')
const { SettingsPopupSlot, settingsPopupGeometry } = await import('../../src/components/SettingsPopupSlot.js')
const { ScrollKeybindingHandler } = await import('../../src/components/ScrollKeybindingHandler.js')
const store = await import('../../src/utils/cockpit/settingsPopup.js')
const { call } = await import('../../src/commands/login/login.js')
const { loginFamilyRows } = await import('../../src/components/loginFamilyRows.js')
const familyRows = loginFamilyRows({ engineLegs: true })
let failures = 0
function check(label: string, pass: boolean, detail = ''): void {
  if (!pass) failures++
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label}${!pass && detail ? ` — ${detail}` : ''}`)
}
type Scene = { columns: number; rows: number; bottom?: number }
const allSizes: Scene[] = [{ columns: 64, rows: 12 }, { columns: 80, rows: 24 }, { columns: 120, rows: 40 }, { columns: 178, rows: 51 }]
const sizeArg = process.argv.indexOf('--sizes')
const sizes = sizeArg < 0 ? allSizes : allSizes.filter(s => (process.argv[sizeArg + 1] ?? '').split(',').includes(`${s.columns}x${s.rows}`))
const title = 'Mercury · logins'
const hint = 'esc or click outside closes'
const compactHint = 'Mercury · logins · esc closes'
const geometryOf = (s: Scene) => settingsPopupGeometry({ width: 100, rows: 29 }, s.columns, s.rows, 0, { top: 0, rows: s.rows - (s.bottom ?? 0) })
const COMPACT_BELOW_BODY_ROWS = 8
const isCompact = (s: Scene): boolean => (geometryOf(s).rows ?? 0) - 7 < COMPACT_BELOW_BODY_ROWS
check('the host folds below eight full-layout body rows, one constant the geometry reads', (store as { SETTINGS_POPUP_COMPACT_BELOW_ROWS?: number }).SETTINGS_POPUP_COMPACT_BELOW_ROWS === COMPACT_BELOW_BODY_ROWS && allSizes.every(s => geometryOf(s).compact === isCompact(s)) && geometryOf({ columns: 64, rows: 12, bottom: 3 }).compact === true && geometryOf({ columns: 64, rows: 12, bottom: 3 }).rowBudget === 4, JSON.stringify(allSizes.map(s => [s.columns, s.rows, geometryOf(s).compact])))
const markerOf = (m: Mounted): string | undefined => m.lines().find(line => line.includes(compactHint))?.match(/(\d+ of \d+)\s*│?\s*$/)?.[1]
const context = { onChangeAPIKey() {}, setMessages() {}, getAppState: () => ({}), setAppState() {} } as never
const receipts: string[] = []
async function mount(scene: Scene, focus = '') {
  const ref = React.createRef<DOMElement>()
  const scaffold = (s: Scene) => React.createElement(AppStateProvider as never, {}, React.createElement(ThemeProvider as never, {}, React.createElement(KeybindingSetup, {},
    React.createElement(Box, { width: s.columns, height: s.rows, flexDirection: 'column' },
      React.createElement(Box, { ref, height: s.rows - (s.bottom ?? 0), flexDirection: 'column' }, ...Array.from({ length: s.rows - (s.bottom ?? 0) }, (_, i) => React.createElement(Text, { key: i }, `CONTEXT ${i}`))),
      React.createElement(Box, { height: s.bottom ?? 0, flexDirection: 'column' }, ...Array.from({ length: s.bottom ?? 0 }, (_, i) => React.createElement(Text, { key: i }, 'BOTTOM'))),
      React.createElement(ScrollKeybindingHandler, { isActive: true, scrollRef: { current: null } }),
      React.createElement(SettingsPopupSlot, { overlay: true, hostRef: ref }),
    ))))
  const m = await mountOffscreen(scaffold(scene), scene.columns, scene.rows)
  await settle(60)
  const result = await call((receipt: string | undefined) => { receipts.push(receipt ?? '') }, context, focus)
  check('the command opens the shared popup without installing a bottom panel', result === null && store.settingsPopupRequest()?.view === 'logins')
  if (!(await waitFor(() => m.screen().includes(title), 3000))) throw new Error(`popup did not mount; crash evidence: ${home}`)
  await settle(100)
  return { m, resize: async (next: Scene) => { m.resize(scaffold(next), next.columns, next.rows); await settle(150) }, close: () => { store.closeSettingsPopup(); m.unmount() } }
}
async function key(m: Mounted, data: string) { m.push(data); await settle(70) }
function save(m: Mounted, scene: Scene, name: string) { if (frames) writeFileSync(join(frames, `${name}-${scene.columns}x${scene.rows}.txt`), m.lines().join('\n') + '\n') }
function fits(m: Mounted, s: Scene, name: string) {
  const lines = m.lines()
  const top = lines.findIndex(line => line.includes('╭'))
  const left = lines[top]?.indexOf('╭') ?? -1
  const right = lines[top]?.indexOf('╮') ?? -1
  const bottom = lines.findIndex((line, i) => i > top && line[left] === '╰')
  const geometry = geometryOf(s)
  const framed = top === geometry.top && left === geometry.left && right - left + 1 === geometry.width && bottom - top + 1 === geometry.rows && lines.slice(top + 1, bottom).every(line => line[left] === '│' && line[right] === '│')
  if (isCompact(s)) check(`${name} ${s.columns}x${s.rows}: complete centred frame whose first row folds the title and the close hint`, framed && (lines[top + 1] ?? '').includes(compactHint) && !m.screen().includes(hint), m.screen())
  else check(`${name} ${s.columns}x${s.rows}: complete centred frame and pinned close hint`, framed && m.screen().includes(hint), m.screen())
  check(`${name}: every cell stays inside the terminal and the host bottom survives`, lines.length <= s.rows && lines.every(line => stringWidth(line) <= s.columns) && lines.slice(s.rows - (s.bottom ?? 0)).every(line => line === 'BOTTOM'))
}
async function walk(m: Mounted, end: string, step = '\x1b[6~'): Promise<boolean> {
  for (let i = 0; i < 70; i++) {
    if (m.screen().includes(end)) return true
    const before = m.screen()
    await key(m, step)
    if (m.screen() === before) return false
  }
  return false
}
const bodyRows = (m: Mounted, s: Scene): string[] => {
  const lines = m.lines()
  const top = lines.findIndex(line => line.includes('╭'))
  const bottom = lines.findIndex((line, i) => i > top && line.includes('╰'))
  return lines.slice(top + 2, bottom).map(line => line.replace(/^\s*│ ?/, '').replace(/│\s*$/, '').trimEnd())
}
const rowsVisible = (m: Mounted, s: Scene): number => bodyRows(m, s).filter(line => line !== '').length
for (const s of sizes) {
  seed = 'idle'; estate = 'absent'
  let board = await mount(s)
  fits(board.m, s, 'menu'); save(board.m, s, 'menu')
  check(`${s.columns}x${s.rows}: the twelve-family list starts without a digit or a reserved ordinal column`, familyRows.length === 12 && board.m.screen().includes('❯ OpenAI — ChatGPT'))
  const menu = board.m.screen()
  for (const digit of ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '１', '９']) {
    await key(board.m, digit)
    check(`${s.columns}x${s.rows}: hidden shortcut ${digit} neither selects nor opens a family`, board.m.screen() === menu)
  }
  const compact = isCompact(s)
  if (compact) {
    const body = bodyRows(board.m, s)
    check(`${s.columns}x${s.rows} compact: the body is the family rows alone, one line each, filling the box`, body.length === geometryOf(s).rowBudget && body.every(line => line !== '') && body.filter(line => /^[❯ ↓↑] /.test(line)).length === body.length && !board.m.screen().includes('Sign in') && !board.m.screen().includes('Provider readiness') && !board.m.screen().includes('subscription, usage-based billing'), body.join(' | '))
    check(`${s.columns}x${s.rows} compact: the header marker reads 1 of 12`, markerOf(board.m) === '1 of 12', markerOf(board.m))
  }
  for (let index = 1; index < 12; index++) {
    await key(board.m, KEY.down)
    check(`${s.columns}x${s.rows}: arrows reach family ${index + 1} without a digit or a reserved ordinal column`, board.m.screen().includes(`❯ ${familyRows[index]!.label.slice(0, 24)}`))
    if (compact) check(`${s.columns}x${s.rows} compact: the marker follows the focus to ${index + 1} of 12`, markerOf(board.m) === `${index + 1} of 12`, markerOf(board.m))
  }
  save(board.m, s, 'menu-bottom')
  if (compact) {
    check(`${s.columns}x${s.rows} compact: the last family row is reached by arrows with the title row still pinned`, board.m.screen().includes('OpenCode Zen — API key') && board.m.lines().some(line => line.includes(compactHint)))
    for (let index = 0; index < 11; index++) await key(board.m, KEY.up)
    check(`${s.columns}x${s.rows} compact: arrows return to the first row and the marker reads 1 of 12`, markerOf(board.m) === '1 of 12' && board.m.screen().includes('OpenAI — ChatGPT'), markerOf(board.m))
  } else {
    check('the readiness tail is reachable without moving the close hint', await walk(board.m, 'OpenAI-compatible') && board.m.screen().includes(hint))
    save(board.m, s, 'readiness')
    const scroll = store.settingsPopupRequest()?.scrollRef?.current
    const beforeWheel = scroll?.getScrollTop() ?? 0
    await key(board.m, '\x1b[<64;15;7M')
    check('the shared wheel handler scrolls the popup, not the retained transcript', beforeWheel > 0 && (scroll?.getScrollTop() ?? beforeWheel) < beforeWheel)
  }
  await key(board.m, KEY.esc)
  const closed = await waitFor(() => !store.isSettingsPopupOpen(), 1000)
  check('menu esc closes the popup and reports no credential change', closed && receipts.at(-1)?.includes('no credential changed') === true, `open=${store.isSettingsPopupOpen()} receipt=${receipts.at(-1)}`)
  board.close()
  if (process.argv.includes('--menu-only')) { await releaseScratchHome(home); process.exit(failures ? 1 : 0) }
  for (const [family, arm] of Object.entries({ openai: '2', openrouter: '3', gemini: '1', huggingface: '2', moonshot: '2', zai: '1', xai: '2', meta: '' })) {
    board = await mount(s, family)
    await key(board.m, KEY.enter)
    save(board.m, s, `${family}-choice`)
    if (arm) check(`${family}: the short credential choice keeps its digit shortcuts`, board.m.screen().includes('❯ 1.'))
    if (compact && arm) check(`${family} compact: the choice screen keeps its title and single-line rows with at most one Gemini note`, rowsVisible(board.m, s) <= 1 + (family === 'openrouter' ? 3 : 2) + (family === 'gemini' ? 1 : 0) && bodyRows(board.m, s).every(line => stringWidth(line) <= geometryOf(s).inner), bodyRows(board.m, s).join(' | '))
    if (family === 'gemini') {
      const words = board.m.lines().map(line => line.split('│').slice(1, -1).join(' ')).join(' ').replace(/\s+/g, ' ')
      const note = compact ? "AI Pro/Ultra plans don't apply; OAuth needs your client." : "Google ended consumer Login with Google on June 18, 2026 (Gemini CLI too); AI Pro/Ultra plans don't apply. Sign-in needs your own OAuth client."
      check(`Gemini ${s.columns}x${s.rows}: the title, both choices and the per-screen note are on screen together`, words.includes('Connect Google Gemini') && words.includes('API key — the easiest') && words.includes('Google account — six steps') && words.includes(note), board.m.screen())
      if (compact) check('Gemini compact: exactly the title, one note and both single-line choices', rowsVisible(board.m, s) === 4 && bodyRows(board.m, s).filter(line => line.includes('OAuth needs your client.')).length === 1, bodyRows(board.m, s).join(' | '))
    }
    if (arm) await key(board.m, arm)
    await key(board.m, 'fixture-draft-with-caret-0123456789')
    check(`${family}: its key field remains visible inside the popup`, /Key:|key:|Token:/.test(board.m.screen()))
    if (compact) check(`${family} compact: the key card keeps its label with key page and esc back, input, and only Gemini adds a billing line`, rowsVisible(board.m, s) === (family === 'gemini' ? 3 : 2) && /esc back/.test(bodyRows(board.m, s)[0] ?? '') && /^(Key|Token): \*+/.test(bodyRows(board.m, s)[1] ?? ''), bodyRows(board.m, s).join(' | '))
    if (family === 'gemini') check(`Gemini key ${s.columns}x${s.rows}: billing, address, provider, input and back are visible without OAuth prose`, board.m.screen().includes('Cloud project: free Flash ~20/day, Pro 0; pay for more.') && board.m.screen().includes('aistudio.google.com/apikey') && board.m.screen().includes('Gemini') && board.m.screen().includes('esc back') && !/OAuth|consumer|Pro\/Ultra/.test(board.m.screen()), board.m.screen())
    fits(board.m, s, `${family} key`); save(board.m, s, `${family}-key`)
    board.close()
  }
  for (const [family, arm, code] of [['huggingface', '1', 'HF-CODE'], ['xai', '1', 'GROK-CODE'], ['openai', '1', 'or paste the redirected URL:'], ['openrouter', '1', 'or paste the redirected URL:'], ['openrouter', '2', 'paste the code:']]) {
    board = await mount(s, family)
    await key(board.m, KEY.enter); await key(board.m, arm!)
    check(`${family} ${arm}: its device/browser wait stays reachable`, await walk(board.m, code!))
    if (compact) {
      const body = bodyRows(board.m, s).filter(line => line !== '')
      const wait = family === 'huggingface' ? [/^HF-CODE · https:\/\/example\.com\/hf\/device$/, /^c copies the URL · ESC cancels\.$/] : family === 'xai' ? [/^GROK-CODE · https:\/\/example\.com\/grok\/device$/, /^c copies the URL · esc cancels$/] : [/^https:\/\/example\.com\/authorize\?state=fixture/, /^(or paste the redirected URL|paste the code):/, /^c copies the URL/]
      check(`${family} ${arm} compact: the wait is the code or URL line, the paste line and the way out, nothing else`, body.length === wait.length && wait.every((pattern, index) => pattern.test(body[index] ?? '')), body.join(' | '))
    }
    fits(board.m, s, `${family} wait`); save(board.m, s, `${family}-wait-${arm}`)
    const cancels = browserCancels
    board.close()
    if (family === 'xai') check('xai: popup unmount cancels the device driver', xaiCancelled?.() === true)
    else if (family !== 'huggingface') check(`${family}: popup unmount cancels the browser handles`, browserCancels === cancels + 1)
  }
  board = await mount(s, 'gemini')
  await key(board.m, KEY.enter); await key(board.m, '2')
  for (let step = 1; step <= 4; step++) {
    fits(board.m, s, `Gemini guide ${step}`); save(board.m, s, `gemini-guide-${step}`)
    await key(board.m, KEY.enter)
  }
  check('Gemini client setup keeps its focused field visible', board.m.screen().includes('Client id:'))
  save(board.m, s, 'gemini-client-id')
  await key(board.m, 'fixture.apps.googleusercontent.com'); await key(board.m, KEY.enter)
  check('Gemini optional secret fits beside its label', board.m.screen().includes('Client secret'))
  save(board.m, s, 'gemini-client-secret')
  await key(board.m, KEY.enter)
  check('Gemini browser callback stays reachable', await walk(board.m, 'or paste the redirected URL:'))
  save(board.m, s, 'gemini-browser')
  board.close()
  const geminiConfig = await import('../../src/services/providers/gemini/geminiAccounts.js')
  geminiConfig.writeGeminiOauthClientConfig(null)
  board = await mount(s, 'deepseek')
  await key(board.m, KEY.enter)
  await key(board.m, 'fixture-draft-0123456789'.repeat(5))
  fits(board.m, s, 'key'); save(board.m, s, 'key')
  check('the focused key field is on screen', board.m.screen().includes('Key:'))
  await key(board.m, KEY.enter)
  check('a long draft reaches the driver intact', submits.at(-1) === 'fixture-draft-0123456789'.repeat(5))
  check('a refused-key note remains reachable in the popup', await walk(board.m, 'correct it here.'))
  save(board.m, s, 'key-refused')
  const submitted = submits.length
  await key(board.m, '\x15'); await key(board.m, 'not a key'); await key(board.m, KEY.enter)
  check('the paste guard stays in the popup without reaching a driver', submits.length === submitted && await walk(board.m, 'whitespace).'))
  save(board.m, s, 'paste-guard')
  await key(board.m, KEY.esc)
  check('key esc returns to the family menu, not out of the popup', store.isSettingsPopupOpen() && await walk(board.m, compact ? 'OpenAI — ChatGPT' : 'Provider readiness', compact ? KEY.up : undefined))
  if (compact) check('compact: back on the menu the marker returns', markerOf(board.m) !== undefined && /of 12$/.test(markerOf(board.m) ?? ''), markerOf(board.m))
  board.close()
  board = await mount(s, 'moonshot')
  await key(board.m, KEY.enter); await key(board.m, KEY.enter); await key(board.m, KEY.enter)
  check('the device code is reachable', await walk(board.m, 'ABCD-EFGH'))
  fits(board.m, s, 'device'); save(board.m, s, 'device')
  if (compact) check('compact: the device wait is the code with its URL, then the way out', JSON.stringify(bodyRows(board.m, s).filter(line => line !== '')) === JSON.stringify(['ABCD-EFGH · https://example.com/kimi/device', 'c copies the URL · ESC cancels.']), bodyRows(board.m, s).join(' | '))
  check('the device URL and cancellation instructions remain reachable', await walk(board.m, 'ESC cancels.'))
  save(board.m, s, 'device-bottom')
  await key(board.m, KEY.esc)
  check('device cancellation settles and disposes the driver', !store.isSettingsPopupOpen() && deviceCancelled?.() === true)
  board.close()
  seed = 'waiting'
  board = await mount(s)
  fits(board.m, s, 'browser'); save(board.m, s, 'browser')
  if (compact) check('compact: the Anthropic browser wait is the URL, the paste line and the way out', bodyRows(board.m, s).filter(line => line !== '').length === 3 && /^https:\/\/example\.com\/oauth/.test(bodyRows(board.m, s)[0] ?? '') && bodyRows(board.m, s)[2] === 'c copies the URL · esc cancels', bodyRows(board.m, s).join(' | '))
  await key(board.m, 'abc')
  check('browser paste stays visible', board.m.screen().includes('Paste code here if prompted >'))
  await key(board.m, KEY.enter)
  check('browser paste is submitted intact', submits.at(-1) === 'abc')
  check('the signed-in receipt stays inside the popup', store.isSettingsPopupOpen() && await walk(board.m, 'press Enter to continue'))
  fits(board.m, s, 'receipt'); save(board.m, s, 'receipt')
  await key(board.m, KEY.esc)
  check('receipt esc completes the popup', !store.isSettingsPopupOpen())
  board.close()
  seed = 'idle'
  successKey = true
  board = await mount(s, 'deepseek')
  await key(board.m, KEY.enter); await key(board.m, 'fixture-key'); await key(board.m, KEY.enter)
  check('a successful engine receipt waits for confirmation inside the popup', store.isSettingsPopupOpen() && await walk(board.m, 'press Enter to continue'))
  fits(board.m, s, 'engine receipt'); save(board.m, s, 'engine-receipt')
  await key(board.m, KEY.enter)
  check('confirming the engine receipt settles the command once', !store.isSettingsPopupOpen() && receipts.at(-1) === 'DeepSeek connected — fixture receipt.')
  board.close(); successKey = false
  for (estate of ['full', 'mixed']) {
    board = await mount(s)
    save(board.m, s, `${estate}-menu`)
    if (compact) {
      check(`${estate} compact: a signed-in family row carries its identity chip inline`, await walk(board.m, 'Claude subscription account · anthropic@example.com', KEY.down))
      fits(board.m, s, `${estate} estate`)
    } else {
      check(`${estate} readiness reaches the credentialed family rows`, await walk(board.m, 'ready · oauth'))
      save(board.m, s, `${estate}-readiness-top`)
      check(`${estate} readiness reaches every family`, await walk(board.m, 'OpenAI-compatible'))
      fits(board.m, s, `${estate} estate`); save(board.m, s, `${estate}-readiness-bottom`)
    }
    board.close()
    for (const family of ['openai', 'claudeai', 'console', 'openrouter', 'gemini', 'huggingface', 'moonshot', 'zai', 'deepseek', 'xai', 'meta']) {
      const id = family === 'claudeai' || family === 'console' ? 'anthropic' : family
      if (estate === 'mixed' && ids.indexOf(id) % 2 !== 0) continue
      board = await mount(s, family)
      await key(board.m, KEY.enter)
      check(`${estate} ${family}: the account actions stay inside the popup`, await walk(board.m, 'Sign in / re-login'))
      check(`${estate} ${family}: the account actions keep their digit shortcuts`, /1\.\s+Sign in \/ re-login/.test(board.m.screen()))
      save(board.m, s, `${estate}-${family}-actions`)
      for (let i = 0; i < 35; i++) { const before = board.m.screen(); await key(board.m, '\x1b[5~'); if (before === board.m.screen()) break }
      check(`${estate} ${family}: the boot owner's account identity is reachable`, await walk(board.m, `${id}@example.com`))
      if (compact) check(`${estate} ${family} compact: the account card is its identity line then the actions`, (bodyRows(board.m, s)[0] ?? '').includes(`${id}@example.com`) && (bodyRows(board.m, s)[1] ?? '').includes('Sign in / re-login'), bodyRows(board.m, s).join(' | '))
      fits(board.m, s, `${estate} ${family}`); save(board.m, s, `${estate}-${family}-identity`)
      await key(board.m, KEY.esc)
      check('account esc returns to the roster without signing out', store.isSettingsPopupOpen() && removedCalls.length === 0)
      board.close()
    }
  }
}
estate = 'absent'; seed = 'idle'
const resizable = await mount(allSizes[3]!, 'deepseek')
await key(resizable.m, KEY.enter); await key(resizable.m, 'draft-kept-')
for (const s of [...allSizes].reverse()) { await resizable.resize(s); fits(resizable.m, s, 'resize key'); check('resize keeps the input in view', resizable.m.screen().includes('Key:')) }
const oneRow = { columns: 64, rows: 12, bottom: 6 }
await resizable.resize(oneRow)
fits(resizable.m, oneRow, 'one-row host')
check('a four-row popup is compact with one body row: the key input and the folded header stay', geometryOf(oneRow).rows === 4 && geometryOf(oneRow).compact && resizable.m.screen().includes('Key:') && resizable.m.lines().some(line => line.includes(compactHint)) && !resizable.m.screen().includes('Window too small'), resizable.m.screen())
save(resizable.m, allSizes[0]!, 'one-row-host')
await resizable.resize({ columns: 64, rows: 12, bottom: 7 })
check('below the compact floor the popup warns and keeps escape visible', resizable.m.screen().includes('wants at least 4 rows') && resizable.m.screen().includes(hint), resizable.m.screen())
save(resizable.m, allSizes[0]!, 'tiny-host')
await resizable.resize(allSizes[3]!)
await key(resizable.m, 'after-resize'); await key(resizable.m, KEY.enter)
check('resize preserves the same mounted draft', submits.at(-1) === 'draft-kept-after-resize')
resizable.close()
const device = await mount(allSizes[3]!, 'moonshot')
await key(device.m, KEY.enter); await key(device.m, KEY.enter); await key(device.m, KEY.enter)
const started = deviceStarts
for (const s of [...allSizes].reverse()) { await device.resize(s); fits(device.m, s, 'resize device'); check('resize keeps the device code reachable', await walk(device.m, 'ABCD-EFGH')) }
check('resize never restarts the device driver', deviceStarts === started)
device.close()
const short = { columns: 80, rows: 14, bottom: 4 }
const tiny = await mount(short)
fits(tiny.m, short, 'short host')
check('a shorter host is compact and its arrows reach the last family row with the marker at 12 of 12', isCompact(short) && await walk(tiny.m, 'OpenCode Zen — API key', KEY.down) && markerOf(tiny.m) === '12 of 12', markerOf(tiny.m))
save(tiny.m, short, 'short-host')
tiny.close()
for (const phase of ['menu', 'key', 'device', 'browser', 'receipt', 'account']) {
  seed = phase === 'browser' ? 'waiting' : phase === 'receipt' ? 'success' : 'idle'
  estate = phase === 'account' ? 'full' : 'absent'
  const board = await mount(allSizes[3]!, phase === 'device' ? 'moonshot' : 'deepseek')
  if (phase === 'key' || phase === 'account') await key(board.m, KEY.enter)
  if (phase === 'device') { await key(board.m, KEY.enter); await key(board.m, KEY.enter); await key(board.m, KEY.enter) }
  await key(board.m, '\x1b[<0;2;2M')
  check(`${phase}: a real outside mouse press closes in one step`, !store.isSettingsPopupOpen())
  board.close()
}
seed = 'idle'; estate = 'full'
const removal = await mount(allSizes[2]!, 'deepseek')
await key(removal.m, KEY.enter); await key(removal.m, KEY.down); await key(removal.m, KEY.enter)
check('removing a stored key first asks for confirmation, without touching an owner', removedCalls.length === 0 && await walk(removal.m, 'Confirm again to remove'))
save(removal.m, allSizes[2]!, 'remove-confirmation')
await key(removal.m, KEY.enter)
check('the second confirmation routes through the existing removal owner once', removedCalls.join() === 'deepseek:fixture' && store.isSettingsPopupOpen())
check('the removal receipt stays inside the popup', await walk(removal.m, 'cleared from the auth-scoped store'))
save(removal.m, allSizes[2]!, 'remove-receipt')
await key(removal.m, '\x1b[<0;2;2M')
check('closing after removal never says no credential changed', !store.isSettingsPopupOpen() && !receipts.at(-1)?.includes('no credential changed'))
removal.close()
const switching = await mount(allSizes[2]!, 'openai')
await key(switching.m, KEY.enter); await key(switching.m, KEY.down); await key(switching.m, KEY.enter)
check('switching calls the existing active-slot owner and leaves the popup up', switches === 1 && store.isSettingsPopupOpen())
await key(switching.m, 's')
check('the boot detail line advertises a live s switch gesture', switches === 2 && store.isSettingsPopupOpen())
save(switching.m, allSizes[2]!, 'switch-receipt')
switching.close()
await releaseScratchHome(home)
console.log(`prove-logins-popup: ${failures} failure(s)`)
process.exit(failures ? 1 : 0)
