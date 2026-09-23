#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { basename, join } from 'node:path'
import { DIST, SCRATCH_ROOT, bootRunner, bound, childEnv, isResult, makeTally, queueJournal, removeWorld, sleep, transcriptFiles, user, type Frame } from '../daemon/dupline-world.ts'
import { seedScratchHome, startScriptedFixture, type Script, type ScriptedRequest } from '../lib/scriptedTurn.ts'

const tally = makeTally('prove-held-notice-wakes-idle')

tally.section('§0 the held set, pure: what wakes an idle main agent')
{
  const q = await import('../../src/input-core/command-queue.ts')
  const notice = (status: string): Parameters<typeof q.isHeldNotice>[0] => ({ value: `<task-notification>\n<task-id>a</task-id>\n<status>${status}</status>\n</task-notification>`, mode: 'task-notification' }) as never
  tally.check('a completed, failed, killed or stopped task notification is a held notice (red on the base: no such classifier)', ['completed', 'failed', 'killed', 'stopped'].every(status => q.isHeldNotice(notice(status))))
  tally.check('a running, resumed or paused notification is not', ['running', 'resumed', 'paused'].every(status => !q.isHeldNotice(notice(status))))
  tally.check('the restart row is in the set', q.isHeldNotice({ value: 'runner restarted after a crash: 1 background agents relaunched, 0 delivered from their receipts, 0 stopped', mode: 'task-notification' } as never))
  tally.check('an ended watch is in the set; a plain monitor line is not', q.isHeldNotice({ value: '<monitor id="m1">\n[Monitor "build" ended]', mode: 'task-notification' } as never) && !q.isHeldNotice({ value: '<monitor id="m1">\nline 12 of the log', mode: 'task-notification' } as never))
  tally.check("an operator's line is not a notice but wakes too; a meta line does not", !q.isHeldNotice({ value: 'words', mode: 'prompt' } as never) && q.isOperatorLine({ value: 'words', mode: 'prompt' } as never) && q.isOperatorLine({ value: 'ls', mode: 'bash' } as never) && !q.isOperatorLine({ value: 'nudge', mode: 'prompt', isMeta: true } as never) && !q.isOperatorLine(notice('completed')))
}

if (!existsSync(DIST)) {
  console.log(`  [SKIP] ${DIST} absent — build first or pass --dist; §0 above still ran`)
  tally.finish()
}
console.log(`build under proof: ${DIST}`)
console.log(' red on the base: L2, L3 and L4 of both roads (a daemon-hosted runner never receives initialize, so the notices its resume queued at boot waited for the operator\'s next words)')

const LAUNCH_ASK = 'held notice probe: launch the child'
const CHILD_PROMPT = 'the child of the held notice probe'
const CHILD_DONE = 'the held notice child finished'
const LAUNCHED = 'held notice probe: the child runs on in the background'
const NOTED = 'held notice probe: the notice is read'
const LAUNCH_LINE = 'Agent launched in the background.'
const HANG_MS = 600_000
const TAKE_BOUND_MS = 2_500
const HELD_STATUS = /<status>(?:killed|stopped|failed|completed)<\/status>/

type Block = { type?: string; text?: string }
const blocksOf = (f: Frame): Block[] => {
  const content = (f.message as { content?: unknown } | undefined)?.content
  return Array.isArray(content) ? (content as Block[]) : []
}
const textOf = (f: Frame): string => blocksOf(f).map(b => (b.type === 'text' ? (b.text ?? '') : '')).join('')
const isChild = (req: ScriptedRequest): boolean => req.opening.trim() === CHILD_PROMPT
const script: Script = req => {
  if (isChild(req)) return [{ type: 'text', text: CHILD_DONE }]
  if (req.ask.includes('<task-notification>') || req.ask.includes('runner restarted')) return [{ type: 'text', text: NOTED }]
  if (!req.ask.trim().startsWith(LAUNCH_ASK)) return [{ type: 'text', text: 'ok' }]
  if (req.step === 0) return [{ type: 'tool_use', name: 'Agent', input: { description: 'the held notice probe child', prompt: CHILD_PROMPT, run_in_background: true } }]
  return [{ type: 'text', text: LAUNCHED }]
}
let hangNextChild = false
const fixture = await startScriptedFixture(script, {
  answerDelayMs: req => {
    if (!isChild(req) || !hangNextChild) return 0
    hangNextChild = false
    return HANG_MS
  },
})
const port = Number(new URL(fixture.base).port)
const roots: string[] = []

