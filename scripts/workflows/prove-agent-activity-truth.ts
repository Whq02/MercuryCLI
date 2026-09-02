#!/usr/bin/env bun
// ============================================================================
//  scripts/workflows/prove-agent-activity-truth.ts
//  PROOF (workflow-hardening defect 1): the /workflows inspector's activity
//  readout is TRUE for every provider dialect.
//
//  The operator's live evening: a mixed workflow's GPT agent
//  showed "0 of 45 tool calls this attempt" + "no reasoning captured — still
//  working" for 16+ minutes — and then FINISHED. The inspector reads two
//  sources: the live frame counter (agentHooks' stream loop) and the
//  persisted agent transcript (agent-<agentId>.jsonl via
//  agentTranscriptReader). "0 of 45" = transcript says 0 while frames said
//  45 — a writer/reader truth gap, dialect-shaped.
//
//  This prover drives the REAL stack — WorkflowTool.call → makeWorkflowHooks
//  → adapterSpawnStream → runAgent → query → provider router — against the
//  three-dialect loopback fixture (scripts/lib/workflowAgentFixture.ts): one
//  workflow, three agents (anthropic default · glm-* chat-completions ·
//  gpt-* Responses), each making ONE real Bash tool call (echo) and, on the
//  two OpenAI-family wires, streaming the dialect's reasoning shape. Then it
//  reads each agent's persisted transcript with the REAL reader and asserts:
//
//    §1 the run completes; every agent frame settled 'done'
//    §2 per dialect: the transcript's toolCallsTotal EQUALS the frame
//       counter (and both ≥ 1) — the lying-counter class, pinned
//    §3 reasoning: captured where the wire streamed it (chat + responses),
//       honest-empty on the anthropic seat (thinking disabled)
//    §4 the final text lands (outcome section truth)
//
//  Run:  ~/.bun/bin/bun run scripts/workflows/prove-agent-activity-truth.ts
// ============================================================================
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  startWorkflowAgentFixture,
  WF_FIXTURE_DONE,
} from '../lib/workflowAgentFixture.ts'

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — activity-truth prover exceeded 150s')
  process.exit(1)
}, 150_000)
guard.unref?.()

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const REPO = join(new URL('.', import.meta.url).pathname, '../..')
const BUN = process.env.BUN ?? join(homedir(), '.bun/bin/bun')
const scratch = mkdtempSync(join(tmpdir(), 'wf-activity-'))

console.log('============================================================')
console.log(' Workflow agent activity truth — counter + reasoning per dialect')
console.log('============================================================')

const fixture = await startWorkflowAgentFixture({
  port: 34901,
  reasoning: { chat: true, responses: true },
})

