#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { actLog, check, drive, endLeg, finish, joined, netlines, nonLoopback, OPENING, optionsRow, printFrame, requireCaptureDriver, rowsHaving, section, sessionFiles, SIZES, startLeg } from './computerDriveKit.ts'

const driver = requireCaptureDriver('computer-drives')
const CARD_NEEDLE = 'first act in this application'
const FOOTER = '● hands off — Mercury is driving TextEdit · esc stops it'

for (const size of SIZES) {
  section(`the ask drive at ${size.cols}×${size.rows}`)
  const leg = await startLeg(
    `ask-${size.cols}`,
    [
      { kind: 'tool_use', preText: 'Looking at the screen.\n', name: 'Computer', input: { action: 'screenshot' } },
      { kind: 'tool_use', preText: 'Clicking the document.\n', name: 'Computer', input: { action: 'click', x: 812, y: 300 } },
      { kind: 'tool_use', preText: 'Clicking again.\n', name: 'Computer', input: { action: 'click', x: 900, y: 340 } },
      { kind: 'text', text: 'Done.' },
    ],
    { holdMs: 1500 },
  )
  const res = await drive(driver, leg, size, [
    ...OPENING('click the document'),
    { requireAwait: true, awaitText: 'first act', awaitStableTicks: 2, mark: 'card', data: '\r' },
    { requireAwait: true, awaitText: 'hands off', awaitStableTicks: 1, mark: 'driving', data: '' },
    { requireAwait: true, awaitText: 'Done.', awaitStableTicks: 3, mark: 'done', data: '' },
  ], 240)
  await endLeg(leg)
  check(`${size.cols}: the drive delivered every send (a real boot, the card, the act, the turn end)`, res.status === 0, `vshot ${res.status} · ${res.endReason} · ${res.stderr.slice(-400)}`)
  const card = res.marks.card ?? []
  printFrame(`${size.cols}×${size.rows} the card`, card)
  check(`${size.cols}: the card title names the Computer tool`, rowsHaving(card, 'Computer'))
  check(`${size.cols}: the body names the act in TextEdit as the first act in this application`, joined(card).includes('in TextEdit') && joined(card).includes(CARD_NEEDLE) && joined(card).includes('click (812, 300)'), joined(card).slice(0, 400))
  check(`${size.cols}: the options row is ON the frame`, optionsRow(card), card.filter(r => /\d\./.test(r)).join(' · '))
  check(`${size.cols}: the five choices in order — Yes, No, 1 hour, 24 hours, sovereign mode`, ['1. Yes', '2. No, and tell Mercury', '3. Yes, for 1 hour', '4. Yes, for 24 hours', '5. Enable sovereign mode'].every(needle => card.some(r => r.includes(needle))), card.filter(r => /\d\. /.test(r)).join(' · '))
  check(`${size.cols}: the card asks how long`, joined(card).includes('and for how long?'), joined(card).slice(0, 400))
  const driving = res.marks.driving ?? []
  printFrame(`${size.cols}×${size.rows} driving`, driving)
  check(`${size.cols}: the footer says hands off while the act runs`, rowsHaving(driving, FOOTER), driving.filter(r => r.includes('hands off')).join(' · '))
  const done = res.marks.done ?? []
  printFrame(`${size.cols}×${size.rows} done`, done)
  check(`${size.cols}: the transcript carries a Computer click row`, /Computer\s+click \(\d+, \d+\)/.test(joined(done)), joined(done).slice(0, 600))
  check(`${size.cols}: the result card names the act`, joined(done).toLowerCase().includes('computer click'), joined(done).slice(0, 600))
  check(`${size.cols}: the turn ended (Done.) with no card on the second act`, rowsHaving(done, 'Done.') && !rowsHaving(done, CARD_NEEDLE))
  check(`${size.cols}: the footer is gone after the turn`, !rowsHaving(done, 'hands off'))
  const log = actLog(leg.log).map(a => `${a.act}:${a.outcome}`)
  check(`${size.cols}: the fake log carries capture, click, capture, click, capture`, log.join(',') === 'capture:done,click:done,capture:done,click:done,capture:done', log.join(','))
  const files = sessionFiles(join(leg.home, 'projects'))
  const persisted = files.map(f => readFileSync(f, 'utf8')).join('\n')
  check(`${size.cols}: a session file was written`, files.length > 0)
  check(`${size.cols}: the session file keeps the stub, never the image bytes`, persisted.includes('not kept in the conversation file') && !persisted.includes('"type":"image"') && !/[A-Za-z0-9+/]{400}/.test(persisted), `${files.length} files`)
  const stray = nonLoopback(netlines(leg.netlog))
  check(`${size.cols}: nothing left loopback`, stray.length === 0, stray.join(' · '))
  check(`${size.cols}: the fixture served the scripted turns`, leg.fixture.messageRequests().length >= 4, `${leg.fixture.messageRequests().length} requests`)
  check(`${size.cols}: the screenshots landed under desktop-shots`, existsSync(join(leg.home, 'desktop-shots')))
}

finish('prove-computer-ask-drive')
