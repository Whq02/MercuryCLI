#!/usr/bin/env bun
import { mock } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { hfEndpointsFixture } from './hfEndpointsFixture.mjs'
import { fakeSshRunner, runpodFixture } from './runpodFixture.mjs'

const SELF = 'scripts/host/prove-host-job-recording.ts'
const UNIT = 'runHostJob'
const RECORDING = join(import.meta.dir, 'recordings', 'host-job.txt')
const SCENE_BOUND_MS = 30_000
const REPEAT_AT_MOST = 12

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const guard = setTimeout(() => {
  console.log(`\n  [FAIL] ${SELF} did not end within 240 s`)
  process.exit(1)
}, 240_000)
guard.unref?.()

const f = await llmhostFixture()
const rp = await runpodFixture()
const hf = await hfEndpointsFixture()
const HF_KEY_AFTER = hf.key + '-after-a-new-sign-in'
const CREDENTIAL_GONE = '00000000-0000-4000-8000-000000000000'

type HostRecord = import('../../src/models/hosting/store.ts').HostRecord
type Options = NonNullable<Parameters<typeof import('../../src/models/hosting/worker.ts').runHostJob>[2]>

const events: string[] = []
const logs = new Map<string, number>()
let scening = false
let patching = 0
let beforeRequest: ((who: string, method: string, path: string, key: string) => void) | undefined
let beforePatch: ((id: string, patch: Partial<HostRecord>) => void) | undefined

const CONFIG_HOME = process.env.MERCURY_CONFIG_DIR!
const secretsShown: ReadonlyArray<readonly [string, string]> = [[HF_KEY_AFTER, '<the Hugging Face key after a new sign-in>'], [hf.key, '<the Hugging Face key>'], [rp.key, '<the Runpod key>']]
const regexOf = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
function pathMasked(text: string, path: string, shown: string): string {
  if (process.platform !== 'win32') return text.split(path).join(shown).split(path.replace(/^\/private/, '')).join(shown)
  let out = text
  for (const [form, sep] of [[JSON.stringify(path).slice(1, -1), '\\\\'], [path, '\\'], [path.replaceAll('\\', '/'), '/']] as const) {
    const separator = `(?:${regexOf(sep)}|/)`
    out = out.replace(new RegExp(`${regexOf(form)}((?:${separator}[^\\s"'\\\\/]+)*)`, 'g'), (_, under: string) => shown + under.replace(new RegExp(separator, 'g'), '/'))
  }
  return out
}
function mask(text: string): string {
  let out = pathMasked(text, f.home, '<home>')
  out = pathMasked(out, CONFIG_HOME, '<config home>')
  for (const [secret, shown] of secretsShown) out = out.split(secret).join(shown)
  return out
    .replace(/mercury-[0-9a-f-]{12}/g, 'mercury-<id>')
    .replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:<port>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<time>')
    .replace(/~\$[\d,.]+ so far/g, '~$<spent> so far')
    .replace(/\n/g, ' \\n ')
}
function shown(value: unknown): string {
  if (value === undefined) return 'undefined'
  return mask(JSON.stringify(value, (key, inner) => (key === 'advancedAt' || key === 'at' ? '<at>' : key === 'localPort' || key === 'port' ? '<port>' : inner)))
}
function patchShown(patch: Partial<HostRecord>): string {
  return Object.entries(patch)
    .map(([key, value]) => (key === 'steps' ? `steps+=${shown((value as HostRecord['steps'])?.at(-1)?.step)}` : key === 'advancedAt' ? 'advancedAt=<at>' : key === 'localPort' ? 'localPort=<port>' : `${key}=${shown(value)}`))
    .join(' ')
}
function flushLogs(): void {
  for (const [path, read] of logs) {
    if (!existsSync(path)) continue
    const text = readFileSync(path, 'utf8')
    logs.set(path, text.length)
    for (const line of text.slice(read).split('\n')) if (line !== '') pushed(`log ${mask(line)}`)
  }
}
function pushed(line: string): void {
  if (events.at(-1) !== line) events.push(line)
}
function say(line: string): void {
  if (!scening) return
  flushLogs()
  pushed(line)
}
function folded(lines: readonly string[]): string[] {
  let out = [...lines]
  for (let moved = true; moved; ) {
    moved = false
    for (let size = 1; size <= REPEAT_AT_MOST && !moved; size++) {
      for (let at = 0; at + 2 * size <= out.length && !moved; at++) {
        if (out.slice(at, at + size).join('\n') !== out.slice(at + size, at + 2 * size).join('\n')) continue
        out = [...out.slice(0, at + size), ...out.slice(at + 2 * size)]
        moved = true
      }
    }
  }
  return out
}

