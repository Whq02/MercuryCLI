#!/usr/bin/env bun
import { mountOffscreen, pinScratchHome, releaseScratchHome, waitFor } from '../lib/settingsPopupHarness.ts'
import { settledFrame } from '../ui/popupFrameSettle.ts'

const HOME = pinScratchHome('health-next-lines')
delete process.env.MERCURY_HOME
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_BOOT_PREFLIGHT = '0'

const React = await import('react')
const { Box } = await import('../../src/screen/themedRenderer.ts')
const { ThemeProvider } = await import('../../src/screen/theme/ThemeProvider.tsx')
const { AppStateProvider } = await import('../../src/screen/app-state/AppState.tsx')
const { KeybindingSetup } = await import('../../src/screen/keys/KeybindingProviderSetup.tsx')
const { ModalContext } = await import('../../src/screen/overlays/modalContext.tsx')
const { PopupFrameContext } = await import('../../src/screen/overlays/PopupGutter.tsx')
const { enableConfigs } = await import('../../src/platform/settings/config.ts')
const { MercuryHealthCertificate, healthPopupShape } = await import('../../src/commands/health/HealthCertificate.tsx')
enableConfigs()
const h = React.createElement

const FAIL_ADVICE =
  'Mercury looks right in Windows Terminal (stable) or the VS Code integrated terminal — PowerShell 7 preferred. You can continue here knowingly; the screen will not be the complete design.'
const WARN_ADVICE =
  'pick from the live rows in /model — a typed id the list lacks is refused before the wire; /bug reports the stale ids'
const SHORT_FAIL_ADVICE = 'open Windows Terminal'
const SHORT_WARN_ADVICE = 'pick from /model'

const END_KEY = '\x1b[F'
const HOME_KEY = '\x1b[H'

let checks = 0
let failures = 0
function check(label: string, good: boolean, detail = '', fix = ''): void {
  checks++
  if (!good) failures++
  console.log(`  [${good ? 'PASS' : 'FAIL'}] ${label}${!good && detail ? ` — ${detail}` : ''}${!good && fix ? ` — fix: ${fix}` : ''}`)
}

function makeCert(failFix: string, warnFix: string, extraOkCount: number) {
  const extras = Array.from({ length: extraOkCount }, (_, index) => ({
    id: `ok-row-${String(index + 1).padStart(2, '0')}`,
    label: `Check row ${String(index + 1).padStart(2, '0')}`,
    status: 'ok' as const,
    evidence: `evidence ${index + 1}`,
  }))
  return {
    verdict: 'fault' as const,
    ranAt: new Date().toISOString(),
    head: { sha: 'abc1234def', branch: 'main', dirty: false },
    version: '1.0.12',
    durationMs: 14,
    depth: 'fast' as const,
    sections: [
      {
        id: 'identity',
        title: 'IDENTITY',
        checks: [
          {
            id: 'iface-terminal',
            label: 'Terminal profile',
            status: 'fail' as const,
            evidence: 'profile v1 unsupported',
            fix: failFix,
          },
          {
            id: 'model-lists',
            label: 'Model lists',
            status: 'warn' as const,
            evidence: 'served 10 · not served 15',
            fix: warnFix,
          },
        ],
      },
      {
        id: 'runtime',
        title: 'RUNTIME',
        checks: extras,
      },
    ],
  }
}

function innerLinesOf(lines: string[]): string[] {
  const top = lines.findIndex(line => line.includes('╭'))
  const bottom = lines.findIndex((line, index) => index > top && line.includes('╰'))
  if (top < 0 || bottom < 0) return []
  return lines.slice(top + 1, bottom).map(line => {
    const start = line.indexOf('│')
    const end = line.lastIndexOf('│')
    if (start < 0 || end <= start) return ''
    return line.slice(start + 2, end - 1).replace(/\s+$/, '')
  })
}

function stripScrollColumn(row: string): string {
  return row.replace(/[↑↓]$/, '').replace(/\s+$/, '')
}

function nextBlockLines(inner: string[]): string[] {
  const start = inner.findIndex(line => line.startsWith('NEXT'))
  if (start < 0) return []
  const end = inner.findIndex((line, index) => index > start && line.startsWith('IDENTITY'))
  const slice = end < 0 ? inner.slice(start + 1) : inner.slice(start + 1, end)
  const trimmed = slice.map(stripScrollColumn)
  while (trimmed.length > 0 && trimmed[trimmed.length - 1] === '') trimmed.pop()
  return trimmed
}

