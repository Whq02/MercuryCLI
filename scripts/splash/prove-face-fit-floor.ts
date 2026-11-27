#!/usr/bin/env bun
import { createSplashCore, assembleCardRows } from '../../assets/splash/splash-core.mjs'
import { join as join2 } from 'node:path'

let failures = 0
let failHint = 'change composeLockup or assembleCardRows in assets/splash/splash-core.mjs (and for the section 4 doc checks, the card names in README.md, AGENTS.md or docs/INSTALL-WINDOWS-FROM-SOURCE.md)'
const t = (name: string, ok: boolean, detail = ''): void => {
  const failText = [detail, failHint].filter(Boolean).join('; ')
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && failText ? ` — ${failText}` : ''}`)
  if (!ok) failures = 1
}

const core = createSplashCore({ nocolor: true })
const vis = (s: string): number => s.replace(/\x1b\[[0-9;]*m/g, '').length

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
t('the live composer yields the five-row card this floor is pinned against', cardRows.length === 5, `${cardRows.length} rows`)

const opts = {
  cardRows,
  hintSegments: [
    { key: '↵', label: '' },
    { key: 'm', label: ' menu' },
  ],
  tinyHint: '↵',
  stripLines: () => [],
}

function compose(cols: number, rows: number): { lines: string[]; cardShown: boolean } {
  return core.composeLockup(cols, rows, opts) as { lines: string[]; cardShown: boolean }
}

{
  const at19 = compose(100, 19)
  t('§1 the card paints at 19 rows (the floor keeps the five-row front door)', at19.cardShown === true)
  const at18 = compose(100, 18)
  t('§1 the card sheds at 18 rows (the floor is exactly 19 for the five-row card)', at18.cardShown === false)
}

{
  const shed = compose(100, 18)
  const cut = shed.lines.find(l => /card needs \d+ rows/.test(l))
  t('§2 the word-only tier names the hidden card and its need', cut !== undefined, shed.lines.map(l => l.trim()).filter(Boolean).slice(-3).join(' | '))
  t('§2 …with this window\'s size beside it', cut !== undefined && cut.includes('100×18'))
  t('§2 …and the true floor in the words', cut !== undefined && cut.includes('needs 19 rows'))
  const shown = compose(100, 19)
  t('§2 the line never appears while the card shows', !shown.lines.some(l => /card needs|card hidden/.test(l)))
  for (const [cols, rows] of [[100, 18], [46, 17], [100, 10], [30, 10], [100, 19]] as const) {
    const c = compose(cols, rows)
    const wide = c.lines.filter(l => vis(l) > cols)
    t(`§2 no composed line exceeds ${cols} cols at ${cols}×${rows}`, wide.length === 0, wide[0]?.slice(0, 60) ?? '')
  }
}

{
  const crossFacts = {
    cwdBase: 'repo',
    menuAvailable: true,
    continueTarget: { base: 'otherrepo', ageMs: 60_000, cross: true },
    concourse: { ctx: 'unregistered in this build', dim: true },
    kitArmedPreset: null,
    agentsCtx: null,
    saturnCtx: null,
    loginsCtx: null,
    sessionsCtx: null,
  } as never
  const rowsWithCross = assembleCardRows(crossFacts) as Array<{ key: string; ctx: string; dim?: boolean }>
  const cont = rowsWithCross.find(r => r.key === 'continue')
  t('§3 the cross-repo row is live (not dim)', cont !== undefined && cont.dim !== true)
  t('§3 …and its ctx names the target repo', cont !== undefined && cont.ctx === 'in otherrepo', cont?.ctx ?? '')
  const withCross = core.composeLockup(100, 40, { ...opts, cardRows: rowsWithCross }) as { lines: string[] }
  const crossLine = withCross.lines.find(l => l.includes('in otherrepo'))
  t('§3 the cross-repo row keeps its → affordance', crossLine !== undefined && crossLine.includes('→'), crossLine?.trim().slice(0, 80) ?? '')
  const dimLine = withCross.lines.find(l => l.includes('unregistered in this build'))
  t('§3 a dim row paints no → affordance', dimLine !== undefined && !dimLine.includes('→'), dimLine?.trim().slice(0, 80) ?? '')
}

{
  const { readFileSync } = await import('node:fs')
  const { join: joinPath } = await import('node:path')
  const DOC_NEEDLE: Record<string, string> = {
    new: 'New Session',
    continue: 'Continue Last Session',
    menu: 'Boot Menu',
    logins: 'Logins',
    concourse: 'Session Manager',
  }
  const keys = (cardRows as Array<{ key: string }>).map(r => r.key)
  const unmapped = keys.filter(k => DOC_NEEDLE[k] === undefined)
  t('§4 every live row key carries a doc needle (a new row must name itself here)', unmapped.length === 0, unmapped.join(', '))
  for (const doc of ['README.md', 'AGENTS.md', 'docs/INSTALL-WINDOWS-FROM-SOURCE.md']) {
    const text = readFileSync(joinPath(import.meta.dir, '../../', doc), 'utf8')
    const missing = keys.map(k => DOC_NEEDLE[k]!).filter(needle => needle !== undefined && !text.includes(needle))
    t(`§4 ${doc} names every live card row`, missing.length === 0, missing.join(', '))
  }
}

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
