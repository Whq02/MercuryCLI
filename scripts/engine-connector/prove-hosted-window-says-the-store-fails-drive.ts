#!/usr/bin/env bun
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { handoffTurn } from '../lib/fixtureApi.ts'
import { firstOutputTs, grabScreens, requireDist, runArtifactArena } from '../streaming/artifactArena.ts'

const arg = (key: string): string | undefined => (process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : undefined)
const distPath = arg('--dist')
const frameDir = arg('--frames')
if (distPath === undefined) requireDist()
if (frameDir) mkdirSync(frameDir, { recursive: true })

const COLS = 120
const ROWS = 40
const FIRST = 'FIRST-REPLY settled.'
const SECOND_PROMPT = 'second words for the window'
const SECOND_REPLY_HEAD = 'SECOND-REPLY'
const THIRD_PROMPT = 'third words for the window'
const THIRD_REPLY_HEAD = 'THIRD-REPLY'
const UNWRITABLE = 'the session transcript store is unwritable'
const READ_ONLY_FOR_MS = 3000

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const walk = (dir: string): string[] => {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    try {
      if (statSync(path).isDirectory()) out.push(...walk(path))
      else out.push(path)
    } catch {
      continue
    }
  }
  return out
}
const steady = (row: string): string => row.replace(/flux-arena-[A-Za-z0-9-]+/g, 'the-arena').replace(/\b\d\d:\d\d:\d\d\b/g, 'hh:mm:ss').replace(/\s+$/, '')
const factsOf = (home: string): Array<string | null> =>
  walk(join(home, 'daemon'))
    .filter(path => path.includes('facts') && path.endsWith('.json'))
    .map(path => {
      try {
        return (JSON.parse(readFileSync(path, 'utf8')) as { transcriptStoreFailing?: string }).transcriptStoreFailing ?? null
      } catch {
        return null
      }
    })

section('a window hosts a session; its record turns read-only while the second turn runs, and writable again once the daemon has said so')
let configDir = ''
let record = ''
let said = ''
let saidAt = 0
let refused = ''
let writableAt = 0
const watch = setInterval(() => {
  if (configDir === '' || writableAt !== 0) return
  if (record === '') {
    const found = walk(join(configDir, 'projects')).find(path => /^[0-9a-f-]{36}\.jsonl$/.test(basename(path)))
    if (found === undefined || !readFileSync(found, 'utf8').includes(SECOND_PROMPT)) return
    chmodSync(found, 0o444)
    record = found
    return
  }
  if (saidAt === 0) {
    const sentence = factsOf(dirname(configDir)).find(fact => fact !== null && fact.includes(UNWRITABLE))
    if (typeof sentence !== 'string') return
    said = sentence
    saidAt = Date.now()
    return
  }
  if (Date.now() - saidAt < READ_ONLY_FOR_MS) return
  refused = readFileSync(record, 'utf8')
  chmodSync(record, 0o644)
  writableAt = Date.now()
}, 100)
const run = await runArtifactArena({
  turns: [
    { kind: 'text', text: FIRST, whenBody: 'first words for the window' },
    { kind: 'paced', deltas: [`${SECOND_REPLY_HEAD} `, 'settled.'], gapMs: 300, startDelayMs: 8000, whenBody: SECOND_PROMPT },
    { kind: 'paced', deltas: [`${THIRD_REPLY_HEAD} `, 'settled.'], gapMs: 300, startDelayMs: 5000, whenBody: THIRD_PROMPT },
    handoffTurn(),
    handoffTurn(),
  ],
  sends: [
    'after:Type a prompt:1200:first words for the window',
    'after:Type a prompt:2200:\\r',
    `after:${FIRST}:4000:${SECOND_PROMPT}`,
    `after:${FIRST}:5000:\\r`,
    `after:${FIRST}:21000:${THIRD_PROMPT}`,
    `after:${FIRST}:22000:\\r`,
  ],
  seconds: 65,
  cols: COLS,
  rows: ROWS,
  keep: true,
  anchor: null,
  ...(distPath !== undefined ? { distPath } : {}),
  seedHome: dir => {
    configDir = dir
  },
})
clearInterval(watch)
try {
  check('the scene: the record was made read-only once it held the second prompt, and while it stayed so the reply behind it was not in it', record !== '' && refused.includes(SECOND_PROMPT) && !refused.includes(SECOND_REPLY_HEAD), record === '' ? 'the record never held the second prompt' : `${refused.length} bytes`)
  check("the facts the daemon publishes for the session carry the store's sentence", said.includes(UNWRITABLE), JSON.stringify(said).slice(0, 300))
  const lastRead = run.ptyReads[run.ptyReads.length - 1]
  const began = firstOutputTs(run)
  const end = lastRead === undefined ? 0 : Math.max(0, lastRead.ts - began)
  const offsets: number[] = []
  for (let at = Math.max(0, saidAt - began); saidAt !== 0 && at < end; at += 500) offsets.push(at)
  offsets.push(end)
  const frames = lastRead === undefined ? [] : grabScreens(run, COLS, ROWS, offsets).map(frame => frame.rows.map(steady))
  const saying = frames.filter(rows => rows.some(row => row.includes(UNWRITABLE)))
  const stood = saying[saying.length - 1] ?? []
  check("the window says it: the store's sentence stands on the screen", saying.length > 0, (frames[frames.length - 1] ?? []).filter(row => row.trim() !== '').slice(-6).join(' | '))
  if (frameDir && stood.length > 0) writeFileSync(join(frameDir, `hosted-window-store-fails-${COLS}x${ROWS}.txt`), stood.join('\n') + '\n')
  for (const row of stood.filter(row => row.trim() !== '').slice(-6)) console.log(`  │ ${row.slice(0, 122)}`)

  section('the record is writable again, and a third turn runs')
  const stored = record === '' ? '' : readFileSync(record, 'utf8')
  check('the store writes again: the reply it refused stands in the record, and the turn after it', writableAt !== 0 && stored.includes(SECOND_REPLY_HEAD) && stored.includes(THIRD_PROMPT) && stored.includes(THIRD_REPLY_HEAD), `writable=${writableAt !== 0} second=${stored.includes(SECOND_REPLY_HEAD)} third=${stored.includes(THIRD_PROMPT)}/${stored.includes(THIRD_REPLY_HEAD)}`)
  const facts = factsOf(run.paths.home)
  check("the facts no longer carry the store's sentence", facts.length > 0 && facts.every(fact => fact === null), JSON.stringify(facts).slice(0, 300))
  const rows = frames[frames.length - 1] ?? []
  check("the window stops saying it: the last frame holds the third turn's reply and no such sentence", rows.some(row => row.includes(THIRD_REPLY_HEAD)) && !rows.some(row => row.includes(UNWRITABLE)), rows.filter(row => row.trim() !== '').slice(-6).join(' | '))
  if (frameDir && rows.length > 0) writeFileSync(join(frameDir, `hosted-window-store-writes-again-${COLS}x${ROWS}.txt`), rows.join('\n') + '\n')
  for (const row of rows.filter(row => row.trim() !== '').slice(-6)) console.log(`  │ ${row.slice(0, 122)}`)
} finally {
  if (record !== '' && existsSync(record)) chmodSync(record, 0o644)
  run.cleanup()
}

console.log(`\nprove-hosted-window-says-the-store-fails-drive: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