const store = { ...(await import('../../src/models/hosting/store.ts')) }
const noticesOfTheProduct = { ...(await import('../../src/models/hosting/notices.ts')) }
mock.module('../../src/models/hosting/store.ts', () => ({
  ...store,
  patchHostRecord: (id: string, patch: Partial<HostRecord>) => {
    if (scening) beforePatch?.(id, patch)
    say(`record ${id} patch ${patchShown(patch)}`)
    patching++
    try {
      const patched = store.patchHostRecord(id, patch)
      return patched
    } finally {
      patching--
    }
  },
  removeHostRecord: (id: string) => {
    say(`record ${id} remove`)
    store.removeHostRecord(id)
  },
  writeHostRecord: (record: HostRecord) => {
    if (patching === 0) say(`record ${mask(record.id)} write jobKind=${record.jobKind} jobState=${record.jobState} step=${shown(record.step)} watchedFrom=${shown(record.watchedFrom)} sshKey=${shown(record.sshKey)}`)
    if (scening && record.log) logs.set(record.log, logs.get(record.log) ?? 0)
    store.writeHostRecord(record)
  },
}))
mock.module('../../src/models/hosting/notices.ts', () => ({
  ...noticesOfTheProduct,
  hostNotice: (record: HostRecord, kind: string, words: string) => {
    say(`notice ${kind} for ${mask(record.id)}: ${mask(words)}`)
    noticesOfTheProduct.hostNotice(record, kind, words)
  },
}))

const nativeFetch = globalThis.fetch
const escaped: string[] = []
globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  const toHuggingFace = url.origin === 'https://api.endpoints.huggingface.cloud' || url.origin === 'https://huggingface.co'
  if (!toHuggingFace && !['127.0.0.1', '[::1]'].includes(url.hostname)) {
    escaped.push(url.origin)
    throw new Error(`${SELF} permits loopback fixtures only`)
  }
  const who = toHuggingFace || url.origin === hf.origin ? 'Hugging Face' : url.origin === new URL(rp.baseUrl).origin ? 'Runpod' : url.origin === new URL(f.baseUrl).origin ? 'the model' : 'the tunnel'
  const key = request.headers.get('authorization') === null ? 'no key' : mask(request.headers.get('authorization')!.replace(/^Bearer /, ''))
  beforeRequest?.(who, request.method, url.pathname, key)
  say(`request ${request.method} ${who} ${mask(url.pathname)}`)
  return toHuggingFace ? nativeFetch(new Request(hf.origin + url.pathname + url.search, request)) : nativeFetch(request)
}, nativeFetch)

const worker = await import('../../src/models/hosting/worker.ts')
const { queueHostBank, queueHostSetup, queueHostWatch } = await import('../../src/models/hosting/jobs.ts')
const { hostRecords } = await import('../../src/models/hosting/store.ts')
const { hostRunner, closeHostTunnel } = await import('../../src/models/hosting/ssh.ts')
const { HOST_RECIPES } = await import('../../src/models/hosting/recipes.ts')
const { saveVendorKey, vendorClient } = await import('../../src/models/hosting/vendors/client.ts')
const { HuggingfaceClient } = await import('../../src/models/hosting/vendors/huggingface.ts')
const { writeStoredHuggingfaceApiKey } = await import('../../src/models/sign-in/account-ledger/providerSecrets.ts')
const { getAuthConfigHomeDir } = await import('../../src/platform/environment/envUtils.ts')

