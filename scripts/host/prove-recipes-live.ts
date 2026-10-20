import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { flagEnv } from '../../src/substrate/flagRegistry.ts'
import { HOST_RECIPES, type HostRecipe } from '../../src/services/host/recipes.ts'
import {
  HOST_RECIPES_FILE_VERSION,
  HOST_RECIPES_URL,
  SHIPPED_HOST_RECIPES_PATH,
  exportHostRecipesJson,
  hostRecipeSchema,
  hostRecipesCachePath,
   hostRecipesFileSchema,
  loadHostRecipes,
  resetHostRecipesFetchState,
} from '../../src/services/host/recipesFile.ts'
import { RunpodClient } from '../../src/services/host/runpod.ts'
import { runpodFixture } from './runpodFixture.mjs'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
const rootScratch = mkdtempSync(join(process.env.MERCURY_CONFIG_DIR, 'recipes-live-'))

let checks = 0
const check = (name: string, truth: unknown): void => {
  assert.ok(truth, name)
  checks++
  console.log('PASS ' + name)
}

const freshHome = (label: string): string => {
  const dir = join(rootScratch, label)
  mkdirSync(dir, { recursive: true })
  process.env.MERCURY_CONFIG_DIR = dir
  delete process.env.MERCURY_HOME
  resetHostRecipesFetchState()
  return dir
}

const rp = await runpodFixture()
let serverRequests = 0
let servedStatus = 200
let servedBody: unknown = {}
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch() {
    serverRequests++
    return new Response(typeof servedBody === 'string' ? servedBody : JSON.stringify(servedBody), {
      status: servedStatus,
      headers: { 'content-type': 'application/json' },
    })
  },
})
const serverUrl = `http://127.0.0.1:${server.port}/recipes.json`

const shippedPath = join(import.meta.dir, '../..', SHIPPED_HOST_RECIPES_PATH)

