#!/usr/bin/env bun
// gate-watch: src/commands/effort/EffortPopup.tsx src/commands/health/HealthCertificate.tsx src/components/CommandPopupSlot.tsx src/components/PopupGutter.tsx src/components/FullscreenLayout.tsx
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome } from '../lib/settingsPopupHarness.ts'
import { settledFrame } from './popupFrameSettle.ts'
import type { CommandPopupShape } from '../../src/utils/cockpit/commandPopup.ts'

pinSourceRef()
const HOME = pinScratchHome('popup-panel-fills-frame')
delete process.env.MERCURY_HOME
delete process.env.MERCURY_EFFORT_LEVEL
process.env.MERCURY_HEALTH_STATE_DIR = join(HOME, 'health-state')
Object.assign(process.env, {
  MERCURY_FULLSCREEN: '1', MERCURY_HELM_HOME: '1', MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  MERCURY_BOOT_PREFLIGHT: '0', MERCURY_REDUCED_MOTION: '1', MERCURY_LOCAL_PROBE_TARGETS: 'none',
  ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', BROWSER: '/usr/bin/true',
})
for (const base of ['ANTHROPIC_BASE_URL', 'MERCURY_OPENAI_API_BASE', 'MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_OPENAI_AUTH_BASE', 'MERCURY_OPENROUTER_API_BASE', 'MERCURY_GEMINI_API_BASE', 'MERCURY_MOONSHOT_API_BASE', 'MERCURY_MOONSHOT_CODING_BASE', 'MERCURY_DEEPSEEK_API_BASE', 'MERCURY_HUGGINGFACE_HUB_BASE', 'MERCURY_HUGGINGFACE_API_BASE', 'MERCURY_ZAI_API_BASE']) process.env[base] = 'http://127.0.0.1:1'
for (const key of ['MERCURY_MODEL', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'HF_TOKEN', 'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY', 'NODE_ENV']) delete process.env[key]

const arg = (key: string): string | undefined => process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : undefined
const frameDir = arg('--frames')
if (frameDir) mkdirSync(frameDir, { recursive: true })
const SIZES: Array<[number, number]> = (arg('--sizes')?.split(',') ?? ['120x44', '80x24']).map(size => size.split('x').map(Number) as [number, number])

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

const React = await import('react')
const h = React.createElement
const { Box, Text } = await import('../../src/ink.ts')
const { App } = await import('../../src/components/App.tsx')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.tsx')
const { FullscreenLayout } = await import('../../src/components/FullscreenLayout.tsx')
const { default: PromptInput } = await import('../../src/components/PromptInput/PromptInput.tsx')
const { resetChromeModeLatchForTests, layoutChromeLive } = await import('../../src/hooks/useLayoutTier.ts')
const { initializeSurfaceRoute, ROOT_CHAT_ROUTE } = await import('../../src/context/surfaceRoute.ts')
const { resetOverlayStackForTests } = await import('../../src/context/overlayStack.ts')
const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/utils/config.ts')
const { POPUP_GUTTER } = await import('../../src/components/PopupGutter.tsx')
const { CommandPopupLease, commandPopupGeometry } = await import('../../src/components/CommandPopupSlot.tsx')
const { claimCommandPopup } = await import('../../src/utils/cockpit/commandPopup.ts')
const { getEngineModel } = await import('../../src/utils/model/model.ts')
const effortCommand = await import('../../src/commands/effort/effort.tsx')
const { effortPopupShape } = await import('../../src/commands/effort/EffortPopup.tsx')
const certificate = await import('../../src/commands/health/HealthCertificate.tsx')
enableConfigs()
saveCurrentProjectConfig(config => ({ ...config, hasCompletedProjectOnboarding: true }))
saveGlobalConfig(config => ({ ...config, prStatusFooterEnabled: false }))

const SOLID = 'T'
const model = getEngineModel()

