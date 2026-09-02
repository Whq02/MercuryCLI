
type BunHash = {
  hash(input: string, seed?: number): number | bigint
}

function bunHash(): BunHash | undefined {
  const bun = (globalThis as { Bun?: BunHash }).Bun
  return bun && typeof bun.hash === 'function' ? bun : undefined
}

export function djb2Hash(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
  }
  return hash
}

function sha256Hex(...parts: string[]): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require('node:crypto') as typeof import('node:crypto')
  const hash = createHash('sha256')
  parts.forEach((part, index) => {
    if (index > 0) hash.update('\0')
    hash.update(part)
  })
  return hash.digest('hex')
}

export function hashContent(content: string): string {
  const bun = bunHash()
  if (bun) return String(bun.hash(content))
  return sha256Hex(content)
}

export function hashPair(a: string, b: string): string {
  const bun = bunHash()
  if (bun) {
    const seed = Number(BigInt.asUintN(32, BigInt(bun.hash(a))))
    return String(bun.hash(b, seed))
  }
  return sha256Hex(a, b)
}
