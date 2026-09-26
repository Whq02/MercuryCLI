#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { JevEvalInput } from '../../src/tools/JevEvalTool/jevEvalSchema.js'
import { roadHome } from './lib/roadHome.ts'

export const LEAD_WAKE_QUESTION_FLOOR = 0.8
export const LEAD_WAKE_FIRST_LINES = 20
export const LEAD_WAKE_LINE_CLIP = 1800
export const LEAD_WAKE_SHOW_CLIP = 200
export const LEAD_WAKE_LEAD_DEV_FILE = 'LEAD-W1.md'
export const LEAD_WAKE_OWN_FILE = 'MERCURY-LEAD-W1.md'
export const LEAD_WAKE_USAGE = "usage: bun run scripts/jev/lead-wake.ts <comms-dir> --state <file> [--floor 0.8] [--first 20] [--home <config home: the JEV setting and key; default the operator's own ~/.mercury, a pinned scratch kept>] [--json]"
export const LEAD_WAKE_QUESTIONS: JevEvalInput['questions'] = [
  {
    id: 'needs_answer',
    kind: 'noul',
    ask: '`line` is one comms line a seat wrote to its lead, in the file `file`. It asks the lead something the seat cannot decide alone — a permission, a scope ruling, a file outside its boundary, a blocking question, a decision to make — so the lead must answer before the seat can go on; a landing, a status note or a finding that needs no reply is not that.',
  },
]

const TIME = '(\\d{2}:\\d{2}(?::\\d{2})?)(?: \\(?[A-Z]{2,5}\\)?| [+-]\\d{4})?'
const STAMP = new RegExp(`^(?:- )?(?:\\[(?:\\d{4}-\\d{2}-\\d{2} )?${TIME}\\] ?|(?:\\d{4}-\\d{2}-\\d{2} )?${TIME}(?: — | · ))(.*)$`)

export interface CommsLine {
  file: string
  number: number
  stamp: string | null
  words: string
  raw: string
}
export type WakeState = Record<string, number>

export function judgedLine(raw: string): boolean {
  const trimmed = raw.trim()
  return trimmed !== '' && !trimmed.startsWith('#')
}

export function splitStamp(raw: string): { stamp: string | null; words: string } {
  const match = STAMP.exec(raw.trim())
  return match ? { stamp: (match[1] ?? match[2])!, words: match[3]!.trim() } : { stamp: null, words: raw.trim() }
}

export function newLinesOf(file: string, text: string, seen: number | undefined, first: number = LEAD_WAKE_FIRST_LINES): { lines: CommsLine[]; count: number; rewound: boolean } {
  const all = text.replace(/\r/g, '').split('\n')
  if (all.length > 0 && all[all.length - 1] === '') all.pop()
  const rewound = seen !== undefined && seen > all.length
  const from = seen === undefined || rewound ? 0 : seen
  const judged: CommsLine[] = []
  for (let index = from; index < all.length; index++) {
    const raw = all[index]!
    if (!judgedLine(raw)) continue
    const { stamp, words } = splitStamp(raw)
    judged.push({ file, number: index + 1, stamp, words: words.length > LEAD_WAKE_LINE_CLIP ? words.slice(0, LEAD_WAKE_LINE_CLIP) : words, raw: raw.trim() })
  }
  return { lines: seen === undefined ? judged.slice(-first) : judged, count: all.length, rewound }
}

export function readState(path: string): WakeState {
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: WakeState = {}
    for (const [file, count] of Object.entries(parsed as Record<string, unknown>)) if (typeof count === 'number' && Number.isInteger(count) && count >= 0) out[file] = count
    return out
  } catch {
    return {}
  }
}

export function commsFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter(name => name.endsWith('.md') && name !== LEAD_WAKE_OWN_FILE)
    .sort((a, b) => (a === LEAD_WAKE_LEAD_DEV_FILE ? -1 : b === LEAD_WAKE_LEAD_DEV_FILE ? 1 : a.localeCompare(b)))
}

function show(words: string): string {
  const flat = words.replace(/\s+/g, ' ')
  return flat.length > LEAD_WAKE_SHOW_CLIP ? `${flat.slice(0, LEAD_WAKE_SHOW_CLIP - 1)}…` : flat
}

function p(value: number): string {
  return value.toFixed(2)
}

interface Args {
  dir: string
  state: string
  floor: number
  first: number
  home?: string
  json: boolean
}