type World = { runHome: string; cwd: string; env: NodeJS.ProcessEnv }
function world(label: string): World {
  const root = realpathSync(mkdtempSync(join(SCRATCH_ROOT, `held-notice-${label}-`)))
  roots.push(root)
  const runHome = join(root, 'home')
  const cwd = join(root, 'work')
  seedScratchHome(runHome, cwd)
  const env = childEnv(runHome, port)
  delete env.MERCURY_CONCOURSE_WORKER
  delete env.MERCURY_RUNNER_RESTART_REASON
  return { runHome, cwd, env }
}
const sessionText = (w: World, sessionId: string): string => {
  const file = transcriptFiles(join(w.runHome, 'projects')).find(p => basename(p) === `${sessionId}.jsonl`)
  if (file === undefined) return ''
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

type Crash = { sessionId: string; childId: string; launched: boolean; recorded: boolean; hung: boolean; killed: boolean }
async function crashWithTheChildRunning(w: World, label: string): Promise<Crash> {
  const sessionId = randomUUID()
  const before = fixture.requests.length
  hangNextChild = true
  const runner = bootRunner({ cwd: w.cwd, env: w.env, extraArgv: ['--session-id', sessionId] })
  runner.send(user(`${LAUNCH_ASK} (${label})`, randomUUID()))
  const closing = await runner.waitFor("the parent's closing words", f => f.type === 'assistant' && textOf(f).includes(LAUNCHED), bound(90_000))
  const hungBy = Date.now() + bound(30_000)
  while (Date.now() < hungBy && !fixture.requests.slice(before).some(isChild)) await sleep(100)
  const receipt = fixture.requests.slice(before).flatMap(r => r.results).find(x => x.text.startsWith(LAUNCH_LINE))
  const recordedBy = Date.now() + bound(10_000)
  while (Date.now() < recordedBy && !sessionText(w, sessionId).includes(LAUNCH_LINE)) await sleep(100)
  const recorded = sessionText(w, sessionId).includes(LAUNCH_LINE)
  const hung = fixture.requests.slice(before).some(isChild)
  runner.kill()
  const killed = await Promise.race([runner.exited.then(() => true), sleep(bound(15_000)).then(() => false)])
  return { sessionId, childId: /agentId: (\S+)/.exec(receipt?.text ?? '')?.[1] ?? '', launched: closing !== null && receipt !== undefined, recorded, hung, killed }
}

async function proveRoad(name: 'cold' | 'warm'): Promise<void> {
  tally.section(
    name === 'cold'
      ? 'cold road: a runner killed under a running background agent is respawned with --resume, as the daemon respawns a crashed seat'
      : 'warm road: a warm runner claims the crashed session with resume: true and restart_reason: crash',
  )
  const w = world(name)
  const crash = await crashWithTheChildRunning(w, name)
  tally.check(`${name} P1 the first runner launched the child in the background and the launch receipt is in the transcript`, crash.launched && crash.recorded && crash.childId !== '', JSON.stringify(crash))
  tally.check(`${name} P2 the child's request hung at the wire and the first runner was killed under it`, crash.hung && crash.killed, JSON.stringify(crash))

  const before = fixture.requests.length
  const bootAt = Date.now()
  const env: NodeJS.ProcessEnv = { ...w.env, MERCURY_CONCOURSE_WORKER: '1', ...(name === 'cold' ? { MERCURY_RUNNER_RESTART_REASON: 'crash' } : {}) }
  const runner = bootRunner({ cwd: w.cwd, env, ...(name === 'cold' ? { extraArgv: ['--resume', crash.sessionId] } : {}) })
  if (name === 'warm') {
    const claimId = `req_claim_${randomUUID().slice(0, 8)}`
    runner.send({ type: 'control_request', request_id: claimId, request: { subtype: 'claim_session', session_id: crash.sessionId, resume: true, restart_reason: 'crash' } })
    const answer = await runner.waitFor('the claim answer', f => f.type === 'control_response' && (f.response as { request_id?: unknown } | undefined)?.request_id === claimId, bound(60_000))
    const response = answer?.response as { subtype?: unknown; response?: { session_id?: unknown } } | undefined
    tally.check('warm P3 the warm runner took the crashed session through the claim', response?.subtype === 'success' && response.response?.session_id === crash.sessionId, JSON.stringify(answer ?? null).slice(0, 240))
  }

  const started = await runner.waitFor('a turn on the restarted runner', f => f.type === 'system' && f.subtype === 'turn_started', bound(20_000))
  const turnAt = started === null ? Number.NaN : Date.now()
  const result = started === null ? null : await runner.waitFor("that turn's result", isResult, bound(60_000))
  await sleep(300)
  const alive = runner.proc.exitCode === null && runner.proc.signalCode === null
  const heldFor = (text: string): boolean => (crash.childId !== '' && text.includes(`<task-id>${crash.childId}</task-id>`) && HELD_STATUS.test(text)) || text.includes('runner restarted after')
  const carrying = fixture.requests.slice(before).find(r => !isChild(r) && heldFor(r.ask))
  const rows = queueJournal(join(w.runHome, 'projects'))
  const queuedRow = rows.findIndex(r => r.operation === 'enqueue' && heldFor(r.content))
  const takenRow = queuedRow < 0 ? undefined : rows.slice(queuedRow + 1).find(r => r.operation === 'dequeue')
  const queuedAt = queuedRow < 0 ? Number.NaN : Date.parse(rows[queuedRow]!.at)
  const takenAt = takenRow === undefined ? Number.NaN : Date.parse(takenRow.at)
  const gap = takenAt - queuedAt
  const since = (at: number): string => (Number.isFinite(at) ? `+${((at - bootAt) / 1000).toFixed(2)}s` : 'never')
  console.log(`  clock: restart ${since(bootAt)} · notice queued ${since(queuedAt)} · taken ${since(takenAt)} · turn_started ${since(turnAt)} · queued→taken ${Number.isFinite(gap) ? `${Math.round(gap)} ms` : 'never'}`)
  console.log(`  requests after the restart: ${fixture.requests.slice(before).map(r => `${r.n}:${isChild(r) ? 'child' : 'main'}${r.step} ${JSON.stringify(r.ask.slice(0, 48))}`).join(' · ') || 'none'}`)

  tally.check(`${name} L1 the restarted runner queued a held notice for the child (its stop, or its landing where the restart relaunched it, or the restart row)`, queuedRow >= 0, JSON.stringify(rows.map(r => `${r.operation}:${r.content.slice(0, 40)}`)).slice(0, 400))
  tally.check(`${name} L2 with no user message sent, a turn started on the restarted runner and its model request carried that notice as its own ask`, started !== null && carrying !== undefined, `turn_started ${started !== null} · carrying request ${carrying?.n ?? 'none'}`)
  tally.check(`${name} L3 the runner took the notice for its turn within ${TAKE_BOUND_MS} ms of queueing it`, Number.isFinite(gap) && gap <= TAKE_BOUND_MS, Number.isFinite(gap) ? `${Math.round(gap)} ms` : 'the notice was never taken')
  tally.check(`${name} L4 the turn settled with a result and the seat stayed up for the next message`, result !== null && alive, `result ${result === null ? 'none' : String(result.subtype)} · alive ${alive}`)
  if (tally.failed() > 0) console.log(`  stderr tail: ${runner.stderr().trim().split('\n').slice(-3).join(' | ').slice(0, 400)}`)
  await runner.stop(bound(5_000))
}

await proveRoad('cold')
await proveRoad('warm')
await Promise.race([fixture.close(), sleep(bound(3_000))])
if (tally.failed() === 0) {
  for (const root of roots) await removeWorld(root)
} else {
  console.log(`  worlds kept: ${roots.join(' · ')}`)
}
tally.finish()