async function renderPane(cols: number, rows: number, cert: ReturnType<typeof makeCert>) {
  const shape = healthPopupShape()
  const width = shape.width(cols)
  const frameRows = shape.rows(rows)
  const report = async () => cert as never
  const element = h(
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
          { width: cols, height: rows, flexDirection: 'column' },
          h(
            ModalContext.Provider,
            { value: { rows: frameRows, columns: width, scrollRef: null } },
            h(
              PopupFrameContext.Provider,
              { value: { rows: frameRows, width } },
              h(MercuryHealthCertificate, { report, onClose: () => {} }),
            ),
          ),
        ),
      ),
    ),
  )
  const scene = await mountOffscreen(element, cols, rows)
  await settledFrame(scene, frame => frame.includes('Mercury · health') && frame.includes('FAILED') && frame.includes('NEXT') && frame.includes('IDENTITY'))
  return scene
}

const FIX_WRAP =
  'wrap each NEXT action in src/commands/health/certificate/healthCertificateView.tsx onto as many lines as it needs without truncate-end, aligning continuation lines under the first line text after the status mark, and count wrapped NEXT lines in src/commands/health/HealthCertificate.tsx'

try {
  for (const [cols, rows] of [[120, 36], [80, 24]] as const) {
    console.log(`\n── ${cols}x${rows} ──`)
    const longCert = makeCert(FAIL_ADVICE, WARN_ADVICE, 22)
    const shortCert = makeCert(SHORT_FAIL_ADVICE, SHORT_WARN_ADVICE, 22)
    const longScene = await renderPane(cols, rows, longCert)
    const shortScene = await renderPane(cols, rows, shortCert)
    try {
      const longInner = innerLinesOf(longScene.lines())
      const shortInner = innerLinesOf(shortScene.lines())
      const longNext = nextBlockLines(longInner)
      const shortNext = nextBlockLines(shortInner)
      const joinedNext = longNext.map(line => line.trim()).join(' ')
      const failWords = FAIL_ADVICE.split(/\s+/)
      const warnWords = WARN_ADVICE.split(/\s+/)
      const missingFail = failWords.filter(word => !joinedNext.includes(word))
      const missingWarn = warnWords.filter(word => !joinedNext.includes(word))

      check(
        `${cols}x${rows}: every word of the long fail advice is on screen under NEXT`,
        missingFail.length === 0,
        `missing: ${missingFail.join(', ')} | lines: ${JSON.stringify(longNext)}`,
        FIX_WRAP,
      )
      check(
        `${cols}x${rows}: every word of the long warn advice is on screen under NEXT`,
        missingWarn.length === 0,
        `missing: ${missingWarn.join(', ')} | lines: ${JSON.stringify(longNext)}`,
        FIX_WRAP,
      )
      check(
        `${cols}x${rows}: no NEXT line ends with the cut mark …`,
        longNext.length > 0 && longNext.every(line => !line.endsWith('…')),
        JSON.stringify(longNext),
        FIX_WRAP,
      )
      const failStart = longNext.findIndex(line => line.startsWith('✕ '))
      const warnStart = longNext.findIndex(line => line.startsWith('▲ '))
      const failLines = failStart >= 0 && warnStart > failStart ? longNext.slice(failStart, warnStart) : []
      const warnLines = warnStart >= 0 ? longNext.slice(warnStart) : []
      const failContAligned = failLines.length > 1 && failLines.slice(1).every(line => line.startsWith('  ') && line[2] !== ' ')
      const warnContAligned = warnLines.length > 1 && warnLines.slice(1).every(line => line.startsWith('  ') && line[2] !== ' ')
      check(
        `${cols}x${rows}: both NEXT advices wrap with continuation lines aligned under the first line text (after the mark)`,
        failContAligned && warnContAligned,
        `fail=${JSON.stringify(failLines)} warn=${JSON.stringify(warnLines)}`,
        FIX_WRAP,
      )

      const longHeadAt = longInner.findIndex(line => line.includes('Mercury · health') && line.includes('FAILED'))
      const shortHeadAt = shortInner.findIndex(line => line.includes('Mercury · health') && line.includes('FAILED'))
      const longCountsAt = longInner.findIndex(line => line.includes('24 checks · 1 fail · 1 warn · 22 ok'))
      const shortCountsAt = shortInner.findIndex(line => line.includes('24 checks · 1 fail · 1 warn · 22 ok'))
      const longIdentityAt = longInner.findIndex(line => line.startsWith('IDENTITY'))
      const shortIdentityAt = shortInner.findIndex(line => line.startsWith('IDENTITY'))
      const longFirstRowAt = longInner.findIndex(line => line.includes('Terminal profile'))
      const shortFirstRowAt = shortInner.findIndex(line => line.includes('Terminal profile'))
      const addedLines = longNext.length - shortNext.length

      check(
        `${cols}x${rows}: headline and counts stay on their own rows`,
        longHeadAt === shortHeadAt && longHeadAt >= 0 && longCountsAt === shortCountsAt && longCountsAt >= 0,
        `head ${longHeadAt}/${shortHeadAt}, counts ${longCountsAt}/${shortCountsAt}`,
        'keep the headline and counts rows unchanged in src/commands/health/certificate/healthCertificateView.tsx',
      )
      check(
        `${cols}x${rows}: rows below NEXT are pushed down by exactly the wrapped lines added (+${addedLines})`,
        addedLines > 0 && longIdentityAt - shortIdentityAt === addedLines && longFirstRowAt - shortFirstRowAt === addedLines,
        `added=${addedLines} identity ${shortIdentityAt}->${longIdentityAt} firstRow ${shortFirstRowAt}->${longFirstRowAt}`,
        FIX_WRAP,
      )

      longScene.push(END_KEY)
      const reachedLast = await waitFor(
        () => longScene.screen().includes('Check row 22') && longScene.screen().includes('24/24'),
        2500,
      )
      check(
        `${cols}x${rows}: scrolling still reaches the last check row (24/24)`,
        reachedLast,
        longScene.lines().slice(-6).join(' | '),
        'ensure ScrollBox layout and nextRows accounting in src/commands/health/HealthCertificate.tsx and healthCertificateView.tsx let scrolling reach the last row',
      )

      longScene.push(HOME_KEY)
      const returnedTop = await waitFor(() => {
        const inner = innerLinesOf(longScene.lines())
        const next = nextBlockLines(inner).map(line => line.trim()).join(' ')
        return inner.some(line => line.includes('1/24')) && next.includes('complete design.') && next.includes('stale ids')
      }, 2500)
      check(
        `${cols}x${rows}: Home returns to row 1/24 with both full NEXT advices back on screen`,
        returnedTop,
        innerLinesOf(longScene.lines()).slice(0, 12).join(' | '),
        'ensure ScrollBox scrollTo(0) at sel === 0 in src/commands/health/HealthCertificate.tsx restores the full NEXT block',
      )
    } finally {
      longScene.unmount()
      shortScene.unmount()
    }
  }

  console.log('\n── 120x36 short certificate (no scrollbar) ──')
  const compactCert = makeCert(FAIL_ADVICE, WARN_ADVICE, 1)
  const compactScene = await renderPane(120, 36, compactCert)
  try {
    const inner = innerLinesOf(compactScene.lines())
    const next = nextBlockLines(inner)
    const joined = next.map(line => line.trim()).join(' ')
    const failMissing = FAIL_ADVICE.split(/\s+/).filter(word => !joined.includes(word))
    const warnMissing = WARN_ADVICE.split(/\s+/).filter(word => !joined.includes(word))
    check(
      '120x36 short cert: both full NEXT advices and all 3 check rows fit without clipping',
      failMissing.length === 0 &&
        warnMissing.length === 0 &&
        next.every(line => !line.endsWith('…')) &&
        inner.some(line => line.includes('Terminal profile')) &&
        inner.some(line => line.includes('Model lists')) &&
        inner.some(line => line.includes('Check row 01')),
      inner.join(' | '),
      FIX_WRAP,
    )
  } finally {
    compactScene.unmount()
  }
} finally {
  await releaseScratchHome(HOME)
}

console.log(`\nprove-next-lines-read-whole: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