function parseArgs(argv: readonly string[]): Args | string {
  const positional: string[] = []
  const args: Args = { dir: '', state: '', floor: LEAD_WAKE_QUESTION_FLOOR, first: LEAD_WAKE_FIRST_LINES, json: false }
  for (let at = 0; at < argv.length; at++) {
    const word = argv[at]!
    const value = (): string | undefined => argv[++at]
    if (word === '--state') args.state = value() ?? ''
    else if (word === '--floor') args.floor = Number(value())
    else if (word === '--first') args.first = Number(value())
    else if (word === '--home') args.home = value()
    else if (word === '--json') args.json = true
    else if (word.startsWith('--')) return `unknown flag ${word}`
    else positional.push(word)
  }
  if (positional.length !== 1) return 'the comms directory is the one argument'
  args.dir = resolve(positional[0]!)
  if (!existsSync(args.dir)) return `no such directory ${args.dir}`
  if (args.state === '') return '--state <file> is required (the line counts per comms file, written back after the run)'
  args.state = resolve(args.state)
  if (!Number.isFinite(args.floor) || args.floor <= 0 || args.floor > 1) return 'the floor is a probability in (0, 1]'
  if (!Number.isInteger(args.first) || args.first < 1) return '--first wants a whole number of lines'
  return args
}

type Judged = CommsLine & { p: number | null; words_unavailable?: string }

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2))
  if (typeof parsed === 'string') {
    console.error(`${LEAD_WAKE_USAGE}\n${parsed}`)
    return 4
  }
  const args = parsed
  const state = readState(args.state)
  const next: WakeState = {}
  const leadLines: CommsLine[] = []
  const items: CommsLine[] = []
  const rewound: string[] = []
  for (const file of commsFiles(args.dir)) {
    const text = readFileSync(join(args.dir, file), 'utf8')
    const found = newLinesOf(file, text, state[file], args.first)
    next[file] = found.count
    if (found.rewound) rewound.push(file)
    if (file === LEAD_WAKE_LEAD_DEV_FILE) leadLines.push(...found.lines)
    else items.push(...found.lines)
  }
  const out: string[] = []
  const record: Record<string, unknown> = { dir: args.dir, floor: args.floor, rewound, leadLines: leadLines.map(line => ({ number: line.number, line: line.raw })) }
  if (leadLines.length > 0) {
    out.push(`${LEAD_WAKE_LEAD_DEV_FILE} — ${leadLines.length} new line(s), read whole:`)
    for (const line of leadLines) out.push(`  ${line.number}: ${line.raw}`)
  } else out.push(`${LEAD_WAKE_LEAD_DEV_FILE} — no new line`)
  let unavailable: string | undefined
  const judged: Judged[] = []
  if (items.length > 0) {
    process.env.MERCURY_CONFIG_DIR = roadHome(args.home)
    const { askJevBatch } = await import('./lib/jevAsk.ts')
    const rows = await askJevBatch(items.map(line => ({ id: `${line.file}:${line.number}`, evidence: { file: line.file, line: line.words } })), LEAD_WAKE_QUESTIONS)
    rows.forEach((row, index) => {
      const line = items[index]!
      if (row.ask.ok && typeof row.ask.nouls.needs_answer === 'number') judged.push({ ...line, p: row.ask.nouls.needs_answer })
      else {
        judged.push({ ...line, p: null })
        if (unavailable === undefined && !row.ask.ok) unavailable = row.ask.words
      }
    })
  }
  const questions = judged.filter(line => line.p !== null && line.p >= args.floor).sort((a, b) => b.p! - a.p! || b.number - a.number)
  const rest = judged.filter(line => !questions.includes(line))
  if (items.length === 0 && leadLines.length === 0) out.push('no new comms line since the last wake')
  if (items.length > 0) {
    if (questions.length > 0) {
      out.push(`QUESTIONS (p ≥ ${p(args.floor)}) — ${questions.length}:`)
      for (const line of questions) out.push(`  QUESTION ${line.file}:${line.number}${line.stamp ? ` ${line.stamp}` : ''} p=${p(line.p!)} · ${show(line.words)}`)
    } else out.push(`QUESTIONS (p ≥ ${p(args.floor)}) — none flagged`)
    if (unavailable !== undefined) out.push(`jev unavailable — ${unavailable}${judged.some(line => line.p !== null) ? ' (the lines below without a number were not judged)' : ' (no line was judged; every line is listed)'}`)
    out.push(`THE REST — ${rest.length} line(s):`)
    for (const line of rest) out.push(`  ${line.file}:${line.number}${line.stamp ? ` ${line.stamp}` : ''} ${line.p === null ? 'unjudged' : `p=${p(line.p)}`} · ${show(line.words)}`)
  }
  if (rewound.length > 0) out.push(`re-read whole (shorter than the last wake saw): ${rewound.join(', ')}`)
  mkdirSync(dirname(args.state), { recursive: true })
  writeFileSync(args.state, `${JSON.stringify(next, null, 2)}\n`)
  Object.assign(record, {
    questions: questions.map(line => ({ file: line.file, number: line.number, stamp: line.stamp, p: line.p, line: line.words })),
    rest: rest.map(line => ({ file: line.file, number: line.number, stamp: line.stamp, p: line.p, line: line.words })),
    ...(unavailable !== undefined ? { unavailable } : {}),
    state: next,
  })
  console.log(args.json ? JSON.stringify(record) : out.join('\n'))
  return 0
}

if (import.meta.main) process.exit(await main())
