#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { ADMITTED, check, childEnv, DIST, endLeg, FACE_READY, finish, printFrame, productNode, requireCaptureDriver, ROOT, scratch, section, startLeg } from '../computer/computerDriveKit.ts'
import { captureEngineEntry, vshotBudgetMs } from '../lib/captureDriver.ts'
import { untilAsync } from '../lib/untilAsync.ts'
import { readSessionWorkers } from '../../src/daemon/concourse-workers/concourseWorkers.ts'
import { open } from '../../src/crew/board/store.ts'

type Cell = { c: string }
type Grid = Cell[][]
type Leg = Awaited<ReturnType<typeof startLeg>>

const driver = requireCaptureDriver('midturn-compact-row')
const COLS = 120
const ROWS = 50
const FOLD_NEEDLE = 'Write the running record of this conversation'
const SUMMARY = '<summary>The conversation was compacted after the seed history.</summary>'
const SEED_NOTES = Array.from({ length: 900 }, (_, n) => `note ${n}: the crew keeps a ledger of what each seat holds and what it waits for.`).join('\n') + '\n'
const COMPACT_ROW = '❯ /compact'
const COMPACTED = 'Compacted —'
const HINT = 'beginQueuedFold (src/screen/composer/input-core/command-queue.ts), autoFoldIfNeeded (src/engine/compaction/autoFold.ts), and foldContext (src/engine/loop/turn/makeRequest.ts) must emit the consumed /compact local_command echo carrying its client uuid so SendsPart.reconcileSends (src/engine/connector/daemon/sends.ts) retires the optimistic echo instead of leaving it below later rows'

const then = (data: string, awaitText: string, mark?: string): Record<string, unknown> => ({
  data,
  atTick: 999,
  awaitText,
  requireAwait: true,
  minTick: 2,
  awaitSettleTicks: 3,
  ...(mark ? { mark } : {}),
})
const textRows = (grid: Grid): string[] => grid.map(row => row.map(cell => cell.c || ' ').join('').replace(/\s+$/, ''))
const lineOf = (lines: string[], needle: string): number => lines.findIndex(line => line.includes(needle))
const linesMatching = (lines: string[], needle: string): number[] =>
  lines.reduce<number[]>((acc, line, index) => (line.includes(needle) ? [...acc, index] : acc), [])

function findFiles(dir: string, pred: (name: string) => boolean): string[] {
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
      if (entry !== 'lineage') out.push(...findFiles(path, pred))
    } else if (pred(entry)) {
      out.push(path)
    }
  }
  return out
}

