#!/usr/bin/env bun
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mountOffscreen, pinScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

const HOME = pinScratchHome('popup-gutter-frames')
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
const manifest = JSON.parse(readFileSync(join(import.meta.dir, '../../design-system/live/manifest.json'), 'utf8')) as { entries: Array<{ scenario: string; cols: number; rows: number }> }
const sizes = [...new Set([...manifest.entries.filter(e => e.scenario === 'frame').map(e => `${e.cols}x${e.rows}`), '178x51', '120x40', '100x40', '80x22'])]
const selectedSizes = arg('--sizes')?.split(',') ?? sizes
let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const React = await import('react')
const h = React.createElement
const { Box, Text } = await import('../../src/ink.ts')
const { App } = await import('../../src/components/App.tsx')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.tsx')
const { FullscreenLayout } = await import('../../src/components/FullscreenLayout.tsx')
const { BootSplashScreen } = await import('../../src/components/BootSplashScreen.tsx')
const { RowPickModal } = await import('../../src/components/concourse/RowPickModal.tsx')
const { HelpV2 } = await import('../../src/components/HelpV2/HelpV2.tsx')
const { default: PromptInput } = await import('../../src/components/PromptInput/PromptInput.tsx')
const { resetChromeModeLatchForTests } = await import('../../src/hooks/useLayoutTier.ts')
const { initializeSurfaceRoute, ROOT_REPL_ROUTE } = await import('../../src/context/surfaceRoute.ts')
const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/utils/config.ts')
const settings = await import('../../src/utils/cockpit/settingsPopup.ts')
const files = await import('../../src/utils/cockpit/filesMenu.ts')
const crew = await import('../../src/utils/cockpit/crewView.ts')
const usageCommand = await import('../../src/commands/usage/usage.tsx')
const configCommand = await import('../../src/commands/config/config.tsx')
const modelCommand = await import('../../src/commands/model/mercuryModel.tsx')
const submodelsCommand = await import('../../src/commands/submodels/submodels.tsx')
const { resetOverlayStackForTests } = await import('../../src/context/overlayStack.ts')
const { railPlanAt } = await import('../../src/utils/helmGeometry.ts')
enableConfigs()
saveCurrentProjectConfig(c => ({ ...c, hasCompletedProjectOnboarding: true }))
saveGlobalConfig(c => ({ ...c, prStatusFooterEnabled: false }))
const context = { messages: [], options: {} } as never
let setModal: (node: React.ReactNode) => void = () => {}

