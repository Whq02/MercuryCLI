#!/usr/bin/env bun

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { firstPtyVisibility, grabScreens, requireDist, runArtifactArena, sendStamp, type ArenaRun } from '../streaming/artifactArena.ts'

requireDist()

const CAPTURE_DIR = process.env.MERCURY_CARD_HOLD_CAPTURE_DIR ?? null
if (CAPTURE_DIR) mkdirSync(CAPTURE_DIR, { recursive: true })

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 500)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const NEEDLE = 'Do you want to proceed'
const MARKER = 'made-by-card.txt'
const WORDS = 'when you are done tell me how many files the folder held'
const HINT = '↵ is off while words wait — 1 approves · 3 declines · ⌫ edits'
const OLD_HINT = 'waits in the composer until the turn ends'
const CLOSING = 'The marker is in place.'
const DECLINED = 'Understood, nothing was touched.'

const flat = (rows: string[]): string => rows.map(r => r.replace(/\s+$/, '')).join('\n')
const rowsWith = (rows: string[], needle: string): string => rows.filter(r => r.includes(needle)).map(r => r.trim()).join(' | ') || `(no row carries "${needle}")`
function dump(label: string, rows: string[]): void {
  if (!CAPTURE_DIR) return
  writeFileSync(join(CAPTURE_DIR, `${label}.txt`), flat(rows) + '\n')
}
function printFrame(label: string, rows: string[]): void {
  console.log(`\n┌── ${label} ──`)
  for (const r of rows) console.log(`│${r.replace(/\s+$/, '')}`)
  console.log('└──')
}
const sendOf = (run: ArenaRun, text: string) => run.sendLog.find(s => Buffer.from(s.b64, 'base64').toString('latin1') === text)
const sendsOf = (run: ArenaRun, text: string) => run.sendLog.filter(s => Buffer.from(s.b64, 'base64').toString('latin1') === text)

async function scene(answer: '1' | '3', closing: string): Promise<ArenaRun> {
  return runArtifactArena({
    cols: 120,
    rows: 50,
    turns: () => [
      { kind: 'tool_use', preText: 'Touching the file.\n', name: 'Bash', input: { command: `touch ${MARKER} && echo touched`, description: 'Create an empty marker file' } },
      { kind: 'text', text: closing },
    ],
    sends: [
      'after:Type a prompt:300:hello',
      'after:hello:400:\\r',
      `after:${NEEDLE}:1500:${WORDS}`,
      `after:${NEEDLE}:5500:\\r`,
      `after:${NEEDLE}:9500:${answer}`,
    ],
    anchor: { needle: NEEDLE, atMs: 8000 },
    seconds: 26,
    keep: true,
  })
}

