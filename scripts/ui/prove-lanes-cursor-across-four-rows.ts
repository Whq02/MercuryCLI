import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome } from '../lib/settingsPopupHarness.ts'
import { settledFrame } from './popupFrameSettle.ts'

pinSourceRef()
const HOME = pinScratchHome('lanes-cursor-across-four-rows')
delete process.env.MERCURY_HOME
delete process.env.MERCURY_EFFORT_LEVEL
process.env.MERCURY_TMPDIR = join(HOME, 'tmp')
process.env.MERCURY_HEALTH_STATE_DIR = join(HOME, 'health-state')
mkdirSync(process.env.MERCURY_TMPDIR, { recursive: true })
Object.assign(process.env, {
  MERCURY_FULLSCREEN: '1',
  MERCURY_HELM_HOME: '1',
  MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  MERCURY_BOOT_PREFLIGHT: '0',
  MERCURY_REDUCED_MOTION: '1',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key',
  BROWSER: '/usr/bin/true',
})
for (const base of [
  'ANTHROPIC_BASE_URL',
  'MERCURY_OPENAI_API_BASE',
  'MERCURY_OPENAI_CHATGPT_BASE',
  'MERCURY_OPENAI_AUTH_BASE',
  'MERCURY_OPENROUTER_API_BASE',
  'MERCURY_GEMINI_API_BASE',
  'MERCURY_MOONSHOT_API_BASE',
  'MERCURY_MOONSHOT_CODING_BASE',
  'MERCURY_ZAI_API_BASE',
  'MERCURY_DEEPSEEK_API_BASE',
  'MERCURY_HUGGINGFACE_API_BASE',
]) {
  process.env[base] = 'http://127.0.0.1:9'
}
for (const key of ['MERCURY_MODEL', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'HF_TOKEN', 'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY', 'NODE_ENV']) {
  delete process.env[key]
}

const arg = (key: string): string | undefined => (process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : undefined)
const frameDir = arg('--frames')
if (frameDir) mkdirSync(frameDir, { recursive: true })

