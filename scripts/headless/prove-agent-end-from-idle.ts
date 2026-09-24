#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DIST, SCRATCH_ROOT, bootRunner, bound, childEnv, isResult, makeTally, sleep, user } from '../daemon/dupline-world.ts'
import { seedScratchHome, startScriptedFixture, type Script, type ScriptedRequest } from '../lib/scriptedTurn.ts'

const tally = makeTally('prove-agent-end-from-idle')
if (!existsSync(DIST)) {
  console.log(`  [SKIP] ${DIST} absent — build first or pass --dist`)
  process.exit(0)
}
console.log(`build under proof: ${DIST}`)

const CHILD_PROMPT = 'the child of the idle probe'
const CHILD_DONE = 'the child finished while the parent was idle'
const FOLLOW_UP = 'are you still there'
const CHILD_DELAY_MS = 4_000
type Frame = Record<string, unknown>
type Block = { type?: string; name?: string }
const blocksOf = (f: Frame): Block[] => {
  const content = (f.message as { content?: unknown } | undefined)?.content
  return Array.isArray(content) ? (content as Block[]) : []
}
const isChild = (req: ScriptedRequest): boolean => req.opening.trim() === CHILD_PROMPT
const isNoticeAsk = (req: ScriptedRequest): boolean => !isChild(req) && req.ask.includes('<task-notification>')
const isFollowUp = (req: ScriptedRequest): boolean => !isChild(req) && req.ask.includes(FOLLOW_UP)
const errorsOf = (f: Frame | null): string => (Array.isArray(f?.errors) ? (f!.errors as unknown[]).map(String).join(' | ') : '')

async function leg(name: string, isolation: 'worktree' | undefined): Promise<void> {
  tally.section(name)
  const root = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'agent-end-from-idle-')))
  const runHome = join(root, 'home')
  const cwd = join(root, 'work')
  seedScratchHome(runHome, cwd)
  writeFileSync(join(cwd, 'README.md'), '# fixture\n')
  if (isolation === 'worktree') {
    const git = (...args: string[]): string => execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, stdio: 'pipe' }).toString()
    git('init', '-q', '-b', 'main')
    git('add', 'README.md')
    git('commit', '-q', '-m', 'seed')
  }
  const script: Script = req => {
    if (isChild(req)) return [{ type: 'text', text: CHILD_DONE }]
    if (isNoticeAsk(req)) return [{ type: 'text', text: 'noted' }]
    if (isFollowUp(req)) return [{ type: 'text', text: 'still here' }]
    if (req.step === 0) return [{ type: 'tool_use', name: 'Agent', input: { description: 'the idle probe child', prompt: CHILD_PROMPT, run_in_background: true, ...(isolation ? { isolation } : {}) } }]
    return [{ type: 'text', text: 'parent done' }]
  }
  const fixture = await startScriptedFixture(script, { answerDelayMs: req => (isChild(req) && req.step === 0 ? CHILD_DELAY_MS : 0) })
  const runner = bootRunner({ cwd, env: childEnv(runHome, Number(new URL(fixture.base).port)) })
  runner.send(user('idle probe: launch the child in the background and stop', randomUUID()))

  const launch = await runner.waitFor("the parent's Agent call", f => f.type === 'assistant' && blocksOf(f).some(b => b.type === 'tool_use' && b.name === 'Agent'), bound(60_000))
  tally.check('the parent launched the child in the background', launch !== null)
  const notification = await runner.waitFor("the child's end", f => f.type === 'system' && f.subtype === 'task_notification', bound(CHILD_DELAY_MS + 60_000))
  tally.check("the child's end rides a task notification", notification !== null, JSON.stringify(notification).slice(0, 160))

  const noticeSeen = Date.now() + bound(30_000)
  while (Date.now() < noticeSeen && runner.proc.exitCode === null && !fixture.requests.some(isNoticeAsk)) await sleep(100)
  tally.check('the notification opens a turn that reaches the model', fixture.requests.some(isNoticeAsk), `requests: ${fixture.requests.map(r => (isChild(r) ? 'child' : `parent${r.step}`)).join(' ')}`)
  const refusal = runner.frames.find(f => isResult(f) && f.is_error === true) ?? null
  tally.check('no turn ended in an error envelope', refusal === null, errorsOf(refusal).slice(0, 240))
  tally.check('the seat is still alive after the notification turn', runner.proc.exitCode === null, `exit code ${String(runner.proc.exitCode)}`)

  if (runner.proc.exitCode === null) {
    const before = runner.frames.length
    runner.send(user(FOLLOW_UP, randomUUID()))
    const follow = await runner.waitFor('the follow-up result', f => isResult(f) && fixture.requests.some(isFollowUp), bound(60_000), before)
    tally.check('the seat answers the next message', follow !== null && follow.subtype === 'success' && fixture.requests.some(isFollowUp), String(follow?.subtype))
  } else {
    tally.check('the seat answers the next message', false, 'the seat had already exited')
  }
  await runner.stop(bound(8_000))
  const code = await runner.exited
  tally.check('stdin close ends the seat with exit 0', code === 0, `exit ${String(code)}`)
  await fixture.close()
  console.log(`  timeline: ${runner.frames.map(f => `${String(f.type)}${f.subtype ? ':' + String(f.subtype) : ''}${typeof f.parent_tool_use_id === 'string' ? '(child)' : ''}`).join(' · ')}`)
  const stderr = runner.stderr().trim()
  if (stderr !== '') console.log(`  stderr tail: ${stderr.split('\n').slice(-2).join(' | ').slice(0, 240)}`)
  rmSync(root, { recursive: true, force: true })
}

await leg('control: a background child with no isolation ends while the parent waits; the seat answers its notification and the next message', undefined)
await leg("the law: a background child in its own worktree ends after the parent went idle; its worktree is gone when its notification opens the parent's turn, and the seat still runs that turn in the session folder", 'worktree')
tally.finish()
