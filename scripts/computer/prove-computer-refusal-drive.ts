#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, drive, endLeg, finish, joined, netlines, nonLoopback, OPENING, printFrame, requireCaptureDriver, rowsHaving, section, sessionFiles, SIZES, startLeg } from './computerDriveKit.ts'

const persistedText = (home: string): string => sessionFiles(join(home, 'projects')).map(f => readFileSync(f, 'utf8')).join('\n')

const driver = requireCaptureDriver('computer-drives')
const CARD_NEEDLE = 'first act in this application'
const TURNS = [
  { kind: 'tool_use' as const, preText: 'Looking at the screen.\n', name: 'Computer', input: { action: 'screenshot' } },
  { kind: 'text' as const, text: 'Done.' },
]

for (const size of SIZES) {
  section(`the flag unset at ${size.cols}×${size.rows}: the harness refuses the unknown tool`)
  const off = await startLeg(`off-${size.cols}`, TURNS, null)
  const res = drive(driver, off, size, [...OPENING('take a screenshot'), { requireAwait: true, awaitText: 'Done.', awaitStableTicks: 3, mark: 'done', data: '' }], 160, { MERCURY_COMPUTER_USE: undefined })
  await endLeg(off)
  const done = res.marks.done ?? []
  printFrame(`${size.cols}×${size.rows} flag unset`, done)
  check(`${size.cols}: the drive delivered`, res.status === 0, `vshot ${res.status} · ${res.endReason} · ${res.stderr.slice(-300)}`)
  const offWords = joined(done).includes('No such tool available') ? 'frame' : persistedText(off.home).includes('No such tool available') ? 'session file' : 'nowhere'
  check(`${size.cols}: the refusal names the tool as not available (read on the ${offWords})`, offWords !== 'nowhere' && (joined(done).includes('Computer') || persistedText(off.home).includes('Computer')), joined(done).slice(0, 500))
  check(`${size.cols}: no card, no footer`, !rowsHaving(done, CARD_NEEDLE) && !rowsHaving(done, 'hands off'))
  check(`${size.cols}: the fake log was never created`, !existsSync(off.log))
  check(`${size.cols}: nothing left loopback`, nonLoopback(netlines(off.netlog)).length === 0)

  section(`the driver switched off at ${size.cols}×${size.rows}: the tool refuses naming the switch`)
  const none = await startLeg(`none-${size.cols}`, TURNS, null)
  const resNone = drive(driver, none, size, [...OPENING('take a screenshot'), { requireAwait: true, awaitText: 'Done.', awaitStableTicks: 3, mark: 'done', data: '' }], 160, { MERCURY_DESKTOP_DRIVER: 'none' })
  await endLeg(none)
  const doneNone = resNone.marks.done ?? []
  printFrame(`${size.cols}×${size.rows} driver none`, doneNone)
  check(`${size.cols}: the drive delivered`, resNone.status === 0, `vshot ${resNone.status} · ${resNone.endReason} · ${resNone.stderr.slice(-300)}`)
  const noneWords = joined(doneNone).includes('switched off for this run') ? 'frame' : persistedText(none.home).includes('switched off for this run') ? 'session file' : 'nowhere'
  check(`${size.cols}: the refusal names the switch (read on the ${noneWords})`, noneWords !== 'nowhere' && (joined(doneNone).includes('MERCURY_DESKTOP_DRIVER=none') || persistedText(none.home).includes('MERCURY_DESKTOP_DRIVER=none')), joined(doneNone).slice(0, 500))
  check(`${size.cols}: no card, no footer`, !rowsHaving(doneNone, CARD_NEEDLE) && !rowsHaving(doneNone, 'hands off'))
  check(`${size.cols}: the fake log was never created`, !existsSync(none.log))
  check(`${size.cols}: nothing left loopback`, nonLoopback(netlines(none.netlog)).length === 0)
}

console.log('\n  – the text-only route leg (a local model whose catalogue declares no vision) waits on the catalogue seam; the route refusal text is pinned by the wire-shape proof')
finish('prove-computer-refusal-drive')
