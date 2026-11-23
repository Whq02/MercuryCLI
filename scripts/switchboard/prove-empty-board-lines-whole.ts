#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { mountOffscreen, waitFor } from '../lib/settingsPopupHarness.ts'
import type { ConcourseSnapshotV1 } from '../../src/screen/concourse/contracts.ts'

assert.ok(process.env.MERCURY_CONFIG_DIR, 'set scratch MERCURY_CONFIG_DIR before running prove-empty-board-lines-whole.ts')
delete process.env.MERCURY_HOME
process.env.NODE_ENV = 'test'
process.env.MERCURY_LIVE_GLYPHS = '0'

let failures = 0
const FIX_HINT = 'fix: wrap the empty-board text nodes with wrap="wrap" in boardRowsOf in src/screen/concourse/layout/listPane.tsx'
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — ${detail ? `${detail} | ` : ''}${FIX_HINT}` : ''}`)
}
const section = (t: string): void => console.log(`\n── ${t} ──`)

const React = await import('react')
const h = React.createElement
const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const { ConcourseLayout, newSessionDoorTail, newSessionDoorWords } = await import('../../src/screen/concourse/ConcourseLayout.tsx')
const { ThemeProvider } = await import('../../src/screen/theme/ThemeProvider.tsx')
const { AppStateProvider } = await import('../../src/screen/app-state/AppState.tsx')
const { referenceFixtureSnapshot } = await import('../notifications/concourseReferenceSeed.ts')

function emptySnapshot(door?: { modelLabel: string; effortLevel: string }): ConcourseSnapshotV1 {
  const base = JSON.parse(JSON.stringify(referenceFixtureSnapshot())) as ConcourseSnapshotV1
  base.groups = []
  base.needsYou = []
  base.sectionNotices = []
  base.peek = null
  if (door !== undefined) base.newSession = { ...base.newSession, door }
  else delete base.newSession.door
  return base
}

async function paintEmptyPane(opts: {
  cols: number
  rows: number
  region: 'list' | 'live'
  door?: { modelLabel: string; effortLevel: string }
}): Promise<{ bodyLines: string[]; paneText: string; footerVisible: boolean }> {
  const snapshot = emptySnapshot(opts.door)
  const layout = h(ConcourseLayout, {
    snapshot,
    boardGroups: snapshot.groups,
    filtering: false,
    filterText: '',
    filterCaret: 0,
    region: opts.region,
    boardSelectedId: null,
    railIndex: 0,
    liveDraftRows: 1,
    thirdPaneNode: () => null,
    mirrorNode: () => null,
    wiring: {
      selectSession: () => {},
      enterSession: () => {},
      selectObligation: () => {},
      answerObligation: () => {},
      openObligation: () => {},
      newSession: () => {},
    },
  })
  const mounted = await mountOffscreen(h(AppStateProvider, { children: h(ThemeProvider, {}, layout) }), opts.cols, opts.rows)
  try {
    await waitFor(() => mounted.screen().includes('SESSIONS') && mounted.screen().includes('no sessions yet'), 5000)
    const lines = mounted.lines()
    const headIdx = lines.findIndex(l => l.includes('SESSIONS'))
    const headLine = lines[headIdx] ?? ''
    const sessionsCol = headLine.indexOf('SESSIONS')
    const borderAt = (line: string, from: number, dir: -1 | 1): number => {
      for (let i = from; i >= 0 && i < line.length; i += dir) {
        if (line[i] === '│' || line[i] === '┃') return i
      }
      return -1
    }
    const leftBorder = borderAt(headLine, sessionsCol - 1, -1)
    const rightBorder = borderAt(headLine, sessionsCol + 1, 1)
    const sliceInner = (line: string): string =>
      leftBorder >= 0 && rightBorder > leftBorder ? line.slice(leftBorder + 1, rightBorder) : line
    const railIdx = lines.findIndex((l, i) => i > headIdx && sliceInner(l).includes('NEEDS YOU'))
    const bodyLines = lines
      .slice(headIdx + 1, railIdx > headIdx ? railIdx : undefined)
      .map(l => sliceInner(l).trim())
      .filter(l => l.length > 0)
    const paneText = bodyLines.join(' ').replace(/\s+/g, ' ').trim()
    const footerVisible = railIdx > headIdx && sliceInner(lines[railIdx + 1] ?? '').includes('n new')
    return { bodyLines, paneText, footerVisible }
  } finally {
    mounted.unmount()
  }
}

