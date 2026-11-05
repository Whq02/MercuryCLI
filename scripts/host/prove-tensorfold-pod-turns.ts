import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const scratch = process.env.MERCURY_CONFIG_DIR
const root = resolve(import.meta.dir, '../..')
const at = process.argv.indexOf('--bundle')
const bundle = resolve(at < 0 ? join(root, 'dist/mercury.mjs') : process.argv[at + 1]!)
const node = /[\\/]bun(?:\.exe)?$/.test(process.execPath) ? Bun.which('node')! : process.execPath
let checks = 0
let failures = 0
const check = (name: string, truth: unknown, detail = ''): void => { checks++; if (!truth) failures++; console.log((truth ? 'PASS ' : 'FAIL ') + name + (!truth && detail ? ' — ' + detail : '')) }

type Body = Record<string, any>
type Row = Record<string, any>
type Step = { kind: 'call'; name: string; args: Record<string, unknown> } | { kind: 'stop-markup' } | { kind: 'cut' } | { kind: 'text'; text: string }
const sse = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`
const BACKGROUND_ID = /Running in the background \(ID: ([A-Za-z0-9_-]+)\)/

function engine(owner: 'tensorfold' | 'vllm', served: string, window: number, script: Step[]): { root: string; bodies: Body[]; stop(): void } {
  const bodies: Body[] = []
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request: Request) {
    const path = new URL(request.url).pathname
    const headers: Record<string, string> = owner === 'tensorfold' ? { server: 'TensorFold' } : {}
    if (path === '/health') return Response.json({ status: 'ok', version: '1.2.2', model: served }, { headers })
    if (path === '/v1/models') return Response.json({ object: 'list', data: [{ id: served, object: 'model', created: 1, owned_by: owner, context_length: window, max_model_len: window, reasoning: { default_enabled: true, default_effort: 'medium', supported_efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] } }] }, { headers })
    if (request.method !== 'POST' || path !== '/v1/chat/completions') return new Response('not found', { status: 404 })
    const body = (await request.json()) as Body
    const main = Array.isArray(body.tools) && body.tools.length > 0
    if (main) bodies.push(body)
    const step: Step = main ? script.shift() ?? { kind: 'text', text: 'SCRIPT-SPENT' } : { kind: 'text', text: 'side' }
    const chunk = (delta: unknown, finish: string | null = null, extra: Record<string, unknown> = {}): string => sse({ id: 'tf-turns', object: 'chat.completion.chunk', created: 1, model: served, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })
    const frames = [chunk({ role: 'assistant' })]
    let finish = 'stop'
    if (step.kind === 'call') {
      frames.push(chunk({ tool_calls: [{ index: 0, id: `call_${bodies.length}`, type: 'function', function: { name: step.name, arguments: JSON.stringify(step.args) } }] }))
      finish = 'tool_calls'
    } else if (step.kind === 'stop-markup') {
      const id = BACKGROUND_ID.exec(JSON.stringify(body.messages ?? []))?.[1] ?? 'no-background-id'
      frames.push(chunk({ reasoning_content: 'Stopping the old server now.' }), chunk({ content: `<tool_call>\n<function=TaskStop>\n<parameter=task_id>\n${id}\n</parameter>\n</function>\n</tool_call>` }))
    } else if (step.kind === 'cut') {
      frames.push(chunk({ reasoning_content: 'Designing the whole module before writing any of it, step by step.' }))
      finish = 'length'
    } else {
      frames.push(chunk({ content: step.text }))
    }
    frames.push(chunk({}, finish, owner === 'tensorfold' ? { tensorfold: { enable_thinking: true, reasoning_effort: 'high', tokens_per_second: 300, seconds: 0.1, prefill_seconds: 0.05, time_to_first_token: 0.06 } } : {}))
    frames.push(sse({ id: 'tf-turns', object: 'chat.completion.chunk', created: 1, model: served, choices: [], usage: { prompt_tokens: 900, completion_tokens: step.kind === 'cut' ? 4096 : 20, total_tokens: 920 } }))
    frames.push('data: [DONE]\n\n')
    return new Response(frames.join(''), { headers: { 'content-type': 'text/event-stream', ...headers } })
  } })
  return { root: `http://127.0.0.1:${server.port}`, bodies, stop: () => server.stop(true) }
}

