#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'fleet-tokens-home-'))

await import('../../src/tasks.js')
const { registerWorkflowTask, updateWorkflowProgressBatch } = await import('../../src/tasks/LocalWorkflowTask/LocalWorkflowTask.js')
const { buildAgentSummaries } = await import('../../src/tools/WorkflowTool/runManifest.js')
const { makeWorkflowHooks } = await import('../../src/tools/WorkflowTool/agentHooks.js')
const { usageSpeaks, workflowUsageSpend } = await import('../../src/tools/WorkflowTool/workflowUsage.js')

import type { LocalWorkflowTaskState, WorkflowProgressEvent } from '../../src/tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import type { WorkflowRunAgentSummary } from '../../src/tools/WorkflowTool/runManifest.js'
import type { WorkflowUsageRollup } from '../../src/tools/WorkflowTool/workflowUsage.js'

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — the fleet tokens proof exceeded 60s')
  process.exit(1)
}, 60_000)
guard.unref?.()

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

type Shape = 'anthropic' | 'openai'
type Resp = { input: number; cacheRead: number; cacheWrite: number; output: number; stop: 'end_turn' | 'tool_use' }
type AgentSpec = { name: string; shape: Shape; responses: Resp[] }
const fresh = (r: Resp): number => r.input + r.output
const freshOf = (rs: Resp[]): number => rs.reduce((n, r) => n + fresh(r), 0)

const OPUS_ONE: Resp[] = [
  { input: 1000, cacheRead: 4000, cacheWrite: 500, output: 200, stop: 'tool_use' },
  { input: 300, cacheRead: 5500, cacheWrite: 0, output: 700, stop: 'end_turn' },
]
const OPUS_TWO: Resp[] = [{ input: 2000, cacheRead: 0, cacheWrite: 8000, output: 100, stop: 'end_turn' }]
const SOL: Resp[] = [
  { input: 900, cacheRead: 3000, cacheWrite: 0, output: 400, stop: 'tool_use' },
  { input: 100, cacheRead: 3900, cacheWrite: 0, output: 600, stop: 'tool_use' },
  { input: 50, cacheRead: 4000, cacheWrite: 0, output: 250, stop: 'end_turn' },
]

type FakeArgs = {
  onQueryProgress?: (ev?: unknown) => void
  toolUseContext?: { abortController?: AbortController }
}
type Frame = Record<string, unknown> & { type?: string; index?: number; label?: string; state?: string; tokens?: number; usage?: unknown }
type Snapshot = { at: string; totalTokens: number; usage: WorkflowUsageRollup | undefined; rows: WorkflowRunAgentSummary[]; frame: Frame }

const rowFigure = (row: { tokens?: number; usage?: WorkflowUsageRollup }): number =>
  row.usage !== undefined && usageSpeaks(row.usage) ? workflowUsageSpend(row.usage) : (row.tokens ?? 0)

