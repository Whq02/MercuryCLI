import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pinSourceRef } from '../lib/settingsPopupHarness.ts'

const home = process.env.MERCURY_CONFIG_DIR
assert.ok(home && !resolve(home).startsWith(join(homedir(), '.mercury')), 'a scratch config home outside the real config is required')
mkdirSync(home, { recursive: true })
delete process.env.MERCURY_HOME
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
pinSourceRef()
let checks = 0
const check = (name: string, value: unknown) => { assert.ok(value, name); checks++; console.log('PASS ' + name) }
const root = resolve(import.meta.dir, '../..')
const sha256 = (text: string): string => 'sha256:' + createHash('sha256').update(text).digest('hex')

const { parseGgufHeader, compareGgufWithEngine, checkGgufAgainstEngine, LLAMACPP_ENGINE_TABLE } = await import('../../src/services/host/ggufHeader.ts')
const { LLAMACPP_ENGINE_SHA, LLAMACPP_ENGINE_IMAGE } = await import('../../src/services/host/recipes.ts')
const { engineProblems, imageStampProblems, readRegistryImage } = await import('./export-llamacpp-engine.ts')
const asset = JSON.parse(readFileSync(join(root, 'assets/host/llamacpp-engine.json'), 'utf8')) as Parameters<typeof engineProblems>[0]['asset']
const dockerfile = readFileSync(join(root, 'scripts/host/Dockerfile.llamacpp'), 'utf8')
const workflow = readFileSync(join(root, '.github/workflows/engine-image.yml'), 'utf8')
const short = LLAMACPP_ENGINE_SHA.slice(0, 7)
const table = LLAMACPP_ENGINE_TABLE
const ids = Object.values(table.types)
const removed = [4, 5, 31, 32, 33, 36, 37, 38]

check('the table names the tensor types of the pinned ggml.h: ids below GGML_TYPE_COUNT, the retired ids absent', table.llamacpp === LLAMACPP_ENGINE_SHA && ids.length >= 30 && table.typeCount === Math.max(...ids) + 1 && table.types.F32 === 0 && table.types.Q4_K === 12 && table.types.BF16 === 30 && table.types.MXFP4 === 39 && removed.every(id => !ids.includes(id)))
check('the image stamp pairs the served digest in recipes.ts with the pinned commit and says it is registry metadata, not a boot test', asset.image !== undefined && asset.image.ref + '@' + asset.image.digest === LLAMACPP_ENGINE_IMAGE && asset.image.revision === LLAMACPP_ENGINE_SHA && asset.image.cudaArchitectures === '100;103;120' && /not a boot test/.test(asset.image.evidence) && /^\d{4}-\d{2}-\d{2}$/.test(asset.image.readOn))

const u32 = (value: number) => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes }
const u64 = (value: number) => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(BigInt(value)); return bytes }
const text = (value: string) => { const bytes = Buffer.from(value, 'utf8'); return Buffer.concat([u64(bytes.length), bytes]) }
type Tensor = { name: string; type?: number; dims?: number[] }
function gguf(architecture: string | undefined, kv: Record<string, number | string>, tensors: readonly Tensor[]): Uint8Array {
  const entries = Object.entries({ ...(architecture ? { 'general.architecture': architecture } : {}), ...kv })
  const parts = [Buffer.from('GGUF'), u32(3), u64(tensors.length), u64(entries.length)]
  for (const [key, value] of entries) { parts.push(text(key)); if (typeof value === 'number') parts.push(u32(4), u32(value)); else parts.push(u32(8), text(value)) }
  for (const tensor of tensors) { const dims = tensor.dims ?? [4096, 4096]; parts.push(text(tensor.name), u32(dims.length)); for (const dim of dims) parts.push(u64(dim)); parts.push(u32(tensor.type ?? 0), u64(0)) }
  return new Uint8Array(Buffer.concat(parts))
}
const header = (architecture: string | undefined, kv: Record<string, number | string>, tensors: readonly Tensor[]) => { const parsed = parseGgufHeader(gguf(architecture, kv, tensors)); assert.ok(parsed.state === 'ok', 'fixture header parses'); return parsed.header }
const quant: Tensor[] = [{ name: 'token_embd.weight', type: table.types.Q4_K! }, { name: 'blk.0.attn_q.weight', type: table.types.Q6_K! }, { name: 'blk.0.attn_norm.weight', type: table.types.F32! }, { name: 'output.weight', type: table.types.BF16! }]

