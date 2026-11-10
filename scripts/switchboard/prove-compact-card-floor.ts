#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}
const section = (t: string): void => console.log(`\n── ${t} ──`)
const REPO = join(import.meta.dir, '..', '..')
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')

const card = await import('../../src/components/concourse/ContractOfferCard.tsx')
const board = await import('../../src/components/concourse/compactBoard.ts')
const wrapText = (await import('../../src/ink/wrap-text.ts')).default
const lines = (text: string, columns: number): number => wrapText(text, columns, 'wrap').split('\n').length
const FLOOR = card.CONTRACT_CARD_MIN_ROWS
const KEYS = '↑↓ choose · ↵ confirm · esc starts it plain'
const textColumnsAt = (cols: number): number => card.contractCardTextColumns(cols - 4)
const askRows = (rows: number, columns: number): number => {
  const fit = card.contractCardFit(rows, columns)
  return 9 + lines(KEYS, columns) - 1 + (fit.askBlurbRows ?? lines(card.CONTRACT_ASK_BLURB, columns)) - (fit.liftMargin ? 1 : 0) - (fit.askGap ? 0 : 1)
}
const fieldRows = (rows: number, columns: number): number => {
  const fit = card.contractCardFit(rows, columns)
  return (fit.fieldGaps ? 9 : 7) + (fit.fieldBlurbRows ?? lines(card.CONTRACT_FIELD_BLURB, columns)) + fit.fieldLines - (fit.fieldLift ? 1 : 0)
}
const STACKED_COLS = [60, 64, 72, 80, 82, 99, 120, 160, 200]

section('§1 the card stands whole in seven rows — both faces')
{
  check('the floor the board is told is seven rows', FLOOR === 7, String(FLOOR))
  check('from 60 columns (every width the board stacks at) the keys row stands on one row', STACKED_COLS.every(c => lines(KEYS, textColumnsAt(c)) === 1), STACKED_COLS.map(c => `${c}:${lines(KEYS, textColumnsAt(c))}`).join(' '))
  check('the ask face takes exactly the floor at the floor: the frame, the title, the question, Yes, No and the keys', STACKED_COLS.every(c => askRows(FLOOR, textColumnsAt(c)) === FLOOR), STACKED_COLS.map(c => `${c}:${askRows(FLOOR, textColumnsAt(c))}`).join(' '))
  check('the field face takes exactly the floor at the floor: it lifts its top margin as the ask face does', STACKED_COLS.every(c => fieldRows(FLOOR, textColumnsAt(c)) === FLOOR && card.contractCardFit(FLOOR, textColumnsAt(c)).fieldLift === true), STACKED_COLS.map(c => `${c}:${fieldRows(FLOOR, textColumnsAt(c))}`).join(' '))
  check('from eight rows up the field face fits with its margin and never lifts (the frames that fitted do not move)', STACKED_COLS.every(c => Array.from({ length: 33 }, (_, i) => i + 8).every(rows => card.contractCardFit(rows, textColumnsAt(c)).fieldLift === false && fieldRows(rows, textColumnsAt(c)) <= rows)))
  check('from the floor up neither face needs more rows than the pane hands it', STACKED_COLS.every(c => Array.from({ length: 34 }, (_, i) => i + FLOOR).every(rows => askRows(rows, textColumnsAt(c)) <= rows && fieldRows(rows, textColumnsAt(c)) <= rows)))
}

