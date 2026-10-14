import { POLARITY_WORDS, polarityFlipBetween } from './mnemePolarity.js'
import { stemLookupToken } from './mnemeStemmer.js'
import { sentencesOf } from './mnemeText.js'

export const CONSOLIDATE_SIMILARITY_THRESHOLD = 0.8
const PROTECTED_WINDOW = 4

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

export function properNames(text: string): string[] {
  const names: string[] = []
  for (const sentence of sentencesOf(text)) {
    const words = sentence.split(/\s+/)
    for (const word of words.slice(1)) {
      const core = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
      if (core.length > 1 && /^\p{Lu}[\p{L}\p{N}'’-]*$/u.test(core)) names.push(core.toLowerCase())
    }
  }
  return names
}

export function protectedWords(text: string): string[] {
  const tokens = shingleTokens(text)
  const words = tokens.flatMap((word, at) => {
    if (/^(no|not|never|without|cannot|neither|nor)$/.test(word) || /n't$/.test(word)) return [tokens.slice(at, at + PROTECTED_WINDOW).join(' ')]
    return /[0-9/_.-]/.test(word) ? [word] : []
  })
  return [...words, ...properNames(text)].sort()
}

function polarityWindows(text: string): Map<string, string> {
  const tokens = shingleTokens(text)
  const windows = new Map<string, string[]>()
  tokens.forEach((word, at) => {
    if (!POLARITY_WORDS.has(word)) return
    windows.set(word, [...(windows.get(word) ?? []), tokens.slice(at, at + PROTECTED_WINDOW).join(' ')])
  })
  return new Map([...windows].map(([word, list]) => [word, list.sort().join('\u0000')]))
}

export function polarityKeepsApart(left: string, right: string): boolean {
  if (polarityFlipBetween(left, right) !== null) return true
  const theirs = polarityWindows(right)
  for (const [word, mine] of polarityWindows(left)) {
    const other = theirs.get(word)
    if (other !== undefined && other !== mine) return true
  }
  return false
}

export function mergeSimilar(left: string, right: string): boolean {
  if (protectedWords(left).join('\u0000') !== protectedWords(right).join('\u0000')) return false
  if (polarityKeepsApart(left, right)) return false
  return shingleSimilarity(left, right) >= CONSOLIDATE_SIMILARITY_THRESHOLD
}
