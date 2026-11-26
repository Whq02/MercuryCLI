#!/usr/bin/env bun
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { startFixtureApi } from '../lib/fixtureApi.ts'
import { encodeSeedTranscript } from '../lib/seedTranscript.ts'
import { key, stagedPageDrive } from '../lib/stagedPageDrive.ts'
import { getProjectDir } from '../../src/sessions/transcripts/paths.js'

const framesDir = process.argv[2]
const fixture = await startFixtureApi([])
const RESUME = 'src/screen/boot-face/BootResumeScreen.tsx'
const DOOR = 'bootMenuAsks in assets/splash/splash-core.mjs says whether the layout draws the line a page hands it as asking'
const DOWN = '\u001b[B'
const ESC = '\u001b'
const DAY_MS = 24 * 60 * 60 * 1000
const WIDE = { cols: 120, rows: 40 }
let failures = 0
const check = (label: string, ok: boolean, fix: string): void => {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ': ' + fix}`)
}
const screenOf = (frame: string): string => frame.split('\n').map(line => line.trim()).filter(Boolean).join(' | ')

const chats = [
  { id: '00000000-0000-4000-8000-0000000000a1', says: 'alpha chat', daysOld: 60 },
  { id: '00000000-0000-4000-8000-0000000000b1', says: 'beta chat', daysOld: 90 },
]
const transcriptsOf = (staged: { home: string; cwd: string }): string[] => chats.map(chat => join(staged.home, 'projects', basename(getProjectDir(staged.cwd)), `${chat.id}.jsonl`))
function oldChats(staged: { home: string; cwd: string }): void {
  const files = transcriptsOf(staged)
  mkdirSync(join(files[0]!, '..'), { recursive: true })
  chats.forEach((chat, index) => {
    const at = new Date(Date.now() - chat.daysOld * DAY_MS)
    writeFileSync(files[index]!, encodeSeedTranscript([
      { type: 'user', uuid: `${chat.id.slice(0, -1)}2`, parentUuid: null, sessionId: chat.id, cwd: staged.cwd, timestamp: at.toISOString(), message: { role: 'user', content: chat.says } },
      { type: 'assistant', uuid: `${chat.id.slice(0, -1)}3`, parentUuid: `${chat.id.slice(0, -1)}2`, sessionId: chat.id, cwd: staged.cwd, timestamp: at.toISOString(), message: { id: `answer-${index}`, type: 'message', role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'saved reply' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 2 } } },
    ], chat.id, at.toISOString()))
    utimesSync(files[index]!, at, at)
  })
  writeFileSync(join(staged.home, 'splash-action.json'), JSON.stringify({ version: 1, ts: Date.now(), action: 'resume' }))
}
const theSessionsPage = { stage: oldChats, env: { MERCURY_SPLASH_HANDOFF: '1' } }
const toTheCard = [key('d prune', 'd', 'list-wide'), key('would delete: 2 transcripts', '', 'card-wide')]

const drive = stagedPageDrive({ name: 'small-window-asks', page: RESUME, framesDir, fixtureUrl: fixture.url, check })
if (drive === null) {
  console.log('The small window asks drive requires the POSIX capture driver.')
  await fixture.close()
  process.exit(0)
}

try {
  const asked = await drive(120, 40, {
    name: 'pruned',
    ...theSessionsPage,
    sends: [...toTheCard, key('delete 2 transcripts? ▸ No · ↑↓ ↵ esc', DOWN, 'card-small'), key('delete 2 transcripts? ▸ Yes · ↑↓ ↵ esc', '\r', 'yes-small')],
    resizes: [{ afterMark: 'card-wide', cols: 40, rows: 10 }],
    readyText: 'deleted 2 transcripts · ↵ esc',
    after: staged => transcriptsOf(staged).every(file => !existsSync(file)),
  })
  check('sessions, 40 by 10: the prune card is asked on the legend\'s line with its answer, ↓ turns it to Yes, and ↵ then deletes the two transcripts and says so', asked.after && asked.frame('card-small').includes('alpha chat') && asked.frame('pruned').includes('deleted 2 transcripts'), `the page must hand the layout its open card as one line (asking in ${RESUME}); ${DOOR}; both transcripts deleted: ${String(asked.after)}; the last screen reads: ${screenOf(asked.frame('pruned'))}`)

  const unasked = await drive(120, 40, {
    name: 'kept',
    ...theSessionsPage,
    sends: [...toTheCard, key('(>_) ', DOWN + '\r' + ESC, 'card-slim'), key('↑↓ · ↵ cycles · esc back', DOWN, 'closed'), key('❯ beta chat', '', 'entered')],
    resizes: [{ afterMark: 'card-wide', cols: 30, rows: 10 }, { afterMark: 'entered', ...WIDE }],
    readyText: 'd prune',
    after: staged => transcriptsOf(staged).every(file => existsSync(file)),
  })
  check('sessions, 30 columns: the card\'s line cannot be drawn, so ↓ and ↵ delete nothing; esc closes the card and both transcripts stand', unasked.after && !unasked.frame('card-slim').includes('↑↓ ↵ esc') && unasked.frame('kept').includes('alpha chat') && unasked.frame('kept').includes('beta chat'), `where the line is not drawn the card's keys must not act, esc and n excepted (the prune keys of ${RESUME}); ${DOOR}; both transcripts stand: ${String(unasked.after)}; wide again the screen reads: ${screenOf(unasked.frame('kept')).slice(0, 400)}`)
  for (const rows of [10, 12]) {
    const short = await drive(120, 40, {
      name: 'short',
      ...theSessionsPage,
      sends: [...toTheCard, key('MERCURY · resume session', DOWN, 'card-short'), key('MERCURY · resume session', '\r', 'yes-short')],
      resizes: [{ afterMark: 'card-wide', cols: 80, rows }],
      readyText: 'deleted 2 transcripts',
      after: staged => transcriptsOf(staged).every(file => !existsSync(file)),
    })
    check(`sessions, 80 by ${rows}: the window is too short for the card, so its question stands on the legend's line, whole, when ↵ deletes the two transcripts`, short.after && short.frame('card-short').includes('delete 2 transcripts? ▸ No · ↑↓ ↵ esc') && short.frame('yes-short').includes('delete 2 transcripts? ▸ Yes · ↑↓ ↵ esc'), `a layout whose own room cuts the card must draw the page's asking line in place of the legend (composeBootMenuClassic and composeBootMenuWide in assets/splash/splash-core.mjs); both transcripts deleted: ${String(short.after)}; when ↵ was pressed the screen read: ${screenOf(short.frame('yes-short'))}`)
  }
  check('the pages made no model call', fixture.messageRequests().length === 0, 'a key of a boot page reached the model API; these pages must stay on their own doors')
} finally {
  await fixture.close()
}
process.exit(failures === 0 ? 0 : 1)
