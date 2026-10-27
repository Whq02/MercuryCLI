#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DIST, MODEL, NODE, childEnv, makeTally, sleep } from '../daemon/dupline-world.ts'
import { hostRunner } from '../lib/runnerHost.ts'
import { seedScratchHome, startScriptedFixture, type ScriptedFixture, type ScriptedRequest, type WireBlock } from '../lib/scriptedTurn.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const tally = makeTally('prove-send-now-sleep-wait')
if (!existsSync(DIST)) {
  console.log(`  [SKIP] ${DIST} absent — build first`)
  process.exit(0)
}
console.log(`build under proof: ${DIST}`)

const ROOT = join(import.meta.dir, '..', '..')
const MAIN_ASK = 'send-now sleep probe: wait a while, then report'
const MESSAGE = 'the operator says: stop sleeping, read this now'
const HEARD = 'heard the operator:'
const NOT_YET = 'no operator message in hand'
const SLEEP_SECONDS = 20
const NEW_INPUT_REASON = 'new input arrived for this turn (it follows this result)'

type Frame = Record<string, unknown> & { atMs: number }

const runHome = realpathSync(mkdtempSync(join(tmpdir(), 'send-now-sleep-')))
const cwd = join(runHome, 'work')
const t0 = Date.now()
let sleepIssued = false
const fixture: ScriptedFixture = await startScriptedFixture((req: ScriptedRequest): WireBlock[] => {
  if (req.opening.trim() !== MAIN_ASK) return [{ type: 'text', text: 'ok' }]
  if (req.step === 0 && req.ask.trim() === MAIN_ASK) {
    sleepIssued = true
    return [{ type: 'tool_use', name: 'Sleep', input: { seconds: SLEEP_SECONDS } }]
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
const mainText = (f: Frame): boolean => f.type === 'text' && f.parent_call_id === undefined
const heardFrame = (): Frame | undefined => frames.find(f => mainText(f) && JSON.stringify(f).includes(HEARD))

void host.prompt(MAIN_ASK, { id: randomUUID() }).catch(() => undefined)
const started = await until('the sleep to start', () => sleepIssued && frames.some(toolStarted), vshotBudgetMs(40_000))
await sleep(1_000)
const effortAnswer = await host.request('session/set_effort', { effort: 'high' }, 10_000).catch((error: unknown) => ({ error: String(error) }))
const sentAtMs = Date.now()
void host.prompt(MESSAGE, { id: randomUUID() }).catch(() => undefined)
await sleep(2_500)
const spokeBeforeChord = heardFrame() !== undefined
const chordAtMs = Date.now()
const chord = await host.request('session/send_now', {}, 10_000).catch((error: unknown) => ({ error: String(error) }))
console.log(`  session/send_now answered: ${JSON.stringify(chord)}`)

await until('the main agent to speak after the chord', () => heardFrame() !== undefined, vshotBudgetMs((SLEEP_SECONDS + 15) * 1000))
await sleep(1_000)
host.end()
await Promise.race([host.exited, sleep(5_000)])
try {
  host.child.kill('SIGKILL')
} catch {
}
await fixture.close()

const heard = heardFrame()
const notYet = frames.find(f => mainText(f) && JSON.stringify(f).includes(NOT_YET))
const mainSteps = fixture.requests.filter(r => r.opening.trim() === MAIN_ASK)
const afterSleep = mainSteps.find(r => r.step === 1)
const sleepResult = afterSleep?.results[0]?.text ?? ''
const seconds = (ms: number | undefined): string => (ms === undefined ? 'never' : `${((ms - t0) / 1000).toFixed(2)}s`)
console.log(`  timeline: message sent ${seconds(sentAtMs)} · chord ${seconds(chordAtMs)} · main spoke ${seconds(heard?.atMs)}`)
console.log(`  sleep result as the model read it: ${JSON.stringify(sleepResult.slice(0, 300))}`)

tally.section('ctrl+s s while a Sleep holds the turn and a sent line waits for the turn\'s end')
tally.check('the sleep took the turn', started)
tally.check('a mid-turn effort pick put the later line on the turn-end hold (the documented wait)', typeof (effortAnswer as { at?: unknown }).at === 'string' && (effortAnswer as { at: string }).at === 'turn_end', JSON.stringify(effortAnswer))
tally.check('the held line did not wake the sleep on its own (the hold held)', !spokeBeforeChord)
tally.check('session/send_now answered with the counts: one line queued and released, no crewmate, no shell', (chord as { queued?: unknown }).queued === 1 && (chord as { released?: unknown }).released === 1 && (chord as { crewmates?: unknown }).crewmates === 0 && (chord as { shells?: unknown }).shells === 0, JSON.stringify(chord))
tally.check('the Sleep ended early with the words it already uses for new input', sleepResult.includes('Sleep interrupted after') && sleepResult.includes(NEW_INPUT_REASON), sleepResult.slice(0, 300))
tally.check('the main agent read the operator\'s message and answered it', heard !== undefined && notYet === undefined, heard === undefined ? `no reply carrying "${HEARD}"${notYet !== undefined ? ' — the model answered without the message' : ''}` : '')
tally.check(`the answer landed after the chord and well inside the ${SLEEP_SECONDS}s the sleep asked for`, heard !== undefined && heard.atMs >= chordAtMs && heard.atMs - chordAtMs < 8_000, `chord ${seconds(chordAtMs)} · main spoke ${seconds(heard?.atMs)}`)
tally.check('the operator\'s words reached the model as the queued line of the same turn', afterSleep !== undefined && afterSleep.allTexts.some(text => text.includes(MESSAGE)), afterSleep === undefined ? 'no second request of the main turn' : afterSleep.ask.slice(0, 120))

tally.section('the seam, structural')
{
  const sleepTool = readFileSync(join(ROOT, 'src/tools/SleepTool/SleepTool.tsx'), 'utf8')
  const watch = readFileSync(join(ROOT, 'src/utils/newInputWatch.ts'), 'utf8')
  tally.check('the Sleep tool\'s one early-return road for new input is the queue watch, which re-reads on every queue commit', sleepTool.includes('stopWatch = watchForNewInput(agentId, onNewInput)') && watch.includes('const stop = subscribeToCommandQueue(() => {') && watch.includes(`export const NEW_INPUT_REASON = '${NEW_INPUT_REASON}'`))
}

if (tally.failed() === 0) rmSync(runHome, { recursive: true, force: true })
else console.log(`  world kept: ${runHome}\n  stderr tail: ${stderr.slice(-800)}`)
tally.finish()