// ── the child: real WorkflowTool.call over the fixture wires ────────────────
const CHILD = String.raw`
;(globalThis as any).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
delete process.env.NODE_ENV
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'wf-activity-home-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
await import('${REPO}/src/tasks.js')
const { enableConfigs } = await import('${REPO}/src/utils/config/globalConfig.js')
enableConfigs()
const { WorkflowTool } = await import('${REPO}/src/tools/WorkflowTool/WorkflowTool.js')
const { getDefaultAppState } = await import('${REPO}/src/state/AppStateStore.js')
const { readAgentTranscript, resolveAgentTranscriptFile } = await import('${REPO}/src/tools/WorkflowTool/agentTranscriptReader.js')
const { decodeTranscriptBuffer } = await import('${REPO}/src/fabric/transcriptDecode.js')
const emit = (o: unknown) => console.log('@@' + JSON.stringify(o))

let state: any = getDefaultAppState()
const setAppState = (fn: any) => { state = typeof fn === 'function' ? fn(state) : fn }
const ctx: any = {
  getAppState: () => state,
  setAppState,
  setAppStateForTasks: setAppState,
  options: {
    mainLoopModel: 'claude-opus-4-8',
    mcpClients: [],
    mcpResources: {},
    tools: [],
    commands: [],
    debug: false,
    verbose: false,
    isNonInteractiveSession: false,
    agentDefinitions: { activeAgents: [], allAgents: [] },
  },
  abortController: new AbortController(),
  toolUseId: 'activity-truth-tool-use',
  readFileState: { readFileState: new Map(), clear: () => {} },
}

const script = [
  "export const meta = { name: 'activity-truth', description: 'per-dialect activity truth', phases: [{ title: 'Legs' }] }",
  "phase('Legs')",
  "const a = await agent('anthropic leg: run the echo command you are told to run, then reply done', {})",
  "const b = await agent('chat leg: run the echo command you are told to run, then reply done', { model: 'glm-5.3' })",
  "const c = await agent('responses leg: run the echo command you are told to run, then reply done', { model: 'gpt-5.5' })",
  "return { a, b, c }",
].join('\n')

try {
  const res = await WorkflowTool.call(
    { script },
    ctx,
    async () => ({ behavior: 'allow' }),
  )
  const d: any = (res as any).data
  emit({ ev: 'launched', runId: d.runId, runDir: d.transcriptDir, error: d.error })
  const runDir = d.transcriptDir
  const deadline = Date.now() + 90_000
  let task: any
  for (;;) {
    task = Object.values(state.tasks ?? {}).find((t: any) => t.type === 'local_workflow')
    if (task && task.status !== 'running') break
    if (Date.now() > deadline) { emit({ ev: 'timeout', status: task?.status, progress: task?.workflowProgress?.slice(-6) }); process.exit(1) }
    await new Promise(r => setTimeout(r, 100))
  }
  const manifest = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'))
  const agents = (task.workflowProgress ?? []).filter((e: any) => e.type === 'workflow_agent')
  const legs: any[] = []
  for (const a of agents) {
    const file = resolveAgentTranscriptFile(
      [manifest.transcriptDir, ...(manifest.transcriptDirs ?? [])],
      a.agentId,
    )
    // The store flushes appends on a timer — give a just-settled agent's
    // tail a bounded beat to land before reading.
    if (file) {
      const flushDeadline = Date.now() + 5000
      while (Date.now() < flushDeadline) {
        if (existsSync(file)) {
          const v = await readAgentTranscript(file)
          if (v && v.toolCallsTotal >= 1 && v.finalText !== undefined) break
        }
        await new Promise(r => setTimeout(r, 150))
      }
    }
    const view = file && existsSync(file) ? await readAgentTranscript(file) : undefined
    const entryShapes = file && existsSync(file)
      ? decodeTranscriptBuffer(readFileSync(file, 'utf8')).entries.map((e: any) => {
          const c = e?.message?.content
          return {
            t: e.type,
            content: Array.isArray(c)
              ? c.map((b: any) => b?.type + (b?.type === 'text' ? '(' + String(b?.text ?? '').slice(0, 30) + ')' : ''))
              : typeof c === 'string'
                ? 'string(' + c.slice(0, 40) + ')'
                : typeof c,
          }
        })
      : []
    const rawHead = file && existsSync(file)
      ? readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).slice(0, 2).map((l: string) => l.slice(0, 300))
      : []
    legs.push({
      entryShapes,
      rawHead,
      index: a.index,
      state: a.state,
      model: a.model,
      frameToolCalls: a.toolCalls ?? 0,
      agentId: a.agentId,
      transcriptFile: file,
      transcriptExists: !!(file && existsSync(file)),
      readerToolCalls: view?.toolCallsTotal,
      readerReasoning: view?.reasoningTotal,
      readerUnreadableReasoning: view?.unreadableReasoningTotal,
      readerFinalText: view?.finalText?.slice(0, 80),
      entryCount: view?.entryCount,
      error: a.error,
    })
  }
  emit({ ev: 'settled', status: task.status, error: task.error, result: task.result, legs, logs: (task.logs ?? []).slice(-5) })
  process.exit(0)
} catch (e) {
  emit({ ev: 'threw', message: (e as Error).message, stack: String((e as Error).stack).slice(0, 600) })
  process.exit(1)
}
`
writeFileSync(join(scratch, 'child.ts'), CHILD)

section('drive: one workflow, three dialect legs (real stack, loopback wires)')
const child = spawn(BUN, ['run', join(scratch, 'child.ts')], {
  cwd: scratch,
  env: {
    ...process.env,
    ...fixture.env,
    MERCURY_DYNAMIC_WORKFLOWS: '1',
  },
})
const lines: Array<Record<string, unknown>> = []
let out = ''
let errTail = ''
child.stdout.on('data', (d: Buffer) => {
  out += d.toString()
})
child.stderr.on('data', (d: Buffer) => {
  errTail = (errTail + d.toString()).slice(-2000)
})
const status: number | null = await new Promise(resolve => {
  const killer = setTimeout(() => child.kill('SIGKILL'), 120_000)
  child.on('close', s => {
    clearTimeout(killer)
    resolve(s)
  })
})
if (process.env.WF_ACTIVITY_DEBUG_OUT) {
  writeFileSync(process.env.WF_ACTIVITY_DEBUG_OUT, out)
}
for (const line of out.split('\n')) {
  if (line.startsWith('@@')) {
    try {
      lines.push(JSON.parse(line.slice(2)))
    } catch {
      /* torn line */
    }
  }
}
const launched = lines.find(l => l.ev === 'launched')
const settled = lines.find(l => l.ev === 'settled') as
  | { status?: string; legs?: Array<Record<string, unknown>>; result?: unknown; logs?: string[] }
  | undefined

