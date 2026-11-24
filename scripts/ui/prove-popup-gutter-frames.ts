#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { mountOffscreen, pinScratchHome, releaseScratchHome, type Mounted } from '../lib/settingsPopupHarness.ts'
import { settledFrame } from './popupFrameSettle.ts'
import { paintsBootFaceReady } from '../lib/bootFace.ts'

const HOME = pinScratchHome('popup-gutter-frames')
Object.assign(process.env, {
  MERCURY_FULLSCREEN: '1', MERCURY_HELM_HOME: '1', MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  MERCURY_BOOT_PREFLIGHT: '0', MERCURY_REDUCED_MOTION: '1', MERCURY_LOCAL_PROBE_TARGETS: 'none',
  ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', BROWSER: '/usr/bin/true',
})
for (const base of ['ANTHROPIC_BASE_URL', 'MERCURY_OPENAI_API_BASE', 'MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_OPENAI_AUTH_BASE', 'MERCURY_OPENROUTER_API_BASE', 'MERCURY_GEMINI_API_BASE', 'MERCURY_MOONSHOT_API_BASE', 'MERCURY_MOONSHOT_CODING_BASE', 'MERCURY_DEEPSEEK_API_BASE', 'MERCURY_HUGGINGFACE_HUB_BASE', 'MERCURY_HUGGINGFACE_API_BASE', 'MERCURY_ZAI_API_BASE']) process.env[base] = 'http://127.0.0.1:1'
for (const key of ['MERCURY_MODEL', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'HF_TOKEN', 'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY', 'NODE_ENV']) delete process.env[key]
const arg = (key: string): string | undefined => process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : undefined
const sourceRef = arg('--source-ref')
if (sourceRef) {
  const root = join(import.meta.dir, '../..')
  const changed = new Set(execFileSync('git', ['-C', root, 'diff', '--name-only', '--diff-filter=M', sourceRef, '--', 'src'], { encoding: 'utf8' }).trim().split('\n'))
  const sources = new Map([...changed].filter(file => /\.tsx?$/.test(file)).map(file => [file, execFileSync('git', ['-C', root, 'show', `${sourceRef}:${file}`], { encoding: 'utf8' })]))
  Bun.plugin({ name: 'versioned-popup-source', setup(build) {
    for (const [file, contents] of sources) {
      const path = join(root, file)
      const filter = new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
      build.onLoad({ filter }, () => ({ contents, loader: file.endsWith('.tsx') ? 'tsx' : 'ts' }))
    }
  } })
  console.log(`Rendering product source from ${sourceRef}; ${sources.size} changed modules restored in the loader`)
}
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
const { Box, Text } = await import('../../src/screen/themedRenderer.ts')
const { App } = await import('../../src/boot/App.tsx')
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
const { KeybindingSetup } = await import('../../src/screen/keys/KeybindingProviderSetup.tsx')
const { FullscreenLayout } = await import('../../src/screen/fullscreen-layout/FullscreenLayout.tsx')
const { BootSplashScreen } = await import('../../src/screen/boot-face/BootSplashScreen.tsx')
const { RowPickModal } = await import('../../src/screen/concourse/RowPickModal.tsx')
const { Help } = await import('../../src/screen/help/HelpV2.tsx')
const { default: Composer } = await import('../../src/screen/composer/Composer.tsx')
const { resetChromeModeLatchForTests } = await import('../../src/screen/fullscreen-layout/useLayoutTier.ts')
const { initializeSurfaceRoute, ROOT_CHAT_ROUTE } = await import('../../src/screen/routes/surfaceRoute.ts')
const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/platform/settings/config.ts')
const settings = await import('../../src/screen/cockpit/settingsPopup.ts')
const files = await import('../../src/screen/cockpit/filesMenu.ts')
const crew = await import('../../src/screen/cockpit/crewView.ts')
const usageCommand = await import('../../src/commands/usage/usage.tsx')
const configCommand = await import('../../src/commands/config/config.tsx')
const jevCommand = await import('../../src/commands/jev/jev.tsx')
const modelCommand = await import('../../src/commands/model/mercuryModel.tsx')
const memoryCommand = await import('../../src/commands/memory/memory.tsx')
const submodelsCommand = await import('../../src/commands/submodels/submodels.tsx')
const { resetOverlayStackForTests } = await import('../../src/screen/overlays/overlayStack.ts')
const { railPlanAt } = await import('../../src/screen/fullscreen-layout/helmGeometry.ts')
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
    bottom: h(Composer, {
      debug: false, toolPermissionContext: getDefaultAppState().toolPermissionContext,
      setToolPermissionContext: () => {}, apiKeyStatus: 'valid', commands: [], agents: [], isLoading: false,
      verbose: false, submitCount: 0, onShowRewindPicker: () => {}, mcpClients: [], vimMode, setVimMode,
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
  check(`${label}: four frame corners are on screen`, frame !== null && frame.left >= 0 && frame.right < columns && frame.top >= 0 && frame.bottom < rows, `${JSON.stringify(frame)}; the popup's frame is clipped or missing at this size, so its width and height must fit inside the terminal`)
  if (frame === null) return
  const { left, right, top, bottom } = frame
  const width = right - left + 1
  const topRun = Array.from(lines[top]!).slice(left, right + 1).join('')
  const bottomRun = Array.from(lines[bottom]!).slice(left, right + 1).join('')
  check(`${label}: rounded frame rows close without interruption`, topRun === `╭${'─'.repeat(width - 2)}╮` && bottomRun === `╰${'─'.repeat(width - 2)}╯` && lines.slice(top + 1, bottom).every((_, i) => cell(lines, left, top + 1 + i) === '│' && cell(lines, right, top + 1 + i) === '│'), `${topRun} / ${bottomRun}; something painted over the frame's border, so the popup's frame must be the last paint on those cells`)
  check(`${label}: the host contains the frame and its one-cell gutter`, left > host.left && right < host.right && top > host.top && bottom < host.bottom, `${JSON.stringify(frame)} in ${JSON.stringify(host)}; the popup must leave one blank cell between its frame and the host view edge, so reduce its width or height at this size`)
  const dirty: string[] = []
  for (let y = top - 1; y <= bottom + 1; y++) for (let x = left - 1; x <= right + 1; x++) {
    if (y >= top && y <= bottom && x >= left && x <= right) continue
    if (cell(lines, x, y) !== ' ') dirty.push(`${x},${y}=${JSON.stringify(cell(lines, x, y))}`)
  }
  check(`${label}: every cell in the surrounding gutter is blank`, dirty.length === 0, `${dirty.slice(0, 8).join(' · ')}; text from the surface behind shows around the popup, so the popup must blank its one-cell margin`)
}
const save = (name: string, lines: string[]): void => { if (frameDir) writeFileSync(join(frameDir, `${name}.txt`), `${lines.join('\n')}\n`) }
const surfaces = [
  { name: 'usage', title: 'Mercury · usage', open: async () => { await usageCommand.call('', context) } },
  { name: 'config', title: 'Mercury · config', open: async () => { await configCommand.call('', context) } },
  { name: 'jev', title: 'Mercury · jev', open: async () => { await jevCommand.call('', context) } },
  { name: 'memory', title: 'Mercury · memory', open: async () => { await memoryCommand.call(() => {}, context, '') } },
  { name: 'model', title: 'Mercury · model', open: async () => { setModal(await modelCommand.call(() => setModal(null), context, '')) } },
  { name: 'files', title: 'Mercury · files', open: async () => { files.openFilesMenu() } },
  { name: 'crew', title: 'Mercury — crew', open: async () => { crew.openCrewView() } },
]
const sheets = [
  { name: 'help-sheet', title: 'Mercury — help', open: async () => setModal(h(Help, { commands: [], onClose: () => setModal(null) })) },
  { name: 'submodels-sheet', title: 'Mercury — submodels', open: async () => setModal(await submodelsCommand.call(() => setModal(null), context, '')) },
]
async function close(scene: Mounted): Promise<void> {
  settings.closeSettingsPopup()
  files.closeFilesMenu()
  crew.closeCrewView()
  setModal(null)
  scene.unmount()
  resetOverlayStackForTests()
}
for (const size of process.argv.includes('--concourse-only') ? [] : selectedSizes) {
  const [columns, rows] = size.split('x').map(Number) as [number, number]
  for (const surface of [...surfaces, ...sheets]) {
    initializeSurfaceRoute(ROOT_CHAT_ROUTE)
    resetChromeModeLatchForTests()
    const scene = await mountOffscreen(wrap(h(Harness, { columns })), columns, rows)
    await settledFrame(scene, frame => frame.includes('TTTT'))
    const before = scene.lines()
    const plan = railPlanAt(columns, true)
    const viewLeft = plan.lanesW
    const viewBottom = before.findIndex((line, y) => y > 0 && cell(before, viewLeft, y) === '╰')
    const composerTop = before.findIndex(line => line.includes('Type a prompt')) - 1
    const host: Rect = viewBottom > 0 ? { left: viewLeft + 1, right: Array.from(before[0] ?? '').indexOf('╮', viewLeft + 1) - 1, top: 1, bottom: viewBottom - 1 } : { left: 0, right: columns - 1, top: 0, bottom: composerTop - 1 }
    await surface.open()
    const opened = await settledFrame(scene, frame => frame.includes(surface.title))
    const lines = scene.lines()
    save(`${surface.name}-${size}`, lines)
    check(`${surface.name} ${size}: the source surface opened`, opened, `${lines.filter(line => /Mercury|fault/i.test(line)).join(' | ')}; the surface's title never appeared, so its open call in the surfaces list of this file did not mount it`)
    if (surfaces.includes(surface as typeof surfaces[number])) judge(`${surface.name} ${size}`, lines, surface.title, host, columns, rows)
    else check(`${surface.name} ${size}: the claims-modal sheet is not mistaken for a floating frame`, opened && lines.every(line => Array.from(line).length <= columns), 'the sheet did not open, or a line is wider than the terminal; the sheet must fit the screen width')
    if (surface.name === 'jev') {
      const beforeFlip = scene.screen()
      scene.push('\x1b[D')
      const flipped = await settledFrame(scene, frame => frame.includes(surface.title) && frame !== beforeFlip)
      const changed = scene.lines()
      save(`jev-flipped-${size}`, changed)
      judge(`jev-flipped ${size}`, changed, surface.title, host, columns, rows)
      const outside = (frame: string[]): string => frame.map((line, y) => Array.from(line.padEnd(columns)).map((c, x) => x >= host.left && x <= host.right && y >= host.top && y <= host.bottom ? ' ' : c).join('')).join('\n')
      check(`jev-flipped ${size}: dynamic height never paints outside the view`, flipped && outside(lines) === outside(changed), 'cells outside the host view changed when the JEV popup grew; its height change must stay inside the view')
    }
    await close(scene)
  }
  const dense = h(Text, null, Array.from({ length: rows }, () => 'T'.repeat(columns)).join('\n'))
  const rowPick = h(RowPickModal, { cols: columns, rows, titlePrefix: 'EFFORT', title: 'session', legend: 'enter selects · esc closes', options: ['low', 'medium', 'high', 'max'].map(id => ({ id, label: id })), onPick: () => {}, onClose: () => {} })
  const scene = await mountOffscreen(wrap(h(Box, { width: columns, height: rows, flexDirection: 'column' }, dense, rowPick)), columns, rows)
  await settledFrame(scene, frame => frame.includes('EFFORT'))
  save(`row-effort-${size}`, scene.lines())
  judge(`row-effort ${size}`, scene.lines(), 'EFFORT', { left: 0, right: columns - 1, top: 0, bottom: rows - 1 }, columns, rows)
  scene.unmount()
  resetOverlayStackForTests()
  resetChromeModeLatchForTests()
  const boot = await mountOffscreen(wrap(h(BootSplashScreen)), columns, rows)
  await settledFrame(boot, frame => paintsBootFaceReady(frame))
  boot.push('m')
  await settledFrame(boot, frame => frame.includes('Mercury · model'))
  save(`boot-model-${size}`, boot.lines())
  judge(`boot-model ${size}`, boot.lines(), 'Mercury · model', { left: 0, right: columns - 1, top: 0, bottom: rows - 1 }, columns, rows)
  boot.unmount()
  resetOverlayStackForTests()
}
if (!process.argv.includes('--session-only')) {
  const { concoursePopupFrames } = await import('./popupGutterConcourse.ts')
  await concoursePopupFrames({ sizes: selectedSizes, wrap, mount: mountOffscreen, check, judge, save })
}
await releaseScratchHome(HOME)
console.log(`popup-gutter-frames: ${checks} checks, ${failures} failed; ${selectedSizes.length} sizes; ${surfaces.length + sheets.length + 2} session/Boot surfaces plus 8 concourse surfaces and dynamic JEV growth`)
process.exit(failures === 0 ? 0 : 1)
