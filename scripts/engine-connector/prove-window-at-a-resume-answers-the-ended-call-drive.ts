#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { handoffTurn, startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { DIST, firstOutputTs, grabScreens, nodeBinPath, requireDist, runArtifactArena } from '../streaming/artifactArena.ts'

const arg = (key: string): string | undefined => (process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : undefined)
const distPath = arg('--dist')
const frameDir = arg('--frames')
if (distPath === undefined) requireDist()
if (frameDir) mkdirSync(frameDir, { recursive: true })

const COLS = 120
const ROWS = 40
const MODEL = 'claude-opus-4-8'
const CALL = 'toolu_resume_build'
const CUT_PROMPT = 'RESUMESCENE run the build'
const WHOLE_PROMPT = 'RESUMESCENE say the word'
const WHOLE_REPLY = 'WHOLE-REPLY settled.'
const NEXT_PROMPT = 'and what came of it'
const NEXT_REPLY = 'NEXT-REPLY settled.'
const WAITING = 'waiting…'
const CLEAN = 'resumed clean'
const FAILED = 'resumed — 1 tool call failed'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 900)}` : ''}`)
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
const cardsIn = (rows: string[]): number => rows.filter(row => row.includes('resumed clean') || row.includes('resumed —')).length
const said = (rows: string[]): string[] => rows.filter(row => /[A-Za-z0-9]/.test(row)).map(row => row.replace(/\s{2,}/g, '  '))
const tailOf = (rows: string[]): string => said(rows).slice(-16).join(' | ')

async function earlierRun(configDir: string, cwd: string, sid: string, prompt: string, cut: boolean): Promise<string> {
  const reply: ScriptedTurn = cut ? { kind: 'tool_use', name: 'Bash', id: CALL, input: { command: 'sleep 15', description: 'Run the build' } } : { kind: 'text', text: WHOLE_REPLY }
  const fixture = await startFixtureApi([handoffTurn(), handoffTurn(), reply])
  const home = dirname(configDir)
  const nodeBin = nodeBinPath()
  const child = spawn(nodeBin, [distPath ?? DIST, 'run', prompt, '--model', MODEL, '--session-id', sid, '--format', 'rows', '--allowed-tools', 'Bash'], {
    cwd,
    env: { HOME: home, PATH: ['/usr/bin:/bin', dirname(nodeBin)].join(delimiter), TERM: 'dumb', MERCURY_CONFIG_DIR: configDir, MERCURY_TMPDIR: join(home, 'tmp'), MERCURY_DAEMON_DIR: join(home, 'earlier-daemon'), ANTHROPIC_BASE_URL: fixture.url, ANTHROPIC_API_KEY: 'fixture-key-000', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_VERIFY_EVIDENCE: '0', MERCURY_TRUST_DIALOG_ACCEPTED: '1' },
  })
  child.stdout.on('data', () => {})
  child.stderr.on('data', () => {})
  const gone = new Promise<void>(resolve => child.on('close', () => resolve()))
  const record = (): string => walk(join(configDir, 'projects')).find(path => path.endsWith(`${sid}.jsonl`)) ?? ''
  if (cut) {
    const until = Date.now() + 30_000
    while (Date.now() < until && !(record() !== '' && readFileSync(record(), 'utf8').includes(CALL))) await new Promise(tick => setTimeout(tick, 50))
    await new Promise(tick => setTimeout(tick, 800))
    child.kill('SIGKILL')
  }
  await gone
  await fixture.close()
  return record() === '' ? '' : readFileSync(record(), 'utf8')
}

async function resumeInAWindow(sid: string, prompt: string, cut: boolean): Promise<{ record: string; frames: string[][]; unfired: string[] }> {
  let record = ''
  const run = await runArtifactArena({
    turns: [handoffTurn(), handoffTurn(), { kind: 'text', text: NEXT_REPLY }],
    sends: [
      'after:Type a prompt:1500:/resume',
      'after:Type a prompt:3000:\\r',
      'after:Type a prompt:4500:\\r',
      'after:Type a prompt:6000:\\r',
      ...(cut ? [`after:Type a prompt:17000:${NEXT_PROMPT}`, 'after:Type a prompt:18000:\\r'] : []),
    ],
    seconds: cut ? 34 : 22,
    cols: COLS,
    rows: ROWS,
    keep: true,
    anchor: null,
    ...(distPath !== undefined ? { distPath } : {}),
    seedHome: async (configDir, cwd) => {
      record = await earlierRun(configDir, cwd, sid, prompt, cut)
    },
  })
  try {
    const lastRead = run.ptyReads[run.ptyReads.length - 1]
    const end = lastRead === undefined ? 0 : Math.max(0, lastRead.ts - firstOutputTs(run))
    const offsets: number[] = []
    for (let at = 500; at < end; at += 500) offsets.push(at)
    offsets.push(end)
    const frames = lastRead === undefined ? [] : grabScreens(run, COLS, ROWS, offsets).map(frame => frame.rows.map(steady))
    return { record, frames, unfired: run.outcome.report?.unfired ?? [] }
  } finally {
    run.cleanup()
  }
}

