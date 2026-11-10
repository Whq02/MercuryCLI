#!/usr/bin/env bun
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 300)}` : ''}`)
}
const card = await import('../../src/components/concourse/ContractOfferCard.tsx')
const board = await import('../../src/components/concourse/compactBoard.ts')
const wrapText = (await import('../../src/ink/wrap-text.ts')).default
const lines = (text: string, columns: number): number => wrapText(text, columns, 'wrap').split('\n').length
const hand = (cols: number, rows: number, sessionCount = 0): { profile: string; rows: number; textColumns: number } => {
  const geo = board.compactConcourseGeometry(cols, rows, { sessionCount, newSessionDoor: true, composerBand: 1, cardRows: card.CONTRACT_CARD_MIN_ROWS })
  return { profile: geo.profile, rows: geo.mirrorRows, textColumns: card.contractCardTextColumns(Math.max(0, geo.live.inner - 2)) }
}
const fitAt = (cols: number, rows: number, sessionCount = 0): ReturnType<typeof card.contractCardFit> => {
  const h = hand(cols, rows, sessionCount)
  return card.contractCardFit(h.rows, h.textColumns)
}

console.log('§1 the text columns follow the pane: eight columns go to the mount, the frame and the body')
check('a pane of 47 columns wraps the blurb at 39', card.contractCardTextColumns(47) === 39)
check('a pane of 49 columns wraps the blurb at 41', card.contractCardTextColumns(49) === 41)
check('the ask blurb wraps to seven lines at 39 and at 41 columns', lines(card.CONTRACT_ASK_BLURB, 39) === 7 && lines(card.CONTRACT_ASK_BLURB, 41) === 7, `${lines(card.CONTRACT_ASK_BLURB, 39)} / ${lines(card.CONTRACT_ASK_BLURB, 41)}`)
check('the field blurb wraps to three lines at both', lines(card.CONTRACT_FIELD_BLURB, 39) === 3 && lines(card.CONTRACT_FIELD_BLURB, 41) === 3)
check('the compact board hands the card its full-width live frame: text columns 68 at 80 columns and 70 at 82', hand(80, 14).textColumns === 68 && hand(82, 17).textColumns === 70, JSON.stringify([hand(80, 14), hand(82, 17)]))
check('at those widths the ask blurb wraps to four lines, the field blurb to two and the keys row stands on one row', [68, 70].every(c => lines(card.CONTRACT_ASK_BLURB, c) === 4 && lines(card.CONTRACT_FIELD_BLURB, c) === 2 && lines('↑↓ choose · ↵ confirm · esc starts it plain', c) === 1))

console.log('§2 the ask face: the blurb yields row by row before the question and the Yes/No rows')
const at8 = card.contractCardFit(8, 39)
check('eight rows at 39 columns: no blurb, the frame lifts its top margin, the card is the eight rows', at8.askBlurbRows === 0 && at8.liftMargin, JSON.stringify(at8))
const at11 = card.contractCardFit(11, 41)
check('eleven rows at 41 columns: one blurb line beside the keys row that wraps there, the margin stays', at11.askBlurbRows === 1 && !at11.liftMargin, JSON.stringify(at11))
const at15 = card.contractCardFit(15, 39)
check('fifteen rows at 39 columns: five blurb lines beside the wrapped keys row, the keys and the frame on the pane', at15.askBlurbRows === 5 && !at15.liftMargin, JSON.stringify(at15))
const at16 = card.contractCardFit(16, 39)
check('the keys row wraps at 39 columns and stands on one row at 100', card.contractCardFit(20, 39).askBlurbRows === null && card.contractCardFit(17, 39).askBlurbRows === null && card.contractCardFit(16, 39).askBlurbRows === 6 && card.contractCardFit(16, 100).askBlurbRows === null)
check('seventeen rows and up at 39 columns, sixteen at 100: the whole blurb, nothing capped; one row short caps one line', card.contractCardFit(17, 39).askBlurbRows === null && !card.contractCardFit(17, 39).liftMargin && card.contractCardFit(40, 100).askBlurbRows === null && at16.askBlurbRows === 6 && !at16.liftMargin)
check('eight rows at 39 columns: the keys row wraps and the lifted card is still one row over, so the gap above the keys yields', at8.askGap === false, JSON.stringify(at8))
check('nine rows at 39 columns, and eight at 100 where the keys row stands on one row: the lift alone fits the card and the gap stays', card.contractCardFit(9, 39).askGap === true && card.contractCardFit(9, 39).liftMargin && card.contractCardFit(8, 100).askGap === true && card.contractCardFit(8, 100).liftMargin, JSON.stringify([card.contractCardFit(9, 39), card.contractCardFit(8, 100)]))
check('with any blurb row on the pane the gap stays', at11.askGap === true && at15.askGap === true && card.contractCardFit(40, 100).askGap === true)
const prompt = readFileSync(join(import.meta.dir, '../../src/components/permissions/PermissionPrompt.tsx'), 'utf8')
check('PermissionPrompt keeps the gap for every caller by default and takes the one prop', prompt.includes('hintGap = true,') && prompt.includes('<Box marginTop={hintGap ? 1 : 0}>'))
const passers = readdirSync(join(import.meta.dir, '../../src/components'), { recursive: true }).map(String).filter(f => /\.tsx?$/.test(f)).filter(f => readFileSync(join(import.meta.dir, '../../src/components', f), 'utf8').includes('hintGap'))
check('the contract offer card is the one caller that passes it', passers.sort().join(',') === 'concourse/ContractOfferCard.tsx,permissions/PermissionPrompt.tsx' && readFileSync(join(import.meta.dir, '../../src/components/concourse/ContractOfferCard.tsx'), 'utf8').includes('hintGap={fit.askGap}'), passers.join(','))
check('a cap never exceeds the blurb itself', [8, 9, 10, 12, 14, 16, 17].every(rows => { const f = card.contractCardFit(rows, 39); return f.askBlurbRows === null || f.askBlurbRows <= 7 }))

