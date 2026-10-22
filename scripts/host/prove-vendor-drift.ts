import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { hfFixture } from './hfFixture.mjs'
import { lambdaFixture } from './lambdaFixture.mjs'
import { runpodFixture } from './runpodFixture.mjs'

const home = process.env.MERCURY_CONFIG_DIR
assert.ok(home && !resolve(home).startsWith(join(homedir(), '.mercury')), 'a scratch config home outside the real config is required')
mkdirSync(home, { recursive: true })
delete process.env.MERCURY_HOME
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
let checks = 0
let failures = 0
const check = (name: string, value: unknown, detail: unknown = ''): void => {
  checks++
  if (!value) failures++
  console.log((value ? 'PASS ' : 'FAIL ') + name + (value ? '' : ' — ' + JSON.stringify(detail)))
}
const originalFetch = globalThis.fetch
globalThis.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  assert.ok(url.protocol === 'http:' && url.hostname === '127.0.0.1', 'proof traffic stays on loopback: ' + url.origin)
  return originalFetch(input, init)
}, originalFetch)
const signal = () => new AbortController().signal
const failure = async (work: () => Promise<unknown>): Promise<string> => { try { await work(); return '' } catch (error) { return error instanceof Error ? error.message : String(error) } }
const sshKey = 'ssh-ed25519 Zml4dHVyZS1wdWJsaWM= mercury-fixture'

const { HOST_RECIPES } = await import('../../src/services/host/recipes.ts')
const { RunpodClient, RunpodHttpError, createRefusal, podLogLines } = await import('../../src/services/host/runpod.ts')
const { hostSpendSoFar, hostPodBills } = await import('../../src/services/host/costs.ts')
const { LambdaClient } = await import('../../src/services/host/vendors/lambda.ts')
const { searchHuggingFace, fetchHuggingFaceRepo, HF_RATE_LIMIT_WORDS, HF_OFFLINE_WORDS } = await import('../../src/services/host/hfRecipes.ts')

const recipeFile = join(home, 'drift-recipes.json')
const previousRecipes = process.env.MERCURY_HOST_RECIPES_FILE
const fixtureRecipe = { ...HOST_RECIPES.find(row => row.id === 'glm53-flash-b200-community')!, vramGb: 180 }
writeFileSync(recipeFile, JSON.stringify({ version: 1, recipes: [fixtureRecipe] }))
process.env.MERCURY_HOST_RECIPES_FILE = recipeFile