section('§1b a blurb the pane caps says it goes on')
if (typeof card.cappedBlurb !== 'function') check('the card exports the one cap its blurbs are painted through', false)
else {
  const whole = (text: string, columns: number): string[] => wrapText(text, columns, 'wrap').split('\n')
  const flat = (text: string): string => text.replace(/\s+/g, ' ')
  const capped = (text: string, columns: number, rows: number | null): string[] => card.cappedBlurb(text, columns, rows).split('\n')
  check('a blurb with room for every line is the blurb itself, on both faces', [39, 41, 68, 70, 110].every(c => card.cappedBlurb(card.CONTRACT_ASK_BLURB, c, null) === card.CONTRACT_ASK_BLURB && card.cappedBlurb(card.CONTRACT_ASK_BLURB, c, whole(card.CONTRACT_ASK_BLURB, c).length) === card.CONTRACT_ASK_BLURB && card.cappedBlurb(card.CONTRACT_FIELD_BLURB, c, null) === card.CONTRACT_FIELD_BLURB))
  const cases: Array<[string, number, number]> = []
  for (const c of [39, 41, 68, 70]) for (const text of [card.CONTRACT_ASK_BLURB, card.CONTRACT_FIELD_BLURB]) for (let rows = 1; rows < whole(text, c).length; rows++) cases.push([text, c, rows])
  check('a capped blurb keeps exactly its rows, each inside the column, and its last row ends with an ellipsis', cases.length > 12 && cases.every(([text, c, rows]) => { const lines = capped(text, c, rows); return lines.length === rows && lines.every(l => l.length <= c) && lines[rows - 1]!.endsWith('…') }), String(cases.length))
  check('…and what it keeps is the head of the blurb, word for word', cases.every(([text, c, rows]) => flat(text).startsWith(flat(capped(text, c, rows).join(' ').slice(0, -1)).trimEnd())))
  const at82 = capped(card.CONTRACT_ASK_BLURB, textColumnsAt(82), card.contractCardFit(11, textColumnsAt(82)).askBlurbRows)
  check('82×17 (eleven rows, two blurb lines): the second line ends "Yes opens a field…"', at82.length === 2 && at82[1] === 'agent acknowledges it without being blocked by it. Yes opens a field…', JSON.stringify(at82))
  const source = read('src/components/concourse/ContractOfferCard.tsx')
  check('both faces paint their blurb through the one cap', source.includes('{cappedBlurb(CONTRACT_ASK_BLURB, textColumns, fit.askBlurbRows)}') && source.includes('{cappedBlurb(CONTRACT_FIELD_BLURB, textColumns, fit.fieldBlurbRows)}'))
}

