#!/usr/bin/env bun
// ============================================================================
//  scripts/workflows/prove-ask-liveness-and-deny.ts
//  PROOF (workflow-hardening defect 4, agent-side halves):
//
//  §A A PENDING PERMISSION ASK IS NOT A STALL. The runner's inactivity
//     watchdog counted an ask awaiting the operator as silence: at the
//     limit (default 15m — the operator's "16+ minutes") it killed the
//     asking agent, the consent card silently self-removed (abort-bound),
//     and the ladder re-asked — the flip-flopping "1 ask"/"running" chip.
//     Here the idle limit is squeezed to 3s and the ask HELD for 9s
//     (three limits); the fixed runner heartbeats the watchdog while the
//     ask pends, the answer arrives, and the agent finishes.
//
//  §B A DENY RETURNS TO THE AGENT AS A NORMAL TOOL RESULT — never a kill,
//     never a silent stall ("they should just try another tool"). The
//     first ask is denied with a reason; the wire shows the reject flowing
//     back as an is_error tool_result; the agent's NEXT tool call is
//     allowed and the agent completes.
//
//  Drives makeWorkflowHooks (real spawn adapter → runAgent → anthropic
//  loopback lane). Run:
//  ~/.bun/bin/bun run scripts/workflows/prove-ask-liveness-and-deny.ts
// ============================================================================
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — ask-liveness prover exceeded 120s')
  process.exit(1)
}, 120_000)
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
const scratch = mkdtempSync(join(tmpdir(), 'wf-ask-'))

console.log('============================================================')
console.log(' Workflow asks — pending ≠ stalled · deny = normal tool result')
console.log('============================================================')

// ── a purpose-built anthropic seat: two tool rounds, then final ─────────────
// Round law (content-routed, stateless): no denied-marker + no ack → tool A;
// a denied tool_result present → tool B; a SUCCESSFUL ack of tool B → final.
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const anthropicTurn = (blocks: string): string => {
  const open = `event: message_start\n${sse({ type: 'message_start', message: { id: `msg_ask_${Date.now() % 1e6}_${Math.floor(Math.random() * 1e4)}`, type: 'message', role: 'assistant', model: 'fixture-anthropic', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 9, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}`
  return open + blocks
}
const toolBlocks = (name: string, input: Record<string, unknown>): string =>
  `event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_ask_${Date.now() % 1e6}_${Math.floor(Math.random() * 1e4)}`, name, input: {} } })}` +
  `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } })}` +
  `event: content_block_stop\n${sse({ type: 'content_block_stop', index: 0 })}` +
  `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 7 } })}` +
  `event: message_stop\n${sse({ type: 'message_stop' })}`
const textBlocks = (text: string): string =>
  `event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}` +
  `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}` +
  `event: content_block_stop\n${sse({ type: 'content_block_stop', index: 0 })}` +
  `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } })}` +
  `event: message_stop\n${sse({ type: 'message_stop' })}`

type Hit = { deniedSeen: boolean; ackBSeen: boolean; isErrorSeen: boolean }
const hits: Array<Hit> = []
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    const raw = Buffer.concat(chunks).toString('utf8')
    if (req.method !== 'POST' || !path.endsWith('/v1/messages')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    const deniedSeen = raw.includes('fixture-denied')
    const ackBSeen = raw.includes('ask-route-b-output')
    const isErrorSeen = raw.includes('"is_error":true')
    hits.push({ deniedSeen, ackBSeen, isErrorSeen })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (ackBSeen) {
      res.end(anthropicTurn(textBlocks('ask-final-done.')))
    } else if (deniedSeen) {
      res.end(anthropicTurn(toolBlocks('Bash', { command: 'echo ask-route-b-output', description: 'route around the deny' })))
    } else {
      res.end(anthropicTurn(toolBlocks('Bash', { command: 'echo ask-route-a-output', description: 'the first attempt' })))
    }
  })
})
await new Promise<void>(resolve => server.listen(34906, '127.0.0.1', resolve))

const CHILD = String.raw`
;(globalThis as any).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
delete process.env.NODE_ENV
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'wf-ask-home-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_AGENT_IDLE_MINUTES = '0.05' // 3s — the squeezed idle limit
await import('${REPO}/src/tasks.js')
const { enableConfigs } = await import('${REPO}/src/utils/config/globalConfig.js')
enableConfigs()
const { makeWorkflowHooks } = await import('${REPO}/src/tools/WorkflowTool/agentHooks.js')
const { getDefaultAppState } = await import('${REPO}/src/state/AppStateStore.js')
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
  toolUseId: 'ask-tool-use',
  readFileState: { readFileState: new Map(), clear: () => {} },
}

