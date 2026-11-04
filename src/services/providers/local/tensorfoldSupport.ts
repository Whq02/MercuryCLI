import { readFileSync } from 'node:fs'
import { release } from 'node:os'
import { MERCURY_VERSION } from '../../../constants/product.js'
import { getLinuxDistroInfo } from '../../../utils/platform.js'
import { readTensorFoldState, type TensorFoldServerState, type TensorFoldState, type TensorFoldStateReads } from './tensorfoldState.js'

export interface TensorFoldSupportFacts {
  version?: string
  backend?: string
  chip?: string
  host?: string
  osVersion?: string
  repo?: string
  drafter?: string
  context?: number
  promptCacheGib?: number
  mercuryVersion?: string
}

const BACKEND_WORDS: Readonly<Record<string, string>> = { metal: 'Metal', cuda: 'CUDA', hip: 'HIP', xpu: 'XPU' }

export function tensorFoldBackendWords(backend: string | undefined): string | undefined {
  if (backend === undefined || backend === '') return undefined
  return BACKEND_WORDS[backend.toLowerCase()] ?? backend
}

export function osVersionWords(platform: NodeJS.Platform = process.platform, kernel: string = release(), reads?: { productVersion?: () => string | undefined }): string {
  if (platform === 'darwin') {
    const product = reads?.productVersion?.() ?? readMacProductVersion()
    return product !== undefined ? `macOS ${product}` : `macOS (Darwin ${kernel})`
  }
  if (platform === 'linux') {
    const pretty = reads?.productVersion?.() ?? readLinuxPrettyName()
    return pretty !== undefined ? `${pretty} (Linux ${kernel})` : `Linux ${kernel}`
  }
  if (platform === 'win32') return `Windows ${kernel}`
  return `${platform} ${kernel}`
}

let macProductVersion: string | undefined | null = null
function readMacProductVersion(): string | undefined {
  if (macProductVersion !== null) return macProductVersion
  try {
    const plist = readFileSync('/System/Library/CoreServices/SystemVersion.plist', 'utf8')
    macProductVersion = /<key>ProductVersion<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1]?.trim()
  } catch {
    macProductVersion = undefined
  }
  return macProductVersion
}

function readLinuxPrettyName(): string | undefined {
  try {
    const line = readFileSync('/etc/os-release', 'utf8').split('\n').find(row => row.startsWith('PRETTY_NAME='))
    return line?.slice('PRETTY_NAME='.length).trim().replace(/^"(.*)"$/, '$1') || undefined
  } catch {
    return undefined
  }
}

export async function readOsVersionWords(): Promise<string> {
  if (process.platform === 'linux') {
    const distro = await getLinuxDistroInfo()
    const named = distro?.distroId !== undefined ? `${distro.distroId}${distro.distroVersion !== undefined ? ` ${distro.distroVersion}` : ''}` : undefined
    return named !== undefined ? `${named} (Linux ${distro?.kernelRelease ?? release()})` : osVersionWords()
  }
  return osVersionWords()
}

export function supportFactsOf(state: TensorFoldState, server: TensorFoldServerState | undefined, osVersion: string): TensorFoldSupportFacts {
  const engine = state.engine ?? undefined
  const chip = server?.device ?? engine?.chip
  const backend = server?.backend ?? engine?.backends[0]
  const hostName = server?.host !== undefined && server.host.origin !== 'app' ? server.host.name : undefined
  return {
    ...(server?.version !== undefined ? { version: server.version } : engine?.version !== undefined ? { version: engine.version } : {}),
    ...(backend !== undefined ? { backend } : {}),
    ...(hostName !== undefined ? { host: hostName } : chip !== undefined ? { chip } : {}),
    osVersion,
    ...(server?.started?.repo !== undefined ? { repo: server.started.repo } : server?.model !== undefined ? { repo: server.model } : {}),
    ...(server?.started?.window !== undefined ? { context: server.started.window } : server?.window !== undefined ? { context: server.window } : {}),
  }
}

export function supportServerOf(state: TensorFoldState): TensorFoldServerState | undefined {
  return state.servers.find(server => server.started !== undefined) ?? state.servers.find(server => server.host === undefined) ?? state.servers[0]
}

export type TensorFoldSupportFocus = Pick<TensorFoldSupportFacts, 'repo' | 'drafter' | 'context' | 'promptCacheGib' | 'host'>

export async function readTensorFoldSupportLine(focus?: TensorFoldSupportFocus, reads?: TensorFoldStateReads, state?: TensorFoldState): Promise<string | undefined> {
  const facts = state ?? (await readTensorFoldState(reads))
  const server = focus?.host !== undefined ? facts.servers.find(row => row.host?.name === focus.host) ?? supportServerOf(facts) : supportServerOf(facts)
  if (server === undefined && (facts.engine === null || facts.engine === undefined) && focus === undefined) return undefined
  const live = supportFactsOf(facts, server, await readOsVersionWords())
  if (focus === undefined) return tensorFoldSupportLine(live)
  const { repo: _repo, drafter: _drafter, context: _context, promptCacheGib: _cache, ...kept } = live
  return tensorFoldSupportLine({
    ...kept,
    ...(focus.host !== undefined ? { host: focus.host } : {}),
    ...(focus.repo !== undefined ? { repo: focus.repo } : live.repo !== undefined ? { repo: live.repo } : {}),
    ...(focus.drafter !== undefined ? { drafter: focus.drafter } : {}),
    ...(focus.context !== undefined ? { context: focus.context } : live.context !== undefined ? { context: live.context } : {}),
    ...(focus.promptCacheGib !== undefined ? { promptCacheGib: focus.promptCacheGib } : {}),
  })
}

export function tensorFoldSupportLine(facts: TensorFoldSupportFacts): string {
  const parts: string[] = [facts.version ? `TensorFold ${facts.version}` : 'TensorFold']
  const backend = tensorFoldBackendWords(facts.backend)
  if (backend !== undefined) parts.push(backend)
  const machine = facts.host ?? facts.chip
  if (machine !== undefined && machine !== '') parts.push(machine)
  parts.push(facts.osVersion ?? osVersionWords())
  if (facts.repo !== undefined && facts.repo !== '') parts.push(facts.drafter ? `${facts.repo} + ${facts.drafter}` : facts.repo)
  if (facts.context !== undefined && facts.context > 0) {
    parts.push(`--context ${facts.context}${facts.promptCacheGib !== undefined && facts.promptCacheGib > 0 ? ` --prompt-cache-gib ${facts.promptCacheGib}` : ''}`)
  }
  parts.push(`Mercury ${facts.mercuryVersion ?? MERCURY_VERSION}`)
  return parts.join(' · ')
}
