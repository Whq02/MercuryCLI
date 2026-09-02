#!/usr/bin/env bun
// ============================================================================
//  prove-face-fit-floor — the front door's card never vanishes silently.
//
//  The cliff: the Boot face's card sheds WHOLE below its floor (word rows +
//  card rows + 11), and the card's growth to 10 rows moved that floor to 24
//  — exactly the macOS Terminal default height — with the word-only tier
//  saying nothing about the cut: a wordmark, a ready line, and no hint that
//  nine journeys were one row of height away. The board names the same
//  situation honestly ("needs at least 80×24 · this window is …"); the face
//  now does too.
//
//  §1 THE FLOOR PIN: the 10-row card paints at 24 rows and sheds at 23 —
//     the NEXT card row moves the floor to 25, reds this section, and the
//     grower re-decides consciously (a tighter tier, a shed ladder, or a
//     new pinned floor) instead of silently raising the front door's cliff.
//  §2 THE HONEST CUT: the word-only tier names the hidden card, its need
//     and this window's size; the line never appears while the card shows,
//     and no composed line ever exceeds the terminal width (a >cols line
//     wraps at the host and tears every row under it).
// ============================================================================
import { createSplashCore, assembleCardRows } from '../../assets/splash/splash-core.mjs'
import { join as join2 } from 'node:path'

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

