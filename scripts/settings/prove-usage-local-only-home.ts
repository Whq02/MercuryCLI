#!/usr/bin/env bun

import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const scenarioAt = process.argv.indexOf('--scenario')
const scenario = scenarioAt < 0 ? null : (process.argv[scenarioAt + 1] ?? null)
const MODELS = ['qwen3.5:9b', 'nemotron-3.5-bolt:74b-a9b']

if (scenario !== null) {
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  const { enableConfigs } = await import('../../src/utils/config.ts')
  enableConfigs()
  const { composeUsageReading } = await import('../../src/cli/handlers/usage.ts')
  const reading = await composeUsageReading(Date.UTC(2026, 9, 16, 12))
  process.stdout.write(`\n${JSON.stringify(reading)}\n`)
  process.exit(0)
}

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}
type SignIn = { provider: string; credentialed: boolean; label?: string; unavailable?: string }
type Reading = { line: string; model: string; sampled: string[]; signIns: SignIn[]; active: { provider: string; sourceKind: string; whyNot?: string; spend: { inputTokens: number } }; providers: Array<{ provider: string; sourceKind: string }> }

const STUB = `
const http = require('node:http')
const MODELS = ${JSON.stringify(MODELS)}
const json = (res, body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
http.createServer((req, res) => { req.on('data', () => {}); req.on('end', () => {
  if (req.url === '/api/tags') return json(res, { models: MODELS.map(name => ({ name, model: name, size: 1024, details: { family: 'qwen3' } })) })
  if (req.url === '/api/version') return json(res, { version: '0.40.5' })
  if (req.url === '/api/ps') return json(res, { models: [] })
  if (req.url === '/api/show') return json(res, { parameters: '', model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 262144 }, capabilities: ['completion', 'tools'] })
  res.writeHead(404, { 'content-type': 'application/json' }); res.end('{}')
}) }).listen(0, '127.0.0.1', function () { process.stdout.write(String(this.address().port) + '\\n') })
`
const stub = spawn(process.execPath, ['-e', STUB], { stdio: ['ignore', 'pipe', 'inherit'] })
const root = await new Promise<string>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('the stub Ollama never reported its port')), 10_000)
  stub.stdout.once('data', (chunk: Buffer) => { clearTimeout(timer); resolve(`http://127.0.0.1:${String(chunk).trim()}`) })
})
process.on('exit', () => { stub.kill() })

