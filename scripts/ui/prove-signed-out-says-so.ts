#!/usr/bin/env bun

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { firstOutputTs, firstPtyVisibility, grabScreens, requireDist, runArtifactArena, type ArenaRun } from '../streaming/artifactArena.ts'

requireDist()

const COLS = 120
const ROWS = 40
const FACE_READY = '↑↓ choose'
const COMPOSER_READY = 'Type a prompt'
const PROMPT = 'hello there'
const SIGNED_OUT_ANSWER = 'choose a model · /model'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail.slice(0, 700) : ''}`)
}
const section = (s: string): void => console.log(`\n── ${s} ──`)
const arg = (key: string): string | undefined => (process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : undefined)
const frameDir = arg('--frames')
if (frameDir) mkdirSync(frameDir, { recursive: true })

const squash = (s: string): string => s.replace(/\s+/g, '')
const painted = (run: ArenaRun, words: string, notBefore = 0): { ts: number; text: string } | undefined => firstPtyVisibility(run.ptyReads, squash(words), notBefore)
const steady = (row: string): string => row.replace(/flux-arena-cwd-[A-Za-z0-9]+/g, 'the-project').replace(/\b\d\d:\d\d:\d\d\b/g, 'hh:mm:ss').replace(/\s+$/, '')
const saveFrame = (name: string, rows: string[]): void => {
  if (frameDir) writeFileSync(join(frameDir, `${name}.txt`), rows.map(steady).join('\n') + '\n')
}
const SETTLE_MS = 700
function screenAfter(run: ArenaRun, paint: { ts: number } | undefined): string[] | null {
  if (paint === undefined) return null
  const [frame] = grabScreens(run, COLS, ROWS, [Math.max(0, paint.ts - firstOutputTs(run) + SETTLE_MS)])
  return frame ? frame.rows : null
}
const rowsWith = (rows: string[] | null, needle: string): string[] => (rows ?? []).filter(l => l.includes(needle))
const statusRow = (rows: string[] | null): string => (rows ?? []).find(l => /(?:⇧←|shift\+←) back$/.test(l)) ?? ''
const unfired = (run: ArenaRun): string => `${run.outcome.reason ?? 'complete'} · unfired ${JSON.stringify(run.outcome.report?.unfired ?? [])}`

async function drive(tag: string, signedIn: boolean, sendPrompt: boolean): Promise<void> {
  const sends = sendPrompt ? [`after:${COMPOSER_READY}:1500:${PROMPT}`, `after:${COMPOSER_READY}:2600:\\r`] : []
  const run = await runArtifactArena({
    turns: [],
    sends,
    seconds: sendPrompt ? 40 : 30,
    cols: COLS,
    rows: ROWS,
    keep: true,
    anchor: null,
    seedCwd: { 'README.md': '# a small folder\n' },
    extraEnv: {
      BROWSER: '/usr/bin/true',
      MERCURY_UPDATE_NOTICE: '0',
      ...(signedIn ? {} : { ANTHROPIC_API_KEY: '' }),
    },
  })
  try {
    const home = screenAfter(run, painted(run, FACE_READY))
    const chatPaint = painted(run, signedIn ? 'ready · Opus 5.5 ·' : 'not signed in · /logins ·')
    const chat = screenAfter(run, chatPaint)
    const resting = signedIn ? chat : screenAfter(run, painted(run, 'not signed in · /logins ·')) ?? chat
    if (home) saveFrame(`${tag}-home`, home)
    if (chat) saveFrame(`${tag}-chat`, chat)
    check(`${tag}: the boot face painted its ready line`, home !== null && home.some(l => l.includes('New Session')), unfired(run))
    check(`${tag}: the chat painted its composer`, chat !== null && chat.some(l => l.includes(COMPOSER_READY)), unfired(run))
    if (!signedIn) {
      check(`${tag}: the home menu's Logins row says not signed in`, rowsWith(home, 'Logins').some(l => l.includes('not signed in')), rowsWith(home, 'Logins').join(' | '))
      check(`${tag}: the chat's hero row says not signed in and names /logins`, rowsWith(chat, 'not signed in').some(l => l.includes('○ not signed in · /logins connects')), rowsWith(chat, 'signed in').join(' | '))
      check(`${tag}: …and never says ready`, chat !== null && !chat.some(l => l.includes('● ready')), rowsWith(chat, 'ready').join(' | '))
      check(`${tag}: the status row reads "not signed in · /logins" before the model`, /^\s*not signed in · \/logins · /.test(statusRow(resting)), statusRow(resting))
      if (sendPrompt) {
        const answer = painted(run, SIGNED_OUT_ANSWER, chatPaint?.ts ?? 0)
        const afterSend = screenAfter(run, answer)
        if (afterSend) saveFrame(`${tag}-after-send`, afterSend)
        check(`${tag}: a prompt sent while signed out answers with the model door (${SIGNED_OUT_ANSWER}) beside the status row's /logins, not a provider error`, afterSend !== null && afterSend.some(l => l.includes(PROMPT)) && rowsWith(afterSend, SIGNED_OUT_ANSWER).length === 1 && rowsWith(afterSend, '/logins').length > 0 && !/401|authentication_error|invalid x-api-key|ECONNREFUSED|API Error/.test(afterSend.join('\n')), afterSend === null ? `the answer never painted · ${unfired(run)}` : rowsWith(afterSend, PROMPT).concat(rowsWith(afterSend, 'logins')).join(' | '))
      }
    } else {
      check(`${tag}: the Logins row counts the sign-in and never says not signed in`, rowsWith(home, 'Logins').some(l => /\d+ of \d+ signed in/.test(l)) && !(home ?? []).some(l => l.includes('not signed in')), rowsWith(home, 'Logins').join(' | '))
      check(`${tag}: the chat's hero row reads ready`, chat !== null && chat.some(l => l.includes('● ready · type a prompt, or / for commands')), rowsWith(chat, 'ready').join(' | '))
      check(`${tag}: the status row reads ready before the model`, /^\s*ready · /.test(statusRow(chat)), statusRow(chat))
      check(`${tag}: nothing on the signed-in chat says not signed in`, chat !== null && !chat.some(l => l.includes('not signed in')), rowsWith(chat, 'signed in').join(' | '))
    }
  } finally {
    run.cleanup()
  }
}

section('§1 a home with no sign-in anywhere: the home menu, the chat and the status row all say so, and a prompt answers with the way in')
await drive('keyless', false, true)

section('§2 a signed-in home keeps its words: Logins counts the sign-in, the hero row and the status row read ready')
await drive('signed-in', true, false)

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ prove-signed-out-says-so — ${failures} check(s) failed`)
  process.exit(1)
}
console.log('✅ prove-signed-out-says-so — all checks pass')
process.exit(0)
