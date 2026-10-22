import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { validateEngineRequest } from '../provider-compat/fixtures/engineRules.mjs'
import { startFixtureApi, HANDOFF_ASK_MARK, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { PYTHON } from './runtime.ts'

export const root = resolve(import.meta.dir, '../..')
export const mercury = ['node', process.env.SDK_PARITY_CLI ?? join(root, 'dist/mercury.mjs')]
export const anthropicModel = 'claude-opus-4-8'
type CompatTurn = { text?: string; reasoning?: string; call?: { name: string; input: Record<string, unknown> }; when?: string }

export async function compatRoadFixture(turns: ScriptedTurn[] = []) {
  const f = await llmhostFixture()
  f.state.dialect = 'llamacpp'
  f.state.auth = true
  const cwd = join(f.home, 'project')
  mkdirSync(cwd)
  seedFirstRun(f.home, [cwd])
  const api = await startFixtureApi(turns)
  const queue: CompatTurn[] = []
  const requests: Array<{ body: any; fault: unknown; auth: string | null }> = []
  const proxy = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname !== '/v1/chat/completions') return fetch(new URL(url.pathname + url.search, f.baseUrl), { method: request.method, headers: request.headers, ...(request.method === 'POST' ? { body: await request.text() } : {}) })
    const body = await request.json() as any
    const auth = request.headers.get('authorization')
    if (auth !== `Bearer ${f.key}`) return Response.json({ error: { message: 'fixture key required' } }, { status: 401 })
    const fault = validateEngineRequest('llamacpp', body)
    requests.push({ body, fault, auth })
    if (fault) return Response.json(fault.body, { status: fault.status })
    const raw = JSON.stringify(body)
    const index = queue.findIndex(turn => turn.when === undefined || raw.includes(turn.when))
    const turn = raw.includes(HANDOFF_ASK_MARK) ? undefined : index < 0 ? undefined : queue.splice(index, 1)[0]
    if (!turn) return fetch(`${f.baseUrl}/chat/completions`, { method: 'POST', headers: request.headers, body: raw })
    const sse = (delta: unknown, finish: string | null = null, usage?: unknown) => `data: ${JSON.stringify({ model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`
    const call = turn.call
    return new Response(sse({ reasoning_content: turn.reasoning ?? 'fixture reasoning' }) + (call
      ? sse({ tool_calls: [{ index: 0, id: `call_${requests.length}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } }] })
      : sse({ content: turn.text ?? 'COMPAT-ANSWER' })) + sse({}, call ? 'tool_calls' : 'stop', { prompt_tokens: 20, completion_tokens: 6, prompt_tokens_details: { cached_tokens: 10 } }) + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  } })
  const model = `compat/fixture/${f.model}`
  const settings = { engine: { model: anthropicModel }, compatProvider: { fixture: { baseUrl: `http://127.0.0.1:${proxy.port}/v1`, models: [f.model], dialect: 'llamacpp' } } }
  writeFileSync(join(f.home, 'settings.json'), JSON.stringify(settings))
  const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
  resetSettingsCache()
  const { writeStoredCompatApiKey } = await import('../../src/services/providers/providerSecrets.ts')
  writeStoredCompatApiKey(f.key, 'fixture')
  const env: NodeJS.ProcessEnv = { HOME: f.home, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, BROWSER: '/usr/bin/true', MERCURY_CONFIG_DIR: f.home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_DAEMON_DIR: join(f.home, 'daemon'), ANTHROPIC_API_KEY: 'fixture-key-000', ANTHROPIC_BASE_URL: api.url }
  return { ...f, cwd, api, env, model, settings, requests, script: (...next: CompatTurn[]) => queue.push(...next), close: async () => { proxy.stop(true); await api.close(); f.close() } }
}

export async function pythonProof(file: string, c: Awaited<ReturnType<typeof compatRoadFixture>>, ...args: string[]): Promise<void> {
  const child = spawn(PYTHON, [join(root, 'scripts/sdk', file), JSON.stringify(mercury), c.cwd, c.model, anthropicModel, ...args], { env: { ...c.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: join(root, 'sdk-py/src') }, stdio: 'inherit' })
  const timer = setTimeout(() => child.kill('SIGKILL'), 90_000)
  try { assert.equal(await new Promise(resolve => child.once('close', resolve)), 0, file) }
  finally { clearTimeout(timer) }
}
