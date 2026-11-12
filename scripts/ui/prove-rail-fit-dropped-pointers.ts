import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome } from '../lib/settingsPopupHarness.ts'
import { settledFrame } from './popupFrameSettle.ts'

pinSourceRef()
const HOME = pinScratchHome('rail-fit-dropped-pointers')
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
const { resetChromeModeLatchForTests, layoutChromeLive } = await import('../../src/hooks/useLayoutTier.ts')
const { initializeSurfaceRoute, ROOT_CHAT_ROUTE } = await import('../../src/context/surfaceRoute.ts')
const { resetOverlayStackForTests } = await import('../../src/context/overlayStack.ts')
const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/utils/config.ts')
const { buildLanesModel } = await import('../../src/utils/cockpit/helmLanesModel.ts')
const { resetHelmFocusForTest } = await import('../../src/utils/cockpit/helmFocus.ts')
const { resolveMercuryTokens } = await import('../../src/utils/mercuryTokens.ts')
const { createTaskStateBase } = await import('../../src/Task.ts')
enableConfigs()
saveCurrentProjectConfig(config => ({ ...config, hasCompletedProjectOnboarding: true }))
saveGlobalConfig(config => ({ ...config, prStatusFooterEnabled: false }))

const tok = resolveMercuryTokens('dark', '#88c0d0')

{
  resetHelmFocusForTest()
  const shellRun = {
    ...createTaskStateBase({ task_id: 's1', task_type: 'local_bash', description: 'build', call_id: 'toolu_s1' }),
    type: 'local_bash' as const,
    status: 'running' as const,
    command: 'bun run build',
    description: 'build',
    startTime: 1_700_000_000_000,
    outputFile: '/tmp/out',
  }
  const baseBusy = {
    width: 30,
    mergedVitals: false,
    activity: 'active' as const,
    sessionCrew: [],
    viewingAgentTaskId: undefined,
    mainChatTaskId: undefined,
    tasks: { s1: shellRun as never },
    roster: { rows: [] },
    workRunSnap: null,
    ledger: [],
    lastSentPrompt: null,
    filesOff: false,
    filesFolder: 'screens',
    recent: [],
    missionCondition: null,
    wakeGlance: null,
    glance: null,
    nowMs: 1_700_000_005_000,
    tok,
    accent: '#88c0d0',
  }

  const cursorHeldNoPriorShed = buildLanesModel({
    ...baseBusy,
    availRows: 10,
    cursorRow: { kind: 'command', command: '/workbench', label: 'workbench:last' },
  })
  check(
    'lanes model: when nothing was shed before the fit pass and FILES is dropped, pointer names /browse',
    cursorHeldNoPriorShed.pointer === '  more: /browse' && cursorHeldNoPriorShed.sections.map(s => s.key).join(',') === 'runs,workbench',
    `pointer=${JSON.stringify(cursorHeldNoPriorShed.pointer)} sections=${cursorHeldNoPriorShed.sections.map(s => s.key).join(',')}`,
  )

  const runsAndFilesDropped = buildLanesModel({
    ...baseBusy,
    availRows: 4,
    cursorRow: { kind: 'command', command: '/workbench', label: 'workbench:last' },
  })
  check(
    'lanes model: when RUNS, WORKBENCH and FILES are dropped at 4 rows, pointer names /runs · /workbench · /browse',
    runsAndFilesDropped.pointer === '  more: /runs · /workbench · /browse',
    `pointer=${JSON.stringify(runsAndFilesDropped.pointer)}`,
  )

  const workAndWorkbenchDedup = buildLanesModel({
    ...baseBusy,
    availRows: 4,
    cursorRow: undefined,
    workRunSnap: {
      runId: 'r1',
      owner: 'main',
      objective: 'verify rails',
      phase: 'executing',
      lifecycle: 'active',
      substantive: true,
      deliverables: [{ id: 'd1', title: 'rails', state: 'in-progress' }],
      verification: { state: 'unverified', summary: '' },
      changedPaths: [],
      totalChangedPaths: 0,
      unresolvedBadEffects: 0,
      updatedAtMs: 1_700_000_005_000,
    } as never,
  })
  check(
    'lanes model: WORK and WORKBENCH deduplicate to one /workbench alongside /runs and /browse',
    workAndWorkbenchDedup.pointer === '  more: /workbench · /runs · /browse',
    `pointer=${JSON.stringify(workAndWorkbenchDedup.pointer)}`,
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
    await settledFrame(scene, frame => frame.includes(CARD) && frame.includes(BAND.repeat(8)))
    for (const paneRows of [4, 6, 9, 10] as const) {
      scene.resize(wrap(h(Harness, { columns, cardRows: rows - paneRows })), columns, rows)
      await settledFrame(scene, frame => frame.includes(CARD) && (frame.split('\n')[paneRows] ?? '').startsWith('╭' + '─'.repeat(columns - 2) + '╮'))
      const lines = scene.lines()
      if (frameDir) writeFileSync(join(frameDir, `${tag}-pane-${paneRows}.txt`), lines.join('\n') + '\n')
      const paneLeft = (lines[0] ?? '').indexOf('╭')
      const paneRight = (lines[0] ?? '').indexOf('╮', paneLeft + 1)
      const leftText = lines.slice(0, paneRows).map(line => line.slice(0, paneLeft).trimEnd()).join('\n')
      const rightRows = lines.slice(0, paneRows).map(line => line.slice(paneRight + 1).trimEnd())
      const rightText = rightRows.join('\n')
      const danglingSep = [...lines.slice(0, paneRows).map(l => l.slice(0, paneLeft).trimEnd()), ...rightRows].some(r => /[·—]\s*…?$/.test(r))
      check(`${tag}, pane ${paneRows}: no rail pointer line ends on a dangling separator`, !danglingSep, `${leftText} || ${rightText}`)

      if (paneRows === 4) {
        check(
          `${tag}, pane 4: lanes rail names /workbench, /help and /browse across its free rows`,
          leftText.includes('/workbench') && leftText.includes('/help') && leftText.includes('/browse'),
          leftText,
        )
        check(
          `${tag}, pane 4: vitals rail names /health, /usage and /workflows across its free rows`,
          rightText.includes('short height — /health') && rightText.includes('/usage') && rightText.includes('/workflows'),
          rightText,
        )
      }
      if (paneRows === 6) {
        check(
          `${tag}, pane 6: vitals rail names /health, /usage and /workflows while no box fits`,
          rightText.includes('short height — /health') && rightText.includes('/usage') && rightText.includes('/workflows'),
          rightText,
        )
      }
      if (paneRows === 9) {
        check(
          `${tag}, pane 9: vitals rail with 1 free row marks that more than /health was dropped`,
          rightText.includes('short height — /health…'),
          rightText,
        )
      }
      if (paneRows === 10) {
        check(
          `${tag}, pane 10: vitals rail with 2 free rows names both /health and /workflows`,
          rightText.includes('short height — /health') && rightText.includes('/workflows'),
          rightText,
        )
      }
    }
  } finally {
    scene.unmount()
  }
}

console.log(`rail-fit-dropped-pointers: ${checks} checks, ${failures} failed`)
await releaseScratchHome(HOME)
process.exit(failures ? 1 : 0)