console.log('§3 the field face: the field keeps its two shipped lines, the blurb and the gaps yield, the cap is what fits')
check('eight rows: no blurb, one field line, no gaps (title, question, field, two key rows inside the frame), the margin stays', at8.fieldBlurbRows === 0 && at8.fieldLines === 1 && !at8.fieldGaps && !at8.fieldLift, JSON.stringify(at8))
check('eleven rows: no blurb, two field lines, the gaps kept', at11.fieldBlurbRows === 0 && at11.fieldLines === 2 && at11.fieldGaps, JSON.stringify(at11))
check('fifteen rows: the whole blurb and the gaps as before, the field capped at the three lines that fit', at15.fieldBlurbRows === null && at15.fieldLines === 3 && at15.fieldGaps, JSON.stringify(at15))
check('twenty rows: the whole blurb, six field lines as before', card.contractCardFit(20, 39).fieldBlurbRows === null && card.contractCardFit(20, 39).fieldLines === 6 && card.contractCardFit(20, 39).fieldGaps, JSON.stringify(card.contractCardFit(20, 39)))
check('every row count from four up yields a face that needs no more rows than the pane has or the seven of the floor, with the field at one line and the margin lifted under eight', [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18].every(rows => { const f = card.contractCardFit(rows, 39); const blurb = f.fieldBlurbRows ?? 3; return (f.fieldGaps ? 9 : 7) + blurb + 1 - (f.fieldLift ? 1 : 0) <= Math.max(rows, 7) && f.fieldLift === rows < 8 }))

console.log('§4 the five sizes the drive boots, each read from the board\'s own geometry while a card stands')
const at80x11 = fitAt(80, 11)
check('80×11: one frame hands seven rows — the ask face lifts and gives up its gap, the field face lifts as well', hand(80, 11).profile === 'single' && hand(80, 11).rows === 7 && at80x11.askBlurbRows === 0 && at80x11.liftMargin && !at80x11.askGap && at80x11.fieldLift && at80x11.fieldLines === 1, JSON.stringify([hand(80, 11), at80x11]))
const at80x14 = fitAt(80, 14)
check('80×14: one frame hands eight rows — the ask face lifts and keeps its gap, the field face keeps its margin', hand(80, 14).profile === 'single' && hand(80, 14).rows === 8 && at80x14.askBlurbRows === 0 && at80x14.liftMargin && at80x14.askGap && !at80x14.fieldLift, JSON.stringify([hand(80, 14), at80x14]))
const at82x17 = fitAt(82, 17)
check('82×17: the stacked board would hand five rows, so the card takes one frame and eleven — two blurb lines, the margin and the gap', hand(82, 17).profile === 'single' && hand(82, 17).rows === 11 && at82x17.askBlurbRows === 2 && !at82x17.liftMargin && at82x17.askGap && at82x17.fieldLines === 2 && at82x17.fieldGaps, JSON.stringify([hand(82, 17), at82x17]))
const at80x19 = fitAt(80, 19)
check('80×19: the stacked board hands the seven rows itself and stays stacked — both faces lift, the gap yields', hand(80, 19).profile === 'split' && hand(80, 19).rows === 7 && at80x19.liftMargin && !at80x19.askGap && at80x19.fieldLift, JSON.stringify([hand(80, 19), at80x19]))
const at80x21 = fitAt(80, 21)
check('80×21: the stacked board hands nine rows — no blurb, the margin and the gap stand, two field lines', hand(80, 21).profile === 'split' && hand(80, 21).rows === 9 && at80x21.askBlurbRows === 0 && !at80x21.liftMargin && at80x21.askGap && at80x21.fieldLines === 2 && !at80x21.fieldLift, JSON.stringify([hand(80, 21), at80x21]))

console.log(`\n${failures === 0 ? '✅' : '❌'} contract-card-fit — ${failures === 0 ? 'all checks pass' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
