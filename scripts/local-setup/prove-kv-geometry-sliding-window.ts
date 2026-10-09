#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const GIB = 1024 ** 3

const { kvGeometryOf, kvCacheBytes } = await import('../../src/services/localServer/localServerMemory.ts')
const { fitLocalWindow } = await import('../../src/services/localServer/localWindowFit.ts')
const { FAKE_OLLAMA_MODEL_INFO } = await import('./fixtures/fake-ollama.ts')

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

console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