section('§1 the run completes; every agent settled done')
check('child exited 0', status === 0, `status ${status}; stderr tail: ${errTail.slice(-400)}; lines: ${JSON.stringify(lines).slice(0, 600)}`)
check('workflow launched', !!launched, out.slice(0, 300))
check('workflow completed', settled?.status === 'completed', JSON.stringify(settled).slice(0, 600))
const legs = settled?.legs ?? []
check('three agent legs observed', legs.length === 3, `saw ${legs.length}`)
for (const leg of legs) {
  check(`leg #${leg.index} settled done`, leg.state === 'done', JSON.stringify(leg))
}

const legByModel = (needle: string): Record<string, unknown> | undefined =>
  legs.find(l => String(l.model ?? '').includes(needle))
const anthro = legs.find(l => !String(l.model ?? '').includes('glm') && !String(l.model ?? '').includes('gpt'))
const chat = legByModel('glm')
const responses = legByModel('gpt')

section('§2 counter truth per dialect: transcript count == frame count ≥ 1')
for (const [name, leg] of [
  ['anthropic', anthro],
  ['chat (glm-*)', chat],
  ['responses (gpt-*)', responses],
] as const) {
  check(`${name}: leg present`, !!leg, JSON.stringify(legs).slice(0, 400))
  if (!leg) continue
  check(`${name}: transcript file exists`, leg.transcriptExists === true, String(leg.transcriptFile))
  check(
    `${name}: frame counter saw the tool call (≥1)`,
    typeof leg.frameToolCalls === 'number' && (leg.frameToolCalls as number) >= 1,
    `frameToolCalls=${leg.frameToolCalls}`,
  )
  check(
    `${name}: transcript reader count EQUALS the frame count`,
    leg.readerToolCalls === leg.frameToolCalls,
    `reader=${leg.readerToolCalls} frames=${leg.frameToolCalls} entries=${leg.entryCount}`,
  )
}

section('§3 reasoning truth: captured where the wire streamed it')
if (chat) {
  check(
    'chat: reasoning captured (reasoning_content → thinking)',
    typeof chat.readerReasoning === 'number' && (chat.readerReasoning as number) >= 1,
    `reasoning=${chat.readerReasoning} unreadable=${chat.readerUnreadableReasoning}`,
  )
}
if (responses) {
  check(
    'responses: reasoning captured or counted unreadable (never silently absent)',
    (typeof responses.readerReasoning === 'number' && (responses.readerReasoning as number) >= 1) ||
      (typeof responses.readerUnreadableReasoning === 'number' && (responses.readerUnreadableReasoning as number) >= 1),
    `reasoning=${responses.readerReasoning} unreadable=${responses.readerUnreadableReasoning}`,
  )
}
if (anthro) {
  check(
    'anthropic: honest-empty reasoning (thinking disabled, none fabricated)',
    anthro.readerReasoning === 0 && anthro.readerUnreadableReasoning === 0,
    `reasoning=${anthro.readerReasoning} unreadable=${anthro.readerUnreadableReasoning}`,
  )
}

section('§4 outcome truth: the final text landed per dialect')
for (const [name, leg, done] of [
  ['anthropic', anthro, WF_FIXTURE_DONE('anthropic')],
  ['chat', chat, WF_FIXTURE_DONE('chat')],
  ['responses', responses, WF_FIXTURE_DONE('responses')],
] as const) {
  if (!leg) continue
  check(
    `${name}: transcript finalText carries the done marker`,
    String(leg.readerFinalText ?? '').includes(done),
    `finalText=${JSON.stringify(leg.readerFinalText)}`,
  )
}

await fixture.close()
rmSync(scratch, { recursive: true, force: true })
console.log(failures ? `\n❌ ACTIVITY-TRUTH RED (${failures} failing)` : '\n✅ ACTIVITY-TRUTH GREEN')
process.exit(failures ? 1 : 0)
