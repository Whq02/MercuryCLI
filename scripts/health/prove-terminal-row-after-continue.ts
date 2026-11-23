#!/usr/bin/env bun
import { mountOffscreen, pinScratchHome, releaseScratchHome } from '../lib/settingsPopupHarness.ts'
import { settledFrame } from '../ui/popupFrameSettle.ts'

const HOME = pinScratchHome('terminal-row')
delete process.env.MERCURY_HOME
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_BOOT_PREFLIGHT = '0'
for (const name of ['TERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'COLORTERM', 'WT_SESSION', 'MSYSTEM', 'ConEmuANSI', 'TMUX', 'KITTY_WINDOW_ID', 'ZED_TERM', 'VTE_VERSION', 'MERCURY_FORCE_SYNC_OUTPUT']) delete process.env[name]

const React = await import('react')
const { Box } = await import('../../src/screen/themedRenderer.ts')
const { ThemeProvider } = await import('../../src/screen/theme/ThemeProvider.tsx')
const { AppStateProvider } = await import('../../src/screen/app-state/AppState.tsx')
const { KeybindingSetup } = await import('../../src/screen/keys/KeybindingProviderSetup.tsx')
const { ModalContext } = await import('../../src/screen/overlays/modalContext.tsx')
const { PopupFrameContext } = await import('../../src/screen/overlays/PopupGutter.tsx')
const { enableConfigs } = await import('../../src/platform/settings/config.ts')
const { MercuryHealthCertificate, healthPopupShape } = await import('../../src/commands/health/HealthCertificate.tsx')
const { BootHealthScreen } = await import('../../src/screen/boot-face/BootHealthScreen.tsx')
const { renderToString } = await import('../../src/screen/renderer/staticRender.tsx')
const { interfaceChecks } = await import('../../src/platform/health/sections/interface.ts')
const { runHealthReport } = await import('../../src/platform/health/healthReport.ts')
const { filterCertificateToCheck, summarizeCert } = await import('../../src/platform/health/healthCertCore.ts')
enableConfigs()
const h = React.createElement

const ROW = 'the status of the iface-terminal row in src/platform/health/sections/interface.ts must be warn when win32-first-class-host is the only required row the profile misses, and fail when it misses another required row'
const WORDS = 'the evidence, detail and fix of the iface-terminal row in src/platform/health/sections/interface.ts must stay as the profile gives them'
const REMEDY = 'Mercury looks right in Windows Terminal (stable) or the VS Code integrated terminal — PowerShell 7 preferred. You can continue here knowingly; the screen will not be the complete design.'

let checks = 0
let failures = 0
function check(label: string, good: boolean, detail = '', fix = ''): void {
  checks++
  if (!good) failures++
  console.log(`  [${good ? 'PASS' : 'FAIL'}] ${label}${!good && detail ? ` — ${detail}` : ''}${!good && fix ? ` — fix: ${fix}` : ''}`)
}

type Row = { status: string; evidence: string; detail?: string; fix?: string }
type Window = { platform?: 'win32'; release?: string; term?: string }
const OLD_CONSOLE: Window = { platform: 'win32', release: '10.0.22631' }
const BEFORE_CONPTY: Window = { platform: 'win32', release: '6.3.9600' }
const DUMB: Window = { term: 'dumb' }
const XTERM: Window = { term: 'xterm-256color' }

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const tty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
const os = require('node:os') as { release: () => string }
const release = os.release

const terminal = interfaceChecks().find(entry => entry.id === 'iface-terminal')!
function rowIn(window: Window): Row {
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
  if (window.platform !== undefined) Object.defineProperty(process, 'platform', { ...platform, value: window.platform })
  if (window.release !== undefined) os.release = () => window.release!
  if (window.term !== undefined) process.env.TERM = window.term
  try {
    return terminal.run() as Row
  } finally {
    if (tty) Object.defineProperty(process.stdout, 'isTTY', tty)
    else delete (process.stdout as { isTTY?: boolean }).isTTY
    Object.defineProperty(process, 'platform', platform)
    os.release = release
    delete process.env.TERM
  }
}

try {
  console.log('\n§1 the old Windows console, the window a user continues in at the terminal check')
  const row = rowIn(OLD_CONSOLE)
  check('the Terminal profile row reads warn there', row.status === 'warn', row.status, ROW)
  check('its evidence still says the profile is unsupported and names the host it is not', /^profile v\d+ unsupported/.test(row.evidence) && row.evidence.includes('missing: win32-first-class-host'), row.evidence, WORDS)
  check('its detail still names this window and what it lacks', (row.detail ?? '').includes('✕ this window (required) — the old Windows console — it names itself to nothing and does not draw frames atomically'), row.detail, WORDS)
  check('its fix is still the remedy', row.fix === REMEDY, row.fix, WORDS)

  console.log('\n§2 a certificate whose one row is that window')
  const cert = await runHealthReport({ depth: 'fast' }, [{ id: 'interface', title: 'INTERFACE', checks: () => [{ ...terminal, run: () => rowIn(OLD_CONSOLE) as never }] }])
  check('its verdict is caution: the window alone is never a fault', cert.verdict === 'caution', cert.verdict, ROW)
  const kept = summarizeCert(cert)
  check(
    'the summary kept in health/last-cert.json reads caution, counts no fail and lists the row as warn',
    kept.verdict === 'caution' && kept.counts.fail === 0 && kept.attention.some(entry => entry.id === 'iface-terminal' && entry.status === 'warn'),
    JSON.stringify({ verdict: kept.verdict, counts: kept.counts, attention: kept.attention.map(entry => `${entry.id}:${entry.status}`) }),
    ROW,
  )
  const only = filterCertificateToCheck(cert, 'iface-terminal')
  check('the verdict mercury health --json prints and exits on is caution, for the document and for --only iface-terminal', only?.verdict === 'caution', String(only?.verdict), ROW)

  console.log('\n§3 the two screens that head a certificate')
  const shape = healthPopupShape()
  const width = shape.width(120)
  const frameRows = shape.rows(36)
  const pane = await mountOffscreen(
    h(
      ThemeProvider,
      null,
      h(
        AppStateProvider,
        null,
        h(
          KeybindingSetup,
          null,
          h(
            Box,
            { width: 120, height: 36, flexDirection: 'column' },
            h(
              ModalContext.Provider,
              { value: { rows: frameRows, columns: width, scrollRef: null } },
              h(PopupFrameContext.Provider, { value: { rows: frameRows, width } }, h(MercuryHealthCertificate, { report: async () => cert as never, onClose: () => {} })),
            ),
          ),
        ),
      ),
    ),
    120,
    36,
  )
  try {
    await settledFrame(pane, frame => frame.includes('Mercury · health') && frame.includes('NEXT') && frame.includes('Terminal profile'))
    const lines = pane.lines()
    const head = lines.find(line => line.includes('Mercury · health')) ?? ''
    check('/health heads its pane ATTENTION, not FAILED', head.includes('ATTENTION') && !head.includes('FAILED'), head.trim(), ROW)
    check('…counts one warn and no fail', lines.some(line => line.includes('1 checks · 1 warn')) && !lines.some(line => /\d+ fail/.test(line)), lines.slice(0, 6).join(' | '), ROW)
    check('…and still gives the remedy under NEXT', lines.some(line => line.includes('▲ Mercury looks right in Windows Terminal')), lines.slice(0, 12).join(' | '), WORDS)
  } finally {
    pane.unmount()
  }
  const face = await renderToString(h(BootHealthScreen, { certificate: cert, fullScene: { columns: 120, rows: 40 } } as never), 120)
  check(
    "the Boot face's health screen gives the verdict as caution, not fault",
    face.includes('▲ caution') && face.includes('verdict caution') && !face.includes('fault'),
    face.split('\n').filter(line => /Verdict|verdict/.test(line)).join(' | '),
    ROW,
  )

  console.log('\n§4 a window that cannot draw the interface at all keeps the fail')
  const old = rowIn(BEFORE_CONPTY)
  check('a console older than Windows 10 1809 stays fail and names the era row', old.status === 'fail' && old.evidence.includes('missing: win32-conpty-host'), `${old.status}: ${old.evidence}`, ROW)
  if (platform.value !== 'win32') {
    const dumb = rowIn(DUMB)
    check('TERM=dumb stays fail with its own remedy', dumb.status === 'fail' && dumb.fix === 'Use a VT-capable terminal (TERM=dumb has no cursor addressing).', `${dumb.status}: ${dumb.fix}`, ROW)
    const xterm = rowIn(XTERM)
    check('a window that meets every required row is no caution', xterm.status === 'info' || xterm.status === 'ok', `${xterm.status}: ${xterm.evidence}`, ROW)
  }
} finally {
  await releaseScratchHome(HOME)
}

console.log(`\nprove-terminal-row-after-continue: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
