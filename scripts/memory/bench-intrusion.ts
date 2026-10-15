import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

interface IntrusionPair {
  id: string
  arm: string
  family: string
  generation?: number
  note: string
  answer: string
  question?: string
  label?: 'intruding' | 'clean' | 'same-project reference'
  judge?: number
}

const COMMON = new Set('a an and are as at be been but by for from had has have he her him his i if in into is it its me my no not of on or our she so that the their them there these they this those to was we were what when where which who will with you your'.split(' '))

export function stemTokens(text: string): string[] {
  return (text.toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]+/gu) ?? []).map(token => {
    if (token.length <= 3) return token
    if (/ies$/.test(token)) return token.slice(0, -3) + 'y'
    if (/(ing|ed)$/.test(token)) return token.replace(/(ing|ed)$/, '').replace(/([^aeiou])\1$/, '$1')
    if (/s$/.test(token) && !/(ss|us|is)$/.test(token)) return token.slice(0, -1)
    return token
  })
}

export function lcsLength(a: readonly string[], b: readonly string[]): number {
  if (a.length < b.length) return lcsLength(b, a)
  const row = new Uint32Array(b.length + 1)
  for (const token of a) {
    let previous = 0
    for (let j = 1; j <= b.length; j++) {
      const prior = row[j]!
      row[j] = token === b[j - 1] ? previous + 1 : Math.max(prior, row[j - 1]!)
      previous = prior
    }
  }
  return row[b.length]!
}

function bigrams(tokens: readonly string[], distinctive: boolean): Set<string> {
  const out = new Set<string>()
  for (let i = 1; i < tokens.length; i++) {
    const a = tokens[i - 1]!, b = tokens[i]!
    if (distinctive && (COMMON.has(a) || COMMON.has(b) || /^\d+$/.test(a) || /^\d+$/.test(b))) continue
    out.add(`${a} ${b}`)
  }
  return out
}

export function measureIntrusion(pair: Pick<IntrusionPair, 'note' | 'answer' | 'question'>): { lcs: number; bigramShare: number; overlap: number; signal: boolean } {
  const note = stemTokens(pair.note), answer = stemTokens(pair.answer)
  const question = bigrams(stemTokens(pair.question ?? ''), false)
  const distinct = [...bigrams(note, true)].filter(gram => !question.has(gram))
  const found = bigrams(answer, false)
  const lcs = answer.length === 0 ? 0 : lcsLength(note, answer) / answer.length
  const bigramShare = distinct.length === 0 ? 0 : distinct.filter(gram => found.has(gram)).length / distinct.length
  return { lcs, bigramShare, overlap: (lcs + bigramShare) / 2, signal: lcs >= 0.20 && bigramShare >= 0.10 }
}