const SCRATCH = mkdtempSync(join(tmpdir(), 'usage-local-only-'))
const DEAD = 'http://127.0.0.1:9'
function run(tag: string, extra: Record<string, string>): Reading {
  const home = mkdtempSync(join(SCRATCH, `${tag}-`))
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) {
    if (/^(ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|MERCURY_OAUTH_TOKEN|MERCURY_API_KEY_FILE_DESCRIPTOR|OPENAI_API_KEY|ZAI_API_KEY|OPENROUTER_API_KEY|GOOGLE_API_KEY|GEMINI_API_KEY|MOONSHOT_API_KEY|DEEPSEEK_API_KEY|HF_TOKEN|XAI_API_KEY|MODEL_API_KEY|MISTRAL_API_KEY|NOUS_API_KEY|MERCURY_COMPAT_BASE_URL|MERCURY_LOCAL_BASE_URL|MERCURY_LOCAL_PROBE_TARGETS|MERCURY_HOME|MERCURY_MODEL)$/.test(key)) delete env[key]
  }
  Object.assign(env, { MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', ANTHROPIC_BASE_URL: DEAD, MERCURY_OPENAI_API_BASE: DEAD, MERCURY_MOONSHOT_API_BASE: `${DEAD}/v1`, MERCURY_ZAI_API_BASE: `${DEAD}/v4`, MERCURY_DEEPSEEK_API_BASE: DEAD }, extra)
  const r = spawnSync(process.execPath, ['run', SELF, '--scenario', tag], { encoding: 'utf8', env, timeout: 120_000 })
  const line = r.stdout.trim().split('\n').filter(l => l.startsWith('{')).pop()
  if (line === undefined) throw new Error(`${tag}: no reading · ${r.status} · ${(r.stderr + r.stdout).slice(-800)}`)
  return JSON.parse(line) as Reading
}
const local = (reading: Reading): SignIn | undefined => reading.signIns.find(s => s.provider === 'local')

console.log('§1 a home never signed in anywhere, this box\'s Ollama answering with two models: no hosted session is claimed; the line names the road the home actually runs')
{
  const reading = run('local-only', { MERCURY_LOCAL_PROBE_TARGETS: `ollama=${root}` })
  check('with no hosted credential the default model resolves to the discovered local one, and the line names it with its server: "local/qwen3.5:9b on Ollama 0.40.5 (2) · 0 subscriptions signed in"', reading.line === 'local/qwen3.5:9b on Ollama 0.40.5 (2) · 0 subscriptions signed in' && reading.model === 'local/qwen3.5:9b', `${reading.line} · model=${reading.model}`)
  check('the words "session on" are nowhere on it', !reading.line.includes('session on'), reading.line)
  check('the local family read its discovery before the reading: present with its server label, no "discovery-pending"', local(reading)?.credentialed === true && local(reading)?.label === 'Ollama 0.40.5 (2)' && local(reading)?.unavailable === undefined, JSON.stringify(local(reading)))
  check('the local family is sampled and reported as the active source (keyless, zero spend in a one-shot read)', reading.sampled.includes('local') && reading.active.provider === 'local' && reading.active.sourceKind === 'keyless' && reading.active.spend.inputTokens === 0 && reading.providers.some(p => p.provider === 'local'), JSON.stringify({ sampled: reading.sampled, active: reading.active.provider }))
  const hosted = run('hosted-pinned', { MERCURY_LOCAL_PROBE_TARGETS: `ollama=${root}`, MERCURY_MODEL: 'claude-opus-5-5' })
  check('a hosted model pinned with no sign-in: "Anthropic not signed in · 0 subscriptions signed in · local servers: Ollama 0.40.5 (2)" — no session claimed, the local road named', hosted.line === 'Anthropic not signed in · 0 subscriptions signed in · local servers: Ollama 0.40.5 (2)', hosted.line)
  check('its active source is the pinned family with no credential — reported, never dressed as a session', hosted.active.provider === 'anthropic' && hosted.active.sourceKind === 'none', JSON.stringify({ provider: hosted.active.provider, sourceKind: hosted.active.sourceKind }))
}

console.log('§2 the same home with a local model as its default: the line names the model and its server')
{
  const reading = run('local-default', { MERCURY_LOCAL_PROBE_TARGETS: `ollama=${root}`, MERCURY_MODEL: 'local/qwen3.5:9b' })
  check('the line reads "local/qwen3.5:9b on Ollama 0.40.5 (2) · 0 subscriptions signed in"', reading.line === 'local/qwen3.5:9b on Ollama 0.40.5 (2) · 0 subscriptions signed in', reading.line)
  check('the active source is the local family (keyless), the model the home\'s own', reading.active.provider === 'local' && reading.active.sourceKind === 'keyless' && reading.model === 'local/qwen3.5:9b', JSON.stringify({ provider: reading.active.provider, model: reading.model }))
}

console.log('§3 no local server at all (probing off): the hosted lead still claims nothing, and the local family is not left pending')
{
  const reading = run('no-server', { MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_MODEL: 'claude-opus-5-5' })
  check('the line reads "Anthropic not signed in · 0 subscriptions signed in" with no local clause', reading.line === 'Anthropic not signed in · 0 subscriptions signed in', reading.line)
  check('the local family is settled, not "discovery-pending"', local(reading)?.credentialed === false && local(reading)?.unavailable !== 'discovery-pending:local', JSON.stringify(local(reading)))
  const localDefault = run('no-server-local-default', { MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_MODEL: 'local/qwen3.5:9b' })
  check('a local default with no server answering says so: "local/qwen3.5:9b · no local server answering · 0 subscriptions signed in"', localDefault.line === 'local/qwen3.5:9b · no local server answering · 0 subscriptions signed in', localDefault.line)
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-usage-local-only-home: ALL GREEN' : `\nprove-usage-local-only-home: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