section('§2 the stacked board yields to one frame while the card stands and its mirror is under the floor')
{
  const facts = (sessionCount: number, newSessionDoor = true, composerBand = 1): { sessionCount: number; newSessionDoor: boolean; composerBand: number } => ({ sessionCount, newSessionDoor, composerBand })
  const stacked = (c: number, r: number, n: number): ReturnType<typeof board.compactConcourseGeometry> => board.compactConcourseGeometry(c, r, facts(n))
  const withCard = (c: number, r: number, n: number): ReturnType<typeof board.compactConcourseGeometry> => board.compactConcourseGeometry(c, r, { ...facts(n), cardRows: FLOOR })
  check('82×17 with no sessions: the stacked mirror hands five rows; with the card the live frame takes the whole height and hands eleven', stacked(82, 17, 0).profile === 'split' && stacked(82, 17, 0).mirrorRows === 5 && withCard(82, 17, 0).profile === 'single' && withCard(82, 17, 0).mirrorRows === 11 && withCard(82, 17, 0).live.y1 === 16, JSON.stringify([stacked(82, 17, 0).mirrorRows, withCard(82, 17, 0).profile, withCard(82, 17, 0).mirrorRows]))
  check('80×20 and 80×21 with five sessions: five and six stacked rows; one frame with the card', stacked(80, 20, 5).mirrorRows === 5 && stacked(80, 21, 5).mirrorRows === 6 && withCard(80, 20, 5).profile === 'single' && withCard(80, 21, 5).profile === 'single' && withCard(80, 20, 5).mirrorRows === 14 && withCard(80, 21, 5).mirrorRows === 15, JSON.stringify([stacked(80, 20, 5).mirrorRows, stacked(80, 21, 5).mirrorRows, withCard(80, 20, 5).mirrorRows, withCard(80, 21, 5).mirrorRows]))
  check('80×19 with no sessions and 80×22 with five: the stacked mirror hands the floor itself and the board stays stacked', stacked(80, 19, 0).mirrorRows === FLOOR && withCard(80, 19, 0).profile === 'split' && stacked(80, 22, 5).mirrorRows === FLOOR && withCard(80, 22, 5).profile === 'split')
  let under = 0
  let kept = 0
  const torn: string[] = []
  const moved: string[] = []
  for (const c of STACKED_COLS) {
    for (let r = 16; r <= 40; r++) {
      for (let n = 0; n <= 14; n++) {
        for (const door of [true, false]) {
          for (const band of [1, 2, 3]) {
            const plain = board.compactConcourseGeometry(c, r, facts(n, door, band))
            const carded = board.compactConcourseGeometry(c, r, { ...facts(n, door, band), cardRows: FLOOR })
            if (carded.mirrorRows < FLOOR) torn.push(`${c}x${r}/${n}/${door}/${band}:${carded.mirrorRows}`)
            if (plain.mirrorRows >= FLOOR) {
              kept++
              if (JSON.stringify(plain) !== JSON.stringify(carded)) moved.push(`${c}x${r}/${n}`)
            } else {
              under++
              if (carded.profile !== 'single' || carded.live.y0 !== 0 || carded.live.y1 !== r - 1) moved.push(`${c}x${r}/${n}:not-one-frame`)
            }
          }
        }
      }
    }
  }
  check('every stacked size from 16 to 40 rows, 0 to 14 sessions, with and without the door, one to three draft lines: the card is never handed fewer than its floor', torn.length === 0, `${torn.length} torn · ${torn.slice(0, 6).join(' ')}`)
  check('a board whose stacked mirror already holds the floor paints the same geometry with the card as without it; one whose mirror is under it paints the live frame alone', moved.length === 0 && under > 0 && kept > 0, `${moved.length} moved · ${moved.slice(0, 6).join(' ')} · under=${under} kept=${kept}`)
  check('no card, no yield: the geometry without the fact and with a zero fact are one', STACKED_COLS.every(c => [16, 17, 20, 21, 25].every(r => [0, 5, 12].every(n => JSON.stringify(stacked(c, r, n)) === JSON.stringify(board.compactConcourseGeometry(c, r, { ...facts(n), cardRows: 0 })) && stacked(c, r, n).profile === 'split'))))
  check('under 60 columns or 16 rows the board is one frame either way', JSON.stringify(board.compactConcourseGeometry(50, 20, facts(3))) === JSON.stringify(board.compactConcourseGeometry(50, 20, { ...facts(3), cardRows: FLOOR })) && JSON.stringify(board.compactConcourseGeometry(80, 14, facts(3))) === JSON.stringify(board.compactConcourseGeometry(80, 14, { ...facts(3), cardRows: FLOOR })))
}

