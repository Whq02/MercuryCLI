import { proofHome } from '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { extensionApi, extensionRequest } from '../../src/cli/extensionApi.ts'
import { hostRecords, readHostRecord } from '../../src/services/host/store.ts'
import { sweepHostJobs } from '../../src/services/host/jobs.ts'
import { hostIdleVerdict, HOST_IDLE_LIMIT_MS } from '../../src/services/host/idle.ts'
import { readBankRegistry } from '../../src/services/host/bank.ts'
import { HOST_RECIPES } from '../../src/services/host/recipes.ts'
import { hostRecipeSchema } from '../../src/services/host/recipesFile.ts'
import { ggufServerPlan } from '../../src/services/localSetup/ggufServer.ts'
import { bankGgufModel } from '../../src/services/localSetup/ggufModels.ts'
import { startHostEngine } from '../../src/services/host/ssh.ts'
import type { HostVendor } from '../../src/services/host/vendors/vendor.ts'
import { ggufHeaderBytes } from './ggufFixture.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_CREDENTIAL_STORE = 'file'
const signal = new AbortController().signal
let created = 0, uncertain = false, now = Date.now()
const pod = { id: 'fixture-external', name: 'Fixture', status: 'RUNNING', cost: 2, createdAt: new Date(now).toISOString(), ssh: { direct: { host: 'fixture.invalid', port: 22, username: 'root' } } }
const vendor = { watchOffer: async (recipe: import('../../src/services/host/recipes.ts').HostRecipe) => ({ recipe, price: 2, gpuId: 'fixture' }), create: async () => { created++; if (uncertain) throw new Error('fixture lost placement response'); return pod }, get: async () => pod } as unknown as HostVendor
const deps = { client: () => vendor, key: async () => ({ path: join(proofHome, 'key'), publicKey: 'ssh-ed25519 Zml4dHVyZQ==' }), now: () => now }
const call = (request: Record<string, unknown>) => extensionApi({ version: 1, ...request }, signal, deps) as Promise<any>
const rental = { ...HOST_RECIPES.find(row => row.engine === 'llamacpp')!, id: 'fixture-compute', model: 'fixture/base', label: 'Fixture', count: 1, nodes: 1, weightsGb: 0, verification: '' }
const quote = await call({ op: 'host.quote', vendor: 'runpod', recipe: rental })
assert.equal(typeof quote.quote, 'string')
assert.equal(quote.offer.price, 2)
assert.equal(typeof quote.storage, 'string')
assert.equal(typeof quote.keyNotice, 'string')
assert.equal(extensionRequest.safeParse({ version: 1, op: 'host.rent', quote: quote.quote, owner: 'fixture-owner', confirmed: false }).success, false)
const connection = await call({ op: 'host.rent', quote: quote.quote, owner: 'fixture-owner', confirmed: true })
assert.equal(connection.pod.id, pod.id)
assert.equal(connection.key, join(proofHome, 'key'))
assert.deepEqual(await call({ op: 'host.rent', quote: quote.quote, owner: 'fixture-owner', confirmed: true }), connection)
assert.equal(created, 1)
await assert.rejects(call({ op: 'host.get', id: pod.id, owner: 'wrong-owner' }), /does not own/)
assert.deepEqual(await call({ op: 'host.get', id: pod.id, owner: 'fixture-owner' }), connection)
assert.equal(readHostRecord(pod.id)?.target?.host, 'fixture.invalid')
assert.deepEqual(await call({ op: 'host.update', id: pod.id, owner: 'fixture-owner', patch: { jobState: 'paused', step: 'paused', error: 'fixture pause' }, notice: { id: 'pause', text: 'Fixture pause' } }), { id: pod.id, updated: true })
const record = readHostRecord(pod.id)!
assert.equal(record.externalJob, 'fixture-owner')
await sweepHostJobs({ records: [record], alive: () => false, launch: async () => { throw new Error('External jobs must not start an inference setup') } })
assert.equal(readHostRecord(pod.id)?.jobState, 'paused')
assert.equal(hostIdleVerdict(record, record.advancedAt! + 60_000), undefined)
assert.equal(hostIdleVerdict(record, record.advancedAt! + HOST_IDLE_LIMIT_MS)?.kind, 'paused')
const expired = await call({ op: 'host.quote', vendor: 'vast', recipe: rental })
now += 6 * 60_000
await assert.rejects(call({ op: 'host.rent', quote: expired.quote, owner: 'expired', confirmed: true }), /expired/)
assert.equal(created, 1)
const unsure = await call({ op: 'host.quote', vendor: 'vast', recipe: rental })
uncertain = true
await assert.rejects(call({ op: 'host.rent', quote: unsure.quote, owner: 'uncertain', confirmed: true }), /lost placement/)
await assert.rejects(call({ op: 'host.rent', quote: unsure.quote, owner: 'uncertain', confirmed: true }), /uncertain/)
assert.equal(created, 2)
assert.equal(hostRecords().length, 1)
console.log('PASS rental JSON: quote, explicit confirmation, replay, ownership, uncertain placement, external recovery and two-hour pause')

