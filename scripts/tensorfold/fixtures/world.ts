import { existsSync, linkSync, mkdirSync, mkdtempSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GgufSource } from '../../../src/services/tensorfold/hfCache.ts'
import type { TensorFoldMachineTruth } from '../../../src/services/tensorfold/fit.ts'

export const GIB = 1024 ** 3
export const FIXTURES = import.meta.dir
export const FAKE_SCRIPT = join(FIXTURES, 'fake-tensorfold.ts')
export const FAKE_BIN = join(FIXTURES, 'bin')
export const fakeExists = (path: string): boolean => path.startsWith(FAKE_BIN) && existsSync(path)

export const MAC_48: TensorFoldMachineTruth = { platform: 'darwin', ramBytes: 48 * GIB, usableBytes: 36 * GIB, usableSource: 'metal', chip: 'Apple M5 Pro', wiredLimitMib: 0, osVersion: '27.0' }
export const MAC_32: TensorFoldMachineTruth = { platform: 'darwin', ramBytes: 32 * GIB, usableBytes: 24 * GIB, usableSource: 'metal', chip: 'Apple M4 Pro', wiredLimitMib: 0, osVersion: '26.3' }
export const MAC_32_LOW: TensorFoldMachineTruth = { platform: 'darwin', ramBytes: 32 * GIB, usableBytes: Math.round(21.3 * GIB), usableSource: 'metal', chip: 'Apple M1 Max', wiredLimitMib: 0, osVersion: '26.5.1' }
export const MAC_16: TensorFoldMachineTruth = { platform: 'darwin', ramBytes: 16 * GIB, usableBytes: 12 * GIB, usableSource: 'metal', chip: 'Apple M4', wiredLimitMib: 0, osVersion: '26.2' }
export const RTX_4090: TensorFoldMachineTruth = { platform: 'linux', ramBytes: 64 * GIB, usableBytes: 23 * GIB, usableSource: 'cuda', chip: 'NVIDIA GeForce RTX 4090', gpu: { name: 'NVIDIA GeForce RTX 4090', memoryBytes: 24 * GIB, driver: '580.95', cuda: '13' } }
export const LINUX_NO_GPU: TensorFoldMachineTruth = { platform: 'linux', ramBytes: 64 * GIB, usableBytes: Math.round(64 * GIB * 0.7), usableSource: 'seventy-percent', chip: 'no NVIDIA GPU found' }
export const LINUX_OLD_DRIVER: TensorFoldMachineTruth = { platform: 'linux', ramBytes: 64 * GIB, usableBytes: 23 * GIB, usableSource: 'cuda', chip: 'NVIDIA GeForce RTX 4090', gpu: { name: 'NVIDIA GeForce RTX 4090', memoryBytes: 24 * GIB, driver: '550.54', cuda: '12' } }
export const WIN_16: TensorFoldMachineTruth = { platform: 'win32', ramBytes: 16 * GIB, usableBytes: Math.round(16 * GIB * 0.7), usableSource: 'seventy-percent', chip: 'Intel Core i7', osVersion: '10.0.19045' }
export const WIN_HOME = 'C:\\Users\\someone'
export const WIN_LLAMA_BIN = `${WIN_HOME}\\.local\\share\\mercury-host\\runtime\\llama.cpp\\build\\bin`

export const QWEN_2B_REPO = 'mlx-community/Qwen3.5-2B-MLX-4bit'
export const QWEN_2B_PIN = '93760be4f1f69842a46bc13dbdc0f19e291392a3'
export const QWEN_27B_REPO = 'TensorFold/Qwen3.8-27B-MLX-4bit'
export const LIGHTNING_REPO = 'TensorFold/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-MLX-4bit'
export const QWEN_9B_REPO = 'mlx-community/Qwen3.5-9B-MLX-4bit'

export const QWEN_2B_CONFIG = {
  architectures: ['Qwen3_5ForConditionalGeneration'],
  model_type: 'qwen3_5',
  quantization: { group_size: 64, bits: 4, mode: 'affine' },
  text_config: { model_type: 'qwen3_5_text', max_position_embeddings: 262144, num_hidden_layers: 24, num_attention_heads: 8, num_key_value_heads: 2, head_dim: 256, full_attention_interval: 4, hidden_size: 2048 },
}

