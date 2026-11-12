import { stemLookupToken } from '../../mneme/mnemeStemmer.js'

const MAX_WORDS = 12
const MAX_FILES = 8
const MAX_RANGES = 3
const RANGE_LINES = 40
const RANGE_GAP = 5
const SHORTLIST = 24
const LINES_PER_FILE = 500
const LINE_COLUMNS = 400
const MAX_PATTERN_CHARS = 1000
const SATURATION = 1.2

const GLUE = new Set(
  'the and for are but not you all any can had her was one our out has his how its let may new now old see two way who did get got him she too use that with this from they what when your have will been into then than them were some would there their about which could other these those should after before where while does make made just like also only over such very want need here each every both same still again back being whether between through under onto upon doing done within without'.split(
    ' ',
  ),
)

const NOT_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffd]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/

type RankedWord = { word: string; spellings: string[] }

export type RankedPass = { lines: string[]; complete: boolean; reason?: string }

type RankedRange = { start: number; end: number; weight: number }

type RankedFile = { file: string; score: number; counts: number[]; ranges: RankedRange[] }

type RankedAnswer = {
  words: RankedWord[]
  holding: number[]
  candidates: number
  searched?: number
  files: RankedFile[]
  incomplete?: string
}

function spellingsOf(word: string): string[] {
  const forms = /[^aeiou]y$/.test(word) ? [word, `${word.slice(0, -1)}ie`] : [word]
  return [...new Set(forms.flatMap(form => [form, form.toUpperCase(), form.charAt(0).toUpperCase() + form.slice(1)]))]
}

export function rankedWords(pattern: string): RankedWord[] {
  const words: RankedWord[] = []
  const seen = new Set<string>()
  const spaced = pattern
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
  for (const token of spaced.split(/[^a-z0-9]+/)) {
    if (token.length < 3 || GLUE.has(token) || /^\d+$/.test(token)) continue
    const stem = stemLookupToken(token)
    const word = stem.length >= 4 ? stem : token
    if (GLUE.has(word) || seen.has(word)) continue
    seen.add(word)
    words.push({ word, spellings: spellingsOf(word) })
    if (words.length === MAX_WORDS) break
  }
  return words
}

export function rankedRefusal(pattern: string): string | null {
  if (NOT_TEXT.test(pattern)) return 'output_mode "ranked" reads pattern as plain words, and this pattern holds bytes that are not text. Describe the behaviour in words.'
  if (pattern.length > MAX_PATTERN_CHARS) {
    return `output_mode "ranked" takes a short description: ${MAX_PATTERN_CHARS} characters at most, of which the first ${MAX_WORDS} words are counted. This pattern has ${pattern.length} characters.`
  }
  if (rankedWords(pattern).length === 0) {
    return 'output_mode "ranked" found no word to count in pattern: it needs a word of three letters or more that is not a glue word such as "the" or "where".'
  }
  return null
}

const SCOPE_VALUE_FLAGS = new Set(['--glob', '--iglob', '--type', '--type-add', '--max-depth'])

export function rankedScope(args: readonly string[]): string[] {
  const scope: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--hidden') scope.push(arg)
    else if (SCOPE_VALUE_FLAGS.has(arg) && i + 1 < args.length) scope.push(arg, args[++i]!)
  }
  return scope
}

function fixedStrings(words: readonly RankedWord[]): string[] {
  return words.flatMap(word => word.spellings.flatMap(spelling => ['-e', spelling]))
}

export function countPassArgs(scope: readonly string[], word: RankedWord): string[] {
  return [...scope, '-c', '--with-filename', '--null', '--stats', '-F', ...fixedStrings([word])]
}

export function linePassArgs(words: readonly RankedWord[], files: readonly string[]): string[] {
  return [
    '-n',
    '--null',
    '--no-heading',
    '--with-filename',
    '-F',
    '--max-columns',
    String(LINE_COLUMNS),
    '--max-count',
    String(LINES_PER_FILE),
    ...fixedStrings(words),
    '--',
    ...files,
  ]
}