section('a session whose run was stopped inside a call; a window opens on it; then a prompt is typed')
{
  const { record, frames, unfired } = await resumeInAWindow('facef00d-0000-4000-8000-00000c2d0001', CUT_PROMPT, true)
  check('the scene: the earlier run left the call in the record and no result for it, and every key was sent', record.includes(CALL) && !record.includes('"kind":"tool-result"') && unfired.length === 0, `${record.length} bytes, unfired ${JSON.stringify(unfired)}`)
  const opened = frames.filter(rows => rows.some(row => row.includes(CUT_PROMPT)) && cardsIn(rows) > 0)
  const atRest = opened.filter(rows => !rows.some(row => row.includes(NEXT_PROMPT)))
  const settled = atRest[atRest.length - 1] ?? []
  check('the window is on the session and at rest before the prompt is typed', atRest.length > 0, tailOf(frames[frames.length - 1] ?? []))
  check('the call no longer waits', settled.length > 0 && !settled.some(row => row.includes(WAITING)), tailOf(settled))
  check('the card says a call failed, and it is the one card on the screen', settled.some(row => row.includes(FAILED)) && cardsIn(settled) === 1 && !settled.some(row => row.includes(CLEAN)), tailOf(settled))
  check('no frame holds two cards', opened.every(rows => cardsIn(rows) === 1), tailOf(opened.find(rows => cardsIn(rows) !== 1) ?? []))
  if (frameDir && settled.length > 0) writeFileSync(join(frameDir, `window-at-a-resume-${COLS}x${ROWS}.txt`), settled.join('\n') + '\n')
  for (const row of said(settled).slice(-14)) console.log(`  │ ${row.slice(0, 122)}`)
  const last = frames[frames.length - 1] ?? []
  const cardAt = last.findIndex(row => row.includes('resumed —') || row.includes(CLEAN))
  const promptAt = last.findIndex(row => row.includes(`❯ ${NEXT_PROMPT}`))
  check('the typed prompt is answered, and the card stands above it as it stood: one card, still saying a call failed', last.some(row => row.includes(NEXT_REPLY)) && cardsIn(last) === 1 && cardAt !== -1 && promptAt > cardAt && last[cardAt]!.includes(FAILED), tailOf(last))
  if (frameDir && last.length > 0) writeFileSync(join(frameDir, `window-at-a-resume-after-a-prompt-${COLS}x${ROWS}.txt`), last.join('\n') + '\n')
  for (const row of said(last).slice(-16)) console.log(`  │ ${row.slice(0, 122)}`)
}

section('control: a session whose run ended whole; a window opens on it')
{
  const { record, frames, unfired } = await resumeInAWindow('facef00d-0000-4000-8000-00000c2d0002', WHOLE_PROMPT, false)
  check('the scene: the earlier run ended with its reply in the record, and every key was sent', record.includes(WHOLE_REPLY) && unfired.length === 0, `${record.length} bytes, unfired ${JSON.stringify(unfired)}`)
  const opened = frames.filter(rows => rows.some(row => row.includes(WHOLE_PROMPT)) && cardsIn(rows) > 0)
  const last = opened[opened.length - 1] ?? []
  check('the card says resumed clean, in every frame from the first that holds it, and it is the one card', opened.length > 0 && opened.every(rows => cardsIn(rows) === 1 && rows.some(row => row.includes(CLEAN))), tailOf(opened.find(rows => cardsIn(rows) !== 1 || !rows.some(row => row.includes(CLEAN))) ?? frames[frames.length - 1] ?? []))
  check('the reply of the earlier run is on the screen and nothing waits', last.some(row => row.includes(WHOLE_REPLY)) && !last.some(row => row.includes(WAITING)), tailOf(last))
  for (const row of said(last).slice(-12)) console.log(`  │ ${row.slice(0, 122)}`)
}

console.log(`\nprove-window-at-a-resume-answers-the-ended-call-drive: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