const ssh = fakeSshRunner(f.baseUrl, hostRunner)
const noShell = { async run(): Promise<string> { throw new Error('a managed endpoint never uses SSH') }, tunnel(): never { throw new Error('a managed endpoint never tunnels') } }
const refusingAfterTheProbe = (words: string): typeof ssh.runner => ({
  ...ssh.runner,
  run: (command: string, args: string[], signal: AbortSignal, timeoutMs?: number): Promise<string> =>
    command === 'ssh' && args.at(-1) !== 'true' ? Promise.reject(new Error(words)) : ssh.runner.run(command, args, signal, timeoutMs),
})
const signal = new AbortController().signal
const lines: string[] = []

function recordShown(id: string): string {
  const record = store.readHostRecord(id)
  if (!record) return `record ${mask(id)}: gone`
  return `record ${mask(id)}: jobKind=${record.jobKind} jobState=${record.jobState} status=${record.status} step=${shown(record.step)} error=${shown(record.error)} steps=${shown(record.steps?.map(row => row.step))}`
}

async function scene(name: string, play: () => Promise<string[]>): Promise<void> {
  events.length = 0
  logs.clear()
  beforeRequest = undefined
  beforePatch = undefined
  let ends: string[] = []
  try {
    ends = await play()
  } finally {
    flushLogs()
    scening = false
    beforeRequest = undefined
    beforePatch = undefined
  }
  lines.push(`== ${name}`, ...folded(events).map(line => `  ${line}`), ...ends.map(id => `  at the end, ${recordShown(id)}`))
  for (const record of hostRecords()) {
    closeHostTunnel(record.id)
    store.removeHostRecord(record.id)
  }
}

async function ran(record: HostRecord, options: Options): Promise<void> {
  if (record.log) logs.set(record.log, 0)
  scening = true
  let bound: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    bound = setTimeout(() => reject(new Error(`${record.id}: the job did not end within ${SCENE_BOUND_MS} ms: ${recordShown(record.id)}`)), SCENE_BOUND_MS)
  })
  try {
    await Promise.race([worker.runHostJob(record.id, record.generation!, options), late])
    say('the job ended')
  } finally {
    clearTimeout(bound)
  }
}

const podRecipe = HOST_RECIPES.find(row => row.id === 'qwen38-27b-rtx-pro-6000')!
const watchRecipe = HOST_RECIPES.find(row => row.gpu === 'RTX PRO 6000' && row.engine === 'llamacpp')!
const endpointRecipe = HOST_RECIPES.find(row => row.id === 'qwen38-27b-h200')!
const started = (): string => new Date().toISOString()
const watchOf = (id: string, extra: Partial<HostRecord> = {}): HostRecord =>
  queueHostWatch({ id, name: watchRecipe.label, recipe: watchRecipe.id, recipeRow: watchRecipe, price: 10, status: 'WATCHING', startedAt: started(), apiBaseUrl: rp.baseUrl, sessionId: `session-${id}`, ...extra })

await scene('a setup whose vendor key is not saved', async () => {
  const record = queueHostSetup({ id: 'no-vendor-key', vendor: 'vast', name: 'no-vendor-key', recipe: podRecipe.id, recipeRow: podRecipe, price: 1.25, startedAt: started(), status: 'RUNNING', sessionId: 'session-no-vendor-key' })
  await ran(record, { runner: ssh.runner, pauseMs: 5, timeoutMs: 5000, keepAlive: false })
  return [record.id]
})