type ReportFixture = Parameters<typeof certificate.MercuryHealthCertificate>[0]['report']
const fixtureReport: ReportFixture = async () => ({
  verdict: 'certified' as const,
  ranAt: new Date().toISOString(),
  head: { sha: 'abc1234def', branch: 'lane/fixture', dirty: false },
  version: '1.0.0',
  durationMs: 12,
  depth: 'fast' as const,
  sections: [
    { id: 'processes', title: 'PROCESSES', checks: [
      { id: 'boots', label: 'Boots complete', status: 'ok' as const, evidence: 'no pending attempts' },
      { id: 'sweep', label: 'Mercury processes', status: 'ok' as const, evidence: 'none stale' },
    ] },
    { id: 'git', title: 'GIT', checks: [
      { id: 'tree', label: 'Working tree', status: 'ok' as const, evidence: 'clean' },
    ] },
  ],
}) as never

type Surface = { name: string; title: string; shape: CommandPopupShape; open: () => Promise<React.ReactNode> }
const surfaces: Surface[] = [
  {
    name: 'effort',
    title: 'Mercury · effort',
    shape: effortPopupShape(model),
    open: () => effortCommand.call(() => {}, { messages: [], options: { engineModel: model }, getAppState: () => getDefaultAppState(), setAppState: () => {} } as never, ''),
  },
  {
    name: 'health',
    title: 'Mercury · health',
    shape: certificate.healthPopupShape(),
    open: async () => h(CommandPopupLease, { token: claimCommandPopup(certificate.healthPopupShape()), children: h(certificate.MercuryHealthCertificate, { onClose: () => {}, report: fixtureReport }) }),
  },
]

