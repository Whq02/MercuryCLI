#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DIST, MODEL, NODE, childEnv, makeTally, sleep } from '../daemon/dupline-world.ts'
import { hostRunner } from '../lib/runnerHost.ts'
import { seedScratchHome, startScriptedFixture, type ScriptedFixture, type ScriptedRequest, type WireBlock } from '../lib/scriptedTurn.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const tally = makeTally('prove-send-now-shell-wait')
if (!existsSync(DIST)) {
  console.log(`  [SKIP] ${DIST} absent — build first`)
  process.exit(0)
}
console.log(`build under proof: ${DIST}`)

const ROOT = join(import.meta.dir, '..', '..')
const MAIN_ASK = 'send-now shell probe: run the long command and wait for it'
const MESSAGE = 'the operator says: stop waiting on the command, read this now'
const HEARD = 'heard the operator:'
const NOT_YET = 'no operator message in hand'
const HOLD_SECONDS = 16
const MOVED_WORDS = 'The operator moved this command to the background as task'

type Frame = Record<string, unknown> & { atMs: number }

const runHome = realpathSync(mkdtempSync(join(tmpdir(), 'send-now-shell-')))
const cwd = join(runHome, 'work')
const t0 = Date.now()
let commandIssued = false
const fixture: ScriptedFixture = await startScriptedFixture((req: ScriptedRequest): WireBlock[] => {
  if (req.ask.includes('<task-notification>')) return [{ type: 'text', text: 'noted' }]
  if (req.opening.trim() !== MAIN_ASK) return [{ type: 'text', text: 'ok' }]
  if (req.step === 0 && req.ask.trim() === MAIN_ASK) {
    commandIssued = true
    return [{ type: 'tool_use', name: 'Bash', input: { command: `sleep ${HOLD_SECONDS}; echo finished`, description: 'the long command holds the turn' } }]
  }
  const carried = req.allTexts.some(text => text.includes(MESSAGE))
  return [{ type: 'text', text: carried ? `${HEARD} ${MESSAGE}` : NOT_YET }]
})
seedScratchHome(runHome, cwd)
const port = Number(new URL(fixture.base).port)

const frames: Frame[] = []
let stderr = ''
const host = hostRunner({
  node: NODE,
  dist: DIST,
  argv: ['--model', MODEL, '--mode', 'sovereign', '--sovereign'],
  cwd,
  env: childEnv(runHome, port) as Record<string, string | undefined>,
  home: runHome,
  onRow: frame => {
    frames.push({ ...frame, atMs: Date.now() })
  },
})
host.child.stderr!.on('data', (chunk: Buffer) => {
  stderr += chunk.toString('utf8')
})
void host.initialize().catch(() => undefined)

const until = async (label: string, pred: () => boolean, budgetMs: number): Promise<boolean> => {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (pred()) return true
    await sleep(50)
  }
  console.log(`  (gave up waiting for ${label})`)
  return false
}

const toolStarted = (f: Frame): boolean => f.type === 'tool_call' && f.parent_call_id === undefined
const taskEnded = (f: Frame): boolean => f.type === 'task' && f.state === 'ended'
const mainText = (f: Frame): boolean => f.type === 'text' && f.parent_call_id === undefined
const heardFrame = (): Frame | undefined => frames.find(f => mainText(f) && JSON.stringify(f).includes(HEARD))

void host.prompt(MAIN_ASK, { id: randomUUID() }).catch(() => undefined)
const started = await until('the command to start', () => commandIssued && frames.some(toolStarted), vshotBudgetMs(40_000))
await sleep(1_000)
const sentAtMs = Date.now()
void host.prompt(MESSAGE, { id: randomUUID() }).catch(() => undefined)
await sleep(2_500)
const spokeBeforeChord = heardFrame() !== undefined
const chordAtMs = Date.now()
const chord = await host.request('session/send_now', {}, 10_000).catch((error: unknown) => ({ error: String(error) }))
console.log(`  session/send_now answered: ${JSON.stringify(chord)}`)

