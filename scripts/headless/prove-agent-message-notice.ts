#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DIST, MODEL, NODE, childEnv, makeTally, sleep } from '../daemon/dupline-world.ts'
import { seedScratchHome, startScriptedFixture, type ScriptedFixture, type ScriptedRequest, type WireBlock } from '../lib/scriptedTurn.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { POLL_INTERVAL_MS } from '../../src/utils/task/framework.ts'

const tally = makeTally('prove-agent-message-notice')
if (!existsSync(DIST)) {
  console.log(`  [SKIP] ${DIST} absent — build first`)
  process.exit(0)
}
console.log(`build under proof: ${DIST}`)

const MAIN_ASK = 'message probe: run the world'
const AGENT_PROMPT = 'the sub-agent of the message probe'
const TO_MAIN = 'a message from the sub-agent to the main agent: the tide is out'
const TO_SUB = 'a message from the main agent to the sub-agent: count the boats too'
const MAIN_DONE = 'main done'
const MESSAGE_STATUS = '<status>message</status>'
const FROM_SUB = 'sent a message'
const FROM_MAIN = 'The main agent sent a message'

type Frame = Record<string, unknown> & { atMs: number }
type Runner = { frames: Frame[]; send: (frame: Record<string, unknown>) => void; stop: (graceMs: number) => Promise<void>; stderr: () => string }
type World = 'sub-to-main-midturn' | 'sub-to-main-idle' | 'main-to-sub-midturn' | 'main-to-sub-ended'

function boot(cwd: string, env: NodeJS.ProcessEnv): Runner {
  const argv = [DIST, '-p', '--input-format=stream-json', '--output-format=stream-json', '--model', MODEL, '--permission-mode', 'bypassPermissions', '--dangerously-bypass-permissions']
  const proc = spawn(NODE, argv, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  const frames: Frame[] = []
  let buffer = ''
  let stderr = ''
  proc.stdout!.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      if (line.trim() === '') continue
      try {
        frames.push({ ...(JSON.parse(line) as Record<string, unknown>), atMs: Date.now() })
      } catch {
      }
    }
  })
  proc.stderr!.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })
  const exited = new Promise<void>(resolve => proc.on('exit', () => resolve()))
  return {
    frames,
    stderr: () => stderr,
    send: frame => proc.stdin!.write(`${JSON.stringify(frame)}\n`),
    stop: async graceMs => {
      try {
        proc.stdin!.end()
      } catch {
      }
      await Promise.race([exited, sleep(graceMs)])
      try {
        proc.kill('SIGKILL')
      } catch {
      }
    },
  }
}

const idOf = (text: string | undefined): string | null => /\b(a[0-9a-z]{8})\b/.exec(text ?? '')?.[1] ?? null
const subtypeOf = (f: Frame): string => (f.type === 'system' ? String(f.subtype ?? '') : String(f.type))
const timeline = (frames: Frame[], t0: number): string =>
  frames
    .filter(f => f.type === 'result' || (f.type === 'system' && ['turn_started', 'task_notification'].includes(String(f.subtype))))
    .map(f => `${((f.atMs - t0) / 1000).toFixed(2)}s ${subtypeOf(f)}${f.type === 'system' && f.subtype === 'task_notification' ? `(${String((f as { task_id?: unknown }).task_id)} ${'status' in f ? String(f.status) : 'no status'})` : ''}`)
    .join(' · ')

async function untilQuiet(runner: Runner, wantResults: number, quietMs: number, budgetMs: number): Promise<void> {
  const until = Date.now() + budgetMs
  while (Date.now() < until) {
    const results = runner.frames.filter(f => f.type === 'result').length
    const last = runner.frames.at(-1)?.atMs ?? 0
    if (results >= wantResults && Date.now() - last > quietMs) return
    await sleep(100)
  }
}

type Seen = { n: number; who: 'main' | 'sub'; step: number; atMs: number; ask: string; results: string[]; allTexts: string[] }

