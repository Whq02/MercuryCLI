#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const distAt = process.argv.indexOf('--dist')
const DIST = distAt >= 0 && process.argv[distAt + 1] !== undefined ? process.argv[distAt + 1]! : join(REPO, 'dist', 'mercury.mjs')
const SCENE = process.env.DRAIN_SCREEN_SCENE
const REAP = 'daemon:owner-orphaned'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const j = (value: unknown): string => JSON.stringify(value)
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const untilAsync = async (pred: () => Promise<boolean> | boolean, ms: number): Promise<boolean> => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      if (await pred()) return true
    } catch {}
    await sleep(100)
  }
  return false
}
const alive = (pid: number | undefined): boolean => {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

if (SCENE === undefined) {
  const scratch = mkdtempSync(join(tmpdir(), 'drain-screen-law-'))
  const dir = join(scratch, 'daemon')
  mkdirSync(join(scratch, 'home'), { recursive: true })
  mkdirSync(dir, { recursive: true })
  process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
  process.env.MERCURY_DAEMON_DIR = dir
  delete process.env.MERCURY_HOME
  const sup = await import('../../src/daemon/concourseWorkers.ts')
  const turnCut = await import('../../src/utils/messages/turnCut.ts')
  const now = Date.now()
  const sid = (tail: string): string => `00000000-dddd-4000-8000-${tail.padStart(12, '0')}`
  const midTurn = (n: string, extra: Record<string, unknown>): Record<string, unknown> => ({ schema: 1, runnerId: `concourse-w${n}`, sessionId: sid(n), workspaceId: scratch, isolation: 'exclusive', modelKey: 'claude-sonnet-5', spawnedAt: now - 60_000, lastLiveAt: now - 60_000, pid: process.pid, lastDeliveryAt: now - 1_000, lastTurnSettledAt: now - 5_000, ...extra })
  const rec = (n: string): { parkRequestedAt?: number; parkRequestedBy?: string; parkRequestedReason?: string; parkedAt?: number; parkReason?: string } | undefined => sup.readSessionWorkers(dir)[`concourse-w${n}`]

  console.log('P the record law: calling the reap off withdraws the parks that reap asked for, and no other')
  {
    const withdraw = (sup as { withdrawParkRequestsBy?: (by: string, runnerIds: readonly string[], dir?: string) => string[] }).withdrawParkRequestsBy
    check('the withdrawal exists', typeof withdraw === 'function')
    if (typeof withdraw === 'function') {
      sup.updateConcourseWorkers(workers => {
        workers['concourse-w1'] = midTurn('1', { parkRequestedAt: now, parkRequestedBy: REAP }) as never
        workers['concourse-w2'] = midTurn('2', { parkRequestedAt: now, parkRequestedBy: 'operator:2147000000' }) as never
        workers['concourse-w3'] = midTurn('3', { parkRequestedAt: now, parkRequestedBy: REAP, parkRequestedReason: 'another reap asked this one' }) as never
        workers['concourse-w4'] = midTurn('4', { parkedAt: now, parkedBy: REAP }) as never
      }, dir)
      const withdrawn = withdraw(REAP, ['concourse-w1', 'concourse-w2', 'concourse-w4', 'concourse-w9'], dir)
      check('of the runners it is given it withdraws the one whose standing park the reap asked for, and says which', withdrawn.join(',') === 'concourse-w1' && rec('1')?.parkRequestedAt === undefined && rec('1')?.parkRequestedBy === undefined, j({ withdrawn, rec: rec('1') }))
      check("a park a window asked for at its own quit stands (it is that window's wish, withdrawn by a focus as before)", rec('2')?.parkRequestedAt !== undefined && rec('2')?.parkRequestedBy === 'operator:2147000000', j(rec('2')))
      check('a runner it was not given keeps its request, whoever asked', rec('3')?.parkRequestedAt !== undefined && rec('3')?.parkRequestedReason === 'another reap asked this one', j(rec('3')))
      check('a session that already parked stays parked', rec('4')?.parkedAt !== undefined, j(rec('4')))
      check('the drain set is what still stands', sup.pendingParkRequests(dir).sort().join(',') === 'concourse-w2,concourse-w3', j(sup.pendingParkRequests(dir)))
      const before = readFileSync(join(dir, 'concourse-delta.json'), 'utf8')
      const again = withdraw(REAP, ['concourse-w1', 'concourse-w2', 'concourse-w4'], dir)
      check('with nothing of the reap left to withdraw it answers none and writes nothing', again.length === 0 && readFileSync(join(dir, 'concourse-delta.json'), 'utf8') === before, j({ again }))
    }
  }

  console.log("S the drain's look counts a stamp only when it was written since the reap began; the look at the moment the owner goes counts any")
  {
    const sDir = join(scratch, 'daemon-stamps')
    mkdirSync(sDir, { recursive: true })
    const stampedAt = now - 60_000
    sup.updateConcourseWorkers(workers => {
      workers['concourse-w1'] = midTurn('1', { focusedAt: stampedAt, focusedBy: `operator:${process.pid}` }) as never
    }, sDir)
    const look = sup.nextLiveCockpitOwner as (exceptPid: number | null, dir?: string, since?: number) => number | undefined
    check('a stamp that names a live pid is a cockpit to the look that reads any stamp, and to a look that began before the stamp was written or in its very millisecond', look(null, sDir) === process.pid && look(null, sDir, stampedAt - 1) === process.pid && look(null, sDir, stampedAt) === process.pid, j([look(null, sDir), look(null, sDir, stampedAt - 1), look(null, sDir, stampedAt)]))
    check('to a look that began after it was written the same stamp is nobody: a pid that lives says nothing about who wrote a stamp older than the reap', look(null, sDir, stampedAt + 1) === undefined && look(null, sDir, now) === undefined, j([look(null, sDir, stampedAt + 1), look(null, sDir, now)]))
  }

  console.log('Q a runner reads from its own record alone that the daemon parked it as a turn cut at the drain ceiling')
  {
    const cutAt = (sup as { cutAtDrainCeiling?: (sessionId: string, pid: number, dir?: string) => boolean }).cutAtDrainCeiling
    check('the reading exists', typeof cutAt === 'function')
    if (typeof cutAt === 'function') {
      sup.updateConcourseWorkers(workers => {
        workers['concourse-w5'] = midTurn('5', { parkRequestedAt: now, parkRequestedBy: REAP }) as never
        workers['concourse-w6'] = midTurn('6', { parkRequestedAt: now, parkRequestedBy: REAP }) as never
        workers['concourse-w7'] = midTurn('7', { parkedAt: now, parkedBy: 'daemon:stop', parkReason: 'parked — the daemon was stopped' }) as never
      }, dir)
      const before = cutAt(sid('5'), process.pid, dir)
      const killed: string[] = []
      const cut = sup.parkConcourseSession(sid('5'), REAP, { kill: short => (killed.push(short), true) }, dir, { afterTurn: false, reason: sup.PARK_DRAIN_CUT_REASON })
      check("the daemon's cut lands the park, with its reason, in the very step that asks for the kill: when that call returns the record on disk reads as a cut at the ceiling (and did not before)", before === false && cut.outcome === 'applied' && killed.join(',') === 'concourse-w5' && rec('5')?.parkedAt !== undefined && rec('5')?.parkReason === sup.PARK_DRAIN_CUT_REASON && cutAt(sid('5'), process.pid, dir) === true, j({ before, cut, killed, rec: rec('5') }))
      const group = readFileSync(join(REPO, 'src', 'utils', 'processGroup.ts'), 'utf8')
      const posixAt = group.indexOf('async function endPosixTree(')
      const posix = posixAt === -1 ? '' : group.slice(posixAt, group.indexOf('\n}\n', posixAt))
      const tableAt = posix.indexOf('await listPosixProcessTable()')
      const signalAt = posix.indexOf('process.kill(-pid, signal)')
      check("…and the kill's signal leaves in a later step than that call (the roster ends a runner's tree through the one owner, which reads the process table before it signals), so the runner hears of the cut after its record says it", readFileSync(join(REPO, 'src', 'daemon', 'roster.ts'), 'utf8').includes('killProcessGroup(child, signal)') && group.includes('void endProcessTree(childProcess, signal)') && tableAt !== -1 && signalAt !== -1 && tableAt < signalAt, j({ posixAt, tableAt, signalAt }))
      check('the reading is of that runner alone: the same session under another pid reads no, and so does another session under the same pid, and a session nobody holds', cutAt(sid('5'), process.pid + 1, dir) === false && cutAt(sid('6'), process.pid, dir) === false && cutAt(sid('9'), process.pid, dir) === false)
      check('a park that is only asked for (a signal for any other cause while the drain still waits) reads no, and so does a park for another reason', rec('6')?.parkRequestedAt !== undefined && rec('6')?.parkedAt === undefined && rec('7')?.parkedAt !== undefined && cutAt(sid('7'), process.pid, dir) === false, j({ six: rec('6'), seven: rec('7') }))
    }
  }

  console.log("R the sentence is a cut's, never the operator's interrupt, and the readers of a session's prompt pass over a cut row as they pass over an interrupt")
  {
    const words = (turnCut as { DRAIN_CUT_WORDS?: string }).DRAIN_CUT_WORDS
    check("the sentence is the owner's (16 Nov 2026)", words === 'the window closed and no window came back', String(words))
    const cut = turnCut.turnCutOf(words ?? 'no sentence')
    check('as an abort reason it is a cut with its words, and its row is not the interrupt row', words !== undefined && cut.kind === 'cut' && cut.detail === words && turnCut.turnCutLine(cut, false) === `[Request cut off: ${words}]` && turnCut.turnCutLine(cut, true) === `[Request cut off during tool use: ${words}]` && turnCut.turnCutLine(cut, false) !== turnCut.INTERRUPT_MESSAGE, j(cut))
    check('the stored row reads back as that cut, with the words a window paints after "Cut off"', turnCut.turnCutOfText(`[Request cut off: ${words}]`)?.kind === 'cut' && turnCut.turnCutWhy(turnCut.turnCutOfText(`[Request cut off: ${words}]`) ?? { kind: 'operator' }) === words)
    const chain = await import('../../src/utils/sessionStorage/chain.ts')
    const sessionIndex = await import('../../src/utils/sessionStorage/sessionIndex.ts')
    const portable = await import('../../src/utils/sessionStoragePortable.ts')
    const rows = ['[Request cut off: any words a cut carries]', '[Request cut off during tool use: any words a cut carries]', '[Request cut off by a no-progress timeout (the provider went quiet)]', '[Request interrupted by user]', 'the prompt the session was given']
    const message = (text: string): unknown => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })
    const record = (text: string): string => JSON.stringify({ schemaVersion: 1, payload: { kind: 'input', content: [{ kind: 'text', text }], meta: {} } })
    const fromChain = chain.getFirstMeaningfulUserMessageTextContent(rows.map(message) as never)
    check("the transcript writer's reader (it keeps a session's last prompt) passes over the cut rows", fromChain === 'the prompt the session was given', String(fromChain))
    const fromWindow = sessionIndex.sessionPromptFromWindow(rows.map(record).join('\n'))
    check("the session index's reader passes over them", fromWindow === 'the prompt the session was given', fromWindow)
    const fromHead = portable.extractFirstPromptFromHead(rows.map(record).join('\n'))
    check("the portable head reader (the concourse row's label) passes over them", fromHead === 'the prompt the session was given', fromHead)
  }

  console.log("T the rewind picker and the prompts list pass over a cut's row as they pass over the interrupt's: it is never offered as words of the user's")
  {
    const messages = await import('../../src/utils/messages.ts')
    const selector = await import('../../src/components/MessageSelector.tsx')
    const panel = await import('../../src/components/prompts-panel/rows.ts')
    const { DeadlineExceededError } = await import('../../src/utils/deadline.ts')
    type Row = { message: { content: string | Array<{ type: string; text?: string }> } }
    const wordsOf = (row: Row): string => (typeof row.message.content === 'string' ? row.message.content : row.message.content.map(block => block.text ?? '').join(''))
    const GIVEN = 'the prompt the session was given'
    const words = (turnCut as { DRAIN_CUT_WORDS?: string }).DRAIN_CUT_WORDS
    const rows: Array<[string, Row]> = [
      ["the interrupt's row", messages.createUserInterruptionMessage({}) as Row],
      ["the interrupt's row during tool use", messages.createUserInterruptionMessage({ toolUse: true }) as Row],
      ["the daemon's cut", messages.createUserInterruptionMessage({ reason: words ?? 'the cut has no sentence here' }) as Row],
      ["the daemon's cut during tool use", messages.createUserInterruptionMessage({ toolUse: true, reason: words ?? 'the cut has no sentence here' }) as Row],
      ["a no-progress timeout's cut", messages.createUserInterruptionMessage({ reason: new DeadlineExceededError('a fixture', 3_000, 9_000, 2) }) as Row],
    ]
    for (const [name, row] of rows) {
      const prompt = messages.createUserMessage({ content: GIVEN })
      const session = [prompt, messages.createAssistantMessage({ content: 'a reply' }), row] as never[]
      const offered = session.filter(selector.selectableUserMessagesFilter as never).map(m => wordsOf(m as Row))
      const listed = panel.promptRows(session).map(r => (r as { text?: string }).text ?? '')
      const afterReply = selector.messagesAfterAreOnlySynthetic(session, 1)
      const afterPrompt = selector.messagesAfterAreOnlySynthetic([prompt, row] as never[], 0)
      check(`${name} (${wordsOf(row).slice(0, 44)}…): the rewind picker offers the one prompt, the prompts list reads the one row, and nothing after the reply, or after a prompt cut before any reply, counts as the user's`, offered.join(' | ') === GIVEN && listed.join(' | ') === GIVEN && afterReply && afterPrompt, j({ offered, listed, afterReply, afterPrompt }))
    }
  }
  rmSync(scratch, { recursive: true, force: true })
  if (!existsSync(DIST)) {
    console.error(`${DIST} missing — run \`bun run build.ts\` first`)
    process.exit(1)
  }
  const scenes = ['screen-returns', 'nobody-comes']
  const runs = await Promise.all(
    scenes.map(
      scene =>
        new Promise<{ scene: string; code: number | null; out: string }>(resolve => {
          const child = spawn(process.execPath, [import.meta.path, ...process.argv.slice(2)], { env: { ...process.env, DRAIN_SCREEN_SCENE: scene }, stdio: ['ignore', 'pipe', 'pipe'] })
          let out = ''
          child.stdout.on('data', chunk => (out += String(chunk)))
          child.stderr.on('data', chunk => (out += String(chunk)))
          const guard = setTimeout(() => child.kill('SIGKILL'), 300_000)
          child.on('close', code => {
            clearTimeout(guard)
            resolve({ scene, code, out })
          })
        }),
    ),
  )
  let red = failures > 0 ? 1 : 0
  for (const run of runs) {
    process.stdout.write(run.out)
    if (run.code !== 0) {
      red++
      if (!/FAIL/.test(run.out)) console.log(`  [FAIL] scene ${run.scene} ended with ${String(run.code)} and named no failure`)
    }
  }
  console.log(red === 0 ? '\nprove-orphan-drain-screen-returns: all green' : `\nprove-orphan-drain-screen-returns: ${red} PART(S) RED`)
  process.exit(red === 0 ? 0 : 1)
}

