#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mountOffscreen } from '../lib/settingsPopupHarness.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
delete process.env.NO_COLOR
process.env.FORCE_COLOR = '3'
const HOME = mkdtempSync(join(tmpdir(), 'rail-first-box-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_FULLSCREEN = '1'
process.env.MERCURY_HELM_HOME = '1'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.MERCURY_BOOT_PREFLIGHT = '0'
process.env.MERCURY_LIVE_GLYPHS = '0'
process.env.MERCURY_LIVE_CLOCK = '0'
process.env.MERCURY_REDUCED_MOTION = '1'
process.env.MERCURY_CRITTER_IDLE = '0'
process.env.MERCURY_CRITTER_GAZE = '0'
process.env.MERCURY_CRITTER_SLEEP = '0'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_OPERATOR = 'sam'
process.env.BROWSER = '/usr/bin/true'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
for (const base of ['ANTHROPIC_BASE_URL', 'MERCURY_OPENAI_API_BASE', 'MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_OPENAI_AUTH_BASE', 'MERCURY_OPENROUTER_API_BASE', 'MERCURY_GEMINI_API_BASE', 'MERCURY_MOONSHOT_API_BASE', 'MERCURY_MOONSHOT_CODING_BASE', 'MERCURY_DEEPSEEK_API_BASE', 'MERCURY_HUGGINGFACE_HUB_BASE', 'MERCURY_HUGGINGFACE_API_BASE', 'MERCURY_ZAI_API_BASE']) process.env[base] = 'http://127.0.0.1:1'
for (const key of ['MERCURY_MODEL', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'HF_TOKEN', 'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY', 'NODE_ENV']) delete process.env[key]

const SESSION_ID = 'rail-first-box-session'
const SIZES: Array<[number, number]> = [[178, 51], [120, 40], [80, 21]]
const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
const frameDir = arg('--frames')
if (frameDir !== undefined) mkdirSync(frameDir, { recursive: true })
let failures = 0
let checks = 0
function check(label: string, good: boolean, detail = ''): void {
  checks++
  if (!good) failures++
  console.log(`[${good ? 'PASS' : 'FAIL'}] ${label}${!good && detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms: number): Promise<void> => new Promise<void>(resolve => setTimeout(resolve, ms))
async function until(predicate: () => boolean, ms = 15000): Promise<boolean> {
  let expired = false
  const timer = setTimeout(() => { expired = true }, ms)
  while (!predicate() && !expired) await sleep(10)
  clearTimeout(timer)
  return predicate()
}
const faults: string[] = []
const originalError = console.error
console.error = (...args: unknown[]): void => { faults.push(args.map(String).join(' ')); originalError(...args) }
const hardLimit = setTimeout(() => { console.error('rail-first-box exceeded its deadline'); process.exit(1) }, 120_000)
hardLimit.unref()

const NOW = Date.now()
type RosterRow = Record<string, unknown> & { id: string; status: string }
const CREW: Array<[string, number]> = [['atlas', 940], ['fjord', 840]]
const rosterRows = (): RosterRow[] =>
  CREW.map(([name, context], index) => ({
    id: `a-${name}`,
    agentId: `a-${name}`,
    kind: 'agent' as const,
    name,
    status: 'running',
    startTime: NOW - 120_000 + index * 1000,
    model: 'claude-opus-5-5',
    agentType: 'mercury-crew',
    inputTokens: context - 40,
    outputTokens: 40,
    totalTokens: context,
    contextTokens: context,
    activity: `Sleeping for ${287 - index}s`,
    phase: { phase: 'tool' as const, sinceMs: NOW - 27_000 },
  }))
const workListeners = new Set<() => void>()
const roster = { rows: rosterRows(), mission: [], samples: [], reported: true }

const React = await import('react')
const { Text } = await import('../../src/screen/themedRenderer.ts')
const { App } = await import('../../src/boot/App.tsx')
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
const { KeybindingSetup } = await import('../../src/screen/keys/KeybindingProviderSetup.tsx')
const { FullscreenLayout } = await import('../../src/screen/fullscreen-layout/FullscreenLayout.tsx')
const { default: Composer } = await import('../../src/screen/composer/Composer.tsx')
const { useCompactWorkControls } = await import('../../src/screen/tasks/CompactWorkSummary.tsx')
const { GlobalKeybindingHandlers } = await import('../../src/screen/chat/useGlobalKeybindings.tsx')
const { resetChromeModeLatchForTests } = await import('../../src/screen/fullscreen-layout/useLayoutTier.ts')
const { initializeSurfaceRoute, ROOT_CHAT_ROUTE } = await import('../../src/screen/routes/surfaceRoute.ts')
const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/platform/settings/config.ts')
enableConfigs()
saveCurrentProjectConfig(config => ({ ...config, hasCompletedProjectOnboarding: true }))
saveGlobalConfig(config => ({ ...config, prStatusFooterEnabled: false }))
const pending = await import('../../src/screen/composer/input-core/pending-input.ts')
const { noSessionConnector } = await import('../../src/engine/connector/noSessionConnector.ts')
const { setFocusedSessionConnector } = await import('../../src/engine/connector/focusedConnector.ts')
const { resetHelmFocusForTest } = await import('../../src/screen/cockpit/helmFocus.ts')
const { railPlanAt } = await import('../../src/screen/fullscreen-layout/helmGeometry.ts')
const { resolveMercuryTokens } = await import('../../src/screen/theme/mercuryTokens.ts')
const h = React.createElement

type CellInk = { fg: string; bold: boolean }
function colorToSgrFg(color: string): string {
  const m = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(color)
  if (m) return `38;2;${m[1]};${m[2]};${m[3]}`
  const hex = color.replace(/^#/, '')
  return `38;2;${parseInt(hex.slice(0, 2), 16)};${parseInt(hex.slice(2, 4), 16)};${parseInt(hex.slice(4, 6), 16)}`
}
const darkTokens = resolveMercuryTokens('dark', '#dd4444')
const INFO_FG = colorToSgrFg(darkTokens.info)
const MUTED_FG = colorToSgrFg(darkTokens.textMuted)

const resting = noSessionConnector() as unknown as Record<string, unknown>
const overrides: Record<string, unknown> = {
  sessionId: () => SESSION_ID,
  workRoster: () => roster,
  subscribeWork: (listener: () => void) => { workListeners.add(listener); return () => { workListeners.delete(listener) } },
  interrupt: () => false,
}
const fake = new Proxy(resting, {
  get(target, key) {
    if (typeof key === 'string' && key in overrides) return overrides[key]
    const value = Reflect.get(target, key, target)
    return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
  },
})
setFocusedSessionConnector(fake as never)

function Transcript(): React.ReactNode {
  return h(Text, null, Array.from({ length: 3 }, (_, index) => `13:00:0${index + 1} [sam] ❯ task ${index + 1}`).join('\n'))
}
async function renderAt(columns: number, rows: number): Promise<{ lines: string[]; wordInk: Array<CellInk | null>; countInk: CellInk | null; titleClickDispatch: string | null }> {
  initializeSurfaceRoute(ROOT_CHAT_ROUTE)
  resetChromeModeLatchForTests()
  resetHelmFocusForTest()
  pending.edit('')
  pending.setMode('prompt')
  const submitted: string[] = []
  const insertRef = { current: null } as React.MutableRefObject<NonNullable<import('../../src/screen/composer/Composer.tsx').ComposerProps['insertTextRef']>['current']>
  function Harness(): React.ReactNode {
    const { controls, focus } = useCompactWorkControls()
    const [vimMode, setVimMode] = React.useState<'INSERT' | 'NORMAL'>('INSERT')
    const [searching, setSearching] = React.useState(false)
    const [help, setHelp] = React.useState(false)
    const [bashes, setBashes] = React.useState<string | boolean>(false)
    const [screen, setScreen] = React.useState('prompt')
    return h(KeybindingSetup, null,
      h(GlobalKeybindingHandlers, { screen, setScreen, showAllInTranscript: false, setShowAllInTranscript: () => {}, messageCount: 0, compactWork: controls } as never),
      h(FullscreenLayout, {
        scrollable: h(Transcript),
        statusBand: h(Text, null, 'waiting on 2 crewmates'),
        statusBandActive: true,
        bottom: h(Composer, {
          compactWork: controls, compactFocus: focus,
          debug: false, toolPermissionContext: getDefaultAppState().toolPermissionContext,
          setToolPermissionContext: () => {}, apiKeyStatus: 'valid', commands: [], agents: [],
          isLoading: false, verbose: false, submitCount: 1, onShowRewindPicker: () => {},
          mcpClients: [], vimMode, setVimMode, showBashesDialog: bashes, setShowBashesDialog: setBashes,
          onExit: () => {}, getToolUseContext: () => ({} as never),
          onSubmit: async (input: string) => { submitted.push(input) },
          isSearchingHistory: searching, setIsSearchingHistory: setSearching, helpOpen: help, setHelpOpen: setHelp,
          hasSuppressedDialogs: false, isLocalJSXCommandActive: false, insertTextRef: insertRef,
        } as never),
      } as never),
    )
  }
  const scene = await mountOffscreen(h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined } as never, h(Harness)), columns, rows, { mouseTracking: true })
  try {
    const painted = await until(() => insertRef.current !== null && scene.screen().includes('Type a prompt'))
    check(`${columns}x${rows}: the layout paints its composer placeholder`, painted, scene.screen().slice(0, 400) + ' | the layout never painted the Type a prompt placeholder within 15 s; check the composer in src/screen/composer/Composer.tsx and the FullscreenLayout mount')
    let last = ''
    let stable = 0
    const deadline = Date.now() + 8000
    while (stable < 12 && Date.now() < deadline) {
      await sleep(50)
      const next = scene.screen()
      stable = next === last ? stable + 1 : 0
      last = next
    }
    const plain = scene.lines()
    const lanesW = railPlanAt(columns, true).lanesW
    const titleRowIdx = lanesW > 0 ? plain.findIndex(line => line.slice(0, lanesW).includes('crew 2')) : -1
    const crewCol = titleRowIdx >= 0 ? plain[titleRowIdx]!.slice(0, lanesW).indexOf('crew 2') : -1
    const wordInk: Array<CellInk | null> =
      titleRowIdx >= 0 && crewCol >= 0
        ? [0, 1, 2, 3].map(dx => {
            const s = scene.styleAt(crewCol + dx, titleRowIdx)
            return s ? { fg: s.fg, bold: s.bold } : null
          })
        : []
    const rawCount = titleRowIdx >= 0 && crewCol >= 0 ? scene.styleAt(crewCol + 5, titleRowIdx) : null
    const countInk: CellInk | null = rawCount ? { fg: rawCount.fg, bold: rawCount.bold } : null
    let titleClickDispatch: string | null = null
    if (columns >= 150 && titleRowIdx >= 0 && crewCol >= 0) {
      submitted.length = 0
      const x = crewCol + 5 + 1
      const y = titleRowIdx + 1
      scene.push(`\x1b[<0;${x};${y}M`)
      await sleep(40)
      scene.push(`\x1b[<0;${x};${y}m`)
      await until(() => submitted.length > 0, 1500)
      titleClickDispatch = submitted[0] ?? null
    }
    return { lines: plain, wordInk, countInk, titleClickDispatch }
  } finally {
    scene.unmount()
  }
}

const railHeaders = (lines: string[], width: number): string[] =>
  lines
    .map(line => line.slice(0, width))
    .map(slice => /^│ \S ([a-z]+(?: \d+)?)(?:\s·\s|\s*│)/.exec(slice)?.[1] ?? null)
    .filter((label): label is string => label !== null)

for (const [columns, rows] of SIZES) {
  const { lines, wordInk, countInk, titleClickDispatch } = await renderAt(columns, rows)
  if (frameDir !== undefined) writeFileSync(join(frameDir, `rail-first-box-${columns}x${rows}.txt`), `${lines.join('\n')}\n`)
  const frame = lines.join('\n')
  check(`${columns}x${rows}: no SEAT box paints anywhere`, !/SEAT ·/.test(frame) && !/\bSEAT\b/.test(frame), 'a SEAT box still paints in the rail; remove it from the sections built in src/screen/cockpit-gauges/helm-lanes-model/sections.ts')
  check(`${columns}x${rows}: no seat self row paints (no "(you)" row, no peer count)`, !/\(you\)/.test(frame) && !/\d+ peers?\b/.test(frame), 'a seat self row or peer count still paints; remove it from the rail rows in src/screen/cockpit-gauges/helm-lanes-model/sections.ts')
  if (columns >= 100) {
    const wordOk = wordInk.length === 4 && wordInk.every(c => c !== null && c.fg === INFO_FG && c.bold === true)
    const countOk = countInk !== null && countInk.fg === MUTED_FG && countInk.bold === false
    check(
      `${columns}x${rows}: crew title paints "crew" in info bold and the count "2" in muted grey non-bold`,
      wordOk && countOk,
      `word=${JSON.stringify(wordInk)} count=${JSON.stringify(countInk)} wantInfo=${INFO_FG} wantMuted=${MUTED_FG}`,
    )
    check(`${columns}x${rows}: the crew rows stand in the CREW section`, /✶ Mercury Lead/.test(frame) && /atlas/.test(frame) && /fjord/.test(frame), 'the roster rows (Mercury Lead, atlas, fjord) are missing from the CREW section; check the crew rows built in src/screen/cockpit-gauges/helm-lanes-model/sections.ts')
  }
  if (columns >= 150) {
    const lanesW = railPlanAt(columns, true).lanesW
    const headers = railHeaders(lines, lanesW)
    check(`${columns}x${rows}: both rails start their first box on row 0 level with the centre pane (no Lanes or Vitals banner)`, (lines[0] ?? '').startsWith('╭') && !(lines[0] ?? '').includes('lanes') && !(lines[0] ?? '').includes('vitals') && (lines[0] ?? '').endsWith('╮'), (lines[0] ?? '') + ' | row 0 must carry the top borders of both rails level with the centre pane, with no Lanes or Vitals heading')
    check(`${columns}x${rows}: the rail's first box is crew 2`, headers[0] === 'crew 2', `boxes: ${headers.join(' › ') || 'none'} | put the CREW section (crewSection area in src/screen/cockpit-gauges/helm-lanes-model/sections.ts) first in the rail order`)
    check(`${columns}x${rows}: clicking the count in the crew 2 title still dispatches /crewmates`, titleClickDispatch === '/crewmates', `dispatched=${JSON.stringify(titleClickDispatch)}`)
  } else if (columns < 100) {
    check(`${columns}x${rows}: the narrow layout paints no lanes rail`, !(lines[0] ?? '').startsWith('╭') && !frame.includes('crew 2'), (lines[0] ?? '') + ' | a lanes rail paints at this narrow width; check railPlanAt in src/screen/fullscreen-layout/helmGeometry.ts so it returns no lanes width below 100 columns')
  }
}
console.error = originalError
clearTimeout(hardLimit)
check('no render or hook-order fault occurred', !faults.some(line => /render fault|Rendered (?:more|fewer) hooks|Minified React error/.test(line)), faults.join('\n') + '\nconsole.error printed a render or hook-order fault; read the fault text above and fix the component it names')
rmSync(HOME, { recursive: true, force: true })
console.log(`rail-first-box: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