const parsed = header('llama', {}, quant)
check('the parser keeps the tensor types in file order', parsed.types?.join(',') === [table.types.Q4_K, table.types.Q6_K, table.types.F32, table.types.BF16].join(',') && parsed.tensors.length === 4)
const fiveDims = parseGgufHeader(gguf('llama', {}, [{ name: 'blk.0.attn_q.weight', dims: [1, 2, 3, 4, 5] }]))
check('a tensor with five dimensions is refused the way llama.cpp refuses it (GGML_MAX_DIMS is 4)', fiveDims.state === 'bad' && fiveDims.reason === 'tensor blk.0.attn_q.weight claims 5 dimensions; llama.cpp reads at most 4')

const passing = compareGgufWithEngine([parsed])
check('a file whose tensors use types the pinned engine knows passes with the same words as before', passing.ok && passing.words === 'header read · architecture llama · 4 tensors in 4 families, all known to llama.cpp ' + short)
const future = compareGgufWithEngine([header('llama', {}, [quant[0]!, { name: 'blk.0.attn_q.weight', type: table.typeCount }, quant[3]!])])
check('a tensor type at GGML_TYPE_COUNT (one a newer llama.cpp or a fork added) is refused with the type and the tensor named', !future.ok && future.words === 'engine cannot load this file: tensor type ' + table.typeCount + ' is unknown to llama.cpp ' + short + ' (e.g. blk.0.attn_q.weight) · a newer llama.cpp is needed')
const retired = compareGgufWithEngine([header('llama', {}, [quant[0]!, { name: 'output.weight', type: 31 }])])
check('a retired type id (Q4_0_4_4 = 31, block size 0 in the engine) is refused without promising a newer engine', !retired.ok && retired.words === 'engine cannot load this file: tensor type 31 was removed from llama.cpp (e.g. output.weight) · look for another quantisation of this model')
const familyFirst = compareGgufWithEngine([header('llama', {}, [{ name: 'blk.0.ffn_gate_router_fancy.weight', type: table.typeCount }])])
check('an unknown tensor family is still named before the type', !familyFirst.ok && familyFirst.words.includes('(e.g. blk.N.ffn_gate_router_fancy)'))
check('a header built without types (older callers) still compares on names alone', compareGgufWithEngine([{ version: 3, tensorCount: 1, architecture: 'llama', kv: {}, tensors: ['token_embd.weight'], headerBytes: 0 }]).ok)

