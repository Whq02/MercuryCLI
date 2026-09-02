/**
 * Non-cryptographic hashes for change detection and stable cache keys.
 */

type BunHash = {
  hash(input: string, seed?: number): number | bigint
}

function bunHash(): BunHash | undefined {
  const bun = (globalThis as { Bun?: BunHash }).Bun
  return bun && typeof bun.hash === 'function' ? bun : undefined
}

/**
 * A deterministic 32-bit string hash for on-disk-stable keys (cache
 * directory names that must survive a runtime upgrade — the runtime's own
 * fast hash is not stable across versions). The formula is contract data:
 * start from 0 and, for each UTF-16 code unit `c`, `h = ((h << 5) - h + c) | 0`,
 * i.e. h * 31 + c reduced to a signed 32-bit integer at every step. The
 * multiply-by-31 variant seeded at 0, not the classic 5381/x33 form the name
 * suggests. Callers take its absolute value and render it in base 36.
 */
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

/**
 * A content hash for change detection — the fast runtime hash when
 * available (orders of magnitude faster than a cryptographic hash and good
 * enough for noticing edits; explicitly NOT for security), else hex
 * SHA-256. The two paths deliberately produce different strings, so nothing
 * may persist a content hash across a runtime change.
 */
export function hashContent(content: string): string {
  const bun = bunHash()
  if (bun) return String(bun.hash(content))
  return sha256Hex(content)
}

/**
 * A pair hash that avoids allocating a concatenated temporary. Under the
 * fast-hash runtime it seed-chains (the first hash seeds the second), which
 * disambiguates different splits of the same characters without a
 * separator; the fallback feeds both strings through one incremental
 * SHA-256 with an explicit NUL between them.
 */
export function hashPair(a: string, b: string): string {
  const bun = bunHash()
  if (bun) {
    const seed = Number(BigInt.asUintN(32, BigInt(bun.hash(a))))
    return String(bun.hash(b, seed))
  }
  return sha256Hex(a, b)
}
