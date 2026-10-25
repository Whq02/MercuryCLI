#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const GIB = 1024 ** 3

const { kvGeometryOf, kvCacheBytes, slidingLayerMask } = await import('../../src/services/localServer/localServerMemory.ts')
const { fitLocalWindow } = await import('../../src/services/localServer/localWindowFit.ts')
const { FAKE_OLLAMA_MODEL_INFO } = await import('./fixtures/fake-ollama.ts')
const { parseGgufHeader } = await import('../../src/services/host/ggufHeader.ts')
const { ggufHeaderBytes } = await import('../host/hfFixture.mjs')

const GEMMA4_31B_MODEL_INFO: Record<string, unknown> = {"gemma4.attention.head_count": 32, "gemma4.attention.head_count_kv": [16, 16, 16, 16, 16, 4, 16, 16, 16, 16, 16, 4, 16, 16, 16, 16, 16, 4, 16, 16, 16, 16, 16, 4, 16, 16, 16, 16, 16, 4, 16, 16, 16, 16, 16, 4, 16, 16, 16, 16, 16, 4, 16, 16, 16, 16, 16, 4, 16, 16, 16, 16, 16, 4, 16, 16, 16, 16, 16, 4], "gemma4.attention.key_length": 512, "gemma4.attention.key_length_swa": 256, "gemma4.attention.layer_norm_rms_epsilon": 1e-06, "gemma4.attention.shared_kv_layers": 0, "gemma4.attention.sliding_window": 1024, "gemma4.attention.sliding_window_pattern": [true, true, true, true, true, false, true, true, true, true, true, false, true, true, true, true, true, false, true, true, true, true, true, false, true, true, true, true, true, false, true, true, true, true, true, false, true, true, true, true, true, false, true, true, true, true, true, false, true, true, true, true, true, false, true, true, true, true, true, false], "gemma4.attention.value_length": 512, "gemma4.attention.value_length_swa": 256, "gemma4.block_count": 60, "gemma4.context_length": 262144, "gemma4.embedding_length": 5376, "general.architecture": "gemma4", "general.parameter_count": 31273089132}
const GEMMA4_31B_WEIGHTS = 19_868_981_791
const USABLE = 36 * GIB
const BOX = 48 * GIB

console.log('\n§1 gemma4:31b as Ollama 0.34.4 states it: 60 layers, 50 sliding-window layers (1024 tokens, 256-wide keys), 10 global layers (512-wide keys)')
{
  const geometry = kvGeometryOf(GEMMA4_31B_MODEL_INFO)
  check('the geometry reads', geometry !== undefined)
  if (geometry !== undefined) {
    check('10 global attention layers carry 40 kv heads at 512/512', geometry.attentionLayers === 10 && geometry.kvHeads === 40 && geometry.keyLength === 512 && geometry.valueLength === 512, JSON.stringify(geometry))
    check('50 sliding layers carry 800 kv heads at 256/256 over a 1024-token window', geometry.sliding?.layers === 50 && geometry.sliding.kvHeads === 800 && geometry.sliding.keyLength === 256 && geometry.sliding.valueLength === 256 && geometry.sliding.window === 1024, JSON.stringify(geometry.sliding))
    const at32k = kvCacheBytes(geometry, 32_768, 1, 'q8_0')
    const at256k = kvCacheBytes(geometry, 262_144, 1, 'q8_0')
    check('the cache at 32k is under 2 GiB (the server measured the whole load at 21 GB beside 18.5 GiB of weights), not 27.9 GiB', at32k < 2 * GIB, `${(at32k / GIB).toFixed(2)} GiB`)
    check('the cache at 256k is about 11 GiB (global layers grow with the window, sliding layers stay capped)', at256k > 10 * GIB && at256k < 12 * GIB, `${(at256k / GIB).toFixed(2)} GiB`)
    const fit = fitLocalWindow({ name: 'gemma4:31b', weightsBytes: GEMMA4_31B_WEIGHTS, geometry, trainedMax: 262_144, machineBytes: BOX, usableBytes: USABLE, slots: 1, cacheType: 'q8_0' })
    check('auto picks the trained 256k on a 48 GiB box with 36 GiB usable, and it fits', fit.window === 262_144 && fit.fits && fit.atMax, `${fit.window} fits=${fit.fits}: ${fit.words}`)
    check('the words say so (no "does not fit")', !fit.words.includes('does not fit'), fit.words)
  }
}