const core = createSplashCore({ nocolor: true })
const vis = (s: string): number => s.replace(/\x1b\[[0-9;]*m/g, '').length

// The live composer's own rows, in the fullest world the host composes
// (menu + kit + agents + saturn + logins + concourse + sessions + the rest):
// the pin rides the REAL row owner, so a row landed in assembleCardRows is
// exactly what moves the floor.
const facts = {
  cwdBase: 'repo',
  menuAvailable: true,
  continueTarget: { base: 'repo', ageMs: 60_000, cross: false },
  concourse: { ctx: 'the live board' },
  kitArmedPreset: null,
  agentsCtx: null,
  saturnCtx: null,
  loginsCtx: null,
  sessionsCtx: null,
} as never
const cardRows = assembleCardRows(facts)
t('the live composer yields the ten-row card this floor is pinned against', cardRows.length === 10, `${cardRows.length} rows`)

const opts = {
  cardRows,
  hintSegments: [
    { key: '↵ ', label: 'start' },
    { key: 'm', label: ' menu' },
  ],
  tinyHint: '↵ start',
  stripLines: () => [],
}

function compose(cols: number, rows: number): { lines: string[]; cardShown: boolean } {
  return core.composeLockup(cols, rows, opts) as { lines: string[]; cardShown: boolean }
}

// §1 the floor pin
{
  const at24 = compose(100, 24)
  t('§1 the card paints at 24 rows (the macOS Terminal default keeps its front door)', at24.cardShown === true)
  const at23 = compose(100, 23)
  t('§1 the card sheds at 23 rows (the floor is exactly 24 for the ten-row card)', at23.cardShown === false)
}

// §2 the honest cut
{
  const shed = compose(100, 23)
  const cut = shed.lines.find(l => /card needs \d+ rows/.test(l))
  t('§2 the word-only tier names the hidden card and its need', cut !== undefined, shed.lines.map(l => l.trim()).filter(Boolean).slice(-3).join(' | '))
  t('§2 …with this window\'s size beside it', cut !== undefined && cut.includes('100×23'))
  t('§2 …and the true floor in the words', cut !== undefined && cut.includes('needs 24 rows'))
  const shown = compose(100, 24)
  t('§2 the line never appears while the card shows', !shown.lines.some(l => /card needs|card hidden/.test(l)))
  for (const [cols, rows] of [[100, 23], [46, 20], [100, 10], [30, 10], [100, 24]] as const) {
    const c = compose(cols, rows)
    const wide = c.lines.filter(l => vis(l) > cols)
    t(`§2 no composed line exceeds ${cols} cols at ${cols}×${rows}`, wide.length === 0, wide[0]?.slice(0, 60) ?? '')
  }
}

// §3 the dim row's honesty (riding this estate): no activation affordance
// on a row navigation skips, and the cross-repo ctx names the road.
{
  const crossFacts = {
    cwdBase: 'repo',
    menuAvailable: true,
    continueTarget: { base: 'otherrepo', ageMs: 60_000, cross: true, dim: true },
    concourse: { ctx: 'the live board' },
    kitArmedPreset: null,
    agentsCtx: null,
    saturnCtx: null,
    loginsCtx: null,
    sessionsCtx: null,
  } as never
  const rowsWithCross = assembleCardRows(crossFacts) as Array<{ key: string; ctx: string; dim?: boolean }>
  const cont = rowsWithCross.find(r => r.key === 'continue')
  t('§3 the cross-repo row is dim', cont?.dim === true)
  t('§3 …and its ctx names the road, not a plain target', cont !== undefined && cont.ctx.includes('via Sessions · Projects'), cont?.ctx ?? '')
  const composed = compose(100, 40)
  void composed
  const withDim = core.composeLockup(100, 40, { ...opts, cardRows: rowsWithCross }) as { lines: string[] }
  const dimLine = withDim.lines.find(l => l.includes('via Sessions'))
  t('§3 the dim row paints no → affordance', dimLine !== undefined && !dimLine.includes('→'), dimLine?.trim().slice(0, 80) ?? '')
  const liveLine = withDim.lines.find(l => l.includes('the live board'))
  t('§3 a live row keeps its →', liveLine !== undefined && liveLine.includes('→'))
}

// §4 the three install docs enumerate the LIVE card (first-contact law):
// the doc lists derive from the same row owner this prover composes with,
// so a row landed in assembleCardRows without its doc needle reds here —
// the docs once named a nine-row card missing Agents while promising a
// Continue row a first boot does not have.
{
  const { readFileSync } = await import('node:fs')
  const { join: joinPath } = await import('node:path')
  const DOC_NEEDLE: Record<string, string> = {
    new: 'New Session',
    continue: 'Continue Last Session',
    menu: 'Boot Menu',
    kit: 'MCPs & Skills',
    agents: 'Agents',
    doctor: 'Doctor / Health Check',
    saturn: 'Saturn Scheduler',
    logins: 'Logins',
    concourse: 'Session Concourse',
    sessions: 'Sessions · Projects',
  }
  const keys = (cardRows as Array<{ key: string }>).map(r => r.key)
  const unmapped = keys.filter(k => DOC_NEEDLE[k] === undefined)
  t('§4 every live row key carries a doc needle (a new row must name itself here)', unmapped.length === 0, unmapped.join(', '))
  for (const doc of ['README.md', 'AGENTS.md', 'docs/INSTALL-WINDOWS-FROM-SOURCE.md']) {
    const text = readFileSync(joinPath(import.meta.dir, '../../', doc), 'utf8')
    const missing = keys.map(k => DOC_NEEDLE[k]!).filter(needle => needle !== undefined && !text.includes(needle))
    t(`§4 ${doc} names every live card row`, missing.length === 0, missing.join(', '))
    t(`§4 ${doc} carries the Continue history gate`, text.includes('once') && text.includes('history'), 'the first-boot card has no Continue row')
  }
}

// §5 the classic boot-menu tier paints a host detail override (the prune
// confirmation — the one transcript-deleting door — was INVISIBLE at
// classic widths: the wide tier's SETTING DETAIL panel was the only reader,
// and ↵ committed from an unconfirmed frame).
{
  const src = await import('node:fs').then(m => m.readFileSync(join2(import.meta.dir, '../../assets/splash/splash-core.mjs'), 'utf8'))
  t('§5 the classic tier rides a CONFIRMATION override through its notice channel', src.includes('m.detailOverride && m.detailOverrideConfirms ? m.detailOverride.filter(Boolean).join'))
  const menu = core.composeBootMenu(70, 20, {
    entries: [{ label: 'a-row', valueLabel: 'v', summary: 'the row summary', group: 'g', groupTitle: 'G', inert: false, valueIsDefault: true, pinnedVal: null }],
    selIdx: 0,
    title: 'sessions',
    legend: '↑↓ move · esc back',
    noticeLine: null,
    detailOverride: ['prune deletes 3 transcripts permanently', 'No is the default'],
    detailOverrideConfirms: true,
  }) as { lines?: string[] } | string[]
  const lines = Array.isArray(menu) ? menu : (menu.lines ?? [])
  const flat = lines.join('\n')
  t('§5 …and the confirmation body paints at classic size', flat.includes('prune deletes 3 transcripts permanently'), flat.slice(0, 200))
}

console.log(failures === 0 ? 'FACE FIT FLOOR: ALL PASS' : 'FACE FIT FLOOR: RED')
process.exit(failures)