const RETURNS = SCENE === 'screen-returns'
const PROBE = 'drain-probe:'
const ANSWER_END = 'and it ended by itself'
const DRAIN_CEILING_MINUTES = '0.35'
const CEILING_MS = Number(DRAIN_CEILING_MINUTES) * 60_000
const SETTLE_HOLD_MS = 5_000

const SCRATCH = mkdtempSync(join(tmpdir(), 'drain-screen-'))
const configDir = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
for (const d of [configDir, daemonDir, work]) mkdirSync(d, { recursive: true })
writeFileSync(join(work, 'README.md'), '# drain fixture\n')
process.env.MERCURY_CONFIG_DIR = configDir
process.env.MERCURY_DAEMON_DIR = daemonDir
delete process.env.MERCURY_HOME
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(configDir, [work])
const { daemonControlRpc, readDaemonState } = await import('../../src/daemon/controlSocket.ts')
const sup = await import('../../src/daemon/concourseWorkers.ts')
const ownerWatch = await import('../../src/daemon/ownerWatch.ts')
const handshake = await import('../../src/daemon/handshake.ts')
const paths = await import('../../src/utils/sessionStorage/paths.ts')
const turnCut = await import('../../src/utils/messages/turnCut.ts')

type Rec = { runnerId: string; sessionId: string; pid?: number; focusedBy?: string; parkedAt?: number; parkedBy?: string; parkReason?: string; parkRequestedAt?: number; parkRequestedBy?: string; lastDeliveryAt?: number; lastTurnSettledAt?: number; endedAt?: number }
const recordsFile = join(daemonDir, 'concourse-workers.json')
const readRec = (sid: string): Rec | undefined => {
  try {
    const all = JSON.parse(readFileSync(recordsFile, 'utf8')) as { workers: Record<string, Rec> }
    return Object.values(all.workers).find(w => w.sessionId === sid)
  } catch {
    return undefined
  }
}
const brief = (r: Rec | undefined): string =>
  r === undefined ? 'no record' : j({ runnerId: r.runnerId, pid: r.pid, focusedBy: r.focusedBy, parkRequestedAt: r.parkRequestedAt, parkRequestedBy: r.parkRequestedBy, parkedAt: r.parkedAt, parkedBy: r.parkedBy, parkReason: r.parkReason, lastDeliveryAt: r.lastDeliveryAt, lastTurnSettledAt: r.lastTurnSettledAt })
