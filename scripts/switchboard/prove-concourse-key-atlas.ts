#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, releaseScratchHome, waitFor } from '../lib/settingsPopupHarness.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import type { ConcourseCallbacks, ConcourseRowV1, ConcourseSnapshotV1 } from '../../src/screen/concourse/contracts.ts'

const HOME = pinScratchHome('concourse-key-atlas')
seedFirstRun(HOME, [])
process.env.NODE_ENV = 'test'
process.env.MERCURY_LIVE_GLYPHS = '0'

const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const FRAMES = argAfter('--frames')

let failures = 0
let checks = 0
const FIX_HINT = 'fix: pass the current board selection to ConcourseKeyAtlas in src/screen/concourse/screen/stage.tsx and forward it to regionKeysFor in src/screen/concourse/screen/modals.tsx'
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — ${detail ? `${detail} | ` : ''}${FIX_HINT}` : ''}`)
}

const React = await import('react')
const h = React.createElement
const { enableConfigs, saveGlobalConfig } = await import('../../src/platform/settings/config.ts')
enableConfigs()
saveGlobalConfig(c => ({ ...c, switchboardCapacity: { askedAt: 1754000000000, allowed: true, recommendedSeats: 5 } }))
const { ConcourseScreen, _resetConcourseCapsuleForTesting } = await import('../../src/screen/concourse/ConcourseScreen.tsx')
const { ThemeProvider } = await import('../../src/screen/theme/ThemeProvider.tsx')
const { AppStateProvider } = await import('../../src/screen/app-state/AppState.tsx')
const { keyHintLabel } = await import('../../src/screen/widgets/keyHintLabel.ts')
const { referenceFixtureSnapshot } = await import('../notifications/concourseReferenceSeed.ts')

function rowOf(sessionId: string, title: string, state: ConcourseRowV1['state']): ConcourseRowV1 {
  return {
    sessionId,
    title,
    state,
    projectLabel: 'project',
    ownerLabel: 'Mercury',
    ageLabel: '01m',
    seats: null,
  }
}

function boardSnapshot(rows: ConcourseRowV1[], groupId: ConcourseSnapshotV1['groups'][number]['id'], groupLabel: string): ConcourseSnapshotV1 {
  const base = JSON.parse(JSON.stringify(referenceFixtureSnapshot())) as ConcourseSnapshotV1
  base.groups = [{ id: groupId, label: groupLabel, rows }]
  base.needsYou = []
  base.sectionNotices = []
  base.peek = null
  return base
}

const noopCallbacks: ConcourseCallbacks = {
  enterSession: () => {},
  peekSession: () => {},
  openObligation: () => {},
  claimObligation: () => {},
  withdrawObligation: () => {},
  answerObligation: () => {},
  pauseAfterTurn: () => {},
  resumeSession: () => {},
  redirectSession: () => {},
  startSessionDraft: () => {},
  setDraftSeed: () => {},
  submitSessionDraft: () => {},
  exitToChat: () => {},
  newSession: () => {},
  stopSession: () => {},
  interruptSession: () => {},
  setSessionModel: () => {},
  setSessionEffort: () => {},
  renameSession: () => {},
  enterBootSettings: () => false,
}

async function openAtlasFor(
  tag: string,
  row: ConcourseRowV1,
  groupId: ConcourseSnapshotV1['groups'][number]['id'],
  groupLabel: string,
): Promise<{ legend: string; atlasLines: string[]; screen: string }> {
  _resetConcourseCapsuleForTesting()
  const snapshot = boardSnapshot([row], groupId, groupLabel)
  const mounted = await mountOffscreen(
    h(
      AppStateProvider,
      { children: h(ThemeProvider, {}, h(ConcourseScreen, { snapshot, callbacks: noopCallbacks })) },
    ),
    120,
    40,
  )
  try {
    await waitFor(() => mounted.screen().includes('status & title') && mounted.screen().includes(row.title), 5000)
    const beforeLines = mounted.lines()
    const legend = (beforeLines[beforeLines.length - 1] ?? '').trim()
    mounted.push('?')
    await waitFor(() => mounted.screen().includes('CONCOURSE — keys'), 5000)
    const lines = mounted.lines()
    if (FRAMES !== undefined) {
      mkdirSync(FRAMES, { recursive: true })
      writeFileSync(join(FRAMES, `${tag}.txt`), lines.map(l => l.trimEnd()).join('\n') + '\n')
    }
    const top = lines.findIndex(l => l.includes('CONCOURSE — keys'))
    const bot = lines.findIndex((l, i) => i > top && l.includes('esc close'))
    const atlasLines = top >= 0 && bot >= top ? lines.slice(top, bot + 1) : []
    mounted.push(KEY.esc)
    await waitFor(() => !mounted.screen().includes('CONCOURSE — keys'), 5000)
    return { legend, atlasLines, screen: atlasLines.join('\n') }
  } finally {
    mounted.unmount()
  }
}