await scene('a managed setup whose saved Hugging Face credential is gone', async () => {
  const id = 'hf-credential-gone'
  const record = queueHostSetup({ id, vendor: 'huggingface', name: id, recipe: endpointRecipe.id, recipeRow: endpointRecipe, price: 5, startedAt: started(), status: 'PROVISIONING', apiBaseUrl: hf.baseUrl, sessionId: `session-${id}`, huggingfaceCredential: { home: getAuthConfigHomeDir(), source: 'captured', id: CREDENTIAL_GONE, job: id } })
  await ran(record, { runner: noShell, pauseMs: 5, timeoutMs: 5000, keepAlive: false })
  return [record.id]
})

saveVendorKey('runpod', rp.key)
const runpod = vendorClient('runpod', { key: rp.key, apiBaseUrl: rp.baseUrl })
const podOffer = (await runpod.offers(signal)).find(row => row.recipe.id === podRecipe.id)!
const podSetup = async (name: string, extra: Partial<HostRecord> = {}): Promise<HostRecord> => {
  const pod = await runpod.create(podOffer, 'ssh-ed25519 fixture', name)
  return queueHostSetup({ id: pod.id, vendor: 'runpod', name: pod.name, recipe: podOffer.recipe.id, price: pod.cost, startedAt: pod.createdAt, status: pod.status, apiBaseUrl: rp.baseUrl, sessionId: `session-${name}`, ...extra })
}

await scene('a private repository with no Hugging Face sign-in', async () => {
  const record = await podSetup('private-repo-no-sign-in', { weightsSource: { kind: 'private-repo', repo: 'fixture-owner/private-weights' } })
  await ran(record, { runner: ssh.runner, pauseMs: 5, timeoutMs: 5000, keepAlive: false })
  return [record.id]
})

await scene('a private repository whose saved Hugging Face credential is gone', async () => {
  const pod = await runpod.create(podOffer, 'ssh-ed25519 fixture', 'private-repo-credential-gone')
  const record = queueHostSetup({ id: pod.id, vendor: 'runpod', name: pod.name, recipe: podOffer.recipe.id, price: pod.cost, startedAt: pod.createdAt, status: pod.status, apiBaseUrl: rp.baseUrl, sessionId: 'session-private-repo-credential-gone', weightsSource: { kind: 'private-repo', repo: 'fixture-owner/private-weights' }, huggingfaceCredential: { home: getAuthConfigHomeDir(), source: 'captured', id: CREDENTIAL_GONE, job: pod.id } })
  await ran(record, { runner: ssh.runner, pauseMs: 5, timeoutMs: 5000, keepAlive: false })
  return [record.id]
})

await scene('a setup whose endpoint lists no model', async () => {
  const record = await podSetup('no-model-listed')
  f.state.listed = false
  try {
    await ran(record, { runner: ssh.runner, pauseMs: 5, timeoutMs: 8000, keepAlive: false })
  } finally {
    f.state.listed = true
  }
  return [record.id]
})

await scene('a setup whose machine names the vendor key in its refusal', async () => {
  const record = await podSetup('machine-names-the-key')
  await ran(record, { runner: refusingAfterTheProbe('ssh exited 255. the machine refused and named the key ' + rp.key), pauseMs: 5, timeoutMs: 8000, keepAlive: false })
  return [record.id]
})

await scene('a private repository whose download names the Hugging Face key in its failure', async () => {
  writeStoredHuggingfaceApiKey(hf.key)
  try {
    const record = await podSetup('download-names-the-key', { weightsSource: { kind: 'private-repo', repo: 'fixture-owner/private-weights' } })
    await ran(record, { runner: refusingAfterTheProbe('ssh exited 1. the machine refused and named the sign-in ' + hf.key), pauseMs: 5, timeoutMs: 8000, keepAlive: false })
    return [record.id]
  } finally {
    writeStoredHuggingfaceApiKey(null)
  }
})

