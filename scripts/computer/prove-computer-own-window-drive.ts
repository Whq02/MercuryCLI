import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { actLog, check, drive, endLeg, finish, netlines, nonLoopback, OPENING, printFrame, requireCaptureDriver, scratch, section, SIZES, startLeg } from './computerDriveKit.ts'

const driver = requireCaptureDriver('computer-drives')
const framesArg = process.argv.indexOf('--frames')
const frames = framesArg < 0 ? undefined : resolve(process.argv[framesArg + 1]!)
if (frames) mkdirSync(frames, { recursive: true })
const cwd = join(scratch, 'project')
mkdirSync(cwd)
const own = { identity: 'com.example.Terminal', name: 'Terminal', pid: 4100, title: 'mercury', windowId: '101', bounds: { x: 0, y: 700, width: 1440, height: 200 } }
const sibling = { ...own, title: 'shell', windowId: '102', bounds: { x: 0, y: 0, width: 800, height: 600 } }
const other = { identity: 'com.example.TextEdit', name: 'TextEdit', pid: 4200, title: 'Document', bounds: sibling.bounds }
const refusal = 'type refused: the application in front is the terminal running this session — a keystroke there would land in this conversation; switch to the target application first'

for (const size of SIZES) {
  for (const [name, frontmost, allowed] of [['sibling', sibling, true], ['own', own, false], ['other', other, true]] as const) {
    const tag = `window-${name}-${size.cols}x${size.rows}`
    section(tag)
    const leg = await startLeg(tag, [
      { kind: 'tool_use', name: 'Computer', input: { action: 'type', text: 'window proof', capture: false } },
      { kind: 'text', text: 'Window check complete.' },
    ], { ownTerminal: own, frontmost }, cwd)
    try {
      const result = await drive(driver, leg, size, [
        ...OPENING('check the target window'),
        { requireAwait: true, awaitText: 'Window check complete.', awaitStableTicks: 2, mark: 'result', data: '' },
      ], 200, { MERCURY_COMPUTER_ACCESS: 'full', ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key' }, 'Window check complete.')
      check(`${tag}: the product finished the fixture turn`, result.status === 0, `${result.status} ${result.endReason} ${result.stderr.slice(-500)}`)
      const requests = leg.fixture.messageRequests()
      const wire = JSON.stringify(requests)
      const acts = actLog(leg.log)
      const typed = acts.filter(act => act.act === 'typeText' && act.outcome === 'done')
      check(`${tag}: ${allowed ? 'the target receives the text' : 'the own window receives no text'}`, typed.length === (allowed ? 1 : 0), JSON.stringify(acts))
      check(`${tag}: the tool record ${allowed ? 'carries success without the own-window refusal' : 'keeps the own-window refusal word for word'}`, allowed ? wire.includes('type 12 chars') && !wire.includes(refusal) : wire.includes(refusal), wire.slice(-1600))
      check(`${tag}: nothing left loopback`, nonLoopback(netlines(leg.netlog)).length === 0)
      printFrame(tag, result.marks.result ?? result.final)
      console.log(JSON.stringify({ tag, home: leg.home, acts, requests }))
      if (frames) {
        writeFileSync(join(frames, `${tag}.json`), JSON.stringify({ size, home: leg.home, acts, requests, result }, null, 2) + '\n')
      }
    } finally {
      await endLeg(leg)
    }
  }
}
finish('prove-computer-own-window-drive')