const runpod = await runpodFixture()
const lambda = await lambdaFixture()
const hf = await hfFixture()
try {
  const api = new RunpodClient(runpod.key, runpod.baseUrl)
  const offers = await api.offers(signal())
  const offer = offers.find(row => row.recipe.id === fixtureRecipe.id) ?? offers[0]!
  for (const name of ['drift-a', 'drift-b', 'drift-c']) await api.create(offer, sshKey, name)

  runpod.state.podPageSize = 2
  runpod.state.podListReads = 0
  const paged = await api.pods(signal())
  check('Runpod pod list walks every cursor page the spec documents', paged.length === 3 && runpod.state.podListReads === 2, { pods: paged.length, reads: runpod.state.podListReads })
  runpod.state.podCursorLost = true
  const lost = await failure(() => api.pods(signal()))
  check('a pod page that says more exist but names no cursor is reported incomplete, never read as complete', /incomplete/.test(lost), lost)
  runpod.state.podCursorLost = false
  runpod.state.repeatPodCursor = true
  const repeated = await failure(() => api.pods(signal()))
  check('a repeated pod-list cursor is reported incomplete', /incomplete/.test(repeated), repeated)
  runpod.state.repeatPodCursor = false
  runpod.state.podPageSize = 1000

  const stream = 'id: 2026-10-22T20:00:00.000Z\ndata: {"source":"system","line":"pod assigned to machine","ts":"2026-10-22T20:00:00.000Z"}\n\nid: 2026-10-22T20:00:01.000Z\ndata: {"source":"container","line":"Pulling image","ts":"2026-10-22T20:00:01.000Z"}\n\ndata: {"source":"container","line":"half a fr'
  const decoded = typeof podLogLines === 'function' ? podLogLines(stream) : undefined
  check('the pod log stream decodes to its documented event lines, the cut tail dropped', JSON.stringify(decoded) === JSON.stringify(['system: pod assigned to machine', 'Pulling image']), decoded)
  runpod.state.logLines = [...Array.from({ length: 14 }, (_, index) => ({ source: 'container', line: 'container line ' + (index + 1) })), { source: 'container', line: 'token ' + runpod.key + ' printed' }]
  const words = await api.logs(paged[0]!.id)
  const lines = words.split('\n')
  check('pod logs show the vendor’s log lines, not SSE frames, the last twelve, with the key redacted', lines.length === 12 && lines[0] === 'container line 4' && lines[11] === 'token [redacted] printed' && !words.includes('data:') && !words.includes('"source"'), lines)
  runpod.state.logLines = null
  const tailAsked = runpod.requests.filter(row => row.path.endsWith('/logs')).at(-1)!
  check('the log read asks the stream for a tail the spec accepts', /^\?tail=\d+$/.test(tailAsked.search) && Number(tailAsked.search.slice(6)) <= 5000, tailAsked.search)

  runpod.state.createOutcomes.push('refuse422')
  const refused = await failure(() => api.create(offer, sshKey, 'drift-422'))
  check('a 422 carries the vendor’s validation lines, not just its title', /request validation failed · \$\.gpu\.minCudaVersion: does not match pattern/.test(refused) && /no pod was created/.test(refused), refused)
  let typed: unknown
  try { runpod.state.createOutcomes.push('refuse422'); await api.create(offer, sshKey, 'drift-422-typed') } catch (error) { typed = error }
  check('a 422 is a refusal with its detail kept on the error', typed instanceof RunpodHttpError && createRefusal(typed) !== undefined && typed.detail.includes('minCudaVersion'), typed instanceof Error ? typed.message : typed)

  const hour = 3600_000
  const now = Date.parse('2026-10-22T21:00:00.000Z')
  const started = new Date(now - hour).toISOString()
  const billed = [
    { status: 'PROVISIONING', cost: 1, startedAt: null, createdAt: started },
    { status: 'STARTING', cost: 2, startedAt: started, createdAt: started },
    { status: 'RUNNING', cost: 4, startedAt: started, createdAt: started },
    { status: 'ERROR', cost: 8, startedAt: started, createdAt: started },
    { status: 'EXITED', cost: 0, startedAt: started, createdAt: started },
    { status: 'TERMINATED', cost: 0, startedAt: started, createdAt: started },
    { status: 'BOOTING', cost: 16, startedAt: started, createdAt: started },
    { status: 'TERMINATING', cost: 32, startedAt: started, createdAt: started },
  ]
  const spend = typeof hostSpendSoFar === 'function' ? hostSpendSoFar(billed, now) : undefined
  check('the spend estimate counts every status the vendors bill — STARTING, ERROR, BOOTING and TERMINATING included — and never EXITED or TERMINATED', spend === 63 && typeof hostPodBills === 'function' && !hostPodBills({ status: 'EXITED' }) && !hostPodBills({ status: 'TERMINATED' }) && hostPodBills({ status: 'STARTING' }), spend)

  const lambdaApi = new LambdaClient(lambda.key, lambda.baseUrl, { pollMs: 10, readyTimeoutMs: 2000 })
  const lambdaOffers = await lambdaApi.offers(signal())
  lambda.state.bootIp = '127.0.0.1'
  for (const name of ['lambda-a', 'lambda-b', 'lambda-c']) await lambdaApi.create(lambdaOffers[0]!, sshKey, name)
  lambda.state.pageSize = 2
  lambda.state.listPages = 0
  const instances = await lambdaApi.pods(signal()).catch(() => [])
  const listed = lambda.requests.filter(row => row.path === '/api/v1/instances' && row.method === 'GET').slice(-2)
  check('Lambda instance list walks page_token pages at the spec’s largest page size instead of refusing', instances.length === 3 && lambda.state.listPages === 2, { instances: instances.length, pages: lambda.state.listPages })
  check('each Lambda page asks for page_size=100 and resumes from the vendor’s token', listed.length === 2 && listed.every(row => row.search.includes('page_size=100')) && !listed[0]!.search.includes('page_token') && listed[1]!.search.includes('page_token=2'), listed.map(row => row.search))
  lambda.state.repeatPageToken = true
  const stuck = await failure(() => lambdaApi.pods(signal()))
  check('a repeated Lambda page token is reported as an incomplete list', /incomplete/.test(stuck), stuck)
  lambda.state.repeatPageToken = false
  lambda.state.pageSize = 50
  check('the Lambda fixture refuses a duplicate key name with the vendor’s own error code', lambda.state.keyCreates === 1 && lambda.state.keys.length === 1, { creates: lambda.state.keyCreates, keys: lambda.state.keys.length })

  hf.state.rateLimited = true
  const limited = await searchHuggingFace('deepseek', { base: hf.baseUrl })
  check('a Hub 429 on search says the rate limit was reached, when it resets and that signing in lifts it — not "unreachable"', limited.state === 'offline' && limited.words === HF_RATE_LIMIT_WORDS + ' · resets in 117 s · sign in with /logins huggingface for a higher limit', limited)
  const limitedWithToken = await searchHuggingFace('deepseek', { base: hf.baseUrl, token: hf.token })
  check('with a token the 429 words keep the reset and drop the sign-in hint', limitedWithToken.state === 'offline' && limitedWithToken.words === HF_RATE_LIMIT_WORDS + ' · resets in 117 s', limitedWithToken)
  const limitedRepo = await fetchHuggingFaceRepo(hf.repos.fp8.id, { base: hf.baseUrl })
  check('a Hub 429 on the repo read says so and that nothing was derived', !limitedRepo.ok && limitedRepo.words === HF_RATE_LIMIT_WORDS + ' · resets in 117 s · sign in with /logins huggingface for a higher limit · nothing was derived', limitedRepo)
  hf.state.rateLimited = false
  hf.state.down = true
  const down = await searchHuggingFace('deepseek', { base: hf.baseUrl })
  check('a Hub that cannot be reached still says unreachable', down.state === 'offline' && down.words === HF_OFFLINE_WORDS, down)
  hf.state.down = false
} finally {
  await Promise.all([runpod.close(), lambda.close(), hf.close()])
  if (previousRecipes === undefined) delete process.env.MERCURY_HOST_RECIPES_FILE; else process.env.MERCURY_HOST_RECIPES_FILE = previousRecipes
  globalThis.fetch = originalFetch
}
console.log('prove-vendor-drift: ' + checks + ' checks, ' + failures + ' failed')
process.exitCode = failures ? 1 : 0
