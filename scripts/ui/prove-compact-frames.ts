#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  check, drive, endLeg, FACE_READY, finish, joined, nonLoopback, netlines,
  printFrame, requireCaptureDriver, scratch, startLeg,
} from '../computer/computerDriveKit.ts'

const driver = requireCaptureDriver('compact-frames')
console.log(`compact frame artifacts: ${scratch}`)
const sizes = process.argv.includes('--size')
  ? [process.argv[process.argv.indexOf('--size') + 1]!.split('x').map(Number)]
  : [[80, 24], [120, 24], [60, 16], [40, 10], [99, 26], [100, 25]]
for (const [cols, rows] of sizes) {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols! < 1 || rows! < 1) throw new Error('size must be positive columns x rows')
  const tag = `compact-frame-${cols}-${rows}`
  const leg = await startLeg(tag, [], null)
  try {
    const result = await drive(driver, leg, { cols: cols!, rows: rows! }, [
      { atTick: 40, awaitText: FACE_READY, minTick: 3, awaitSettleTicks: 2, requireAwait: true, data: '\r', mark: 'boot' },
      { atTick: 100, awaitText: '? for shortcuts', minTick: 5, awaitSettleTicks: 2, requireAwait: true, data: 'compact-draft' },
      { atTick: 999, awaitText: 'compact-draft', minTick: 5, awaitSettleTicks: 2, requireAwait: true, data: '', mark: 'typed' },
    ], 135, { MERCURY_COMPUTER_USE: undefined })
    const frame = result.marks.typed ?? []
    printFrame(`${cols}x${rows} Boot`, result.marks.boot ?? [])
    printFrame(`${cols}x${rows}`, frame)
    check(`${cols}x${rows}: Boot paints its real ready hint`, joined(result.marks.boot ?? []).includes(FACE_READY))
    check(`${cols}x${rows}: all sends reached the actual editor`, result.status === 0 && frame.length > 0, result.stderr)
    check(`${cols}x${rows}: no old top-band telemetry remains`, !frame.some(line => line.includes('daemon') && line.includes('fleet') && line.includes('trace')))
    check(`${cols}x${rows}: no size refusal replaced the chat`, !/resize to continue|terminal too small|needs 80 columns/.test(joined(frame)))
    const modelRows = frame.map((line, index) => line.includes('Opus 5') ? index : -1).filter(index => index >= 0)
    check(`${cols}x${rows}: the model appears on one chrome row`, modelRows.length === 1, JSON.stringify(modelRows))
    const summaryRows = frame.map((line, index) => /\d+ sessions? on|S:\d+/.test(line) ? index : -1).filter(index => index >= 0)
    check(`${cols}x${rows}: exactly one scoped summary`, summaryRows.length === 1, JSON.stringify(summaryRows))
    check(`${cols}x${rows}: summary never invents a question-mark count`, summaryRows.length === 1 && !frame[summaryRows[0]!]!.includes('?'))
    const editor = frame.findIndex(line => line.includes('compact-draft'))
    const border = editor > 0 && /╭/.test(frame[editor - 1]!) ? editor - 1 : editor
    check(`${cols}x${rows}: summary immediately precedes the real editor frame`, editor >= 0 && summaryRows[0] === border - 1, `summary=${summaryRows[0]} editor=${editor} border=${border}`)
    check(`${cols}x${rows}: the plain status precedes the summary`, modelRows.length === 1 && summaryRows.length === 1 && modelRows[0]! < summaryRows[0]!)
    check(`${cols}x${rows}: no compact critter grid or miniature mark`, !/▚▛▀▜▞|▖▟▆▙▗|▄▀▀▀▀▀▀▀▄|▀▀▀▀▀▀▀▀▀/.test(joined(frame)))
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