const LANES_CURSOR_HINT = 'to fix, change how the lanes cursor is remembered when the rail rows are unpublished and published again (publishHelmRows and moveHelmCursor in src/screen/cockpit/helmFocus.ts); for a frame mismatch, look at how the lanes pane resizes in src/screen/fullscreen-layout/FullscreenLayout.tsx'

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}${!ok ? ` — ${LANES_CURSOR_HINT}` : ''}`)
}

const React = await import('react')
const h = React.createElement
const { Box, Text } = await import('../../src/screen/themedRenderer.ts')
const { App } = await import('../../src/boot/App.tsx')
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
const { KeybindingSetup } = await import('../../src/screen/keys/KeybindingProviderSetup.tsx')
const { FullscreenLayout } = await import('../../src/screen/fullscreen-layout/FullscreenLayout.tsx')
const { resetChromeModeLatchForTests, layoutChromeLive } = await import('../../src/screen/fullscreen-layout/useLayoutTier.ts')
const { initializeSurfaceRoute, ROOT_CHAT_ROUTE } = await import('../../src/screen/routes/surfaceRoute.ts')
const { resetOverlayStackForTests } = await import('../../src/screen/overlays/overlayStack.ts')
const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/platform/settings/config.ts')
const {
  currentHelmRow,
  getHelmCursor,
  getHelmRows,
  moveHelmCursor,
  publishHelmRows,
  resetHelmFocusForTest,
  setHelmFocus,
} = await import('../../src/screen/cockpit/helmFocus.ts')
type HelmRow = import('../../src/screen/cockpit/helmFocus.ts').HelmRow
enableConfigs()
saveCurrentProjectConfig(config => ({ ...config, hasCompletedProjectOnboarding: true }))
saveGlobalConfig(config => ({ ...config, prStatusFooterEnabled: false }))

{
  resetHelmFocusForTest()
  const rows3: HelmRow[] = [
    { kind: 'command', command: '/workbench', label: 'workbench:last' },
    { kind: 'command', command: '/health', label: 'hint:/health' },
    { kind: 'files', label: 'files:browse' },
  ]
  publishHelmRows('lanes', rows3)
  moveHelmCursor('lanes', 2)
  check('helmFocus: cursor moved to row 2 before shrinking to empty', getHelmCursor('lanes') === 2 && currentHelmRow('lanes')?.label === 'files:browse')
  publishHelmRows('lanes', [])
  check('helmFocus: empty publish clamps active index to 0 with no rows', getHelmCursor('lanes') === 0 && getHelmRows('lanes').length === 0)
  publishHelmRows('lanes', rows3)
  check(
    'helmFocus: growing back from empty restores the remembered row 2 cursor',
    getHelmCursor('lanes') === 2 && currentHelmRow('lanes')?.label === 'files:browse',
    `cursor=${getHelmCursor('lanes')} row=${JSON.stringify(currentHelmRow('lanes'))}`,
  )
}

const SOLID = 'T'
const BAND = 'B'
const CARD = 'the card that takes the rows'
function Harness({ columns, cardRows }: { columns: number; cardRows: number }): React.ReactNode {
  return h(FullscreenLayout, {
    scrollable: h(Box, { flexDirection: 'column' }, ...Array.from({ length: 120 }, (_, key) => h(Text, { key, wrap: 'truncate-end' }, SOLID.repeat(columns)))),
    statusBand: h(Text, { wrap: 'truncate-end' }, BAND.repeat(columns)),
    statusBandActive: false,
    bottom: h(Box, { height: cardRows, flexShrink: 0, borderStyle: 'round', flexDirection: 'column' }, h(Text, { wrap: 'truncate-end' }, CARD)),
  } as never)
}
const wrap = (node: React.ReactNode): React.ReactNode => h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined } as never, h(KeybindingSetup, null, node))

for (const [columns, rows] of [[160, 50], [177, 49], [213, 60]] as const) {
  const tag = `${columns}x${rows}`
  resetHelmFocusForTest()
  resetChromeModeLatchForTests()
  resetOverlayStackForTests()
  initializeSurfaceRoute(ROOT_CHAT_ROUTE)
  layoutChromeLive(columns, rows)
  const scene = await mountOffscreen(wrap(h(Harness, { columns, cardRows: 3 })), columns, rows)
  try {
    const resizePane = async (paneRows: number): Promise<string[]> => {
      scene.resize(wrap(h(Harness, { columns, cardRows: rows - paneRows })), columns, rows)
      await settledFrame(scene, frame => frame.includes(CARD) && (frame.split('\n')[paneRows] ?? '').startsWith('╭' + '─'.repeat(columns - 2) + '╮'))
      return scene.lines()
    }
    const resizeRest = async (): Promise<string[]> => {
      scene.resize(wrap(h(Harness, { columns, cardRows: 3 })), columns, rows)
      await settledFrame(scene, frame => frame.includes(CARD) && frame.includes(BAND.repeat(8)))
      return scene.lines()
    }

    await settledFrame(scene, frame => frame.includes(CARD) && frame.includes(BAND.repeat(8)))
    const direct6 = (await resizePane(6)).join('\n')
    await resizeRest()
    const direct12 = (await resizePane(12)).join('\n')
    await resizeRest()

    const fourLines = await resizePane(4)
    if (frameDir) writeFileSync(join(frameDir, `${tag}-pane-4.txt`), fourLines.join('\n') + '\n')
    const fourRailWhole =
      /^╭─+╮╭/.test(fourLines[0] ?? '') &&
      /^│[^│]*workbench[^│]*││/.test(fourLines[1] ?? '') &&
      /^│[^│]*no prompts yet[^│]*││/.test(fourLines[2] ?? '') &&
      /^╰─+╯╰/.test(fourLines[3] ?? '')
    check(
      `${tag}: at 4 rows the lanes rail paints one whole workbench box and publishes only workbench:last`,
      fourRailWhole && getHelmRows('lanes').length === 1 && getHelmRows('lanes')[0]?.label === 'workbench:last',
      `whole=${fourRailWhole} rows=${JSON.stringify(getHelmRows('lanes'))}`,
    )
    await resizeRest()

    const threeLines = await resizePane(3)
    if (frameDir) writeFileSync(join(frameDir, `${tag}-pane-3.txt`), threeLines.join('\n') + '\n')
    const threeRailNoBox = !threeLines.slice(0, 3).some(l => l.startsWith('╭') || l.startsWith('╰'))
    check(
      `${tag}: shrinking to 3 rows unpublishes all lanes rows`,
      getHelmRows('lanes').length === 0 && threeRailNoBox,
      `noBox=${threeRailNoBox} rows=${JSON.stringify(getHelmRows('lanes'))}`,
    )
    const afterThree6Lines = await resizePane(6)
    if (frameDir) writeFileSync(join(frameDir, `${tag}-pane-6-after-3.txt`), afterThree6Lines.join('\n') + '\n')
    check(
      `${tag}: growing from 3 rows to 6 keeps the resting workbench:last row instead of switching to files:browse`,
      getHelmRows('lanes').length === 1 && getHelmRows('lanes')[0]?.label === 'workbench:last' && afterThree6Lines.join('\n') === direct6,
      `rows=${JSON.stringify(getHelmRows('lanes'))}`,
    )

    const afterThree12Lines = await resizePane(12)
    if (frameDir) writeFileSync(join(frameDir, `${tag}-pane-12-after-3.txt`), afterThree12Lines.join('\n') + '\n')
    check(
      `${tag}: growing through 3 rows to 12 matches a direct resize from rest to 12 byte for byte`,
      afterThree12Lines.join('\n') === direct12,
      afterThree12Lines.slice(0, 12).map(l => l.slice(0, 30)).join('\n'),
    )

    await resizeRest()
    setHelmFocus('lanes')
    const lastIdx = getHelmRows('lanes').length - 1
    moveHelmCursor('lanes', lastIdx)
    check(`${tag}: focused cursor placed on files:browse`, getHelmCursor('lanes') === lastIdx && currentHelmRow('lanes')?.label === 'files:browse')
    await resizePane(3)
    await resizeRest()
    check(
      `${tag}: shrinking to 3 rows and growing back restores the focused files:browse cursor`,
      getHelmCursor('lanes') === lastIdx && currentHelmRow('lanes')?.label === 'files:browse',
      `cursor=${getHelmCursor('lanes')} row=${JSON.stringify(currentHelmRow('lanes'))}`,
    )
    resetHelmFocusForTest()
  } finally {
    scene.unmount()
  }
}

console.log(`lanes-cursor-across-four-rows: ${checks} checks, ${failures} failed`)
await releaseScratchHome(HOME)
process.exit(failures ? 1 : 0)