function seedHome(prefix: string, endpoints: Record<string, { root: string; podId: string; dialect: string; served: string; engine: string }>): { home: string; cwd: string } {
  const home = mkdtempSync(join(scratch, `${prefix}-home-`))
  const cwd = mkdtempSync(join(scratch, `${prefix}-project-`))
  mkdirSync(join(home, 'user-home'), { recursive: true })
  mkdirSync(join(home, 'host', 'pods'), { recursive: true })
  mkdirSync(join(home, 'host', 'boxes'), { recursive: true })
  seedFirstRun(home, [cwd])
  const startedAt = new Date().toISOString()
  const compatProvider: Record<string, unknown> = {}
  const models: Record<string, unknown> = {}
  for (const [name, endpoint] of Object.entries(endpoints)) {
    compatProvider[name] = { baseUrl: `${endpoint.root}/v1`, hostPodId: endpoint.podId, dialect: endpoint.dialect, models: [endpoint.served] }
    models[`compat/${name}/${endpoint.served}`] = { contextWindow: 262144, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }
    writeFileSync(join(home, 'host', 'pods', `${endpoint.podId}.json`), JSON.stringify({ vendor: 'runpod', id: endpoint.podId, name: `${name} proof`, recipe: `fixture-${endpoint.engine}`, price: 1.19, startedAt, status: 'RUNNING', jobKind: 'setup', jobState: 'ready', step: 'ready', provider: name, recipeRow: { id: `fixture-${endpoint.engine}`, engine: endpoint.engine } }))
    if (endpoint.engine === 'tensorfold') writeFileSync(join(home, 'host', 'boxes', `pod-${endpoint.podId}.json`), JSON.stringify({ name: `pod-${endpoint.podId}`, kind: 'ssh', target: { host: '127.0.0.1', user: 'root', port: 22 }, os: 'linux', arch: 'x86_64', home: '/root', memoryGb: 96, unifiedMemory: false, gpus: [{ name: 'NVIDIA RTX PRO 6000', memory: 96 }], engines: [{ kind: 'tensorfold', path: '/workspace/mercury-host/fixture/bin/tensorfold-native', version: '1.2.2', port: 8080 }], bankPaths: [], discoveredAt: startedAt }))
  }
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ compatProvider, models }))
  return { home, cwd }
}