const LEAD_LINE = 'no sessions yet — this board fills as you start them'

section('§1 120x36 empty board: both lines wrap whole with no ellipsis')
{
  const plain = await paintEmptyPane({ cols: 120, rows: 36, region: 'list' })
  const doorLine = `▸ ${newSessionDoorWords({ region: 'list', filtering: false })}`
  check('120x36 list (no door): first line reads whole', plain.paneText.includes(LEAD_LINE), plain.bodyLines.join(' | '))
  check('120x36 list (no door): second line reads whole', plain.paneText.includes(doorLine), plain.bodyLines.join(' | '))
  check('120x36 list (no door): neither line ends in ellipsis', plain.bodyLines.every(l => !l.includes('…')), plain.bodyLines.join(' | '))
  check('120x36 list (no door): NEEDS YOU and pane footer remain visible', plain.footerVisible, plain.bodyLines.join(' | '))

  const door = { modelLabel: 'Sonnet 5.5', effortLevel: 'high' }
  const withDoor = await paintEmptyPane({ cols: 120, rows: 36, region: 'list', door })
  const fullDoorLine = `${doorLine}${newSessionDoorTail(door)}`
  check('120x36 list (with door): first line reads whole', withDoor.paneText.includes(LEAD_LINE), withDoor.bodyLines.join(' | '))
  check('120x36 list (with door): second line with model/effort tail reads whole', withDoor.paneText.includes(fullDoorLine), withDoor.bodyLines.join(' | '))
  check('120x36 list (with door): neither line ends in ellipsis', withDoor.bodyLines.every(l => !l.includes('…')), withDoor.bodyLines.join(' | '))
  check('120x36 list (with door): NEEDS YOU and pane footer remain visible', withDoor.footerVisible, withDoor.bodyLines.join(' | '))

  const liveFocused = await paintEmptyPane({ cols: 120, rows: 36, region: 'live' })
  const liveDoorLine = `▸ ${newSessionDoorWords({ region: 'live', filtering: false })}`
  check('120x36 live focus: both lines read whole without ellipsis', liveFocused.paneText.includes(LEAD_LINE) && liveFocused.paneText.includes(liveDoorLine) && liveFocused.bodyLines.every(l => !l.includes('…')), liveFocused.bodyLines.join(' | '))
}

section('§2 narrow wide-floor (100x26) and stacked (80x24): lines stay whole and footer stays intact')
{
  const narrow = await paintEmptyPane({ cols: 100, rows: 26, region: 'list', door: { modelLabel: 'Opus 5.5', effortLevel: 'high' } })
  const narrowDoor = `▸ ${newSessionDoorWords({ region: 'list', filtering: false })}${newSessionDoorTail({ modelLabel: 'Opus 5.5', effortLevel: 'high' })}`
  check('100x26: both lines read whole without ellipsis and footer stays visible', narrow.paneText.includes(LEAD_LINE) && narrow.paneText.includes(narrowDoor) && narrow.bodyLines.every(l => !l.includes('…')) && narrow.footerVisible, narrow.bodyLines.join(' | '))

  const stacked = await paintEmptyPane({ cols: 80, rows: 24, region: 'list' })
  const stackedDoor = `▸ ${newSessionDoorWords({ region: 'list', filtering: false })}`
  check('80x24 stacked: both lines read whole without ellipsis and footer stays visible', stacked.paneText.includes(LEAD_LINE) && stacked.paneText.includes(stackedDoor) && stacked.bodyLines.every(l => !l.includes('…')) && stacked.footerVisible, stacked.bodyLines.join(' | '))
}

console.log(failures === 0 ? '\nprove-empty-board-lines-whole: ALL LAWS HOLD' : `\nprove-empty-board-lines-whole: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
