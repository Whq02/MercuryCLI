import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '../..')
if (process.env.MERCURY_DRIFT_SIGNALS !== '1') {
  console.log('vendor drift signals not read: this proof reads the vendors’ live documents and registries; run it as a reading with MERCURY_DRIFT_SIGNALS=1')
  process.exit(0)
}
if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')

let checks = 0
let failures = 0
const check = (name: string, value: unknown, detail: unknown = ''): void => {
  checks++
  if (!value) failures++
  console.log((value ? 'PASS ' : 'FAIL ') + name + (value ? '' : ' — ' + JSON.stringify(detail)))
}
const record = (value: unknown): Record<string, any> | undefined => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, any> : undefined
const fetchText = async (url: string, init: RequestInit = {}): Promise<{ status: number; headers: Headers; text: string }> => {
  const response = await fetch(url, { ...init, headers: { 'user-agent': 'mercury-drift-signals/1', ...(init.headers ?? {}) }, redirect: 'follow', signal: AbortSignal.timeout(60_000) })
  return { status: response.status, headers: response.headers, text: init.method === 'HEAD' ? '' : await response.text() }
}
const fetchJson = async (url: string): Promise<{ status: number; headers: Headers; body: any }> => {
  const { status, headers, text } = await fetchText(url)
  let body: unknown
  try { body = JSON.parse(text) } catch { body = undefined }
  return { status, headers, body }
}
const resolveRefs = (doc: any, node: any, seen: Set<string> = new Set()): any => {
  if (Array.isArray(node)) return node.map(child => resolveRefs(doc, child, seen))
  if (!record(node)) return node
  if (typeof node.$ref === 'string') {
    if (seen.has(node.$ref)) return { $circular: node.$ref }
    let target: any = doc
    for (const key of node.$ref.replace(/^#\//, '').split('/')) target = target?.[key]
    return resolveRefs(doc, target, new Set([...seen, node.$ref]))
  }
  return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, resolveRefs(doc, value, seen)]))
}
const property = (schema: any, key: string): any => {
  if (!record(schema)) return undefined
  if (record(schema.properties) && key in schema.properties) return schema.properties[key]
  for (const part of [...(schema.allOf ?? []), ...(schema.anyOf ?? []), ...(schema.oneOf ?? [])]) { const found = property(part, key); if (found !== undefined) return found }
  return undefined
}
const enumOf = (schema: any): string[] | undefined => {
  if (!record(schema)) return undefined
  if (Array.isArray(schema.enum)) return schema.enum
  for (const part of [...(schema.allOf ?? []), ...(schema.anyOf ?? []), ...(schema.oneOf ?? [])]) { const found = enumOf(part); if (found) return found }
  return undefined
}