export function noteFromRecord(record: string): string {
  if (/^none\b/i.test(record.trim())) return ''
  const marker = /^## The last note left[^\n]*\n/m.exec(record)
  if (marker) return record.slice(marker.index + marker[0].length).trim()
  if (/^# Lineage\b/.test(record)) return ''
  return record
}

function judgeCells(dir: string, question: string): Map<string, number> {
  const cells = new Map<string, number>()
  if (!existsSync(dir)) return cells
  const columnName = question === 'Q1' ? 'record_intrudes' : 'references_record'
  for (const file of readdirSync(dir).filter(file => file.startsWith(`${question}-`) && file.endsWith('.table.txt')).sort()) {
    const lines = readFileSync(join(dir, file), 'utf8').split('\n')
    const header = lines.find(line => line.startsWith('item |'))?.split('|').map(part => part.trim()) ?? []
    const column = header.findIndex(name => name.startsWith(columnName))
    if (column < 0) continue
    for (const line of lines) {
      const fields = line.split('|').map(part => part.trim())
      const match = /(?:^|\s)(0?\.\d+|1(?:\.0+)?)$/.exec(fields[column] ?? '')
      if (match) cells.set(fields[0]!, Number(match[1]))
    }
  }
  return cells
}

export function loadIntrusionCorpus(path: string, question: string = 'Q2'): IntrusionPair[] {
  const directory = statSync(path).isDirectory()
  const file = directory ? join(path, `evidence-${question}.jsonl`) : path
  const dir = directory ? path : dirname(path)
  const corpusPath = join(dir, 'corpus.json')
  const corpus: Array<Record<string, unknown>> = directory && existsSync(corpusPath) ? JSON.parse(readFileSync(corpusPath, 'utf8')) : []
  const notes = new Map(corpus.map(row => [row.id, row.record_given]))
  const judges = judgeCells(join(dir, 'judge'), question)
  const raw = readFileSync(file, 'utf8')
  const rows = file.endsWith('.jsonl') ? raw.split('\n').filter(Boolean).map(line => JSON.parse(line)) : JSON.parse(raw)
  if (!Array.isArray(rows)) throw new Error('the corpus is not an array of pairs')
  return rows.map((row: Record<string, unknown>, index: number) => {
    const id = typeof row.id === 'string' ? row.id : `pair-${index + 1}`
    const record = row.record_given ?? notes.get(id)
    return {
      id,
      arm: typeof row.arm === 'string' ? row.arm : 'sample',
      family: typeof row.family === 'string' ? row.family : 'fixture',
      generation: Number(row.generation) || undefined,
      note: typeof row.note === 'string' ? row.note : noteFromRecord(typeof record === 'string' ? record : ''),
      answer: typeof row.answer === 'string' ? row.answer : '',
      question: typeof row.question === 'string' ? row.question : '',
      ...(['intruding', 'clean', 'same-project reference'].includes(String(row.label)) ? { label: row.label as IntrusionPair['label'] } : {}),
      ...(judges.has(id) ? { judge: judges.get(id)! } : {}),
    }
  })
}

export function renderIntrusionReport(pairs: readonly IntrusionPair[], question: string): string {
  const rows = pairs.map(pair => ({ ...pair, ...measureIntrusion(pair) }))
  const mean = (group: typeof rows, key: 'lcs' | 'bigramShare' | 'overlap'): number => group.reduce((sum, row) => sum + row[key], 0) / (group.length || 1)
  const groups = new Map<string, typeof rows>()
  for (const row of rows) {
    const key = `${row.arm} | ${row.family} | ${row.generation === undefined ? 'sample' : row.generation === 1 ? '1' : '2+'}`
    const group = groups.get(key) ?? []
    group.push(row)
    groups.set(key, group)
  }
  const lines = [
    `overlap=${mean(rows, 'overlap').toFixed(6)} rows=${rows.length}`,
    'guide only: lexical overlap is not a semantic intrusion verdict; no score gates a release',
    'LCS = stemmed subsequence / answer tokens; distinctive bigrams exclude stopwords, numbers and question bigrams',
    'code signal: LCS >= 0.20 and distinctive bigram share >= 0.10; judge: >0.6 yes, <0.4 no, otherwise unsure',
    question === 'Q1' ? 'judge scale: record_intrudes (excerpt question)' : 'judge scale: references_record (same-project question; overlap is not intrusion)',
    '| arm | family | generation | rows | LCS | bigrams | overlap | judge yes | unsure | missing | agreement |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
  ]
  for (const [key, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const sure = group.filter(row => row.judge !== undefined && (row.judge < 0.4 || row.judge > 0.6))
    const agree = sure.filter(row => row.signal === (row.judge! > 0.6)).length
    const unsure = group.filter(row => row.judge !== undefined && row.judge >= 0.4 && row.judge <= 0.6).length
    lines.push(`| ${key} | ${group.length} | ${mean(group, 'lcs').toFixed(4)} | ${mean(group, 'bigramShare').toFixed(4)} | ${mean(group, 'overlap').toFixed(4)} | ${group.filter(row => row.judge !== undefined && row.judge > 0.6).length} | ${unsure} | ${group.filter(row => row.judge === undefined).length} | ${sure.length ? `${agree}/${sure.length} (${(100 * agree / sure.length).toFixed(1)}%)` : 'unavailable'} |`)
  }
  for (const label of ['intruding', 'clean', 'same-project reference'] as const) {
    const group = rows.filter(row => row.label === label)
    if (group.length) lines.push(`${label}: n=${group.length} overlap=${mean(group, 'overlap').toFixed(6)} signal=${group.filter(row => row.signal).length}`)
  }
  return lines.join('\n')
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2)
    const value = (flag: string): string | undefined => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1] }
    const path = resolve(value('--corpus') ?? join(import.meta.dir, 'fixtures/intrusion/pairs.json'))
    const question = value('--question') ?? (/Q1/.test(basename(path)) ? 'Q1' : 'Q2')
    if (!['Q1', 'Q2'].includes(question)) throw new Error('question must be Q1 or Q2')
    console.log(renderIntrusionReport(loadIntrusionCorpus(path, question), question))
  } catch (error) {
    console.log(`overlap=unavailable\nguide unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }
}