export type CacheSeed = { repo: string; config: Record<string, unknown>; weightsBytes: number; sha?: string; refs?: boolean; incompleteBytes?: number }

export function seedGgufCache(root: string, seeds: readonly (GgufSource & { partialBytes?: number })[]): void {
  for (const seed of seeds) {
    const base = join(root, `models--${seed.repo.replace('/', '--')}`)
    mkdirSync(join(base, 'blobs'), { recursive: true })
    mkdirSync(join(base, 'snapshots', seed.revision), { recursive: true })
    if (seed.partialBytes !== undefined) {
      writeFileSync(join(base, 'blobs', `${seed.sha256}.incomplete`), '')
      truncateSync(join(base, 'blobs', `${seed.sha256}.incomplete`), seed.partialBytes)
      continue
    }
    writeFileSync(join(base, 'blobs', seed.sha256), '')
    truncateSync(join(base, 'blobs', seed.sha256), seed.bytes)
    linkSync(join(base, 'blobs', seed.sha256), join(base, 'snapshots', seed.revision, seed.file))
  }
}

export function seedHfCache(root: string, seeds: readonly CacheSeed[]): void {
  for (const seed of seeds) {
    const base = join(root, `models--${seed.repo.replace('/', '--')}`)
    const sha = seed.sha ?? 'f'.repeat(40)
    mkdirSync(join(base, 'blobs'), { recursive: true })
    mkdirSync(join(base, 'snapshots', sha), { recursive: true })
    if (seed.refs !== false) {
      mkdirSync(join(base, 'refs'), { recursive: true })
      writeFileSync(join(base, 'refs', 'main'), sha)
    }
    writeFileSync(join(base, 'snapshots', sha, 'config.json'), JSON.stringify(seed.config))
    if (seed.weightsBytes > 0) {
      writeFileSync(join(base, 'blobs', 'weightsblob'), '')
      truncateSync(join(base, 'blobs', 'weightsblob'), seed.weightsBytes)
      symlinkSync(join('..', '..', 'blobs', 'weightsblob'), join(base, 'snapshots', sha, 'model.safetensors'))
    }
    if (seed.incompleteBytes !== undefined) {
      writeFileSync(join(base, 'blobs', 'partialblob.incomplete'), '')
      truncateSync(join(base, 'blobs', 'partialblob.incomplete'), seed.incompleteBytes)
    }
  }
}

export type FakeWorld = { root: string; cache: string; home: string; cwd: string; env: NodeJS.ProcessEnv; serviceEnv: Record<string, string> }

export function fakeWorld(prefix: string, opts: { seeds?: readonly CacheSeed[]; ggufSeeds?: readonly (GgufSource & { partialBytes?: number })[]; env?: Record<string, string> } = {}): FakeWorld {
  const root = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', `${prefix}-`))
  const home = join(root, 'home')
  const cache = join(home, '.cache', 'huggingface', 'hub')
  const cwd = join(root, 'project')
  mkdirSync(cache, { recursive: true })
  mkdirSync(home, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  seedHfCache(cache, opts.seeds ?? [{ repo: QWEN_2B_REPO, config: QWEN_2B_CONFIG, weightsBytes: 4096, sha: QWEN_2B_PIN }])
  seedGgufCache(cache, opts.ggufSeeds ?? [])
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${FAKE_BIN}:/usr/bin:/bin`,
    HOME: home,
    HF_HUB_CACHE: cache,
    FAKE_TENSORFOLD_BUN: process.execPath,
    FAKE_TENSORFOLD_SCRIPT: FAKE_SCRIPT,
    FAKE_TENSORFOLD_CACHE: cache,
    ...opts.env,
  }
  const serviceEnv: Record<string, string> = {}
  for (const key of ['PATH', 'HOME', 'HF_HUB_CACHE', 'FAKE_TENSORFOLD_BUN', 'FAKE_TENSORFOLD_SCRIPT', 'FAKE_TENSORFOLD_CACHE', ...Object.keys(opts.env ?? {})]) if (env[key] !== undefined) serviceEnv[key] = env[key]!
  return { root, cache, home, cwd, env, serviceEnv }
}