const RUNPOD_SPEC = 'https://api.runpod.io/v2/openapi.json'
const RUNPOD_ROUTES: [string, string][] = [['get', '/v2/pods'], ['post', '/v2/pods'], ['get', '/v2/pods/{id}'], ['delete', '/v2/pods/{id}'], ['post', '/v2/pods/{id}/action'], ['get', '/v2/pods/{id}/logs'], ['get', '/v2/catalog/gpus'], ['get', '/v2/catalog/datacenters'], ['get', '/v2/network-volumes'], ['post', '/v2/network-volumes'], ['delete', '/v2/network-volumes/{id}'], ['get', '/v2/global-volumes'], ['post', '/v2/global-volumes'], ['delete', '/v2/global-volumes/{id}'], ['get', '/v2/clusters'], ['post', '/v2/clusters'], ['get', '/v2/clusters/{id}'], ['delete', '/v2/clusters/{id}'], ['get', '/v2/clusters/{id}/pods']]
const RUNPOD_POD_STATUSES = ['PROVISIONING', 'STARTING', 'RUNNING', 'EXITED', 'ERROR', 'TERMINATED']
{
  const { status, headers, body } = await fetchJson(RUNPOD_SPEC)
  check('Runpod publishes its v2 OpenAPI document (' + RUNPOD_SPEC + ')', status === 200 && record(body)?.openapi, status)
  check('Runpod v2 OpenAPI info.version is still 2.0.0 (a bump means the routes below were re-read by nobody)', body?.info?.version === '2.0.0', body?.info)
  check('Runpod announces no Deprecation or Sunset header on the v2 document', !headers.get('deprecation') && !headers.get('sunset'), { deprecation: headers.get('deprecation'), sunset: headers.get('sunset') })
  const paths = record(body?.paths) ?? {}
  const missing = RUNPOD_ROUTES.filter(([method, path]) => !record(paths[path])?.[method])
  check('every Runpod route the product calls is still in the document', missing.length === 0, missing)
  const deprecated = RUNPOD_ROUTES.filter(([method, path]) => record(paths[path])?.[method]?.deprecated === true)
  check('none of those Runpod routes is marked deprecated', deprecated.length === 0, deprecated)
  const spec = body
  const podList = resolveRefs(spec, paths['/v2/pods']?.get?.responses?.['200']?.content?.['application/json']?.schema)
  const pagination = property(podList, 'pagination')
  check('Runpod list answers carry pagination {nextCursor, hasNextPage} as required fields', Array.isArray(pagination?.required) && pagination.required.includes('nextCursor') && pagination.required.includes('hasNextPage'), pagination?.required)
  const podSchema = property(podList, 'pods')?.items
  check('the Runpod pod status enum is the six statuses the spend estimate knows', JSON.stringify(enumOf(property(podSchema, 'status'))) === JSON.stringify(RUNPOD_POD_STATUSES), enumOf(property(podSchema, 'status')))
  const cost = property(podSchema, 'cost')
  check('Runpod says cost is 0 only when EXITED or TERMINATED', /0\.0 when EXITED or TERMINATED/.test(String(cost?.description ?? '')), cost?.description)
  const logs = paths['/v2/pods/{id}/logs']?.get
  const logSchema = resolveRefs(spec, logs?.responses?.['200']?.content?.['text/event-stream']?.schema)
  check('Runpod pod logs are a text/event-stream whose data carries source, line and ts', logSchema !== undefined && /`source`/.test(String(logSchema?.description)) && /`line`/.test(String(logSchema?.description)) && /`ts`/.test(String(logSchema?.description)), logSchema?.description)
  const tail = (logs?.parameters ?? []).map((row: any) => resolveRefs(spec, row)).find((row: any) => row.name === 'tail')
  check('the logs tail parameter still accepts up to 5000 lines', tail && /Maximum 5000/.test(String(tail.description)), tail?.description)
  const action = resolveRefs(spec, paths['/v2/pods/{id}/action']?.post?.requestBody?.content?.['application/json']?.schema)
  check('the pod action enum still carries stop', enumOf(property(action, 'action'))?.includes('stop'), enumOf(property(action, 'action')))
  const gpus = paths['/v2/catalog/gpus']?.get
  const gpuParams = (gpus?.parameters ?? []).map((row: any) => resolveRefs(spec, row).name)
  check('the GPU catalogue still takes include, product, cloud, count and minCudaVersion', ['include', 'product', 'cloud', 'count', 'minCudaVersion'].every(name => gpuParams.includes(name)), gpuParams)
  const gpu = resolveRefs(spec, gpus?.responses?.['200']?.content?.['application/json']?.schema)?.properties?.gpus?.items
  check('a GPU row still carries id, name, memory, secure, price.secure, maxCount.secure, availability and dataCenters', ['id', 'name', 'memory', 'secure', 'price', 'maxCount', 'availability', 'dataCenters'].every(key => property(gpu, key) !== undefined) && property(property(gpu, 'price'), 'secure') && property(property(gpu, 'maxCount'), 'secure'), Object.keys(gpu?.properties ?? {}))
  const create = resolveRefs(spec, paths['/v2/pods']?.post?.requestBody?.content?.['application/json']?.schema)
  const persistent = property(property(create, 'mounts'), 'persistent')
  check('the persistent mount the rent road uses is deprecated in prose only, not in the schema (a schema deprecation means the road moves to network volumes)', persistent !== undefined && persistent.deprecated !== true, { deprecated: persistent?.deprecated, description: persistent?.description?.slice(0, 120) })
  const minCuda = property(property(create, 'gpu'), 'minCudaVersion')
  check('gpu.minCudaVersion on pod create still takes major.minor', minCuda?.pattern === '^\\d+\\.\\d+$', minCuda?.pattern)
  const problem = resolveRefs(spec, paths['/v2/pods']?.get?.responses?.['429'])
  check('a Runpod 429 documents Retry-After in seconds beside the RateLimit headers', problem?.headers?.['Retry-After'] && problem?.headers?.['RateLimit-Policy'], Object.keys(problem?.headers ?? {}))
  const errorShape = resolveRefs(spec, paths['/v2/pods']?.post?.responses?.['422'])?.content?.['application/problem+json']?.schema
  check('a Runpod problem+json carries title, status, detail and errors[]', ['title', 'status', 'detail', 'errors'].every(key => property(errorShape, key) !== undefined), Object.keys(errorShape?.properties ?? {}))
  const credentials = await fetchText('https://docs.runpod.io/get-started/credentials.md')
  const keyPage = /Create an API key[\s\S]*?\((https:\/\/console\.runpod\.io\/user\/[a-z]+)\)/.exec(credentials.text)?.[1]
  const { HOST_VENDOR_INFO } = await import('../../src/services/host/vendors/vendor.ts')
  check('Runpod’s credentials document still names the page the key words point to (https://console.runpod.io/user/credentials)', credentials.status === 200 && keyPage !== undefined && HOST_VENDOR_INFO.runpod.keyHelp.includes(keyPage), { keyPage, keyHelp: HOST_VENDOR_INFO.runpod.keyHelp })
  const keyHelp = (await fetchText('https://console.runpod.io/user/credentials', { headers: { 'user-agent': 'Mozilla/5.0' } })).status
  check('the Runpod credentials page answers', keyHelp === 200, keyHelp)
}

