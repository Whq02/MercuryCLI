#!/usr/bin/env bun
import { mock } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, waitFor } from '../lib/settingsPopupHarness.ts'
import { registerGeneratedAsset, registerOnlyRequested } from '../lib/generated-assets-map.mjs'

const ROOT = join(import.meta.dir, '../..')
const ASSET = {
  assets: 'scripts/ui/fixtures/settings-popup-header/*.txt',
  generator: 'bun scripts/ui/prove-settings-popup-header.ts --write',
  check: 'bun scripts/ui/prove-settings-popup-header.ts',
  sources: 'scripts/ui/prove-settings-popup-header.ts scripts/cockpit-interaction/status-popup-fixture.ts src/components/SettingsPopupSlot.tsx src/components/PopupGutter.tsx src/components/FullscreenLayout.tsx src/components/Settings/** src/components/ConsoleOAuthFlow.tsx src/components/mercury-ui/screens/SettingsStatusView.tsx src/commands/config/config.tsx src/commands/status/mercuryStatus.tsx src/commands/login/login.tsx src/commands/usage/usage.tsx',
}
if (registerOnlyRequested(ASSET)) process.exit(0)
pinSourceRef()
const HOME = pinScratchHome('settings-popup-header')
mkdirSync(join(HOME, 'orchard'), { recursive: true })
process.chdir(join(HOME, 'orchard'))
Object.assign(process.env, {
  MERCURY_FULLSCREEN: '1', MERCURY_HELM_HOME: '1', MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  MERCURY_BOOT_PREFLIGHT: '0', MERCURY_REDUCED_MOTION: '1', MERCURY_LOCAL_PROBE_TARGETS: 'none',
  ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', BROWSER: '/usr/bin/true',
})
const fetches: string[] = []
globalThis.fetch = (async (input: RequestInfo | URL) => {
  fetches.push(String(input))
  throw new Error('this source-render fixture has no network')
}) as typeof fetch
const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
const frames = arg('--frames')
const stills = join(import.meta.dir, 'fixtures', 'settings-popup-header')
const write = process.argv.includes('--write')
if (frames) mkdirSync(frames, { recursive: true })
if (write) mkdirSync(stills, { recursive: true })
let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`)
}
const React = await import('react')
const h = React.createElement
const viewed = await import('../../src/components/tasks/useCrewmateView.ts')
mock.module('../../src/components/tasks/useCrewmateView.ts', () => ({
  ...viewed,
  useViewedCrewmate: () => ({ taskId: 'fixture-view', name: 'cedar', facts: { description: 'popup review' }, local: undefined, pinned: false, running: 0 }),
}))
const capacity = await import('../../src/services/switchboard/capacityCheck.ts')
const seatFacts: import('../../src/services/switchboard/capacityCheck.ts').SeatCeilingFacts = { seats: 17, source: 'machine', sentence: '17 seats', lever: capacity.SEAT_DOORS, reading: 17, readingSentence: 'fixture reading: 17 seats', sample: null, consented: null }
mock.module('../../src/services/switchboard/capacityCheck.ts', () => ({ ...capacity, seatCeilingFacts: () => seatFacts, seatCeilingFactsAsync: async () => seatFacts }))
const { Box, Text, measureElement } = await import('../../src/ink.ts')
const { App } = await import('../../src/components/App.tsx')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.tsx')
const { FullscreenLayout } = await import('../../src/components/FullscreenLayout.tsx')
const { default: PromptInput } = await import('../../src/components/PromptInput/PromptInput.tsx')
const { resetChromeModeLatchForTests } = await import('../../src/hooks/useLayoutTier.ts')
const { initializeSurfaceRoute, ROOT_CHAT_ROUTE } = await import('../../src/context/surfaceRoute.ts')
const { resetOverlayStackForTests } = await import('../../src/context/overlayStack.ts')
const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/utils/config.ts')
const { railPlanAt } = await import('../../src/utils/helmGeometry.ts')
const { settingsPopupGeometry, settingsPopupHost } = await import('../../src/components/SettingsPopupSlot.tsx')
const store = await import('../../src/utils/cockpit/settingsPopup.ts')
const config = await import('../../src/commands/config/config.tsx')
const usage = await import('../../src/commands/usage/usage.tsx')
const logins = await import('../../src/commands/login/login.tsx')
const { SettingsStatusView } = await import('../../src/components/mercury-ui/screens/SettingsStatusView.tsx')
const { fixtureReads, buildFacts, model } = await import('../cockpit-interaction/status-popup-fixture.ts')
delete process.env.NODE_ENV
process.env.FORCE_COLOR = '3'
enableConfigs()
saveCurrentProjectConfig(c => ({ ...c, hasCompletedProjectOnboarding: true }))
saveGlobalConfig(c => ({ ...c, prStatusFooterEnabled: false }))
const facts = buildFacts([], model, {
  ...fixtureReads,
  artifact: () => ({ ...fixtureReads.artifact!(), version: '1.0.0', buildTree: '12345678' }),
  families: () => [
    ...fixtureReads.families!().map(family => {
      const labels: Record<string, string> = {
        moonshot: 'Kimi account (device-code sign-in · Global — kimi.ai)',
        zai: 'GLM Coding Plan key (stored, auth-scoped)',
        'openai-compat': 'Custom endpoint (http://127.0.0.1:8080/v1) · API key (stored, auth-scoped)',
        local: 'Ollama 0.11.4 (2 models) · localhost:11434 · LM Studio localhost:1234',
      }
      return labels[family.id] ? { ...family, credentialed: true, credentialLabel: labels[family.id] } : family
    }),
    ...[['xai', 'xAI'], ['meta', 'Meta']].map(([id, name]) => ({ id, available: true, credentialed: true, credentialLabel: `${name} API key (stored, auth-scoped)` })),
  ] as ReturnType<NonNullable<typeof fixtureReads.families>>,
  accountUsage: id => ({
    ...fixtureReads.accountUsage!(id),
    ...(id === 'moonshot' || id === 'zai' ? { windows: [
      { key: '5h', label: 'Window (5h)', state: 'live', usedPct: id === 'moonshot' ? 25 : 17, observedAtMs: Date.now(), provider: id, source: 'fixture' },
      { key: '7d', label: 'Current week (7d)', state: 'live', usedPct: id === 'moonshot' ? 41 : 3, observedAtMs: Date.now(), provider: id, source: 'fixture' },
    ] } : {}),
    ...(id === 'xai' ? { readerNote: 'credits: USD 18.00 available · voucher USD 3.00 · cash USD 15.00 · month spend USD 2.00 (management API)' } : {}),
    ...(id === 'deepseek' ? { readerNote: 'credits: USD 12.00 available · granted USD 2.00 · topped-up USD 10.00 (balance read)' } : {}),
    ...(id === 'openrouter' ? { readerNote: 'credits: USD 24.00 remaining · USD 6.00 used of USD 30.00 limit (key usage read)' } : {}),
    ...(id === 'meta' ? { readerNote: 'credits: not reported by the provider; usage is not read from this key' } : {}),
  }) as ReturnType<NonNullable<typeof fixtureReads.accountUsage>>,
}).facts
const context = { messages: [], options: {}, getAppState: getDefaultAppState } as never
const status = (): void => store.openSettingsPopup({
  view: 'status', width: 110, rows: null,
  line: 'session snapshot · 12:00 · orchard · main',
  hint: 'esc or click outside closes · /accounts · /usage · /health',
  body: g => h(SettingsStatusView, { facts, onClose: store.closeSettingsPopup, width: g.inner, rowBudget: g.rowBudget }),
})
function Harness({ columns }: { columns: number }): React.ReactNode {
  const [vimMode, setVimMode] = React.useState<'INSERT' | 'NORMAL'>('INSERT')
  const [searching, setSearching] = React.useState(false)
  const [help, setHelp] = React.useState(false)
  const [bashes, setBashes] = React.useState<string | boolean>(false)
  const insertTextRef = React.useRef(null)
  return h(FullscreenLayout, {
    scrollable: h(Box, { flexDirection: 'column' }, ...Array.from({ length: 80 }, (_, key) => h(Text, { key, wrap: 'truncate-end' }, `transcript row ${String(key + 1).padStart(2, '0')} ${'· '.repeat(columns)}`))),
    bottom: h(PromptInput, {
      debug: false, toolPermissionContext: getDefaultAppState().toolPermissionContext,
      setToolPermissionContext: () => {}, apiKeyStatus: 'valid', commands: [], agents: [], isLoading: false,
      verbose: false, submitCount: 0, onShowMessageSelector: () => {}, mcpClients: [], vimMode, setVimMode,
      showBashesDialog: bashes, setShowBashesDialog: setBashes, onExit: () => {}, getToolUseContext: () => ({}),
      onSubmit: async () => {}, isSearchingHistory: searching, setIsSearchingHistory: setSearching,
      helpOpen: help, setHelpOpen: setHelp, hasSuppressedDialogs: false, isLocalJSXCommandActive: false, insertTextRef,
    } as never),
  })
}
const surfaces = [
  { view: 'status', open: status },
  { view: 'config', open: () => config.call('', context) },
  { view: 'usage', open: () => usage.call('', context) },
  { view: 'logins', open: () => logins.call(() => {}, context) },
]
const cell = (lines: string[], x: number, y: number): string => Array.from(lines[y] ?? '')[x] ?? ' '
const header = 'VIEW · cedar · viewing'
for (const [columns, rows] of [[120, 40], [100, 30]] as const) {
  for (const surface of surfaces) {
    initializeSurfaceRoute(ROOT_CHAT_ROUTE)
    resetChromeModeLatchForTests()
    const node = h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined } as never, h(KeybindingSetup, null, h(Harness, { columns })))
    const scene = await mountOffscreen(node, columns, rows)
    let baseline = ''
    let baselineStill = 0
    check(`${columns}x${rows} ${surface.view}: the real centre header and scaffold settle before opening`, await waitFor(() => {
      const now = scene.screen()
      baselineStill = now === baseline && [header, 'transcript row', 'WORKBENCH', 'FILES · orchard', 'Type a prompt'].every(mark => now.includes(mark)) ? baselineStill + 1 : 0
      baseline = now
      return baselineStill >= 3
    }, 8000))
    const before = scene.lines()
    const headerRow = before.findIndex(line => line.includes(header))
    const plan = railPlanAt(columns, true)
    const centreBottom = before.findIndex((line, y) => y > headerRow && cell(before, plan.lanesW, y) === '╰')
    await surface.open()
    const title = `Mercury · ${surface.view}`
    let last = ''
    let stable = 0
    check(`${columns}x${rows} ${surface.view}: the popup paints and settles`, await waitFor(() => {
      const now = scene.screen()
      stable = now === last && now.includes(title) ? stable + 1 : 0
      last = now
      return stable >= 3
    }, 8000))
    const after = scene.lines()
    const titleRow = after.findIndex(line => line.includes(title))
    const popupLeft = after[titleRow]?.lastIndexOf('│', after[titleRow]!.indexOf(title)) ?? -1
    const popupTop = after.findIndex((line, y) => y < titleRow && cell(after, popupLeft, y) === '╭')
    const popupRight = Array.from(after[popupTop] ?? '').findIndex((c, x) => x > popupLeft && c === '╮')
    const popupBottom = after.findIndex((line, y) => y > titleRow && cell(after, popupLeft, y) === '╰')
    const gutter = popupTop - 1
    const label = `${columns}x${rows} /${surface.view}`
    check(`${label}: the header words stay visible above the top gutter`, headerRow >= 0 && after[headerRow]?.includes(header) === true && gutter > headerRow, `header row ${headerRow + 1}, gutter row ${gutter + 1}, border row ${popupTop + 1}`)
    check(`${label}: the entire header row is unchanged`, after[headerRow] === before[headerRow], after[headerRow] === before[headerRow] ? '' : JSON.stringify({ before: before[headerRow], after: after[headerRow] }))
    check(`${label}: all four corners and the bottom gutter fit the measured centre`, popupLeft > plan.lanesW && popupRight > popupLeft && popupBottom > popupTop && popupBottom + 1 < centreBottom, `centre bottom ${centreBottom + 1}, popup ${popupTop + 1}..${popupBottom + 1}`)
    check(`${label}: the top gutter is an opaque blank row`, popupLeft >= 0 && Array.from({ length: popupRight - popupLeft + 3 }, (_, i) => cell(after, popupLeft - 1 + i, gutter)).every(c => c === ' '))
    check(`${label}: the footer stays visible`, after.some(line => line.includes('esc or click outside')))
    if (surface.view === 'status' || surface.view === 'config') {
      check(`${label}: a full-height popup starts its gutter immediately below the header`, gutter === headerRow + 1)
    }
    const frame = after.join('\n') + '\n'
    const name = `${surface.view}-${columns}x${rows}.txt`
    if (frames) {
      writeFileSync(join(frames, name), frame)
      writeFileSync(join(frames, `${surface.view}-${columns}x${rows}-rows.json`), JSON.stringify({ header: headerRow + 1, gutter: gutter + 1, border: popupTop + 1, bottom: popupBottom + 1, centreBottom: centreBottom + 1 }) + '\n')
    }
    if (write) writeFileSync(join(stills, name), frame)
    else if (!frames && !arg('--source-ref') && process.platform === 'darwin') check(`${label}: the stored frame matches the source render`, readFileSync(join(stills, name), 'utf8') === frame)
    if (surface.view === 'status') {
      for (let step = 0; step < 80; step++) scene.push('\x1b[B')
      check(`${label}: the last status fact remains reachable with its header and close hint`, await waitFor(() => scene.screen().includes('workflow idle · trace 3') && scene.screen().includes(header) && scene.screen().includes('esc or click outside'), 4000))
    }
    store.closeSettingsPopup()
    check(`${label}: closing restores the header and transcript`, await waitFor(() => !scene.screen().includes(title) && scene.lines()[headerRow] === before[headerRow], 4000))
    scene.unmount()
    resetOverlayStackForTests()
  }
}
for (const framed of [true, false]) {
  for (const height of [3, 6, 12, 17, 30, 40]) {
    const ref = React.createRef<import('../../src/ink.ts').DOMElement>()
    const scene = await mountOffscreen(h(Box, { width: 80, height: 40 }, h(Box, { ref, width: 60, height, ...(framed ? { borderStyle: 'round' } : {}) })), 80, 40)
    check(`${height}-row host: the measured element settled`, await waitFor(() => ref.current !== null && measureElement(ref.current).height === height, 4000))
    const band = ref.current === null ? null : settingsPopupHost(ref.current, framed)
    const top = framed ? 2 : 0
    const available = Math.max(0, height - (framed ? 3 : 0))
    check(`${height}-row ${framed ? 'framed' : 'unframed'} host: measured band clears only the header that exists`, band?.top === top && band?.rows === available, JSON.stringify(band))
    if (band?.top !== undefined && band.rows !== undefined) {
      const geometry = settingsPopupGeometry({ width: 110, rows: 44 }, band.columns, 40, band.left, { top: band.top, rows: band.rows })
      const expected = Math.max(0, available - 2)
      const compact = expected - 7 < 8
      check(`${height}-row host: chrome and compact floor stay inside the smaller budget`, geometry.rows === expected && geometry.compact === compact && geometry.rowBudget === Math.max(0, expected - (compact ? 3 : 7)), JSON.stringify(geometry))
    }
    scene.unmount()
  }
}
const layout = readFileSync(join(ROOT, 'src/components/FullscreenLayout.tsx'), 'utf8')
check('the framed centre carries no title row and is the settings slot host', !layout.includes('HelmCenterHeader') && /ref=\{centreBoxRef\}[\s\S]*?<TerminalSizeContext\.Provider value=\{sizeVal\}>/.test(layout) && layout.includes('<SettingsPopupSlot overlay={true} hostRef={centreBoxRef} framed={centerFrame} />'))
check('no fixture fetch was needed', fetches.length === 0, `${fetches.length} attempts`)
await releaseScratchHome(HOME)
if (write && failures === 0) registerGeneratedAsset(ASSET)
console.log(`settings-popup-header: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