section('§2b one frame too short for the card beside its composer: the composer yields, then the foot')
{
  const facts = (composerBand: number): { sessionCount: number; newSessionDoor: boolean; composerBand: number } => ({ sessionCount: 2, newSessionDoor: true, composerBand })
  const plain = (c: number, r: number, band = 1): ReturnType<typeof board.compactConcourseGeometry> => board.compactConcourseGeometry(c, r, facts(band))
  const carded = (c: number, r: number, band = 1): ReturnType<typeof board.compactConcourseGeometry> => board.compactConcourseGeometry(c, r, { ...facts(band), cardRows: FLOOR })
  check('80×11: the mirror already hands the floor beside the composer — nothing yields', plain(80, 11).mirrorRows === FLOOR && JSON.stringify(plain(80, 11)) === JSON.stringify(carded(80, 11)))
  check('80×10: six rows beside the composer; with the card the composer yields and the mirror hands seven, the foot row kept', plain(80, 10).mirrorRows === 6 && plain(80, 10).composerRows === 1 && carded(80, 10).mirrorRows === FLOOR && carded(80, 10).composerRows === 0 && carded(80, 10).liveFootRows === 1, JSON.stringify([plain(80, 10), carded(80, 10)]))
  check('80×9: the composer and then the foot yield — seven rows', carded(80, 9).mirrorRows === FLOOR && carded(80, 9).composerRows === 0 && carded(80, 9).liveFootRows === 0 && plain(80, 9).liveFootRows === 1, JSON.stringify(carded(80, 9)))
  check('80×12 with a three-line draft: the composer would leave six rows, so it yields while the card stands', plain(80, 12, 3).mirrorRows === 6 && carded(80, 12, 3).mirrorRows === 9 && carded(80, 12, 3).composerRows === 0, JSON.stringify([plain(80, 12, 3).mirrorRows, carded(80, 12, 3).mirrorRows]))
  check('80×8 and under: the frame itself is shorter than the card — the geometry hands every inner row and nothing more', carded(80, 8).mirrorRows === 6 && carded(80, 8).composerRows === 0 && carded(80, 8).liveFootRows === 0 && carded(80, 5).mirrorRows === 3)
  const torn: string[] = []
  const moved: string[] = []
  for (const c of [40, 59, 60, 80, 120, 200]) {
    for (let r = 3; r <= 40; r++) {
      for (let n = 0; n <= 14; n += 7) {
        for (const band of [1, 2, 3]) {
          const without = board.compactConcourseGeometry(c, r, { sessionCount: n, newSessionDoor: true, composerBand: band })
          const zero = board.compactConcourseGeometry(c, r, { sessionCount: n, newSessionDoor: true, composerBand: band, cardRows: 0 })
          const withCard = board.compactConcourseGeometry(c, r, { sessionCount: n, newSessionDoor: true, composerBand: band, cardRows: FLOOR })
          if (r >= 9 && withCard.mirrorRows < FLOOR) torn.push(`${c}x${r}/${n}/${band}:${withCard.mirrorRows}`)
          if (JSON.stringify(without) !== JSON.stringify(zero)) moved.push(`${c}x${r}/${n}/${band}`)
          if (without.mirrorRows >= FLOOR && JSON.stringify(without) !== JSON.stringify(withCard)) moved.push(`${c}x${r}/${n}/${band}:card`)
        }
      }
    }
  }
  check('from nine rows up, at every width and draft height, the card is handed its floor', torn.length === 0, `${torn.length} torn · ${torn.slice(0, 6).join(' ')}`)
  check('with no card standing, or a mirror that already holds the floor, no size from 3 to 40 rows moves', moved.length === 0, `${moved.length} moved · ${moved.slice(0, 6).join(' ')}`)
}

section('§3 the screen hands the floor only while the card stands; the painter and the wheel read the one geometry')
{
  const screen = read('src/components/concourse/ConcourseScreen.tsx')
  const compact = read('src/components/concourse/CompactConcourse.tsx')
  check('the floor rides while the contract card stands and is zero otherwise', screen.includes('const compactCardRows = contractAsk ? CONTRACT_CARD_MIN_ROWS : 0') && screen.includes('cardRows: compactCardRows,') && screen.includes('cardRows={compactCardRows}'))
  check('the compact painter takes its profile from the geometry it lays out with (no second owner)', compact.includes("if (geo.profile === 'single') {") && !/\bprofile: CompactConcourseProfile\b/.test(compact) && compact.includes('    cardRows,\n  })'))
  check('the wheel reads the list from the same geometry', screen.includes("const compactListPainted = compactGeo?.profile === 'split' || (compactGeo?.profile === 'single' && region === 'list' && !contractAskRef.current)"))
  check('the live frame\'s foot keeps its notes and drops its own key hints while the card stands, in both profiles', compact.includes("<FootRow text={cardRows > 0 ? '' : compactOpenedFoot({ reduced, verbsFire, draftHeld: liveDraftHeld })} note={note}") && compact.includes("<FootRow text={cardRows > 0 ? '' : compactLiveFoot({ verbsFire })} note={note}"))
}

console.log(failures === 0 ? '\nprove-compact-card-floor: ALL LAWS HOLD' : `\nprove-compact-card-floor: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