function transcriptOf(leg: Leg): string | undefined {
  return findFiles(join(leg.home, 'projects'), name => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/.test(name))[0]
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

function daemonGone(leg: Leg): boolean {
  try {
    const pid = Number(readFileSync(join(leg.home, 'daemon', 'daemon.pid'), 'utf8').trim())
    if (!(pid > 1)) return true
    process.kill(pid, 0)
    return false
  } catch {
    return true
  }
}

async function capture(
  tag: string,
  leg: Leg,
  argv: string[],
  sends: unknown[],
  readyText: string,
  total: number,
  during?: (ended: () => boolean) => Promise<void>,
): Promise<{ status: number | null; marks: Map<string, string[]>; final: string[]; log: string }> {
  const out = join(scratch, `${tag}-grid.json`)
  const cfgPath = join(scratch, `${tag}-config.json`)
  writeFileSync(cfgPath, JSON.stringify({ argv: [productNode(), DIST, ...argv], cwd: leg.cwd, cols: COLS, rows: ROWS, sends, resizes: [], total, out, readyText: [readyText], readySettleTicks: 6 }))
  const child = spawn(driver.python, [captureEngineEntry(driver, ROOT), cfgPath], {
    cwd: leg.cwd,
    env: childEnv(leg, { TMPDIR: '.', MERCURY_DESKTOP_DRIVER: 'none', MERCURY_CRITTER: 'clam', MERCURY_TURN_RECEIPT: '1' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', chunk => {
    log += String(chunk)
  })
  child.stderr.on('data', chunk => {
    log += String(chunk)
  })
  let ended = false
  const status = new Promise<number | null>(resolve => {
    const wall = setTimeout(() => {
      log += '\ncapture deadline exceeded\n'
      child.kill('SIGKILL')
    }, vshotBudgetMs(total * 200 + 60_000))
    child.once('error', error => {
      log += `\n${String(error)}\n`
    })
    child.once('close', code => {
      clearTimeout(wall)
      ended = true
      resolve(code)
    })
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
writeFileSync(join(project, 'notes.txt'), SEED_NOTES)

section('§1 /compact sent while a tool turn is in flight settles in place, never below later rows')
{
  const leg = await startLeg('midturn-a', [
    { kind: 'tool_use', name: 'Read', input: { file_path: join(project, 'notes.txt') } },
    { kind: 'text', text: 'SEED-DONE.' },
    { kind: 'tool_use', name: 'Bash', input: { command: 'sleep 4', description: 'Hold turn open' } },
    { kind: 'text', text: SUMMARY, whenBody: FOLD_NEEDLE },
    { kind: 'text', text: 'MIDTURN-AFTER-FOLD.' },
    { kind: 'text', text: 'LATER-TURN-REPLY.' },
  ], null, project)
  writeFileSync(join(leg.home, 'settings.json'), JSON.stringify({ guardrails: { allow: ['Bash(sleep *)'] }, view: { reducedMotion: true }, activity: { tips: { enabled: false } } }))
  const cap = await capture('midturn-a', leg, ['--chat'], [
    { atTick: 40, awaitText: FACE_READY, minTick: 3, awaitSettleTicks: 2, requireAwait: true, data: '\r' },
    then('seed the notes', ADMITTED),
    then('\r', 'seed the notes'),
    then('run the slow check', 'SEED-DONE.'),
    then('\r', 'run the slow check'),
    then('/compact', 'esc interrupt'),
    then('\r', '/compact'),
    then('', 'MIDTURN-AFTER-FOLD.', 'after-midturn'),
    then('follow up after fold', 'MIDTURN-AFTER-FOLD.'),
    then('\r', 'follow up after fold'),
    then('', 'LATER-TURN-REPLY.', 'after-later'),
  ], 'LATER-TURN-REPLY.', 650)
  stopDaemon(leg)
  const afterMid = cap.marks.get('after-midturn') ?? []
  const afterLater = cap.marks.get('after-later') ?? cap.final
  printFrame('mid-turn /compact · after turn completes', afterMid)
  printFrame('mid-turn /compact · after later turn', afterLater)
  check('mid-turn capture ran cleanly (exit 0)', cap.status === 0, `exit=${cap.status} ${cap.log.slice(-400)}`)
  const midCompact = linesMatching(afterMid, COMPACT_ROW)
  const midCompactedAt = lineOf(afterMid, COMPACTED)
  const midReplyAt = lineOf(afterMid, 'MIDTURN-AFTER-FOLD.')
  const midReceiptAt = lineOf(afterMid, '1 shell command')
  const midRunAt = lineOf(afterMid, '❯ run the slow check')
  check(
    'after the mid-turn fold lands, ❯ /compact appears once, after the turn prompt and above Compacted —, the reply, and the closing line',
    midCompact.length === 1 && midRunAt >= 0 && midCompactedAt > midCompact[0]! && midCompact[0]! > midRunAt && midReplyAt > midCompactedAt && midReceiptAt > midReplyAt,
    `rows=${JSON.stringify({ midRunAt, midCompact, midCompactedAt, midReplyAt, midReceiptAt })} | ${HINT}`,
  )
  const laterCompact = linesMatching(afterLater, COMPACT_ROW)
  const laterCompactedAt = lineOf(afterLater, COMPACTED)
  const laterAskAt = lineOf(afterLater, '❯ follow up after fold')
  const laterReplyAt = lineOf(afterLater, 'LATER-TURN-REPLY.')
  check(
    'after a later turn arrives, ❯ /compact still appears once, above Compacted — and above the later turn',
    laterCompact.length === 1 && laterCompactedAt > laterCompact[0]! && laterAskAt > laterCompactedAt && laterReplyAt > laterAskAt,
    `rows=${JSON.stringify({ laterCompact, laterCompactedAt, laterAskAt, laterReplyAt })} | ${HINT}`,
  )

  const file = transcriptOf(leg)
  const sid = file === undefined ? '' : basename(file, '.jsonl')
  await untilAsync(() => daemonGone(leg), vshotBudgetMs(30_000), 100)
  const resumed = await capture('midturn-a-resumed', leg, ['--resume', sid], [then('', 'LATER-TURN-REPLY.', 'resumed')], 'LATER-TURN-REPLY.', 400)
  stopDaemon(leg)
  const again = resumed.marks.get('resumed') ?? resumed.final
  printFrame('mid-turn /compact · resumed', again)
  const resumedCompact = linesMatching(again, COMPACT_ROW)
  const resumedCompactedAt = lineOf(again, COMPACTED)
  const resumedReplyAt = lineOf(again, 'LATER-TURN-REPLY.')
  check(
    'on --resume, ❯ /compact stands once, above Compacted — and above the later turn',
    sid !== '' && resumed.status === 0 && resumedCompact.length === 1 && resumedCompactedAt > resumedCompact[0]! && resumedReplyAt > resumedCompactedAt,
    `exit=${resumed.status} rows=${JSON.stringify({ resumedCompact, resumedCompactedAt, resumedReplyAt })} | ${HINT}`,
  )
  await endLeg(leg)
}

section('§2 /compact sent mid-turn with swarm on and a board post arriving during the turn')
{
  const leg = await startLeg('midturn-b', [
    { kind: 'tool_use', name: 'Read', input: { file_path: join(project, 'notes.txt') } },
    { kind: 'text', text: 'SEED-DONE.' },
    { kind: 'tool_use', name: 'Bash', input: { command: 'sleep 5', description: 'Hold swarm turn' } },
    { kind: 'text', text: SUMMARY, whenBody: FOLD_NEEDLE },
    { kind: 'text', text: 'SWARM-AFTER-FOLD.' },
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
    return file === undefined ? undefined : findFiles(leg.home, name => name === 'board.sqlite').find(path => path.includes(basename(file, '.jsonl')))
  }
  let posted = false
  const cap = await capture('midturn-b', leg, ['--chat'], [
    { atTick: 40, awaitText: FACE_READY, minTick: 3, awaitSettleTicks: 2, requireAwait: true, data: '\r' },
    then('seed the notes', ADMITTED),
    then('\r', 'seed the notes'),
    then('/swarm on', 'SEED-DONE.'),
    then('\r', '/swarm on'),
    then('run the slow swarm check', 'Swarm on for new crewmates'),
    then('\r', 'run the slow swarm check'),
    then('/compact', 'esc interrupt'),
    then('\r', '/compact'),
    then('', 'SWARM-AFTER-FOLD.', 'after-swarm'),
  ], 'SWARM-AFTER-FOLD.', 650, async ended => {
    const ready = await untilAsync(() => (transcriptText().includes('Hold swarm turn') && transcriptText().includes('/compact') && boardOf() !== undefined) || ended(), vshotBudgetMs(60_000), 100)
    if (!ready || ended()) return
    const path = boardOf()
    if (path === undefined) return
    const sid = basename(dirname(dirname(dirname(path))))
    const board = open(path, sid)
    try {
      board.enroll({ author: { sessionId: sid, agentId: 'poster', executionId: 'run' }, name: 'poster' })
      posted = board.post({ author: { sessionId: sid, agentId: 'poster', executionId: 'run' }, name: 'poster' }, { clientOpId: 'midturn-ask-1', kind: 'ask', text: '@main BOARD-POST-DURING-FOLD?' }).ok
    } finally {
      board.close()
    }
  })
  stopDaemon(leg)
  const frame = cap.marks.get('after-swarm') ?? cap.final
  printFrame('mid-turn /compact with swarm board post', frame)
  check('swarm mid-turn capture ran cleanly and the board post landed', cap.status === 0 && posted, `exit=${cap.status} posted=${posted} ${cap.log.slice(-400)}`)
  const swarmCompact = linesMatching(frame, COMPACT_ROW)
  const swarmCompactedAt = lineOf(frame, COMPACTED)
  const swarmReplyAt = lineOf(frame, 'SWARM-AFTER-FOLD.')
  const swarmReceiptAt = lineOf(frame, '1 shell command')
  const swarmBoardAt = lineOf(frame, 'BOARD-POST-DURING-FOLD?')
  check(
    'with swarm on and a board post arriving mid-turn, ❯ /compact appears once, above Compacted —, the reply, and the closing line',
    swarmCompact.length === 1 && swarmBoardAt >= 0 && swarmCompactedAt > swarmCompact[0]! && swarmReplyAt > swarmCompactedAt && swarmReceiptAt > swarmReplyAt,
    `rows=${JSON.stringify({ swarmBoardAt, swarmCompact, swarmCompactedAt, swarmReplyAt, swarmReceiptAt })} | ${HINT}`,
  )
  await endLeg(leg)
}

section('§3 control: /compact sent when idle stays clean')
{
  const leg = await startLeg('idle-c', [
    { kind: 'tool_use', name: 'Read', input: { file_path: join(project, 'notes.txt') } },
    { kind: 'text', text: 'SEED-DONE.' },
    { kind: 'text', text: SUMMARY, whenBody: FOLD_NEEDLE },
    { kind: 'text', text: 'IDLE-LATER-REPLY.' },
  ], null, project)
  writeFileSync(join(leg.home, 'settings.json'), JSON.stringify({ view: { reducedMotion: true }, activity: { tips: { enabled: false } } }))
  const cap = await capture('idle-c', leg, ['--chat'], [
    { atTick: 40, awaitText: FACE_READY, minTick: 3, awaitSettleTicks: 2, requireAwait: true, data: '\r' },
    then('seed the notes', ADMITTED),
    then('\r', 'seed the notes'),
    then('/compact', 'SEED-DONE.'),
    then('\r', '/compact'),
    then('', COMPACTED, 'after-idle-fold'),
    then('follow up after idle fold', COMPACTED),
    then('\r', 'follow up after idle fold'),
    then('', 'IDLE-LATER-REPLY.', 'after-idle-later'),
  ], 'IDLE-LATER-REPLY.', 600)
  stopDaemon(leg)
  const frame = cap.marks.get('after-idle-later') ?? cap.final
  printFrame('idle /compact · control', frame)
  check('idle control capture ran cleanly (exit 0)', cap.status === 0, `exit=${cap.status} ${cap.log.slice(-400)}`)
  const idleCompact = linesMatching(frame, COMPACT_ROW)
  const idleCompactedAt = lineOf(frame, COMPACTED)
  const idleReplyAt = lineOf(frame, 'IDLE-LATER-REPLY.')
  check(
    'idle /compact appears once, above Compacted — and above the later turn',
    idleCompact.length === 1 && idleCompactedAt > idleCompact[0]! && idleReplyAt > idleCompactedAt,
    `rows=${JSON.stringify({ idleCompact, idleCompactedAt, idleReplyAt })} | ${HINT}`,
  )
  await endLeg(leg)
}

rmSync(scratch, { recursive: true, force: true })
finish('midturn-compact-row')
