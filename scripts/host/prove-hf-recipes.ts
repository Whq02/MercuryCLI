import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { hfFixture } from './hfFixture.mjs'

const home = process.env.MERCURY_CONFIG_DIR
assert.ok(home && !resolve(home).startsWith(join(homedir(), '.mercury')), 'a scratch config home outside the real config is required')
mkdirSync(home, { recursive: true })
delete process.env.MERCURY_HOME
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
let checks = 0
const check = (name: string, value: unknown) => { assert.ok(value, name); checks++; console.log('PASS ' + name) }
const originalFetch = globalThis.fetch
const fetches: string[] = []
globalThis.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  assert.ok(url.protocol === 'http:' && url.hostname === '127.0.0.1', 'proof traffic stays on loopback: ' + url.origin)
  fetches.push(String(url))
  return originalFetch(input, init)
}, originalFetch)
const hf = await hfFixture()
try {
  const { searchHuggingFace, fetchHuggingFaceRepo, deriveHostRecipe, pickHuggingFaceModel, hfRowLabel, hfModelChat, derivedHfRecipe, derivedRecipeWords, forgetDerivedHfRecipes, chooseGgufQuant, HF_OFFLINE_WORDS, HF_PROOF_WORDS, HF_GATED_WORDS, HF_NOT_CHAT_WORDS } = await import('../../src/services/host/hfRecipes.ts')
  const { hostRecipeSchema, currentHostRecipes, sessionHostRecipes, forgetSessionHostRecipes } = await import('../../src/services/host/recipesFile.ts')
  const { HOST_RECIPES } = await import('../../src/services/host/recipes.ts')
  const base = hf.baseUrl

  const dark = await searchHuggingFace('deepseek', {})
  check('a proof-shape run with the seam unset reaches nothing and says so', dark.state === 'offline' && dark.words === HF_PROOF_WORDS && fetches.length === 0)
  const darkRepo = await fetchHuggingFaceRepo('unsloth/DeepSeek-V4.1-Flash-GGUF', {})
  check('a repo read in a proof-shape run with the seam unset reaches nothing', !darkRepo.ok && fetches.length === 0)

  const found = await searchHuggingFace('deepseek', { base })
  assert.equal(found.state, 'ready', 'the fixture search answers')
  const models = found.state === 'ready' ? found.models : []
  check('the search asks the Hub for text generation sorted by downloads with the fields the rows need', hf.state.searches === 1 && hf.state.lastSearch?.query === 'deepseek' && /pipeline_tag=text-generation/.test(hf.state.lastSearch!.params) && /sort=downloads/.test(hf.state.lastSearch!.params) && /limit=20/.test(hf.state.lastSearch!.params) && ['siblings', 'safetensors', 'cardData', 'config', 'gguf', 'gated', 'private', 'library_name', 'tags', 'downloads', 'pipeline_tag'].every(key => hf.state.lastSearch!.params.includes('expand=' + key)))
  check('four fixture repos come back sorted by downloads', models.map(model => model.id).join(' ') === [hf.repos.fp8.id, hf.repos.vision.id, hf.repos.gguf.id, hf.repos.gated.id].join(' '))
  const gguf = models.find(model => model.id === hf.repos.gguf.id)!
  const fp8 = models.find(model => model.id === hf.repos.fp8.id)!
  const gated = models.find(model => model.id === hf.repos.gated.id)!
  const vision = models.find(model => model.id === hf.repos.vision.id)!
  check('rows carry size · format · downloads · licence · gated', hfRowLabel(fp8) === fp8.id + ' · 284B · safetensors FP8 · ↓ 3.4M · MIT · unverified' && hfRowLabel(gguf) === gguf.id + ' · 284B · GGUF Q4_K_M · ↓ 412k · MIT · unverified' && hfRowLabel(gated) === gated.id + ' · 36B · safetensors BF16 · ↓ 1.2k · MIT · 🔒 gated · unverified')
  check('the vision repo is listed as not a chat model and cannot be picked', hfRowLabel(vision).includes(HF_NOT_CHAT_WORDS + ' (vision)') && !hfModelChat(vision).ok)
  check('the padded id keeps the columns aligned', hfRowLabel(gguf, 48).startsWith(gguf.id.padEnd(48) + ' · '))

  const ggufRepo = await fetchHuggingFaceRepo(gguf.id, { base })
  assert.ok(ggufRepo.ok, 'the GGUF tree is read')
  check('the tree read asks for the recursive file list and skips config.json when the repo has none', hf.state.trees === 1 && hf.state.configs === 0 && ggufRepo.files.filter(file => file.path.endsWith('.gguf')).length === 23)
  const quant = chooseGgufQuant(ggufRepo.files)!
  check('Q4_K_M is preferred and its shards are gathered by -00001-of-N', quant.quant === 'Q4_K_M' && quant.files.length === 4 && quant.bytes === 120e9)
  const ggufDerived = deriveHostRecipe(gguf, ggufRepo.files, ggufRepo.config)
  assert.ok(ggufDerived.ok, 'the GGUF recipe derives: ' + JSON.stringify(ggufDerived))
  const llama = HOST_RECIPES.find(row => row.engine === 'llamacpp' && row.install)!
  const g = ggufDerived.recipe
  check('GGUF → llama.cpp with the shipped image and install, the chosen quant as weightFile and include', g.engine === 'llamacpp' && g.image === llama.image && g.install === llama.install && g.cuda === llama.cuda && g.weightFile === 'Q4_K_M/DeepSeek-V4.1-Flash-Q4_K_M-00001-of-00004.gguf' && g.include === 'Q4_K_M/DeepSeek-V4.1-Flash-Q4_K_M-0000*')
  check('GGUF memory = file sizes × 1.2 → the smallest shape that fits (120 GB → 144 GB → 2× H100)', g.weightsGb === 120 && g.gpu === 'H100' && g.count === 2 && g.vramGb === 80 && g.diskGb === 200)
  check('GGUF preserves the repo-declared context per slot without imposing a smaller ceiling', g.context === 1048576 && g.contextPerSlot === 1048576 && g.flags.join(' ').includes('--ctx-size 4194304 --parallel 4') && g.flags.includes('--jinja'))
  for (const context of [32768, 2097152, undefined]) {
    const variation = deriveHostRecipe({ ...gguf, ggufContext: context }, ggufRepo.files, ggufRepo.config)
    assert.ok(variation.ok)
    const expected = context ?? 131072
    check('GGUF context ' + (context ?? 'unknown') + ' retains its declaration or the unknown-context default', variation.recipe.context === expected && variation.recipe.contextPerSlot === expected && variation.recipe.flags.join(' ').includes('--ctx-size ' + expected * 4 + ' --parallel 4'))
  }
  check('the GGUF recipe is stamped unverified with the repo as its source and passes the schema', g.verified.by === 'unverified' && g.verified.source === 'https://huggingface.co/' + gguf.id && /^\d{4}-\d{2}-\d{2}$/.test(g.verified.on!) && g.verified.note!.includes('nobody has booted this recipe') && g.id === 'hf-unsloth-deepseek-v4.1-flash-gguf' && g.label === gguf.id + ' · Q4_K_M' && g.model === gguf.id && hostRecipeSchema.safeParse(g).success && ggufDerived.engine === 'llama.cpp' && ggufDerived.format === 'GGUF Q4_K_M')

  const fp8Repo = await fetchHuggingFaceRepo(fp8.id, { base })
  assert.ok(fp8Repo.ok, 'the FP8 tree and config are read')
  check('a safetensors repo reads its raw config.json', hf.state.configs === 1 && fp8Repo.config.max_position_embeddings === 1048576)
  const fp8Derived = deriveHostRecipe(fp8, fp8Repo.files, fp8Repo.config)
  assert.ok(fp8Derived.ok, 'the FP8 recipe derives: ' + JSON.stringify(fp8Derived))
  const v = fp8Derived.recipe
  check('safetensors → vLLM with --max-model-len from the config and --tensor-parallel-size = the GPU count', v.engine === 'vllm' && v.image === 'vllm/vllm-openai:latest' && v.flags.join(' ') === '--max-model-len 1048576 --tensor-parallel-size 2' && v.context === 1048576)
  check('FP8 memory = params × 1 byte (BF16 × 2) × 1.2 → 2× B200; weights and disk from the file sizes', v.gpu === 'B200' && v.count === 2 && v.vramGb === 180 && v.weightsGb === 288 && v.diskGb === 450 && v.label === fp8.id + ' · FP8' && hostRecipeSchema.safeParse(v).success && fp8Derived.engine === 'vLLM' && fp8Derived.format === 'safetensors FP8')

  const visionDerived = deriveHostRecipe(vision, [{ path: 'model.safetensors', size: 6e9 }, { path: 'config.json', size: 4096 }], { architectures: ['DeepseekOCRForConditionalGeneration'] })
  check('the vision repo is refused by the derivation', !visionDerived.ok && visionDerived.reason.includes(HF_NOT_CHAT_WORDS))
  const visionPick = await pickHuggingFaceModel(vision, { base })
  check('picking the vision repo says not a chat model and reads nothing', !visionPick.ok && visionPick.words.includes(HF_NOT_CHAT_WORDS) && hf.state.trees === 2)

  const gatedPick = await pickHuggingFaceModel(gated, { base })
  check('a gated repo without a token says sign in with /logins huggingface and reads nothing', !gatedPick.ok && gatedPick.words === gated.id + ' · ' + HF_GATED_WORDS && hf.state.trees === 2)
  const gatedPicked = await pickHuggingFaceModel(gated, { base, token: hf.token })
  assert.ok(gatedPicked.ok, 'a gated repo with the token derives: ' + JSON.stringify(gatedPicked))
  check('with the token the tree is read with the bearer and the BF16 recipe fits 1× H200 (72 GB × 1.2)', hf.requests.some(row => /\/tree\/[a-f0-9]{40}$/.test(row.path) && row.authorization === 'Bearer ' + hf.token) && gatedPicked.row.recipe.gpu === 'H200' && gatedPicked.row.recipe.count === 1 && gatedPicked.row.recipe.label === gated.id + ' · BF16' && gatedPicked.row.recipe.flags.join(' ') === '--max-model-len 131072 --tensor-parallel-size 1')
  check('no token ever reaches a record: the recipe carries the repo URL and the stamp, never the bearer', !JSON.stringify(gatedPicked.row.recipe).includes(hf.token))

  const picked = await pickHuggingFaceModel(gguf, { base })
  assert.ok(picked.ok, 'the GGUF pick derives')
  const treesAfterPick = hf.state.trees
  const again = await pickHuggingFaceModel(gguf, { base })
  check('a pick is remembered by repo id: the second pick reads nothing and returns the same recipe', again.ok && again.row === picked.row && hf.state.trees === treesAfterPick && derivedHfRecipe(gguf.id) === picked.row)
  check('a picked recipe joins the session list the road reads, after the shipped recipes, never the shipped file', currentHostRecipes().at(-1)?.id === picked.row.recipe.id && sessionHostRecipes().some(row => row.id === picked.row.recipe.id) && !HOST_RECIPES.some(row => row.id === picked.row.recipe.id))
  const words = derivedRecipeWords(picked.row.recipe)!
  check('the RECIPE line reads unverified with the engine, format and size and the price-confirm and pod-guard promise', words.startsWith('RECIPE · unverified — recipe derived from the repo’s config and file list a moment ago (engine llama.cpp · GGUF Q4_K_M · 120 GB); nobody has booted this exact recipe yet.') && words.endsWith('The price is confirmed before anything is rented; the pod guard terminates a pod that never answers.') && derivedRecipeWords(picked.row.recipe, Date.now() + 3 * 60_000)!.includes('3 min ago') && derivedRecipeWords(HOST_RECIPES[0]!) === undefined)

  forgetDerivedHfRecipes(); forgetSessionHostRecipes()
  check('forgetting the session leaves the shipped list alone', !currentHostRecipes().some(row => row.id.startsWith('hf-')))

  hf.state.delayMs = 400
  const slow = await searchHuggingFace('deepseek', { base, timeoutMs: 100 })
  check('a timeout yields the offline words, never a throw', slow.state === 'offline' && slow.words === HF_OFFLINE_WORDS)
  hf.state.delayMs = 0
  hf.state.down = true
  const refused = await searchHuggingFace('deepseek', { base })
  const refusedRepo = await fetchHuggingFaceRepo(fp8.id, { base })
  check('a refused connection yields the offline words for the search and the repo read', refused.state === 'offline' && refused.words === HF_OFFLINE_WORDS && !refusedRepo.ok && refusedRepo.words.includes('unreachable'))
  hf.state.down = false
  check('every request stayed on the loopback fixture', fetches.every(url => url.startsWith(base)))
  console.log('HF RECIPES GREEN — ' + checks + ' checks; loopback fixture only; no real key or token')
} finally {
  globalThis.fetch = originalFetch
  await hf.close()
}