console.log('\n§2 a hybrid without a sliding pattern (qwen3.5:9b, one full-attention layer in four) reads exactly as before')
{
  const geometry = kvGeometryOf(FAKE_OLLAMA_MODEL_INFO)
  check('8 attention layers × 4 heads at 256/256, no sliding part', geometry !== undefined && geometry.attentionLayers === 8 && geometry.kvHeads === 32 && geometry.keyLength === 256 && geometry.sliding === undefined, JSON.stringify(geometry))
  const at256k = geometry === undefined ? 0 : kvCacheBytes(geometry, 262_144, 1, 'q8_0')
  check('the cache at 256k is the 4.3 GiB /localsetup step 5 states', Math.abs(at256k / GIB - 4.3) < 0.1, `${(at256k / GIB).toFixed(2)} GiB`)
}

console.log('\n§3 a scalar head_count_kv beside a sliding window and no pattern key (gemma3 as llama.cpp hardcodes it: one global layer in six)')
const GEMMA3_4B_KV: Record<string, unknown> = { 'general.architecture': 'gemma3', 'gemma3.block_count': 34, 'gemma3.attention.head_count': 8, 'gemma3.attention.head_count_kv': 4, 'gemma3.attention.key_length': 256, 'gemma3.attention.value_length': 256, 'gemma3.embedding_length': 2560, 'gemma3.attention.sliding_window': 1024, 'gemma3.context_length': 131072 }
{
  const mask = slidingLayerMask(GEMMA3_4B_KV, 'gemma3', 34)
  check('layers 5, 11, 17, 23, 29 are global; the other 29 slide', mask !== undefined && mask.filter(v => !v).length === 5 && [5, 11, 17, 23, 29].every(i => mask[i] === false) && mask[0] === true && mask[33] === true, JSON.stringify(mask))
  const geometry = kvGeometryOf(GEMMA3_4B_KV)
  check('5 global layers × 4 kv heads = 20 heads at 256/256', geometry?.attentionLayers === 5 && geometry.kvHeads === 20 && geometry.keyLength === 256 && geometry.valueLength === 256, JSON.stringify(geometry))
  check('29 sliding layers × 4 kv heads = 116 heads over a 1024-token window', geometry?.sliding?.layers === 29 && geometry.sliding.kvHeads === 116 && geometry.sliding.window === 1024 && geometry.sliding.keyLength === 256, JSON.stringify(geometry?.sliding))
  const expectedGlobal = 20 * (256 + 256) * 2 * 32_768
  const expectedSliding = 116 * (256 + 256) * 2 * 1024
  check('f16 at 32k: 20×512×2×32768 + 116×512×2×1024 = 671,088,640 + 121,634,816 = 792,723,456 bytes', expectedGlobal === 671_088_640 && expectedSliding === 121_634_816 && geometry !== undefined && kvCacheBytes(geometry, 32_768, 1, 'f16') === 792_723_456, String(geometry && kvCacheBytes(geometry, 32_768, 1, 'f16')))
  check('not the 4,563,402,752 bytes (34 layers all global) the old arithmetic charged', geometry !== undefined && kvCacheBytes(geometry, 32_768, 1, 'f16') !== 34 * 4 * 512 * 2 * 32_768)
  const gemma2 = kvGeometryOf({ ...GEMMA3_4B_KV, 'general.architecture': 'gemma2', 'gemma2.block_count': 26, 'gemma2.attention.head_count': 8, 'gemma2.attention.head_count_kv': 4, 'gemma2.attention.key_length': 256, 'gemma2.attention.sliding_window': 4096 })
  check('gemma2 alternates: 13 global, 13 sliding layers over 4096', gemma2?.attentionLayers === 13 && gemma2.kvHeads === 52 && gemma2.sliding?.layers === 13 && gemma2.sliding.window === 4096, JSON.stringify(gemma2))
  const unknownArch = kvGeometryOf({ 'general.architecture': 'phi3', 'phi3.block_count': 32, 'phi3.attention.head_count': 32, 'phi3.attention.head_count_kv': 32, 'phi3.attention.key_length': 96, 'phi3.attention.sliding_window': 2047 })
  check('an architecture with no known pattern keeps every layer global, as before', unknownArch?.attentionLayers === 32 && unknownArch.kvHeads === 1024 && unknownArch.sliding === undefined, JSON.stringify(unknownArch))
  const withInterval = kvGeometryOf({ 'general.architecture': 'glm5', 'glm5.block_count': 40, 'glm5.attention.head_count': 32, 'glm5.attention.head_count_kv': 4, 'glm5.attention.key_length': 128, 'glm5.full_attention_interval': 4, 'glm5.attention.sliding_window': 512 })
  check('a full_attention_interval model is still read by its interval alone', withInterval?.attentionLayers === 10 && withInterval.kvHeads === 40 && withInterval.sliding === undefined, JSON.stringify(withInterval))
}