try {
  check('shipped recipes JSON exists under assets/host/recipes.json', existsSync(shippedPath))
  const shippedRaw = readFileSync(shippedPath, 'utf8')
  const exportedRaw = exportHostRecipesJson(HOST_RECIPES)
  check('export script reproduces the shipped JSON byte for byte from HOST_RECIPES', exportedRaw === shippedRaw)
  const driftedRaw = exportHostRecipesJson([
    { ...HOST_RECIPES[0]!, diskGb: HOST_RECIPES[0]!.diskGb + 10 },
    ...HOST_RECIPES.slice(1),
  ])
  check('table drift is detected against shipped JSON bytes', driftedRaw !== shippedRaw)
  const parsedShipped = hostRecipesFileSchema.parse(JSON.parse(shippedRaw))
  const sortedIds = [...parsedShipped.recipes.map(row => row.id)].sort((a, b) => a.localeCompare(b))
  check('shipped JSON carries version, publishedAt and recipes sorted deterministically by id', parsedShipped.version === HOST_RECIPES_FILE_VERSION && /^\d{4}-\d{2}-\d{2}$/.test(parsedShipped.publishedAt) && JSON.stringify(parsedShipped.recipes.map(row => row.id)) === JSON.stringify(sortedIds))
  check('HOST_RECIPES_URL points at the raw file on the public repository', HOST_RECIPES_URL === 'https://raw.githubusercontent.com/Whq02/MercuryCLI/main/assets/host/recipes.json')

  check('every row in HOST_RECIPES validates against hostRecipeSchema', HOST_RECIPES.every(row => hostRecipeSchema.safeParse(row).success))
  check('every row verified.source is https and every measured row carries on', HOST_RECIPES.every(row => row.verified.source.startsWith('https://') && (row.verified.by !== 'measured' || Boolean(row.verified.on && /^\d{4}-\d{2}-\d{2}$/.test(row.verified.on)))))
  const glmGguf = HOST_RECIPES.find(row => row.id === 'glm53-flash-gguf-b300')!
  const nemotronGguf = HOST_RECIPES.find(row => row.id === 'nemotron35-super-gguf-rtx-pro-6000')!
  const b200Community = HOST_RECIPES.find(row => row.id === 'glm53-flash-b200-community')!
  check('GLM GGUF row is measured on 2026-10-20 with upstream llama.cpp, cache-reuse 256 and contextPerSlot 131072', glmGguf.verified.by === 'measured' && glmGguf.verified.on === '2026-10-20' && glmGguf.contextPerSlot === 131072 && glmGguf.install?.includes('3bb63cbcbfb62056c84fe9e521b0f3d756d29c32') && !glmGguf.install.includes('unslothai/llama.cpp') && glmGguf.flags.join(' ').includes('--ctx-size 524288 --parallel 4 --flash-attn on --cache-type-k q8_0 --cache-type-v q8_0 --cache-reuse 256'))
  check('Nemotron row is documented, 4x B200 NVFP4 row is community, and SGLang cookbook rows carry cookbook badges in verified.note', nemotronGguf.verified.by === 'documented' && nemotronGguf.contextPerSlot === 131072 && b200Community.verified.by === 'community' && HOST_RECIPES.filter(row => row.source.startsWith('https://docs.sglang.io/cookbook/')).every(row => row.verified.by === 'documented' && (row.verified.note === 'verified' || row.verified.note === 'in-progress')))

  freshHome('unreachable')
  const fallbackFromUnreachable = await loadHostRecipes({ url: 'http://127.0.0.1:1/recipes.json', timeoutMs: 300, forceFetch: true })
  check('unreachable URL falls back silently to the shipped recipes without creating a broken cache', fallbackFromUnreachable.length === HOST_RECIPES.length && !existsSync(hostRecipesCachePath()))

  freshHome('lower-version')
  servedStatus = 200
  servedBody = {
    version: 0,
    publishedAt: '2026-10-19',
    recipes: [{ ...glmGguf, id: 'stale-version-zero-row' }],
  }
  const ignoredLower = await loadHostRecipes({ url: serverUrl, forceFetch: true })
  check('fetched file with a lower version than the shipped file is ignored', ignoredLower.length === HOST_RECIPES.length && !ignoredLower.some(row => row.id === 'stale-version-zero-row'))
  servedBody = {
    version: 1,
    publishedAt: '2026-10-19',
    recipes: [{ ...glmGguf, id: 'stale-version-one-row' }],
  }
  const ignoredLowerAgainstV2Shipped = await loadHostRecipes({
    url: serverUrl,
    forceFetch: true,
    shipped: { version: 2, publishedAt: '2026-10-20', recipes: HOST_RECIPES },
  })
  check('fetched v1 file is ignored when shipped file is v2', !ignoredLowerAgainstV2Shipped.some(row => row.id === 'stale-version-one-row') && ignoredLowerAgainstV2Shipped.length === HOST_RECIPES.length)

  freshHome('higher-version')
  const qwenRtx = HOST_RECIPES.find(row => row.id === 'qwen38-27b-rtx-pro-6000')!
  const unverifiedRow: HostRecipe = {
    ...qwenRtx,
    id: 'aaa-unverified-rtx-pro-6000',
    label: 'Unverified Test · FP8',
    verification: 'unverified',
    verified: { by: 'unverified', source: 'https://docs.sglang.io/cookbook/autoregressive/Qwen/Qwen3.8-27B' },
  }
  const liveV2Row: HostRecipe = {
    ...qwenRtx,
    id: 'zzz-live-v2-rtx-pro-6000',
    label: 'Live V2 Model · FP8',
     verified: { by: 'measured', on: '2026-10-20', note: 'live v2 check', source: 'https://docs.sglang.io/cookbook/autoregressive/Qwen/Qwen3.8-27B' },
  }
  const malformedRow = {
    ...qwenRtx,
    id: 'malformed-measured-without-on',
    verified: { by: 'measured', source: 'http://insecure.example.com/not-https' },
  }
  servedBody = {
    version: HOST_RECIPES_FILE_VERSION + 1,
    publishedAt: '2026-10-21',
    recipes: [unverifiedRow, malformedRow, liveV2Row, nemotronGguf],
  }
  const droppedReasons: string[] = []
  const beforeRequests = serverRequests
  const loadedV2 = await loadHostRecipes({
    url: serverUrl,
    forceFetch: true,
    onDrop: (index, reason) => droppedReasons.push(`${index}:${reason}`),
  })
  check('higher-version fetched file wins and caches to ~/.mercury/host/recipes.json', existsSync(hostRecipesCachePath()) && loadedV2.some(row => row.id === 'zzz-live-v2-rtx-pro-6000'))
  check('malformed row in fetched file is dropped with its reason logged while valid rows load', droppedReasons.length === 1 && droppedReasons[0]!.startsWith('1:') && loadedV2.length === 3 && !loadedV2.some(row => row.id === 'malformed-measured-without-on'))
  check('unverified rows sort last in loadHostRecipes()', loadedV2.at(-1)?.id === 'aaa-unverified-rtx-pro-6000')

  const cachedAgain = await loadHostRecipes({ url: 'http://127.0.0.1:1/must-not-fetch-when-cache-fresh.json' })
  check('cached recipes are reused within the 6-hour TTL without refetching', serverRequests === beforeRequests + 1 && cachedAgain.some(row => row.id === 'zzz-live-v2-rtx-pro-6000'))

  const offersWithUnverified = await new RunpodClient(rp.key, rp.baseUrl).offers(new AbortController().signal)
  check('RunpodClient.offers() reads through loadHostRecipes() and sorts unverified offers last', offersWithUnverified.some(row => row.recipe.id === 'zzz-live-v2-rtx-pro-6000') && offersWithUnverified.at(-1)?.recipe.id === 'aaa-unverified-rtx-pro-6000')

  const localOverridePath = join(rootScratch, 'local-override-recipes.json')
  const localRow: HostRecipe = {
    ...qwenRtx,
    id: 'local-override-rtx-pro-6000',
    label: 'Local Override · FP8',
    verified: { by: 'measured', on: '2026-10-20', note: 'owner experiment', source: 'https://unsloth.ai/docs/models/glm-5.3-flash' },
  }
  writeFileSync(localOverridePath, JSON.stringify({
    version: 1,
    publishedAt: '2026-10-20',
    recipes: [localRow],
  }, null, 2) + '\n')
  process.env.MERCURY_HOST_RECIPES_FILE = localOverridePath
  try {
    check('MERCURY_HOST_RECIPES_FILE is registered in FLAG_REGISTRY and readable through flagEnv', flagEnv('MERCURY_HOST_RECIPES_FILE') === localOverridePath)
    const fromEnvFile = await loadHostRecipes({ url: serverUrl })
    const offersFromEnvFile = await new RunpodClient(rp.key, rp.baseUrl).offers(new AbortController().signal)
    check('MERCURY_HOST_RECIPES_FILE wins over cached and shipped recipes in both loadHostRecipes() and RunpodClient.offers()', fromEnvFile.length === 1 && fromEnvFile[0]!.id === 'local-override-rtx-pro-6000' && offersFromEnvFile.length === 1 && offersFromEnvFile[0]!.recipe.id === 'local-override-rtx-pro-6000')
  } finally {
    delete process.env.MERCURY_HOST_RECIPES_FILE
  }

  console.log('RECIPES LIVE GREEN — ' + checks + ' checks')
} finally {
  server.stop(true)
  await rp.close()
  rmSync(rootScratch, { recursive: true, force: true })
}