const daemonLogPath = join(SCRATCH, 'daemon.log')
const daemonLog = (): string => (existsSync(daemonLogPath) ? readFileSync(daemonLogPath, 'utf8') : '')
const logTail = (): string => daemonLog().split('\n').filter(l => /park|owner|screen|idle|drain|shutting/.test(l)).slice(-8).join(' | ')
const stampOf = (line: RegExp): number | null => {
  const hit = daemonLog().split('\n').find(l => line.test(l))
  const at = hit === undefined ? Number.NaN : Date.parse(hit.split(' ')[0] ?? '')
  return Number.isFinite(at) ? at : null
}
const count = (words: string): number => daemonLog().split(words).length - 1

const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
const usage = { input_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 8 }
const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map(b => ((b as { type?: string; text?: string }).type === 'text' ? ((b as { text?: string }).text ?? '') : '')).join('')
      : ''
let seatStreams = 0
let seatStreamsEnded = 0
let releaseSeat: () => void = () => {}
const seatReleased = new Promise<void>(resolve => {
  releaseSeat = resolve
})
const fixture = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const url = (req.url ?? '').split('?')[0] ?? ''
    if (req.method !== 'POST' || !url.endsWith('/v1/messages')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    let body: { model?: unknown; stream?: unknown; messages?: unknown[] } = {}
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof body
    } catch {}
    const model = typeof body.model === 'string' ? body.model : 'fixture'
    const seat = (body.messages ?? []).some(m => (m as { role?: string }).role === 'user' && textOf((m as { content?: unknown }).content).includes(PROBE))
    if (body.stream !== true) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'msg_side', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null, usage }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.write(sse('message_start', { type: 'message_start', message: { id: `msg_${Date.now()}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } }))
    res.write(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
    res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: seat ? 'the reply began ' : 'ok' } }))
    const finish = (): void => {
      res.write(sse('content_block_stop', { type: 'content_block_stop', index: 0 }))
      res.write(sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage }))
      res.end(sse('message_stop', { type: 'message_stop' }))
    }
    if (!seat) {
      finish()
      return
    }
    seatStreams++
    void seatReleased.then(() => {
      res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ANSWER_END } }))
      finish()
      seatStreamsEnded++
    })
  })
})
await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`

const owner = spawn('sleep', ['900'], { stdio: 'ignore' })
const cockpit = spawn('sleep', ['900'], { stdio: 'ignore' })
const daemonEnv: Record<string, string | undefined> = {
  ...process.env,
  MERCURY_CONFIG_DIR: configDir,
  MERCURY_DAEMON_DIR: daemonDir,
  MERCURY_DAEMON_OWNER_PID: String(owner.pid),
  MERCURY_SESSION_PARK_DRAIN_MINUTES: DRAIN_CEILING_MINUTES,
  ANTHROPIC_API_KEY: 'fixture-key-000',
  ANTHROPIC_BASE_URL: base,
  MERCURY_CACHE_CLOCK: '0',
  MERCURY_PARTY: '0',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_TERMINAL_TITLE: '0',
  MERCURY_TURN_RECEIPT: '0',
  MERCURY_VERIFY_EVIDENCE: '0',
  MERCURY_WARM_RUNNER: '0',
}
delete daemonEnv.MERCURY_DAEMON_PERSIST
delete daemonEnv.MERCURY_DAEMON_OWNER_FD
delete daemonEnv.DRAIN_SCREEN_SCENE
if (!RETURNS) daemonEnv.MERCURY_DAEMON_OWNER_FD = '3'
const logFd = openSync(daemonLogPath, 'a')
const daemon = spawn('node', [DIST, 'daemon', 'run', work], { cwd: work, env: daemonEnv as NodeJS.ProcessEnv, stdio: RETURNS ? ['ignore', logFd, logFd] : ['ignore', logFd, logFd, 'pipe'] })
const ownerPipe = RETURNS ? null : (daemon.stdio[3] as import('node:net').Socket | null)
ownerPipe?.on('error', () => {})
const daemonGone = (): boolean => daemon.exitCode !== null || daemon.signalCode !== null
const cleanup = async (): Promise<void> => {
  releaseSeat()
  for (const idler of [owner, cockpit]) {
    try {
      idler.kill('SIGKILL')
    } catch {}
  }
  if (!daemonGone()) {
    try {
      await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never)
    } catch {}
    try {
      daemon.kill('SIGTERM')
    } catch {}
    await untilAsync(daemonGone, 10_000)
  }
  fixture.closeAllConnections()
  await new Promise<void>(resolve => fixture.close(() => resolve()))
  if (failures === 0) rmSync(SCRATCH, { recursive: true, force: true })
  else console.log(`[forensics] world kept: ${SCRATCH}`)
}
const watchBudget = ownerWatch.OWNER_WATCH_INTERVAL_MS * (ownerWatch.OWNER_WATCH_GRACE_CHECKS + 2) + 12_000

console.log(RETURNS
  ? `\nscreen-returns: the owner dies while a turn runs and a second cockpit comes inside the drain (${CEILING_MS / 1000} s): it takes the ownership, the turn goes on to its own end, the daemon stays and watches it`
  : `\nnobody-comes: the owner's pipe closes while a turn runs (its pid lives on, its stamp still on the session), a stale stamp comes to name a live pid, and no window comes back: at the ceiling (${CEILING_MS / 1000} s) the turn is cut, the session parks and the daemon leaves`)
try {
  check('the daemon serves under an owner', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000), logTail())
  const dispatched = (await daemonControlRpc({
    op: 'concourseDispatch',
    clientMessageId: `drain-screen-${SCENE}`,
    prompt: `${PROBE} answer when the stream ends`,
    workspaceDir: work,
    title: 'Drain probe',
    model: 'claude-opus-5',
    effort: 'high',
  } as never, { timeoutMs: 15_000 })) as { ok?: boolean; sessionId?: string }
  check('a session dispatched onto a real runner', dispatched.ok === true && typeof dispatched.sessionId === 'string', j(dispatched))
  const sid = dispatched.sessionId ?? ''
  const transcriptPath = join(paths.getProjectDir(work), `${sid}.jsonl`)
  const transcript = (): string => (existsSync(transcriptPath) ? readFileSync(transcriptPath, 'utf8') : '')
  const focus = async (pid: number | undefined): Promise<{ ok?: boolean; outcome?: string; detail?: string }> =>
    (await daemonControlRpc({ op: 'sessionControl', action: 'focus', sessionId: sid, by: `operator:${pid}` } as never, { timeoutMs: 15_000 })) as { ok?: boolean; outcome?: string; detail?: string }
  check('its turn is in flight (the reply stream is open and held by the fixture)', await untilAsync(() => seatStreams >= 1, 90_000), `seat streams ${seatStreams}`)
  await sleep(400)
  const ownerOn = await focus(owner.pid)
  const before = readRec(sid)
  const pid = before?.pid
  check("the owner's own window stands on the session: the record is live, mid-turn, focused by it, and no park is asked for", ownerOn.outcome === 'applied' && before !== undefined && alive(pid) && sup.turnInFlightOf(before as never) && before.focusedBy === `operator:${owner.pid}` && before.parkRequestedAt === undefined && before.parkedAt === undefined, `${j(ownerOn)} ${brief(before)}`)

  if (ownerPipe === null) owner.kill('SIGKILL')
  else ownerPipe.destroy()
  check(`the owner goes (${ownerPipe === null ? 'its process is killed' : 'its pipe closes'}): with no live cockpit the daemon asks every session to park, and the one mid-turn drains`, await untilAsync(() => /the screen is gone — parking every active session: parked 0, draining 1 /.test(daemonLog()), 45_000) && daemonLog().includes(`owner pid ${owner.pid} gone (${ownerPipe === null ? 'owner-gone' : 'owner-pipe-eof'})`), logTail())
  const reapAt = stampOf(/the screen is gone — parking every active session/) ?? Date.now()
  const draining = readRec(sid)
  check('the park is asked for by the reap, not applied: the runner keeps its turn and the daemon waits', draining?.parkRequestedAt !== undefined && draining.parkRequestedBy === REAP && draining.parkedAt === undefined && draining.focusedBy === `operator:${owner.pid}` && alive(pid) && !daemonGone(), brief(draining))

  if (!RETURNS) {
    const staleAt = reapAt - 3_600_000
    sup.updateConcourseWorkers(workers => {
      workers['concourse-w90'] = { schema: 1, runnerId: 'concourse-w90', sessionId: '00000000-dddd-4000-8000-000000000090', workspaceId: work, isolation: 'exclusive', modelKey: 'claude-opus-5', spawnedAt: staleAt, lastLiveAt: staleAt, pid: 2_147_000_000, lastDeliveryAt: staleAt, lastTurnSettledAt: staleAt + 1, focusedAt: staleAt, focusedBy: `operator:${cockpit.pid}` } as never
    })
    await sleep(3_000)
    const held = readRec(sid)
    check("inside the drain a stamp an hour older than the reap comes to name a live pid (what a dead window's stamp reads as once another program takes its pid; here the proof writes it, for a process of its own): three seconds on the daemon has not taken that process for a window (red before the guard: the reap called off for it, the daemon staying for as long as it lives)", alive(cockpit.pid) && !/the screen came back|ownership passes/.test(daemonLog()) && held?.parkRequestedAt !== undefined && held.parkRequestedBy === REAP && !daemonGone(), `${brief(held)} · ${logTail()}`)
  }

  if (RETURNS) {
    const came = await focus(cockpit.pid)
    check("a second cockpit comes inside the drain and stands on the running session: its record appears by the daemon's own focus door", came.outcome === 'applied' && readRec(sid)?.focusedBy === `operator:${cockpit.pid}` && Date.now() - reapAt < CEILING_MS / 2, `${j(came)} ${brief(readRec(sid))} ${Date.now() - reapAt} ms after the reap began`)
    check('the cockpit that came takes the ownership, and the daemon says so in its log in the words it uses when ownership passes at once (red on the parent: nothing in the drain looks for it)', await untilAsync(() => daemonLog().includes(`the screen came back inside the drain — ownership passes to the live cockpit pid ${cockpit.pid}; the daemon stays up`), 8_000), logTail())
    check('the reap is called off: the park it asked of the running session is withdrawn', await untilAsync(() => readRec(sid)?.parkRequestedAt === undefined, 4_000) && readRec(sid)?.parkedAt === undefined && daemonLog().includes(`${draining?.runnerId} keeps its turn`), `${brief(readRec(sid))} · ${logTail()}`)
    const record = await readDaemonState()
    check('the daemon record names the cockpit that came as its owner', await untilAsync(async () => (await readDaemonState())?.ownerPid === cockpit.pid, 4_000), `record ownerPid=${record?.ownerPid} want ${cockpit.pid}`)
    const hello = await handshake.handshakeDaemon({ timeoutMs: 3000 })
    check('…and so do its hello facts', hello.daemon?.ownerPid === cockpit.pid, `hello ownerPid=${hello.daemon?.ownerPid ?? 'none'} state=${hello.state}`)
    await sleep(Math.max(0, reapAt + CEILING_MS + 4_000 - Date.now()))
    const past = readRec(sid)
    check(`${Math.round((Date.now() - reapAt) / 1000)} s after the reap began, past the ceiling, the turn still runs: nothing is cut, the runner lives, the session is not parked and the daemon stands (red on the parent: cut at the ceiling, the daemon gone)`, !daemonGone() && alive(pid) && past !== undefined && past.parkedAt === undefined && sup.turnInFlightOf(past as never) && seatStreamsEnded === 0 && !/drain ceiling/.test(daemonLog()) && !/\[Request /.test(transcript()), `daemon gone ${daemonGone()}, runner alive ${alive(pid)}, ${brief(past)}, row ${/\[Request [^\]]*\]/.exec(transcript())?.[0] ?? 'none'} · ${logTail()}`)
    const heldUntilRelease = past !== undefined && sup.turnInFlightOf(past as never) && alive(pid)
    releaseSeat()
    check('the turn ends by itself: it ran until the fixture let its reply go, and then settles in the record', heldUntilRelease && (await untilAsync(() => {
      const r = readRec(sid)
      return seatStreamsEnded >= 1 && r !== undefined && !sup.turnInFlightOf(r as never)
    }, 30_000)), `in flight at the release ${heldUntilRelease}, ended ${seatStreamsEnded}, ${brief(readRec(sid))}`)
    check("the transcript holds the engine's own answer and a completed turn, and no cut row of any kind", await untilAsync(() => transcript().includes(ANSWER_END) && /"metaKind":"turn-end","fields":\{[^}]*"status":"completed"/.test(transcript()), 15_000) && !/\[Request (?:interrupted by user|cut off)/.test(transcript()), j({ answer: transcript().includes(ANSWER_END), turnEnd: /"metaKind":"turn-end","fields":\{[^}]*\}/.exec(transcript())?.[0] ?? null, cutRow: /\[Request [^\]]*\]/.exec(transcript())?.[0] ?? null }))
    await sleep(SETTLE_HOLD_MS)
    const settled = readRec(sid)
    check(`${SETTLE_HOLD_MS / 1000} s after its own end the session stays under the cockpit that came: not parked, its runner alive, the daemon up, and the log names no park and no cut`, !daemonGone() && alive(pid) && settled !== undefined && settled.parkedAt === undefined && settled.parkRequestedAt === undefined && settled.focusedBy === `operator:${cockpit.pid}` && !/finished its turn and parked|drain ceiling|shutting down/.test(daemonLog()), `daemon gone ${daemonGone()}, runner alive ${alive(pid)}, ${brief(settled)} · ${logTail()}`)
    const stood = !daemonGone()
    cockpit.kill('SIGKILL')
    check('the cockpit that came goes too and nobody is left: the daemon, which stood until then, watched it, parks what it holds and leaves (no daemon that never ends)', stood && (await untilAsync(daemonGone, watchBudget + 10_000)), `stood ${stood} · ${logTail()}`)
    const left = readRec(sid)
    check('…by a second reap in its log, the session at rest parked at once by that reap, its runner gone', count('no live cockpit remains: parking every active session, then self-reaping') === 2 && daemonLog().includes(`owner pid ${cockpit.pid} gone`) && left?.parkedAt !== undefined && left.parkedBy === REAP && left.parkReason !== sup.PARK_DRAIN_CUT_REASON && (await untilAsync(() => !alive(pid), 10_000)), `${brief(left)} · ${logTail()}`)
  } else {
    const cut = await untilAsync(() => /was still mid-turn at the drain ceiling — its turn is cut and it parks/.test(daemonLog()), CEILING_MS + 20_000)
    const cutAt = stampOf(/was still mid-turn at the drain ceiling/)
    check('nobody comes: the turn is cut at the ceiling, not before it', cut && cutAt !== null && cutAt - reapAt >= CEILING_MS - 1_500 && cutAt - reapAt <= CEILING_MS + 10_000, `cut ${cut}, ${cutAt === null ? 'no stamp' : `${cutAt - reapAt} ms after the reap began`} · ${logTail()}`)
    check("the daemon leaves, and no stamp older than its reap was a window that came back: not the stale one, and not its lost owner's, whose pid lives and whose stamp stands on the session the whole drain", (await untilAsync(daemonGone, 20_000)) && /owner-orphaned — shutting down/.test(daemonLog()) && !/ownership passes|the screen came back/.test(daemonLog()) && alive(owner.pid) && alive(cockpit.pid), `owner alive ${alive(owner.pid)}, the other process alive ${alive(cockpit.pid)} · ${logTail()}`)
    const parked = readRec(sid)
    check('the session is parked as a turn cut at the drain ceiling, and its runner is gone', parked?.parkedAt !== undefined && parked.parkedBy === REAP && parked.parkReason === sup.PARK_DRAIN_CUT_REASON && (await untilAsync(() => !alive(pid), 10_000)), brief(parked))
    check('the model was asked once and the fixture never let its reply go: the turn was cut, not finished', seatStreams === 1 && seatStreamsEnded === 0, `streams ${seatStreams}, ended ${seatStreamsEnded}`)
    const words = (turnCut as { DRAIN_CUT_WORDS?: string }).DRAIN_CUT_WORDS
    const cutRow = (): string => /\[Request [^\]]*\]/.exec(transcript())?.[0] ?? 'none'
    check("the transcript's row for the cut says what it was, in the owner's sentence, and is not the user's interrupt (red before the row's mend: [Request interrupted by user])", (await untilAsync(() => cutRow() !== 'none', 10_000)) && typeof words === 'string' && cutRow() === `[Request cut off: ${words}]` && !transcript().includes('[Request interrupted by user'), `the row reads ${cutRow()}`)
    const turnEnd = /"metaKind":"turn-end","fields":\{[^}]*\}/.exec(transcript())?.[0] ?? 'none'
    check("the turn's end is a cut's (failed), never an interrupt's", /"status":"failed"/.test(turnEnd) && !/"status":"interrupted"/.test(transcript()), turnEnd)
    const lastPrompts = [...transcript().matchAll(/"metaKind":"last-prompt","fields":\{"lastPrompt":"((?:[^"\\]|\\.)*)"/g)].map(m => m[1] ?? '')
    check("the session keeps the words it was given as its last prompt: the cut's row is not taken for one", lastPrompts.length > 0 && !lastPrompts.some(text => text.startsWith('[Request')), j(lastPrompts.map(text => text.slice(0, 80))))
  }
} finally {
  await cleanup()
}
console.log(failures === 0 ? `  scene ${SCENE}: green` : `  scene ${SCENE}: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