console.log('\n§4 the pattern as GGUF writes it: integer 1/0 arrays and a scalar period')
const EIGHT_LAYERS_INT_PATTERN: Record<string, unknown> = { 'general.architecture': 'cohere2', 'cohere2.block_count': 8, 'cohere2.attention.head_count': 32, 'cohere2.attention.head_count_kv': [8, 8, 8, 8, 8, 8, 8, 8], 'cohere2.attention.key_length': 128, 'cohere2.attention.value_length': 128, 'cohere2.attention.sliding_window': 4096, 'cohere2.attention.sliding_window_pattern': [1, 1, 1, 0, 1, 1, 1, 0] }
{
  const ints = kvGeometryOf(EIGHT_LAYERS_INT_PATTERN)
  check('integer 1 reads as a sliding layer: 2 global layers (16 heads), 6 sliding (48 heads)', ints?.attentionLayers === 2 && ints.kvHeads === 16 && ints.sliding?.layers === 6 && ints.sliding.kvHeads === 48 && ints.sliding.window === 4096, JSON.stringify(ints))
  const expected = 16 * (128 + 128) * 2 * 8192 + 48 * (128 + 128) * 2 * 4096
  check('f16 at 8k: 16×256×2×8192 + 48×256×2×4096 = 67,108,864 + 100,663,296 = 167,772,160 bytes', expected === 167_772_160 && ints !== undefined && kvCacheBytes(ints, 8192, 1, 'f16') === 167_772_160, String(ints && kvCacheBytes(ints, 8192, 1, 'f16')))
  const period = kvGeometryOf({ 'general.architecture': 'smallthinker', 'smallthinker.block_count': 8, 'smallthinker.attention.head_count': 32, 'smallthinker.attention.head_count_kv': 8, 'smallthinker.attention.key_length': 128, 'smallthinker.attention.sliding_window': 4096, 'smallthinker.attention.sliding_window_pattern': 4 })
  check('a scalar period 4 means layers 3 and 7 are global: the same 167,772,160 bytes', period?.attentionLayers === 2 && period.kvHeads === 16 && period.sliding?.layers === 6 && kvCacheBytes(period, 8192, 1, 'f16') === 167_772_160, JSON.stringify(period))
  const mismatched = kvGeometryOf({ ...EIGHT_LAYERS_INT_PATTERN, 'cohere2.attention.sliding_window_pattern': [1, 1, 0] })
  check('a pattern whose length is not the layer count is ignored (all global, as before)', mismatched?.attentionLayers === 8 && mismatched.kvHeads === 64 && mismatched.sliding === undefined, JSON.stringify(mismatched))
}

console.log('\n§5 the same numbers from a GGUF header: synthetic bytes through the header reader')
{
  const scalarHeader = parseGgufHeader(new Uint8Array(ggufHeaderBytes({ architecture: 'gemma3', kv: { 'gemma3.block_count': 34, 'gemma3.attention.head_count': 8, 'gemma3.attention.head_count_kv': 4, 'gemma3.attention.key_length': 256, 'gemma3.attention.value_length': 256, 'gemma3.embedding_length': 2560, 'gemma3.attention.sliding_window': 1024, 'gemma3.context_length': 131072, 'tokenizer.ggml.tokens': ['a', 'b'] }, tensors: ['token_embd.weight'] })))
  check('the gemma3 header parses with its scalars', scalarHeader.state === 'ok' && scalarHeader.header.kv['gemma3.attention.sliding_window'] === 1024 && scalarHeader.header.kv['gemma3.attention.head_count_kv'] === 4, JSON.stringify(scalarHeader))
  const fromScalarHeader = scalarHeader.state === 'ok' ? kvGeometryOf(scalarHeader.header.kv) : undefined
  check('the header-read geometry prices the cache at 792,723,456 bytes at 32k f16', fromScalarHeader !== undefined && kvCacheBytes(fromScalarHeader, 32_768, 1, 'f16') === 792_723_456, String(fromScalarHeader && kvCacheBytes(fromScalarHeader, 32_768, 1, 'f16')))
  const arrayHeader = parseGgufHeader(new Uint8Array(ggufHeaderBytes({ architecture: 'cohere2', kv: { 'cohere2.block_count': 8, 'cohere2.attention.head_count': 32, 'cohere2.attention.head_count_kv': [8, 8, 8, 8, 8, 8, 8, 8], 'cohere2.attention.key_length': 128, 'cohere2.attention.value_length': 128, 'cohere2.attention.sliding_window': 4096, 'cohere2.attention.sliding_window_pattern': [true, true, true, false, true, true, true, false], 'tokenizer.ggml.tokens': Array.from({ length: 1100 }, (_, i) => 't' + i) }, tensors: ['token_embd.weight'] })))
  check('a small numeric array and a boolean array come through the header reader; a string array still does not', arrayHeader.state === 'ok' && JSON.stringify(arrayHeader.header.kv['cohere2.attention.head_count_kv']) === '[8,8,8,8,8,8,8,8]' && JSON.stringify(arrayHeader.header.kv['cohere2.attention.sliding_window_pattern']) === '[true,true,true,false,true,true,true,false]' && arrayHeader.header.kv['tokenizer.ggml.tokens'] === undefined, JSON.stringify(arrayHeader.state === 'ok' ? Object.keys(arrayHeader.header.kv) : arrayHeader))
  const fromArrayHeader = arrayHeader.state === 'ok' ? kvGeometryOf(arrayHeader.header.kv) : undefined
  check('the header-read array geometry prices the cache at 167,772,160 bytes at 8k f16', fromArrayHeader !== undefined && kvCacheBytes(fromArrayHeader, 8192, 1, 'f16') === 167_772_160, String(fromArrayHeader && kvCacheBytes(fromArrayHeader, 8192, 1, 'f16')))
  const bigArray = parseGgufHeader(new Uint8Array(ggufHeaderBytes({ architecture: 'cohere2', kv: { 'cohere2.block_count': 8, 'cohere2.big': Array.from({ length: 1025 }, () => 1), 'cohere2.after': 7 }, tensors: [] })))
  check('an array past 1,024 elements is skipped and the keys after it still read', bigArray.state === 'ok' && bigArray.header.kv['cohere2.big'] === undefined && bigArray.header.kv['cohere2.after'] === 7, JSON.stringify(bigArray.state === 'ok' ? bigArray.header.kv : bigArray))
}

