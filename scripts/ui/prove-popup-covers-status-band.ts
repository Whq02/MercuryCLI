#!/usr/bin/env bun
// gate-watch: src/components/PopupGutter.tsx src/components/CommandPopupSlot.tsx src/components/ModelPickerPopupSlot.tsx src/components/FullscreenLayout.tsx
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome } from '../lib/settingsPopupHarness.ts'
import { settledFrame } from './popupFrameSettle.ts'

pinSourceRef()
const HOME = pinScratchHome('popup-covers-status-band')
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
const SIZES: Array<[number, number]> = (arg('--sizes')?.split(',') ?? ['100x30', '120x44', '160x50', '165x50', '200x60']).map(size => size.split('x').map(Number) as [number, number])

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
const { getEngineModel } = await import('../../src/utils/model/model.ts')
const effortCommand = await import('../../src/commands/effort/effort.tsx')
const modelCommand = await import('../../src/commands/model/mercuryModel.tsx')
const certificate = await import('../../src/commands/health/HealthCertificate.tsx')
const { CommandPopupLease } = await import('../../src/components/CommandPopupSlot.tsx')
const { claimCommandPopup } = await import('../../src/utils/cockpit/commandPopup.ts')
enableConfigs()
saveCurrentProjectConfig(config => ({ ...config, hasCompletedProjectOnboarding: true }))
saveGlobalConfig(config => ({ ...config, prStatusFooterEnabled: false }))

const SOLID = 'T'
const BAND = 'B'
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

