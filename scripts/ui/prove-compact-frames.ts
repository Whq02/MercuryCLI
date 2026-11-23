#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  ADMITTED, check, drive, endLeg, FACE_READY, finish, joined, nonLoopback, netlines,
  printFrame, requireCaptureDriver, ROOT, scratch, startLeg,
} from '../computer/computerDriveKit.ts'
import { keyHintLabel } from '../../src/screen/widgets/keyHintLabel.ts'
import { compactWorkSummaryText } from '../../src/screen/tasks/useFocusedWork.ts'
import { stringWidth } from '../../src/screen/renderer/stringWidth.ts'

const driver = requireCaptureDriver('compact-frames')
console.log(`compact frame artifacts: ${scratch}`)
const sizes = process.argv.includes('--size')
  ? [process.argv[process.argv.indexOf('--size') + 1]!.split('x').map(Number)]
  : [[90, 31], [80, 24], [82, 17], [120, 24], [60, 16], [40, 10], [99, 26], [100, 25]]
type Rung = { form: 'none' | 'line' | 'dock'; bandRows: number }
const ladderHome = join(scratch, 'ladder-home')
mkdirSync(ladderHome, { recursive: true })
const ladderRead = spawnSync(process.execPath, ['-e', `import { compactBandForm, compactBandRows } from ${JSON.stringify(pathToFileURL(join(ROOT, 'src', 'screen', 'widgets', 'geometry.ts')).href)}\nconsole.log(JSON.stringify(${JSON.stringify(sizes)}.map(([c, r]) => [c, r, compactBandForm(c, r), compactBandRows(c, r)])))`], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, MERCURY_CONFIG_DIR: ladderHome, MERCURY_CREDENTIAL_STORE: 'file' } })
const ladder = new Map<string, Rung>()
for (const [c, r, form, bandRows] of JSON.parse(ladderRead.stdout.trim().split('\n').pop() || '[]') as Array<[number, number, Rung['form'], number]>) ladder.set(`${c}x${r}`, { form, bandRows })
check('the band ladder is read in a home of its own with no settings file (the default critter size), never the ambient home', ladderRead.status === 0 && ladder.size === sizes.length, `the ladder reader failed to import compactBandForm and compactBandRows from src/screen/widgets/geometry.ts or returned a wrong count; exit=${ladderRead.status}; ${ladderRead.stderr.slice(-400)}`)
for (const [cols, rows] of sizes) {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols! < 1 || rows! < 1) throw new Error('size must be positive columns x rows')
  const tag = `compact-frame-${cols}-${rows}`
  const summaryWords = compactWorkSummaryText({ sessionsOn: 1, monitorsHere: 0, agentsHere: 0 }, cols! - (stringWidth(keyHintLabel('⇧← boot face')) + 1))
  const summaryNeedle = summaryWords.includes('crewmates here') ? 'crewmates here' : 'C:'
  const leg = await startLeg(tag, [], null)
  try {
    const result = await drive(driver, leg, { cols: cols!, rows: rows! }, [
      { atTick: 40, awaitText: FACE_READY, minTick: 3, awaitSettleTicks: 2, awaitStableTicks: 3, requireAwait: true, data: '\r', mark: 'boot' },
      { atTick: 100, awaitText: ADMITTED, minTick: 5, awaitSettleTicks: 2, requireAwait: true, data: 'compact-draft' },
      { atTick: 999, awaitText: summaryNeedle, targetText: summaryNeedle, minTick: 5, awaitSettleTicks: 2, requireAwait: true, data: '', mark: 'typed' },
    ], 135, { MERCURY_DESKTOP_DRIVER: 'none' })
    const frame = result.marks.typed ?? []
    printFrame(`${cols}x${rows} Boot`, result.marks.boot ?? [])
    printFrame(`${cols}x${rows}`, frame)
    check(`${cols}x${rows}: Boot paints its real ready hint`, joined(result.marks.boot ?? []).includes(FACE_READY), 'the Boot face did not paint its ready hint at this size; see the printed Boot frame above and the compact face in src/screen/boot-face/splash/face.tsx')
    check(`${cols}x${rows}: all sends reached the actual editor`, result.status === 0 && frame.length > 0, 'the capture drive did not finish or the typed frame is empty (rebuild dist with bun run build.ts); drive output: ' + result.stderr)
    check(`${cols}x${rows}: no old top-band telemetry remains`, !frame.some(line => line.includes('daemon') && line.includes('fleet') && line.includes('trace')), 'the old top-band telemetry row is back in the compact chat; remove it from the chat chrome, the printed frame shows the row')
    check(`${cols}x${rows}: no size refusal replaced the chat`, !/resize to continue|terminal too small|too small for|needs \d+(?: columns|[×x]\d+)/.test(joined(frame)), 'a size refusal replaced the chat at a size that must stay usable; see the printed frame above for the refusal text and search src/ for that text')
    const modelRows = frame.map((line, index) => line.includes('Opus 5') ? index : -1).filter(index => index >= 0)
    check(`${cols}x${rows}: the model appears on one chrome row`, modelRows.length === 1, 'the model name must appear on exactly one chrome row of the compact frame, see the printed frame; rows found: ' + JSON.stringify(modelRows))
    const summaryRows = frame.map((line, index) => /^(?:\d+ sessions? on · \d+ monitors? here · \d+ crewmates? here|S:\d+ · M:\d+ · C:\d+)(?:\s+(?:⇧← |shift\+← )(?:boot face|concourse))?$/.test(line.trim()) ? index : -1).filter(index => index >= 0)
    check(`${cols}x${rows}: exactly one scoped summary`, summaryRows.length === 1, 'the compact frame must show exactly one sessions summary line (text from compactWorkSummaryText in src/screen/tasks/useFocusedWork.ts); rows found: ' + JSON.stringify(summaryRows))
    check(`${cols}x${rows}: summary never invents a question-mark count`, summaryRows.length === 1 && !frame[summaryRows[0]!]!.includes('?'), 'the sessions summary line must show real counts, never a question mark (compactWorkSummaryText in src/screen/tasks/useFocusedWork.ts); see the printed frame')
    const editor = frame.findIndex(line => line.includes('compact-draft'))
    const border = editor >= 0 && /╰/.test(frame[editor + 1] ?? '') ? editor + 1 : editor
    check(`${cols}x${rows}: the sessions line immediately follows the real editor frame and closes the window`, editor >= 0 && summaryRows[0] === border + 1 && summaryRows[0] === rows! - 1, `the sessions line must sit directly under the editor frame on the last row of the window, see the printed frame; summary=${summaryRows[0]} editor=${editor} border=${border}`)
    check(`${cols}x${rows}: the way back sits at the right edge of the sessions line`, summaryRows.length === 1 && frame[summaryRows[0]!]!.length === cols && /(?:⇧← |shift\+← )(?:boot face|concourse)$/.test(frame[summaryRows[0]!]!), 'the sessions line must be exactly the window width and end with the way-back hint; line: ' + (frame[summaryRows[0]!] ?? ''))
    check(`${cols}x${rows}: the model row precedes the summary`, modelRows.length === 1 && summaryRows.length === 1 && modelRows[0]! < summaryRows[0]!, 'the model row must come above the sessions line in the compact frame, see the printed frame')
    check(`${cols}x${rows}: no shortcut hint rows`, !/\? for shortcuts|for commands \+ files|ctrl\+t activity|for a new line/.test(joined(frame)), 'a shortcut hint row appeared in the compact chat; remove it from the compact chat chrome, the printed frame shows which')
    const { form, bandRows } = ladder.get(`${cols}x${rows}`) ?? { form: 'none', bandRows: 0 }
    const artRows = frame.slice(0, Math.max(0, bandRows - 1)).filter(line => /[▀▄]{3,}/.test(line)).length
    check(`${cols}x${rows}: the identity band carries the critter at its ${form} form and nothing else does`, (form === 'dock' ? artRows >= 2 : artRows === 0) && frame.slice(bandRows).every(line => !/[▀▄]{3,}/.test(line)), `the critter must be drawn only in the identity band and only at the form compactBandForm in src/screen/widgets/geometry.ts returns; band=${form} artRows=${artRows}`)
    check(`${cols}x${rows}: the band closes with its rule exactly when a band is up`, bandRows === 0 ? !frame.some(line => /^─+$/.test(line)) : frame[bandRows - 1] === '─'.repeat(cols!), 'the identity band must close with a full-width rule on its last row exactly when compactBandRows in src/screen/widgets/geometry.ts says a band is up; row: ' + (frame[bandRows - 1] ?? ''))
    check(`${cols}x${rows}: no miniature mark and no old top band`, !/▚▛▀▜▞|▖▟▆▙▗|▝▜▆▛▘|▗▙█▟▖/.test(joined(frame)), 'an old miniature mark is back in the compact frame; remove it from the compact chat chrome, the printed frame shows it')
    check(`${cols}x${rows}: the model lives in the band when a band is up, on the chip line otherwise`, modelRows.length === 1 && (bandRows > 0 ? modelRows[0]! < bandRows - 1 : modelRows[0]! === border - (border === editor ? 1 : 2)), `the model row must sit inside the band when one is up (compactBandRows in src/screen/widgets/geometry.ts), else on the chip line above the editor; model=${modelRows[0]} band=${bandRows}`)
    check(`${cols}x${rows}: the draft was not submitted`, leg.fixture.requests.length === 0, 'the typed draft was sent to the model; the compact editor must not submit without Enter, requests seen: ' + leg.fixture.requests.length)
    check(`${cols}x${rows}: the drive stayed on loopback`, nonLoopback(netlines(leg.netlog)).length === 0, 'the drive reached a non-loopback host; keep the session on the mock server of startLeg. Hosts: ' + nonLoopback(netlines(leg.netlog)).join(' | '))
    const gridPath = join(scratch, `${tag}-${cols}x${rows}-grid.json`)
    const payload = JSON.parse(readFileSync(gridPath, 'utf8')) as { grid: Array<Array<{ c: string }>>; cursor?: { x: number; y: number } }
    check(`${cols}x${rows}: final grid has the exact physical dimensions`, payload.grid.length === rows && payload.grid.every(line => line.length === cols), 'the capture grid size differs from the asked size; the capture drive resized or did not finish, see the drive output of the earlier check')
    check(`${cols}x${rows}: the live cursor remains in bounds`, payload.cursor !== undefined && payload.cursor.x >= 0 && payload.cursor.x < cols! && payload.cursor.y >= 0 && payload.cursor.y < rows!, 'the final cursor was missing or outside the window; the compact chat parked the cursor off screen')
  } finally {
    await endLeg(leg)
  }
}
finish('compact-frames')
