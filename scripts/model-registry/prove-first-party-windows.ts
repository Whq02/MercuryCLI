#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinSourceRef, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

pinSourceRef()
const HOME = mkdtempSync(join(tmpdir(), 'first-party-windows-'))
const PROJECT = join(HOME, 'project')
mkdirSync(PROJECT, { recursive: true })
process.chdir(PROJECT)
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = HOME
delete process.env.NODE_ENV
for (const key of ['MERCURY_MODEL', 'MERCURY_EFFORT_LEVEL', 'MERCURY_DEFAULT_FABLE_MODEL', 'MERCURY_DEFAULT_OPUS_MODEL', 'MERCURY_DEFAULT_SONNET_MODEL', 'MERCURY_DEFAULT_HAIKU_MODEL', 'MERCURY_DISABLE_1M_CONTEXT', 'MERCURY_PROVIDER_BETAS', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'HF_TOKEN', 'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY', 'XAI_API_KEY']) delete process.env[key]
Object.assign(process.env, {
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_EVOLUTION_LEDGER: '0',
  MERCURY_FULLSCREEN: '1',
  MERCURY_HELM_HOME: '1',
  MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  MERCURY_BOOT_PREFLIGHT: '0',
  MERCURY_REDUCED_MOTION: '1',
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
  ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key',
  BROWSER: '/usr/bin/true',
})

let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 900)}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}
const arg = (key: string): string | undefined => (process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : undefined)
const frameDir = arg('--frames')
if (frameDir) mkdirSync(frameDir, { recursive: true })

const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/utils/config.ts')
enableConfigs()
saveCurrentProjectConfig(c => ({ ...c, hasCompletedProjectOnboarding: true }))
saveGlobalConfig(c => ({ ...c, prStatusFooterEnabled: false }))
const caps = await import('../../src/utils/model/capabilities.ts')
const { focusedOptionSupports1m } = await import('../../src/utils/model/modelOptions.ts')
const { getAutoCompactThreshold } = await import('../../src/services/compact/autoCompact.ts')
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
const { recordSignIn } = await import('../../src/utils/accounts/signInLedger.ts')
recordSignIn('anthropic', 'api-key')

const HEADER = 'context-1m-2025-08-07'
const MILLION = 1_000_000
const window = (id: string): string => {
  const r = caps.resolveContextWindow(id)
  return `${r.effectiveWindow}/${r.source}`
}

