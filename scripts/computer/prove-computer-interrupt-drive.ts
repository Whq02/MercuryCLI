#!/usr/bin/env bun
import { actLog, check, drive, endLeg, finish, joined, netlines, nonLoopback, OPENING, printFrame, requireCaptureDriver, rowsHaving, section, SIZES, startLeg } from './computerDriveKit.ts'

const driver = requireCaptureDriver('computer-drives')
const CARD_NEEDLE = 'first act in this application'

for (const size of SIZES) {
  section(`the interrupt drive at ${size.cols}×${size.rows}`)
  const leg = await startLeg(
    `interrupt-${size.cols}`,
    [
      { kind: 'tool_use', preText: 'Looking at the screen.\n', name: 'Computer', input: { action: 'screenshot' } },
      { kind: 'tool_use', preText: 'Clicking the document.\n', name: 'Computer', input: { action: 'click', x: 812, y: 300 } },
      { kind: 'tool_use', preText: 'Typing.\n', name: 'Computer', input: { action: 'type', text: 'hello' } },
      { kind: 'tool_use', preText: 'Pressing enter.\n', name: 'Computer', input: { action: 'key', key: 'Enter' } },
      { kind: 'text', text: 'Done.' },
    ],
    { holdMs: 1500 },
  )
  const res = drive(driver, leg, size, [
    ...OPENING('click and type'),
    { requireAwait: true, awaitText: 'first act', awaitStableTicks: 2, mark: 'card', data: '\r' },
    { requireAwait: true, awaitText: 'hands off', awaitStableTicks: 1, mark: 'driving', data: '' },
    { requireAwait: true, awaitText: 'interrupted', awaitStableTicks: 3, mark: 'interrupted', data: 'z' },
    { afterPrevTicks: 4, mark: 'typed', data: '' },
  ], 240)
  await endLeg(leg)
  check(`${size.cols}: the drive delivered every send`, res.status === 0, `vshot ${res.status} · ${res.endReason} · ${res.stderr.slice(-400)}`)
  const driving = res.marks.driving ?? []
  check(`${size.cols}: the footer was up when esc landed`, rowsHaving(driving, 'hands off'), driving.filter(r => r.includes('hands off')).join(' · '))
  const interrupted = res.marks.interrupted ?? []
  printFrame(`${size.cols}×${size.rows} interrupted`, interrupted)
  const text = joined(interrupted)
  check(`${size.cols}: the transcript row names the interruption (whole words, wrapped or not)`, text.includes('interrupted by the operator') && text.includes('released'), text.slice(0, 600))
  check(`${size.cols}: the footer is gone`, !rowsHaving(interrupted, 'hands off'))
  check(`${size.cols}: no type or key row followed`, !text.includes('Computer type') && !text.includes('Computer key') && !text.includes('Done.'), text.slice(0, 600))
  const typed = res.marks.typed ?? []
  printFrame(`${size.cols}×${size.rows} typed`, typed)
  check(`${size.cols}: the composer took a typed character afterwards`, typed.some(r => /[❯›>]\s?z(\s|$)/.test(r)), typed.filter(r => /[❯›>]/.test(r)).join(' · '))
  const log = actLog(leg.log).map(a => `${a.act}:${a.outcome}`)
  check(`${size.cols}: the log ends with the aborted click then releaseAll, and no typeText`, log.slice(-2).join(',') === 'click:aborted,releaseAll:done' && !log.some(l => l.startsWith('typeText')), log.join(','))
  check(`${size.cols}: nothing left loopback`, nonLoopback(netlines(leg.netlog)).length === 0)
}

finish('prove-computer-interrupt-drive')