type Surface = { name: string; title: string; painted: (frame: string) => boolean; open: () => Promise<React.ReactNode> }
const surfaces: Surface[] = [
  {
    name: 'model',
    title: 'Mercury · model',
    painted: frame => frame.includes('Mercury · model') && frame.includes('current'),
    open: () => modelCommand.call(() => {}, { messages: [] } as never, ''),
  },
  {
    name: 'effort',
    title: 'Mercury · effort',
    painted: frame => frame.includes('Mercury · effort'),
    open: () => effortCommand.call(() => {}, { messages: [], options: { engineModel: model }, getAppState: () => getDefaultAppState(), setAppState: () => {} } as never, ''),
  },
  {
    name: 'health',
    title: 'Mercury · health',
    painted: frame => frame.includes('Mercury · health') && frame.includes('PROCESSES'),
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
    statusBand: h(Text, { wrap: 'truncate-end' }, BAND.repeat(columns)),
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
type Panel = { top: number; bottom: number; left: number; right: number }
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
  return right < 0 || bottom >= screen.length ? null : { top, bottom, left, right }
}
type Host = { left: number; right: number; top: number }
function hostOf(screen: string[][], panel: Panel): Host | null {
  let host: Host | null = null
  for (let top = panel.top - 1; top >= 0; top--) {
    const cells = screen[top]!
    for (let x0 = panel.left - 1; x0 >= 0; x0--) {
      if (cells[x0] !== '╭') continue
      const x1 = cells.findIndex((glyph, x) => x > panel.right && glyph === '╮')
      if (x1 < 0) continue
      let encloses = true
      for (let y = panel.top; y <= panel.bottom && encloses; y++) encloses = screen[y]![x0] === '│' && screen[y]![x1] === '│'
      if (encloses && (host === null || x0 + 1 > host.left)) host = { left: x0 + 1, right: x1 - 1, top: top + 1 }
    }
  }
  return host
}
const BORDER = new Set(['╭', '╮', '╰', '╯', '│', '─'])
type BandState = 'whole' | 'absent' | 'torn'
function bandAbove(screen: string[][], host: Host, panel: Panel): { state: BandState; rows: string[] } {
  const rows = Array.from({ length: Math.max(0, panel.top - host.top) }, (_, i) => screen[host.top + i]!.slice(host.left, host.right + 1).join(''))
  const painted = rows.filter(row => row.trim().length > 0)
  if (painted.length === 0) return { state: 'absent', rows }
  const lid = rows.findIndex(row => row.trimStart().startsWith('╭'))
  const floor = rows.findIndex(row => row.trimStart().startsWith('╰'))
  const sidesWhole = lid >= 0 && floor > lid && rows.slice(lid + 1, floor).every(row => row.trimStart().startsWith('│') && row.trimEnd().endsWith('│')) && rows.slice(lid + 1, floor).some(row => row.includes(BAND))
  if (sidesWhole) return { state: 'whole', rows }
  return { state: painted.some(row => Array.from(row).some(glyph => BORDER.has(glyph))) ? 'torn' : 'absent', rows }
}
const save = (name: string, lines: string[]): void => { if (frameDir) writeFileSync(join(frameDir, `${name}.txt`), `${lines.join('\n')}\n`) }

for (const [columns, rows] of SIZES) {
  const chrome = layoutChromeLive(columns, rows).chrome
  section(`${columns}x${rows} (${chrome} chrome): a popup over the centre pane leaves the status band whole or hides it whole`)
  for (const surface of surfaces) {
    initializeSurfaceRoute(ROOT_CHAT_ROUTE)
    resetChromeModeLatchForTests()
    const modal = await surface.open()
    const scene = await mountOffscreen(wrap(h(Harness, { columns, modal })), columns, rows)
    try {
      const opened = await settledFrame(scene, frame => surface.painted(frame), 8000)
      const lines = scene.lines()
      save(`${surface.name}-${columns}x${rows}`, lines)
      const screen = screenOf(lines, columns)
      const panel = panelOf(screen, surface.title)
      check(`${surface.name} ${columns}x${rows}: the popup painted as one closed bordered window over the solid chat`, opened && panel !== null, panel === null ? lines.slice(0, 6).join(' | ') : '')
      if (panel === null) continue
      const host = hostOf(screen, panel)
      check(`${surface.name} ${columns}x${rows}: the centre box's frame is read from the painted view`, host !== null, `row ${panel.top + 1}: ${screen[panel.top + 1]!.join('').trimEnd()}`)
      if (host === null) continue
      const slack = (host.right - host.left + 1) - (panel.right - panel.left + 1 + 2)
      const spans = slack <= 8
      const band = bandAbove(screen, host, panel)
      const pasted = band.rows.map((row, i) => `row ${host.top + i}: ${row.trimEnd()}`).join('\n')
      console.log(`${surface.name} ${columns}x${rows}: popup at columns ${panel.left}..${panel.right}, rows ${panel.top}..${panel.bottom}; centre pane ${host.left}..${host.right} from row ${host.top}; the popup ${spans ? `spans the pane (${slack} column${slack === 1 ? '' : 's'} of slack)` : 'floats inside the pane'}; the band above it is ${band.state}`)
      if (spans) {
        check(`${surface.name} ${columns}x${rows}: the rows between the pane's top and the popup carry the status band whole or nothing of it — never its top border alone (nor a few columns of it)`, band.state !== 'torn', `the band is ${band.state}:\n${pasted}`)
      } else {
        const above = Array.from({ length: Math.max(0, panel.top - host.top) }, (_, i) => screen[host.top + i]!.slice(host.left, host.right + 1).join(''))
        const lidRow = above.find(row => row.trimStart().startsWith('╭'))
        check(`${surface.name} ${columns}x${rows}: a popup narrower than the pane floats over the band and leaves its top border's corners in place`, lidRow !== undefined && lidRow.trimEnd().endsWith('╮'), above.map((row, i) => `row ${host.top + i}: ${row.trimEnd()}`).join('\n'))
      }
    } finally {
      scene.unmount()
      resetOverlayStackForTests()
    }
  }
}

console.log(`\npopup-covers-status-band: ${checks} checks, ${failures} failed`)
await releaseScratchHome(HOME)
process.exit(failures === 0 ? 0 : 1)