function runFleet(agents: AgentSpec[], title: string): {
  start: () => Promise<unknown>[]
  step: (gate: string, next?: string) => Promise<void>
  finish: (name: string) => Promise<void>
  read: (at: string) => Snapshot
  snapshots: Snapshot[]
} {
  const gates = new Map<string, { opened: Promise<void>; open: () => void; arrived: Promise<void>; arrive: () => void }>()
  const gate = (name: string) => {
    let g = gates.get(name)
    if (g === undefined) {
      let open = (): void => {}
      let arrive = (): void => {}
      const opened = new Promise<void>(r => { open = r })
      const arrived = new Promise<void>(r => { arrive = r })
      g = { opened, open, arrived, arrive }
      gates.set(name, g)
    }
    return g
  }
  const waitAt = async (name: string): Promise<void> => {
    const g = gate(name)
    g.arrive()
    await g.opened
  }

  const taskId = `wf-task-${title}`
  const store = { state: { tasks: {} as Record<string, unknown>, speculation: { status: 'idle' } } }
  const set = (fn: (prev: unknown) => unknown): void => {
    store.state = fn(store.state) as typeof store.state
  }
  registerWorkflowTask({ taskId, script: 'return 1', workflowRunId: `run-${title}`, setAppState: set as never })
  const task = (): LocalWorkflowTaskState => store.state.tasks[taskId] as LocalWorkflowTaskState
  const snapshots: Snapshot[] = []
  let frameCount = 0
  const read = (at: string): Snapshot => {
    const t = task()
    return { at, totalTokens: t.totalTokens, usage: t.usage, rows: buildAgentSummaries(t.workflowProgress), frame: {} }
  }

  let seq = 0
  const mint = (name: string, i: number, shape: Shape, r: Resp): { type: 'assistant'; message: Record<string, unknown> } => ({
    type: 'assistant',
    message: {
      id: `${name}-response-${i}`,
      model: 'fixture-model',
      role: 'assistant',
      type: 'message',
      stop_reason: null,
      stop_sequence: null,
      content:
        r.stop === 'tool_use'
          ? [{ type: 'tool_use', id: `tu-${name}-${i}-${++seq}`, name: 'Bash', input: {} }]
          : [{ type: 'text', text: `${name} reply ${i}` }],
      usage:
        shape === 'anthropic'
          ? { input_tokens: r.input, cache_read_input_tokens: r.cacheRead, cache_creation_input_tokens: r.cacheWrite, output_tokens: 0 }
          : { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 },
    },
  })
  const settledUsage = (r: Resp) => ({
    input_tokens: r.input,
    cache_read_input_tokens: r.cacheRead,
    cache_creation_input_tokens: r.cacheWrite,
    output_tokens: r.output,
  })

  const fakes = new Map<string, AgentSpec>()
  for (const a of agents) fakes.set(a.name, a)
  const fakeSpawn = (args: FakeArgs & { prompt?: string }): AsyncGenerator<unknown, void> => {
    const spec = fakes.get(String(args.prompt))!
    return (async function* () {
      for (let i = 0; i < spec.responses.length; i++) {
        const r = spec.responses[i]!
        await waitAt(`${spec.name}:request-${i}`)
        args.onQueryProgress?.({ type: 'stream_request_start' })
        args.onQueryProgress?.({ type: 'request_wait', wait: { kind: 'first-byte', budgetMs: 60_000, sinceMs: Date.now() } })
        await waitAt(`${spec.name}:message-${i}`)
        const m = mint(spec.name, i, spec.shape, r)
        args.onQueryProgress?.(m)
        yield m
        await waitAt(`${spec.name}:settle-${i}`)
        m.message.usage = settledUsage(r)
        m.message.stop_reason = r.stop
        args.onQueryProgress?.({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: r.stop, stop_sequence: null }, usage: settledUsage(r) } })
        if (r.stop === 'tool_use') {
          await waitAt(`${spec.name}:tool-${i}`)
          const toolUseId = (m.message.content as Array<{ id: string }>)[0]!.id
          const u = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] } }
          args.onQueryProgress?.(u)
          yield u
        }
      }
      await waitAt(`${spec.name}:end`)
    })()
  }

  const hooks = makeWorkflowHooks({
    toolUseContext: {
      abortController: new AbortController(),
      getAppState: () => ({
        toolPermissionContext: { mode: 'default', additionalWorkingDirectories: new Map(), alwaysAllowRules: {}, alwaysDenyRules: {} },
        mcp: { tools: [] },
      }),
      options: { agentDefinitions: { activeAgents: [] }, mainLoopModel: 'claude-opus-5' },
    },
    canUseTool: async () => ({ behavior: 'allow' }),
    emitProgress: (f: unknown) => {
      const data = (f as { data?: Frame }).data
      if (!data) return
      updateWorkflowProgressBatch(taskId, [data as unknown as WorkflowProgressEvent], set as never)
      frameCount++
      const t = task()
      snapshots.push({ at: `frame ${frameCount} (agent ${String(data.index)} ${String(data.state)})`, totalTokens: t.totalTokens, usage: t.usage, rows: buildAgentSummaries(t.workflowProgress), frame: data })
    },
    workflowRunId: undefined,
    onAgentController: () => {},
    seedPhaseTitles: [],
    args: undefined,
    spawnSubagentStream: fakeSpawn as never,
  } as never) as { agent: (p: string, o?: Record<string, unknown>) => Promise<unknown> }

  const pending = new Map<string, Promise<unknown>>()
  return {
    snapshots,
    read,
    start: () => agents.map(a => {
      const p = hooks.agent(a.name, {})
      p.catch(() => undefined)
      pending.set(a.name, p)
      return p
    }),
    step: async (name, next) => {
      gate(name).open()
      if (next !== undefined) await gate(next).arrived
    },
    finish: async name => {
      gate(`${name}:end`).open()
      await pending.get(name)
    },
  }
}