async function focusedComposerFor(
  row: ConcourseRowV1,
  groupId: ConcourseSnapshotV1['groups'][number]['id'],
  groupLabel: string,
): Promise<{ restPrompt: string; focusedFoot: string }> {
  _resetConcourseCapsuleForTesting()
  const snapshot = boardSnapshot([row], groupId, groupLabel)
  const mounted = await mountOffscreen(
    h(
      AppStateProvider,
      { children: h(ThemeProvider, {}, h(ConcourseScreen, { snapshot, callbacks: noopCallbacks })) },
    ),
    120,
    40,
  )
  try {
    await waitFor(() => mounted.screen().includes('status & title') && mounted.screen().includes(`❯ message ${row.title}`), 5000)
    const restPrompt = mounted.lines().find(l => l.includes(`❯ message ${row.title}`)) ?? ''
    mounted.push('\t')
    await waitFor(() => mounted.screen().includes('↵↵ enter session'), 5000)
    mounted.push('check')
    await waitFor(() => mounted.screen().includes('❯ check') && mounted.screen().includes('newline · tab panes'), 5000)
    const focusedFoot = mounted.lines().find(l => l.includes('newline · tab panes')) ?? ''
    return { restPrompt, focusedFoot }
  } finally {
    mounted.unmount()
  }
}

try {
  const live = await openAtlasFor('live', rowOf('s-live', 'Live task', 'working'), 'working', 'working')
  const liveExpected = [
    [keyHintLabel('⌃g'), 'ground'],
    ['i', 'interrupt'],
    ['m', 'model'],
    ['e', 'effort'],
    ['r', 'rename'],
    ['→', 'peek'],
    ['/', 'filter'],
    ['p', 'pause'],
  ] as const
  for (const [k, word] of liveExpected) {
    check(`live row: ? names "${k} ${word}"`, live.atlasLines.some(l => l.includes(k) && l.includes(word)), live.atlasLines.map(l => l.trim()).join(' | '))
  }
  check('live row: resting bottom legend names the four chords', live.legend === 'tab panes · / filter · ? keys · esc boot face', live.legend)
  const legendChords = live.legend.split(' · ').map(p => p.trim()).filter(Boolean)
  for (const chord of legendChords) {
    const [k, ...rest] = chord.split(' ')
    const label = rest.join(' ')
    if (k === undefined || label === '') continue
    check(`live row: bottom-legend chord "${chord}" is named in ?`, live.atlasLines.some(l => l.includes(k) && l.includes(label.split(' ')[0]!)), `legend="${live.legend}"`)
  }
  check('live row at 120×40: no section is hidden in ?', !live.screen.includes('more section'), live.atlasLines.slice(-4).join(' | '))

  const paused = await openAtlasFor('paused', rowOf('s-paused', 'Paused task', 'paused'), 'paused', 'paused')
  for (const [k, word] of [
    [keyHintLabel('⌃g'), 'ground'],
    ['i', 'interrupt'],
    ['m', 'model'],
    ['e', 'effort'],
    ['r', 'rename'],
    ['→', 'peek'],
    ['p', 'resume'],
  ] as const) {
    check(`paused row: ? names "${k} ${word}"`, paused.atlasLines.some(l => l.includes(k) && l.includes(word)), paused.atlasLines.map(l => l.trim()).join(' | '))
  }
  check('paused row: resting bottom legend names the four chords', paused.legend === 'tab panes · / filter · ? keys · esc boot face', paused.legend)
  const parked = await openAtlasFor('parked', rowOf('s-parked', 'Parked task', 'parked'), 'parked', 'parked')
  for (const [k, word] of [
    [keyHintLabel('⌃g'), 'ground'],
    ['r', 'rename'],
    ['/', 'filter'],
    [keyHintLabel('⌃x ⌃x'), 'arm · delete'],
  ] as const) {
    check(`parked row: ? names "${k} ${word}"`, parked.atlasLines.some(l => l.includes(k) && l.includes(word)), parked.atlasLines.map(l => l.trim()).join(' | '))
  }
  check('parked row: ? omits i interrupt / m model / e effort that do nothing on a parked row', !parked.screen.includes('interrupt') && !parked.atlasLines.some(l => /\be\s+effort\b/.test(l)) && !parked.atlasLines.some(l => /\bm\s+model\b/.test(l)), parked.atlasLines.map(l => l.trim()).join(' | '))

  const workingComposer = await focusedComposerFor(rowOf('s-work', 'Live task', 'working'), 'working', 'working')
  check('working row: resting composer keeps short "message <title>" placeholder', workingComposer.restPrompt.includes('❯ message Live task') && !workingComposer.restPrompt.includes('on its next turn'), workingComposer.restPrompt.trim())
  check('working row: focused composer foot says "↵ queue" (not "↵ send")', workingComposer.focusedFoot.includes('↵ queue ·') && !workingComposer.focusedFoot.includes('↵ send ·'), workingComposer.focusedFoot.trim())

  const idleComposer = await focusedComposerFor(rowOf('s-idle', 'Idle task', 'ready-to-review'), 'ready-to-review', 'ready to review')
  check('idle row: resting composer keeps short "message <title>" placeholder', idleComposer.restPrompt.includes('❯ message Idle task') && !idleComposer.restPrompt.includes('on its next turn'), idleComposer.restPrompt.trim())
  check('idle row: focused composer foot says "↵ send" (not "↵ queue")', idleComposer.focusedFoot.includes('↵ send ·') && !idleComposer.focusedFoot.includes('↵ queue ·'), idleComposer.focusedFoot.trim())
} finally {
  await releaseScratchHome(HOME)
}

console.log(`\nprove-concourse-key-atlas: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
