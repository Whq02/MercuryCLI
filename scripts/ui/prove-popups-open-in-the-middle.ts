#!/usr/bin/env bun
// gate-watch: src/screen/fullscreen-layout/CrewViewSlot.tsx src/screen/fullscreen-layout/frame.tsx src/screen/fullscreen-layout/FullscreenLayout.tsx src/screen/overlays/promptOverlay.tsx src/screen/composer/composerSurface.tsx src/screen/cockpit/commandPopup.ts src/commands/runs/tasks.tsx src/commands/workbench/workbench.tsx
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, type Mounted } from '../lib/settingsPopupHarness.ts'
import { settledFrame } from './popupFrameSettle.ts'

const HOME = pinScratchHome('popups-open-in-the-middle')
Object.assign(process.env, {
  MERCURY_FULLSCREEN: '1', MERCURY_HELM_HOME: '1', MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  MERCURY_BOOT_PREFLIGHT: '0', MERCURY_REDUCED_MOTION: '1', MERCURY_LOCAL_PROBE_TARGETS: 'none',
  ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', BROWSER: '/usr/bin/true',
})
for (const base of ['ANTHROPIC_BASE_URL', 'MERCURY_OPENAI_API_BASE', 'MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_OPENAI_AUTH_BASE', 'MERCURY_OPENROUTER_API_BASE', 'MERCURY_GEMINI_API_BASE', 'MERCURY_MOONSHOT_API_BASE', 'MERCURY_MOONSHOT_CODING_BASE', 'MERCURY_DEEPSEEK_API_BASE', 'MERCURY_HUGGINGFACE_HUB_BASE', 'MERCURY_HUGGINGFACE_API_BASE', 'MERCURY_ZAI_API_BASE']) process.env[base] = 'http://127.0.0.1:1'
for (const key of ['MERCURY_MODEL', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'HF_TOKEN', 'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY', 'NODE_ENV']) delete process.env[key]
pinSourceRef()
const arg = (key: string): string | undefined => process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : undefined
const frameDir = arg('--frames')
if (frameDir) mkdirSync(frameDir, { recursive: true })
const only = arg('--only')
const SIZES = (arg('--sizes') ?? '230x70,200x60,120x40').split(',')
const WHERE = 'the one door is CrewViewSlot in src/screen/fullscreen-layout/CrewViewSlot.tsx: a popup that misses it is not handed to it (the composer hands the runs popup through useRunsPopup in src/screen/composer/composerSurface.tsx; a command claims the door with claimCommandPopup(crewDoorShape(view)) in its own call)'
let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ` — ${detail}${detail ? '; ' : ''}${WHERE}` : ''}`)
}
const React = await import('react')
const h = React.createElement
const { Box, Text } = await import('../../src/screen/themedRenderer.ts')
const { App } = await import('../../src/boot/App.tsx')
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
const { KeybindingSetup } = await import('../../src/screen/keys/KeybindingProviderSetup.tsx')
const { FullscreenLayout } = await import('../../src/screen/fullscreen-layout/FullscreenLayout.tsx')
const { default: Composer } = await import('../../src/screen/composer/Composer.tsx')
const { resetChromeModeLatchForTests } = await import('../../src/screen/fullscreen-layout/useLayoutTier.ts')
const { railPlanAt, resetRailTier } = await import('../../src/screen/fullscreen-layout/helmGeometry.ts')
const { initializeSurfaceRoute, ROOT_CHAT_ROUTE } = await import('../../src/screen/routes/surfaceRoute.ts')
const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/platform/settings/config.ts')
const crew = await import('../../src/screen/cockpit/crewView.ts')
const commandPopup = await import('../../src/screen/cockpit/commandPopup.ts')
const runsCommand = await import('../../src/commands/runs/tasks.tsx')
const workbenchCommand = await import('../../src/commands/workbench/workbench.tsx')
const { resetOverlayStackForTests } = await import('../../src/screen/overlays/overlayStack.ts')
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
    statusBand: h(Text, null, 'the status row'),
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
function wrap(node: React.ReactNode, footerSelection: 'tasks' | null): React.ReactNode {
  return h(App, { initialState: { ...getDefaultAppState(), footerSelection }, getFpsMetrics: () => undefined } as never, h(KeybindingSetup, null, node))
}
type Rect = { left: number; right: number; top: number; bottom: number }
const cell = (lines: string[], x: number, y: number): string => Array.from(lines[y] ?? '')[x] ?? ' '
function frameOf(lines: string[], title: string): Rect | null {
  const y = lines.findIndex(line => line.includes(title))
  if (y < 0) return null
  const titleAt = Array.from(lines[y]!.slice(0, lines[y]!.indexOf(title))).length
  let left = titleAt
  while (left >= 0 && cell(lines, left, y) !== '│') left--
  if (left < 0) return null
  let top = y
  while (top >= 0 && cell(lines, left, top) !== '╭') top--
  if (top < 0) return null
  const right = Array.from(lines[top]!).findIndex((c, x) => x > left && c === '╮')
  let bottom = top + 1
  while (bottom < lines.length && cell(lines, left, bottom) !== '╰') bottom++
  return right < 0 || bottom >= lines.length ? null : { left, right, top, bottom }
}
const save = (name: string, lines: string[]): void => { if (frameDir) writeFileSync(join(frameDir, `${name}.txt`), `${lines.join('\n')}\n`) }
const text = (lines: string[], y: number, from: number, to: number): string => Array.from((lines[y] ?? '').padEnd(to + 1)).slice(from, to + 1).join('')

type Scene = { scene: Mounted; before: string[]; host: Rect; columns: number; rows: number }
async function mount(size: string, footerSelection: 'tasks' | null = null, mouseTracking = false): Promise<Scene> {
  const [columns, rows] = size.split('x').map(Number) as [number, number]
  initializeSurfaceRoute(ROOT_CHAT_ROUTE)
  resetChromeModeLatchForTests()
  resetRailTier()
  const scene = await mountOffscreen(wrap(h(Harness, { columns }), footerSelection), columns, rows, { mouseTracking })
  await settledFrame(scene, frame => frame.includes('TTTT'))
  const before = scene.lines()
  const viewLeft = railPlanAt(columns, columns >= 150).lanesW
  const viewBottom = before.findIndex((_, y) => y > 0 && cell(before, viewLeft, y) === '╰')
  const host: Rect = { left: viewLeft + 1, right: Array.from(before[0] ?? '').indexOf('╮', viewLeft + 1) - 1, top: 1, bottom: viewBottom - 1 }
  return { scene, before, host, columns, rows }
}
async function unmount(scene: Mounted): Promise<void> {
  crew.closeCrewView()
  setModal(null)
  const claim = commandPopup.commandPopupClaim()
  if (claim !== null) commandPopup.releaseCommandPopup(claim.token)
  scene.unmount()
  resetOverlayStackForTests()
}
type CrewShot = { frame: Rect | null; lines: string[] }
function judge(label: string, { before, host, columns }: Scene, lines: string[], title: string, keys: RegExp, crewShot: CrewShot, width: number): void {
  const crewFrame = crewShot.frame
  const frame = frameOf(lines, title)
  check(`${label}: it is a bordered box with its head line at its top`, frame !== null && lines[frame.top + 1]!.includes(title), `the head ${JSON.stringify(title)} is not on the first row inside a rounded frame`)
  if (frame === null || crewFrame === null) return
  const leftMargin = frame.left - host.left
  const rightMargin = host.right - frame.right
  check(`${label}: it stands in the middle (left margin equals right margin within one cell)`, Math.abs(leftMargin - rightMargin) <= 1 && frame.right < host.right, `left margin ${leftMargin}, right margin ${rightMargin} inside the view ${host.left}..${host.right} of ${columns} columns`)
  check(`${label}: its top row is the crew popup's top row at this terminal size`, frame.top === crewFrame.top, `top row ${frame.top}, the crew popup's ${crewFrame.top}`)
  check(`${label}: it is as wide as the door's width rule allows (${width} asked, the view less its gutters at most)`, frame.right - frame.left + 1 === Math.min(width, host.right - host.left + 1 - 2), `${frame.right - frame.left + 1} columns in a view of ${host.right - host.left + 1}`)
  check(`${label}: its keys row is its last row`, keys.test(text(lines, frame.bottom - 1, frame.left, frame.right)), `the last row inside the frame reads ${JSON.stringify(text(lines, frame.bottom - 1, frame.left, frame.right).trim())}`)
  const beside = [...Array(frame.bottom - frame.top + 1).keys()].map(i => frame.top + i).filter(y => frame.left - 2 >= host.left && /T/.test(text(before, y, host.left, frame.left - 2)))
  const lost = beside.filter(y => text(lines, y, host.left, frame.left - 2) !== text(before, y, host.left, frame.left - 2) || text(lines, y, frame.right + 2, host.right) !== text(before, y, frame.right + 2, host.right))
  const under = [...Array(Math.max(0, host.bottom - frame.bottom - 1)).keys()].map(i => frame.bottom + 2 + i)
  const lostUnder = under.filter(y => text(lines, y, host.left, host.right) !== text(before, y, host.left, host.right))
  check(`${label}: the transcript's rows stay drawn around it (${beside.length} rows beside it, ${under.length} under it)`, beside.length + under.length > 0 && lost.length === 0 && lostUnder.length === 0, `rows ${[...lost, ...lostUnder].slice(0, 6).join(',')} of the transcript changed outside the popup and its one-cell gutter`)
  const asWide = frame.left === crewFrame.left && frame.right === crewFrame.right
  const above = [...Array(frame.top).keys()].filter(y => asWide ? text(lines, y, host.left, host.right) !== text(crewShot.lines, y, host.left, host.right) : text(lines, y, host.left, host.right) !== text(before, y, host.left, host.right) && text(lines, y, host.left, host.right).trim() !== '')
  check(`${label}: what stands above it is ${asWide ? 'what stands above the crew popup' : 'the screen\'s own rows, or the blank cover the door lays over the status band for a popup as wide as the view'}`, above.length === 0, `rows ${above.join(',')} above the popup are neither`)
  const typing = before.findIndex(line => line.includes('Type a prompt'))
  check(`${label}: the typing box, the side boxes and the status row stay where they were`, typing > 0 && lines[typing] === before[typing] && lines.every((line, y) => text(lines, y, 0, host.left - 2) === text(before, y, 0, host.left - 2) && text(lines, y, host.right + 2, columns - 1) === text(before, y, host.right + 2, columns - 1)), `the typing box was on row ${typing}; rows ${lines.map((_, y) => y).filter(y => text(lines, y, 0, host.left - 2) !== text(before, y, 0, host.left - 2) || text(lines, y, host.right + 2, columns - 1) !== text(before, y, host.right + 2, columns - 1)).slice(0, 6).join(',')} changed beside the view`)
}