const log: { file: string; range?: string }[] = []
const hub = (files: Record<string, Uint8Array>): typeof fetch => (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  const file = decodeURIComponent(url.pathname.split('/').pop()!)
  const headers = init?.headers as Record<string, string> | undefined
  log.push({ file, ...(headers?.Range ? { range: headers.Range } : {}) })
  const bytes = files[file]
  if (!bytes) return new Response('not here', { status: 404 })
  const range = /^bytes=(\d+)-(\d+)$/.exec(headers?.Range ?? '')
  assert.ok(range, 'every header read is a Range request')
  const slice = new Uint8Array(bytes.subarray(Number(range[1]), Math.min(Number(range[2]) + 1, bytes.length)))
  return new Response(slice, { status: 206, headers: { 'Content-Range': 'bytes ' + range[1] + '-' + (Number(range[1]) + slice.length - 1) + '/' + bytes.length } })
}) as typeof fetch
const blocks = (from: number, to: number, extra: Tensor[] = []): Tensor[] => Array.from({ length: to - from + 1 }, (_, i) => from + i).flatMap(block => [{ name: 'blk.' + block + '.attn_q.weight', type: table.types.Q4_K! }, { name: 'blk.' + block + '.attn_norm.weight', type: table.types.F32! }, ...extra.map(tensor => ({ ...tensor, name: tensor.name.replace('N', String(block)) }))])
const stem: Tensor[] = [{ name: 'token_embd.weight', type: table.types.Q4_K! }, { name: 'output_norm.weight', type: table.types.F32! }, { name: 'output.weight', type: table.types.BF16! }]
const total = stem.length + 2 * 20
const shardSet = (edit: { first?: Record<string, number | string>; second?: Record<string, number | string>; third?: Tensor[]; architecture?: string; secondTensors?: Tensor[] } = {}): Record<string, Uint8Array> => ({
  'm-00001-of-00003.gguf': gguf(edit.architecture ?? 'llama', { 'split.no': 0, 'split.count': 3, 'split.tensors.count': total, ...edit.first }, stem),
  'm-00002-of-00003.gguf': gguf(undefined, { 'split.no': 1, 'split.count': 3, ...edit.second }, edit.secondTensors ?? blocks(0, 9)),
  'm-00003-of-00003.gguf': gguf(undefined, { 'split.no': 2, 'split.count': 3 }, edit.third ?? blocks(10, 19)),
})
const read = (files: Record<string, Uint8Array>, file = 'm-00001-of-00003.gguf') => { log.length = 0; return checkGgufAgainstEngine('http://hub.invalid', 'org/model', 'main', file, { fetch: hub(files) }) }
const good = await read(shardSet())
check('a consistent three-shard file passes with every shard header read by Range and nothing else fetched: ' + good.words, good.state === 'known' && good.words === 'header read · architecture llama · ' + total + ' tensors in 5 families, all known to llama.cpp ' + short && new Set(log.map(row => row.file)).size === 3 && log.every(row => row.range?.startsWith('bytes=')))
const fork = await read(shardSet({ architecture: 'glm5next' }))
check('an architecture the engine lacks is refused after the first shard alone', fork.state === 'unknown' && fork.words.includes('"glm5next" is not known') && log.every(row => row.file === 'm-00001-of-00003.gguf'))
const miscounted = await read(shardSet({ first: { 'split.count': 2 } }))
check('a name that says three shards while split.count says two is refused before the other shards are read', miscounted.state === 'unknown' && miscounted.words === 'engine cannot load this file: its name says 3 shards but split.count says 2' && log.every(row => row.file === 'm-00001-of-00003.gguf'))
const single = gguf('llama', {}, [quant[0]!, quant[3]!])
const unsplit = await read({ 'm-00001-of-00003.gguf': single })
check('a sharded name whose header names no split.count is refused (the loader would read one file and miss the rest)', unsplit.state === 'unknown' && unsplit.words === 'engine cannot load this file: its name says 3 shards but its header names no split.count')
const misnumbered = await read(shardSet({ second: { 'split.no': 5 } }))
check('a shard whose split.no is not its index is refused the way the loader refuses it', misnumbered.state === 'unknown' && misnumbered.words === 'engine cannot load this file: shard 2 of 3 carries split.no 5 · llama.cpp expects 1')
const overcounted = await read(shardSet({ first: { 'split.tensors.count': 999 } }))
check('a split.tensors.count that differs from what the shards carry is refused', overcounted.state === 'unknown' && overcounted.words === 'engine cannot load this file: split.tensors.count names 999 tensors but the 3 shards carry ' + total)
const uncounted = await read({ ...shardSet(), 'm-00001-of-00003.gguf': gguf('llama', { 'split.no': 0, 'split.count': 3 }, stem) })
check('a first shard without split.tensors.count is refused (the loader requires the key)', uncounted.state === 'unknown' && uncounted.words === 'engine cannot load this file: the first shard names no split.tensors.count')
const duplicated = await read(shardSet({ secondTensors: [quant[0]!, ...blocks(0, 9)] }))
check('a tensor that appears in two shards is refused', duplicated.state === 'unknown' && duplicated.words === "engine cannot load this file: tensor 'token_embd.weight' appears twice")
const lateType = await read(shardSet({ third: [...blocks(10, 19), { name: 'blk.19.ffn_down.weight', type: table.typeCount + 3 }] }))
check('an unknown tensor type in the last shard is refused after all three headers were read', lateType.state === 'unknown' && lateType.words.startsWith('engine cannot load this file: tensor type ' + (table.typeCount + 3) + ' is unknown to llama.cpp ' + short + ' (e.g. blk.19.ffn_down.weight)') && new Set(log.map(row => row.file)).size === 3)
const pointer = await read({ ...shardSet(), 'm-00002-of-00003.gguf': new Uint8Array(Buffer.from('version https://git-lfs.github.com/spec/v1\noid sha256:' + 'ab'.repeat(32) + '\nsize 12\n')) })
check('a shard that is an LFS pointer is still refused with the shard named', pointer.state === 'unknown' && pointer.words === 'engine cannot load this file: shard 2 of 3 · the file does not start with GGUF')

