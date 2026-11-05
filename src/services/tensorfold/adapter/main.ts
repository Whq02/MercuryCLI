import { homedir } from 'node:os'
import { ggufOnDisk, hfCacheRoot } from '../hfCache.js'
import { ADAPTER_SERVED_BY, ADAPTER_SPEAKER, ADAPTER_VERSION, LLAMACPP_RELEASE, adapterVersionLine, cpuModelWords, llamaCppWords } from './identity.js'
import { LlamaInstallError, installLlamaServer, llamaRuntimeBin, readLlamaServerVersion, resolveLlamaServer, type LlamaServerVersion } from './llama.js'
import { ADAPTER_CHECKPOINTS, adapterCheckpointOf, adapterFamilies } from './models.js'
import { GgufPullError, pullGguf } from './pull.js'
import { ServeRefusal, parseServeArgs, runServe } from './serve.js'

export type AdapterIo = {
  env?: NodeJS.ProcessEnv
  home?: string
  platform?: NodeJS.Platform
  arch?: string
  stdout?: (text: string) => void
  stderr?: (text: string) => void
  fetchImpl?: typeof fetch
  llamaServer?: string
}

export const ADAPTER_SERVE_FLAGS = ['--name', '--context', '--port', '--prompt-cache-gib', '--host', '--api-key-file', '--drafter', '--parallel'] as const
export const ADAPTER_ENV = ['HF_HOME', 'HF_HUB_CACHE', 'HF_ENDPOINT', 'HF_TOKEN', 'TF_DRAIN_S'] as const
const USAGE = 'usage: tensorfold-adapter --version | capabilities --json | models [--json] | pull REPO[@REVISION] | serve MODEL [flags] | install'

export type AdapterLlamaFacts = { found: boolean; binary?: string; pinned?: boolean; refused?: string; runtime: string; release: typeof LLAMACPP_RELEASE } & LlamaServerVersion

export function capabilitiesJson(facts: { chip?: string; llama: AdapterLlamaFacts; version?: string }): Record<string, unknown> {
  return {
    schema: 1,
    engine: ADAPTER_SERVED_BY,
    served_by: ADAPTER_SERVED_BY,
    version: facts.version ?? ADAPTER_VERSION,
    chip: facts.chip ?? null,
    backends: ['cpu'],
    families: adapterFamilies(),
    serve: { flags: Object.fromEntries(ADAPTER_SERVE_FLAGS.map(flag => [flag, {}])) },
    env: [...ADAPTER_ENV],
    optional_libraries: [],
    llamacpp: { ...facts.llama, words: llamaCppWords(facts.llama) },
    profiles: { default: 'cpu', available: ['cpu'] },
  }
}

export async function readLlamaFacts(io: AdapterIo = {}): Promise<AdapterLlamaFacts> {
  const env = io.env ?? process.env
  const home = io.home ?? homedir()
  const runtime = llamaRuntimeBin(home)
  if (io.llamaServer !== undefined) return { found: true, binary: io.llamaServer, pinned: true, runtime, release: LLAMACPP_RELEASE, ...(await readLlamaServerVersion(io.llamaServer, env)) }
  const resolved = await resolveLlamaServer({ env, home, ...(io.platform !== undefined ? { platform: io.platform } : {}) })
  return { ...resolved, runtime, release: LLAMACPP_RELEASE }
}

export function modelsJson(root: string): Record<string, unknown> {
  return {
    served_by: ADAPTER_SERVED_BY,
    cache: root,
    models: ADAPTER_CHECKPOINTS.map(point => {
      const disk = ggufOnDisk(root, point.gguf)
      return { repo: point.repo, name: point.shortName, label: point.label, family: point.family, gguf: point.gguf, on_disk: disk.complete, bytes_on_disk: disk.bytes, bytes: point.gguf.bytes, qualified: point.qualified }
    }),
  }
}

function modelsText(root: string): string {
  const rows = ADAPTER_CHECKPOINTS.map(point => {
    const disk = ggufOnDisk(root, point.gguf)
    return `${point.repo}: ${point.label} (${point.family}) → ${point.gguf.repo}/${point.gguf.file} · ${disk.complete ? 'on disk' : disk.bytes > 0 ? `${disk.bytes} of ${point.gguf.bytes} bytes on disk` : 'not pulled'}`
  })
  return `${rows.join('\n')}\n`
}

