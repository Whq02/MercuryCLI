#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ADMITTED, check, drive, endLeg, FACE_READY, finish, joined, nonLoopback, netlines,
  printFrame, requireCaptureDriver, scratch, startLeg,
} from '../computer/computerDriveKit.ts'
import { compactBandForm, compactBandRows } from '../../src/components/mercury-ui/geometry.ts'

const driver = requireCaptureDriver('compact-frames')
console.log(`compact frame artifacts: ${scratch}`)
const sizes = process.argv.includes('--size')
  ? [process.argv[process.argv.indexOf('--size') + 1]!.split('x').map(Number)]
  : [[90, 31], [80, 24], [82, 17], [120, 24], [60, 16], [40, 10], [99, 26], [100, 25]]
for (const [cols, rows] of sizes) {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols! < 1 || rows! < 1) throw new Error('size must be positive columns x rows')
  const tag = `compact-frame-${cols}-${rows}`
  const leg = await startLeg(tag, [], null)
  try {
    const result = await drive(driver, leg, { cols: cols!, rows: rows! }, [
      { atTick: 40, awaitText: FACE_READY, minTick: 3, awaitSettleTicks: 2, requireAwait: true, data: '\r', mark: 'boot' },
      { atTick: 100, awaitText: ADMITTED, minTick: 5, awaitSettleTicks: 2, requireAwait: true, data: 'compact-draft' },
      { atTick: 999, awaitText: cols! >= 60 ? 'agents here' : 'A:', targetText: cols! >= 60 ? 'agents here' : 'A:', minTick: 5, awaitSettleTicks: 2, requireAwait: true, data: '', mark: 'typed' },
    ], 135, { MERCURY_DESKTOP_DRIVER: 'none' })
    const frame = result.marks.typed ?? []
    printFrame(`${cols}x${rows} Boot`, result.marks.boot ?? [])
    printFrame(`${cols}x${rows}`, frame)
    check(`${cols}x${rows}: Boot paints its real ready hint`, joined(result.marks.boot ?? []).includes(FACE_READY))
    check(`${cols}x${rows}: all sends reached the actual editor`, result.status === 0 && frame.length > 0, result.stderr)
    check(`${cols}x${rows}: no old top-band telemetry remains`, !frame.some(line => line.includes('daemon') && line.includes('fleet') && line.includes('trace')))
    check(`${cols}x${rows}: no size refusal replaced the chat`, !/resize to continue|terminal too small|too small for|needs \d+(?: columns|[×x]\d+)/.test(joined(frame)))
    const modelRows = frame.map((line, index) => line.includes('Opus 5') ? index : -1).filter(index => index >= 0)
    check(`${cols}x${rows}: the model appears on one chrome row`, modelRows.length === 1, JSON.stringify(modelRows))
    const summaryRows = frame.map((line, index) => /^(?:\d+ sessions? on · \d+ monitors? here · \d+ agents? here|S:\d+ · M:\d+ · A:\d+)(?:\s+(?:⇧← |shift\+← )(?:boot face|concourse))?$/.test(line.trim()) ? index : -1).filter(index => index >= 0)
    check(`${cols}x${rows}: exactly one scoped summary`, summaryRows.length === 1, JSON.stringify(summaryRows))
    check(`${cols}x${rows}: summary never invents a question-mark count`, summaryRows.length === 1 && !frame[summaryRows[0]!]!.includes('?'))
    const editor = frame.findIndex(line => line.includes('compact-draft'))
    const border = editor >= 0 && /╰/.test(frame[editor + 1] ?? '') ? editor + 1 : editor
    check(`${cols}x${rows}: the sessions line immediately follows the real editor frame and closes the window`, editor >= 0 && summaryRows[0] === border + 1 && summaryRows[0] === rows! - 1, `summary=${summaryRows[0]} editor=${editor} border=${border}`)
    check(`${cols}x${rows}: the way back sits at the right edge of the sessions line`, summaryRows.length === 1 && frame[summaryRows[0]!]!.length === cols && /(?:⇧← |shift\+← )(?:boot face|concourse)$/.test(frame[summaryRows[0]!]!), frame[summaryRows[0]!] ?? '')
    check(`${cols}x${rows}: the model row precedes the summary`, modelRows.length === 1 && summaryRows.length === 1 && modelRows[0]! < summaryRows[0]!)
    check(`${cols}x${rows}: no shortcut hint rows`, !/\? for shortcuts|for commands \+ files|ctrl\+t activity|for a new line/.test(joined(frame)))
    const form = compactBandForm(cols!, rows!)
    const bandRows = compactBandRows(cols!, rows!)
    const artRows = frame.slice(0, Math.max(0, bandRows - 1)).filter(line => /[▀▄]{3,}/.test(line)).length
    check(`${cols}x${rows}: the identity band carries the critter at its ${form} form and nothing else does`, (form === 'square' || form === 'dock' ? artRows >= 2 : artRows === 0) && frame.slice(bandRows).every(line => !/[▀▄]{3,}/.test(line)), `band=${form} artRows=${artRows}`)
    check(`${cols}x${rows}: the band closes with its rule exactly when a band is up`, bandRows === 0 ? !frame.some(line => /^─+$/.test(line)) : frame[bandRows - 1] === '─'.repeat(cols!), frame[bandRows - 1] ?? '')
    check(`${cols}x${rows}: no miniature mark and no old top band`, !/▚▛▀▜▞|▖▟▆▙▗|▝▜▆▛▘|▗▙█▟▖/.test(joined(frame)))
    check(`${cols}x${rows}: the model lives in the band when a band is up, on the chip line otherwise`, modelRows.length === 1 && (bandRows > 0 ? modelRows[0]! < bandRows - 1 : modelRows[0]! === border - (border === editor ? 1 : 2)), `model=${modelRows[0]} band=${bandRows}`)
    check(`${cols}x${rows}: the draft was not submitted`, leg.fixture.requests.length === 0)
    check(`${cols}x${rows}: the drive stayed on loopback`, nonLoopback(netlines(leg.netlog)).length === 0)
    const gridPath = join(scratch, `${tag}-${cols}x${rows}-grid.json`)
    const payload = JSON.parse(readFileSync(gridPath, 'utf8')) as { grid: Array<Array<{ c: string }>>; cursor?: { x: number; y: number } }
    check(`${cols}x${rows}: final grid has the exact physical dimensions`, payload.grid.length === rows && payload.grid.every(line => line.length === cols))
    check(`${cols}x${rows}: the live cursor remains in bounds`, payload.cursor !== undefined && payload.cursor.x >= 0 && payload.cursor.x < cols! && payload.cursor.y >= 0 && payload.cursor.y < rows!)
  } finally {
    await endLeg(leg)
  }
}
finish('compact-frames')