const LAMBDA_SPEC = 'https://cloud.lambda.ai/api/v1/openapi.json'
const LAMBDA_ROUTES: [string, string][] = [['get', '/api/v1/instance-types'], ['get', '/api/v1/instances'], ['get', '/api/v1/instances/{id}'], ['post', '/api/v1/instance-operations/launch'], ['post', '/api/v1/instance-operations/terminate'], ['get', '/api/v1/ssh-keys'], ['post', '/api/v1/ssh-keys']]
const LAMBDA_STATUSES = ['booting', 'active', 'unhealthy', 'terminated', 'terminating', 'preempted']
{
  const { status, headers, body } = await fetchJson(LAMBDA_SPEC)
  check('Lambda publishes its OpenAPI document (' + LAMBDA_SPEC + ')', status === 200 && record(body)?.openapi, status)
  check('Lambda OpenAPI info.version is still 1.10.0', body?.info?.version === '1.10.0', body?.info?.version)
  check('Lambda announces no Deprecation or Sunset header on the document', !headers.get('deprecation') && !headers.get('sunset'), { deprecation: headers.get('deprecation'), sunset: headers.get('sunset') })
  const paths = record(body?.paths) ?? {}
  const missing = LAMBDA_ROUTES.filter(([method, path]) => !record(paths[path])?.[method])
  check('every Lambda route the product calls is still in the document', missing.length === 0, missing)
  const deprecated = LAMBDA_ROUTES.filter(([method, path]) => record(paths[path])?.[method]?.deprecated === true)
  check('none of those Lambda routes is marked deprecated', deprecated.length === 0, deprecated)
  check('cloud.lambda.ai is the production server and the lambdalabs host is the deprecated one', body?.servers?.[0]?.url === 'https://cloud.lambda.ai/' && /deprecated/i.test(String(body?.servers?.[1]?.description ?? '')), body?.servers)
  const list = paths['/api/v1/instances']?.get
  const params = (list?.parameters ?? []).map((row: any) => resolveRefs(body, row))
  const pageSize = params.find((row: any) => row.name === 'page_size')
  check('the Lambda instance list pages by page_size (1–100, default 50) and page_token', pageSize && /1-100/.test(String(pageSize.description)) && /default 50/.test(String(pageSize.description)) && params.some((row: any) => row.name === 'page_token'), params.map((row: any) => row.name))
  const instance = resolveRefs(body, list?.responses?.['200']?.content?.['application/json']?.schema)?.properties?.data?.items
  check('the Lambda instance status enum is the six statuses the adapter maps', JSON.stringify(enumOf(property(instance, 'status'))) === JSON.stringify(LAMBDA_STATUSES), enumOf(property(instance, 'status')))
  check('Lambda still documents one request per second and one launch per 12 seconds (the adapter’s pacing words)', /one request per second/.test(String(body?.info?.description)) && /one request per 12\s*\n?seconds/.test(String(body?.info?.description)), String(body?.info?.description).slice(0, 300))
  const launch = resolveRefs(body, paths['/api/v1/instance-operations/launch']?.post?.requestBody?.content?.['application/json']?.schema)
  check('launch still takes region_name, instance_type_name, ssh_key_names, name and user_data', ['region_name', 'instance_type_name', 'ssh_key_names', 'name', 'user_data'].every(key => property(launch, key) !== undefined), Object.keys(launch?.properties ?? {}))
}

