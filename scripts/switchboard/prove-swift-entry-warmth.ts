#!/usr/bin/env bun
process.env.MERCURY_DESKTOP_DRIVER = 'none'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'swift-warmth-')))
mkdirSync(join(SCRATCH, 'home'), { recursive: true })
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')

let failures = 0
const warmthFailureHint = (label: string): string => {
  if (/the Chat|transcript modes|cold loading line is keyed/.test(label)) return 'change how the chat screen uses the warmth in src/screen/chat/useChatSession.ts (paintedMessages, entryLoadingLine) and src/screen/concourse-model/sessionWarmth.ts'
  return 'change the store or the paint selection in src/screen/concourse-model/sessionWarmth.ts (armEntryWarmth, settleEntryWarmth, paintedTranscriptOf, entryLoadingLineOf)'
}
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  const shown = cond ? detail : `${detail ? `${detail} — ` : ''}${warmthFailureHint(label)}`
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${shown ? ` — ${shown}` : ''}`)
}

console.log('§1 the wiring (mirror publishes · entry arms/settles · Chat paints render-only)')
{
  const { openTranscriptPart } = await import('../ui/chatScenarios.ts')
  const view = await openTranscriptPart('swift-warmth-transcript', { keepHome: true })
  const rows = view.rowsOf(4)
  await view.setRows(rows.slice(0, 2))
  const live = view.part.value().transcriptMessages
  await view.act(() => view.part.value().handleEnterTranscript())
  await view.setRows(rows)
  const kept = view.part.value().transcriptMessages
  await view.close()
  check(
    '…while the transcript modes keep the connector records',
    live.length === 2 && live[0] === rows[0] && live[1] === rows[1] && kept.length === 2 && kept[0] === rows[0] && kept[1] === rows[1],
    `${live.length} live rows, ${kept.length} kept of ${rows.length}`,
  )
}

console.log('\n§2 the store (bounded by construction · per-session settle)')
const w = await import('../../src/screen/concourse-model/sessionWarmth.ts')
const row = (i: number, text: string): Record<string, unknown> => ({
  type: 'assistant',
  uuid: `00000000-0000-4000-a000-${String(i).padStart(12, '0')}`,
  timestamp: new Date(1750000000000 + i * 1000).toISOString(),
  message: { role: 'assistant', content: [{ type: 'text', text }] },
})
w._resetSessionWarmthForTesting()
const forty = Array.from({ length: 40 }, (_, i) => row(i, `warm row ${i}`))
w.rememberSessionWarmth('s1', forty as never, 3)
w.armEntryWarmth('s1', 'the census chat')
const armed = w.enteringWarmth()
check('the tail slice is bounded (40 in → the newest 32 kept)', armed !== null && armed.rows.length === w.WARMTH_TAIL_ROWS)
check(
  '…keeping the NEWEST rows, shed arithmetic honest (3 before + 8 trimmed)',
  armed !== null &&
    (armed.rows[armed.rows.length - 1] as { uuid?: string }).uuid?.endsWith('39') === true &&
    armed.shed === 11,
  `shed=${armed?.shed}`,
)
for (let s = 2; s <= 10; s++) w.rememberSessionWarmth(`s${s}`, [row(0, `s${s}`)] as never, 0)
w.armEntryWarmth('s1')
check('the LRU cap holds (10 sessions remembered → the oldest slice fell off)', w.enteringWarmth()?.rows.length === 0)
w.armEntryWarmth('s10', 'newer entry')
w.settleEntryWarmth('s1')
check("an older landing's settle never kills a NEWER entry's arm", w.enteringWarmth()?.sessionId === 's10')
w.settleEntryWarmth('s10')
check('the named settle stands the arm down', w.enteringWarmth() === null)
w.armEntryWarmth('s9')
check('an armed cold entry answers zero rows (the loading row case)', w.enteringWarmth()?.rows.length === 1 || w.enteringWarmth()?.rows.length === 0)
w.evictSessionWarmth('s9')
w.settleEntryWarmth()

console.log('\n§3 the paint selection')
w._resetSessionWarmthForTesting()
const real = [row(100, 'the connector truth')] as never[]
w.rememberSessionWarmth('s1', [row(1, 'stale warmth')] as never, 0)
w.armEntryWarmth('s1', 'census')
check('the truth always wins (non-empty records ignore the hint, identity kept)', w.paintedTranscriptOf(real as never, w.enteringWarmth()) === (real as never))
check('…and the loading line stays down while records exist', w.entryLoadingLineOf(w.enteringWarmth(), false) === null)
const warmPaint = w.paintedTranscriptOf([], w.enteringWarmth())
check('empty records + warm arm → the warm tail', warmPaint.length === 1 && JSON.stringify(warmPaint).includes('stale warmth'))
check('…and no loading line beside content', w.entryLoadingLineOf(w.enteringWarmth(), true) === null)
w.evictSessionWarmth('s1')
check(
  'empty records + cold arm → the honest loading line, named',
  w.entryLoadingLineOf(w.enteringWarmth(), true) === 'opening census — loading the conversation…',
  String(w.entryLoadingLineOf(w.enteringWarmth(), true)),
)
check('…while the row half stays the plain empty identity', w.paintedTranscriptOf([], w.enteringWarmth()).length === 0)
w.settleEntryWarmth()
const plain: never[] = []
check('unarmed → plain identity (the ordinary chat path never re-renders over this seam)', w.paintedTranscriptOf(plain as never, w.enteringWarmth()) === (plain as never))
check('unarmed → no loading line', w.entryLoadingLineOf(w.enteringWarmth(), true) === null)

console.log('\n§4 the first frame paints content (static render through the real pipeline)')
const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const { renderMessagesToPlainText } = await import('../../src/screen/chat/exportRenderer.tsx')
const { getAllBaseTools } = await import('../../src/tools/kit/toolList.ts')
w._resetSessionWarmthForTesting()
w.rememberSessionWarmth('s1', Array.from({ length: 6 }, (_, i) => row(i, `the mirror held row ${i}`)) as never, 0)
w.armEntryWarmth('s1', 'census')
const warmText = await renderMessagesToPlainText(w.paintedTranscriptOf([], w.enteringWarmth()) as never, getAllBaseTools() as never, 100)
check('the warm first frame carries the tail\'s own words', warmText.includes('the mirror held row 5'), warmText.slice(0, 80))
check('…and is never blank', warmText.trim().length > 0)
w.evictSessionWarmth('s1')
const React = (await import('react')).default
const { renderToString } = await import('../../src/screen/renderer/staticRender.tsx')
const { Box, Text } = await import('../../src/screen/themedRenderer.js')
const line = w.entryLoadingLineOf(w.enteringWarmth(), true)
const coldText = await renderToString(
  React.createElement(Box, { paddingLeft: 1, marginTop: 1 }, React.createElement(Text, { dimColor: true }, line)),
)
check('the cold first frame carries the loading line', coldText.includes('opening census — loading the conversation…'), coldText.slice(0, 80))
check('…and is never blank', coldText.trim().length > 0)

console.log('\n§5 the identity law (the covered-slot entry: C → board → A)')
w._resetSessionWarmthForTesting()
const cRecords = [row(200, 'the covered chat C words')] as never[]
w.rememberSessionWarmth('A', [row(1, 'warm A tail')] as never, 0)
w.armEntryWarmth('A', 'the chosen chat', 'C')
check('the arm carries the covered identity', w.enteringWarmth()?.coveredSessionId === 'C')
const coveredFrame = w.paintedTranscriptOf(cRecords as never, w.enteringWarmth(), 'C')
check(
  '(a) the frame after choosing A never paints C\'s rows (the cross-session bleed)',
  !JSON.stringify(coveredFrame).includes('the covered chat C words'),
)
check('(b) A\'s warm tail paints while the slot still holds C', JSON.stringify(coveredFrame).includes('warm A tail'))
check('…and no loading line beside the warm content', w.entryLoadingLineOf(w.enteringWarmth(), false, 'C') === null)
w.evictSessionWarmth('A')
check(
  '(b-cold) the honest loading line covers C\'s records for a cold A',
  w.entryLoadingLineOf(w.enteringWarmth(), false, 'C') === 'opening the chosen chat — loading the conversation…',
  String(w.entryLoadingLineOf(w.enteringWarmth(), false, 'C')),
)
check('…and the row half paints no covered rows', w.paintedTranscriptOf(cRecords as never, w.enteringWarmth(), 'C').length === 0)
const aRecords = [row(300, 'A landed truth')] as never[]
check('the armed mount keeps truth-wins (identity kept)', w.paintedTranscriptOf(aRecords as never, w.enteringWarmth(), 'A') === (aRecords as never))
w.rememberSessionWarmth('A', [row(2, 'warm A again')] as never, 0)
const tRecords = [row(400, 'third session T truth')] as never[]
check('(c) a third identity paints its own records', w.paintedTranscriptOf(tRecords as never, w.enteringWarmth(), 'T') === (tRecords as never))
check('(c) …and never wears the entry\'s loading line', w.entryLoadingLineOf(w.enteringWarmth(), true, 'T') === null)
check('(c) …and never borrows the armed warmth', !JSON.stringify(w.paintedTranscriptOf([] as never, w.enteringWarmth(), 'T')).includes('warm A again'))
check('the resting slot ("" — landing in flight) still paints the warmth', JSON.stringify(w.paintedTranscriptOf([] as never, w.enteringWarmth(), '')).includes('warm A again'))
w._resetSessionWarmthForTesting()

console.log('\n§4 the chat screen, read off its mounted session part')
{
  const { openSessionPart } = await import('../ui/chatScenarios.ts')
  const session = await openSessionPart('warmth-covered', { keepHome: true })
  const covered = [row(500, 'the covered chat words')] as never[]
  const warm = [row(501, 'warm tail of the entered chat')] as never[]
  await session.plant({ messages: covered })
  w.rememberSessionWarmth('warmth-entered', warm as never, 0)
  w.armEntryWarmth('warmth-entered', 'the entered chat', 'warmth-covered')
  await session.plant({})
  const overCovered = session.part.value().paintedMessages
  const shownLive = session.part.value().displayedMessages
  const frozen = [row(502, 'a frozen transcript row')] as never[]
  await session.plant({ inVirtualTranscript: true, transcriptMessages: frozen })
  const shownInTranscript = session.part.value().displayedMessages
  await session.plant({ inVirtualTranscript: false })
  const armedOverCovered = w.enteringWarmth()?.sessionId
  await session.focus('warmth-entered', { messages: [] })
  const armedInEntered = w.enteringWarmth()?.sessionId
  const landedRows = [row(503, 'the entered chat landed')] as never[]
  await session.plant({ messages: landedRows })
  await new Promise(resolve => setTimeout(resolve, 80))
  const afterFold = w.enteringWarmth()
  const paintedAfterFold = session.part.value().paintedMessages
  w.armEntryWarmth('warmth-entered', 'the entered chat again')
  const keptAfterFold = w.enteringWarmth()?.rows.length
  w.settleEntryWarmth('warmth-entered')
  w.armEntryWarmth('warmth-cold', 'the cold chat')
  await session.focus('warmth-cold', { messages: [] })
  const coldLine = session.part.value().entryLoadingLine
  await session.focus('warmth-third')
  await new Promise(resolve => setTimeout(resolve, 80))
  const afterThird = w.enteringWarmth()
  await session.close()
  check('the Chat paints through the one pure composer, keyed on the store version AND the focused identity', overCovered.length === 1 && overCovered[0] === warm[0] && paintedAfterFold === landedRows, `${overCovered.length} rows over the covered chat`)
  check('the Chat settles the hint at fold-complete replace (evict + settle)', armedInEntered === 'warmth-entered' && afterFold === null && keptAfterFold === 0, `${String(armedInEntered)} · ${JSON.stringify(afterFold)} · ${String(keptAfterFold)} rows still kept`)
  check('the cold loading line is keyed the same way', coldLine === 'opening the cold chat — loading the conversation…', String(coldLine))
  check('the Chat settle spares armed-or-covered', armedOverCovered === 'warmth-entered' && armedInEntered === 'warmth-entered' && afterThird === null, `${String(armedOverCovered)} · ${String(armedInEntered)} · ${JSON.stringify(afterThird)}`)
}

console.log(failures === 0 ? '\nprove-swift-entry-warmth: ALL LAWS HOLD' : `\nprove-swift-entry-warmth: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
