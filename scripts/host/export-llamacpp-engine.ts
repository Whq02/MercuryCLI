import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { registerGeneratedAsset, registerOnlyRequested } from '../lib/generated-assets-map.mjs'
import { LLAMACPP_ENGINE_IMAGE, LLAMACPP_ENGINE_SHA } from '../../src/services/host/recipes.ts'

const root = resolve(import.meta.dir, '../..')
const ASSET = 'assets/host/llamacpp-engine.json'
const DOCKERFILE = 'scripts/host/Dockerfile.llamacpp'
const WORKFLOW = '.github/workflows/engine-image.yml'
const UPSTREAM = 'ggml-org/llama.cpp'
const ARCH_SOURCE = 'src/llama-arch.cpp'
const GGML_SOURCE = 'ggml/include/ggml.h'
const MANIFEST_ACCEPT = 'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json'
const ROW = {
  assets: ASSET,
  generator: 'bun scripts/host/export-llamacpp-engine.ts',
  check: 'bun scripts/host/export-llamacpp-engine.ts --check',
  sources: 'src/services/host/recipes.ts ' + DOCKERFILE + ' ' + WORKFLOW + ' scripts/host/export-llamacpp-engine.ts',
}
if (registerOnlyRequested(ROW)) process.exit(0)

interface EngineImageStamp { ref: string; digest: string; manifest: string; revision: string; cudaArchitectures: string; created: string; readOn: string; evidence: string }
interface EngineTableFile { generatedBy: string; llamacpp: string; source: string; sourceSha256: string; ggmlSource: string; ggmlSourceSha256: string; image?: EngineImageStamp; typeCount: number; types: Record<string, number>; architectures: string[]; tensors: string[] }
interface Manifest { mediaType?: string; manifests?: { digest: string; platform?: { os?: string; architecture?: string } }[]; config?: { digest: string } }

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
const blobUrl = (sha: string, path: string): string => 'https://github.com/' + UPSTREAM + '/blob/' + sha + '/' + path
const rawUrl = (sha: string, path: string): string => 'https://raw.githubusercontent.com/' + UPSTREAM + '/' + sha + '/' + path
const all = (text: string, pattern: RegExp): string[] => [...text.matchAll(pattern)].map(match => match[1]!)
const argumentAfter = (flag: string): string | undefined => { const at = process.argv.indexOf(flag); return at >= 0 ? process.argv[at + 1] : undefined }
const readAsset = (): EngineTableFile => JSON.parse(readFileSync(resolve(root, ASSET), 'utf8')) as EngineTableFile
const canonical = (table: EngineTableFile): EngineTableFile => ({ generatedBy: table.generatedBy, llamacpp: table.llamacpp, source: table.source, sourceSha256: table.sourceSha256, ggmlSource: table.ggmlSource, ggmlSourceSha256: table.ggmlSourceSha256, ...(table.image ? { image: table.image } : {}), typeCount: table.typeCount, types: table.types, architectures: table.architectures, tensors: table.tensors })
const writeAsset = (table: EngineTableFile): void => { writeFileSync(resolve(root, ASSET), JSON.stringify(canonical(table), null, 2) + '\n'); registerGeneratedAsset(ROW) }

