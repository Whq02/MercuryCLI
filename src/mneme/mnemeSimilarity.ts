import { stemLookupToken } from './mnemeStemmer.js'

export const CONSOLIDATE_SIMILARITY_THRESHOLD = 0.8

export function shingleTokens(text: string): string[] {
  return (text.toLowerCase().replace(/[’]/g, "'").match(/[\p{L}\p{N}]+(?:['./_-][\p{L}\p{N}]+)*/gu) ?? []).map(stemLookupToken)
}

function shingles(tokens: string[]): Set<string> {
  const width = Math.min(3, tokens.length)
  const out = new Set<string>()
  if (width === 0) return out
  for (let i = 0; i <= tokens.length - width; i++) out.add(tokens.slice(i, i + width).join('\u0000'))
  return out
}

export function shingleSimilarity(left: string, right: string): number {
  const a = shingles(shingleTokens(left))
  const b = shingles(shingleTokens(right))
  if (!a.size || !b.size) return 0
  let shared = 0
  for (const word of a) if (b.has(word)) shared++
  return shared / (a.size + b.size - shared)
}

function protectedWords(text: string): string {
  const tokens = shingleTokens(text)
  const words = tokens.flatMap((word, at) => {
    if (/^(no|not|never|without|cannot|neither|nor)$/.test(word) || /n't$/.test(word)) return [tokens.slice(at, at + 4).join(' ')]
    return /[0-9/_.]/.test(word) ? [word] : []
  })
  return words.sort().join('\u0000')
}

export function mergeSimilar(left: string, right: string): boolean {
  return protectedWords(left) === protectedWords(right) && shingleSimilarity(left, right) >= CONSOLIDATE_SIMILARITY_THRESHOLD
}