function runTurn(seeded: { home: string; cwd: string }, model: string, prompt: string, extra: string[], env: Record<string, string> = {}): Promise<{ code: number | null; rows: Row[]; stderr: string }> {
  return new Promise(done => {
    const child = spawn(node, [bundle, 'run', prompt, '--model', model, '--format', 'rows', '--max-turns', '8', '--effort', 'high', ...extra], {
      cwd: seeded.cwd,
      env: {
        HOME: join(seeded.home, 'user-home'), PATH: process.env.PATH ?? '/usr/bin:/bin', TERM: 'dumb', NO_COLOR: '1', LANG: 'en_US.UTF-8', ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
        MERCURY_CONFIG_DIR: seeded.home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_DAEMON_DIR: join(seeded.home, 'daemon'), MERCURY_TMPDIR: process.env.MERCURY_TMPDIR ?? process.env.TMPDIR ?? join(seeded.home, 'tmp'),
        MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_BOOT_PREFLIGHT: '0', ...env,
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', data => { stdout += data })
    child.stderr.on('data', data => { stderr += data })
    const deadline = setTimeout(() => child.kill('SIGKILL'), 120_000)
    child.on('close', code => {
      clearTimeout(deadline)
      const rows = stdout.split('\n').filter(line => line.trim().startsWith('{')).flatMap(line => { try { return [JSON.parse(line) as Row] } catch { return [] } })
      done({ code, rows, stderr })
    })
  })
}

const outcomeOf = (rows: Row[]): Row | undefined => rows.find(row => row.type === 'outcome')
const noticesOf = (rows: Row[]): string[] => rows.filter(row => row.type === 'notice').map(row => String(row.text ?? ''))
const limitNotice = (rows: Row[]): string | undefined => noticesOf(rows).find(text => text.startsWith('thinking ran to the output limit'))
const engines: Array<{ stop(): void }> = []
try {
  const markupScript: Step[] = [
    { kind: 'call', name: 'Bash', args: { command: 'sleep 30', run_in_background: true, description: 'Start the smoke server' } },
    { kind: 'call', name: 'ToolSearch', args: { query: 'select:TaskStop' } },
    { kind: 'stop-markup' },
    { kind: 'text', text: 'POD-DONE' },
  ]
  const pod = engine('tensorfold', 'qwen3.8-27b', 262144, markupScript)
  engines.push(pod)
  const markupHome = seedHome('tf-pod-markup', { 'pod-tfpod': { root: pod.root, podId: 'tfpod', dialect: 'chat-completions', served: 'qwen3.8-27b', engine: 'tensorfold' } })
  const markup = await runTurn(markupHome, 'compat/pod-tfpod/qwen3.8-27b', 'Start the smoke server in the background, then stop it and report.', ['--allowed-tools', 'Bash', 'ToolSearch', 'TaskStop'])
  const markupOutcome = outcomeOf(markup.rows)
  const stopCall = markup.rows.find(row => row.type === 'tool_call' && row.tool === 'TaskStop')
  const stopResult = stopCall ? markup.rows.find(row => row.type === 'tool_result' && row.call_id === stopCall.call_id) : undefined
  const background = markup.rows.find(row => row.type === 'tool_result' && BACKGROUND_ID.test(String(row.output ?? '')))
  check('the pod turn started a background task through Bash and loaded TaskStop through ToolSearch', background !== undefined && markup.rows.some(row => row.type === 'tool_call' && row.tool === 'ToolSearch'), JSON.stringify(markup.rows.filter(row => row.type === 'tool_call').map(row => row.tool)))
  check('RED ON THE BASE: the TaskStop call the engine left as Qwen markup ran — a TaskStop tool call with the background task id, and its result says the task stopped', stopCall !== undefined && stopCall.input?.task_id === BACKGROUND_ID.exec(String(background?.output ?? ''))?.[1] && stopResult?.status === 'ok' && /Stopped task/.test(String(stopResult.output ?? '')), JSON.stringify({ stopCall, stopResult, outcome: markupOutcome?.error }))
  check('RED ON THE BASE: the turn completes with the model\'s report, not "the model answered with a tool call (TaskStop) that was not executed"', markupOutcome?.status === 'completed' && markup.rows.some(row => row.type === 'text' && String(row.text).includes('POD-DONE')), JSON.stringify(markupOutcome))

  const cutPod = engine('tensorfold', 'qwen3.8-27b', 262144, [{ kind: 'cut' }, { kind: 'text', text: 'CUT-DONE' }])
  engines.push(cutPod)
  const cut = await runTurn(seedHome('tf-pod-cut', { 'pod-tfpod': { root: cutPod.root, podId: 'tfpod', dialect: 'chat-completions', served: 'qwen3.8-27b', engine: 'tensorfold' } }), 'compat/pod-tfpod/qwen3.8-27b', 'Write the module.', [])
  check('RED ON THE BASE: the pod request carries max_tokens 32768 (min(32768, the 256k window / 2)) and a thinking budget under it', cutPod.bodies[0]?.max_tokens === 32768 && cutPod.bodies[0]?.thinking_budget === 16384 && cutPod.bodies[0]?.reasoning_effort === 'high', JSON.stringify({ max_tokens: cutPod.bodies[0]?.max_tokens, thinking_budget: cutPod.bodies[0]?.thinking_budget, reasoning_effort: cutPod.bodies[0]?.reasoning_effort }))
  check('RED ON THE BASE: the notice names the limit the request sent: "thinking ran to the output limit (32768) — continuing"', limitNotice(cut.rows) === 'thinking ran to the output limit (32768) — continuing' && outcomeOf(cut.rows)?.status === 'completed', JSON.stringify(noticesOf(cut.rows)))

  const localTf = engine('tensorfold', 'qwen3.8-27b', 262144, [{ kind: 'cut' }, { kind: 'text', text: 'CUT-DONE' }])
  engines.push(localTf)
  const local = await runTurn(seedHome('tf-local-cut', {}), 'local/qwen3.8-27b', 'Write the module.', [], { MERCURY_LOCAL_PROBE_TARGETS: `tensorfold=${localTf.root}` })
  check('RED ON THE BASE: the local TensorFold lane names the limit it sent too', localTf.bodies[0]?.max_tokens === 32768 && limitNotice(local.rows) === 'thinking ran to the output limit (32768) — continuing', JSON.stringify({ max_tokens: localTf.bodies[0]?.max_tokens, notices: noticesOf(local.rows), outcome: outcomeOf(local.rows)?.error }))

  const vllmPod = engine('vllm', 'qwen3.8-27b', 262144, [{ kind: 'cut' }, { kind: 'text', text: 'CUT-DONE' }])
  engines.push(vllmPod)
  const vllm = await runTurn(seedHome('vllm-pod-cut', { 'pod-vllmpod': { root: vllmPod.root, podId: 'vllmpod', dialect: 'vllm', served: 'qwen3.8-27b', engine: 'vllm' } }), 'compat/pod-vllmpod/qwen3.8-27b', 'Write the module.', [])
  check('a vLLM pod is unchanged: no max_tokens on its request and the notice keeps the catalogue words "(32k)"', vllmPod.bodies[0] !== undefined && !('max_tokens' in vllmPod.bodies[0]) && limitNotice(vllm.rows) === 'thinking ran to the output limit (32k) — continuing', JSON.stringify({ max_tokens: vllmPod.bodies[0]?.max_tokens, notices: noticesOf(vllm.rows), outcome: outcomeOf(vllm.rows)?.error }))
} finally {
  for (const running of engines) running.stop()
}
if (failures > 0) {
  console.log('TENSORFOLD POD TURNS RED · ' + failures + ' of ' + checks + ' checks failed')
  process.exit(1)
}
console.log('TENSORFOLD POD TURNS GREEN · ' + checks + ' checks · the built bundle against fixture engines; nothing was rented')