let askNo = 0
const askLog: Array<{ ask: number; heldMs?: number; decision: string }> = []
const canUseTool = async (_tool: any, _input: any, _ctx: any, _msg: any, _id: string) => {
  askNo++
  const mine = askNo
  if (mine === 1) {
    // §A: hold the FIRST ask for 9s — three idle limits — then allow.
    const t0 = Date.now()
    await new Promise(r => setTimeout(r, 9000))
    askLog.push({ ask: mine, heldMs: Date.now() - t0, decision: 'allow-after-hold' })
    return { behavior: 'allow', updatedInput: _input }
  }
  if (mine === 2) {
    // §B: deny with a reason — must flow back as a normal tool result.
    askLog.push({ ask: mine, decision: 'deny' })
    return { behavior: 'deny', message: 'fixture-denied — try another tool' }
  }
  askLog.push({ ask: mine, decision: 'allow' })
  return { behavior: 'allow', updatedInput: _input }
}

const frames: any[] = []
const hooks: any = makeWorkflowHooks({
  toolUseContext: ctx,
  canUseTool,
  emitProgress: (f: any) => frames.push(f?.data),
  workflowRunId: 'ask-run',
} as any)

// ONE agent: ask 1 (held 9s) allows tool A; the SECOND tool call in the same
// turn round... — the fixture serves tool A first; after its allowed result
// the conversation carries no deny yet, so the next request would repeat
// tool A. To exercise the deny leg the SECOND ask (the re-served tool A) is
// denied; the reject flows back as a tool_result; the fixture then serves
// tool B; ask 3 allows it; the final text lands.
const t0 = Date.now()
const result = await hooks.agent('ask agent: run what you are told', {})
const elapsed = Date.now() - t0
const agentFrames = frames.filter((f: any) => f?.type === 'workflow_agent')
emit({
  ev: 'settled',
  result,
  elapsed,
  askLog,
  finalState: agentFrames.at(-1)?.state,
  attempts: Math.max(...agentFrames.map((f: any) => f?.attempt ?? 1)),
  toolCalls: agentFrames.at(-1)?.toolCalls,
  errorFrames: agentFrames.filter((f: any) => f.state === 'error').map((f: any) => f.error),
})
process.exit(0)
`
writeFileSync(join(scratch, 'child.ts'), CHILD)

const child = spawn(BUN, ['run', join(scratch, 'child.ts')], {
  cwd: scratch,
  env: {
    ...process.env,
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:34906',
    ANTHROPIC_API_KEY: 'fixture-key-000',
  },
})
let out = ''
let errTail = ''
child.stdout.on('data', (d: Buffer) => (out += d.toString()))
child.stderr.on('data', (d: Buffer) => (errTail = (errTail + d.toString()).slice(-1500)))
const status: number | null = await new Promise(resolve => {
  const killer = setTimeout(() => child.kill('SIGKILL'), 90_000)
  child.on('close', s => {
    clearTimeout(killer)
    resolve(s)
  })
})
const settled = out
  .split('\n')
  .filter(l => l.startsWith('@@'))
  .map(l => {
    try {
      return JSON.parse(l.slice(2)) as Record<string, unknown>
    } catch {
      return {}
    }
  })
  .find(l => l.ev === 'settled') as
  | {
      result?: unknown
      elapsed?: number
      askLog?: Array<{ ask: number; heldMs?: number; decision: string }>
      finalState?: string
      attempts?: number
      toolCalls?: number
      errorFrames?: string[]
    }
  | undefined

section('§A a pending ask is not a stall (3s idle limit, 9s held ask)')
check('child exited 0', status === 0, `status ${status}; stderr: ${errTail.slice(-400)}`)
check('the first ask really held ≥ 8.5s (three idle limits)', (settled?.askLog?.[0]?.heldMs ?? 0) >= 8_500, JSON.stringify(settled?.askLog))
check('agent settled done — never stall-cut mid-ask', settled?.finalState === 'done', JSON.stringify(settled).slice(0, 400))
check('ONE attempt — the ladder never re-asked', settled?.attempts === 1, `attempts=${settled?.attempts}`)
check('no error frames', (settled?.errorFrames ?? []).length === 0, JSON.stringify(settled?.errorFrames))

section('§B a deny flows back as a normal tool result; the agent routes around')
check('the deny was issued (ask 2)', settled?.askLog?.some(a => a.decision === 'deny') === true, JSON.stringify(settled?.askLog))
const postDeny = hits.find(h => h.deniedSeen)
check('the wire saw the deny as an is_error tool_result (conversation continued)', !!postDeny && postDeny.isErrorSeen, JSON.stringify(hits))
check('the agent then ran the OTHER tool and finished', settled?.result === 'ask-final-done.', JSON.stringify(settled?.result))
// Three EMITTED calls: A (allowed) · A again (denied — still a call the
// model made, honestly counted) · B (allowed). A counter that hid the
// denied call would under-report the agent's activity.
check('all three emitted tool calls counted (denied one included)', settled?.toolCalls === 3, `toolCalls=${settled?.toolCalls}`)

server.close()
rmSync(scratch, { recursive: true, force: true })
console.log(failures ? `\n❌ ASK-LIVENESS RED (${failures} failing)` : '\n✅ ASK-LIVENESS GREEN')
process.exit(failures ? 1 : 0)