const tree = { asset, sha: LLAMACPP_ENGINE_SHA, image: LLAMACPP_ENGINE_IMAGE, dockerfile, workflow }
check('the checked-in table, recipes.ts, the Dockerfile, the workflow and the served image agree', engineProblems(tree).length === 0)
const moved = 'f'.repeat(40)
const movedPin = engineProblems({ ...tree, sha: moved })
check('moving the pinned commit without a new image is refused: the table, every pin and the served image are named', movedPin.includes('the table was generated at llama.cpp ' + LLAMACPP_ENGINE_SHA + ' but recipes.ts pins ' + moved) && movedPin.filter(problem => /^Dockerfile ARG LLAMA_CPP_SHA pins /.test(problem)).length === dockerfile.match(/^ARG LLAMA_CPP_SHA=/gm)!.length && dockerfile.match(/^ARG LLAMA_CPP_SHA=/gm)!.length >= 3 && movedPin.some(problem => problem.startsWith('workflow upstream_sha default pins ')) && movedPin.some(problem => problem.startsWith('workflow upstream_sha fallback pins ')) && movedPin.includes('the served image ' + asset.image!.digest.slice(0, 19) + ' was built at llama.cpp ' + LLAMACPP_ENGINE_SHA + ' (registry label) while recipes.ts pins ' + moved + ' · publish an image at the pinned commit and stamp it with --image'))
const otherDigest = 'ghcr.io/whq02/mercury-llamacpp@sha256:' + 'e'.repeat(64)
check('a served digest the stamp never read is refused', engineProblems({ ...tree, image: otherDigest }).join('\n') === 'the image stamp names ' + LLAMACPP_ENGINE_IMAGE + ' but recipes.ts serves ' + otherDigest)
const validationDrift = dockerfile.replace(/^(FROM runtime AS validation\nARG LLAMA_CPP_SHA=)[0-9a-f]{40}$/m, '$1' + moved)
check('a stage of the Dockerfile left at another commit is refused (every ARG occurrence is read)', validationDrift !== dockerfile && engineProblems({ ...tree, dockerfile: validationDrift }).join('\n') === 'Dockerfile ARG LLAMA_CPP_SHA pins ' + moved + ' while recipes.ts pins ' + LLAMACPP_ENGINE_SHA)
const archDrift = engineProblems({ ...tree, dockerfile: dockerfile.replaceAll('ARG CUDA_ARCHITECTURES="100;103;120"', 'ARG CUDA_ARCHITECTURES="90;100;103;120"') })
check('CUDA targets that differ between the Dockerfile, the workflow and the served image are refused', archDrift.some(problem => problem.startsWith('the CUDA architectures disagree: ')) && archDrift.some(problem => problem === 'the served image was built for CUDA 100;103;120 while the Dockerfile names 90;100;103;120'))
const { image: _unstamped, ...bare } = asset
check('a table without the image stamp is refused and told how to stamp it', engineProblems({ ...tree, asset: bare as typeof asset }).join('\n') === 'the table carries no image stamp · run bun scripts/host/export-llamacpp-engine.ts --image once the engine image is published')
check('a table without the tensor type set is refused', engineProblems({ ...tree, asset: { ...asset, types: {}, typeCount: 0 } }).join('\n') === 'the table carries no tensor type set from ggml/include/ggml.h')