export async function adapterCapabilities(io: AdapterIo = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  const llama = await readLlamaFacts(io)
  const stderr = llama.found ? '' : `warning: ${llama.refused !== undefined ? `${llama.refused}; ` : 'llama.cpp is not installed; '}/tensorfold installs release ${LLAMACPP_RELEASE.build} into ${llama.runtime}\n`
  const chip = cpuModelWords()
  return { stdout: `${JSON.stringify(capabilitiesJson({ ...(chip !== undefined ? { chip } : {}), llama }))}\n`, stderr, code: 0 }
}

export async function runTensorFoldAdapter(argv: readonly string[], io: AdapterIo = {}): Promise<number> {
  const out = io.stdout ?? ((text: string) => process.stdout.write(text))
  const err = io.stderr ?? ((text: string) => process.stderr.write(text))
  const env = io.env ?? process.env
  const home = io.home ?? homedir()
  const [verb, ...rest] = argv
  try {
    if (verb === '--version' || verb === 'version') {
      out(`${adapterVersionLine()}\n`)
      return 0
    }
    if (verb === 'capabilities') {
      if (rest[0] !== '--json' || rest.length !== 1) {
        err(`${USAGE}\n`)
        return 2
      }
      const answer = await adapterCapabilities(io)
      if (answer.stderr !== '') err(answer.stderr)
      out(answer.stdout)
      return 0
    }
    if (verb === 'models') {
      const root = hfCacheRoot(env, home)
      if (rest.length > 1 || (rest.length === 1 && rest[0] !== '--json')) {
        err(`${USAGE}\n`)
        return 2
      }
      out(rest[0] === '--json' ? `${JSON.stringify(modelsJson(root))}\n` : modelsText(root))
      return 0
    }
    if (verb === 'pull') {
      const spec = rest[0]
      if (spec === undefined || rest.length !== 1) {
        err(`${USAGE}\n`)
        return 2
      }
      const point = adapterCheckpointOf(spec)
      if (point === undefined) {
        err(`${ADAPTER_SPEAKER}: no backend for ${spec} on Mercury's engine; it serves ${ADAPTER_CHECKPOINTS.map(row => row.repo).join(', ')}\n`)
        return 1
      }
      const root = hfCacheRoot(env, home)
      out(`[${ADAPTER_SPEAKER}] downloading ${point.gguf.repo}@${point.gguf.revision.slice(0, 7)} ${point.gguf.file} (${(point.gguf.bytes / 1e9).toFixed(2)} GB) from Hugging Face for ${point.repo}\n`)
      const controller = new AbortController()
      const stop = (): void => controller.abort()
      process.once('SIGTERM', stop)
      process.once('SIGINT', stop)
      try {
        const outcome = await pullGguf(root, point.gguf, { env, signal: controller.signal, ...(io.fetchImpl !== undefined ? { fetchImpl: io.fetchImpl } : {}) })
        out(`[${ADAPTER_SPEAKER}] ${point.gguf.repo}: ${outcome.bytes} bytes on disk · sha256 verified${outcome.downloaded ? '' : ' · already in the cache'}\n`)
        return 0
      } catch (error) {
        if (error instanceof GgufPullError && error.stopped) return 143
        throw error
      } finally {
        process.removeListener('SIGTERM', stop)
        process.removeListener('SIGINT', stop)
      }
    }
    if (verb === 'serve') {
      const args = parseServeArgs(rest)
      return await runServe(args, { env, home, ...(io.platform !== undefined ? { platform: io.platform } : {}), ...(io.llamaServer !== undefined ? { llamaServer: io.llamaServer } : {}) })
    }
    if (verb === 'install') {
      if (rest.length !== 0) {
        err(`${USAGE}\n`)
        return 2
      }
      const found = await installLlamaServer({ env, home, ...(io.platform !== undefined ? { platform: io.platform } : {}), ...(io.arch !== undefined ? { arch: io.arch } : {}), ...(io.fetchImpl !== undefined ? { fetchImpl: io.fetchImpl } : {}), onLine: line => out(`[${ADAPTER_SPEAKER}] ${line}\n`) })
      out(`[${ADAPTER_SPEAKER}] ${llamaCppWords(found)} installed at ${found.binary}\n`)
      return 0
    }
    err(`${USAGE}\n`)
    return 2
  } catch (error) {
    if (error instanceof ServeRefusal) {
      err(`${error.message.startsWith(`${ADAPTER_SPEAKER}:`) ? error.message : `${ADAPTER_SPEAKER}: ${error.message}`}\n`)
      return error.code
    }
    if (error instanceof GgufPullError || error instanceof LlamaInstallError) {
      err(`${ADAPTER_SPEAKER}: ${error.message}\n`)
      return 1
    }
    err(`${ADAPTER_SPEAKER}: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}