await scene('a managed endpoint kept alive through a new sign-in, then refused', async () => {
  writeStoredHuggingfaceApiKey(hf.key)
  const api = new HuggingfaceClient(hf.key, hf.baseUrl, { pollMs: 5, readyTimeoutMs: 40 })
  const offer = (await api.offers(signal)).find(row => row.recipe.id === endpointRecipe.id)!
  const pod = await api.create(offer, '', 'hf-kept-alive')
  const record = queueHostSetup({ id: pod.id, vendor: 'huggingface', name: pod.name, recipe: offer.recipe.id, recipeRow: offer.recipe, price: offer.price, startedAt: pod.createdAt, status: pod.status, apiBaseUrl: hf.baseUrl, sessionId: 'session-hf-kept-alive' })
  let beats = 0
  beforeRequest = (who, method, path, key) => {
    if (who !== 'Hugging Face' || method !== 'GET' || path !== '/v1/models' || store.readHostRecord(pod.id)?.jobState !== 'ready') return
    say(`keep-alive read ${++beats > 2 ? 'after the second' : beats} carries ${key}`)
    if (beats === 1) writeStoredHuggingfaceApiKey(HF_KEY_AFTER)
  }
  try {
    await ran(record, { runner: noShell, pauseMs: 5, timeoutMs: 5000 })
  } finally {
    writeStoredHuggingfaceApiKey(null)
  }
  return [record.id]
})

await scene('a setup stopped as its tunnel opens', async () => {
  const record = await podSetup('stopped-at-the-tunnel')
  let stopped = false
  beforePatch = (id, patch) => {
    if (stopped || id !== record.id || patch.localPort === undefined) return
    stopped = true
    say('the setup is stopped as this write lands')
    store.patchHostRecord(id, { jobState: 'stopped' })
  }
  await ran(record, { runner: ssh.runner, pauseMs: 5, timeoutMs: 8000, keepAlive: false })
  return [record.id]
})

await scene('a managed setup whose Hugging Face sign-in is removed before the provider asks for its key', async () => {
  writeStoredHuggingfaceApiKey(hf.key)
  const api = new HuggingfaceClient(hf.key, hf.baseUrl, { pollMs: 5, readyTimeoutMs: 40 })
  const offer = (await api.offers(signal)).find(row => row.recipe.id === endpointRecipe.id)!
  const pod = await api.create(offer, '', 'hf-sign-in-removed')
  const record = queueHostSetup({ id: pod.id, vendor: 'huggingface', name: pod.name, recipe: offer.recipe.id, recipeRow: offer.recipe, price: offer.price, startedAt: pod.createdAt, status: pod.status, apiBaseUrl: hf.baseUrl, sessionId: 'session-hf-sign-in-removed' })
  let reads = 0
  beforeRequest = (who, method, path) => {
    if (who !== 'Hugging Face' || method !== 'GET' || !path.startsWith('/v2/endpoint/') || ++reads !== 2) return
    say('the Hugging Face sign-in is removed while this read is on its way')
    writeStoredHuggingfaceApiKey(null)
  }
  try {
    await ran(record, { runner: noShell, pauseMs: 5, timeoutMs: 5000, keepAlive: false })
  } finally {
    writeStoredHuggingfaceApiKey(null)
  }
  return [record.id]
})

await scene('a watch whose vendor refuses the key', async () => {
  saveVendorKey('runpod', 'a-key-the-vendor-does-not-know')
  const record = watchOf('watch-key-refused')
  try {
    await ran(record, { runner: ssh.runner, pauseMs: 5, timeoutMs: 2000, keepAlive: false })
  } finally {
    saveVendorKey('runpod', rp.key)
  }
  return [record.id]
})

