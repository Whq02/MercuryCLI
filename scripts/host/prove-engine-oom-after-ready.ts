import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { runpodFixture, fakeSshRunner } from './runpodFixture.mjs'
import type { HostRecord } from '../../src/services/host/store.ts'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
process.env.MERCURY_RECONNECT_SCALE = '0.01'
process.env.MERCURY_RECONNECT_BUDGET_MINUTES = '0.05'
const f = await llmhostFixture()
const rp = await runpodFixture()
const nativeFetch = globalThis.fetch
const escaped: string[] = []
globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init)
  if (!['127.0.0.1', '[::1]'].includes(new URL(request.url).hostname)) { escaped.push(request.url); throw new Error('OOM proof permits only loopback fixtures') }
  return nativeFetch(request)
}, nativeFetch)
const failures: string[] = []
let checks = 0
const check = (name: string, truth: unknown, detail = ''): void => { if (truth) { checks++; console.log('PASS ' + name) } else { failures.push(name + (detail ? ': ' + detail : '')); console.error('FAIL ' + name + (detail ? ': ' + detail : '')) } }
const houseWords = /\b(door|road|seat|fold|lane|ladder|owner|law|pin|prover)s?\b/i
const until = async (what: string, test: () => boolean, ms = 15_000): Promise<void> => { const t0 = Date.now(); while (!test()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what); await new Promise(resolve => setTimeout(resolve, 20)) } }
let ssh: ReturnType<typeof fakeSshRunner> | undefined
try {
  const sshModule = await import('../../src/services/host/ssh.ts') as Record<string, any>
  const wordsModule = await import('../../src/commands/llmhost/words.ts') as Record<string, any>
  const { hostRunner, closeHostTunnel } = sshModule
  const engineDeathAfterReadyWords: ((text: string) => { message: string; facts: Record<string, unknown> }) | undefined = sshModule.engineDeathAfterReadyWords
  const shortEngineLine: ((line: string) => string) | undefined = sshModule.shortEngineLine
  const hostEngineDeadChatWords: ((record: Record<string, unknown>) => string) | undefined = wordsModule.hostEngineDeadChatWords
  const hostEngineOomWords: ((facts: Record<string, unknown>) => string) | undefined = wordsModule.hostEngineOomWords
  const { hostMachineName } = wordsModule
  const { runHostJob } = await import('../../src/services/host/worker.ts')
  const { queueHostSetup } = await import('../../src/services/host/jobs.ts')
  const { readHostRecord, hostDirectory, patchHostRecord, removeHostRecord } = await import('../../src/services/host/store.ts')
  const { vendorClient, saveVendorKey } = await import('../../src/services/host/vendors/client.ts')
  const { HOST_IDLE_LIMIT_MS, hostIdleVerdict } = await import('../../src/services/host/idle.ts')
  const { configuredCompatEndpoints } = await import('../../src/services/providers/openaicompat/compatAccounts.ts')
  saveVendorKey('runpod', rp.key)
  const api = vendorClient('runpod', { key: rp.key, apiBaseUrl: rp.baseUrl })
  ssh = fakeSshRunner(f.baseUrl, hostRunner, f.state)
  const healthyLog = ssh.state.log
  const offers = await api.offers(new AbortController().signal)
  const offer = offers.find(row => row.recipe.id === 'qwen38-27b-rtx-pro-6000')!
  assert.ok(offer, 'the fixture catalogue offers the proof recipe')
  const session = 'oom-session'
  const notices = (id: string): { words: string; status: string }[] => {
    const dir = join(hostDirectory(), 'notices')
    try {
      return readdirSync(dir).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(dir, name), 'utf8')) as { sessionId: string; words: string })
        .filter(row => row.sessionId === session && row.words.includes(id)).map(row => ({ words: row.words, status: /<status>([a-z]+)<\/status>/.exec(row.words)?.[1] ?? '' }))
    } catch { return [] }
  }

  const workspace = join(f.home, 'workspace')
  const engineDir = join(workspace, offer.recipe.id)
  mkdirSync(engineDir, { recursive: true })
  writeFileSync(join(engineDir, 'engine.pid'), '2147483646\n')
  writeFileSync(join(engineDir, 'launch.log'), '')
  let dead = false
  let weightsPresent = false
  const probes: string[] = []
  const polls: string[] = []
  const shell = (command: string): Promise<string> => new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve(output) : reject(new Error(output)))
  })
  const runner = {
    tunnel: ssh.runner.tunnel.bind(ssh.runner),
    async run(command: string, args: string[], signal: AbortSignal, timeoutMs?: number): Promise<string> {
      const remote = args.at(-1) ?? ''
      if (command === 'ssh' && remote.startsWith('test -d ')) { probes.push(remote); return weightsPresent ? 'MERCURY_WEIGHTS_PRESENT\n' : '' }
      if (command === 'ssh' && dead && remote.startsWith('tail -n 8 ')) {
        const out = await shell(remote.replaceAll('/workspace/mercury-host', workspace))
        polls.push(out)
        return out
      }
      return ssh!.runner.run(command, args, signal, timeoutMs)
    },
  }

  const ownerRun = [
    'MERCURY_STEP starting engine',
    '[2026-10-23 19:14:05] Use dsv4 attention backend for DeepseekV4ForCausalLM, setting page_size to 256.',
    '[2026-10-23 19:15:04 TP0 EP0] Load weight end. elapsed=39.85 s, type=DeepseekV4ForCausalLM, quant=fp8, avail mem=56.25 GB, mem usage=119.99 GB.',
    '[2026-10-23 19:15:22 TP0 EP0] Memory pool end. avail mem=33.50 GB',
    '[2026-10-23 19:15:47 TP0 EP0] max_total_num_tokens=1754112, chunked_prefill_size=16384, max_prefill_tokens=16384, max_running_requests=256, context_len=1048576, available_gpu_mem=24.70 GB',
    '[2026-10-23 19:16:32 TP0 EP0] Prefill batch, #new-seq: 1, #new-token: 16384, #cached-token: 0, full token usage: 0.02, swa token usage: 0.02, #running-req: 0, #queue-req: 0, #pending-token: 425959, cuda graph: False, input throughput (token/s): 529.73',
    '[2026-10-23 19:16:36 TP0 EP0] Prefill batch, #new-seq: 1, #new-token: 16384, #cached-token: 0, full token usage: 0.09, swa token usage: 0.02, #running-req: 0, #queue-req: 0, #pending-token: 294887, cuda graph: False, input throughput (token/s): 25515.10',
    '[rank1]:[W1023 18:19:08 CUDACachingAllocator.cpp:3933] memory allocation failed with OOM on device 1 while trying to allocate 8904507392 bytes (free: 3974823936, total: 191503007744).',
    '[2026-10-23 19:16:36 TP3 EP3] Scheduler hit an exception: Traceback (most recent call last):',
    '  File "/sgl-workspace/sglang/python/sglang/srt/layers/attention/deepseek_v4_backend.py", line 3262, in _publish_or_consume_candidates',
    '    publish.append(masks[0] if len(masks) == 1 else torch.cat(masks))',
    'torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.75 GiB. GPU 3 has a total capacity of 178.35 GiB of which 2.23 GiB is free.',
    '/workspace/mercury-host/' + offer.recipe.id + "/engine.sh: line 87: 14233 Killed                  'sglang' 'serve' '--model-path' '/workspace/mercury-host/" + offer.recipe.id + "/weights'",
  ]
  const engineLine = 'memory allocation failed with OOM on device 1 while trying to allocate 8.9 GB (free: 4.0 GB, total: 191.5 GB)'
  check('the engine line loses its log prefixes and reads its byte counts in GB', shortEngineLine?.(ownerRun[7]!) === engineLine, shortEngineLine?.(ownerRun[7]!))
  const oomWords = 'the engine ran out of GPU memory at 154k tokens of context · the recipe’s budget was 1M · Resume restarts it; a shorter conversation or the Tune screen’s smaller context fits'
  check('the out-of-memory sentence reads the tokens held and the budget from the engine’s plan and batch lines', hostEngineOomWords?.({ contextTokens: Math.round(0.09 * 1754112), budgetTokens: 1048576 }) === oomWords)

  const pod = await api.create(offer, 'ssh-ed25519 fixture', 'oom-after-ready')
  ssh.state.log = healthyLog
  const record = queueHostSetup({ id: pod.id, vendor: 'runpod', name: pod.name, recipe: offer.recipe.id, price: pod.cost, startedAt: pod.createdAt, status: pod.status, apiBaseUrl: rp.baseUrl, sessionId: session })
  const deletesAtStart = rp.state.deletes
  const createsAtStart = rp.state.creates
  const job = runHostJob(record.id, record.generation!, { runner, pauseMs: 30, timeoutMs: 10_000 })
  await until('ready', () => readHostRecord(pod.id)?.jobState === 'ready')
  const ready = readHostRecord(pod.id)!
  const machine = hostMachineName('runpod', pod.id)
  check('the ready record remembers the folder the engine loaded its weights from', ready.loadedWeights === '/workspace/mercury-host/' + offer.recipe.id + '/weights', JSON.stringify(ready.loadedWeights))
  check('the registered endpoint names its rental', configuredCompatEndpoints().find(row => row.name === ready.provider)?.hostPodId === pod.id)
  const firstScript = ssh.state.script
  check('the first launch downloads the weights', firstScript.includes('hf download'))

  writeFileSync(join(engineDir, 'engine.log'), ownerRun.join('\n') + '\n')
  dead = true
  closeHostTunnel(pod.id)
  await job
  const paused = readHostRecord(pod.id)!
  const posted = notices(pod.id).filter(row => !row.words.includes('ready · /model'))
  for (const row of posted) console.log('  notice · ' + (/<summary>([^]*?)<\/summary>/.exec(row.words)?.[1] ?? row.words))
  const expectedWords = machine + ' · the engine died after setup: ' + engineLine + ' · ' + oomWords + ' · paused, $' + pod.cost.toFixed(2) + '/hr still billing · Resume or Terminate in /llmhost'
  check('the poll ran the product’s own read: the plan, the batch and the cause lines reached the worker', polls.some(out => out.includes('MERCURY_ENGINE_EXITED') && out.includes('MERCURY_ENGINE_PLAN max_total_num_tokens=1754112') && out.includes('MERCURY_ENGINE_BATCH ') && out.includes('MERCURY_ENGINE_CAUSE [rank1]')), polls.at(-1))
  check('an engine death after ready pauses the record with the machine up: no terminate, the pod still listed, status RUNNING', paused.jobState === 'paused' && paused.status === 'RUNNING' && rp.state.deletes === deletesAtStart && rp.state.pods.has(pod.id), JSON.stringify({ jobState: paused.jobState, status: paused.status }))
  check('the record carries the engine’s own facts: the line, the OOM, the tokens held, the budget and the pool', paused.engineDeath?.line === engineLine && paused.engineDeath.oom === true && paused.engineDeath.contextTokens === Math.round(0.09 * 1754112) && paused.engineDeath.budgetTokens === 1048576 && paused.engineDeath.poolTokens === 1754112 && paused.advancedAt === paused.engineDeath.at, JSON.stringify(paused.engineDeath))
  check('the record’s words say what happened in the engine’s terms, never that the shape was too small', paused.error === expectedWords && !paused.error.includes('too small'), paused.error)
  check('the paused step is the last step and names the engine death', paused.step === 'paused · the engine died after setup' && paused.steps?.at(-1)?.step === paused.step)
  check('one paused notice posts the same words with the rate still billing and the two actions', posted.length === 1 && posted[0]!.status === 'stopped' && posted[0]!.words.includes(pod.name + ' · ' + expectedWords), posted.map(row => row.words).join('\n'))
  check('the notice uses no house words and never shows the vendor key', !posted.some(row => houseWords.test(row.words.replace(/<[^>]+>/g, ' ')) || row.words.includes(rp.key)))
  check('the two-hour rule covers the pause: nothing at 1 h 59 min, a paused verdict at 2 h', hostIdleVerdict(paused, paused.advancedAt! + HOST_IDLE_LIMIT_MS - 60_000) === undefined && hostIdleVerdict(paused, paused.advancedAt! + HOST_IDLE_LIMIT_MS)?.kind === 'paused')
  const unit = polls.length ? engineDeathAfterReadyWords?.(polls.at(-1)!) : undefined
  check('the death reader builds the same words from the poll text alone', unit?.message === 'the engine died after setup: ' + engineLine + ' · ' + oomWords && unit.facts.contextTokens === Math.round(0.09 * 1754112), unit?.message)

  const modelId = 'compat/' + ready.provider + '/' + f.model
  const chatLine = paused.engineDeath ? hostEngineDeadChatWords?.({ id: pod.id, vendor: 'runpod', price: pod.cost, engineDeath: paused.engineDeath }) : undefined
  check('the chat line carries the engine’s line, the machine, the rate still billing and the Resume', chatLine === machine + ' · the engine ran out of GPU memory at 154k tokens of context (the recipe’s budget was 1M): ' + engineLine + ' · the machine stays up and bills $' + pod.cost.toFixed(2) + '/hr · Resume in /llmhost restarts the engine; a shorter conversation or the Tune screen’s smaller context fits', chatLine)
  const outage = (events: readonly any[]): any[] => events.filter(event => event?.type === 'system' && event.subtype === 'api_error' && event.error?.networkOutage === true)
  const before = f.events.length
  const t0 = Date.now()
  const turn = await f.run(modelId)
  const chatEvents = f.events.slice(before)
  const said = turn.find(row => row.isApiErrorMessage)
  const content = said?.message?.content?.[0]?.text ?? said?.message?.content
  check('the request answers at once with the one engine line as its API error', turn.length === 1 && said !== undefined && content === chatLine && said.errorDetails === 'host-engine-dead', JSON.stringify(content))
  check('no network outage row and no reconnect wait reach the chat', outage(chatEvents).length === 0 && Date.now() - t0 < 2000 && !JSON.stringify(chatEvents).includes('network unreachable'), JSON.stringify(chatEvents.map(event => event.type + ':' + (event.subtype ?? ''))))

  patchHostRecord(pod.id, { jobState: 'ready', engineDeath: undefined })
  const landing = f.events.length
  const watcher = setInterval(() => { if (outage(f.events.slice(landing)).length) { clearInterval(watcher); patchHostRecord(pod.id, { jobState: 'paused', engineDeath: paused.engineDeath }) } }, 5)
  const t1 = Date.now()
  const late = await f.run(modelId)
  clearInterval(watcher)
  const lateEvents = f.events.slice(landing)
  const lateSaid = late.find(row => row.isApiErrorMessage)
  const lateContent = lateSaid?.message?.content?.[0]?.text ?? lateSaid?.message?.content
  check('a death recorded during the reconnect wait ends the ladder on its next step with the engine line', outage(lateEvents).length >= 1 && lateContent === chatLine && Date.now() - t1 < 5000 && !JSON.stringify(lateEvents).includes('reconnect budget is spent'), JSON.stringify({ outages: outage(lateEvents).length, content: lateContent }))

  ssh.state.log = healthyLog
  dead = false
  weightsPresent = true
  const resumed = queueHostSetup({ ...readHostRecord(pod.id)!, status: 'RUNNING' })
  check('Resume re-queues the paused record with a fresh generation, clears the death and keeps the loaded folder', resumed.jobState === 'queued' && resumed.generation !== paused.generation && resumed.error === undefined && resumed.engineDeath === undefined && resumed.loadedWeights === paused.loadedWeights)
  const commandsBefore = ssh.commands.length
  await runHostJob(resumed.id, resumed.generation!, { runner, pauseMs: 30, timeoutMs: 10_000, keepAlive: false })
  const back = readHostRecord(pod.id)!
  check('the resumed engine reaches ready on the same machine with no new pod and no terminate', back.jobState === 'ready' && back.provider === ready.provider && rp.state.creates === createsAtStart && rp.state.deletes === deletesAtStart && rp.state.pods.has(pod.id), JSON.stringify({ jobState: back.jobState, error: back.error }))
  check('the folder on the machine was checked before it was trusted', probes.length === 1 && probes[0]!.includes("test -d '" + paused.loadedWeights + "'"), probes.join('\n'))
  check('the relaunch starts the engine from the weights already there: no download in the script, the step says so', !ssh.state.script.includes('hf download') && ssh.state.script.includes('weights kept · verified · download skipped') && ssh.state.script.includes(paused.loadedWeights!) && back.steps?.some(row => row.step === 'weights already on the machine · no download') === true && ssh.commands.slice(commandsBefore).some(row => row.args.at(-1)?.includes('nohup setsid')), ssh.state.script.split('\n').filter(line => /download|weights/.test(line)).join(' | '))
  check('a request after Resume goes through again', (await f.run(modelId)).some(row => row.message?.stop_reason))
  closeHostTunnel(pod.id)
  check('OOM proof makes no public network calls', escaped.length === 0)
  removeHostRecord(pod.id)
  if (failures.length) throw new Error(failures.length + ' OOM-after-ready cases failed\n' + failures.join('\n'))
  console.log('ENGINE OOM AFTER READY GREEN · ' + checks + ' checks; the record pauses on the engine’s own words, the chat gets one line and no reconnect ladder, Resume restarts from the weights on the machine; loopback fixtures, zero billable calls')
} finally { globalThis.fetch = nativeFetch; ssh?.close(); await rp.close(); f.close() }