const folder = join(proofHome, 'bank')
const model = ggufHeaderBytes({ architecture: 'qwen35moe', kv: { 'qwen35moe.block_count': 40, 'qwen35moe.context_length': 131072, 'qwen35moe.attention.head_count': 16, 'qwen35moe.attention.head_count_kv': 2, 'qwen35moe.embedding_length': 2048, 'qwen35moe.full_attention_interval': 4 }, tensors: ['blk.0.attn_norm.weight'] })
const files = { 'model.gguf': model, 'chat.jinja': Buffer.from('{{ messages }}') }
const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')
const bankRecipe = { ...HOST_RECIPES.find(row => row.engine === 'llamacpp')!, id: 'fixture-bank', model: 'local/Fixture', weightsGb: Object.values(files).reduce((sum, file) => sum + file.length, 0) / 1e9, weightFile: 'model.gguf', include: 'model.gguf', chatTemplateFile: 'chat.jinja', mmproj: undefined, weightManifest: { model: 'local/Fixture', revision: 'a'.repeat(40), include: 'model.gguf', files: Object.entries(files).map(([path, data]) => ({ path, size: data.length, sha256: sha(data) })) } }
for (const path of ['../escape', '/absolute', 'C:/absolute', 'a\\b']) assert.equal(hostRecipeSchema.safeParse({ ...bankRecipe, chatTemplateFile: path }).success, false)
const plan = await call({ op: 'bank.plan', folder, recipe: bankRecipe })
assert.equal(plan.exists, false)
assert.equal(plan.folder, folder)
assert.equal(plan.path, join(folder, 'local--Fixture'))
mkdirSync(plan.path, { recursive: true })
for (const [name, bytes] of Object.entries(files)) writeFileSync(join(plan.path, name), bytes)
writeFileSync(join(plan.path, 'SHA256SUMS'), Object.entries(files).map(([name, data]) => sha(data) + '  ' + name + '\n').join(''))
writeFileSync(join(plan.path, 'chat.jinja'), 'changed')
await assert.rejects(call({ op: 'bank.register', folder, recipe: bankRecipe }), /differs/)
assert.deepEqual(readBankRegistry().models, {})
writeFileSync(join(plan.path, 'chat.jinja'), files['chat.jinja'])
const registered = await call({ op: 'bank.register', folder, recipe: bankRecipe })
assert.equal(registered.registered, true)
assert.equal(registered.path, plan.path)
assert.ok(readBankRegistry().models[registered.key])
await assert.rejects(call({ op: 'bank.register', folder, recipe: bankRecipe }), /already exists/)
const gguf = await bankGgufModel(bankRecipe, folder, 64 * 1024 ** 3, process.platform, signal)
const local = await ggufServerPlan(gguf, folder, { serverCommand: 'fixture-server', cwd: proofHome })
assert.equal(local.args[local.args.indexOf('--chat-template-file') + 1], join(plan.path, 'chat.jinja'))
assert.ok(!local.args.includes('--lora'))
const commands: string[] = []
const runner = { async run(_command: string, args: string[]) { commands.push(args.at(-1)!); return 'MERCURY_PREBUILT_ENGINE yes' }, tunnel(): never { throw new Error('no tunnel') } }
for (const kept of [undefined, '/fixture/kept']) {
  commands.length = 0
  await startHostEngine({ host: 'fixture' }, bankRecipe, runner, signal, false, true, kept ? undefined : plan.path, kept)
  const script = commands.findLast(text => text.includes('nohup setsid'))!.replaceAll("'\\''", "'")
  assert.ok(script.includes("'--chat-template-file' '" + (kept ?? '/workspace/mercury-host/' + bankRecipe.id + '/weights') + "/chat.jinja'"))
  assert.ok(!script.includes('--lora'))
}
console.log('PASS Bank JSON: plan, checksum refusal without registry write, registration, duplicate refusal and both template readers')

const cli = (input: unknown) => spawnSync(process.execPath, [join(import.meta.dirname, '../../src/entrypoints/cli.tsx'), 'extension-api', '--json'], { cwd: proofHome, env: { ...process.env, MERCURY_CONFIG_DIR: proofHome, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none' }, input: JSON.stringify(input), encoding: 'utf8', timeout: 120_000 })
for (const input of [{ version: 2, op: 'context', project: proofHome }, { version: 1, op: 'unknown' }, { version: 1, op: 'context', project: proofHome, extra: true }]) {
  const result = cli(input)
  assert.equal(result.status, 1, result.stderr)
  assert.equal(JSON.parse(result.stdout).ok, false)
}
const context = cli({ version: 1, op: 'context', project: proofHome })
assert.equal(context.status, 0, context.stderr)
const reading = JSON.parse(context.stdout)
assert.equal(reading.version, 1)
assert.equal(reading.ok, true)
assert.ok(reading.result.tools.some((tool: any) => tool.function.name === 'Read'))
assert.match(reading.result.engine.revision, /^[a-f0-9]{40}$/)
assert.equal(typeof reading.result.projectDir, 'string')
writeFileSync(join(proofHome, '.provider-secrets.json'), JSON.stringify({ fixture: { apiKey: 'fixture-opaque-credential' } }))
const scrubbed = cli({ version: 1, op: 'redact', value: { text: 'fixture-opaque-credential', 'fixture-opaque-credential': 'private key name', schema: { properties: { api_key: { type: 'string' } } } } })
assert.equal(scrubbed.status, 0, scrubbed.stderr)
assert.equal(JSON.parse(scrubbed.stdout).result.value.text, '[redacted]')
assert.equal(JSON.parse(scrubbed.stdout).result.value['[redacted]'], 'private key name')
assert.equal(JSON.parse(scrubbed.stdout).result.value.schema.properties.api_key.type, 'string')
console.log('PASS CLI JSON framing, strict request schemas, context and opaque credential redaction without schema damage')