function under(root: string, file: string): string | null {
  if (file === root) return file.slice(Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')) + 1)
  if (!file.startsWith(root)) return null
  const next = file.charAt(root.length)
  const closed = root.endsWith('/') || root.endsWith('\\')
  if (!closed && next !== '/' && next !== '\\') return null
  return file.slice(root.length + (closed ? 0 : 1))
}

function readCountPass(lines: readonly string[], root: string): { counts: Map<string, number>; searched?: number } {
  const counts = new Map<string, number>()
  let searched: number | undefined
  for (const line of lines) {
    const nul = line.indexOf('\0')
    if (nul === -1) {
      const stats = /^(\d+) files searched$/.exec(line)
      if (stats) searched = Number(stats[1])
      continue
    }
    const file = line.slice(0, nul)
    const count = line.slice(nul + 1)
    if (!/^\d+$/.test(count) || under(root, file) === null) continue
    counts.set(file, Number(count))
  }
  return { counts, ...(searched !== undefined ? { searched } : {}) }
}

function isLetter(char: string): boolean {
  return (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z')
}

function isUpper(char: string): boolean {
  return char >= 'A' && char <= 'Z'
}

export function holdsWord(text: string, word: RankedWord): boolean {
  for (const spelling of word.spellings) {
    const capitalised = isUpper(spelling.charAt(0)) && spelling !== spelling.toUpperCase()
    const shouted = !capitalised && spelling === spelling.toUpperCase() && spelling !== spelling.toLowerCase()
    for (let at = text.indexOf(spelling); at !== -1; at = text.indexOf(spelling, at + 1)) {
      if (capitalised || at === 0) return true
      const before = text.charAt(at - 1)
      if (shouted ? !isUpper(before) : !isLetter(before)) return true
    }
  }
  return false
}

function saturated(count: number): number {
  return count / (count + SATURATION)
}

function byScoreThenPath<T extends { file: string; score: number }>(a: T, b: T): number {
  return b.score - a.score || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)
}

function rangesOf(rows: ReadonlyArray<{ line: number; held: number[] }>, rarity: readonly number[]): RankedRange[] {
  const sorted = [...rows].sort((a, b) => a.line - b.line)
  const clusters: Array<Array<{ line: number; held: number[] }>> = []
  for (const row of sorted) {
    const cluster = clusters[clusters.length - 1]
    if (cluster && row.line - cluster[cluster.length - 1]!.line <= RANGE_GAP && row.line - cluster[0]!.line < RANGE_LINES) cluster.push(row)
    else clusters.push([row])
  }
  return clusters
    .map(cluster => {
      const within = rarity.map(() => 0)
      for (const row of cluster) for (const index of row.held) within[index]!++
      let weight = 0
      for (let index = 0; index < rarity.length; index++) if (within[index]! > 0) weight += rarity[index]! * saturated(within[index]!)
      return { start: cluster[0]!.line, end: cluster[cluster.length - 1]!.line, weight }
    })
    .sort((a, b) => b.weight - a.weight || a.start - b.start)
}

export async function rankedSearch(options: {
  pattern: string
  root: string
  scope: readonly string[]
  run: (args: string[], target: string) => Promise<RankedPass>
  withhold?: (files: string[]) => string[]
}): Promise<RankedAnswer> {
  const { root } = options
  const asked = rankedWords(options.pattern)
  const passes: Array<Map<string, number>> = []
  let searched: number | undefined
  let incomplete: string | undefined
  for (const word of asked) {
    const pass = await options.run(countPassArgs(options.scope, word), root)
    if (!pass.complete) {
      incomplete = pass.reason ?? 'the search did not finish'
      break
    }
    const read = readCountPass(pass.lines, root)
    passes.push(read.counts)
    if (read.searched !== undefined) searched = Math.max(searched ?? 0, read.searched)
  }
  const words = asked.slice(0, passes.length)

  const found = new Set<string>()
  for (const pass of passes) for (const file of pass.keys()) found.add(file)
  const allowed = options.withhold ? new Set(options.withhold([...found].sort()).filter(file => found.has(file))) : found
  if (searched !== undefined) searched = Math.max(allowed.size, searched - (found.size - allowed.size))
  const counts = passes.map(pass => new Map([...pass].filter(([file]) => allowed.has(file))))
  const holding = counts.map(pass => pass.size)
  const total = Math.max(searched ?? 0, allowed.size)
  const rarity = holding.map(count => Math.log(1 + (total - count + 0.5) / (count + 0.5)))

  const shortlist = [...allowed]
    .map(file => {
      const path = under(root, file) ?? file
      let score = 0
      for (let index = 0; index < words.length; index++) {
        const count = counts[index]!.get(file) ?? 0
        if (count > 0) score += rarity[index]! * saturated(count)
        if (holdsWord(path, words[index]!)) score += rarity[index]!
      }
      return { file, score }
    })
    .sort(byScoreThenPath)
    .slice(0, SHORTLIST)
    .map(entry => entry.file)

  const answer: RankedAnswer = { words, holding, candidates: allowed.size, ...(searched !== undefined ? { searched } : {}), files: [] }
  if (incomplete !== undefined) answer.incomplete = incomplete
  if (shortlist.length === 0) return answer

  const reading = await options.run(linePassArgs(words, shortlist.slice(0, -1)), shortlist[shortlist.length - 1]!)
  if (!reading.complete && answer.incomplete === undefined) answer.incomplete = reading.reason ?? 'the search did not finish'
  const listed = new Set(shortlist)
  const rows = new Map<string, Array<{ line: number; held: number[] }>>()
  for (const line of reading.lines) {
    const nul = line.indexOf('\0')
    if (nul === -1) continue
    const file = line.slice(0, nul)
    const row = /^(\d+):([\s\S]*)$/.exec(line.slice(nul + 1))
    if (!row || !listed.has(file) || row[2]!.startsWith('[Omitted long ')) continue
    const held: number[] = []
    for (let index = 0; index < words.length; index++) if (holdsWord(row[2]!, words[index]!)) held.push(index)
    if (held.length === 0) continue
    const list = rows.get(file) ?? []
    list.push({ line: Number(row[1]), held })
    rows.set(file, list)
  }

  const ranked: RankedFile[] = []
  for (const [file, lines] of rows) {
    const path = under(root, file) ?? file
    const exact = words.map(() => 0)
    for (const row of lines) for (const index of row.held) exact[index]!++
    const ranges = rangesOf(lines, rarity)
    let score = ranges[0]?.weight ?? 0
    for (let index = 0; index < words.length; index++) {
      if (exact[index]! > 0) score += rarity[index]! * saturated(exact[index]!)
      if (holdsWord(path, words[index]!)) score += rarity[index]!
    }
    ranked.push({ file, score, counts: exact, ranges: ranges.slice(0, MAX_RANGES) })
  }
  answer.files = ranked.sort(byScoreThenPath).slice(0, MAX_FILES)
  return answer
}

function said(count: number): string {
  return count.toLocaleString('en-US')
}

function fileWord(count: number): string {
  return count === 1 ? 'file' : 'files'
}

export function renderRanked(answer: RankedAnswer, display: (file: string) => string): { text: string; rows: string[] } {
  const { words, holding, candidates, searched } = answer
  if (words.length === 0) return { text: 'Ranked by words, not by meaning: no word was counted before the search was cut.', rows: [] }
  if (candidates === 0) {
    const names = words.map(word => word.word)
    const either = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]!}`
    const among = searched === undefined ? 'No file searched' : `No file among ${said(searched)} searched`
    return { text: `${among} holds ${either}. This ranks by words only: add the names the behaviour may go by.`, rows: [] }
  }
  const counted = words.map((word, index) => `${word.word} (${said(holding[index]!)}${index === 0 ? ` ${fileWord(holding[index]!)}` : ''})`).join(', ')
  const among = searched === undefined ? '' : `, among ${said(searched)} searched`
  const head = `Ranked by words, not by meaning: ${answer.files.length} of ${said(candidates)} ${fileWord(candidates)} holding ${counted}${among}.`
  const places = answer.files.map(file => `${display(file.file)}:${file.ranges.map(range => (range.start === range.end ? String(range.start) : `${range.start}-${range.end}`)).join(', ')}`)
  const rows = answer.files.map((file, at) => {
    const held = words.flatMap((word, index) => (file.counts[index]! > 0 ? [`${word.word} ${file.counts[index]!}`] : []))
    return `${places[at]!} (${held.join(', ')})`
  })
  return {
    text: [head, ...rows, 'A file that says it in other words is not listed: add the names it may go by to pattern.'].join('\n'),
    rows: places,
  }
}
