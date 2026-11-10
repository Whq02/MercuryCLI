export const TENSORFOLD_RELEASE = '1.2.5'
export const TENSORFOLD_BREW_FORMULA = 'ashhart/tensorfold/tensorfold'
export const TENSORFOLD_RELEASE_BASE = `https://github.com/ashhart/TensorFold/releases/download/v${TENSORFOLD_RELEASE}`
export const TENSORFOLD_AGENT_FLOOR = 65_536
export const GIB = 1024 ** 3
export const TENSORFOLD_RUNTIME_MARGIN = 2 * GIB

export type TensorFoldCheckpoint = {
  repo: string
  label: string
  shortName: string
  family: string
  weightsBytes: number
  downloadBytes: number
  kvBytesPerToken: number
  trainedMax: number
  pin?: string
  drafter?: { repo: string; weightsBytes: number; downloadBytes: number }
  promptCacheGib?: number
  qualified: boolean
}

export const QWEN_2B: TensorFoldCheckpoint = {
  repo: 'mlx-community/Qwen3.5-2B-MLX-4bit',
  label: 'Qwen3.5 2B',
  shortName: 'qwen3.5-2b',
  family: 'qwen3_5',
  weightsBytes: 1_749_081_964,
  downloadBytes: 1_749_083_534,
  kvBytesPerToken: 12_288,
  trainedMax: 262_144,
  pin: '93760be4f1f69842a46bc13dbdc0f19e291392a3',
  promptCacheGib: 1,
  qualified: true,
}

export const QWEN_27B: TensorFoldCheckpoint = {
  repo: 'TensorFold/Qwen3.8-27B-MLX-4bit',
  label: 'Qwen3.8 27B',
  shortName: 'qwen3.8-27b',
  family: 'qwen3_5',
  weightsBytes: 16_054_541_349,
  downloadBytes: 16_081_520_999,
  kvBytesPerToken: 65_536,
  trainedMax: 262_144,
  drafter: { repo: 'z-lab/Qwen3.8-27B-DFlash2', weightsBytes: 3_848_817_896, downloadBytes: 3_849_113_002 },
  qualified: true,
}

export const NEMOTRON_LIGHTNING: TensorFoldCheckpoint = {
  repo: 'TensorFold/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-MLX-4bit',
  label: 'Nemotron Lightning',
  shortName: 'nemotron-lightning',
  family: 'nemotron_h',
  weightsBytes: 18_527_064_363,
  downloadBytes: 18_544_234_457,
  kvBytesPerToken: 6_144,
  trainedMax: 262_144,
  qualified: true,
}

export const TENSORFOLD_STARTING_POINTS: readonly TensorFoldCheckpoint[] = [QWEN_27B, NEMOTRON_LIGHTNING, QWEN_2B]

export const QWEN_27B_SECOND_WORDS = "steadier on long tasks · prefill ~350 tok/s · takes most of this Mac's memory"
const DENSE_FIRST_RAM_BYTES = 64 * GIB
const DENSE_FIRST_GENERATION = 5

export function appleSiliconGeneration(chip: string): number | undefined {
  const match = /\bM(\d+)\b/.exec(chip)
  return match ? Number(match[1]) : undefined
}

export function tensorFoldStartingOrder(machine: { platform: NodeJS.Platform; ramBytes: number; chip: string }): readonly TensorFoldCheckpoint[] {
  if (machine.platform !== 'darwin') return TENSORFOLD_STARTING_POINTS
  const generation = appleSiliconGeneration(machine.chip)
  const denseFirst = machine.ramBytes >= DENSE_FIRST_RAM_BYTES && generation !== undefined && generation >= DENSE_FIRST_GENERATION
  return denseFirst ? TENSORFOLD_STARTING_POINTS : [NEMOTRON_LIGHTNING, QWEN_27B, QWEN_2B]
}

export const TENSORFOLD_RAISED_LIMIT_REPOS: ReadonlySet<string> = new Set([QWEN_27B.repo])
export const TENSORFOLD_RAISED_LIMIT_BELOW_BYTES = 48 * GIB

export const PROMPT_CACHE_OPT_IN_FAMILIES: ReadonlySet<string> = new Set(['qwen3_5'])

export function startingPointOf(repo: string): TensorFoldCheckpoint | undefined {
  return TENSORFOLD_STARTING_POINTS.find(point => point.repo.toLowerCase() === repo.toLowerCase())
}

const VENDOR_PREFIXES = ['mlx-community/', 'tensorfold/', 'nvidia/', 'unsloth/', 'qwen/', 'z-lab/', 'google/', 'meta-llama/', 'mistralai/', 'liquidai/', 'zai-org/', 'moonshotai/', 'deepseek-ai/']
const QUANT_SUFFIX = /-(?:mlx-)?(?:\d+bit|q\d+(?:g\d+)?|nvfp4|fp8|bf16|exl3|exlr8|int4|mxfp4)(?:-[a-z0-9]+)*$/i

export function tensorFoldShortName(repo: string): string {
  const point = startingPointOf(repo)
  if (point !== undefined) return point.shortName
  let name = repo.toLowerCase()
  for (const prefix of VENDOR_PREFIXES) if (name.startsWith(prefix)) name = name.slice(prefix.length)
  name = name.slice(name.lastIndexOf('/') + 1)
  name = name.replace(/-mlx$/i, '')
  name = name.replace(QUANT_SUFFIX, '')
  name = name.replace(/-mlx$/i, '')
  return name
}

export function tensorFoldLabel(repo: string): string {
  const point = startingPointOf(repo)
  if (point !== undefined) return point.label
  const short = tensorFoldShortName(repo)
  return short
    .split('-')
    .map(part => (/^\d/.test(part) ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ')
}

export function isRepoId(spec: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(spec)
}

export function isGgufRepo(repo: string): boolean {
  return /gguf/i.test(repo)
}
