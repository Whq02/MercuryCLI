#!/usr/bin/env bun
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
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
const UNWRITABLE = 'the session transcript store is unwritable'

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

section('a window hosts a session; its record turns read-only while the second turn runs')
let configDir = ''
let record = ''
const watch = setInterval(() => {
  if (configDir === '' || record !== '') return
  const found = walk(join(configDir, 'projects')).find(path => /^[0-9a-f-]{36}\.jsonl$/.test(basename(path)))
  if (found === undefined || !readFileSync(found, 'utf8').includes(SECOND_PROMPT)) return
  chmodSync(found, 0o444)
  record = found
}, 100)
const run = await runArtifactArena({
  turns: [
    { kind: 'text', text: FIRST, whenBody: 'first words for the window' },
    { kind: 'paced', deltas: [`${SECOND_REPLY_HEAD} `, 'settled.'], gapMs: 300, startDelayMs: 8000, whenBody: SECOND_PROMPT },
    handoffTurn(),
  ],
  sends: ['after:Type a prompt:1200:first words for the window', 'after:Type a prompt:2200:\\r', `after:${FIRST}:4000:${SECOND_PROMPT}`, `after:${FIRST}:5000:\\r`],
  seconds: 55,
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
  const stored = record === '' ? '' : readFileSync(record, 'utf8')
  check('the scene: the record was made read-only once it held the second prompt, and the reply behind it is not in it', record !== '' && stored.includes(SECOND_PROMPT) && !stored.includes(SECOND_REPLY_HEAD), record === '' ? 'the record never held the second prompt' : `${stored.length} bytes`)
  const facts = walk(join(run.paths.home, 'daemon'))
    .filter(path => path.includes('facts') && path.endsWith('.json'))
    .map(path => {
      try {
        return (JSON.parse(readFileSync(path, 'utf8')) as { transcriptStoreFailing?: string }).transcriptStoreFailing ?? null
      } catch {
        return null
      }
    })
  check("the facts the daemon publishes for the session carry the store's sentence", facts.some(sentence => sentence !== null && sentence.includes(UNWRITABLE)), JSON.stringify(facts).slice(0, 300))
  const lastRead = run.ptyReads[run.ptyReads.length - 1]
  const [frame] = lastRead === undefined ? [] : grabScreens(run, COLS, ROWS, [Math.max(0, lastRead.ts - firstOutputTs(run))])
  const rows = frame ? frame.rows.map(steady) : []
  check("the window says it: the store's sentence stands on the screen", rows.some(row => row.includes(UNWRITABLE)), rows.filter(row => row.trim() !== '').slice(-6).join(' | '))
  if (frameDir && rows.length > 0) writeFileSync(join(frameDir, `hosted-window-store-fails-${COLS}x${ROWS}.txt`), rows.join('\n') + '\n')
  for (const row of rows.filter(row => row.trim() !== '').slice(-6)) console.log(`  │ ${row.slice(0, 122)}`)
} finally {
  if (record !== '' && existsSync(record)) chmodSync(record, 0o644)
  run.cleanup()
}

console.log(`\nprove-hosted-window-says-the-store-fails-drive: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