console.log('\n§6 gpt-oss and gemma3n without a pattern key keep their architecture periods')
for (const fixture of [
  { arch: 'gpt-oss', layers: 24, heads: 8, width: 64, window: 128, period: 2, globalLayers: 12, slidingLayers: 12, globalBytes: 805_306_368, slidingBytes: 3_145_728, totalBytes: 808_452_096 },
  { arch: 'gemma3n', layers: 35, heads: 2, width: 256, window: 512, period: 5, globalLayers: 7, slidingLayers: 28, globalBytes: 469_762_048, slidingBytes: 29_360_128, totalBytes: 499_122_176 },
]) {
  const { arch, layers, heads, width, window, period, globalLayers, slidingLayers, globalBytes, slidingBytes, totalBytes } = fixture
  const header = parseGgufHeader(new Uint8Array(ggufHeaderBytes({ architecture: arch, kv: { [`${arch}.block_count`]: layers, [`${arch}.attention.head_count_kv`]: heads, [`${arch}.attention.key_length`]: width, [`${arch}.attention.value_length`]: width, [`${arch}.attention.sliding_window`]: window }, tensors: [] })))
  check(`${arch}: the GGUF header has a sliding window and no pattern key`, header.state === 'ok' && header.header.kv[`${arch}.attention.sliding_window_pattern`] === undefined)
  const info = header.state === 'ok' ? header.header.kv : {}
  const mask = slidingLayerMask(info, arch, layers)
  check(`${arch}: only every ${period}th layer is global, starting with a sliding layer`, mask !== undefined && mask.length === layers && mask.every((sliding, i) => sliding === (i % period !== period - 1)), JSON.stringify(mask))
  const geometry = kvGeometryOf(info)
  check(`${arch}: ${globalLayers} global layers and ${slidingLayers} sliding layers`, geometry?.attentionLayers === globalLayers && geometry.kvHeads === globalLayers * heads && geometry.sliding?.layers === slidingLayers && geometry.sliding.kvHeads === slidingLayers * heads && geometry.sliding.window === window, JSON.stringify(geometry))
  check(`${arch}: f16 at 32k = ${globalBytes} + ${slidingBytes} = ${totalBytes} bytes`, globalLayers * heads * (width + width) * 2 * 32_768 === globalBytes && slidingLayers * heads * (width + width) * 2 * window === slidingBytes && geometry !== undefined && kvCacheBytes(geometry, 32_768, 1, 'f16') === totalBytes, String(geometry && kvCacheBytes(geometry, 32_768, 1, 'f16')))
  const explicit = slidingLayerMask({ ...info, [`${arch}.attention.sliding_window_pattern`]: Array.from({ length: layers }, () => false) }, arch, layers)
  check(`${arch}: explicit GGUF metadata overrides the architecture default`, explicit?.every(sliding => !sliding) === true)
  const noWindow = slidingLayerMask({ ...info, [`${arch}.attention.sliding_window`]: undefined }, arch, layers)
  check(`${arch}: no sliding window means no inferred pattern`, noWindow === undefined)
}

console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
