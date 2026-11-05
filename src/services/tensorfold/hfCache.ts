import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function hfCacheRoot(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  if (env.HF_HUB_CACHE) return env.HF_HUB_CACHE
  if (env.HF_HOME) return join(env.HF_HOME, 'hub')
  return join(home, '.cache', 'huggingface', 'hub')
}

export function cacheDirOfRepo(repo: string): string {
  return `models--${repo.replace('/', '--')}`
}

export function hubEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  return (env.HF_ENDPOINT ?? 'https://huggingface.co').replace(/\/+$/, '')
}

export type GgufSource = { repo: string; file: string; quant: string; revision: string; sha256: string; bytes: number }

type GgufPaths = { base: string; blob: string; incomplete: string; snapshotDir: string; snapshotFile: string }

export function ggufPaths(root: string, gguf: GgufSource): GgufPaths {
  const base = join(root, cacheDirOfRepo(gguf.repo))
  const blob = join(base, 'blobs', gguf.sha256)
  const snapshotDir = join(base, 'snapshots', gguf.revision)
  return { base, blob, incomplete: `${blob}.incomplete`, snapshotDir, snapshotFile: join(snapshotDir, gguf.file) }
}

function sizeOf(path: string): number | undefined {
  try {
    return statSync(path).size
  } catch {
    return undefined
  }
}

export function ggufOnDisk(root: string, gguf: GgufSource): { bytes: number; complete: boolean } {
  const paths = ggufPaths(root, gguf)
  const whole = sizeOf(paths.blob)
  if (whole !== undefined && whole === gguf.bytes) return { bytes: whole, complete: true }
  return { bytes: whole ?? sizeOf(paths.incomplete) ?? 0, complete: false }
}

export function cacheBlobBytes(root: string, repo: string): number {
  const blobs = join(root, cacheDirOfRepo(repo), 'blobs')
  let total = 0
  try {
    for (const name of readdirSync(blobs)) total += sizeOf(join(blobs, name)) ?? 0
  } catch {
    return 0
  }
  return total
}