type Marks = { atSolSettle0: Snapshot; underTest: Snapshot; atOpusOneSettle0: Snapshot; beforeWait: Snapshot; afterWait: Snapshot; final: Snapshot }

async function drive(shapes: Record<'opus-one' | 'opus-two' | 'sol', Shape>, title: string): Promise<{ marks: Marks; snapshots: Snapshot[] }> {
  const fleet = runFleet(
    [
      { name: 'opus-one', shape: shapes['opus-one'], responses: OPUS_ONE },
      { name: 'opus-two', shape: shapes['opus-two'], responses: OPUS_TWO },
      { name: 'sol', shape: shapes.sol, responses: SOL },
    ],
    title,
  )
  fleet.start()
  await Promise.all([fleet.step('opus-one:request-0', 'opus-one:message-0'), fleet.step('opus-two:request-0', 'opus-two:message-0'), fleet.step('sol:request-0', 'sol:message-0')])
  await fleet.step('sol:message-0', 'sol:settle-0')
  await fleet.step('sol:settle-0', 'sol:tool-0')
  const atSolSettle0 = fleet.read('after the sol first response settled (its usage written back, the message_delta mark seen)')
  await fleet.step('sol:tool-0', 'sol:request-1')
  await fleet.step('sol:request-1', 'sol:message-1')
  await fleet.step('sol:message-1', 'sol:settle-1')
  await fleet.step('sol:settle-1', 'sol:tool-1')
  await fleet.step('sol:tool-1', 'sol:request-2')
  await fleet.step('sol:request-2', 'sol:message-2')
  const underTest = fleet.read('the frame under test: sol has two settled responses and a third in flight; both opus agents are still inside their first response')
  await fleet.step('opus-one:message-0', 'opus-one:settle-0')
  await fleet.step('opus-one:settle-0', 'opus-one:tool-0')
  const atOpusOneSettle0 = fleet.read('after the opus-one first response settled')
  await fleet.step('opus-one:tool-0', 'opus-one:request-1')
  const beforeWait = fleet.read('before the opus-one second request opened')
  await fleet.step('opus-one:request-1', 'opus-one:message-1')
  const afterWait = fleet.read('after the opus-one second request opened (its first-byte wait frame landed)')
  await fleet.step('opus-one:message-1', 'opus-one:settle-1')
  await fleet.step('opus-one:settle-1', 'opus-one:end')
  await fleet.finish('opus-one')
  await fleet.step('opus-two:message-0', 'opus-two:settle-0')
  await fleet.step('opus-two:settle-0', 'opus-two:end')
  await fleet.finish('opus-two')
  await fleet.step('sol:message-2', 'sol:settle-2')
  await fleet.step('sol:settle-2', 'sol:end')
  await fleet.finish('sol')
  const final = fleet.read('every agent landed')
  return { marks: { atSolSettle0, underTest, atOpusOneSettle0, beforeWait, afterWait, final }, snapshots: fleet.snapshots }
}

