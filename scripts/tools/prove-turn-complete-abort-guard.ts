#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const root = join(import.meta.dir, '..', '..')
const t = await import('../core-runtime/turnScenarios.ts')
const engine = readFileSync(join(root, 'src', 'rows', 'turn.ts'), 'utf-8')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { statusOfTerminal, OUTCOME_STATUSES } = await import('../../src/rows/vocabulary.ts')
const { createUserInterruptionMessage } = await import('../../src/utils/messages/factories.js')
const { turnCutLine, turnCutOf, turnCutResultText } = await import('../../src/utils/messages/rejectionText.js')
const driver = readFileSync(join(root, 'src', 'cli', 'headless', 'turnDriver.ts'), 'utf-8')

console.log('============================================================')
console.log(' cancelled turns never settle as phantom completions (HB-0096, runner-homed)')
console.log('============================================================')

const f = t.fixtures
type Run = Awaited<ReturnType<typeof t.runScripted>>
type Phase = 'stream' | 'tools'
type Abort = { phase: Phase; reason: unknown; run: Run | null; threw: string }
type Seen = Run['events'][number]
const REASONS: unknown[] = [undefined, 'interrupt', 'crew-stop', 'a foreign reason', new Error('cut detail'), { code: 'DEADLINE_EXCEEDED' }]
const say = (reason: unknown): string => (reason === undefined ? 'no reason given' : reason instanceof Error ? `Error(${reason.message})` : JSON.stringify(reason))
async function abortIn(phase: Phase, reason: unknown): Promise<Abort> {
  const plan =
    phase === 'stream'
      ? {
          tools: [{ name: 'Bash' }],
          script: [[...f.yields(f.calls('toolu_one', 'Bash', { command: 'sleep 30' }), f.calls('toolu_two', 'Bash', { command: 'sleep 60' })), { kind: 'do' as const, fn: (env: { rig: { abortController: AbortController } }) => env.rig.abortController.abort(reason) }]],
        }
      : {
          tools: [{ name: 'SlowTool', result: 'finished during the abort', onCall: (rig: { abortController: AbortController }) => rig.abortController.abort(reason) }],
          script: [f.yields(f.calls('toolu_running', 'SlowTool', {}))],
        }
  try {
    return { phase, reason, run: await t.runScripted(plan), threw: '' }
  } catch (error) {
    return { phase, reason, run: null, threw: String(error) }
  }
}
const aborts: Abort[] = []
for (const phase of ['stream', 'tools'] as const) for (const reason of REASONS) aborts.push(await abortIn(phase, reason))
const ended = (c: Abort): string => (c.run === null ? `threw ${c.threw}` : `${String(c.run.terminal.reason)}${c.run.events.at(-1)?.kind === 'run_terminal' ? '' : ' with no run_terminal event'}`)
const terminalOf = (phase: Phase): string => (phase === 'stream' ? 'aborted_streaming' : 'aborted_tools')
const stepOf = (phase: Phase): string => (phase === 'stream' ? 'modelReply (src/run-core/turn/modelReply.ts)' : 'afterTools (src/run-core/turn/afterTools.ts)')
const told = (bad: Abort[], read: (c: Abort) => string): string => bad.map(c => `${c.phase} abort, ${say(c.reason)}: ${read(c)}`).join(' · ')
const operatorAbort = (phase: Phase): Abort => aborts.find(c => c.phase === phase && c.reason === undefined)!
const textOf = (event: Seen | undefined): string => {
  const content = (event?.message as { message?: { content?: Array<{ type?: string; text?: string; content?: unknown }> } } | null | undefined)?.message?.content
  const block = Array.isArray(content) && content.length === 1 ? content[0] : undefined
  return block === undefined ? 'no single block' : block.type === 'text' ? String(block.text) : String(block.content)
}
const lineRead = (c: Abort): string => {
  const found = (c.run?.events ?? []).filter(event => event.kind === 'interruption')
  const event = found[0]
  return found.length !== 1 || event === undefined ? `${found.length} interruption events` : `${String(event.phase)} steer=${String(event.steer)} ${event.message === null ? 'no line' : textOf(event)}`
}
const lineOwed = (c: Abort): string => `${c.phase} steer=${String(c.reason === 'interrupt')} ${c.reason === 'interrupt' ? 'no line' : turnCutLine(turnCutOf(c.reason), c.phase === 'tools')}`
const settledRead = (c: Abort): string => {
  const events = c.run?.events ?? []
  const at = events.findIndex(event => event.kind === 'interruption')
  const before = events.slice(0, Math.max(at, 0)).filter(event => event.kind === 'tool_settled')
  return `${before.map(event => `${String(event.toolUseId)} ${String(event.outcome)} synthetic=${String(event.synthetic)}: ${textOf(event)}`).join(' | ')}${events.some(event => event.kind === 'tool_started') ? ' | a tool ran' : ''}`
}
const settledOwed = (c: Abort): string => ['toolu_one', 'toolu_two'].map(id => `${id} aborted synthetic=true: ${turnCutResultText(turnCutOf(c.reason))}`).join(' | ')

section('A. reachability: the turn machine RETURNS clean typed terminals on cancel')
for (const phase of ['stream', 'tools'] as const) {
  const held = ended(operatorAbort(phase)) === terminalOf(phase)
  check(
    `abort during ${phase === 'stream' ? 'streaming' : 'tools'} returns the ${terminalOf(phase)} terminal (no throw)`,
    held,
    held ? '' : `${stepOf(phase)} must end the run by returning { reason: '${terminalOf(phase)}' }; the run ${ended(operatorAbort(phase))}`,
  )
}
{
  const bad = aborts.filter(c => ended(c) !== terminalOf(c.phase))
  check(
    `no abort branch throws: each of ${aborts.length} aborts, in the stream and in the tools, with no reason, a steer, a crew stop, a foreign word, an Error and a deadline, returns its aborted terminal`,
    bad.length === 0,
    bad.length === 0 ? '' : `an abort must leave the run through its returned terminal, in modelReply for the stream and afterTools for the tools, never through a throw — ${told(bad, ended)}`,
  )
}

