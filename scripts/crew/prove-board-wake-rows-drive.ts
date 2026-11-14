#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { ADMITTED, check, childEnv, DIST, endLeg, FACE_READY, finish, printFrame, productNode, requireCaptureDriver, ROOT, scratch, section, startLeg } from '../computer/computerDriveKit.ts'
import { captureEngineEntry, vshotBudgetMs } from '../lib/captureDriver.ts'
import { handoffTurn } from '../lib/fixtureApi.ts'
import { readSessionWorkers } from '../../src/daemon/concourseWorkers.ts'
import { open } from '../../src/services/crewBoard/store.ts'

type Cell = { c: string }
type Grid = Cell[][]
type Leg = Awaited<ReturnType<typeof startLeg>>

const driver = requireCaptureDriver('board-wake-rows')
const COLS = 120
const ROWS = 76
const JOB = 'Hold a seat busy'
const POSTS = ['@main ONE-ASK which file first?', '@main TWO-ASK is the build green?', '@main THREE-ASK may I take the README?']
const REPLIES = ['WAKE-ONE-REPLY.', 'WAKE-TWO-REPLY.', 'WAKE-THREE-REPLY.']
const WAITING = 'Lead is waiting.'
const JOB_NOTED = 'JOB-NOTED.'
const AFTER = 'AFTER-FOLD-REPLY.'
const BOUNDARY = 'Conversation compacted'
const PLAIN_NOTICE = /● notice · \d+ lines? [›⌄]/
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const textRows = (grid: Grid): string[] => grid.map(row => row.map(cell => cell.c || ' ').join('').replace(/\s+$/, ''))
const lineOf = (lines: string[], needle: string): number => lines.findIndex(line => line.includes(needle))
const then = (data: string, awaitText: string, mark?: string): Record<string, unknown> => ({ data, atTick: 999, awaitText, requireAwait: true, minTick: 2, awaitSettleTicks: 3, ...(mark ? { mark } : {}) })

function findFiles(dir: string, name: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    let isDir = false
    try {
      isDir = statSync(path).isDirectory()
    } catch {
      continue
    }
    if (isDir) out.push(...findFiles(path, name))
    else if (entry === name) out.push(path)
  }
  return out
}

function transcriptOf(leg: Leg): string | undefined {
  return findFilesMatching(join(leg.home, 'projects'), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/)[0]
}

function findFilesMatching(dir: string, name: RegExp): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    let isDir = false
    try {
      isDir = statSync(path).isDirectory()
    } catch {
      continue
    }
    if (isDir) {
      if (entry !== 'lineage') out.push(...findFilesMatching(path, name))
    } else if (name.test(entry)) out.push(path)
  }
  return out
}

function stopDaemon(leg: Leg): void {
  const dir = join(leg.home, 'daemon')
  if (!existsSync(dir)) return
  for (const worker of Object.values(readSessionWorkers(dir))) {
    if (worker.pid && worker.endedAt === undefined) {
      try {
        process.kill(worker.pid, 'SIGTERM')
      } catch {
      }
    }
  }
  try {
    const pid = Number(readFileSync(join(dir, 'daemon.pid'), 'utf8').trim())
    if (pid > 1) process.kill(pid, 'SIGTERM')
  } catch {
  }
}