for (const size of SIZES) {
  const crewScene = await mount(size)
  crew.openCrewView()
  await settledFrame(crewScene.scene, frame => frame.includes('Mercury — crew'))
  const crewShot: CrewShot = { frame: frameOf(crewScene.scene.lines(), 'Mercury — crew'), lines: crewScene.scene.lines() }
  save(`crew-${size}`, crewShot.lines)
  await unmount(crewScene.scene)
  check(`crew ${size}: the model popup opened`, crewShot.frame !== null, 'the crew popup did not paint its frame')
  if (only === undefined || only === 'runs') {
    const typed = await mount(size)
    setModal(await runsCommand.call(() => setModal(null), context, ''))
    await settledFrame(typed.scene, frame => frame.includes('Mercury — runs'))
    save(`runs-command-${size}`, typed.scene.lines())
    judge(`/runs ${size}`, typed, typed.scene.lines(), 'Mercury — runs', /esc close/, crewShot, 124)
    typed.scene.push('\x1b')
    await settledFrame(typed.scene, frame => !frame.includes('Mercury — runs'))
    check(`/runs ${size}: esc closes it and the screen is as it was`, typed.scene.lines().join('\n') === typed.before.join('\n'), 'the frame after esc differs from the frame before the popup opened')
    await unmount(typed.scene)
    const picked = await mount(size, 'tasks')
    picked.scene.push('\r')
    await settledFrame(picked.scene, frame => frame.includes('Mercury — runs'))
    save(`runs-footer-${size}`, picked.scene.lines())
    judge(`runs from the footer ${size}`, picked, picked.scene.lines(), 'Mercury — runs', /esc close/, crewShot, 124)
    picked.scene.push('\x1b')
    await settledFrame(picked.scene, frame => !frame.includes('Mercury — runs'))
    check(`runs from the footer ${size}: esc closes it and the typing box is still on its row`, picked.scene.lines().findIndex(line => line.includes('Type a prompt')) === picked.before.findIndex(line => line.includes('Type a prompt')), 'the typing box moved after the popup closed')
    await unmount(picked.scene)
  }
  for (const popup of [
    { name: 'prompts', route: '/workbench', title: 'Mercury — prompts', open: () => workbenchCommand.call(() => setModal(null), context, '') },
  ]) {
    if (only !== undefined && only !== popup.name) continue
    const opened = await mount(size)
    setModal(await popup.open())
    await settledFrame(opened.scene, frame => frame.includes(popup.title))
    save(`${popup.name}-${size}`, opened.scene.lines())
    judge(`${popup.route} ${size}`, opened, opened.scene.lines(), popup.title, /esc close/, crewShot, 140)
    opened.scene.push('\x1b')
    await settledFrame(opened.scene, frame => !frame.includes(popup.title))
    check(`${popup.route} ${size}: esc closes it and the screen is as it was`, opened.scene.lines().join('\n') === opened.before.join('\n'), 'the frame after esc differs from the frame before the popup opened')
    await unmount(opened.scene)
  }
}
if (only === undefined || only === 'keys') {
  const size = SIZES[0]!
  const click = (scene: Mounted, x: number, y: number): void => scene.push(`\x1b[<0;${x + 1};${y + 1}M\x1b[<0;${x + 1};${y + 1}m`)
  const at = (lines: string[], words: string): { x: number; y: number } => {
    const y = lines.findIndex(line => line.includes(words))
    return { x: Array.from((lines[y] ?? '').slice(0, (lines[y] ?? '').indexOf(words))).length + 1, y }
  }
  const typingBox = (lines: string[]): string => lines.find(line => line.includes('Type a prompt')) ?? ''
  const { noSessionConnector } = await import('../../src/engine/connector/noSessionConnector.ts')
  const { setFocusedSessionConnector, releaseFocusedSessionConnector } = await import('../../src/engine/connector/focusedConnector.ts')
  const roster = { rows: Array.from({ length: 6 }, (_, index) => ({ id: `mon-${index + 1}`, kind: 'monitor' as const, name: `monitor ${index + 1} watching build-${index + 1}.log`, status: 'running', startTime: Date.now() - (index + 1) * 60_000, command: `tail -f build-${index + 1}.log` })), mission: [], samples: [], reported: true }
  setFocusedSessionConnector(new Proxy(noSessionConnector(), {
    get(target, prop, receiver) {
      if (prop === 'workRoster') return () => roster
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as never)
  const cursorOn = (lines: string[]): string | undefined => lines.find(line => /❯ .*monitor \d watching/.test(line))?.match(/monitor (\d) watching/)?.[1]
  const runs = await mount(size, 'tasks', true)
  runs.scene.push('\r')
  await settledFrame(runs.scene, frame => frame.includes('Mercury — runs'))
  check(`runs keys ${size}: the popup lists the six runs with the cursor on the first`, cursorOn(runs.scene.lines()) === '1' && runs.scene.lines().some(line => line.includes('6 running')), `cursor on monitor ${cursorOn(runs.scene.lines())}`)
  runs.scene.push('\x1b[B')
  check(`runs keys ${size}: ↓ moves the cursor one row`, await settledFrame(runs.scene, frame => cursorOn(frame.split('\n')) === '2').catch(() => false), `cursor on monitor ${cursorOn(runs.scene.lines())}`)
  runs.scene.push('z')
  await settledFrame(runs.scene)
  check(`runs keys ${size}: a letter typed while it is open does not reach the typing box behind it`, typingBox(runs.scene.lines()) === typingBox(runs.before), `the typing box reads ${JSON.stringify(typingBox(runs.scene.lines()).trim())}`)
  const foot = at(runs.scene.lines(), '↑↓ move · pgup/pgdn page')
  click(runs.scene, foot.x, foot.y)
  check(`runs keys ${size}: a click on the keys row at its foot closes it`, await settledFrame(runs.scene, frame => !frame.includes('Mercury — runs')).catch(() => false), 'the popup is still open after the click')
  await unmount(runs.scene)
  releaseFocusedSessionConnector()
  const prompts = await mount(size, null, true)
  setModal(await workbenchCommand.call(() => setModal(null), context, ''))
  await settledFrame(prompts.scene, frame => frame.includes('Mercury — prompts'))
  prompts.scene.push('3')
  check(`prompts keys ${size}: the section key 3 opens the saved prompts`, await settledFrame(prompts.scene, frame => frame.includes('no saved prompts yet')).catch(() => false), 'the saved prompts hint was not drawn after 3')
  const first = at(prompts.scene.lines(), '1 PROMPTS')
  click(prompts.scene, first.x, first.y)
  check(`prompts keys ${size}: a click on the section PROMPTS goes back to it`, await settledFrame(prompts.scene, frame => frame.includes('no prompts sent in this chat yet')).catch(() => false), `clicked ${first.x},${first.y}; the prompts hint was not drawn after the click`)
  prompts.scene.push('z')
  await settledFrame(prompts.scene)
  check(`prompts keys ${size}: a letter typed while it is open does not reach the typing box behind it`, typingBox(prompts.scene.lines()) === typingBox(prompts.before), `the typing box reads ${JSON.stringify(typingBox(prompts.scene.lines()).trim())}`)
  await unmount(prompts.scene)
}
if (only === undefined || only === 'quiet') {
  process.env.MERCURY_RECESS = '1'
  const size = SIZES[0]!
  const ink = (shot: Scene): string => JSON.stringify(shot.scene.styleAt(shot.host.left + 2, shot.host.bottom))
  const behindCrew = await mount(size)
  const loud = ink(behindCrew)
  crew.openCrewView()
  await settledFrame(behindCrew.scene, frame => frame.includes('Mercury — crew'))
  const quiet = ink(behindCrew)
  await unmount(behindCrew.scene)
  check(`quiet backdrop ${size}: with the crew popup open the transcript behind it is drawn one step quieter`, quiet !== loud, `the transcript's ink is ${loud} with and without the crew popup`)
  for (const popup of [
    { route: '/runs', title: 'Mercury — runs', open: () => runsCommand.call(() => setModal(null), context, '') },
    { route: '/workbench', title: 'Mercury — prompts', open: () => workbenchCommand.call(() => setModal(null), context, '') },
  ]) {
    const behind = await mount(size)
    setModal(await popup.open())
    await settledFrame(behind.scene, frame => frame.includes(popup.title))
    check(`quiet backdrop ${size}: behind ${popup.route} the transcript is as quiet as behind the crew popup`, ink(behind) === quiet, `the transcript's ink is ${ink(behind)}, behind the crew popup ${quiet}, with no popup ${loud}; the door makes a carried popup the raised surface in src/screen/fullscreen-layout/frame.tsx (surfaceRef)`)
    await unmount(behind.scene)
  }
  process.env.MERCURY_RECESS = '0'
}
{
  const { PromptOverlayProvider, usePromptOverlayDialog, useSetPromptOverlayDialog } = await import('../../src/screen/overlays/promptOverlay.tsx')
  let mounts = 0
  let renderAgain: () => void = () => {}
  function Kept({ label }: { label: string }): React.ReactNode {
    const [born] = React.useState(() => ++mounts)
    return h(Text, null, `${label} born ${born}`)
  }
  function Hands(): React.ReactNode {
    const [turn, setTurn] = React.useState(0)
    renderAgain = () => setTurn(value => value + 1)
    useSetPromptOverlayDialog(React.useMemo(() => h(Kept, { label: `handed ${turn}` }), [turn]))
    return null
  }
  function Carries(): React.ReactNode {
    return usePromptOverlayDialog()
  }
  const scene = await mountOffscreen(h(PromptOverlayProvider, null, h(Hands), h(Carries)), 60, 6)
  const handed = await settledFrame(scene, frame => frame.includes('handed 0 born 1')).catch(() => false)
  renderAgain()
  renderAgain()
  const again = handed && await settledFrame(scene, frame => frame.includes('handed 2')).catch(() => false)
  check('a popup the composer hands to the door is kept, not opened anew, when the composer draws again', again && mounts === 1 && scene.lines().some(line => line.includes('handed 2 born 1')), `the handed popup was mounted ${mounts} times and the frame reads ${JSON.stringify(scene.lines().join(' ').trim())}; useSetPromptOverlayDialog in src/screen/overlays/promptOverlay.tsx must hand the new element without first handing null in a draw of its own`)
  scene.unmount()
}
await releaseScratchHome(HOME)
console.log(`popups-open-in-the-middle: ${checks} checks, ${failures} failed; ${SIZES.length} sizes`)
process.exit(failures === 0 ? 0 : 1)