section("§1 the vendor's table: which first-party ids read 1M with no suffix (platform.claude.com/docs/en/build-with-claude/context-windows and the vendor client's own model rows, read 10 Nov 2026)")
{
  const NATIVE = ['claude-fable-5', 'claude-mythos-5', 'claude-opus-4-8', 'claude-opus-4-7']
  for (const id of NATIVE) {
    check(`${id} reads 1M from the first-party pin with no suffix`, window(id) === `${MILLION}/static-pin`, window(id))
  }
  check('a dated snapshot and a case-changed spelling of Fable 5 read the same row', window('claude-fable-5-20260115') === `${MILLION}/static-pin` && window('Claude-Fable-5') === `${MILLION}/static-pin`, `${window('claude-fable-5-20260115')} · ${window('Claude-Fable-5')}`)
  check('a dated snapshot of Opus 4.8 and a case-changed spelling of Opus 4.7 read their own rows, not the Opus 4.6 row whose capabilities they share', window('claude-opus-4-8-20260115') === `${MILLION}/static-pin` && window('Claude-Opus-4-7') === `${MILLION}/static-pin`, `${window('claude-opus-4-8-20260115')} · ${window('Claude-Opus-4-7')}`)
  const ALREADY = ['claude-fable-5-2', 'claude-fable-5-1', 'claude-mythos-5-2', 'claude-mythos-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-haiku-5-5']
  check('the rows that already read 1M keep it', ALREADY.every(id => window(id) === `${MILLION}/static-pin`), ALREADY.map(id => `${id}=${window(id)}`).join(' '))
  const SWITCHED = ['claude-opus-4-6', 'claude-sonnet-4-6']
  check('Opus 4.6 and Sonnet 4.6 keep their two positions: 200k as the id stands, 1M with [1m]', SWITCHED.every(id => caps.getContextWindowForModel(id) === 200_000 && window(`${id}[1m]`) === `${MILLION}/suffix-1m` && caps.modelSupports1M(id)), SWITCHED.map(id => `${id}=${window(id)} ${id}[1m]=${window(`${id}[1m]`)}`).join(' '))
  const KEPT = ['claude-sonnet-4-5[1m]', 'claude-sonnet-4[1m]']
  check('with an API key Sonnet 4.5 and Sonnet 4 keep the [1m] position the vendor\'s client gives them under its 1M header (a subscription sends none and reads the base id: prove-context-1m-header §2)', KEPT.every(id => window(id) === `${MILLION}/suffix-1m`), KEPT.map(id => `${id}=${window(id)}`).join(' '))
  const NO_POSITION = ['claude-opus-4-5[1m]', 'claude-opus-4-1[1m]', 'claude-opus-4[1m]', 'claude-haiku-4-5[1m]', 'claude-3-7-sonnet[1m]']
  const ignored = NO_POSITION.map(id => caps.resolveContextWindow(id))
  check('[1m] on a first-party id with no 1M position resolves as the base id: 200,000, and the resolution says the suffix was ignored', ignored.every(r => r.effectiveWindow === 200_000 && r.source !== 'suffix-1m' && r.activation.kind === 'unavailable' && r.fallbackReason === 'unverified [1m] suffix ignored; resolved as the base id'), ignored.map(r => `${r.model}=${r.effectiveWindow}/${r.source}/${r.fallbackReason ?? ''}`).join(' '))
  const OTHERS = ['glm-5.3[1m]', 'kimi-k3[1m]', 'deepseek-v4-pro[1m]', 'an-unlisted-model[1m]']
  check('another family\'s id and an unlisted id take no window from the suffix: each resolves as its base id', OTHERS.every(id => caps.resolveContextWindow(id).source !== 'suffix-1m' && caps.getContextWindowForModel(id) === caps.getContextWindowForModel(id.replace('[1m]', ''))), OTHERS.map(id => `${id}=${window(id)} base=${window(id.replace('[1m]', ''))}`).join(' '))
  const SMALL = ['claude-sonnet-4-5', 'claude-opus-4-5', 'claude-haiku-4-5']
  check('the 200k rows stay 200k', SMALL.every(id => caps.getContextWindowForModel(id) === 200_000), SMALL.map(id => `${id}=${window(id)}`).join(' '))
  check('a carrier-shaped spelling of Fable 5 or Opus 4.8 never takes the first-party pin', caps.resolveContextWindow('openrouter/anthropic/claude-fable-5').source !== 'static-pin' && caps.resolveContextWindow('openrouter/anthropic/claude-opus-4-8').source !== 'static-pin', `${window('openrouter/anthropic/claude-fable-5')} · ${window('openrouter/anthropic/claude-opus-4-8')}`)
  process.env.MERCURY_DISABLE_1M_CONTEXT = '1'
  const clamped = caps.resolveContextWindow('claude-fable-5')
  delete process.env.MERCURY_DISABLE_1M_CONTEXT
  check('MERCURY_DISABLE_1M_CONTEXT clamps the row to 200k and says why', clamped.effectiveWindow === 200_000 && clamped.fallbackReason === 'clamped by the 1M kill-switch', JSON.stringify(clamped))
}

