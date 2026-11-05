import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { fakeSshRunner, liveCatalogue, runpodFixture } from './runpodFixture.mjs'
import type { HostRecord } from '../../src/services/host/store.ts'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const f = await llmhostFixture()
const rp = await runpodFixture()
const nativeFetch = globalThis.fetch
const escaped: string[] = []
globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init)
  if (!['127.0.0.1', '[::1]'].includes(new URL(request.url).hostname)) { escaped.push(request.url); throw new Error('The rent drive permits only loopback fixtures') }
  return nativeFetch(request)
}, nativeFetch)
let checks = 0
const check = (name: string, truth: unknown, detail = ''): void => { assert.ok(truth, name + (detail ? ': ' + detail : '')); checks++; console.log('PASS ' + name) }
let ssh: ReturnType<typeof fakeSshRunner> | undefined
const engineHits: { path: string; authorization?: string; body?: unknown }[] = []
let podKey = (): string | undefined => undefined
let chatContent = 'ready'
const engine = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const path = new URL(request.url).pathname
  const authorization = request.headers.get('authorization') ?? undefined
  const hit: { path: string; authorization?: string; body?: unknown } = { path, ...(authorization ? { authorization } : {}) }
  engineHits.push(hit)
  if (path === '/health') return Response.json({ status: 'ok' })
  const key = podKey()
  if (!key || authorization !== 'Bearer ' + key) return Response.json({ error: { message: 'missing or invalid API key' } }, { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } })
  if (path === '/v1/models') return Response.json({ object: 'list', data: [{ id: 'qwen3.8-27b', object: 'model', created: 1, owned_by: 'tensorfold', context_length: 131072, max_model_len: 131072, reasoning: { default_enabled: true, default_effort: 'medium', supported_efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'none'] } }] })
  if (path === '/v1/chat/completions') {
    const body = await request.json() as { model: string }
    hit.body = body
    const chunk = (delta: unknown, finish: string | null = null, usage?: unknown): string => 'data: ' + JSON.stringify({ model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) }) + '\n\n'
    return new Response(chunk({ content: chatContent }) + chunk({}, 'stop', { prompt_tokens: 20, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0 }, tensorfold: { tokens_per_second: 110, time_to_first_token: 0.04, prefill_seconds: 0.04, reasoning_effort: 'medium' } }) + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  }
  return new Response('not found', { status: 404 })
} })
const engineBase = 'http://127.0.0.1:' + engine.port + '/v1'
try {
  const { hostRunner } = await import('../../src/services/host/ssh.ts')
  const { runHostJob } = await import('../../src/services/host/worker.ts')
  const { queueHostSetup } = await import('../../src/services/host/jobs.ts')
  const { readHostRecord, removeHostRecord } = await import('../../src/services/host/store.ts')
  const { vendorClient, saveVendorKey } = await import('../../src/services/host/vendors/client.ts')
  const { configuredCompatEndpoints, resolveCompatApiKey } = await import('../../src/services/providers/openaicompat/compatAccounts.ts')
  const { TENSORFOLD_HOST_IMAGE } = await import('../../src/services/host/tensorfoldRelease.ts')
  const { stopTensorFoldPod, tensorFoldPodFacts, tensorFoldPodKey, TENSORFOLD_HOST_WORDS } = await import('../../src/services/host/tensorfoldPod.ts')
  const { hostRentalUsage } = await import('../../src/services/host/costs.ts')
  const { readBox } = await import('../../src/services/host/boxes.ts')
  const { getSettingsForSource } = await import('../../src/utils/settings/settings.ts')
  saveVendorKey('runpod', rp.key)
  rp.state.customGpus = liveCatalogue.gpus.map((gpu: { id: string }) => gpu.id === 'NVIDIA GeForce RTX 5090' ? { ...gpu, availability: 'HIGH', dataCenters: [{ id: 'EU-NL-1', name: 'EU-NL-1', availability: 'HIGH' }] } : gpu)
  const api = vendorClient('runpod', { key: rp.key, apiBaseUrl: rp.baseUrl })
  ssh = fakeSshRunner(engineBase, hostRunner, { window: 131072, slots: 1 }, { enginePort: 8080 })
  ssh.state.log = 'MERCURY_STEP checking the NVIDIA driver\nMERCURY_STEP driver 580.95.05 · compute capability 12.0\nMERCURY_STEP downloading TensorFold 1.2.2 for linux-x86_64\nMERCURY_STEP TensorFold 1.2.2 installed\nMERCURY_STEP pulling TensorFold/Qwen3.8-27B-MLX-4bit\nMERCURY_STEP starting engine\n'
  podKey = () => ssh!.state.keyFile.split(': ')[1]?.trim()
  const offers = await api.offers(new AbortController().signal)
  const tensorfold = offers.filter(row => row.recipe.engine === 'tensorfold' && row.gpuId === 'NVIDIA GeForce RTX 5090')
  check('live stock on an RTX 5090 offers the three TensorFold starting points at the card’s price; the in-stock A100 and RTX PRO 6000 carry them too and no sm_90+ card does', tensorfold.length === 3 && tensorfold.every(row => row.price === 1.19) && offers.some(row => row.recipe.engine === 'tensorfold' && row.gpuId.includes('A100')) && offers.some(row => row.recipe.engine === 'tensorfold' && row.gpuId.includes('RTX PRO 6000')) && !offers.some(row => row.recipe.engine === 'tensorfold' && /H100|H200|B200|B300/.test(row.gpuId)))
  const offer = tensorfold.find(row => row.recipe.id === 'tensorfold-qwen38-27b-rtx-5090')!
  const pod = await api.create(offer, 'ssh-ed25519 fixture', 'tf-rent')
  const body = rp.state.createBodies.at(-1) as { image: string; ports: string[]; gpu: { minCudaVersion: string }; env: Record<string, string>; mounts: { persistent?: { size: number; path: string } } }
  check('the pod is created on the digest-pinned CUDA 13.0.3 base image with 22/tcp and 8080/http exposed, CUDA 13.0 required and HF_HOME on /workspace', body.image === TENSORFOLD_HOST_IMAGE && body.ports.join(' ') === '22/tcp 8080/http' && body.gpu.minCudaVersion === '13.0' && body.env.HF_HOME === '/workspace/huggingface' && body.mounts.persistent?.path === '/workspace' && body.mounts.persistent.size === 80)
  const session = 'tf-rent-session'
  const record = queueHostSetup({ id: pod.id, vendor: 'runpod', name: pod.name, recipe: offer.recipe.id, price: pod.cost, startedAt: pod.createdAt, status: pod.status, apiBaseUrl: rp.baseUrl, sessionId: session })
  await runHostJob(record.id, record.generation!, { runner: ssh.runner, pauseMs: 20, timeoutMs: 20_000, keepAlive: false })
  const ready = readHostRecord(pod.id)!
  check('the setup reaches ready: install → pull → serve through the SSH road, the tunnel on a local port, the provider pod-<id>', ready.jobState === 'ready' && ready.step === 'ready' && ready.provider === 'pod-' + pod.id && typeof ready.localPort === 'number', JSON.stringify({ jobState: ready.jobState, step: ready.step, error: ready.error }))
  const remotes = ssh.commands.filter(row => row.command === 'ssh').map(row => String(row.args.at(-1)))
  const key = tensorFoldPodKey(pod.id)
  check('Mercury wrote its generated key to the pod as mercury[inference] before the launch, and the launch script is the TensorFold one (no sglang, no python download)', ssh.state.keyFile === 'mercury[inference]: ' + key + '\n' && remotes.findIndex(row => row.includes('umask 077') && row.includes('/api-key')) < remotes.findIndex(row => row.includes('nohup setsid')) && ssh.state.script.includes("'tensorfold-native' 'serve' 'TensorFold/Qwen3.8-27B-MLX-4bit'") && ssh.state.script.includes("'--host' '0.0.0.0' '--port' '8080' '--api-key-file'") && !ssh.state.script.includes('sglang') && !ssh.state.script.includes('python3 -c'))
  check('readiness waited on the pair: /health key-blind and /v1/models with the key on 127.0.0.1:8080', remotes.some(row => row.includes('http://127.0.0.1:8080/health') && row.includes("Authorization: Bearer $(cut -d ' ' -f 2") && row.includes('http://127.0.0.1:8080/v1/models')))
  const tunnel = ssh.commands.find(row => row.command === 'tunnel')!
  check('the SSH tunnel forwards a local port to the pod’s 8080 and was proven with the key', /:127\.0\.0\.1:8080$/.test(String(tunnel.args[tunnel.args.indexOf('-L') + 1])) && engineHits.some(hit => hit.path === '/v1/models' && hit.authorization === 'Bearer ' + key))
  const endpoint = configuredCompatEndpoints().find(row => row.name === 'pod-' + pod.id)!
  check('the provider is registered as OpenAI-compatible chat completions on the tunnel, linked to the pod, with the key stored under the provider', endpoint !== undefined && endpoint.dialect === 'chat-completions' && endpoint.baseUrl === 'http://127.0.0.1:' + ready.localPort + '/v1' && endpoint.hostPodId === pod.id && resolveCompatApiKey(process.env, endpoint.name)?.key === key)
  const model = 'compat/pod-' + pod.id + '/qwen3.8-27b'
  const facts = (getSettingsForSource('userSettings')?.models as Record<string, { contextWindow?: number; efforts?: string[] }> | undefined)?.[model]
  check('the model facts carry the served window and the TensorFold effort ladder', facts?.contextWindow === 131072 && facts.efforts?.join(' ') === 'low medium high xhigh max')
  check('the reply check reached the engine through the tunnel with the key and the engine answered', engineHits.some(hit => hit.path === '/v1/chat/completions' && hit.authorization === 'Bearer ' + key && (hit.body as { model?: string })?.model === 'qwen3.8-27b') && !escaped.length)
  const box = readBox('pod-' + pod.id)
  check('the pod is a host box with engine tensorfold on 8080 and its SSH target, and lane 1’s facts show it serving with price and elapsed time', box?.engines[0]?.kind === 'tensorfold' && box.engines[0].port === 8080 && box.target?.host === '127.0.0.1' && tensorFoldPodFacts(ready, offer.recipe)?.state === 'serving' && tensorFoldPodFacts(ready, offer.recipe)?.price === 1.19 && hostRentalUsage(model)?.price === 1.19 && (hostRentalUsage(model)?.elapsedMs ?? -1) >= 0)
  const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
  const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
  const { assembleToolPool } = await import('../../src/tools.ts')
  const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages.ts')
  const { ToolSearchTool } = await import('../../src/tools/ToolSearchTool/ToolSearchTool.ts')
  const permission = getEmptyToolPermissionContext()
  const pool = assembleToolPool(permission, [])
  const searched = await ToolSearchTool.call({ query: 'select:TaskStop', max_results: 5 }, { options: { tools: pool }, getAppState: () => ({ toolPermissionContext: { ...permission, mode: 'default' }, mcp: { clients: [] } }) } as never)
  const admission = ToolSearchTool.mapToolResultToToolResultBlockParam((searched as { data: unknown }).data as never, 'toolu_ts_1')
  chatContent = '<tool_call>\n<function=TaskStop>\n<parameter=task_id>\nb4avyo465\n</parameter>\n</function>\n</tool_call>'
  const minted: Array<{ type: string; name?: string; input?: { task_id?: string } }> = []
  for await (const item of routedCallModel({
    messages: [createUserMessage({ content: 'Stop the smoke server.' }), createAssistantMessage({ content: [{ type: 'tool_use', id: 'toolu_ts_1', name: 'ToolSearch', input: { query: 'select:TaskStop' } }] as never }), createUserMessage({ content: [admission] as never })] as never,
    systemPrompt: ['You are a fixture assistant.'] as never, thinkingConfig: { type: 'enabled', budget_tokens: 1024 } as never, tools: pool, signal: AbortSignal.timeout(30_000),
    options: { getToolPermissionContext: async () => permission, model, isNonInteractiveSession: true, querySource: 'main_thread', agents: [], hasAppendSystemPrompt: false, mcpTools: [], hasPendingMcpServers: false, effortValue: 'high' } as never,
  })) {
    const row = item as { type?: string; isApiErrorMessage?: boolean; message?: { content?: typeof minted } }
    if (row.type === 'assistant' && row.isApiErrorMessage !== true) minted.push(...(row.message?.content ?? []))
  }
  chatContent = 'ready'
  const sent = engineHits.filter(hit => hit.path === '/v1/chat/completions').at(-1)?.body as { max_tokens?: number; thinking_budget?: number } | undefined
  check('the pod as registered is TensorFold-served on the compat road: a ToolSearch-loaded TaskStop it answers as Qwen markup runs, and the request carries the local lane\'s max_tokens for the 128k window (32768) with the thinking budget under it', minted.some(block => block.type === 'tool_use' && block.name === 'TaskStop' && block.input?.task_id === 'b4avyo465') && sent?.max_tokens === 32768 && sent.thinking_budget === 16384, JSON.stringify({ minted: minted.map(block => block.type + ':' + (block.name ?? '')), max_tokens: sent?.max_tokens, thinking_budget: sent?.thinking_budget }))
  check('the engine log Mercury keeps names the driver check, the install and the pull', readFileSync(ready.log!, 'utf8').includes('driver 580.95.05 · compute capability 12.0') && readFileSync(ready.log!, 'utf8').includes('pulling TensorFold/Qwen3.8-27B-MLX-4bit'))
  const stopped = await stopTensorFoldPod(pod.id, { client: api, pauseMs: 10, forget: async () => {} })
  check('s on the HOST pod row stops the pod: compute billing ends, the disk bills until Terminate', stopped.ok && rp.state.stops === 1 && readHostRecord(pod.id)?.status === 'EXITED' && stopped.words.includes('compute billing ended') && stopped.words.includes('the disk bills until you terminate it in /llmhost') && tensorFoldPodFacts(readHostRecord(pod.id)!, offer.recipe)?.state === 'stopped')

  const gatedPod = await api.create(offer, 'ssh-ed25519 fixture', 'tf-gated')
  const gated = queueHostSetup({ id: gatedPod.id, vendor: 'runpod', name: gatedPod.name, recipe: offer.recipe.id, price: gatedPod.cost, startedAt: gatedPod.createdAt, status: gatedPod.status, apiBaseUrl: rp.baseUrl, sessionId: session, weightsSource: { kind: 'private-repo', repo: 'someone/gated-checkpoint' } })
  const launchesBefore = ssh.commands.filter(row => String(row.args.at(-1)).includes('nohup setsid')).length
  await runHostJob(gated.id, gated.generation!, { runner: ssh.runner, pauseMs: 20, timeoutMs: 20_000, keepAlive: false })
  const paused = readHostRecord(gatedPod.id)!
  check('a gated or private checkpoint is refused before any download with the words on screen, and the setup pauses with the pod still billing', paused.jobState === 'paused' && paused.error?.includes(TENSORFOLD_HOST_WORDS.gated) === true && ssh.commands.filter(row => String(row.args.at(-1)).includes('nohup setsid')).length === launchesBefore, paused.error)
  removeHostRecord(gatedPod.id)
  removeHostRecord(pod.id)
  console.log('TENSORFOLD RENT DRIVE GREEN · ' + checks + ' checks · Runpod, SSH and the engine are fixtures; nothing was rented')
} finally {
  ssh?.close()
  engine.stop(true)
  await rp.close()
  f.close()
}