section('§1 words typed under a Bash card, the hand rests, ↵ — the card holds its ground and nothing runs; 1 then approves')
const approve = await scene('1', CLOSING)
try {
  const typed = sendOf(approve, WORDS)
  const enters = sendsOf(approve, '\r')
  const heldEnter = enters.find(s => s.after === NEEDLE)
  const approved = sendOf(approve, '1')
  check('§1 the card painted its question and the three witnessed sends were delivered (type · ↵ · 1)', typed !== undefined && heldEnter !== undefined && approved !== undefined, approve.driverOut.slice(-400))
  if (typed !== undefined && heldEnter !== undefined && approved !== undefined) {
    const t = sendStamp(approve, typed)
    const e = sendStamp(approve, heldEnter)
    const a = sendStamp(approve, approved)
    const [rested, afterEnter, settled] = grabScreens(approve, 120, 50, [e - 400, e + 1800, a + 2500])

    dump('approve-card-back-before-enter', rested!.rows)
    const restedText = flat(rested!.rows)
    check('§1 before the ↵ the card is back on the frame with the words beneath it', restedText.includes(NEEDLE) && restedText.includes(WORDS), rowsWith(rested!.rows, '❯'))
    check('§1 the queued-words hint reads exactly the ruled words', restedText.includes(HINT), rowsWith(rested!.rows, 'words wait') + ' · ' + rowsWith(rested!.rows, OLD_HINT))
    check('§1 the old hint is gone', !restedText.includes(OLD_HINT))
    check(`§1 the ↵ was sent after the words rested (${e - t} ms after typing, past the 1500 ms window)`, e - t > 1500 + 500, `${e - t} ms`)

    dump('approve-after-enter', afterEnter!.rows)
    const afterText = flat(afterEnter!.rows)
    check('§1 after the ↵ the card is STILL up (the question row stands)', afterText.includes(NEEDLE), rowsWith(afterEnter!.rows, 'Bash'))
    check('§1 after the ↵ the Yes row is still on the frame', /1\. Yes/.test(afterText), rowsWith(afterEnter!.rows, 'Yes'))
    check('§1 after the ↵ the words still wait beneath the card', afterText.includes(WORDS), rowsWith(afterEnter!.rows, '❯'))
    check('§1 after the ↵ nothing ran (no "Ran" row, no closing text)', !/Ran 1 bash command/.test(afterText) && !afterText.includes(CLOSING), rowsWith(afterEnter!.rows, 'bash command'))
    const ranAt = firstPtyVisibility(approve.ptyReads, 'Ran1bashcommand', 0)
    check('§1 the "Ran" row first reaches the terminal only after the 1 was sent (never on the ↵)', ranAt !== undefined && ranAt.ts > approved.sent, ranAt ? `ran at +${ranAt.ts - heldEnter.sent} ms after the ↵, the 1 went at +${approved.sent - heldEnter.sent} ms` : '(no Ran row at all)')
    const midTurn = approve.fixture.requests.filter(r => r.path.includes('/messages') && JSON.stringify(r.body).includes(WORDS)).length
    check('§1 the ↵ did not send the words to the model either', midTurn === 0, `${midTurn} request(s) carried them`)

    dump('approve-after-1', settled!.rows)
    const settledText = flat(settled!.rows)
    check('§1 the digit 1 approves: the turn settles with the closing text', settledText.includes(CLOSING), rowsWith(settled!.rows, 'marker'))
    check('§1 the words sit in the composer, unsent, when the turn ends', settledText.includes(WORDS) && !settledText.includes(NEEDLE), rowsWith(settled!.rows, '❯'))
    printFrame('§1 after the held ↵', afterEnter!.rows)
  } else {
    const [final] = grabScreens(approve, 120, 50, [-1])
    printFrame('§1 final screen', final!.rows)
  }
  check('§1 the approved command ran in the end (the marker exists)', existsSync(join(approve.paths.cwd, MARKER)))
} finally {
  approve.cleanup()
}

section('§2 the same card, the same held ↵; 3 then declines — the card goes, the command never runs')
const decline = await scene('3', DECLINED)
try {
  const enters = sendsOf(decline, '\r')
  const heldEnter = enters.find(s => s.after === NEEDLE)
  const declined = sendOf(decline, '3')
  check('§2 the card painted its question and the held ↵ and the 3 were delivered', heldEnter !== undefined && declined !== undefined, decline.driverOut.slice(-400))
  if (heldEnter !== undefined && declined !== undefined) {
    const e = sendStamp(decline, heldEnter)
    const d = sendStamp(decline, declined)
    const [afterEnter, settled] = grabScreens(decline, 120, 50, [e + 1800, d + 2500])
    dump('decline-after-enter', afterEnter!.rows)
    const afterText = flat(afterEnter!.rows)
    check('§2 after the ↵ the card is still up and the marker is not on disk', afterText.includes(NEEDLE) && !existsSync(join(decline.paths.cwd, MARKER)), rowsWith(afterEnter!.rows, 'Bash'))
    dump('decline-after-3', settled!.rows)
    const settledText = flat(settled!.rows)
    check('§2 the digit 3 declines: the card is gone', !settledText.includes(NEEDLE), rowsWith(settled!.rows, 'proceed'))
    check('§2 the words still wait in the composer after the decline', settledText.includes(WORDS), rowsWith(settled!.rows, '❯'))
    printFrame('§2 after the 3', settled!.rows)
  }
  check('§2 the declined command never ran (no marker)', !existsSync(join(decline.paths.cwd, MARKER)))
} finally {
  decline.cleanup()
}

console.log(`\n${checks} checks, ${failures} failures`)
console.log(failures === 0 ? 'prove-consent-card-holds-under-words: ALL LAWS HOLD' : `prove-consent-card-holds-under-words: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
