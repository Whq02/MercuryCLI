#!/usr/bin/env bun
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures = 1
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const scratch = mkdtempSync(join(tmpdir(), 'seat-engine-identity-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) {
  process.env[spelling] = home
}
for (const key of ['ANTHROPIC_API_KEY', 'ZAI_API_KEY']) {
  delete process.env[key]
}
delete process.env.NODE_ENV
process.env.MERCURY_EVOLUTION_LEDGER = '0'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_CREW_DIR = join(scratch, 'crew')
process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
process.env.ANTHROPIC_AUTH_TOKEN = 'fixture-token'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

console.log('============================================================')
console.log(' seat engine identity — no prompt names an engine; the seat reference does')
console.log('============================================================')

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const prompts = await import('../../src/constants/prompts.ts')

const idInPrompt = (text: string): string | null => {
  const m = /the model you run through Mercury is `([^`]+)`/.exec(text)
  return m?.[1] ?? null
}

section('§1 — the main loop: the env block names no engine (the seat reads mercury://seat for the model it runs on)')
{
  const env = await prompts.computeSimpleEnvInfo('claude-opus-5')
  check('the main-loop env block carries no engine line', !env.includes('the model you run through Mercury is') && idInPrompt(env) === null, env.slice(0, 200))
  check('…and names no model id at all', !env.includes('claude-opus-5'), env)
  const other = await prompts.computeSimpleEnvInfo('gpt-5.6-sol')
  check('a different seat model still names no id (the block is keyed on the model for its catalogue facts only)', idInPrompt(other) === null && !other.includes('gpt-5.6-sol'), other)
  const { seatReferenceText } = await import('../../src/services/resources/adapters/seat.ts')
  const reference = seatReferenceText({ model: 'claude-opus-5', effort: 'high', posture: 'interactive', engines: [] })
  check('the seat reference is where the id lives, verbatim', reference.includes('claude-opus-5'), reference)
}

section('§2 — subagents: the child’s env block names no engine either')
{
  const sections = await prompts.enhanceSystemPromptWithEnvDetails(['<task prompt>'], 'claude-sonnet-5')
  const whole = sections.join('\n\n')
  check('the subagent env block carries no engine line', !whole.includes('the model you run through Mercury is') && idInPrompt(whole) === null, whole.slice(-300))
  check('…and names no model id', !whole.includes('claude-sonnet-5'), whole.slice(-300))
  check('the task prompt still rides ahead of the env block', whole.indexOf('<task prompt>') !== -1 && whole.indexOf('<task prompt>') < whole.indexOf('The environment this session runs in'))
}

section('§3 — workers: the spec boots on the model admission resolved')
{
  const { buildConcourseWorkerSpec } = await import('../../src/daemon/concourseWorkers.ts')
  const spec = buildConcourseWorkerSpec({
    runnerId: 'w-seat-1',
    sessionId: 's-seat-1',
    workspaceId: scratch,
    modelKey: 'claude-opus-5',
    effort: 'high',
    cwd: scratch,
  })
  check('the worker spec carries the admitted model id', spec.model === 'claude-opus-5', String(spec.model))
  const env = await prompts.computeSimpleEnvInfo(String(spec.model))
  check('…and the worker’s own prompt states no id (its seat reference does)', idInPrompt(env) === null && !env.includes('claude-opus-5'), env)
}

try {
  removeScratch(scratch)
} catch {
}
console.log(
  failures === 0
    ? '\n✅ prove-seat-engine-identity — all checks pass'
    : '\n❌ prove-seat-engine-identity — check(s) failed',
)
process.exit(failures)