const HF_SPEC = 'https://huggingface.co/.well-known/openapi.json'
const HF_CLIENT = 'https://raw.githubusercontent.com/huggingface/huggingface_hub/main/src/huggingface_hub/hf_api.py'
const HF_RATE_LIMITS = 'https://huggingface.co/docs/hub/rate-limits'
{
  const { status, body } = await fetchJson(HF_SPEC)
  check('the Hub publishes its OpenAPI document (' + HF_SPEC + ')', status === 200 && record(body)?.openapi, status)
  const tree = body?.paths?.['/api/models/{namespace}/{repo}/tree/{rev}/{path}']?.get
  const treeParams = (tree?.parameters ?? []).map((row: any) => row.name)
  check('the Hub tree route still takes recursive, limit and cursor and documents the Link header', ['recursive', 'limit', 'cursor'].every(name => treeParams.includes(name)) && tree?.responses?.['200']?.headers?.Link, treeParams)
  const entry = tree?.responses?.['200']?.content?.['application/json']?.schema?.items
  check('a Hub tree entry still carries type (file|directory), oid, size and lfs {oid, size} — the pinned-manifest reads', enumOf(property(entry, 'type'))?.includes('file') && property(entry, 'oid') && property(entry, 'size') && property(property(entry, 'lfs'), 'oid') && property(property(entry, 'lfs'), 'size'), Object.keys(entry?.properties ?? {}))
  const source = readFileSync(resolve(root, 'src/services/host/hfRecipes.ts'), 'utf8')
  const expand = /const EXPAND = \[([^\]]+)\]/.exec(source)?.[1]?.split(',').map(word => word.trim().replace(/^'|'$/g, '')).filter(Boolean) ?? []
  const client = await fetchText(HF_CLIENT)
  const literal = /ExpandModelProperty_T = Literal\[([^\]]+)\]/.exec(client.text)?.[1]?.split(',').map(word => word.trim().replace(/^"|"$/g, '')).filter(Boolean) ?? []
  const unknown = [...expand, 'sha'].filter(key => !literal.includes(key))
  check('every expand[] key the search sends is one the official client accepts today (' + HF_CLIENT + ')', client.status === 200 && expand.length > 0 && unknown.length === 0, { unknown, expand })
  const page = await fetchText(HF_RATE_LIMITS)
  check('the Hub rate-limit page still names the RateLimit and RateLimit-Policy headers and the 429 answer (' + HF_RATE_LIMITS + ')', page.status === 200 && /RateLimit-Policy/.test(page.text) && /429/.test(page.text), page.status)
}

