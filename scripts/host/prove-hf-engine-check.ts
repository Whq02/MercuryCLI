import assert from 'node:assert/strict'
import { mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pinSourceRef } from '../lib/settingsPopupHarness.ts'
import { fixtureExtraRepos, ggufFixtureShards, ggufHeaderBytes, hfFixture } from './hfFixture.mjs'

const home = process.env.MERCURY_CONFIG_DIR
assert.ok(home && !resolve(home).startsWith(join(homedir(), '.mercury')), 'a scratch config home outside the real config is required')
mkdirSync(home, { recursive: true })
delete process.env.MERCURY_HOME
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
pinSourceRef()
let checks = 0
const check = (name: string, value: unknown) => { assert.ok(value, name); checks++; console.log('PASS ' + name) }
const originalFetch = globalThis.fetch
globalThis.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  assert.ok(url.protocol === 'http:' && url.hostname === '127.0.0.1', 'proof traffic stays on loopback: ' + url.origin)
  return originalFetch(input, init)
}, originalFetch)

const hf = await hfFixture({ extra: [fixtureExtraRepos.exl3, fixtureExtraRepos.hqq] })
try {
  const { parseGgufHeader, tensorFamily, compareGgufWithEngine, readGgufHeader, checkGgufAgainstEngine, LLAMACPP_ENGINE_TABLE, hubFileUrl } = await import('../../src/services/host/ggufHeader.ts')
  const { searchHuggingFace, pickHuggingFaceModel, deriveHostRecipe, derivedRecipeWords, forgetDerivedHfRecipes, unloadableQuantisation, HF_LOOK_FOR_WORDS } = await import('../../src/services/host/hfRecipes.ts')
  const { LLAMACPP_ENGINE_SHA } = await import('../../src/services/host/recipes.ts')
  const { forgetSessionHostRecipes } = await import('../../src/services/host/recipesFile.ts')
  const short = LLAMACPP_ENGINE_SHA.slice(0, 7)
  check('the engine table was generated at the pinned llama.cpp', LLAMACPP_ENGINE_TABLE.llamacpp === LLAMACPP_ENGINE_SHA && LLAMACPP_ENGINE_TABLE.architectures.length > 100 && LLAMACPP_ENGINE_TABLE.tensors.length > 200 && !LLAMACPP_ENGINE_TABLE.architectures.includes('(unknown)'))

  const bytes = ggufHeaderBytes({ architecture: 'glm5-next', kv: { 'glm5-next.block_count': 46, 'tokenizer.ggml.tokens': ['a', 'b'], 'tokenizer.chat_template': 'x'.repeat(5000), 'general.flag': true }, tensors: ['token_embd.weight', 'blk.45.nextn.eh_proj.weight', 'blk.3.exp_probs_b.bias'] })
  const parsed = parseGgufHeader(new Uint8Array(bytes))
  check('a GGUF header parses: magic, version, counts, metadata, tensor names', parsed.state === 'ok' && parsed.header.architecture === 'glm5-next' && parsed.header.tensorCount === 3 && parsed.header.kv['glm5-next.block_count'] === 46 && parsed.header.kv['general.flag'] === true && parsed.header.tensors.join(',') === 'token_embd.weight,blk.45.nextn.eh_proj.weight,blk.3.exp_probs_b.bias' && parsed.header.headerBytes === bytes.length)
  check('a truncated header asks for more bytes, a non-GGUF file is refused', parseGgufHeader(new Uint8Array(bytes.subarray(0, 300))).state === 'more' && parseGgufHeader(new Uint8Array(Buffer.from('version https://git-lfs'))).state === 'bad')
  check('tensor families drop the block number and the weight/bias suffix', tensorFamily('blk.45.nextn.eh_proj.weight') === 'blk.N.nextn.eh_proj' && tensorFamily('blk.3.exp_probs_b.bias') === 'blk.N.exp_probs_b' && tensorFamily('blk.2.ffn_gate.7.weight') === 'blk.N.ffn_gate.N' && tensorFamily('output.weight') === 'output')

  const fixtures = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/gguf-headers.json'), 'utf8')) as { headers: Record<string, { repo: string; architecture: string; tensors: string[]; shards: number }> }
  for (const [name, fixture] of Object.entries(fixtures.headers)) {
    const verdict = compareGgufWithEngine([{ version: 3, tensorCount: fixture.tensors.length, architecture: fixture.architecture, kv: {}, tensors: fixture.tensors, headerBytes: 0 }])
    check('the real header of ' + fixture.repo + ' (' + name + ') passes: ' + verdict.words, verdict.ok && verdict.words.startsWith('header read · architecture ' + fixture.architecture + ' · ' + fixture.tensors.length + ' tensors in ') && verdict.words.endsWith('all known to llama.cpp ' + short))
  }
  const cypherfox = fixtures.headers.cypherfox!
  check('the Cypherfox file carries the NextN tensors the engine knows and sets aside', cypherfox.tensors.includes('blk.45.nextn.eh_proj.weight') && LLAMACPP_ENGINE_TABLE.tensors.includes('blk.N.nextn.eh_proj') && LLAMACPP_ENGINE_TABLE.tensors.includes('blk.N.ffn_gate_shexp'))
  const fork = compareGgufWithEngine([{ version: 3, tensorCount: cypherfox.tensors.length, architecture: 'glm5next', kv: {}, tensors: cypherfox.tensors, headerBytes: 0 }])
  check('the fork-format originals (architecture glm5next) are refused with the words', !fork.ok && fork.words === 'engine cannot load this file: its architecture "glm5next" is not known to llama.cpp ' + short + ' · a newer llama.cpp is needed')
  const family = compareGgufWithEngine([{ version: 3, tensorCount: 2, architecture: 'glm5-next', kv: {}, tensors: ['token_embd.weight', 'blk.0.ffn_gate_router_fancy.weight', 'blk.1.ffn_gate_router_fancy.weight'], headerBytes: 0 }])
  check('an unknown tensor family is refused with the family named', !family.ok && family.words === 'engine cannot load this file: 1 tensor family is unknown to llama.cpp ' + short + ' (e.g. blk.N.ffn_gate_router_fancy) · a newer llama.cpp is needed')
  check('a header without an architecture is refused', !compareGgufWithEngine([{ version: 3, tensorCount: 0, kv: {}, tensors: [], headerBytes: 0 }]).ok)

  const base = hf.baseUrl
  const gguf = hf.repos.gguf
  const firstShard = gguf.files.find(file => file.path.endsWith('Q4_K_M-00001-of-00004.gguf'))!.path
  const shards = ggufFixtureShards('ok')
  check('the fixture’s first shard carries the metadata and no tensors, like unsloth’s uploads', parseGgufHeader(new Uint8Array(shards[0]!)).state === 'ok' && (parseGgufHeader(new Uint8Array(shards[0]!)) as { header: { tensorCount: number; headerBytes: number } }).header.tensorCount === 3 && shards[0]!.length > 700 * 1024)
  hf.state.ranges.length = 0; hf.state.resolveBytes = 0
  const read = await readGgufHeader(hubFileUrl(base, gguf.id, 'main', firstShard), { token: hf.token })
  check('the first shard’s header is read by growing range requests, never the file', read.ok && read.header.architecture === 'deepseek2' && hf.state.ranges.length >= 2 && hf.state.ranges[0]!.start === 0 && hf.state.ranges[0]!.end === 256 * 1024 - 1 && hf.state.ranges[1]!.start === 256 * 1024 && hf.state.resolveBytes < 2 * 1024 * 1024)
  check('the range requests carry the Hugging Face token and no request asks for the body', hf.requests.filter(row => row.path.includes('/resolve/')).every(row => row.range && row.authorization === 'Bearer ' + hf.token))

  hf.state.ggufVariant = 'redirect'
  const redirected = await readGgufHeader(hubFileUrl(base, gguf.id, 'main', firstShard), { token: hf.token })
  check('a 302 to the file store is followed with the range request', redirected.ok && redirected.header.architecture === 'deepseek2' && hf.requests.some(row => row.path.includes('/resolve/') && row.search === '?cdn=1' && row.range))
  hf.state.ggufVariant = 'no-range'
  const whole = await readGgufHeader(hubFileUrl(base, gguf.id, 'main', firstShard), { token: hf.token })
  check('a server that ignores Range still yields the header from the start of its 200 body', whole.ok && whole.header.architecture === 'deepseek2')
  hf.state.ggufVariant = 'ok'

  const all = await checkGgufAgainstEngine(base, gguf.id, 'main', firstShard, { token: hf.token })
  check('the sharded check reads every shard’s header and passes a known file: ' + all.words, all.state === 'known' && all.words === 'header read · architecture deepseek2 · ' + (3 + 18 * 60) + ' tensors in 21 families, all known to llama.cpp ' + short && hf.state.ranges.filter(row => row.start === 0).length >= 4)
  hf.state.ggufVariant = 'fork'
  const forkRead = await checkGgufAgainstEngine(base, gguf.id, 'main', firstShard, { token: hf.token })
  check('a fork-format first shard is refused before any shard beyond it is read', forkRead.state === 'unknown' && forkRead.words.includes('"glm5next" is not known'))
  hf.state.ggufVariant = 'unknown-family'
  const familyRead = await checkGgufAgainstEngine(base, gguf.id, 'main', firstShard, { token: hf.token })
  check('an unknown family in a later shard is refused', familyRead.state === 'unknown' && familyRead.words.includes('(e.g. blk.N.ffn_gate_router_fancy)'))
  hf.state.ggufVariant = 'gated'
  const gatedRead = await checkGgufAgainstEngine(base, gguf.id, 'main', firstShard, { token: hf.token })
  check('a 403 on the file header is honest and not a refusal of the model', gatedRead.state === 'unread' && gatedRead.words === 'engine check skipped · Hugging Face answered HTTP 403 for the file header (gated · sign in with /logins huggingface or accept the terms at https://huggingface.co/' + gguf.id + ')')
  hf.state.ggufVariant = 'not-gguf'
  const pointer = await checkGgufAgainstEngine(base, gguf.id, 'main', firstShard, { token: hf.token })
  check('a file that is not a GGUF (an LFS pointer) is refused as unloadable', pointer.state === 'unknown' && pointer.words === 'engine cannot load this file: the file does not start with GGUF')
  hf.state.ggufVariant = 'ok'
  hf.state.down = true
  const down = await checkGgufAgainstEngine(base, gguf.id, 'main', firstShard, { token: hf.token, timeoutMs: 2000 })
  check('a Hub that does not answer is honest and not a refusal', down.state === 'unread' && down.words.startsWith('engine check skipped · Hugging Face did not answer the file header'))
  hf.state.down = false

  const search = await searchHuggingFace('deepseek', { base, token: hf.token })
  assert.ok(search.state === 'ready')
  const models = search.models
  const ggufModel = models.find(model => model.id === gguf.id)!
  forgetDerivedHfRecipes(); forgetSessionHostRecipes()
  const picked = await pickHuggingFaceModel(ggufModel, { base, token: hf.token })
  check('picking a known GGUF derives the row with the engine check on it', picked.ok && picked.row.engineCheck?.startsWith('header read · architecture deepseek2') === true && picked.row.recipe.verification.endsWith(' · header checked against the engine'))
  check('engine check data remains internal rather than a row stamp', picked.ok && picked.row.engineCheck?.includes('header read · architecture deepseek2') === true && !derivedRecipeWords(picked.row.recipe)?.includes('header read'))
  forgetDerivedHfRecipes(); forgetSessionHostRecipes()
  hf.state.ggufVariant = 'fork'
  const refused = await pickHuggingFaceModel(ggufModel, { base, token: hf.token })
  check('picking the fork-format file is refused before the rent, with the words', !refused.ok && refused.words === gguf.id + ' · engine cannot load this file: its architecture "glm5next" is not known to llama.cpp ' + short + ' · a newer llama.cpp is needed')
  forgetDerivedHfRecipes(); forgetSessionHostRecipes()
  hf.state.ggufVariant = 'gated'
  const unread = await pickHuggingFaceModel(ggufModel, { base, token: hf.token })
  check('a gated file header leaves the derived row with honest words', unread.ok && unread.row.engineCheck?.startsWith('engine check skipped · Hugging Face answered HTTP 403') === true && unread.row.recipe.verification.endsWith(' · header unread'))
  hf.state.ggufVariant = 'ok'

  const exl3 = models.find(model => model.id === fixtureExtraRepos.exl3.id)!
  const fp8 = models.find(model => model.id === hf.repos.fp8.id)!
  const hqq = models.find(model => model.id === fixtureExtraRepos.hqq.id)!
  const exlWords = 'this file is an EXL3 quantisation; none of Mercury’s engines (vLLM, SGLang, llama.cpp) run it — ' + HF_LOOK_FOR_WORDS
  check('the EXL3 repo is named unloadable from its config, its library and its k-map file', unloadableQuantisation(exl3) === exlWords && unloadableQuantisation({ ...exl3, config: {}, library: undefined, tags: [] }, {}, [{ path: 'exl3_k_map.json', size: 1 }]) === exlWords && unloadableQuantisation({ ...exl3, config: {}, library: undefined, tags: ['exl2'] }) === 'this file is an EXL2 quantisation; none of Mercury’s engines (vLLM, SGLang, llama.cpp) run it — ' + HF_LOOK_FOR_WORDS)
  check('the FP8 repo and an unquantised repo are loadable', unloadableQuantisation(fp8) === undefined && unloadableQuantisation(hf.repos.gated as never) === undefined)
  check('a quant method vLLM’s registry does not name is refused with the method', unloadableQuantisation(hqq) === 'this file is a HQQ quantisation, which vLLM does not load — ' + HF_LOOK_FOR_WORDS)
  forgetDerivedHfRecipes(); forgetSessionHostRecipes()
  const exlPick = await pickHuggingFaceModel(exl3, { base, token: hf.token })
  check('picking the EXL3 repo is refused before the rent, with the lead’s words', !exlPick.ok && exlPick.words === exl3.id + ' · ' + exlWords)
  const fp8Pick = await pickHuggingFaceModel(fp8, { base, token: hf.token })
  check('picking the FP8 DeepSeek repo still derives the vLLM row', fp8Pick.ok && fp8Pick.row.engine === 'vLLM' && fp8Pick.row.engineCheck === undefined)
  const direct = deriveHostRecipe(exl3, fixtureExtraRepos.exl3.files, fixtureExtraRepos.exl3.rawConfig as Record<string, unknown>)
  check('the derivation itself refuses EXL3 from the raw config', !direct.ok && direct.reason === exlWords)
  console.log('HF ENGINE CHECK GREEN · ' + checks + ' checks; loopback Hub fixture, real header fixtures of three files read off the Hub on 2026-10-23, llama.cpp ' + short)
} finally {
  await hf.close()
}
