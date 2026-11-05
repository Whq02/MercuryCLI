import type { GgufSource } from '../hfCache.js'
import { NEMOTRON_LIGHTNING, QWEN_2B, type TensorFoldCheckpoint } from '../starting.js'

export type AdapterCheckpoint = TensorFoldCheckpoint & { gguf: GgufSource; architecture: string }

export const QWEN_2B_GGUF: AdapterCheckpoint = {
  repo: QWEN_2B.repo,
  label: QWEN_2B.label,
  shortName: QWEN_2B.shortName,
  family: QWEN_2B.family,
  architecture: 'qwen35',
  weightsBytes: 1_280_835_840,
  downloadBytes: 1_280_835_840,
  kvBytesPerToken: 12_288,
  trainedMax: 262_144,
  promptCacheGib: 1,
  qualified: true,
  gguf: { repo: 'unsloth/Qwen3.5-2B-GGUF', file: 'Qwen3.5-2B-Q4_K_M.gguf', quant: 'Q4_K_M', revision: 'f6d5376be1edb4d416d56da11e5397a961aca8ae', sha256: 'aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223', bytes: 1_280_835_840 },
}

export const QWEN_4B_GGUF: AdapterCheckpoint = {
  repo: 'mlx-community/Qwen3.5-4B-MLX-4bit',
  label: 'Qwen3.5 4B',
  shortName: 'qwen3.5-4b',
  family: 'qwen3_5',
  architecture: 'qwen35',
  weightsBytes: 2_740_937_888,
  downloadBytes: 2_740_937_888,
  kvBytesPerToken: 32_768,
  trainedMax: 262_144,
  promptCacheGib: 1,
  qualified: true,
  gguf: { repo: 'unsloth/Qwen3.5-4B-GGUF', file: 'Qwen3.5-4B-Q4_K_M.gguf', quant: 'Q4_K_M', revision: 'e87f176479d0855a907a41277aca2f8ee7a09523', sha256: '00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4', bytes: 2_740_937_888 },
}

const LIGHTNING_GGUF: AdapterCheckpoint = {
  repo: NEMOTRON_LIGHTNING.repo,
  label: NEMOTRON_LIGHTNING.label,
  shortName: NEMOTRON_LIGHTNING.shortName,
  family: NEMOTRON_LIGHTNING.family,
  architecture: 'nemotron_h',
  weightsBytes: 25_266_255_936,
  downloadBytes: 25_266_255_936,
  kvBytesPerToken: NEMOTRON_LIGHTNING.kvBytesPerToken,
  trainedMax: 262_144,
  promptCacheGib: 1,
  qualified: false,
  gguf: { repo: 'unsloth/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-GGUF', file: 'NVIDIA-Nemotron-3.5-Lightning-30B-A3B-UD-Q4_K_M.gguf', quant: 'UD-Q4_K_M', revision: 'f2d3fe3694501008786e81e5f20360cbf715496a', sha256: 'edcb5d4650796ed2fb412498de6f83b585862312c747ddb74f0ea04b22206181', bytes: 25_266_255_936 },
}

export const ADAPTER_CHECKPOINTS: readonly AdapterCheckpoint[] = [QWEN_4B_GGUF, QWEN_2B_GGUF, LIGHTNING_GGUF]

export const ADAPTER_QUALIFIED_WORDS = "qualified by Mercury on its own engine · not one of TensorFold's starting points"

export function adapterCheckpointOf(repo: string): AdapterCheckpoint | undefined {
  const wanted = repo.split('@')[0]!.toLowerCase()
  return ADAPTER_CHECKPOINTS.find(point => point.repo.toLowerCase() === wanted || point.gguf.repo.toLowerCase() === wanted)
}

export function adapterFamilies(): Record<string, string[]> {
  const families: Record<string, string[]> = {}
  for (const point of ADAPTER_CHECKPOINTS) {
    const format = `gguf-${point.gguf.quant.toLowerCase()}`
    families[point.family] = [...new Set([...(families[point.family] ?? []), format])]
  }
  return families
}

export function ggufWords(point: AdapterCheckpoint): string {
  return `${point.gguf.repo} · ${point.gguf.file} (${point.gguf.quant})`
}