{
  const { HOST_RECIPES } = await import('../../src/services/host/recipes.ts')
  const images = [...new Set(HOST_RECIPES.map(recipe => recipe.image))]
  const accept = 'application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json'
  const tokens = new Map<string, string>()
  const gone: string[] = []
  for (const image of images) {
    const ghcr = image.startsWith('ghcr.io/')
    const [repoPart, digest] = image.replace(/^ghcr\.io\//, '').split('@')
    const [repo, tag] = digest ? [repoPart!, digest] : repoPart!.split(':') as [string, string]
    const registry = ghcr ? 'https://ghcr.io' : 'https://registry-1.docker.io'
    const tokenUrl = ghcr ? 'https://ghcr.io/token?scope=repository:' + repo + ':pull' : 'https://auth.docker.io/token?service=registry.docker.io&scope=repository:' + repo + ':pull'
    const token = tokens.get(tokenUrl) ?? (await fetchJson(tokenUrl)).body?.token
    if (typeof token === 'string') tokens.set(tokenUrl, token)
    const head = await fetchText(registry + '/v2/' + repo + '/manifests/' + tag, { method: 'HEAD', headers: { Authorization: 'Bearer ' + token, Accept: accept } })
    if (head.status !== 200) gone.push(image + ' → HTTP ' + head.status)
  }
  check('every recipe image tag still answers a manifest HEAD on its registry (' + images.length + ' images, no pull)', gone.length === 0, gone)
}

{
  const locks = readdirSync(resolve(root, 'vendor')).filter(name => name.endsWith('.lock.json'))
  const broken: string[] = []
  const sized: string[] = []
  let urls = 0
  for (const name of locks) {
    const lock = JSON.parse(readFileSync(resolve(root, 'vendor', name), 'utf8'))
    const rows: { url: string; bytes?: number }[] = []
    const walk = (node: any): void => {
      if (Array.isArray(node)) { node.forEach(walk); return }
      if (!record(node)) return
      if (typeof node.url === 'string' && /^https?:\/\//.test(node.url)) rows.push({ url: node.url, ...(typeof node.bytes === 'number' ? { bytes: node.bytes } : typeof node.sizeBytes === 'number' ? { bytes: node.sizeBytes } : {}) })
      if (typeof node.checksum === 'string' && /^https?:\/\//.test(node.checksum)) rows.push({ url: node.checksum })
      if (typeof node.checksums === 'string' && /^https?:\/\//.test(node.checksums)) rows.push({ url: node.checksums })
      Object.values(node).forEach(walk)
    }
    walk(lock)
    for (const row of rows) {
      urls++
      const head = await fetchText(row.url, { method: 'HEAD' })
      if (head.status !== 200) broken.push(name + ' ' + row.url + ' → HTTP ' + head.status)
      const length = Number(head.headers.get('content-length'))
      if (row.bytes !== undefined && length > 0 && length !== row.bytes) sized.push(name + ' ' + row.url + ' → ' + length + ' bytes, lock says ' + row.bytes)
    }
  }
  check('every pinned vendor pack URL still answers (' + urls + ' URLs across ' + locks.length + ' locks)', broken.length === 0, broken)
  check('every pinned byte count the locks name matches the server’s content-length', sized.length === 0, sized)
  const node = JSON.parse(readFileSync(resolve(root, 'vendor/node.lock.json'), 'utf8'))
  const index = (await fetchJson('https://nodejs.org/dist/index.json')).body as { version: string; security?: boolean; date: string }[]
  const major = 'v' + String(node.version).split('.')[0] + '.'
  const line = Array.isArray(index) ? index.filter(row => row.version.startsWith(major)) : []
  const newest = line[0]
  const behind = line.filter(row => row.version !== 'v' + node.version && row.version.localeCompare('v' + node.version, undefined, { numeric: true }) > 0)
  check('the pinned Node ' + node.version + ' is the newest release of its line (' + (newest?.version ?? '?') + ' on nodejs.org/dist/index.json)', newest?.version === 'v' + node.version, { newest, behind: behind.map(row => row.version + (row.security ? ' (security)' : '')) })
}

{
  const engine = readFileSync(resolve(root, 'src/services/host/boxEngine.ts'), 'utf8')
  const tag = /https:\/\/github\.com\/ollama\/ollama\/releases\/download\/(v[0-9.]+)\//.exec(engine)?.[1]
  const release = tag ? (await fetchJson('https://api.github.com/repos/ollama/ollama/releases/tags/' + tag)).body : undefined
  const assets: string[] = Array.isArray(release?.assets) ? release.assets.map((row: any) => row.name) : []
  const wanted = ['ollama-linux-amd64.tar.zst', 'ollama-linux-arm64.tar.zst', 'ollama-windows-amd64.zip', 'ollama-windows-arm64.zip', 'sha256sum.txt']
  check('the Ollama release the box road installs (' + (tag ?? '?') + ') still publishes the five assets the script downloads', tag !== undefined && wanted.every(name => assets.includes(name)), { tag, missing: wanted.filter(name => !assets.includes(name)) })
  const advisories = tag ? (await fetchJson('https://api.github.com/advisories?ecosystem=go&affects=github.com/ollama/ollama@' + tag.slice(1) + '&per_page=10')).body : undefined
  check('no published GitHub advisory names the pinned Ollama ' + (tag ?? '?'), Array.isArray(advisories) && advisories.length === 0, Array.isArray(advisories) ? advisories.map((row: any) => row.ghsa_id + ' ' + row.summary) : advisories)
}

console.log('prove-vendor-drift-signals: ' + checks + ' checks, ' + failures + ' failed')
process.exitCode = failures ? 1 : 0
