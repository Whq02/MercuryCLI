#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { actLog, check, drive, endLeg, finish, joined, netlines, nonLoopback, OPENING, optionsRow, printFrame, requireCaptureDriver, rowsHaving, section, sessionFiles, SIZES, startLeg } from './computerDriveKit.ts'

const driver = requireCaptureDriver('computer-drives')
const CARD_NEEDLE = 'the first act this session'
const FOOTER = '● hands off — Mercury is driving TextEdit · esc stops it'

for (const size of SIZES) {
  section(`the ask drive at ${size.cols}×${size.rows}`)
  const leg = await startLeg(
    `ask-${size.cols}`,
    [
      { kind: 'tool_use', preText: 'Looking at the screen.\n', name: 'Computer', input: { action: 'screenshot' } },
      { kind: 'tool_use', preText: 'Clicking the document.\n', name: 'Computer', input: { action: 'click', x: 400, y: 200, capture: true } },
      { kind: 'tool_use', preText: 'Clicking again.\n', name: 'Computer', input: { action: 'click', x: 500, y: 240, capture: true } },
      { kind: 'text', text: 'Done.' },
    ],
    { holdMs: 1500 },
  )
  const res = await drive(driver, leg, size, [
    ...OPENING('click the document'),
    { requireAwait: true, awaitText: 'first act', awaitStableTicks: 2, mark: 'card', data: '\r' },
    { requireAwait: true, awaitText: 'hands off', awaitStableTicks: 2, awaitStableRegion: [0, size.rows - 3, size.cols, size.rows], mark: 'driving', data: '' },
    { requireAwait: true, awaitText: 'Done.', awaitStableTicks: 3, mark: 'done', data: '' },
  ], 240)
  await endLeg(leg)
  check(`${size.cols}: the drive delivered every send (a real boot, the card, the act, the turn end)`, res.status === 0, `drive failed, read the vshot status and stderr: ${res.status} · ${res.endReason} · ${res.stderr.slice(-400)}`)
  const card = res.marks.card ?? []
  printFrame(`${size.cols}×${size.rows} the card`, card)
  check(`${size.cols}: the card title names the Computer tool`, rowsHaving(card, 'Computer'), 'the card title must name Computer: see src/permissions/cards/computer/ComputerPermissionRequest.tsx')
  check(`${size.cols}: the body names the act in TextEdit as the first act this session`, joined(card).includes('in TextEdit') && joined(card).includes(CARD_NEEDLE) && joined(card).includes('click (400, 200)'), 'the card body must read as the message built by checkPermissions in src/tools/computer/ComputerTool.ts: ' + joined(card).slice(0, 400))
  check(`${size.cols}: the options row is ON the frame`, optionsRow(card), 'the options row must be drawn on the frame by src/permissions/cards/computer/ComputerPermissionRequest.tsx: ' + card.filter(r => /\d\./.test(r)).join(' · '))
  check(`${size.cols}: the five choices in order — Yes, No, 1 hour, 24 hours, sovereign mode`, ['1. Yes, for this session', '2. No, and tell Mercury', '3. Yes, for 1 hour', '4. Yes, for 24 hours', '5. Enable sovereign mode'].every(needle => card.some(r => r.includes(needle))), 'the five options come from src/permissions/cards/computer/ComputerPermissionRequest.tsx: ' + card.filter(r => /\d\. /.test(r)).join(' · '))
  check(`${size.cols}: the card asks how long`, joined(card.map(r => r.replace(/[│╭╮╰╯─]/g, ' '))).includes('and for how long?'), 'the card must ask how long in src/permissions/cards/computer/ComputerPermissionRequest.tsx: ' + joined(card).slice(0, 400))
  const driving = res.marks.driving ?? []
  printFrame(`${size.cols}×${size.rows} driving`, driving)
  check(`${size.cols}: the footer says hands off while the act runs`, rowsHaving(driving, FOOTER), 'the hands off footer comes from DRIVING_FOOTER_PREFIX in src/integrations/desktop/desktopSession.ts: ' + driving.filter(r => r.includes('hands off')).join(' · '))
  const done = res.marks.done ?? []
  printFrame(`${size.cols}×${size.rows} done`, done)
  check(`${size.cols}: the transcript carries a Computer click row`, /Computer\s+click \(\d+, \d+\)/.test(joined(done)), 'the click row is rendered by src/tools/computer/rows.tsx: ' + joined(done).slice(0, 600))
  check(`${size.cols}: the result card names the act`, joined(done).toLowerCase().includes('computer click'), 'the result card is rendered by src/tools/computer/rows.tsx: ' + joined(done).slice(0, 600))
  check(`${size.cols}: the turn ended (Done.) with no card on the second act`, rowsHaving(done, 'Done.') && !rowsHaving(done, CARD_NEEDLE), 'the second act must not ask again and the turn must end with Done.: see checkPermissions in src/tools/computer/ComputerTool.ts')
  check(`${size.cols}: the footer is gone after the turn`, !rowsHaving(done, 'hands off'), 'the footer must be cleared when the turn ends: see DRIVING_FOOTER_PREFIX in src/integrations/desktop/desktopSession.ts')
  const acts = actLog(leg.log)
  const log = acts.map(a => `${a.act}:${a.outcome}`)
  const inputsAndCaptures = acts.filter(a => a.act !== 'accessibilityTree').map(a => `${a.act}:${a.outcome}`)
  const clicks = acts.filter(a => a.act === 'click')
  check(`${size.cols}: the fake log carries each captcha tree preflight before its click and the same three captures`, inputsAndCaptures.join(',') === 'capture:done,click:done,capture:done,click:done,capture:done' && clicks.every(a => acts[acts.indexOf(a) - 1]?.act === 'accessibilityTree') && JSON.stringify(clicks.map(a => a.detail.at)) === JSON.stringify([{ x: 500, y: 300 }, { x: 600, y: 340 }]), 'each click must be preceded by an accessibilityTree read and each capture logged: see src/tools/computer/ComputerTool.ts and src/integrations/desktop/desktopSession.ts: ' + log.join(','))
  const files = sessionFiles(join(leg.home, 'projects'))
  const persisted = files.map(f => readFileSync(f, 'utf8')).join('\n')
  check(`${size.cols}: a session file was written`, files.length > 0, 'no session file under the leg projects folder: the drive did not persist its session')
  check(`${size.cols}: the session file keeps the stub, never the image bytes`, persisted.includes('not kept in the conversation file') && !persisted.includes('"type":"image"') && !/[A-Za-z0-9+/]{400}/.test(persisted), `the stub text lives in src/integrations/desktop/screenshotRetention.ts and must replace every image block in the session file: ${files.length} files`)
  const stray = nonLoopback(netlines(leg.netlog))
  check(`${size.cols}: nothing left loopback`, stray.length === 0, 'the drive must stay on loopback, find what dials out: ' + stray.join(' · '))
  check(`${size.cols}: the fixture served the scripted turns`, leg.fixture.messageRequests().length >= 4, `fewer than 4 scripted turns reached the fixture, the drive stopped early: ${leg.fixture.messageRequests().length} requests`)
  check(`${size.cols}: the screenshots landed under desktop-shots`, existsSync(join(leg.home, 'desktop-shots')), 'screenshots are saved under DESKTOP_SHOTS_DIR in src/integrations/desktop/desktopSession.ts')
}

finish('prove-computer-ask-drive')