await until('the main agent to speak after the chord', () => heardFrame() !== undefined, vshotBudgetMs((HOLD_SECONDS + 20) * 1000))
await until('the command to end in the background', () => frames.some(taskEnded), vshotBudgetMs((HOLD_SECONDS + 20) * 1000))
await sleep(1_500)
host.end()
await Promise.race([host.exited, sleep(5_000)])
try {
  host.child.kill('SIGKILL')
} catch {
}
await fixture.close()

const heard = heardFrame()
const notYet = frames.find(f => mainText(f) && JSON.stringify(f).includes(NOT_YET))
const ended = frames.find(taskEnded)
const mainSteps = fixture.requests.filter(r => r.opening.trim() === MAIN_ASK)
const afterCommand = mainSteps.find(r => r.step === 1)
const commandResult = afterCommand?.results[0]?.text ?? ''
const notice = fixture.requests.find(r => r.ask.includes('<task-notification>'))
const seconds = (ms: number | undefined): string => (ms === undefined ? 'never' : `${((ms - t0) / 1000).toFixed(2)}s`)
console.log(`  timeline: message sent ${seconds(sentAtMs)} · chord ${seconds(chordAtMs)} · main spoke ${seconds(heard?.atMs)} · command ended ${seconds(ended?.atMs)}`)
console.log(`  command result as the model read it: ${JSON.stringify(commandResult.slice(0, 300))}`)

tally.section('ctrl+s s while a foreground command holds the turn and a sent line waits behind it')
tally.check('the command took the turn', started)
tally.check('the sent line waited behind the command (a shell has no hand-over of its own on arrival)', !spokeBeforeChord)
tally.check('session/send_now answered with the counts: one line queued, nothing on the hold, no crewmate, one shell moved', (chord as { queued?: unknown }).queued === 1 && (chord as { released?: unknown }).released === 0 && (chord as { crewmates?: unknown }).crewmates === 0 && (chord as { shells?: unknown }).shells === 1, JSON.stringify(chord))
tally.check('the main agent read the operator\'s message and answered it', heard !== undefined && notYet === undefined, heard === undefined ? `no reply carrying "${HEARD}"${notYet !== undefined ? ' — the model answered without the message' : ''}` : '')
tally.check('the answer landed after the chord and BEFORE the command ended', heard !== undefined && ended !== undefined && heard.atMs >= chordAtMs && heard.atMs < ended.atMs, `main spoke ${seconds(heard?.atMs)} · command ended ${seconds(ended?.atMs)}`)
tally.check('the Bash call returned the operator\'s move-to-background acknowledgement, the command still running', commandResult.includes(MOVED_WORDS) && commandResult.includes('it is still running, and its output arrives as a notification when it completes'), commandResult.slice(0, 300))
tally.check('the operator\'s words reached the model as the queued line of the same turn', afterCommand !== undefined && afterCommand.allTexts.some(text => text.includes(MESSAGE)), afterCommand === undefined ? 'no second request of the main turn' : afterCommand.ask.slice(0, 120))
tally.check('the command ran on in the background to its own end and its completion reached the model as a notification', ended !== undefined && notice !== undefined, `ended ${seconds(ended?.atMs)} · notification ${notice !== undefined ? 'seen' : 'absent'}`)

tally.section('the seam, structural')
{
  const bash = readFileSync(join(ROOT, 'src/tools/BashTool/BashTool.tsx'), 'utf8')
  const request = readFileSync(join(ROOT, 'src/tools/BashTool/backgroundRequest.ts'), 'utf8')
  tally.check('send-now rides the operator\'s one move-to-background road (the shift+B request), never a second one', request.includes('export function requestShellBackground(): number') && bash.includes('const unregisterRun = registerShellRun({') && bash.includes(`return \`${MOVED_WORDS} \${id}; it is still running, and its output arrives as a notification when it completes. Output: \${outputPath}.\``))
}

if (tally.failed() === 0) rmSync(runHome, { recursive: true, force: true })
else console.log(`  world kept: ${runHome}\n  stderr tail: ${stderr.slice(-800)}`)
tally.finish()
