#!/usr/bin/env bun
import * as React from 'react'
import type { ThemeName } from '../../src/utils/theme.ts'
import { pinScratchHome, releaseScratchHome, mountOffscreen, waitFor } from '../lib/settingsPopupHarness.ts'

const HOME = pinScratchHome('concourse-composer-border')
process.env.MERCURY_WARM_INK = '1'

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
const { ConcourseComposer } = await import('../../src/components/concourse/ConcourseStrips.tsx')
const { composerFrame } = await import('../../src/components/PromptInput/composerFrame.tsx')
const { composerBorderRole } = await import('../../src/components/mercury-ui/composerFloor.ts')
const { setSessionCritter } = await import('../../src/components/mercury-ui/sessionAccent.ts')
const { getTheme } = await import('../../src/utils/theme.ts')
const { resolveMercuryTokens } = await import('../../src/utils/mercuryTokens.ts')
const { Text } = await import('../../src/ink.ts')

let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

async function borderFgOf(node: React.ReactNode): Promise<{ fg: string; ch: string } | null> {
  const m = await mountOffscreen(node, 80, 24)
  await waitFor(() => m.lines().some(line => line.includes('╭') || line.includes('┏')), 1500)
  const lines = m.lines()
  const y = lines.findIndex(line => line.includes('╭') || line.includes('┏'))
  if (y < 0) {
    m.unmount()
    return null
  }
  const x = lines[y]!.search(/[╭┏]/)
  const st = m.styleAt(x, y)
  const ch = lines[y]![x] ?? ''
  m.unmount()
  return st === null ? null : { fg: st.fg, ch }
}

async function sessionBorderFg(themeName: ThemeName, empty: boolean): Promise<string> {
  const theme = getTheme(themeName)
  const role = composerBorderRole(empty)
  const el = React.createElement(
    ThemeProvider,
    { initialState: themeName },
    composerFrame({
      banner: null,
      columns: 60,
      isCompact: false,
      inputBody: React.createElement(Text, null, empty ? '' : 'hello'),
      borderStyle: 'round',
      theme,
      borderColor: role,
      input: empty ? '' : 'hello',
    }),
  )
  const hit = await borderFgOf(el)
  return hit?.fg ?? '(none)'
}

async function concourseBorder(themeName: ThemeName, focused: boolean, text: string): Promise<{ fg: string; ch: string } | null> {
  const el = React.createElement(
    ThemeProvider,
    { initialState: themeName },
    React.createElement(ConcourseComposer, {
      width: 60,
      bandRows: 2,
      focused,
      draft: { text, caret: text.length },
      pending: false,
      note: null,
      restHint: 'message',
    }),
  )
  return borderFgOf(el)
}

function rgbToSgr(color: string): string {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color.trim())
  if (hex) return `38;2;${parseInt(hex[1]!, 16)};${parseInt(hex[2]!, 16)};${parseInt(hex[3]!, 16)}`
  const rgb = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/i.exec(color.trim())
  if (rgb) return `38;2;${rgb[1]};${rgb[2]};${rgb[3]}`
  return color
}

try {
  console.log('\nConcourseComposer border follows theme promptBorder / promptBorderResting')

  setSessionCritter('crab')
  const darkInfo = rgbToSgr(getTheme('dark').info)
  const darkActiveSession = await sessionBorderFg('dark', false)
  const darkRestingSession = await sessionBorderFg('dark', true)
  const darkActive = await concourseBorder('dark', true, 'hello')
  const darkResting = await concourseBorder('dark', true, '')
  const darkUnfocused = await concourseBorder('dark', false, 'hello')
  const darkBorderStrong = rgbToSgr(resolveMercuryTokens('dark', getTheme('dark').promptBorder).borderStrong)

  check(
    'dark (crab) focused non-empty matches session promptBorder and is not info',
    darkActive !== null && darkActive.fg === darkActiveSession && darkActive.fg !== darkInfo,
    `got=${darkActive?.fg} session=${darkActiveSession} info=${darkInfo}`,
  )
  check(
    'dark (crab) focused empty matches session promptBorderResting and is not info',
    darkResting !== null && darkResting.fg === darkRestingSession && darkResting.fg !== darkInfo,
    `got=${darkResting?.fg} session=${darkRestingSession} info=${darkInfo}`,
  )
  check(
    'dark unfocused keeps borderStrong',
    darkUnfocused !== null && darkUnfocused.fg === darkBorderStrong,
    `got=${darkUnfocused?.fg} expected=${darkBorderStrong}`,
  )

  setSessionCritter('octopus')
  const tbInfo = rgbToSgr(getTheme('true-black').info)
  const tbActiveSession = await sessionBorderFg('true-black', false)
  const tbRestingSession = await sessionBorderFg('true-black', true)
  const tbActive = await concourseBorder('true-black', true, 'hello')
  const tbResting = await concourseBorder('true-black', true, '')

  check(
    'true-black (octopus) focused non-empty follows new promptBorder and differs from dark (crab) and info',
    tbActive !== null && tbActive.fg === tbActiveSession && tbActive.fg !== darkActive?.fg && tbActive.fg !== tbInfo,
    `got=${tbActive?.fg} session=${tbActiveSession} dark=${darkActive?.fg} info=${tbInfo}`,
  )
  check(
    'true-black (octopus) focused empty matches session promptBorderResting and is not info',
    tbResting !== null && tbResting.fg === tbRestingSession && tbResting.fg !== tbInfo,
    `got=${tbResting?.fg} session=${tbRestingSession} info=${tbInfo}`,
  )
} finally {
  await releaseScratchHome(HOME)
}

console.log(failures === 0 ? `\nGREEN (${checks} checks)` : `\nRED (${failures} of ${checks})`)
process.exit(failures === 0 ? 0 : 1)