function Harness({ columns }: { columns: number }): React.ReactNode {
  const [modal, updateModal] = React.useState<React.ReactNode>(null)
  setModal = updateModal
  const [vimMode, setVimMode] = React.useState<'INSERT' | 'NORMAL'>('INSERT')
  const [searching, setSearching] = React.useState(false)
  const [help, setHelp] = React.useState(false)
  const [bashes, setBashes] = React.useState<string | boolean>(false)
  const insertRef = React.useRef<unknown>(null)
  const modalScrollRef = React.useRef(null)
  return h(FullscreenLayout, {
    scrollable: h(Box, { flexDirection: 'column' }, ...Array.from({ length: 100 }, (_, key) => h(Text, { key, wrap: 'truncate-end' }, 'T'.repeat(columns)))),
    statusBand: h(Text, null, 'live transcript behind the popup'),
    statusBandActive: false,
    modal: modal === null ? undefined : h(Box, { width: '100%', flexDirection: 'column' }, modal),
    modalScrollRef,
    bottom: h(PromptInput, {
      debug: false, ideSelection: undefined, toolPermissionContext: getDefaultAppState().toolPermissionContext,
      setToolPermissionContext: () => {}, apiKeyStatus: 'valid', commands: [], agents: [], isLoading: false,
      verbose: false, submitCount: 0, onShowMessageSelector: () => {}, mcpClients: [], vimMode, setVimMode,
      showBashesDialog: bashes, setShowBashesDialog: setBashes, onExit: () => {}, getToolUseContext: () => ({}),
      onSubmit: async () => {}, isSearchingHistory: searching, setIsSearchingHistory: setSearching,
      helpOpen: help, setHelpOpen: setHelp, hasSuppressedDialogs: false, isLocalJSXCommandActive: modal !== null,
      insertTextRef: insertRef,
    } as never),
  } as never)
}
function wrap(node: React.ReactNode): React.ReactNode {
  return h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined } as never, h(KeybindingSetup, null, node))
}
type Rect = { left: number; right: number; top: number; bottom: number }
const cell = (lines: string[], x: number, y: number): string => Array.from(lines[y] ?? '')[x] ?? ' '
function frameOf(lines: string[], title: string): Rect | null {
  const y = lines.findLastIndex(line => line.includes(title))
  if (y < 0) return null
  const titleAt = lines[y]!.indexOf(title)
  const left = lines[y]!.lastIndexOf('│', titleAt)
  if (left < 0) return null
  let top = y
  while (top >= 0 && !'╭┌'.includes(cell(lines, left, top))) top--
  if (top < 0) return null
  const topCells = Array.from(lines[top]!)
  const right = topCells.findIndex((c, x) => x > left && '╮┐'.includes(c))
  let bottom = top + 1
  while (bottom < lines.length && !'╰└'.includes(cell(lines, left, bottom))) bottom++
  return right < 0 || bottom >= lines.length ? null : { left, right, top, bottom }
}
function judge(label: string, lines: string[], title: string, host: Rect, columns: number, rows: number): void {
  const frame = frameOf(lines, title)
  check(`${label}: four frame corners are on screen`, frame !== null && frame.left >= 0 && frame.right < columns && frame.top >= 0 && frame.bottom < rows, JSON.stringify(frame))
  if (frame === null) return
  const { left, right, top, bottom } = frame
  const width = right - left + 1
  const topRun = Array.from(lines[top]!).slice(left, right + 1).join('')
  const bottomRun = Array.from(lines[bottom]!).slice(left, right + 1).join('')
  check(`${label}: rounded frame rows close without interruption`, topRun === `╭${'─'.repeat(width - 2)}╮` && bottomRun === `╰${'─'.repeat(width - 2)}╯` && lines.slice(top + 1, bottom).every((_, i) => cell(lines, left, top + 1 + i) === '│' && cell(lines, right, top + 1 + i) === '│'), `${topRun} / ${bottomRun}`)
  check(`${label}: the host contains the frame and its one-cell gutter`, left > host.left && right < host.right && top > host.top && bottom < host.bottom, `${JSON.stringify(frame)} in ${JSON.stringify(host)}`)
  const dirty: string[] = []
  for (let y = top - 1; y <= bottom + 1; y++) for (let x = left - 1; x <= right + 1; x++) {
    if (y >= top && y <= bottom && x >= left && x <= right) continue
    if (cell(lines, x, y) !== ' ') dirty.push(`${x},${y}=${JSON.stringify(cell(lines, x, y))}`)
  }
  check(`${label}: every cell in the surrounding gutter is blank`, dirty.length === 0, dirty.slice(0, 8).join(' · '))
}
const save = (name: string, lines: string[]): void => { if (frameDir) writeFileSync(join(frameDir, `${name}.txt`), `${lines.join('\n')}\n`) }
const surfaces = [
  { name: 'usage', title: 'Mercury · usage', open: async () => { await usageCommand.call('', context) } },
  { name: 'config', title: 'Mercury · config', open: async () => { await configCommand.call('', context) } },
  { name: 'model', title: 'Mercury · model', open: async () => { setModal(await modelCommand.call(() => setModal(null), context, '')) } },
  { name: 'files', title: 'Mercury · files', open: async () => { files.openFilesMenu() } },
  { name: 'crew', title: 'Mercury — crew', open: async () => { crew.openCrewView() } },
]
const sheets = [
  { name: 'help-sheet', title: 'Mercury — help', open: async () => setModal(h(HelpV2, { commands: [], onClose: () => setModal(null) })) },
  { name: 'submodels-sheet', title: 'Mercury — submodels', open: async () => setModal(await submodelsCommand.call(() => setModal(null), context, '')) },
]
async function close(scene: Mounted): Promise<void> {
  settings.closeSettingsPopup()
  files.closeFilesMenu()
  crew.closeCrewView()
  setModal(null)
  await settle(80)
  scene.unmount()
  resetOverlayStackForTests()
}
for (const size of process.argv.includes('--concourse-only') ? [] : selectedSizes) {
  const [columns, rows] = size.split('x').map(Number) as [number, number]
  for (const surface of [...surfaces, ...sheets]) {
    initializeSurfaceRoute(ROOT_REPL_ROUTE)
    resetChromeModeLatchForTests()
    const scene = await mountOffscreen(wrap(h(Harness, { columns })), columns, rows)
    await waitFor(() => scene.screen().includes('TTTT'), 4000)
    await settle(100)
    const before = scene.lines()
    const plan = railPlanAt(columns, true)
    const viewLeft = plan.lanesW
    const viewBottom = before.findIndex((line, y) => y > 0 && cell(before, viewLeft, y) === '╰')
    const composerTop = before.findIndex(line => line.includes('Type a prompt')) - 1
    const host: Rect = viewBottom > 0 ? { left: viewLeft + 1, right: Array.from(before[0] ?? '').indexOf('╮', viewLeft + 1) - 1, top: 1, bottom: viewBottom - 1 } : { left: 0, right: columns - 1, top: 0, bottom: composerTop - 1 }
    await surface.open()
    const opened = await waitFor(() => scene.screen().includes(surface.title), 4000)
    await settle(150)
    const lines = scene.lines()
    save(`${surface.name}-${size}`, lines)
    check(`${surface.name} ${size}: the source surface opened`, opened, lines.filter(line => /Mercury|fault/i.test(line)).join(' | '))
    if (surfaces.includes(surface as typeof surfaces[number])) judge(`${surface.name} ${size}`, lines, surface.title, host, columns, rows)
    else check(`${surface.name} ${size}: the claims-modal sheet is not mistaken for a floating frame`, opened && lines.every(line => Array.from(line).length <= columns))
    await close(scene)
  }
  const dense = h(Text, null, Array.from({ length: rows }, () => 'T'.repeat(columns)).join('\n'))
  const rowPick = h(RowPickModal, { cols: columns, rows, titlePrefix: 'EFFORT', title: 'session', legend: 'enter selects · esc closes', options: ['low', 'medium', 'high', 'max'].map(id => ({ id, label: id })), onPick: () => {}, onClose: () => {} })
  const scene = await mountOffscreen(wrap(h(Box, { width: columns, height: rows, flexDirection: 'column' }, dense, rowPick)), columns, rows)
  await waitFor(() => scene.screen().includes('EFFORT'), 4000)
  await settle(100)
  save(`row-effort-${size}`, scene.lines())
  judge(`row-effort ${size}`, scene.lines(), 'EFFORT', { left: 0, right: columns - 1, top: 0, bottom: rows - 1 }, columns, rows)
  scene.unmount()
  resetOverlayStackForTests()
  resetChromeModeLatchForTests()
  const boot = await mountOffscreen(wrap(h(BootSplashScreen)), columns, rows)
  await waitFor(() => boot.screen().includes('↑↓ choose'), 4000)
  boot.push('m')
  await waitFor(() => boot.screen().includes('Mercury · model'), 4000)
  await settle(150)
  save(`boot-model-${size}`, boot.lines())
  judge(`boot-model ${size}`, boot.lines(), 'Mercury · model', { left: 0, right: columns - 1, top: 0, bottom: rows - 1 }, columns, rows)
  boot.unmount()
  resetOverlayStackForTests()
}
const { concoursePopupFrames } = await import('./popupGutterConcourse.ts')
await concoursePopupFrames({ sizes: selectedSizes, wrap, mount: mountOffscreen, settle, waitFor, check, judge, save })
rmSync(HOME, { recursive: true, force: true })
console.log(`popup-gutter-frames: ${checks} checks, ${failures} failed; ${selectedSizes.length} sizes × ${surfaces.length + sheets.length + 2} surfaces`)
process.exit(failures === 0 ? 0 : 1)