section('§2 what a session on one of these rows does with it: the fold point and the request')
{
  const plain = getAutoCompactThreshold('claude-fable-5')
  const suffixed = getAutoCompactThreshold('claude-fable-5[1m]')
  console.log(`  [record] auto-compact threshold: claude-fable-5 ${plain} · claude-fable-5[1m] ${suffixed} · claude-fable-5-1 ${getAutoCompactThreshold('claude-fable-5-1')} · claude-opus-4-6 ${getAutoCompactThreshold('claude-opus-4-6')}`)
  check('a session on Fable 5 folds where its [1m] spelling folds, far past 200k', plain === suffixed && plain > 900_000, `${plain} against ${suffixed}`)
  check('a session on Mythos 5 folds at the same point', getAutoCompactThreshold('claude-mythos-5') === plain, String(getAutoCompactThreshold('claude-mythos-5')))

  const betas = caps.getAllModelBetas('claude-fable-5')
  check('a request on the id as it stands names no 1M header: the window is the model\'s own', !betas.includes(HEADER), JSON.stringify(betas))
  const opus = ['claude-opus-4-8', 'claude-opus-4-7'].map(id => `${id} ${getAutoCompactThreshold(id)} ${getAutoCompactThreshold(`${id}[1m]`)} ${caps.getAllModelBetas(id).includes(HEADER)}`)
  console.log(`  [record] auto-compact threshold, the id as it stands and its [1m] spelling, and whether the plain id's request names the header: ${opus.join(' · ')}`)
  check('a session on Opus 4.8 or Opus 4.7 folds where its [1m] spelling folds, and its request names no 1M header', opus.every(row => /^\S+ (\d+) \1 false$/.test(row) && Number(row.split(' ')[1]) > 900_000), opus.join(' · '))
  check('Opus 4.6 and Sonnet 4.6 still fold at their 200k position as the id stands', getAutoCompactThreshold('claude-opus-4-6') < 200_000 && getAutoCompactThreshold('claude-sonnet-4-6') < 200_000, `${getAutoCompactThreshold('claude-opus-4-6')} · ${getAutoCompactThreshold('claude-sonnet-4-6')}`)
}