await scene('a watch stopped while it reads the stock', async () => {
  const record = watchOf('watch-stopped-mid-read')
  let stopped = false
  beforeRequest = (who, method, path) => {
    if (stopped || who !== 'Runpod' || method !== 'GET' || path !== '/v2/catalog/gpus') return
    stopped = true
    say('the watch is stopped while this read is on its way')
    store.patchHostRecord(record.id, { jobState: 'stopped' })
  }
  await ran(record, { runner: ssh.runner, pauseMs: 5000, timeoutMs: 20_000, keepAlive: false })
  return [record.id]
})

await scene('a watch that finds no stock at its price until its window ends', async () => {
  const record = watchOf('watch-no-stock-at-the-price', { price: 0.01 })
  await ran(record, { runner: ssh.runner, pauseMs: 5, timeoutMs: 600, keepAlive: false })
  return [record.id]
})

await scene('a watch that finds stock its weights disk cannot reach, until its window ends', async () => {
  const record = watchOf('watch-volume-elsewhere', { weightsSource: { kind: 'volume', volumeId: 'a-volume-kept-elsewhere' } })
  await ran(record, { runner: ssh.runner, pauseMs: 5, timeoutMs: 2000, keepAlive: false })
  return [record.id]
})

await scene('a watch stopped as it marks the create', async () => {
  const record = watchOf('watch-stopped-at-the-mark')
  let stopped = false
  beforePatch = (id, patch) => {
    if (stopped || id !== record.id || !patch.creating) return
    stopped = true
    say('the watch is stopped as this write lands')
    store.patchHostRecord(id, { jobState: 'stopped' })
  }
  await ran(record, { runner: ssh.runner, pauseMs: 5, timeoutMs: 5000, keepAlive: false })
  return [record.id]
})

await scene('a watch whose every create is refused for placement, until its window ends', async () => {
  const record = watchOf('watch-never-placed')
  rp.state.failCreate = true
  try {
    await ran(record, { runner: ssh.runner, pauseMs: 5, timeoutMs: 1000, keepAlive: false })
  } finally {
    rp.state.failCreate = false
  }
  return [record.id]
})

await scene('a watch whose stock read fails twice, is refused a place, fails once more and is then refused for payment', async () => {
  const record = watchOf('watch-read-failures')
  const failing = (times: number): void => { rp.state.failNext = { route: 'GET /v2/catalog/gpus', status: 503, times } }
  failing(2)
  rp.state.createOutcomes.push('refuse', 'refuse402')
  let creates = 0
  beforeRequest = (who, method, path) => {
    if (who === 'Runpod' && method === 'POST' && path === '/v2/pods' && ++creates === 1) failing(1)
  }
  try {
    await ran(record, { runner: ssh.runner, pauseMs: 260, timeoutMs: 30_000, keepAlive: false })
  } finally {
    rp.state.failNext = null
  }
  return [record.id]
})

await scene('a watch whose create gets no clear answer', async () => {
  const record = watchOf('watch-create-unclear')
  rp.state.createOutcomes.push('http503')
  await ran(record, { runner: ssh.runner, pauseMs: 5, timeoutMs: 5000, keepAlive: false })
  return [record.id]
})

await scene('a watch whose create is refused for payment', async () => {
  const record = watchOf('watch-create-unpaid')
  rp.state.createOutcomes.push('refuse402')
  await ran(record, { runner: ssh.runner, pauseMs: 5, timeoutMs: 5000, keepAlive: false })
  return [record.id]
})

await scene('a watch that rents a pod and sets it up', async () => {
  const record = watchOf('watch-rents-and-sets-up')
  await ran(record, { runner: ssh.runner, pauseMs: 5, timeoutMs: 8000, keepAlive: false })
  return [record.id, `fixture-pod-${rp.state.creates}`]
})