const rowOf = (s: Snapshot, name: string): WorkflowRunAgentSummary | undefined => s.rows.find(r => r.label === name)
const figures = (s: Snapshot): string => `Tok ${s.totalTokens} · rows ${s.rows.map(r => `#${r.index}:${rowFigure(r)}/${String(r.tokens)}`).join(' ')} · usage ${s.usage === undefined ? 'none' : JSON.stringify(s.usage)}`

console.log('============================================================')
console.log(' fleet tokens — one number: fresh input + output, additive, live')
console.log('============================================================')
console.log('  three agents through the real hooks and the real reducer: two Anthropic-shaped (usage at arrival carries the input')
console.log('  and the cached prefix, the output writes back at the end) and one OpenAI-shaped (all-zero usage at arrival, the')
console.log('  whole record writes back at the end); both roads mark the settle with stop_reason beside the final usage, then')
console.log('  yield the message_delta stream event that reaches the hooks through onQueryProgress')

const driven = async (shapes: Record<'opus-one' | 'opus-two' | 'sol', Shape>, title: string): Promise<{ marks: Marks; snapshots: Snapshot[] }> => {
  try {
    return await drive(shapes, title)
  } catch (e) {
    console.log(`\n❌ the ${title} fleet threw before its checks: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
    process.exit(1)
  }
}

const mixed = await driven({ 'opus-one': 'anthropic', 'opus-two': 'anthropic', sol: 'openai' }, 'mixed')

section('§A the run figure is the sum of the agent rows at EVERY frame (the context sum used to hold this by accident; the figure the agent lane paints did not)')
{
  let bad = mixed.snapshots.find(s => s.totalTokens !== s.rows.reduce((n, r) => n + rowFigure(r), 0))
  check(`the run Tok equals the sum of the figures the agent lanes paint, at all ${mixed.snapshots.length} frames`, bad === undefined, bad === undefined ? '' : `${bad.at}: ${figures(bad)}`)
  bad = mixed.snapshots.find(s => s.usage !== undefined && s.totalTokens !== workflowUsageSpend(s.usage))
  check('the run Tok equals the spend of the run rollup (the header and the run detail pane agree) at every frame', bad === undefined, bad === undefined ? '' : `${bad.at}: ${figures(bad)}`)
}

section("§B each agent's row is fresh input + output of its SETTLED responses — the cache fields do not enter, the newest response's prompt size does not enter (the row used to be the newest response's context, cache read inside)")
{
  const f = mixed.marks.final
  const expect = (name: string, word: string, rs: Resp[]): void => {
    const row = rowOf(f, name)
    const u = row?.usage
    check(`${word}: the row figure is ${freshOf(rs)} (fresh in ${rs.reduce((n, r) => n + r.input, 0)} + out ${rs.reduce((n, r) => n + r.output, 0)})`, row?.tokens === freshOf(rs) && rowFigure(row!) === freshOf(rs), row === undefined ? 'no row' : `tokens ${String(row.tokens)} · painted ${rowFigure(row)}`)
    check(`${word}: the row record keeps the halves apart (in ${rs.reduce((n, r) => n + r.input, 0)} · out ${rs.reduce((n, r) => n + r.output, 0)} · cache read ${rs.reduce((n, r) => n + r.cacheRead, 0)} · cache write ${rs.reduce((n, r) => n + r.cacheWrite, 0)} · ${rs.length} turns)`, !!u && u.inputTokens === rs.reduce((n, r) => n + r.input, 0) && u.outputTokens === rs.reduce((n, r) => n + r.output, 0) && u.cacheReadTokens === rs.reduce((n, r) => n + r.cacheRead, 0) && u.cacheCreationTokens === rs.reduce((n, r) => n + r.cacheWrite, 0) && u.apiTurns === rs.length && u.unsettledTurns === 0, JSON.stringify(u))
  }
  expect('opus-one', 'opus-one (Anthropic-shaped)', OPUS_ONE)
  expect('opus-two', 'opus-two (Anthropic-shaped)', OPUS_TWO)
  expect('sol', 'sol (OpenAI-shaped)', SOL)
  const total = freshOf(OPUS_ONE) + freshOf(OPUS_TWO) + freshOf(SOL)
  check(`the landed run's Tok is ${total}, the three rows added`, f.totalTokens === total, figures(f))
  check('the cached prefix of every response stays outside the run Tok', f.totalTokens < [...OPUS_ONE, ...OPUS_TWO, ...SOL].reduce((n, r) => n + r.input + r.cacheRead + r.cacheWrite + r.output, 0))
}

section('§C while agents still run and a response has settled anywhere, the run paints a figure, never the dash (the OpenAI-shaped agent used to add 0 until it landed, and the Anthropic-shaped ones had yielded nothing)')
{
  const t = mixed.marks.underTest
  check(`the run Tok is > 0 at the frame under test (${t.totalTokens})`, t.totalTokens > 0, figures(t))
  check(`the run Tok at that frame is the settled fresh sum of sol's two landed responses (${freshOf(SOL.slice(0, 2))}); the in-flight third and the opus agents' open first responses add nothing`, t.totalTokens === freshOf(SOL.slice(0, 2)), figures(t))
  const sol = rowOf(t, 'sol')
  check('§D the OpenAI-shaped agent contributes its settled responses BEFORE it lands', sol !== undefined && (sol.state === 'progress' || sol.state === 'start') && rowFigure(sol) === freshOf(SOL.slice(0, 2)), sol === undefined ? 'no row' : `state ${sol.state} · painted ${rowFigure(sol)} · tokens ${String(sol.tokens)}`)
  const s0 = mixed.marks.atSolSettle0
  check(`§D the figure moves AT the settle mark (the message_delta event), not at the next message: right after sol's first response settled the run Tok is ${fresh(SOL[0]!)}`, s0.totalTokens === fresh(SOL[0]!) && rowFigure(rowOf(s0, 'sol')!) === fresh(SOL[0]!), figures(s0))
  const o0 = mixed.marks.atOpusOneSettle0
  check(`§D the same on the Anthropic shape: right after opus-one's first response settled its row is ${fresh(OPUS_ONE[0]!)}, the run Tok ${fresh(OPUS_ONE[0]!) + freshOf(SOL.slice(0, 2))}`, rowFigure(rowOf(o0, 'opus-one')!) === fresh(OPUS_ONE[0]!) && o0.totalTokens === fresh(OPUS_ONE[0]!) + freshOf(SOL.slice(0, 2)), figures(o0))
}

section("§E a landed agent's row is its final settled sum: no jump at the settle (the last progress frame used to carry the newest response's arrival-time size, the done frame its settled size)")
{
  for (const [name, rs] of [['opus-one', OPUS_ONE], ['opus-two', OPUS_TWO], ['sol', SOL]] as const) {
    const lastProgress = [...mixed.snapshots].reverse().find(s => s.frame.label === name && s.frame.state === 'progress')
    const done = mixed.snapshots.find(s => s.frame.label === name && s.frame.state === 'done')
    const before = lastProgress === undefined ? undefined : rowFigure(rowOf(lastProgress, name)!)
    const after = done === undefined ? undefined : rowFigure(rowOf(done, name)!)
    check(`${name}: the last progress figure (${String(before)}) equals the done figure (${String(after)}) equals the settled sum (${freshOf(rs)})`, before === after && after === freshOf(rs), `${lastProgress?.at ?? '?'} → ${done?.at ?? '?'}`)
  }
}

section("§G a frame that carries a wait keeps the agent's figure (the first-byte wait frame used to replace the row with no tokens, and the run Tok dropped)")
{
  const b = mixed.marks.beforeWait
  const a = mixed.marks.afterWait
  check(`the run Tok before the wait (${b.totalTokens}) is the settled sum so far (${fresh(OPUS_ONE[0]!) + freshOf(SOL.slice(0, 2))})`, b.totalTokens === fresh(OPUS_ONE[0]!) + freshOf(SOL.slice(0, 2)), figures(b))
  check(`the run Tok after the wait frame is unchanged (${a.totalTokens})`, a.totalTokens === b.totalTokens && a.totalTokens > 0, figures(a))
  const row = rowOf(a, 'opus-one')
  check('the waiting agent row still carries its figure and its record', row !== undefined && row.waiting === 'prefill' && rowFigure(row) === fresh(OPUS_ONE[0]!) && row.tokens === fresh(OPUS_ONE[0]!), row === undefined ? 'no row' : `waiting ${String(row.waiting)} · tokens ${String(row.tokens)} · painted ${rowFigure(row)}`)
}

section('§F a mixed run behaves as a single-family run: the same responses give the same Tok at every frame whatever the dialect wrote at yield time (the all-OpenAI run used to read 0 where the all-Anthropic run read the context)')
{
  const anthropic = await driven({ 'opus-one': 'anthropic', 'opus-two': 'anthropic', sol: 'anthropic' }, 'anthropic')
  const openai = await driven({ 'opus-one': 'openai', 'opus-two': 'openai', sol: 'openai' }, 'openai')
  const trail = (r: { snapshots: Snapshot[] }): string => r.snapshots.map(s => s.totalTokens).join(',')
  check('the three runs emit the same number of frames', mixed.snapshots.length === anthropic.snapshots.length && anthropic.snapshots.length === openai.snapshots.length, `${mixed.snapshots.length} / ${anthropic.snapshots.length} / ${openai.snapshots.length}`)
  check('the mixed run and the all-Anthropic run paint the same Tok at every frame', trail(mixed) === trail(anthropic), `mixed ${trail(mixed)}\n      anthropic ${trail(anthropic)}`)
  check('the mixed run and the all-OpenAI run paint the same Tok at every frame', trail(mixed) === trail(openai), `mixed ${trail(mixed)}\n      openai ${trail(openai)}`)
  check('the all-OpenAI run paints a figure at the frame under test', openai.marks.underTest.totalTokens === mixed.marks.underTest.totalTokens && openai.marks.underTest.totalTokens > 0, figures(openai.marks.underTest))
  check('all three land on the same run Tok', mixed.marks.final.totalTokens === anthropic.marks.final.totalTokens && anthropic.marks.final.totalTokens === openai.marks.final.totalTokens, `${mixed.marks.final.totalTokens} / ${anthropic.marks.final.totalTokens} / ${openai.marks.final.totalTokens}`)
}

section('§H the board line, as text, for the record')
{
  const fmt = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
  const t = mixed.marks.underTest
  const done = t.rows.filter(r => r.state === 'done').length
  console.log(`  under test: Ag ${done}/${t.rows.length} · Tok ${t.totalTokens > 0 ? fmt(t.totalTokens) : '—'}`)
  for (const r of t.rows) console.log(`    #${r.index} ${r.label} · ${r.state} · ${rowFigure(r) > 0 ? `${fmt(rowFigure(r))} spent` : '—'}`)
  const f = mixed.marks.final
  console.log(`  landed: Ag ${f.rows.filter(r => r.state === 'done').length}/${f.rows.length} · Tok ${fmt(f.totalTokens)}`)
  for (const r of f.rows) console.log(`    #${r.index} ${r.label} · ${r.state} · ${fmt(rowFigure(r))} spent (${fmt(r.usage?.inputTokens ?? 0)} in / ${fmt(r.usage?.outputTokens ?? 0)} out)`)
}

rmSync(process.env.MERCURY_CONFIG_DIR!, { recursive: true, force: true })
clearTimeout(guard)
console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ ${failures} FLEET-TOKENS PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL FLEET-TOKENS PROOFS PASS')
process.exit(0)
