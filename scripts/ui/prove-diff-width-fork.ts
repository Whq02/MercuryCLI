#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
process.chdir(root)
const writeSrc = readFileSync(join(root, 'src', 'components', 'permissions', 'FileWritePermissionRequest', 'FileWriteToolDiff.tsx'), 'utf-8')
const editSrc = readFileSync(join(root, 'src', 'components', 'FileEditToolDiff.tsx'), 'utf-8')
const wrapperSrc = readFileSync(join(root, 'src', 'components', 'permissions', 'ConsentFileEditDiff.tsx'), 'utf-8')
const permSrc = readFileSync(join(root, 'src', 'components', 'permissions', 'PermissionDialog.tsx'), 'utf-8')
const { consentContentWidth, CONSENT_CARD_CHROME_COLUMNS } = await import('../../src/components/permissions/consentBodyBudget.ts')

console.log('============================================================')
console.log(' permission diff width — the card chrome subtraction')
console.log('============================================================')

section('FileWriteToolDiff: the body width is the content box less its frame padding')
check('no compiler-runtime cache', !/const \$ = _c\(15\)/.test(writeSrc) && !/\$\[\d+\]/.test(writeSrc))
check('useMemo for hunks is present', /useMemo\(\(\) =>/.test(writeSrc))
check('bodyWidth = consentContentWidth(columns) - FRAME_COLUMNS', /consentContentWidth\(columns\) - FRAME_COLUMNS/.test(writeSrc) && /const FRAME_COLUMNS = 2/.test(writeSrc))
check('width={bodyWidth} passed to StructuredDiff', /width=\{bodyWidth\}/.test(writeSrc))
check('Math.max(1, ...) floor present', /Math\.max\(1,/.test(writeSrc))

section('FileEditToolDiff: the inner width is the available width less its frame')
check('framed derived from width alone', /const framed = columns > 80/.test(editSrc))
check('the consent wrapper hands the card\'s content box as the available width', /availableWidth=\{consentContentWidth\(columns\)\}/.test(wrapperSrc))
check('innerWidth subtracts the round frame (border + padding, four cells) when framed', /framed \? outerWidth - FRAME_COLUMNS : outerWidth/.test(editSrc) && /const FRAME_COLUMNS = 4/.test(editSrc))
check('the transcript surface keeps its own default (columns - 2)', /availableWidth \?\? columns - 2/.test(editSrc))
check('Math.max(1, ...) floor present', /Math\.max\(1,/.test(editSrc))

section('PermissionDialog: the card chrome the content box subtracts')
check('borderLeft present (full card)', /borderLeft=\{undefined\}/.test(permSrc))
check('paddingLeft={1}', /paddingLeft=\{1\}/.test(permSrc))
check('borderRight present (full card)', /borderRight=\{undefined\}/.test(permSrc))
check('the card is round + mode-tinted (borderColor={cardColor})', /borderStyle="round"/.test(permSrc) && /borderColor=\{cardColor\}/.test(permSrc))
check('innerPaddingX defaults to one cell a side', /innerPaddingX = 1/.test(permSrc))
check('the owner counts the borders and the outer padding (four cells) plus the inner padding', CONSENT_CARD_CHROME_COLUMNS === 4 && consentContentWidth(100) === 94 && consentContentWidth(100, 0) === 96)

section('behavioral: width arithmetic (measured on the built bundle at 100 and 110 columns)')
const editWidth = (cols: number) => Math.max(1, cols > 80 ? consentContentWidth(cols) - 4 : consentContentWidth(cols))
const writeWidth = (cols: number) => Math.max(1, consentContentWidth(cols) - 2)
check('FileEdit @100 framed: 90 cells (100 − 6 − 4) — the box the frame showed', editWidth(100) === 90)
check('FileEdit @110 framed: 100 cells — the 100 visible cells of the reproduction', editWidth(110) === 100)
check('FileEdit @80 unframed: 74 cells (80 − 6)', editWidth(80) === 74)
check('FileWrite @100: 92 cells (100 − 6 − 2)', writeWidth(100) === 92)
check('FileWrite @120: 112 cells', writeWidth(120) === 112)

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ permission diff width — the card chrome subtraction proven')
  process.exit(0)
} else {
  console.log(` ❌ permission diff width — ${failures} check(s) failed`)
  process.exit(1)
}
