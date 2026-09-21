#!/usr/bin/env bun
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 300)}` : ''}`)
}
const card = await import('../../src/components/concourse/ContractOfferCard.tsx')
const wrapText = (await import('../../src/ink/wrap-text.ts')).default
const lines = (text: string, columns: number): number => wrapText(text, columns, 'wrap').split('\n').length

console.log('§1 the text columns follow the pane: the mount, the frame and the body each take two')
check('80 columns: the live pane hands 47, the blurb wraps at 39', card.contractCardTextColumns(47) === 39)
check('82 columns: the live pane hands 49, the blurb wraps at 41', card.contractCardTextColumns(49) === 41)
check('the ask blurb wraps to nine lines at 39 and at 41 columns (the before frames show eight and the pane cuts the ninth)', lines(card.CONTRACT_ASK_BLURB, 39) === 9 && lines(card.CONTRACT_ASK_BLURB, 41) === 9, `${lines(card.CONTRACT_ASK_BLURB, 39)} / ${lines(card.CONTRACT_ASK_BLURB, 41)}`)
check('the field blurb wraps to three lines at both', lines(card.CONTRACT_FIELD_BLURB, 39) === 3 && lines(card.CONTRACT_FIELD_BLURB, 41) === 3)

console.log('§2 the ask face: the blurb yields row by row before the question and the Yes/No rows')
const at8 = card.contractCardFit(8, 39)
check('80×14 (eight rows): no blurb, the frame lifts its top margin, the card is the eight rows', at8.askBlurbRows === 0 && at8.liftMargin, JSON.stringify(at8))
const at11 = card.contractCardFit(11, 41)
check('82×17 (eleven rows): one blurb line beside the keys row that wraps at 41 columns, the margin stays', at11.askBlurbRows === 1 && !at11.liftMargin, JSON.stringify(at11))
const at15 = card.contractCardFit(15, 39)
check('80×21 (fifteen rows): five blurb lines beside the wrapped keys row, the keys and the frame back on the pane', at15.askBlurbRows === 5 && !at15.liftMargin, JSON.stringify(at15))
const at18 = card.contractCardFit(18, 39)
check('the keys row wraps at 39 columns and stands on one row at 100', card.contractCardFit(20, 39).askBlurbRows === null && card.contractCardFit(19, 39).askBlurbRows === null && card.contractCardFit(18, 39).askBlurbRows === 8 && card.contractCardFit(18, 100).askBlurbRows === null)
check('nineteen rows and up at the compact widths, eighteen at the wide ones: the whole blurb, nothing capped (the earlier look byte for byte)', card.contractCardFit(19, 39).askBlurbRows === null && !card.contractCardFit(19, 39).liftMargin && card.contractCardFit(40, 100).askBlurbRows === null && at18.askBlurbRows === 8 && !at18.liftMargin)
check('a cap never exceeds the blurb itself', [8, 9, 10, 12, 14, 16, 17].every(rows => { const f = card.contractCardFit(rows, 39); return f.askBlurbRows === null || f.askBlurbRows <= 9 }))

console.log('§3 the field face: the field keeps its two shipped lines, the blurb and the gaps yield, the cap is what fits')
check('eight rows: no blurb, one field line, no gaps (title, question, field, two key rows inside the frame)', at8.fieldBlurbRows === 0 && at8.fieldLines === 1 && !at8.fieldGaps, JSON.stringify(at8))
check('eleven rows: no blurb, two field lines, the gaps kept', at11.fieldBlurbRows === 0 && at11.fieldLines === 2 && at11.fieldGaps, JSON.stringify(at11))
check('fifteen rows: the whole blurb and the gaps as before, the field capped at the three lines that fit', at15.fieldBlurbRows === null && at15.fieldLines === 3 && at15.fieldGaps, JSON.stringify(at15))
check('twenty rows: the whole blurb, six field lines as before', card.contractCardFit(20, 39).fieldBlurbRows === null && card.contractCardFit(20, 39).fieldLines === 6 && card.contractCardFit(20, 39).fieldGaps, JSON.stringify(card.contractCardFit(20, 39)))
check('every row count from four up yields a face that needs no more rows than the pane has, with the field at one line', [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18].every(rows => { const f = card.contractCardFit(rows, 39); const blurb = f.fieldBlurbRows ?? 3; return (f.fieldGaps ? 9 : 7) + blurb + 1 <= Math.max(rows, 8) }))

console.log(`\n${failures === 0 ? '✅' : '❌'} contract-card-fit — ${failures === 0 ? 'all checks pass' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