async function world(name: World): Promise<void> {
  const shape: Record<World, string> = {
    'sub-to-main-midturn': 'the sub-agent sends to "main" while the main agent holds a 6 s command',
    'sub-to-main-idle': 'the sub-agent sends to "main" while the main agent waits between turns',
    'main-to-sub-midturn': 'the main agent sends to the sub-agent while the sub-agent holds a 5 s command',
    'main-to-sub-ended': 'the main agent sends to a sub-agent whose run has ended',
  }
  tally.section(`${name}: ${shape[name]}`)
  const runHome = realpathSync(mkdtempSync(join(tmpdir(), 'agent-message-')))
  const cwd = join(runHome, 'work')
  let agentId: string | null = null
  const t0 = Date.now()
  const fixture: ScriptedFixture = await startScriptedFixture((req: ScriptedRequest): WireBlock[] => {
    const last = req.results[req.results.length - 1]
    if (req.opening.trim() === AGENT_PROMPT) {
      if (req.ask.trim() !== AGENT_PROMPT && req.ask.trim() !== '') return [{ type: 'text', text: 'agent done again' }]
      switch (name) {
        case 'sub-to-main-midturn':
          if (req.step === 0) return [{ type: 'tool_use', name: 'SendMessage', input: { to: 'main', message: TO_MAIN, summary: 'the tide' } }]
          return [{ type: 'text', text: 'agent done' }]
        case 'sub-to-main-idle':
          if (req.step === 0) return [{ type: 'tool_use', name: 'Bash', input: { command: 'sleep 2', description: 'the sub-agent waits for the main turn to end' } }]
          if (req.step === 1) return [{ type: 'tool_use', name: 'SendMessage', input: { to: 'main', message: TO_MAIN, summary: 'the tide' } }]
          if (req.step === 2) return [{ type: 'tool_use', name: 'Bash', input: { command: 'sleep 3', description: 'the sub-agent works on after its message' } }]
          return [{ type: 'text', text: 'agent done' }]
        case 'main-to-sub-midturn':
          if (req.step === 0) return [{ type: 'tool_use', name: 'Bash', input: { command: 'sleep 5', description: 'the sub-agent holds its turn' } }]
          return [{ type: 'text', text: 'agent done' }]
        case 'main-to-sub-ended':
          return [{ type: 'text', text: 'agent done' }]
      }
    }
    if (req.ask.includes('<task-notification>')) return [{ type: 'text', text: 'noted' }]
    if (req.ask.trim() !== MAIN_ASK) return [{ type: 'text', text: 'ok' }]
    if (req.step === 0) return [{ type: 'tool_use', name: 'Agent', input: { description: 'the probe sub-agent', prompt: AGENT_PROMPT, run_in_background: true } }]
    if (req.step === 1) agentId = idOf(last?.text)
    switch (name) {
      case 'sub-to-main-midturn':
        if (req.step === 1) return [{ type: 'tool_use', name: 'Bash', input: { command: 'sleep 6', description: 'the main agent holds its turn' } }]
        return [{ type: 'text', text: MAIN_DONE }]
      case 'sub-to-main-idle':
        return [{ type: 'text', text: MAIN_DONE }]
      case 'main-to-sub-midturn':
        if (req.step === 1) return [{ type: 'tool_use', name: 'Bash', input: { command: 'sleep 2', description: 'let the sub-agent start its command' } }]
        if (req.step === 2) return [{ type: 'tool_use', name: 'SendMessage', input: { to: agentId ?? 'nobody', message: TO_SUB, summary: 'the boats' } }]
        if (req.step === 3) return [{ type: 'tool_use', name: 'Bash', input: { command: 'sleep 6', description: 'the main agent holds its turn' } }]
        return [{ type: 'text', text: MAIN_DONE }]
      case 'main-to-sub-ended':
        if (req.step === 1) return [{ type: 'tool_use', name: 'Bash', input: { command: 'sleep 3', description: 'let the sub-agent finish' } }]
        if (req.step === 2) return [{ type: 'tool_use', name: 'SendMessage', input: { to: agentId ?? 'nobody', message: TO_SUB, summary: 'the boats' } }]
        if (req.step === 3) return [{ type: 'tool_use', name: 'Bash', input: { command: 'sleep 6', description: 'the main agent holds its turn' } }]
        return [{ type: 'text', text: MAIN_DONE }]
    }
  })
  seedScratchHome(runHome, cwd)
  const port = Number(new URL(fixture.base).port)
  const runner = boot(cwd, childEnv(runHome, port))
  runner.send({ type: 'user', message: { role: 'user', content: MAIN_ASK }, uuid: randomUUID(), session_id: '' })
  const wantResults = name === 'sub-to-main-idle' ? 3 : 1
  await untilQuiet(runner, wantResults, 6_000, vshotBudgetMs(70_000))
  await runner.stop(5_000)
  await fixture.close()

  const seen: Seen[] = fixture.requests.map(r => ({ n: r.n, who: r.opening.trim() === AGENT_PROMPT ? 'sub' : 'main', step: r.step, atMs: r.atMs, ask: r.ask, results: r.results.map(x => x.text), allTexts: r.allTexts }))
  const messageText = name.startsWith('sub-to-main') ? TO_MAIN : TO_SUB
  const receiver = name.startsWith('sub-to-main') ? 'main' : 'sub'
  const sends = seen.flatMap(r => r.results.filter(x => x.includes('"success"') || x.includes('No such tool available: SendMessage') || x.includes('Cannot deliver')))
  const carrying = seen.filter(r => r.who === receiver && r.allTexts.some(t => t.includes(messageText)))
  const carriedTexts = (r: Seen): string[] => r.allTexts.filter(t => t.includes(messageText))
  const first = carrying[0]
  const messageFrames = runner.frames.filter(f => f.type === 'system' && f.subtype === 'task_notification' && String((f as { task_id?: unknown }).task_id) === agentId && !('status' in f))
  const completionFrames = runner.frames.filter(f => f.type === 'system' && f.subtype === 'task_notification' && String((f as { task_id?: unknown }).task_id) === agentId && 'status' in f)
  const turnsStarted = runner.frames.filter(f => f.type === 'system' && f.subtype === 'turn_started').length
  const results = runner.frames.filter(f => f.type === 'result').length
  const sentAt = ((): number => {
    const sender = receiver === 'main' ? 'sub' : 'main'
    const after = seen.find(r => r.who === sender && r.results.some(x => x.includes('"success":true') && (x.includes('Message delivered') || x.includes('resumed in the background') || x.includes('Message queued'))))
    return after?.atMs ?? Number.NaN
  })()
  console.log(`  timeline: ${timeline(runner.frames, t0)}`)
  console.log(`  requests: ${seen.map(r => `${r.n}:${r.who}${r.step}@${((r.atMs - t0) / 1000).toFixed(2)}s`).join(' ')} · agent ${agentId}`)
  console.log(`  send result: ${JSON.stringify(sends[0]?.slice(0, 220) ?? null)}`)
  if (first !== undefined) console.log(`  carried by request ${first.n} (${first.who} step ${first.step}, ${Math.round(first.atMs - sentAt)} ms after the send's receipt): ${JSON.stringify(carriedTexts(first)[0]?.slice(0, 200))}`)

  const delivered = sends.some(x => x.includes('"success":true') && (x.includes('Message delivered to') || x.includes('resumed in the background with your message')))
  tally.check(`${name} L1 the sender's receipt says the message was delivered — never "no such tool", never queued`, delivered && !sends.some(x => x.includes('No such tool') || x.includes('Message queued for')), JSON.stringify(sends.map(x => x.slice(0, 120))))
  tally.check(`${name} L2 the receiver read the message as a task notification whose status is message, naming the sender`, first !== undefined && carriedTexts(first).some(t => t.includes(MESSAGE_STATUS) && t.includes(receiver === 'main' ? FROM_SUB : FROM_MAIN)), first === undefined ? 'no request of the receiver carries the words' : JSON.stringify(carriedTexts(first)[0]?.slice(0, 300)))
  switch (name) {
    case 'sub-to-main-midturn':
      tally.check(`${name} L3 the main agent read it inside its running turn, at the boundary after the held command — the request of the launch turn right after the command's result`, first !== undefined && first.ask.trim() === MAIN_ASK && first.step === 2 && carriedTexts(first).some(t => t.includes('A background agent sent a message:')), `carrying ask ${JSON.stringify(first?.ask.slice(0, 40))} step ${first?.step}`)
      tally.check(`${name} L4 one turn: the message rode the live turn, no turn of its own`, turnsStarted === 1 && results === 1, `turn_started ${turnsStarted} · results ${results}`)
      break
    case 'sub-to-main-idle': {
      const foldStart = runner.frames.filter(f => f.type === 'system' && f.subtype === 'turn_started')[1]?.atMs ?? Number.NaN
      tally.check(`${name} L3 the idle main agent started a turn for the message, and that turn carried the message alone — the completion came in a turn of its own (three turn edges: the launch, the message, the completion; the results collapse while the agent runs)`, first !== undefined && first.ask.includes(MESSAGE_STATUS) && !first.ask.includes('<status>completed</status>') && turnsStarted === 3 && results >= 1, `carrying ask ${JSON.stringify(first?.ask.slice(0, 60))} · turn_started ${turnsStarted} · results ${results}`)
      tally.check(`${name} L4 the message's turn began within the settle window of the send, not at the sub-agent's end`, Number.isFinite(foldStart) && Number.isFinite(sentAt) && foldStart - sentAt < POLL_INTERVAL_MS + 2_000, `turn − send ${Math.round(foldStart - sentAt)} ms · window ${POLL_INTERVAL_MS} ms`)
      break
    }
    case 'main-to-sub-midturn':
      tally.check(`${name} L3 the sub-agent read it inside its running turn, at the boundary after its held command, and its run was not restarted`, first !== undefined && first.step === 1 && seen.filter(r => r.who === 'sub' && r.step === 0).length === 1, `carrying step ${first?.step} · sub runs ${seen.filter(r => r.who === 'sub' && r.step === 0).length}`)
      break
    case 'main-to-sub-ended':
      tally.check(`${name} L3 the ended sub-agent was resumed with the message as its next user text, in the notice's shape`, first !== undefined && first.step === 0 && first.ask.includes(MESSAGE_STATUS) && first.ask.includes(TO_SUB) && sends.some(x => x.includes('resumed in the background with your message')), `carrying step ${first?.step} ask ${JSON.stringify(first?.ask.slice(0, 80))}`)
      break
  }
  const messageFrameAt = messageFrames[0]?.atMs ?? Number.NaN
  const closingAt = runner.frames.find(f => f.type === 'assistant' && JSON.stringify(f).includes(MAIN_DONE))?.atMs ?? Number.NaN
  const beforeClose = name === 'sub-to-main-midturn' || name === 'main-to-sub-midturn' ? Number.isFinite(closingAt) && messageFrameAt < closingAt : true
  tally.check(`${name} L5 the runner spoke exactly one task_notification frame for the message: the agent's id, no status word, the sender in its summary${name.endsWith('midturn') ? ', on the wire before the turn\'s closing words' : ''}`, messageFrames.length === 1 && /sent a message/.test(String((messageFrames[0] as { summary?: unknown } | undefined)?.summary ?? '')) && beforeClose, `message frames ${messageFrames.length}: ${JSON.stringify(messageFrames.map(f => [f.task_id, f.status ?? 'no status', String(f.summary).slice(0, 50)]))} · completion frames ${completionFrames.length}`)
  if (tally.failed() === 0) rmSync(runHome, { recursive: true, force: true })
  else console.log(`  world kept: ${runHome}\n  stderr tail: ${runner.stderr().slice(-500)}`)
}

const only = process.argv.includes('--world') ? process.argv[process.argv.indexOf('--world') + 1] : undefined
for (const name of ['sub-to-main-midturn', 'sub-to-main-idle', 'main-to-sub-midturn', 'main-to-sub-ended'] as World[]) {
  if (only !== undefined && only !== name) continue
  await world(name)
}
tally.finish()