async function capture(tag: string, leg: Leg, argv: string[], sends: unknown[], readyText: string, total: number, during?: (ended: () => boolean) => Promise<void>): Promise<{ status: number | null; marks: Map<string, string[]>; final: string[]; log: string }> {
  const out = join(scratch, `${tag}-grid.json`)
  const cfgPath = join(scratch, `${tag}-config.json`)
  writeFileSync(cfgPath, JSON.stringify({ argv: [productNode(), DIST, ...argv], cwd: leg.cwd, cols: COLS, rows: ROWS, sends, resizes: [], total, out, readyText: [readyText], readySettleTicks: 6 }))
  const child = spawn(driver.python, [captureEngineEntry(driver, ROOT), cfgPath], { cwd: leg.cwd, env: childEnv(leg, { TMPDIR: '.', MERCURY_DESKTOP_DRIVER: 'none', MERCURY_CRITTER: 'clam', MERCURY_SETTLE_WINDOW_MS: '4000' }), stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', chunk => { log += String(chunk) })
  child.stderr.on('data', chunk => { log += String(chunk) })
  let ended = false
  const status = new Promise<number | null>(resolve => {
    const wall = setTimeout(() => { log += '\ncapture deadline exceeded\n'; child.kill('SIGKILL') }, vshotBudgetMs(total * 200 + 60_000))
    child.once('error', error => { log += `\n${String(error)}\n` })
    child.once('close', code => { clearTimeout(wall); ended = true; resolve(code) })
  })
  if (during !== undefined) await during(() => ended)
  const code = await status
  const marks = new Map<string, string[]>()
  let final: string[] = []
  if (existsSync(out)) {
    const payload = JSON.parse(readFileSync(out, 'utf8')) as { grid?: Grid; marks?: Array<{ label: string; grid: Grid }> }
    for (const mark of payload.marks ?? []) marks.set(mark.label, textRows(mark.grid))
    final = payload.grid ? textRows(payload.grid) : []
  }
  return { status: code, marks, final, log }
}

const project = realpathSync(scratch)
writeFileSync(join(project, 'notes.txt'), Array.from({ length: 900 }, (_, n) => `note ${n}: the crew keeps a ledger of what each seat holds and what it waits for.`).join('\n') + '\n')
const leg = await startLeg('board-wake-rows', [
  { kind: 'tool_use', name: 'Read', input: { file_path: join(project, 'notes.txt') } },
  { kind: 'tool_use', name: 'Bash', input: { command: 'sleep 60', description: JOB, run_in_background: true } },
  { kind: 'text', text: WAITING },
  { kind: 'text', text: REPLIES[0]! },
  { kind: 'text', text: REPLIES[1]! },
  { kind: 'text', text: REPLIES[2]! },
  { kind: 'text', text: JOB_NOTED },
  { kind: 'text', text: 'The lead waited for the crew, answered three asks and noted a finished job.' },
  { kind: 'text', text: AFTER },
  handoffTurn(),
], null, project)
writeFileSync(join(leg.home, 'settings.json'), JSON.stringify({ guardrails: { allow: ['Bash(sleep *)'] }, view: { reducedMotion: true }, activity: { tips: { enabled: false } } }))

const transcriptText = (): string => {
  const file = transcriptOf(leg)
  if (file === undefined) return ''
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}
const boardOf = (): string | undefined => {
  const file = transcriptOf(leg)
  return file === undefined ? undefined : findFiles(leg.home, 'board.sqlite').find(path => path.includes(basename(file, '.jsonl')))
}
const post = (clientOpId: string, text: string): boolean => {
  const path = boardOf()
  if (path === undefined) return false
  const sid = basename(dirname(dirname(dirname(path))))
  const board = open(path, sid)
  const sender = { author: { sessionId: sid, agentId: 'poster', executionId: 'run' }, name: 'poster' }
  try {
    board.enroll(sender)
    return board.post(sender, { clientOpId, kind: 'ask', text }).ok
  } finally {
    board.close()
  }
}
const until = async (test: () => boolean, ended: () => boolean, timeoutMs = 150_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (!test()) {
    if (ended() || Date.now() > deadline) return false
    await sleep(100)
  }
  return true
}

let posted = 0
const live = await capture('live', leg, ['--chat'], [
  { atTick: 40, awaitText: FACE_READY, minTick: 3, awaitSettleTicks: 2, requireAwait: true, data: '\r' },
  then('Wait for crew questions.', ADMITTED),
  then('\r', 'Wait for crew questions.'),
  then('/swarm on', WAITING),
  then('\r', '/swarm on'),
  then('', 'Swarm on for new crewmates'),
  then('', REPLIES[0]!),
  then('', REPLIES[1]!),
  then('', REPLIES[2]!, 'woken'),
  then('', JOB_NOTED, 'job'),
  then('/compact', JOB_NOTED),
  then('\r', '/compact'),
  then('', 'Compacted — folded', 'folded'),
  then('after the fold', 'Compacted — folded'),
  then('\r', 'after the fold'),
  then('', AFTER, 'after'),
], AFTER, 1100, async ended => {
  if (!(await until(() => transcriptText().includes(WAITING) && boardOf() !== undefined, ended))) return
  await sleep(2500)
  for (const [index, words] of POSTS.entries()) {
    if (index > 0 && !(await until(() => transcriptText().includes(REPLIES[index - 1]!), ended))) return
    if (index > 0) await sleep(1500)
    if (post(`ask-${index + 1}`, words)) posted++
  }
})
stopDaemon(leg)

section('§1 the scene: a hosted window, the swarm on, three posts addressed to the lead at three times, a finished job, then /compact')
check('the capture ran every send (engine exit 0) and the three posts were written to the board', live.status === 0 && posted === 3, `exit ${live.status} · ${posted} posted · ${live.log.slice(-500)}`)
const woken = live.marks.get('woken') ?? []
const job = live.marks.get('job') ?? []
const folded = live.marks.get('folded') ?? []
const after = live.marks.get('after') ?? []
printFrame('woken three times, before the fold', woken)
printFrame('the finished job, before the fold', job)
printFrame('after /compact', folded)
const inOrder = (lines: string[], needles: string[]): boolean => {
  let at = -1
  for (const needle of needles) {
    const next = lines.findIndex((line, index) => index > at && line.includes(needle))
    if (next < 0) return false
    at = next
  }
  return true
}
check('each post paints as the seat\'s own row and each wake is answered, in order', inOrder(woken, [POSTS[0]!, REPLIES[0]!, POSTS[1]!, REPLIES[1]!, POSTS[2]!, REPLIES[2]!]), woken.filter(line => line.includes('poster') || line.includes('REPLY')).join(' | '))
check('a background shell runs through all three wakes, as a crew would: the daemon asks the runner for its queue each second only while a crewmate, shell or monitor runs, and in a quiet session no wake ever reached the window', lineOf(job, `[Background] ${JOB}`) > lineOf(job, REPLIES[2]!), job.filter(line => line.includes('Background') || line.includes('REPLY')).join(' | '))
check('live, a wake paints no notice row: woken three times, the frame holds none (the parent paints one a wake)', lineOf(woken, REPLIES[2]!) >= 0 && !woken.some(line => PLAIN_NOTICE.test(line)), woken.filter(line => PLAIN_NOTICE.test(line)).map(line => line.trim()).join(' | '))
check('…nor does one stand once the job has finished', lineOf(job, JOB_NOTED) >= 0 && !job.some(line => PLAIN_NOTICE.test(line)), job.filter(line => PLAIN_NOTICE.test(line)).map(line => line.trim()).join(' | '))

section('§2 a notice that is not a wake keeps its row: the finished job')
const jobRow = job.find(line => line.includes(`[Background] ${JOB}`)) ?? ''
check('the finished job paints its own notice row, the clock, the dot, the plate and the fold mark', /\d{2}:\d{2}:\d{2} ● \[Background\] Hold a seat busy · done · \d+ lines? ›/.test(jobRow), jobRow || job.filter(line => line.includes('Background') || line.includes('notice')).join(' | '))
check('…and it is answered', lineOf(job, JOB_NOTED) > lineOf(job, `[Background] ${JOB}`), job.filter(line => line.includes('Background') || line.includes(JOB_NOTED)).join(' | '))

section('§3 after the fold: no notice row is left standing above the boundary')
const boundaryAt = lineOf(folded, BOUNDARY)
const above = boundaryAt < 0 ? [] : folded.slice(0, boundaryAt).filter(line => PLAIN_NOTICE.test(line))
check('the boundary row stands in the frame', boundaryAt >= 0, folded.slice(0, 12).join(' | '))
check('no notice row stands above the boundary (the base leaves three, one a wake)', boundaryAt >= 0 && above.length === 0, `${above.length} above the boundary: ${above.map(line => line.trim()).join(' | ')}`)
check('the frame after the fold holds no plain notice row at all', boundaryAt >= 0 && !folded.some(line => PLAIN_NOTICE.test(line)), folded.filter(line => PLAIN_NOTICE.test(line)).map(line => line.trim()).join(' | '))
check('the rows the fold kept stand below the boundary as they landed: the posts and the replies, in order', boundaryAt >= 0 && inOrder(folded.slice(boundaryAt), [POSTS[0]!, REPLIES[0]!, POSTS[1]!, REPLIES[1]!, POSTS[2]!, REPLIES[2]!]), folded.slice(Math.max(0, boundaryAt)).filter(line => line.includes('poster') || line.includes('REPLY')).join(' | '))
check('the next turn paints below them', lineOf(after, AFTER) > lineOf(after, REPLIES[2]!) && !after.some(line => PLAIN_NOTICE.test(line)), after.filter(line => line.includes('REPLY') || PLAIN_NOTICE.test(line)).join(' | '))

section('§4 the session resumed in a new window')
const file = transcriptOf(leg)
const sid = file === undefined ? '' : basename(file, '.jsonl')
await sleep(1500)
const resumed = await capture('resumed', leg, ['--resume', sid], [then('', AFTER, 'resumed')], AFTER, 400)
stopDaemon(leg)
const again = resumed.marks.get('resumed') ?? resumed.final
printFrame('resumed', again)
check('the resumed window painted the session (engine exit 0)', sid !== '' && resumed.status === 0 && lineOf(again, AFTER) >= 0, `exit ${resumed.status} · ${resumed.log.slice(-400)}`)
check('it holds no plain notice row', lineOf(again, AFTER) >= 0 && !again.some(line => PLAIN_NOTICE.test(line)), again.filter(line => PLAIN_NOTICE.test(line)).map(line => line.trim()).join(' | '))
check('…and the rows of the record stand as before: the boundary, the kept posts and replies, the turn after', inOrder(again, [BOUNDARY, POSTS[0]!, REPLIES[0]!, POSTS[2]!, REPLIES[2]!, AFTER]), again.filter(line => line.includes(BOUNDARY) || line.includes('poster') || line.includes('REPLY')).join(' | '))

await endLeg(leg)
rmSync(scratch, { recursive: true, force: true })
finish('board-wake-rows')