function registry(labels: Record<string, string>, options: { tamper?: boolean; noAmd64?: boolean; tokenStatus?: number } = {}) {
  const config = JSON.stringify({ architecture: 'amd64', os: 'linux', config: { Labels: labels } })
  const manifest = JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: sha256(config), size: config.length }, layers: [] })
  const index = JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [...(options.noAmd64 ? [] : [{ mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: sha256(manifest), size: manifest.length, platform: { architecture: 'amd64', os: 'linux' } }]), { mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: sha256('attestation'), size: 11, platform: { architecture: 'unknown', os: 'unknown' } }] })
  const digest = sha256(index)
  const seen: { path: string; authorization?: string; accept?: string }[] = []
  const fetchLike = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const headers = (init?.headers ?? {}) as Record<string, string>
    seen.push({ path: url.pathname + url.search, ...(headers.Authorization ? { authorization: headers.Authorization } : {}), ...(headers.Accept ? { accept: headers.Accept } : {}) })
    assert.equal(url.origin, 'http://127.0.0.1:1', 'the registry read stays on the fake registry')
    if (url.pathname === '/token') return new Response(JSON.stringify({ token: 'pull-token' }), { status: options.tokenStatus ?? 200 })
    if (headers.Authorization !== 'Bearer pull-token' && !url.pathname.startsWith('/storage/')) return new Response('unauthorised', { status: 401 })
    if (url.pathname === '/v2/whq02/mercury-llamacpp/manifests/' + digest) return new Response(options.tamper ? index + ' ' : index, { status: 200, headers: { 'Content-Type': 'application/vnd.oci.image.index.v1+json' } })
    if (url.pathname === '/v2/whq02/mercury-llamacpp/manifests/' + sha256(manifest)) return new Response(manifest, { status: 200 })
    if (url.pathname === '/v2/whq02/mercury-llamacpp/blobs/' + sha256(config)) return new Response(null, { status: 307, headers: { Location: '/storage/' + sha256(config) } })
    if (url.pathname === '/storage/' + sha256(config)) { assert.ok(!headers.Authorization, 'the storage redirect carries no bearer token'); return new Response(config, { status: 200 }) }
    return new Response('not here', { status: 404 })
  }) as typeof fetch
  return { image: '127.0.0.1:1/whq02/mercury-llamacpp@' + digest, digest, manifest: sha256(manifest), fetch: fetchLike, seen }
}
const goodLabels = { 'org.opencontainers.image.revision': LLAMACPP_ENGINE_SHA, 'ai.mercury.cuda.architectures': '100;103;120', 'org.opencontainers.image.created': '2026-10-23T03:26:00Z' }
const live = registry(goodLabels)
const stamped = await readRegistryImage(live.image, { fetch: live.fetch, insecure: true, now: () => new Date('2026-10-23T12:00:00Z') })
check('the registry read follows token → index → linux/amd64 manifest → config, verifying each digest, and stamps the labels', stamped.ok && stamped.stamp.ref === '127.0.0.1:1/whq02/mercury-llamacpp' && stamped.stamp.digest === live.digest && stamped.stamp.manifest === live.manifest && stamped.stamp.revision === LLAMACPP_ENGINE_SHA && stamped.stamp.cudaArchitectures === '100;103;120' && stamped.stamp.created === '2026-10-23T03:26:00Z' && stamped.stamp.readOn === '2026-10-23' && /not a boot test/.test(stamped.stamp.evidence))
check('the pull token is asked for anonymously with the pull scope and sent only to the registry', live.seen[0]?.path === '/token?scope=repository:whq02/mercury-llamacpp:pull&service=127.0.0.1:1' && live.seen.filter(row => row.path.startsWith('/v2/')).every(row => row.authorization === 'Bearer pull-token' && (row.accept ?? '').includes('application/vnd.oci.image.index.v1+json') === row.path.includes('/manifests/')) && live.seen.some(row => row.path.startsWith('/storage/') && !row.authorization))
const stale = registry({ ...goodLabels, 'org.opencontainers.image.revision': moved })
const staleStamp = await readRegistryImage(stale.image, { fetch: stale.fetch, insecure: true })
check('an image built at another commit reads but is refused as a stamp (what --image prints before writing nothing)', staleStamp.ok && imageStampProblems(staleStamp.stamp, LLAMACPP_ENGINE_SHA, stale.image, '100;103;120').join('\n') === 'the served image ' + stale.digest.slice(0, 19) + ' was built at llama.cpp ' + moved + ' (registry label) while recipes.ts pins ' + LLAMACPP_ENGINE_SHA + ' · publish an image at the pinned commit and stamp it with --image')
check('a stamp of the right commit for other CUDA targets is refused', stamped.ok && imageStampProblems(stamped.stamp, LLAMACPP_ENGINE_SHA, live.image, '90;100;103;120').join('\n') === 'the served image was built for CUDA 100;103;120 while the Dockerfile names 90;100;103;120')
const tampered = registry(goodLabels, { tamper: true })
const tamperedRead = await readRegistryImage(tampered.image, { fetch: tampered.fetch, insecure: true })
check('an index whose bytes do not hash to the requested digest is refused', !tamperedRead.ok && tamperedRead.words.startsWith('127.0.0.1:1 answered ' + tampered.image + ' whose digest is sha256:') && tamperedRead.words.endsWith(', not ' + tampered.digest))
const armOnly = registry(goodLabels, { noAmd64: true })
const armRead = await readRegistryImage(armOnly.image, { fetch: armOnly.fetch, insecure: true })
check('an index without a linux/amd64 manifest is refused', !armRead.ok && armRead.words === armOnly.image + ' carries no linux/amd64 manifest')
const closed = registry(goodLabels, { tokenStatus: 401 })
const closedRead = await readRegistryImage(closed.image, { fetch: closed.fetch, insecure: true })
check('a registry that issues no anonymous pull token is refused with the status', !closedRead.ok && closedRead.words === '127.0.0.1:1 answered HTTP 401 for an anonymous pull token')
const badRef = await readRegistryImage('ghcr.io/whq02/mercury-llamacpp:latest', { fetch: live.fetch })
check('a tag instead of a digest is refused before any request', !badRef.ok && badRef.words.startsWith('the image reference is not host/name@sha256:digest'))