const React = await import('react')
const h = React.createElement
const { Box, Text } = await import('../../src/ink.ts')
const { App } = await import('../../src/components/App.tsx')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.tsx')
const { FullscreenLayout } = await import('../../src/components/FullscreenLayout.tsx')
const { default: PromptInput } = await import('../../src/components/PromptInput/PromptInput.tsx')
const { resetChromeModeLatchForTests } = await import('../../src/hooks/useLayoutTier.ts')
const { initializeSurfaceRoute, ROOT_CHAT_ROUTE } = await import('../../src/context/surfaceRoute.ts')
const { resetOverlayStackForTests } = await import('../../src/context/overlayStack.ts')
const settingsStore = await import('../../src/utils/cockpit/settingsPopup.ts')
const modelCommand = await import('../../src/commands/model/mercuryModel.tsx')
const { noSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.ts')
const { setFocusedSessionConnector, _resetFocusedSessionConnectorForTesting } = await import('../../src/services/engine-connector/focusedConnector.ts')

const TITLE = 'Mercury · model'
const CTRL_W = '\x17'
const SEATED = 'claude-opus-5-5'
const settingsPath = join(HOME, 'settings.json')

type Scene = { m: Mounted; done: unknown[][]; seats: unknown[] }
function session(): unknown[] {
  const seats: unknown[] = []
  const facts = { main: SEATED, effective: SEATED, setting: SEATED, effectiveSource: 'live', sessionPin: null, effort: 'medium', effortSent: 'medium', pendingSwitch: null }
  const records: unknown[] = []
  _resetFocusedSessionConnectorForTesting()
  const overrides: Record<string, unknown> = {
    carrier: 'daemon',
    sessionId: () => 'first-party-windows-proof',
    modelFacts: () => facts,
    records: () => records,
    setModel: async (setting: unknown) => {
      seats.push(setting)
      return { state: 'applied' }
    },
    sendWords: async () => ({ state: 'sent' }),
    addDisplayRow: () => {},
  }
  setFocusedSessionConnector(new Proxy(noSessionConnector(), {
    get(target, key) {
      if (typeof key === 'string' && key in overrides) return overrides[key]
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as never)
  return seats
}
function Harness({ element }: { element: React.ReactNode }): React.ReactNode {
  const [vimMode, setVimMode] = React.useState<'INSERT' | 'NORMAL'>('INSERT')
  const [searching, setSearching] = React.useState(false)
  const [help, setHelp] = React.useState(false)
  const [bashes, setBashes] = React.useState<string | boolean>(false)
  const insertRef = React.useRef<unknown>(null)
  const modalScrollRef = React.useRef(null)
  return h(FullscreenLayout, {
    scrollable: h(Box, { flexDirection: 'column' }, h(Text, null, 'transcript')),
    statusBand: h(Text, null, 'activity specimen'),
    statusBandActive: false,
    modal: h(Box, { width: '100%', flexDirection: 'column' }, element),
    modalScrollRef,
    bottom: h(PromptInput, {
      debug: false, toolPermissionContext: getDefaultAppState().toolPermissionContext,
      setToolPermissionContext: () => {}, apiKeyStatus: 'valid', commands: [], agents: [], isLoading: false,
      verbose: false, submitCount: 0, onShowMessageSelector: () => {}, mcpClients: [], vimMode, setVimMode,
      showBashesDialog: bashes, setShowBashesDialog: setBashes, onExit: () => {}, getToolUseContext: () => ({}),
      onSubmit: async () => {}, isSearchingHistory: searching, setIsSearchingHistory: setSearching,
      helpOpen: help, setHelpOpen: setHelp, hasSuppressedDialogs: false, isLocalJSXCommandActive: true,
      insertTextRef: insertRef,
    } as never),
  } as never)
}
async function openPicker(): Promise<Scene> {
  initializeSurfaceRoute(ROOT_CHAT_ROUTE)
  resetChromeModeLatchForTests()
  const done: unknown[][] = []
  const seats = session()
  const element = await modelCommand.call((...call: unknown[]) => { done.push(call) }, { messages: [], options: {} } as never, '')
  const state = { ...(getDefaultAppState() as unknown as Record<string, unknown>), engineModel: SEATED, engineModelForSession: null }
  const m = await mountOffscreen(h(App, { initialState: state, getFpsMetrics: () => undefined } as never, h(KeybindingSetup, null, h(Harness, { element }))), 120, 40)
  await waitFor(() => m.screen().includes(TITLE) && m.screen().includes('↑↓ select'), 10000)
  await settle(400)
  return { m, done, seats }
}
async function closeScene(scene: Scene): Promise<void> {
  settingsStore.closeSettingsPopup()
  await settle(60)
  scene.m.unmount()
  resetOverlayStackForTests()
}
const cells = (line: string): string => line.replace(/^.*?│ │ │ /, '').replace(/ │ │ │.*$/, '').replace(/\s+/g, ' ').trim()
const focused = (m: Mounted): string => m.lines().find(l => /│ │ │ .* │ │ │/.test(l)) ?? ''
const noticeOf = (m: Mounted): string => (m.lines().find(l => /ctx · no alternate window|not a toggle/.test(l)) ?? '').replace(/[│]/g, ' ').replace(/\s+/g, ' ').trim()
async function focusRow(scene: Scene, id: string): Promise<boolean> {
  for (const key of [KEY.up, KEY.down]) {
    for (let step = 0; step < 40; step++) {
      if (cells(focused(scene.m)).includes(` ${id} `)) return true
      scene.m.push(key)
      await settle(70)
    }
  }
  return cells(focused(scene.m)).includes(` ${id} `)
}
const frame = (name: string, m: Mounted): void => {
  if (frameDir) writeFileSync(join(frameDir, `${name}-120x40.txt`), `${m.lines().join('\n')}\n`)
}
async function pick(id: string, flips: number): Promise<{ rest: string; flipped: string; notice: string; seated: unknown; said: string }> {
  const scene = await openPicker()
  const found = await focusRow(scene, id)
  const rest = found ? cells(focused(scene.m)) : `row ${id} never took the focus`
  const restLine = focused(scene.m)
  frame(`${id}-rest`, scene.m)
  let flipped = rest
  let notice = ''
  for (let n = 0; n < flips; n++) {
    scene.m.push(CTRL_W)
    await waitFor(() => focused(scene.m) !== restLine || noticeOf(scene.m) !== '', 3000)
    await settle(120)
    flipped = cells(focused(scene.m))
    notice = noticeOf(scene.m)
    frame(`${id}-ctrl-w-${n + 1}`, scene.m)
  }
  scene.m.push(KEY.enter)
  await waitFor(() => scene.seats.length > 0 || scene.done.length > 0, 8000)
  await settle(150)
  const said = String(scene.done[0]?.[0] ?? '')
  const seated = scene.seats.length === 1 ? scene.seats[0] : scene.seats
  await closeScene(scene)
  _resetFocusedSessionConnectorForTesting()
  writeFileSync(settingsPath, JSON.stringify({}))
  resetSettingsCache()
  return { rest, flipped, notice, seated, said }
}

section('§3 the picker at 120x40: the Fable 5, Opus 4.8 and Opus 4.7 rows have one window and no switch; the Opus 4.6 and Sonnet 4.6 rows keep their switch, its default and what each position seats')
{
  const fable = await pick('claude-fable-5', 1)
  console.log(`  [record] Fable 5: rest "${fable.rest}" · after ctrl+w "${fable.flipped}" · notice "${fable.notice}" · seated ${JSON.stringify(fable.seated)} · said "${fable.said}"`)
  check('the Fable 5 row reads 1M ctx at rest', fable.rest === 'Fable 5 claude-fable-5 1M ctx', fable.rest)
  check('ctrl+w on it answers that the row has no other window, and the row does not move', fable.flipped === fable.rest && fable.notice.includes('1M ctx · no alternate window'), `${fable.flipped} · ${fable.notice}`)
  const atRest = await pick('claude-fable-5', 0)
  check('enter on the row seats the id as it stands, at rest and after the chord: no [1m] spelling is made for it', atRest.seated === 'claude-fable-5' && fable.seated === 'claude-fable-5', `at rest ${JSON.stringify(atRest.seated)} · after ctrl+w ${JSON.stringify(fable.seated)} · ${atRest.said}`)
  const offered = ['claude-fable-5-2', 'claude-fable-5-1', 'claude-fable-5', 'claude-mythos-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5', 'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-haiku-5-5', 'claude-haiku-4-5'].filter(id => focusedOptionSupports1m(id))
  check('the switch is offered on Opus 4.6 and Sonnet 4.6 alone', JSON.stringify(offered) === JSON.stringify(['claude-opus-4-6', 'claude-sonnet-4-6']), JSON.stringify(offered))
  for (const [id, name] of [['claude-opus-4-8', 'Opus 4.8'], ['claude-opus-4-7', 'Opus 4.7']] as const) {
    const chord = await pick(id, 1)
    const rest = await pick(id, 0)
    console.log(`  [record] ${name}: rest "${rest.rest}" seats ${JSON.stringify(rest.seated)} · after ctrl+w "${chord.flipped}" · notice "${chord.notice}" seats ${JSON.stringify(chord.seated)}`)
    check(`${name}: the row reads 1M ctx, ctrl+w answers that it has no other window and the row does not move`, rest.rest === `${name} ${id} 1M ctx` && chord.flipped === rest.rest && chord.notice.includes('1M ctx · no alternate window'), `${rest.rest} · ${chord.flipped} · ${chord.notice}`)
    check(`${name}: enter seats ${id} as it stands, at rest and after the chord`, rest.seated === id && chord.seated === id, `at rest ${JSON.stringify(rest.seated)} · after ctrl+w ${JSON.stringify(chord.seated)}`)
  }
  for (const [id, name] of [['claude-opus-4-6', 'Opus 4.6'], ['claude-sonnet-4-6', 'Sonnet 4.6']] as const) {
    const on = await pick(id, 0)
    const off = await pick(id, 1)
    const back = await pick(id, 2)
    console.log(`  [record] ${name}: rest "${on.rest}" seats ${JSON.stringify(on.seated)} · one ctrl+w "${off.flipped}" seats ${JSON.stringify(off.seated)} · two "${back.flipped}" seats ${JSON.stringify(back.seated)}`)
    check(`${name}: the row opens on its 1M position and enter seats ${id}[1m]`, on.rest === `${name} ${id} 1M ctx` && on.seated === `${id}[1m]`, `${on.rest} · ${JSON.stringify(on.seated)} · ${on.said}`)
    check(`${name}: ctrl+w switches the row to 200k and enter seats ${id}`, off.flipped === `${name} ${id} 200k ctx` && off.seated === id, `${off.flipped} · ${JSON.stringify(off.seated)} · ${off.said}`)
    check(`${name}: a second ctrl+w switches it back to 1M`, back.flipped === `${name} ${id} 1M ctx` && back.seated === `${id}[1m]`, `${back.flipped} · ${JSON.stringify(back.seated)}`)
  }
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} — ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
