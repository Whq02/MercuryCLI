;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startScriptedFixture } from '../lib/scriptedTurn.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const at = process.argv.indexOf('--dist')
const dist = at < 0 ? join(import.meta.dir, '../../dist/mercury.mjs') : process.argv[at + 1]!
let failures = 0
function check(label: string, pass: boolean, detail: unknown = ''): void {
  if (!pass) failures++
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label}${pass ? '' : ` — ${JSON.stringify(detail)}`}`)
}
type Row = Record<string, any>
const home = realpathSync(mkdtempSync(join(tmpdir(), 'child-rows-')))
process.env.MERCURY_CONFIG_DIR = home
const state = await import('../../src/bootstrap/state.ts')
state.setIsInteractive(false)
const { emitBackgroundAgentRows } = await import('../../src/utils/task/sdkAgentFrames.ts')
const { drainRows } = await import('../../src/utils/sdkEventQueue.ts')
const { mainThreadStep } = await import('../../src/rows/read.ts')
const blocks = [{ type: 'thinking', thinking: 'consider' }, { type: 'text', text: 'words' }, { type: 'tool_use', id: 'call-background', name: 'Read', input: { file_path: 'proof' } }]
const assistant = (content: unknown, id = 'background-message'): any => ({ type: 'assistant', uuid: randomUUID(), timestamp: new Date().toISOString(), message: { id, role: 'assistant', type: 'message', model: 'fixture', content, stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 40, output_tokens: 8 } } })
try {
  emitBackgroundAgentRows('agent-parent', assistant(blocks))
  emitBackgroundAgentRows('agent-parent', assistant([{ type: 'text', text: 'more' }]))
  const rows = drainRows() as Row[]
  const items = rows.filter(row => ['reasoning', 'text', 'tool_call'].includes(row.type))
  check('background normalized blocks have distinct consecutive addresses', JSON.stringify(items.map(row => row.block)) === JSON.stringify([0, 1, 2, 3]), items)
  check('background pieces keep one provider message identity and Agent scope', items.length === 4 && items.every(row => row.message_id === 'background-message' && row.parent_call_id === 'agent-parent'), items)
  check('background model call emits one scoped step', rows.filter(row => row.type === 'step').length === 1 && rows.find(row => row.type === 'step')?.usage.output_tokens === 8, rows)
  const { childRowsOf } = await import('../../src/rows/child.ts')
  const early = assistant([{ type: 'thinking', thinking: 'foreground' }], 'handover-message')
  early.message.stop_reason = null
  const foreground = childRowsOf({ session_id: state.getSessionId(), parent_call_id: 'handover-parent', turn: 1 }, early) as Row[]
  const settled = assistant([{ type: 'text', text: 'background' }, { type: 'tool_use', id: 'handover-call', name: 'Read', input: {} }], 'handover-message')
  emitBackgroundAgentRows('handover-parent', settled)
  emitBackgroundAgentRows('handover-parent', settled)
  const handed = [...foreground, ...drainRows()] as Row[]
  check('foreground to background handover keeps one block cursor and no duplicate pieces', JSON.stringify(handed.filter(row => row.block !== undefined).map(row => row.block)) === '[0,1,2]', handed)
  check('handover emits one step after the settled final piece', handed.filter(row => row.type === 'step').length === 1 && handed.at(-1)?.type === 'step', handed)

  for (const childModel of [null, 'same', 'haiku']) {
    const runHome = realpathSync(mkdtempSync(join(tmpdir(), 'child-run-')))
    seedFirstRun(runHome, [runHome])
    const nested = childModel !== null
    const childPrompt = 'CHILD-ROW-PROOF'
    const command = 'for n in 1 2 3 4 5 6; do printf "row tick %s\\n" "$n"; sleep 1; done'
    const api = await startScriptedFixture(req => {
      if (nested && req.opening.trim() !== childPrompt) {
        if (req.step === 0) return [{ type: 'tool_use', name: 'Agent', input: { description: 'prove child rows', prompt: childPrompt, ...(childModel === 'haiku' ? { model: 'haiku' } : {}) } }]
        return [{ type: 'text', text: 'PARENT-DONE' }]
      }
      if (req.step === 0) return [{ type: 'text', text: 'tool begins' }, { type: 'tool_use', name: 'Bash', input: { command } }]
      return [{ type: 'text', text: nested ? 'CHILD-DONE' : 'MAIN-DONE' }]
    })
    const child = spawn(Bun.which('node')!, [dist, 'run', 'PARENT-ROW-PROOF', '--format', 'rows', '--partial', '--mode', 'sovereign', '--model', 'claude-opus-4-8'], { cwd: runHome, env: { HOME: runHome, PATH: process.env.PATH, TMPDIR: tmpdir(), MERCURY_CONFIG_DIR: runHome, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_DAEMON_DIR: join(runHome, 'daemon'), ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', ANTHROPIC_BASE_URL: api.base }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', data => { stdout += String(data) })
    child.stderr.on('data', data => { stderr += String(data) })
    const timer = setTimeout(() => child.kill('SIGKILL'), 90_000)
    const rc = await new Promise<number | null>(resolve => child.on('close', resolve))
    clearTimeout(timer)
    await api.close()
    const output = stdout.split('\n').filter(Boolean).map(line => JSON.parse(line) as Row)
    const agent = output.find(row => row.type === 'tool_call' && row.tool === 'Agent')
    const call = output.find(row => row.type === 'tool_call' && row.tool === 'Bash')
    const ticks = output.filter(row => row.type === 'tool_update')
    const steps = output.filter(row => row.type === 'step')
    const mainSteps = steps.filter(row => mainThreadStep(row as never))
    const childSteps = steps.filter(row => row.parent_call_id !== undefined)
    const outcome = output.find(row => row.type === 'outcome')
    const label = childModel ?? 'main'
    check(`${label}: fixture turn completed`, rc === 0 && outcome?.status === 'completed' && api.requests.length === (nested ? 4 : 2), { rc, stderr, outcome, requests: api.requests.length })
    check(`${label}: at least two live ticks identify the running Bash call`, !!call && ticks.length >= 2 && ticks.every(row => row.call_id === call.call_id), { call, ticks })
    check(`${label}: only a child tick carries the Agent parent`, ticks.length >= 2 && ticks.every(row => nested ? row.parent_call_id === agent?.call_id && !!agent : row.parent_call_id === undefined), { agent, ticks })
    check(`${label}: ticks strictly increase within the call`, ticks.every((row, index) => index === 0 || row.tick > ticks[index - 1]!.tick), ticks)
    check(`${label}: one scoped step per model call`, steps.length === api.requests.length && childSteps.length === (nested ? 2 : 0) && new Set(steps.map(row => row.message_id)).size === steps.length, steps)
    check(`${label}: outcome steps and occupancy remain main-thread only`, mainSteps.length === 2 && outcome?.steps === 2 && mainSteps.every(row => row.usage.input_tokens === 40 && row.usage.output_tokens === 8), { mainSteps, outcome })
    check(`${label}: child final text and steps retain Agent scope`, !nested || (childSteps.every(row => row.parent_call_id === agent?.call_id) && output.some(row => row.type === 'text' && row.text === 'CHILD-DONE' && row.parent_call_id === agent?.call_id)), { childSteps, text: output.filter(row => row.type === 'text') })
    const models = Object.values(outcome?.models ?? {}) as Row[]
    const input = models.reduce((sum, row) => sum + row.input_tokens, 0)
    const outputTokens = models.reduce((sum, row) => sum + row.output_tokens, 0)
    const cost = models.reduce((sum, row) => sum + row.cost_usd, 0)
    check(`${label}: billing usage includes every fixture call and agrees with per-model sums`, outcome?.usage.input_tokens === api.requests.length * 40 && outcome?.usage.output_tokens === api.requests.length * 8 && outcome.usage.input_tokens === input && outcome.usage.output_tokens === outputTokens, outcome)
    check(`${label}: cost equals the sum of the model costs`, typeof outcome?.cost_usd === 'number' && Math.abs(outcome.cost_usd - cost) < 1e-9, outcome)
    check(`${label}: model identities cover parent and child`, childModel !== 'haiku' || (Object.keys(outcome?.models ?? {}).length === 2 && new Set(steps.map(row => row.model)).size === 2), { models: outcome?.models, steps })
    rmSync(runHome, { recursive: true, force: true })
  }
} finally {
  rmSync(home, { recursive: true, force: true })
}
console.log(`child rows: ${failures === 0 ? 'green' : `${failures} failures`}`)
process.exit(failures === 0 ? 0 : 1)
