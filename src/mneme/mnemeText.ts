import { stemLookupToken } from './mnemeStemmer.js'

const GLUE = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'into', 'at', 'by', 'for', 'from', 'with', 'as', 'is', 'are', 'was', 'were',
  'be', 'been', 'being', 'am', 'it', 'its', 'this', 'that', 'these', 'those', 'there', 'here', 'their', 'they', 'them', 'we',
  'our', 'us', 'you', 'your', 'he', 'she', 'his', 'her', 'him', 'i', 'me', 'my', 'mine', 'do', 'does', 'did', 'done', 'doing',
  'has', 'have', 'had', 'having', 'will', 'would', 'shall', 'should', 'can', 'could', 'may', 'might', 'must', 'so', 'than',
  'then', 'also', 'too', 'very', 'just', 'about', 'up', 'out', 'any', 'all', 'each', 'every', 'some', 'such', 'own', 'same',
  'other', 'what', 'which', 'who', 'whom', 'whose', 'how', 'why', 'where', 'again', 'once', 'ever', 'per', 'via', 'etc',
])

const CONTRACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bwon't\b/g, 'will not'],
  [/\bcan't\b/g, 'can not'],
  [/\bcannot\b/g, 'can not'],
  [/\bshan't\b/g, 'shall not'],
  [/n't\b/g, ' not'],
]

function cvc(word: string): boolean {
  const n = word.length
  if (n < 3) return false
  return !/[aeiouwxy]/.test(word[n - 1]!) && /[aeiouy]/.test(word[n - 2]!) && !/[aeiouy]/.test(word[n - 3]!)
}

function measure(word: string): number {
  let m = 0
  let inVowel = false
  for (const ch of word) {
    const vowel = /[aeiouy]/.test(ch)
    if (vowel) inVowel = true
    else if (inVowel) {
      m++
      inVowel = false
    }
  }
  return m
}

function stem(raw: string): string {
  const word = stemLookupToken(raw.toLowerCase())
  if (!word.endsWith('e') || word.length < 3 || /[^a-z]/.test(word)) return word
  const base = word.slice(0, -1)
  const m = measure(base)
  return m > 1 || (m === 1 && !cvc(base)) ? base : word
}

export function wordsOf(text: string): string[] {
  let lowered = text.toLowerCase()
  for (const [pattern, replacement] of CONTRACTIONS) lowered = lowered.replace(pattern, replacement)
  return lowered.split(/[^a-z0-9]+/).filter(word => word.length >= 2)
}

const CLAUSE_JOINERS = new Set(['and', 'but', 'or'])

export function clausesOf(text: string): string[][] {
  const out: string[][] = []
  for (const piece of text.split(/[,;.!?\r\n]+/)) {
    let clause: string[] = []
    for (const word of wordsOf(piece)) {
      if (CLAUSE_JOINERS.has(word)) {
        if (clause.length > 0) out.push(clause)
        clause = []
        continue
      }
      clause.push(word)
    }
    if (clause.length > 0) out.push(clause)
  }
  return out
}

export function normalisedText(text: string): string {
  return wordsOf(text).join(' ')
}

export const isNumberWord = (word: string): boolean => /^\d+$/.test(word)

export function contentStems(words: readonly string[], skip: ReadonlySet<string> = new Set()): string[] {
  const out: string[] = []
  for (const word of words) {
    if (GLUE.has(word) || skip.has(word) || isNumberWord(word)) continue
    out.push(stem(word))
  }
  return out
}

const ABBREVIATION_END = /\b(?:e\.g|i\.e|vs|cf)\.$/i
const TITLE_END = /\b(?:Dr|Mr|Mrs|Ms|Prof|St)\.$/

function endsWithAbbreviation(piece: string): boolean {
  return ABBREVIATION_END.test(piece) || TITLE_END.test(piece)
}

export function sentencesOf(text: string): string[] {
  const out: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const pieces: string[] = []
    for (const piece of line.split(/(?<=[.!?])\s+(?=[^\s])/)) {
      const previous = pieces.length > 0 ? pieces[pieces.length - 1]! : null
      if (previous !== null && endsWithAbbreviation(previous)) pieces[pieces.length - 1] = `${previous} ${piece}`
      else pieces.push(piece)
    }
    for (const piece of pieces) {
      const cleaned = piece.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim()
      if (cleaned !== '' && /[a-z]/i.test(cleaned)) out.push(cleaned)
    }
  }
  return out
}

export function shingles(stems: readonly string[], size: number = 2): Set<string> {
  const out = new Set<string>()
  if (stems.length < size) {
    for (const one of stems) out.add(one)
    return out
  }
  for (let index = 0; index + size <= stems.length; index++) out.add(stems.slice(index, index + size).join(' '))
  return out
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const item of a) if (b.has(item)) shared++
  return shared / (a.size + b.size - shared)
}

export function containment(part: ReadonlySet<string>, whole: ReadonlySet<string>): number {
  if (part.size === 0) return 0
  let shared = 0
  for (const item of part) if (whole.has(item)) shared++
  return shared / part.size
}

export function firstWords(text: string, limit: number = 8): string {
  const words = text.trim().split(/\s+/)
  if (words.length <= limit) return text.trim()
  return `${words.slice(0, limit).join(' ')}…`
}

export function countInWords(n: number): string {
  const small = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
  const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']
  if (n < 0 || !Number.isInteger(n)) return String(n)
  if (n < 20) return small[n]!
  if (n < 100) return `${tens[Math.floor(n / 10)]}${n % 10 === 0 ? '' : `-${small[n % 10]}`}`
  return String(n)
}