const run = /^RUN (LD_LIBRARY_PATH=\/opt\/cuda-driver:\$LD_LIBRARY_PATH llama-server --version > \/opt\/engine-version\.txt 2>&1 && test -s \/opt\/engine-version\.txt && grep -q "\$LLAMA_CPP_SHA" \/opt\/engine-version\.txt && .*)$/m.exec(dockerfile)?.[1]
check('the validation stage captures stderr, refuses an empty version file and greps the declared commit', run !== undefined && dockerfile.includes('FROM runtime AS validation\nARG LLAMA_CPP_SHA=' + LLAMACPP_ENGINE_SHA + '\n'))
if (process.platform !== 'win32' && run) {
  const sandbox = join(home, 'validation-stage')
  mkdirSync(join(sandbox, 'bin'), { recursive: true }); mkdirSync(join(sandbox, 'opt'), { recursive: true }); mkdirSync(join(sandbox, 'usr/local/bin'), { recursive: true })
  const stub = (file: string, body: string) => { writeFileSync(join(sandbox, file), '#!/bin/sh\n' + body + '\n'); chmodSync(join(sandbox, file), 0o755) }
  stub('bin/hf', 'echo hf 2.2.0'); stub('bin/ldd', 'echo "\tlibgomp.so.1 => /lib/x86_64-linux-gnu/libgomp.so.1"'); stub('usr/local/bin/llama-server', 'exit 0')
  const line = run.replaceAll('/opt/', sandbox + '/opt/').replace('/usr/local/bin/llama-server', sandbox + '/usr/local/bin/llama-server').replace('env PATH=/usr/local/bin:/usr/bin:/bin hf', 'hf')
  const stage = (version: string): number => { stub('bin/llama-server', version); return spawnSync('bash', ['-c', line], { cwd: sandbox, env: { PATH: join(sandbox, 'bin') + ':/usr/bin:/bin', LLAMA_CPP_SHA: LLAMACPP_ENGINE_SHA }, encoding: 'utf8' }).status ?? -1 }
  const commit = (sha: string) => 'echo "version: 0.0.0 (build 1, commit ' + sha + ')" >&2; echo "built with gcc for x86_64-linux-gnu" >&2; exit 0'
  check('the validation line passes a binary that names the declared commit on stderr and keeps the words in the version file', stage(commit(LLAMACPP_ENGINE_SHA)) === 0 && readFileSync(join(sandbox, 'opt/engine-version.txt'), 'utf8').includes('commit ' + LLAMACPP_ENGINE_SHA))
  check('the validation line fails a binary built at another commit', stage(commit(moved)) !== 0)
  check('the validation line fails a binary that prints no version (the served image’s empty version.txt would not pass again)', stage('exit 0') !== 0)
}

const checked = spawnSync('bun', ['scripts/host/export-llamacpp-engine.ts', '--check'], { cwd: root, encoding: 'utf8' })
check('bun scripts/host/export-llamacpp-engine.ts --check is green on this tree and names the served image', checked.status === 0 && checked.stdout.includes('is current for llama.cpp ' + LLAMACPP_ENGINE_SHA) && checked.stdout.includes('served image ' + asset.image!.digest.slice(0, 19) + ' built at that commit'))
check('the host suite runs this proof', readFileSync(join(root, 'scripts/host/run-all.sh'), 'utf8').includes('prove-llamacpp-engine-upkeep.ts'))
console.log('LLAMACPP ENGINE UPKEEP GREEN · ' + checks + ' checks; injected Hub and registry fetches, no network, llama.cpp ' + short + ' (upstream facts: gguf.cpp, llama-model-loader.cpp, ggml.h, common/build-info at that commit) · tree ' + execFileSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim())
