export type ModelNameEntry = { id: string; name?: string }

export type ModelNameMatch =
  | { kind: 'exact'; typed: string; id: string }
  | { kind: 'match'; typed: string; id: string; said: string }
  | { kind: 'ambiguous'; typed: string; candidates: string[] }
  | { kind: 'none'; typed: string; nearest: string[] }

const VENDOR_WORDS = ['anthropic', 'claude', 'openai', 'zai', 'z.ai', 'moonshot', 'deepseek', 'google', 'gemini', 'meta', 'mistral', 'xai']
const DATE_TAIL = /[-_ ](20\d{6})$/

export function modelNameKey(text: string): string {
  let word = text.trim().toLowerCase()
  if (word === '') return ''
  if (!word.includes('/')) {
    for (const vendor of VENDOR_WORDS) {
      if (word === vendor) break
      if (word.startsWith(vendor) && /[-_ :.]/.test(word.charAt(vendor.length))) {
        word = word.slice(vendor.length + 1)
        break
      }
    }
    word = word.replace(DATE_TAIL, '')
  }
  return word.replace(/[^a-z0-9]+/g, '')
}

const NEAREST = 3

function distance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) rows[0]![j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i]![j] = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
  }
  return rows[a.length]![b.length]!
}

function keysOf(entry: ModelNameEntry): string[] {
  const own = [modelNameKey(entry.id), ...(entry.name === undefined || entry.id.includes('/') ? [] : [modelNameKey(entry.name)])]
  return own.filter(k => k !== '')
}

function nearestOf(key: string, entries: readonly ModelNameEntry[]): string[] {
  const scored = entries.map(entry => {
    const own = keysOf(entry)
    const score = Math.min(...own.map(k => (k.includes(key) || key.includes(k) ? Math.abs(k.length - key.length) : distance(key, k))))
    return { id: entry.id, score }
  })
  return scored
    .sort((a, b) => a.score - b.score)
    .slice(0, NEAREST)
    .map(entry => entry.id)
}

export function matchModelName(typed: string, entries: readonly ModelNameEntry[]): ModelNameMatch {
  const word = typed.trim()
  const seen = new Set<string>()
  const unique = entries.filter(entry => (seen.has(entry.id) ? false : (seen.add(entry.id), true)))
  const exact = unique.find(entry => entry.id === word) ?? unique.find(entry => entry.id.toLowerCase() === word.toLowerCase())
  if (exact !== undefined) return { kind: 'exact', typed: word, id: exact.id }
  const key = modelNameKey(word)
  if (key === '') return { kind: 'none', typed: word, nearest: [] }
  const whole = unique.filter(entry => keysOf(entry).includes(key))
  if (whole.length === 1) return { kind: 'match', typed: word, id: whole[0]!.id, said: `${word} → ${whole[0]!.id}` }
  if (whole.length > 1) return { kind: 'ambiguous', typed: word, candidates: whole.map(entry => entry.id) }
  const leading = unique.filter(entry => keysOf(entry).some(k => k.startsWith(key)))
  if (leading.length === 1) return { kind: 'match', typed: word, id: leading[0]!.id, said: `${word} → ${leading[0]!.id}` }
  if (leading.length > 1) return { kind: 'ambiguous', typed: word, candidates: leading.map(entry => entry.id) }
  return { kind: 'none', typed: word, nearest: nearestOf(key, unique) }
}
