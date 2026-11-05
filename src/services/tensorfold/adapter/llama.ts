import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, join } from 'node:path'
import { ADAPTER_VERSION, LLAMACPP_RUNTIME_BIN, LLAMACPP_WINDOWS_CPU_ASSET } from './identity.js'

export type LlamaIo = {
  platform?: NodeJS.Platform
  arch?: string
  env?: NodeJS.ProcessEnv
  home?: string
  exists?: (path: string) => boolean
}

export type LlamaServerVersion = { version?: string; build?: string; commit?: string }

export type LlamaServerFound = { binary: string } & LlamaServerVersion

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function llamaRuntimeBin(home: string = homedir()): string {
  return join(home, ...LLAMACPP_RUNTIME_BIN)
}

export function llamaServerCandidates(io: LlamaIo = {}): string[] {
  const platform = io.platform ?? process.platform
  const env = io.env ?? process.env
  const home = io.home ?? homedir()
  const name = platform === 'win32' ? 'llama-server.exe' : 'llama-server'
  const pathDirs = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : delimiter).filter(dir => dir !== '')
  const dirs = [llamaRuntimeBin(home), ...pathDirs]
  return [...new Set(dirs.map(dir => join(dir, name)))]
}

export const LLAMACPP_BUILD_FLOOR = 11829

export type LlamaResolution = { found: true; binary: string; pinned: boolean } & LlamaServerVersion | { found: false; refused?: string }

export async function resolveLlamaServer(io: LlamaIo = {}): Promise<LlamaResolution> {
  const exists = io.exists ?? executable
  const env = io.env ?? process.env
  const runtime = llamaRuntimeBin(io.home ?? homedir())
  const refusals: string[] = []
  for (const binary of llamaServerCandidates(io).filter(exists)) {
    const version = await readLlamaServerVersion(binary, env)
    if (binary.startsWith(runtime)) return { found: true, binary, pinned: true, ...version }
    const build = Number(version.build)
    if (Number.isInteger(build) && build >= LLAMACPP_BUILD_FLOOR) return { found: true, binary, pinned: false, ...version }
    refusals.push(`${binary} is ${version.build !== undefined ? `build ${version.build}` : 'an unknown build'}`)
  }
  return { found: false, ...(refusals.length > 0 ? { refused: `${refusals.join('; ')}; Mercury's engine needs llama.cpp b${LLAMACPP_BUILD_FLOOR} or newer` } : {}) }
}

export function parseLlamaServerVersion(text: string | undefined): LlamaServerVersion {
  const line = (text ?? '').split('\n').find(row => /version:/i.test(row)) ?? ''
  const version = /version:\s*([^\s(]+)/i.exec(line)?.[1]
  const build = /build\s+(\d+)/i.exec(line)?.[1]
  const commit = /commit\s+([0-9a-f]{7,40})/i.exec(line)?.[1]
  return { ...(version !== undefined ? { version } : {}), ...(build !== undefined ? { build } : {}), ...(commit !== undefined ? { commit } : {}) }
}

export function readLlamaServerVersion(binary: string, env: NodeJS.ProcessEnv = process.env): Promise<LlamaServerVersion> {
  return new Promise(resolve => {
    try {
      execFile(binary, ['--version'], { encoding: 'utf8', timeout: 15_000, maxBuffer: 1 << 20, windowsHide: true, env }, (_error, stdout, stderr) => resolve(parseLlamaServerVersion(`${String(stdout)}\n${String(stderr)}`)))
    } catch {
      resolve({})
    }
  })
}

export type LlamaInstallIo = LlamaIo & {
  fetchImpl?: typeof fetch
  asset?: { name: string; url: string; bytes: number; sha256: string }
  onLine?: (line: string) => void
  signal?: AbortSignal
  startCheck?: (binary: string, env: NodeJS.ProcessEnv) => Promise<number | null>
}

export class LlamaInstallError extends Error {}

export const VC_REDIST_WORDS = 'llama-server.exe needs the Microsoft Visual C++ 2015-2022 x64 runtime (vc_redist.x64.exe from microsoft.com); install it, then /tensorfold again'
const STATUS_DLL_NOT_FOUND = 3221225781

export function llamaServerStartsOutcome(code: number | null, platform: NodeJS.Platform): string | undefined {
  if (code === 0) return undefined
  if (platform === 'win32' && (code === STATUS_DLL_NOT_FOUND || code === STATUS_DLL_NOT_FOUND - 2 ** 32)) return VC_REDIST_WORDS
  return `llama-server --version exited ${code ?? 'without a code'}`
}

function llamaServerExitCode(binary: string, env: NodeJS.ProcessEnv): Promise<number | null> {
  return new Promise(resolve => {
    try {
      execFile(binary, ['--version'], { encoding: 'utf8', timeout: 10_000, maxBuffer: 1 << 20, windowsHide: true, env }, error => resolve(error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : 1))
    } catch {
      resolve(1)
    }
  })
}

export async function installLlamaServer(io: LlamaInstallIo = {}): Promise<LlamaServerFound> {
  const platform = io.platform ?? process.platform
  const arch = io.arch ?? process.arch
  if (platform !== 'win32' || arch !== 'x64') throw new LlamaInstallError(`the adapter installs llama.cpp's Windows x64 build only; on ${platform} ${arch} install llama.cpp yourself (brew install llama.cpp on macOS)`)
  const asset = io.asset ?? LLAMACPP_WINDOWS_CPU_ASSET
  const fetchImpl = io.fetchImpl ?? fetch
  const say = io.onLine ?? (() => undefined)
  say(`downloading ${asset.name} (${(asset.bytes / 1e6).toFixed(1)} MB) from ${asset.url}`)
  let response: Response
  try {
    response = await fetchImpl(asset.url, { headers: { 'user-agent': `mercury-tensorfold-adapter/${ADAPTER_VERSION}` }, ...(io.signal !== undefined ? { signal: io.signal } : {}) })
  } catch (error) {
    throw new LlamaInstallError(`the download did not answer: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) throw new LlamaInstallError(`the download answered ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length !== asset.bytes) throw new LlamaInstallError(`${asset.name} is ${bytes.length} bytes, not the ${asset.bytes} Mercury measured; nothing was installed`)
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== asset.sha256) throw new LlamaInstallError(`${asset.name} does not match the sha256 Mercury measured (${digest.slice(0, 12)}… instead of ${asset.sha256.slice(0, 12)}…); nothing was installed`)
  say(`sha256 verified · ${asset.sha256.slice(0, 12)}…`)
  const { unzipFile } = await import('../../../utils/archive/zip.js')
  const entries = await unzipFile(bytes)
  const bin = llamaRuntimeBin(io.home ?? homedir())
  mkdirSync(bin, { recursive: true })
  let placed = 0
  for (const [name, data] of Object.entries(entries)) {
    const leaf = basename(name)
    if (leaf === '' || name.endsWith('/')) continue
    writeFileSync(join(bin, leaf), data)
    placed += 1
  }
  const binary = join(bin, 'llama-server.exe')
  if (!(io.exists ?? executable)(binary)) throw new LlamaInstallError(`${asset.name} held no llama-server.exe; ${placed} files were unpacked into ${bin}`)
  say(`unpacked ${placed} files into ${bin}`)
  const env = io.env ?? process.env
  const outcome = llamaServerStartsOutcome(await (io.startCheck ?? llamaServerExitCode)(binary, env), platform)
  if (outcome !== undefined) throw new LlamaInstallError(outcome)
  return { binary, ...(await readLlamaServerVersion(binary, env)) }
}