section('B. the discriminator: the interruption line forces an honest settlement')
for (const phase of ['stream', 'tools'] as const) {
  const bad = aborts.filter(c => c.phase === phase && lineRead(c) !== lineOwed(c))
  check(
    `the ${phase === 'stream' ? 'streaming' : 'tools'} abort branch appends the ${phase === 'stream' ? 'user' : 'tool-use'} interruption line (steer excepted)`,
    bad.length === 0,
    bad.length === 0 ? '' : `${stepOf(phase)} must yield one interruption event of phase '${phase}' carrying createUserInterruptionMessage({ toolUse: ${phase === 'tools'}, reason }), and null with steer on 'interrupt' — ${told(bad, c => `read [${lineRead(c)}] owed [${lineOwed(c)}]`)}`,
  )
}
{
  const bad = aborts.filter(c => c.phase === 'stream' && settledRead(c) !== settledOwed(c))
  check(
    'the streaming abort branch settles every announced tool_use synthetically first, in the typed cut\'s words',
    bad.length === 0,
    bad.length === 0 ? '' : `modelReply (src/run-core/turn/modelReply.ts) must settle each tool_use the cut reply announced as aborted with turnCutResultText(turnCutOf(reason)) before the interruption event, and start none — ${told(bad, c => `read [${settledRead(c)}] owed [${settledOwed(c)}]`)}`,
  )
}
check(
  'the interruption line is TEXT content (the transcript says the turn was cut)',
  [false, true].every(toolUse => [undefined, 'crew-stop', 'a foreign reason', new Error('cut detail')].every(reason => {
    const content = createUserInterruptionMessage({ toolUse, reason }).message.content
    return Array.isArray(content) && content.length === 1 && content[0]?.type === 'text' && content[0].text === turnCutLine(turnCutOf(reason), toolUse)
  })),
)
const { loadTs, parseSource, resolveStructureTypescript } = await import('../../src/services/structure/tsFacility.ts')
const resolved = resolveStructureTypescript(root)
if (resolved.state !== 'ok') throw new Error(resolved.note)
const ts = loadTs(resolved.modulePath)
const parsed = parseSource(ts, 'turn.ts', engine)
let completedIsInsideGate = false
const visit = (node: import('typescript').Node): void => {
  if (ts.isIfStatement(node) && node.expression.getText(parsed.sourceFile).replace(/\s/g, '') === "settled.status==='completed'") {
    completedIsInsideGate = node.thenStatement.getText(parsed.sourceFile).includes("yield* endTurn('completed'")
  }
  ts.forEachChild(node, visit)
}
visit(parsed.sourceFile)
const cuts = [null, 'operator', 'idle-timeout', 'parent-stop', 'cut'] as const
check(
  'statusOfTerminal never reads an aborted terminal as completed, whatever the cut',
  (['aborted_streaming', 'aborted_tools'] as const).every(reason => cuts.every(cut => { const s = statusOfTerminal({ reason } as never, cut as never).status; return (OUTCOME_STATUSES as readonly string[]).includes(s) && s !== 'completed' })),
)
check(
  'the settlement reads the status off the terminal and the cut, then gates the completed yield on it',
  /const aborted = terminal\.reason === 'aborted_streaming' \|\| terminal\.reason === 'aborted_tools'\s*const cut = aborted \? turnCutOf\(this\.abortController\.signal\.reason\)\.kind : null/.test(engine) &&
    /const settled = endedOnApiError \? \{ status: 'failed' as const, errorClass: 'model' as const \} : statusOfTerminal\(terminal, cut\)\s*if \(settled\.status === 'completed'\) \{/.test(engine) && parsed.parseErrors.length === 0 && completedIsInsideGate,
)
check(
  'the completed outcomes are the closed two (local command · the gated settlement)',
  (engine.match(/endTurn\((?:refused \? 'refused' : )?'completed'/g) ?? []).length === 2,
)
check(
  'the turn settlement’s completed yield is the LAST outcome of its kind, past the gate',
  engine.lastIndexOf("endTurn('completed'") > engine.indexOf('const settled ='),
)

section('C. the settle tail: exactly once per turn, after the turn, one call site')
check(
  "runOneTurn settles in order: executeTurn → lifecycle 'completed' → onTurnSettled",
  /await ports\.executeTurn\(command, batch\.length > 1 \? batch : \[\], message => \{[\s\S]{0,1500}?\}\)\s*for \(const uuid of batchUuids\) \{\s*ports\.notifyLifecycle\(uuid, 'completed'\)\s*\}[\s\S]{0,300}?ports\.onTurnSettled\(command\)/.test(driver),
)
check(
  'onTurnSettled has exactly one call site in the driver',
  (driver.match(/ports\.onTurnSettled\(/g) ?? []).length === 1,
)
check(
  'the error band (a failed outcome + shutdown) is reserved for a THROWN cycle — the clean abort return never reaches it',
  /catch \(error\) \{[\s\S]{0,400}?await ports\.writeDirect\(ports\.onCycleError\(error, ports\.turnIdOf\(\)\)\)[\s\S]{0,200}?ports\.shutdown\(1\)/.test(driver),
)

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ HB-0096 — cancelled turns settle honestly at the runner (law re-homed)')
  process.exit(0)
} else {
  console.log(` ❌ HB-0096 — ${failures} check(s) failed`)
  process.exit(1)
}
