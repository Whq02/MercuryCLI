#!/usr/bin/env bun
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type ArenaRun, grabScreens, requireDist, runArtifactArena, sendStamp } from '../streaming/artifactArena.ts'

requireDist()

const KEEP = process.argv.includes('--keep')
const arg = (key: string): string | undefined => (process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : undefined)
const FRAMES = arg('--frames')
if (FRAMES) mkdirSync(FRAMES, { recursive: true })

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const rowsHaving = (rows: string[], needle: string): boolean => rows.some(r => r.includes(needle))
const rowMatching = (rows: string[], re: RegExp): string | undefined => rows.find(r => re.test(r))
function save(name: string, rows: string[]): void {
  if (FRAMES) writeFileSync(join(FRAMES, `${name}.txt`), rows.map(r => r.replace(/\s+$/, '')).join('\n') + '\n')
}
function printFrame(label: string, rows: string[]): void {
  console.log(`\n┌── ${label} ──`)
  for (const r of rows) console.log(`│${r.replace(/\s+$/, '')}`)
  console.log('└──')
}
const ESC = '\\x1b'
const escSends = (run: ArenaRun): number[] =>
  run.sendLog.filter(s => Buffer.from(s.b64, 'base64').toString('latin1') === '\x1b').map(s => sendStamp(run, s))

section('provision — the card for the one-time browser download names the build, its size and where it lands, and asks for a download')
{
  const QUESTION = 'Download this browser build?'
  const CARD_UP = 'tell Mercury what to do differently'
  const run = await runArtifactArena({
    cols: 120,
    rows: 36,
    turns: [
      { kind: 'tool_use', preText: 'No browser is available yet; asking to set one up.\n', name: 'Browser', input: { op: 'provision' } },
      { kind: 'text', text: 'Understood, nothing was downloaded.' },
    ],
    sends: ['after:Type a prompt:300:hello', 'after:hello:400:\\r', `after:${CARD_UP}:1500:${ESC}`],
    anchor: { needle: CARD_UP, atMs: 9000 },
    seconds: 26,
    keep: true,
  })
  const escs = escSends(run)
  check('a Browser card painted and the decline was delivered', escs.length === 1, `esc at ${escs.join(', ')} · driver: ${run.driverOut.slice(-400)}`)
  if (escs.length === 1) {
    const [card] = grabScreens(run, 120, 36, [escs[0]! - 700])
    const rows = card!.rows
    save('provision-card-120x36', rows)
    printFrame('provision card 120x36', rows)
    check('the card is the download card, not the page-driving card', rowsHaving(rows, 'Browser download') && !rowsHaving(rows, 'drive this page'))
    check('the card names the build', /Chrome for Testing \d+\.\d+\.\d+\.\d+ \(current stable\)/.test(rows.join('\n')), rowMatching(rows, /Chrome for Testing/) ?? '(no build row)')
    check('the card names the download size', /a \d+ MB download/.test(rows.join('\n')), rowMatching(rows, /download/) ?? '(no size row)')
    check('the card says where the build lands', rowsHaving(rows, 'unpacks to roughly twice that on disk, under') && rowsHaving(rows, join(run.paths.home, '.mercury', 'browsers').slice(0, 30)), rowMatching(rows, /under /) ?? '(no cache row)')
    check('the card says how to remove it', /\/browser remove \d+\.\d+/.test(rows.join('\n')), rowMatching(rows, /remove/) ?? '(no remove row)')
    check('the card asks for a download and the yes says so', rowsHaving(rows, QUESTION) && rowsHaving(rows, '1. Yes, download it'))
    check('the card does not carry the tool description written for page driving', !rowsHaving(rows, 'Drive a real Chromium-family browser'))
    check('the card says nothing moves before the yes', rowsHaving(rows, 'Nothing is downloaded until you say yes'))
    const [final] = grabScreens(run, 120, 36, [-1])
    save('provision-declined-final-120x36', final!.rows)
    check('the decline landed: the model heard the refusal and the turn settled', rowsHaving(final!.rows, 'Understood, nothing was downloaded.'), final!.rows.slice(-12).join(' | '))
    check('nothing was downloaded into the arena home', !existsSync(join(run.paths.home, '.mercury', 'browsers', 'chrome')))
  } else {
    const [final] = grabScreens(run, 120, 36, [-1])
    printFrame('final screen (no card needle)', final!.rows)
  }
  if (!KEEP) run.cleanup()
}

section('first visit — the origin card says what a yes covers: the origin for the session, linked pages read without asking, a new address asked')
{
  const ORIGIN = 'http://127.0.0.1:65530'
  const CARD_UP = 'tell Mercury what to do differently'
  const run = await runArtifactArena({
    cols: 120,
    rows: 36,
    turns: [
      { kind: 'tool_use', preText: 'Opening the page.\n', name: 'Browser', input: { op: 'open', url: `${ORIGIN}/index.html` } },
      { kind: 'text', text: 'Understood, the page was not opened.' },
    ],
    sends: ['after:Type a prompt:300:hello', 'after:hello:400:\\r', `after:${CARD_UP}:1500:${ESC}`],
    anchor: { needle: CARD_UP, atMs: 9000 },
    seconds: 26,
    keep: true,
  })
  const escs = escSends(run)
  check('the first-visit card painted and the decline was delivered', escs.length === 1, `esc at ${escs.join(', ')} · driver: ${run.driverOut.slice(-400)}`)
  if (escs.length === 1) {
    const [card] = grabScreens(run, 120, 36, [escs[0]! - 700])
    const rows = card!.rows
    save('first-visit-card-120x36', rows)
    printFrame('first-visit card 120x36', rows)
    const text = rows.join('\n')
    check('the card is the Browser card with the open line', rowsHaving(rows, '⦿ Browser') && rowsHaving(rows, `open ${ORIGIN}/index.html`))
    check('the card says the yes approves the origin for the session', text.includes(`Yes approves ${ORIGIN} for this session`), rowMatching(rows, /approves/) ?? '(no scope row)')
    check('the card says linked pages are read without asking and the first act on one asks', rowsHaving(rows, 'Pages it links or redirects to are read') && rowsHaving(rows, 'without asking; the first act'), rowMatching(rows, /links or redirects/) ?? '(no linked-pages row)')
    check('the card says a new origin opened by address is asked by name', text.includes('A new origin opened by address is asked by name'), rowMatching(rows, /new origin/) ?? '(no new-origin row)')
    check('the card no longer carries the page-driving description', !rowsHaving(rows, 'Drive a real Chromium-family browser'))
    check('the three answers stand: yes, yes for this project, no', rowsHaving(rows, '1. Yes') && rowsHaving(rows, `2. Yes, and don't ask again for ${ORIGIN} in this project`) && rowsHaving(rows, '3. No, and tell Mercury what to do differently (esc)'))
    const [final] = grabScreens(run, 120, 36, [-1])
    save('first-visit-declined-final-120x36', final!.rows)
    check('the decline landed and the turn settled', rowsHaving(final!.rows, 'Understood, the page was not opened.'), final!.rows.slice(-12).join(' | '))
  } else {
    const [final] = grabScreens(run, 120, 36, [-1])
    printFrame('final screen (no card)', final!.rows)
  }
  if (!KEEP) run.cleanup()
}

console.log(`\n${checks} checks, ${failures} failures`)
console.log(failures === 0 ? 'prove-browser-cards-drive: ALL LAWS HOLD' : `prove-browser-cards-drive: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
