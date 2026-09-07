import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { getMercuryHome } from '../../utils/envUtils.js'
import type { ProtocolEra } from './sdk.js'

export const ERA_VERDICT_TTL_MS = 24 * 60 * 60 * 1000

type Verdict = { era: ProtocolEra; at: number }
type CacheFile = Record<string, Verdict>

export function eraVerdictCachePath(): string {
  return join(getMercuryHome(), 'mcp-era-cache.json')
}

const DIGEST = /^[0-9a-f]{64}$/

function fileKey(serverKey: string): string {
  return createHash('sha256').update(serverKey).digest('hex')
}

let readMemo: Promise<CacheFile> | null = null
let writeChain: Promise<void> = Promise.resolve()

function readCache(): Promise<CacheFile> {
  if (readMemo === null) {
    readMemo = readFile(eraVerdictCachePath(), 'utf8')
      .then(text => JSON.parse(text) as CacheFile)
      .catch(() => ({}) as CacheFile)
  }
  return readMemo
}

function mutate(update: (cache: CacheFile) => void): Promise<void> {
  writeChain = writeChain
    .then(async () => {
      const cache = await readCache()
      update(cache)
      for (const key of Object.keys(cache)) if (!DIGEST.test(key)) delete cache[key]
      const path = eraVerdictCachePath()
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, JSON.stringify(cache, null, 2))
      readMemo = Promise.resolve(cache)
    })
    .catch(() => {})
  return writeChain
}

export async function readEraVerdict(
  serverKey: string,
  now: number = Date.now(),
): Promise<{ kind: 'legacy' } | undefined> {
  const entry = (await readCache())[fileKey(serverKey)]
  if (entry === undefined || entry.era !== 'legacy') return undefined
  if (now - entry.at > ERA_VERDICT_TTL_MS) return undefined
  return { kind: 'legacy' }
}

export function recordEraVerdict(serverKey: string, era: ProtocolEra, now: number = Date.now()): Promise<void> {
  return mutate(cache => {
    if (era === 'legacy') cache[fileKey(serverKey)] = { era, at: now }
    else delete cache[fileKey(serverKey)]
  })
}

export function clearEraVerdict(serverKey: string): Promise<void> {
  return mutate(cache => {
    delete cache[fileKey(serverKey)]
  })
}

export function resetEraVerdictMemo(): void {
  readMemo = null
}
