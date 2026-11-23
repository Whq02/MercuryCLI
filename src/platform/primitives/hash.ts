import { createHash } from 'node:crypto'

type BunHash = {
  hash(input: string, seed?: number): number | bigint
}

function bunHash(): BunHash | undefined {
  const bun = (globalThis as { Bun?: BunHash }).Bun
  return bun && typeof bun.hash === 'function' ? bun : undefined
}

export function djb2Hash(str: string): number {
  let value = 0
  for (let i = 0; i < str.length; i++) value = (value * 31 + str.charCodeAt(i)) | 0
  return value
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
  const bun = bunHash()
  return bun ? String(bun.hash(content)) : sha256Parts(content)
}

export function hashPair(a: string, b: string): string {
  const bun = bunHash()
  if (!bun) return sha256Parts(a, b)
  const seed = Number(BigInt.asUintN(32, BigInt(bun.hash(a))))
  return String(bun.hash(b, seed))
}