function Harness({ columns, modal }: { columns: number; modal: React.ReactNode }): React.ReactNode {
  const [vimMode, setVimMode] = React.useState<'INSERT' | 'NORMAL'>('INSERT')
  const [searching, setSearching] = React.useState(false)
  const [help, setHelp] = React.useState(false)
  const [bashes, setBashes] = React.useState<string | boolean>(false)
  const insertRef = React.useRef<unknown>(null)
  const modalScrollRef = React.useRef(null)
  return h(FullscreenLayout, {
    scrollable: h(Box, { flexDirection: 'column' }, ...Array.from({ length: 120 }, (_, key) => h(Text, { key, wrap: 'truncate-end' }, SOLID.repeat(columns)))),
    statusBand: h(Text, { wrap: 'truncate-end' }, SOLID.repeat(columns)),
    statusBandActive: false,
    modal: h(Box, { width: '100%', flexDirection: 'column' }, modal),
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
const wrap = (node: React.ReactNode): React.ReactNode => h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined } as never, h(KeybindingSetup, null, node))

const screenOf = (lines: string[], columns: number): string[][] => lines.map(line => { const cells = Array.from(line); while (cells.length < columns) cells.push(' '); return cells })
type Panel = { top: number; bottom: number; left: number; right: number; width: number }
function panelOf(screen: string[][], title: string): Panel | null {
  const y = screen.findIndex(cells => cells.join('').includes(title))
  if (y < 0) return null
  const left = screen[y]!.lastIndexOf('│', Array.from(screen[y]!.join('').slice(0, screen[y]!.join('').indexOf(title))).length)
  if (left < 0) return null
  let top = y
  while (top >= 0 && screen[top]![left] !== '╭') top--
  if (top < 0) return null
  const right = screen[top]!.findIndex((glyph, x) => x > left && glyph === '╮')
  let bottom = top + 1
  while (bottom < screen.length && screen[bottom]![left] !== '╰') bottom++
  return right < 0 || bottom >= screen.length ? null : { top, bottom, left, right, width: right - left + 1 }
}
function groundBeside(screen: string[][], panel: Panel, y: number): { left: number; right: number } {
  const cells = screen[y]!
  let left = 0
  for (let x = panel.left - 1; x >= 0 && cells[x] === ' '; x--) left++
  let right = 0
  for (let x = panel.right + 1; x < cells.length && cells[x] === ' '; x++) right++
  return { left, right }
}
function hostOf(screen: string[][], panel: Panel): { left: number; columns: number; framed: boolean } | null {
  const cells = screen[panel.top + 1]!
  const beside = groundBeside(screen, panel, panel.top + 1)
  const leftEdge = panel.left - beside.left - 1
  const rightEdge = panel.right + beside.right + 1
  if (leftEdge < 0 && rightEdge >= cells.length) return { left: 0, columns: cells.length, framed: false }
  if (cells[leftEdge] === '│' && cells[rightEdge] === '│') return { left: leftEdge + 1, columns: rightEdge - leftEdge - 1, framed: true }
  return null
}
const save = (name: string, lines: string[]): void => { if (frameDir) writeFileSync(join(frameDir, `${name}.txt`), `${lines.join('\n')}\n`) }
const rowAt = (screen: string[][], y: number): string => screen[y]!.join('').replace(/\s+$/, '')

for (const [columns, rows] of SIZES) {
  const chrome = layoutChromeLive(columns, rows).chrome
  section(`${columns}x${rows} (${chrome} chrome): the panel fills the popup frame the slot gave it`)
  for (const surface of surfaces) {
    initializeSurfaceRoute(ROOT_CHAT_ROUTE)
    resetChromeModeLatchForTests()
    const modal = await surface.open()
    const scene = await mountOffscreen(wrap(h(Harness, { columns, modal })), columns, rows)
    try {
      const opened = await settledFrame(scene, frame => frame.includes(surface.title) && frame.includes(SOLID.repeat(8)), 8000)
      const lines = scene.lines()
      save(`${surface.name}-${columns}x${rows}`, lines)
      const screen = screenOf(lines, columns)
      const panel = panelOf(screen, surface.title)
      check(`${surface.name} ${columns}x${rows}: the popup painted as one closed bordered window over the solid chat`, opened && panel !== null, panel === null ? lines.slice(0, 6).join(' | ') : '')
      if (panel === null) continue
      const host = hostOf(screen, panel)
      const pasted = [panel.top, panel.top + 1, panel.bottom].map(y => `row ${y}: ${rowAt(screen, y)}`).join('\n')
      console.log(`${surface.name} ${columns}x${rows}: panel ${panel.width} wide at columns ${panel.left}..${panel.right}, rows ${panel.top}..${panel.bottom}; host ${host === null ? 'not read from the title row' : `${host.columns} columns from ${host.left}${host.framed ? ' inside the view frame' : ' (the screen)'}`}`)
      check(`${surface.name} ${columns}x${rows}: the host the popup floats in is read from the painted view (the centre box's frame or the screen's edge)`, host !== null, pasted)
      if (host !== null) {
        const frame = commandPopupGeometry({ left: host.left, top: 0, columns: host.columns, rows }, rows, surface.shape)
        check(`${surface.name} ${columns}x${rows}: the panel's left and right border columns are where the popup frame begins and ends (columns ${frame.left}..${frame.left + frame.width - 1}, ${frame.width} wide)`, panel.left === frame.left && panel.width === frame.width, `the panel is ${panel.width} wide at ${panel.left}..${panel.right} — ${frame.width - panel.width} column${frame.width - panel.width === 1 ? '' : 's'} short of its frame\n${pasted}`)
      }
      const beside = Array.from({ length: panel.bottom - panel.top + 1 }, (_, i) => groundBeside(screen, panel, panel.top + i))
      const lid = beside[0]!
      const widest = beside.reduce((acc, row) => ({ left: Math.max(acc.left, row.left), right: Math.max(acc.right, row.right) }), { left: 0, right: 0 })
      const narrowest = beside.reduce((acc, row) => ({ left: Math.min(acc.left, row.left), right: Math.min(acc.right, row.right) }), { left: columns, right: columns })
      check(`${surface.name} ${columns}x${rows}: one ground column beside ╭ and one beside ╮ (${POPUP_GUTTER}/${POPUP_GUTTER}), no blank ground column inside the frame`, lid.left === POPUP_GUTTER && lid.right === POPUP_GUTTER, `${lid.left}/${lid.right} blank columns beside the lid\n${pasted}`)
      check(`${surface.name} ${columns}x${rows}: every row of the panel keeps that ${POPUP_GUTTER}/${POPUP_GUTTER} ground beside its border`, narrowest.left === POPUP_GUTTER && narrowest.right === POPUP_GUTTER && widest.left === POPUP_GUTTER && widest.right === POPUP_GUTTER, `left ${narrowest.left}..${widest.left} · right ${narrowest.right}..${widest.right} blank columns across rows ${panel.top}..${panel.bottom}`)
    } finally {
      scene.unmount()
      resetOverlayStackForTests()
    }
  }
}

console.log(`\npopup-panel-fills-frame: ${checks} checks, ${failures} failed`)
await releaseScratchHome(HOME)
process.exit(failures === 0 ? 0 : 1)
