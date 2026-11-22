import { createHash } from 'node:crypto'
import { notBuilt } from '../pi/holes.js'

type BunHash = {
  hash(input: string, seed?: number): number | bigint
}

function bunHash(): BunHash | undefined {
  const bun = (globalThis as { Bun?: BunHash }).Bun
  return bun && typeof bun.hash === 'function' ? bun : undefined
}

export function djb2Hash(str: string): number {
  return notBuilt('src/utils/hash.ts:13')
}

function sha256Parts(...parts: string[]): string {
  const hash = createHash('sha256')
  parts.forEach((part, index) => {
    if (index > 0) hash.update('\0')
    hash.update(part)
  })
  return hash.digest('hex')
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

export function hashContent(content: string): string {
  return notBuilt('src/utils/hash.ts:34')
}

export function hashPair(a: string, b: string): string {
  return notBuilt('src/utils/hash.ts:40')
}