await scene('a watch that rents a pod it cannot record', async () => {
  const record = watchOf('watch-rented-unrecorded')
  const inTheWay = join(store.hostDirectory(), 'pods', `fixture-pod-${rp.state.creates + 1}.json`)
  beforeRequest = (who, method, path) => {
    if (who !== 'Runpod' || method !== 'POST' || path !== '/v2/pods') return
    say('a folder stands where the rented pod is to be recorded')
    mkdirSync(inTheWay, { recursive: true })
  }
  try {
    await ran(record, { runner: ssh.runner, pauseMs: 5, timeoutMs: 5000, keepAlive: false })
  } finally {
    rmSync(inTheWay, { recursive: true, force: true })
  }
  return [record.id]
})

const bankOf = (id: string, extra: Partial<HostRecord>): HostRecord =>
  queueHostBank({ id, name: id, recipe: podRecipe.id, recipeRow: podRecipe, price: 0, startedAt: started(), status: 'BANKING', sessionId: `session-${id}`, ...extra })

await scene('a bank check on a folder that holds no sums', async () => {
  const folder = join(f.home, 'a-bank-with-no-sums')
  mkdirSync(folder, { recursive: true })
  const record = bankOf('bank-check-no-sums', { bankTask: 'verify', bankFolder: folder, status: 'VERIFYING' })
  await ran(record, { runner: ssh.runner, pauseMs: 5, timeoutMs: 5000, keepAlive: false })
  return [record.id]
})

await scene('a banking whose folder cannot be made and is named with the Hugging Face key', async () => {
  const inTheWay = join(f.home, 'a-file-where-the-bank-is-to-stand')
  writeFileSync(inTheWay, '')
  writeStoredHuggingfaceApiKey(hf.key)
  try {
    const record = bankOf('bank-folder-in-the-way', { bankTask: 'bank', bankFolder: join(inTheWay, hf.key) })
    await ran(record, { runner: ssh.runner, pauseMs: 5, timeoutMs: 5000, keepAlive: false })
    return [record.id]
  } finally {
    writeStoredHuggingfaceApiKey(null)
    rmSync(inTheWay, { force: true })
  }
})

globalThis.fetch = nativeFetch
ssh.close()
await rp.close()
await hf.close()
f.close()

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const text = lines.join('\n') + '\n'
if (process.argv.includes('--write')) {
  mkdirSync(dirname(RECORDING), { recursive: true })
  writeFileSync(RECORDING, text)
  console.log(`wrote ${lines.filter(line => line.startsWith('== ')).length} scenes, ${lines.length} lines to ${RECORDING}`)
  process.exit(0)
}

check(`the unit under the recording is the product's own ${UNIT} of src/models/hosting/worker.ts; two modules beside it are wrapped, each export calling the product's own and noting the call (store.ts: patchHostRecord, removeHostRecord, writeHostRecord; notices.ts: hostNotice)`, worker.runHostJob.name === UNIT)
check('every request stayed on a loopback fixture', escaped.length === 0, escaped.join(', '))
const recorded = existsSync(RECORDING) ? readFileSync(RECORDING, 'utf8') : null
if (recorded === null) check(`the recording stands at ${RECORDING}`, false, `bun ${SELF} --write records it`)
else {
  const was = recorded.split('\n')
  const now = text.split('\n')
  let at = 0
  while (at < was.length && at < now.length && was[at] === now[at]) at++
  const sceneAt = [...now.slice(0, at + 1)].reverse().find(line => line.startsWith('== ')) ?? '== the opening'
  check(
    `${UNIT} behaves as recorded in scripts/host/recordings/host-job.txt (this run: ${lines.filter(line => line.startsWith('== ')).length} scenes, ${lines.length} lines)`,
    recorded === text,
    `the recorded behaviour of ${UNIT} changed in "${sceneAt.slice(3)}" at line ${at + 1} | recorded: ${(was[at] ?? '<the recording ends>').trim().slice(0, 400)} | now: ${(now[at] ?? '<the run ends>').trim().slice(0, 400)} — when the change is meant, bun ${SELF} --write records it again`,
  )
}
console.log(failures === 0 ? `\n${SELF}: ${UNIT} behaves as recorded` : `\n${SELF}: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