function engineTableFromSources(archSource: string, ggmlSource: string, sha: string, image?: EngineImageStamp): EngineTableFile {
  const architectures = [...archSource.matchAll(/\{\s*LLM_ARCH_([A-Z0-9_]+),\s*"([^"]+)"\s*\}/g)].filter(match => match[1] !== 'UNKNOWN').map(match => match[2]!)
  const tensors = [...archSource.matchAll(/\{\s*LLM_TENSOR_[A-Z0-9_]+,\s*"([^"]+)"\s*\}/g)].map(match => match[1]!.replaceAll('%d', 'N'))
  if (architectures.length < 50 || tensors.length < 100) throw new Error(ARCH_SOURCE + ' at ' + sha + ' yielded ' + architectures.length + ' architectures and ' + tensors.length + ' tensor names; the source shape changed')
  const enumBody = /enum ggml_type \{([\s\S]*?)\};/.exec(ggmlSource)?.[1]
  if (!enumBody) throw new Error(GGML_SOURCE + ' at ' + sha + ' has no enum ggml_type; the source shape changed')
  const types: Record<string, number> = {}
  let typeCount: number | undefined
  for (const match of enumBody.matchAll(/^\s*GGML_TYPE_([A-Z0-9_]+)\s*=\s*(\d+)/gm)) {
    if (match[1] === 'COUNT') typeCount = Number(match[2])
    else types[match[1]!] = Number(match[2])
  }
  const ids = Object.values(types)
  if (typeCount === undefined || ids.length < 30 || Math.max(...ids) >= typeCount) throw new Error(GGML_SOURCE + ' at ' + sha + ' yielded ' + ids.length + ' tensor types and GGML_TYPE_COUNT ' + typeCount + '; the enum shape changed')
  return {
    generatedBy: 'scripts/host/export-llamacpp-engine.ts', llamacpp: sha,
    source: blobUrl(sha, ARCH_SOURCE), sourceSha256: sha256(archSource), ggmlSource: blobUrl(sha, GGML_SOURCE), ggmlSourceSha256: sha256(ggmlSource),
    ...(image ? { image } : {}),
    typeCount, types, architectures: [...new Set(architectures)].sort(), tensors: [...new Set(tensors)].sort(),
  }
}

async function fetchSources(sha: string): Promise<{ arch: string; ggml: string }> {
  const read = async (path: string): Promise<string> => {
    const response = await fetch(rawUrl(sha, path))
    if (!response.ok) throw new Error('GitHub answered HTTP ' + response.status + ' for ' + rawUrl(sha, path))
    return response.text()
  }
  return { arch: await read(ARCH_SOURCE), ggml: await read(GGML_SOURCE) }
}

export function imageStampProblems(stamp: EngineImageStamp, sha: string, image: string, cudaArchitectures: string): string[] {
  const problems: string[] = []
  if (stamp.ref + '@' + stamp.digest !== image) problems.push('the image stamp names ' + stamp.ref + '@' + stamp.digest + ' but recipes.ts serves ' + image)
  if (stamp.revision !== sha) problems.push('the served image ' + stamp.digest.slice(0, 19) + ' was built at llama.cpp ' + stamp.revision + ' (registry label) while recipes.ts pins ' + sha + ' · publish an image at the pinned commit and stamp it with --image')
  if (stamp.cudaArchitectures !== cudaArchitectures) problems.push('the served image was built for CUDA ' + stamp.cudaArchitectures + ' while the Dockerfile names ' + cudaArchitectures)
  return problems
}

export function engineProblems(input: { asset: EngineTableFile; sha: string; image: string; dockerfile: string; workflow: string }): string[] {
  const { asset, sha, image } = input
  const problems: string[] = []
  if (asset.llamacpp !== sha) problems.push('the table was generated at llama.cpp ' + asset.llamacpp + ' but recipes.ts pins ' + sha)
  const shaPins = {
    'Dockerfile ARG LLAMA_CPP_SHA': all(input.dockerfile, /^ARG LLAMA_CPP_SHA=([0-9a-f]{40})$/gm),
    'workflow upstream_sha default': all(input.workflow, /^\s+default: ([0-9a-f]{40})$/gm),
    'workflow upstream_sha fallback': all(input.workflow, /inputs\.upstream_sha \|\| '([0-9a-f]{40})'/g),
  }
  for (const [name, values] of Object.entries(shaPins)) {
    if (!values.length) problems.push(name + ' is missing')
    for (const value of values) if (value !== sha) problems.push(name + ' pins ' + value + ' while recipes.ts pins ' + sha)
  }
  if (!Array.isArray(asset.architectures) || asset.architectures.length < 50 || !Array.isArray(asset.tensors) || asset.tensors.length < 100) problems.push('the table is too small to be ' + ARCH_SOURCE)
  if (!/^[0-9a-f]{64}$/.test(asset.sourceSha256)) problems.push('the table carries no ' + ARCH_SOURCE + ' digest')
  const ids = Object.values(asset.types ?? {})
  if (ids.length < 30 || !Number.isInteger(asset.typeCount) || Math.max(...ids) >= asset.typeCount) problems.push('the table carries no tensor type set from ' + GGML_SOURCE)
  if (!/^[0-9a-f]{64}$/.test(asset.ggmlSourceSha256 ?? '')) problems.push('the table carries no ' + GGML_SOURCE + ' digest')
  const archPins = {
    'Dockerfile ARG CUDA_ARCHITECTURES': all(input.dockerfile, /^ARG CUDA_ARCHITECTURES="([0-9;]+)"$/gm),
    'workflow arches default': all(input.workflow, /^\s+default: '([0-9;]+)'$/gm),
    'workflow arches fallback': all(input.workflow, /inputs\.arches \|\| '([0-9;]+)'/g),
  }
  const arches = new Set(Object.values(archPins).flat())
  for (const [name, values] of Object.entries(archPins)) if (!values.length) problems.push(name + ' is missing')
  if (arches.size > 1) problems.push('the CUDA architectures disagree: ' + [...arches].join(' vs '))
  if (!asset.image) problems.push('the table carries no image stamp · run bun scripts/host/export-llamacpp-engine.ts --image once the engine image is published')
  else problems.push(...imageStampProblems(asset.image, sha, image, [...arches][0] ?? ''))
  return problems
}

export async function readRegistryImage(image: string, options: { fetch?: typeof fetch; insecure?: boolean; now?: () => Date } = {}): Promise<{ ok: true; stamp: EngineImageStamp } | { ok: false; words: string }> {
  const doFetch = options.fetch ?? fetch
  const match = /^([^/@]+)\/([^@]+)@(sha256:[0-9a-f]{64})$/.exec(image)
  if (!match) return { ok: false, words: 'the image reference is not host/name@sha256:digest: ' + image }
  const host = match[1]!
  const name = match[2]!
  const digest = match[3]!
  const origin = (options.insecure ? 'http://' : 'https://') + host
  const get = (url: string, accept: string, token?: string): Promise<Response> => doFetch(url, { headers: { Accept: accept, ...(token ? { Authorization: 'Bearer ' + token } : {}) }, redirect: 'manual', signal: AbortSignal.timeout(20_000) })
  const digested = async (response: Response, want: string, what: string): Promise<string | { words: string }> => {
    if (!response.ok) return { words: host + ' answered HTTP ' + response.status + ' for ' + what }
    const text = await response.text()
    const have = 'sha256:' + sha256(text)
    return have === want ? text : { words: host + ' answered ' + what + ' whose digest is ' + have + ', not ' + want }
  }
  try {
    const tokenResponse = await get(origin + '/token?scope=repository:' + name + ':pull&service=' + host, 'application/json')
    if (!tokenResponse.ok) return { ok: false, words: host + ' answered HTTP ' + tokenResponse.status + ' for an anonymous pull token' }
    const token = (await tokenResponse.json() as { token?: string }).token
    if (!token) return { ok: false, words: host + ' issued no pull token' }
    const indexText = await digested(await get(origin + '/v2/' + name + '/manifests/' + digest, MANIFEST_ACCEPT, token), digest, image)
    if (typeof indexText !== 'string') return { ok: false, words: indexText.words }
    let manifest = JSON.parse(indexText) as Manifest
    let manifestDigest = digest
    if (Array.isArray(manifest.manifests)) {
      const amd64 = manifest.manifests.find(entry => entry.platform?.os === 'linux' && entry.platform.architecture === 'amd64')
      if (!amd64) return { ok: false, words: image + ' carries no linux/amd64 manifest' }
      manifestDigest = amd64.digest
      const manifestText = await digested(await get(origin + '/v2/' + name + '/manifests/' + manifestDigest, MANIFEST_ACCEPT, token), manifestDigest, 'the linux/amd64 manifest')
      if (typeof manifestText !== 'string') return { ok: false, words: manifestText.words }
      manifest = JSON.parse(manifestText) as Manifest
    }
    const configDigest = manifest.config?.digest
    if (!configDigest) return { ok: false, words: 'the manifest ' + manifestDigest + ' names no image config' }
    let configResponse = await get(origin + '/v2/' + name + '/blobs/' + configDigest, 'application/octet-stream', token)
    const location = configResponse.headers.get('location')
    if (configResponse.status >= 300 && configResponse.status < 400 && location) { await configResponse.body?.cancel().catch(() => {}); configResponse = await doFetch(new URL(location, origin).toString(), { signal: AbortSignal.timeout(20_000) }) }
    const configText = await digested(configResponse, configDigest, 'the image config')
    if (typeof configText !== 'string') return { ok: false, words: configText.words }
    const labels = (JSON.parse(configText) as { config?: { Labels?: Record<string, string> } }).config?.Labels ?? {}
    const revision = labels['org.opencontainers.image.revision']
    const cudaArchitectures = labels['ai.mercury.cuda.architectures']
    if (!revision || !cudaArchitectures) return { ok: false, words: 'the image config of ' + image + ' carries no org.opencontainers.image.revision and ai.mercury.cuda.architectures labels' }
    const readOn = (options.now?.() ?? new Date()).toISOString().slice(0, 10)
    return { ok: true, stamp: { ref: host + '/' + name, digest, manifest: manifestDigest, revision, cudaArchitectures, created: labels['org.opencontainers.image.created'] ?? '', readOn, evidence: 'OCI labels of the linux/amd64 config read from ' + host + ' on ' + readOn + ' · says which commit and CUDA targets the binary was built with · not a boot test' } }
  } catch (error) {
    return { ok: false, words: host + ' did not answer: ' + (error instanceof Error ? error.message : String(error)) }
  }
}

function pinsOfTree(): { dockerfile: string; workflow: string; cudaArchitectures: string } {
  const dockerfile = readFileSync(resolve(root, DOCKERFILE), 'utf8')
  return { dockerfile, workflow: readFileSync(resolve(root, WORKFLOW), 'utf8'), cudaArchitectures: /^ARG CUDA_ARCHITECTURES="([0-9;]+)"$/m.exec(dockerfile)?.[1] ?? '' }
}

function check(): void {
  const asset = readAsset()
  const problems = engineProblems({ asset, sha: LLAMACPP_ENGINE_SHA, image: LLAMACPP_ENGINE_IMAGE, ...pinsOfTree() })
  if (problems.length) { for (const problem of problems) console.error('llamacpp-engine: ' + problem); process.exit(1) }
  console.log('llamacpp-engine: ' + ASSET + ' is current for llama.cpp ' + asset.llamacpp + ' (' + asset.architectures.length + ' architectures, ' + asset.tensors.length + ' tensor names, ' + Object.keys(asset.types).length + ' tensor types) · served image ' + asset.image!.digest.slice(0, 19) + ' built at that commit for CUDA ' + asset.image!.cudaArchitectures + ' (registry labels read ' + asset.image!.readOn + ')')
}

async function stampImage(): Promise<void> {
  const asset = readAsset()
  const read = await readRegistryImage(LLAMACPP_ENGINE_IMAGE)
  if (!read.ok) { console.error('llamacpp-engine: ' + read.words); process.exit(1) }
  const stamp = read.stamp
  const problems = imageStampProblems(stamp, LLAMACPP_ENGINE_SHA, LLAMACPP_ENGINE_IMAGE, pinsOfTree().cudaArchitectures)
  if (problems.length) { for (const problem of problems) console.error('llamacpp-engine: ' + problem); console.error('llamacpp-engine: nothing stamped'); process.exit(1) }
  writeAsset({ ...asset, image: stamp })
  console.log('llamacpp-engine: ' + ASSET + ' stamps ' + LLAMACPP_ENGINE_IMAGE + ' · built at llama.cpp ' + stamp.revision + ' for CUDA ' + stamp.cudaArchitectures + ' on ' + stamp.created + ' (registry labels; not a boot test)')
  if (!asset.llamacpp || asset.llamacpp !== stamp.revision) console.error('llamacpp-engine: the table was generated at ' + asset.llamacpp + '; regenerate it with --sha ' + stamp.revision)
}

async function reviewUpstream(ref: string): Promise<void> {
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
  const api = async <T>(path: string): Promise<T> => {
    const response = await fetch('https://api.github.com/repos/' + UPSTREAM + path, { headers: { Accept: 'application/vnd.github+json', ...(token ? { Authorization: 'Bearer ' + token } : {}) } })
    if (!response.ok) throw new Error('GitHub answered HTTP ' + response.status + ' for ' + path)
    return response.json() as Promise<T>
  }
  const commit = await api<{ sha: string; commit: { committer: { date: string }; message: string } }>('/commits/' + ref)
  const compare = await api<{ ahead_by: number; behind_by: number }>('/compare/' + LLAMACPP_ENGINE_SHA + '...' + commit.sha)
  const sources = await fetchSources(commit.sha)
  const next = engineTableFromSources(sources.arch, sources.ggml, commit.sha)
  const current = readAsset()
  const added = (now: readonly string[], before: readonly string[]): string[] => now.filter(item => !before.includes(item))
  const typesOf = (table: EngineTableFile): string[] => Object.entries(table.types).map(([name, id]) => name + '=' + id)
  console.log('llamacpp-engine: pinned ' + LLAMACPP_ENGINE_SHA + ' · ' + ref + ' is ' + commit.sha + ' (' + commit.commit.committer.date + ' · ' + commit.commit.message.split('\n')[0] + ') · ' + compare.ahead_by + ' commits ahead, ' + compare.behind_by + ' behind')
  console.log('llamacpp-engine: architectures +' + added(next.architectures, current.architectures).length + ' −' + added(current.architectures, next.architectures).length + (added(next.architectures, current.architectures).length ? ' (' + added(next.architectures, current.architectures).join(', ') + ')' : ''))
  console.log('llamacpp-engine: tensor names +' + added(next.tensors, current.tensors).length + ' −' + added(current.tensors, next.tensors).length + (added(next.tensors, current.tensors).length ? ' (' + added(next.tensors, current.tensors).join(', ') + ')' : ''))
  console.log('llamacpp-engine: tensor types +' + added(typesOf(next), typesOf(current)).length + ' −' + added(typesOf(current), typesOf(next)).length + (added(typesOf(next), typesOf(current)).length ? ' (' + added(typesOf(next), typesOf(current)).join(', ') + ')' : '') + ' · GGML_TYPE_COUNT ' + current.typeCount + ' → ' + next.typeCount)
  console.log('llamacpp-engine: to move the pin: bun scripts/host/export-llamacpp-engine.ts --sha ' + commit.sha + ' · set LLAMACPP_ENGINE_SHA in src/services/host/recipes.ts, ARG LLAMA_CPP_SHA in ' + DOCKERFILE + ' and the upstream_sha default/fallback in ' + WORKFLOW + ' · publish the engine image at that commit · set LLAMACPP_ENGINE_IMAGE to its digest · bun scripts/host/export-llamacpp-engine.ts --image · --check')
}

if (import.meta.main) {
  if (process.argv.includes('--check')) check()
  else if (process.argv.includes('--image')) await stampImage()
  else if (process.argv.includes('--upstream')) await reviewUpstream(argumentAfter('--upstream') ?? 'master')
  else {
    const sha = argumentAfter('--sha') ?? LLAMACPP_ENGINE_SHA
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('--sha wants a full llama.cpp commit')
    const sources = await fetchSources(sha)
    let image: EngineImageStamp | undefined
    try { image = readAsset().image } catch { image = undefined }
    const table = engineTableFromSources(sources.arch, sources.ggml, sha, image)
    writeAsset(table)
    console.log('llamacpp-engine: wrote ' + ASSET + ' for llama.cpp ' + sha + ' (' + table.architectures.length + ' architectures, ' + table.tensors.length + ' tensor names, ' + Object.keys(table.types).length + ' tensor types)')
    if (sha !== LLAMACPP_ENGINE_SHA) console.error('llamacpp-engine: recipes.ts still pins ' + LLAMACPP_ENGINE_SHA + '; the check stays red until it names ' + sha)
    if (image && image.revision !== sha) console.error('llamacpp-engine: the served image ' + image.digest.slice(0, 19) + ' was built at ' + image.revision + '; the check stays red until an image built at ' + sha + ' is published and stamped with --image')
  }
}
