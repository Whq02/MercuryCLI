import { cpus, tmpdir } from 'node:os'
import { join } from 'node:path'
import { MERCURY_VERSION } from '../../../constants/product.js'

export const ADAPTER_SERVED_BY = 'mercury-llamacpp'
export const ADAPTER_FLAG = '--tensorfold-adapter'
export const ADAPTER_BUNDLE = 'tensorfold-adapter.mjs'
export const ADAPTER_VERSION = MERCURY_VERSION
export const ADAPTER_NAME = 'TensorFold adapter'
export const ADAPTER_ENGINE_WORDS = "Mercury's engine"
export const ADAPTER_SENTENCE = "served by Mercury's engine on this machine until TensorFold ships for Windows"
export const ADAPTER_HEADING_WORDS = "served by Mercury's engine until TensorFold ships for Windows"
export const ADAPTER_NO_SHARING_WORDS = 'not shared · sharing from Mercury\'s engine comes later'
export const ADAPTER_SPEAKER = 'tensorfold-adapter'
export const ADAPTER_CHILD_PREFIX = '[llama.cpp] '
export const LLAMACPP_RELEASE = { build: 'b12359', commit: 'b1b770d90d94cad9e9ea5b993bdbc383a522fb28' } as const
export const LLAMACPP_WINDOWS_CPU_ASSET = {
  name: 'llama-b12359-bin-win-cpu-x64.zip',
  url: 'https://github.com/ggml-org/llama.cpp/releases/download/b12359/llama-b12359-bin-win-cpu-x64.zip',
  bytes: 25_097_509,
  sha256: '837c1655e87df3b66989f4be33a792a1399c785bf259038dc75c900096683e69',
} as const
export const LLAMACPP_RUNTIME_BIN = ['.local', 'share', 'mercury-host', 'runtime', 'llama.cpp', 'build', 'bin'] as const

export function adapterChildPidFile(port: number): string {
  return join(tmpdir(), 'mercury-tensorfold-adapter', `port-${port}.pid`)
}

export function servedByAdapter(servedBy: string | undefined): boolean {
  return servedBy === ADAPTER_SERVED_BY
}

export function isAdapterEntry(binary: string): boolean {
  return /\.(?:mjs|ts|tsx)$/.test(binary)
}

export function tensorFoldEngineLabel(version: string | undefined, servedBy?: string): string {
  if (servedByAdapter(servedBy)) return `${ADAPTER_NAME}${version ? ` ${version}` : ''} (${ADAPTER_ENGINE_WORDS})`
  return version ? `TensorFold ${version}` : 'TensorFold'
}

export function llamaCppWords(engine: { build?: string; commit?: string } | undefined): string {
  if (engine === undefined) return 'llama.cpp'
  const build = engine.build !== undefined && engine.build !== '1' ? `b${engine.build.replace(/^b/, '')}` : undefined
  const commit = engine.commit?.slice(0, 7)
  return ['llama.cpp', build ?? commit].filter(part => part !== undefined).join(' ')
}

export function adapterVersionLine(): string {
  return `Mercury ${ADAPTER_NAME} ${ADAPTER_VERSION}`
}

export function cpuModelWords(model: string | undefined = cpus()[0]?.model): string | undefined {
  if (model === undefined) return undefined
  const words = model
    .replace(/\((?:R|TM|tm|r)\)/g, '')
    .replace(/\bCPU\b/g, '')
    .replace(/@\s*[\d.]+\s*GHz/gi, '')
    .replace(/\d+-Core Processor/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
  return words === '' ? undefined : words
}
