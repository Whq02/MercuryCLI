#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { JevChoiceAnswer } from '../../src/services/jev/jevContract.js'
import type { JevEvalInput } from '../../src/tools/JevEvalTool/jevEvalSchema.js'
import { roadHome } from './lib/roadHome.ts'

export { PROOF_HOME_PREFIX, roadHome } from './lib/roadHome.ts'

export const RED_ROAD_CONFIDENT_FLOOR = 0.6
export const RED_ROAD_LOAD_CEILING = 10
export const RED_ROAD_LOAD_WAIT_SECS = 1800
export const RED_ROAD_LOAD_POLL_SECS = 10
export const RED_ROAD_RERUN_CEILING_SECS = 1800
export const RED_ROAD_LINE_CLIP = 240
export const RED_ROAD_FAIL_LINE_CLIP = 700
export const RED_ROAD_SHOWN_BEFORE = 12
export const RED_ROAD_SHOWN_AFTER = 8
export const RED_ROAD_TAIL_LINES = 40
export const RED_ROAD_RERUN_TAIL_LINES = 30
export const RED_ROAD_SOURCE_BEFORE = 2
export const RED_ROAD_SOURCE_AFTER = 6
export const RED_ROAD_NEEDLE_LIMIT = 6
export const RED_ROAD_CHECK_LIMIT = 48
export const RED_ROAD_HOME_PREFIX = 'red-road-home.'
export const RED_ROAD_PROOF_KEY = 'proof-key-ci-gate-not-a-real-key'
export const RED_ROAD_DEAD_BASE = 'http://127.0.0.1:1'
export const RED_ROAD_CLASSES = ['product', 'stale', 'run', 'hosted'] as const
export type RedRoadClass = (typeof RED_ROAD_CLASSES)[number]
export type RedRoadVerdict = RedRoadClass | 'unsure'
export const RED_ROAD_EXITS: Readonly<Record<RedRoadVerdict | 'unavailable' | 'usage', number>> = { run: 0, product: 1, stale: 2, hosted: 3, unsure: 4, unavailable: 5, usage: 6 }
export const RED_ROAD_WORDS: Readonly<Record<RedRoadVerdict, string>> = { product: 'PRODUCT DEFECT', stale: 'STALE LAW', run: 'RUN', hosted: 'HOSTED-ONLY', unsure: 'CANNOT TELL' }
export const RED_ROAD_SEVERITY: readonly RedRoadVerdict[] = ['product', 'stale', 'unsure', 'hosted', 'run']
export const RED_ROAD_USAGE =
  "usage: bun run scripts/jev/red-road.ts <prover|suite> <log> [--row '<results.tsv row>'] [--rc N] [--secs N] [--tree <dir>] [--no-rerun] [--rerun-log <path> --rerun-rc N] [--rerun-cache <dir>] [--load-ceiling 10] [--load-wait 900] [--rerun-ceiling 1800] [--since <date>] [--width <words>] [--load-then <1/5/15>] [--hosted] [--receipt <path>] [--floor 0.6] [--home <config home>] [--json] [-- <rerun command...>]"

export const RED_ROAD_QUESTION: JevEvalInput['questions'][number] = {
  id: 'class',
  kind: 'choice',
  ask: 'One failing check of one prover. `expected` is the check\'s words and the prover source lines that make it. `shown` is what the log or the screen read where it failed. `changed` is what changed on the product lines the check reads since the last release, against the commit that last touched the check. `run` is the original run\'s exit code, wall and kill or starvation signatures. `load` is the machine load and the width of that run. `rerun` is the same prover run again alone in a fresh home at low load: its exit code, whether this same check failed again, and its last lines. Which one class explains this red?',
  options: {
    product: 'a product defect: the product answered with the wrong words, rows, timing or state; the same check fails again in `rerun` alone at low load, and `changed` shows no product change to the words the check reads after the check was last touched',
    stale: 'a stale law: the check\'s expectation is out of date; `changed` shows the product line it reads changed after the check was last touched, or the words it wants no longer exist in the product, so the same check fails again in `rerun` while the product is right',
    run: 'the run, not the tree: load, a kill from outside (exit 137 or 143, a suite ceiling, a tree-kill), a fixture collision (a port in use, a shared scratch), or a capture that never settled or never delivered its sends; `rerun` alone at low load went green or failed a different check',
    hosted: 'hosted-only: the platform, not the tree; the failure names something specific to the hosted Linux runner (a path, a directory or a tool absent there) and `rerun` on this box went green',
  },
  allow_none: true,
  none_means: 'the evidence decides none of these',
}
export const RED_ROAD_REAL_QUESTION: JevEvalInput['questions'][number] = {
  id: 'real',
  kind: 'noul',
  ask: 'This red is the tree\'s own — a product defect or a stale law: the same check fails again when the prover runs alone at low load, as `rerun` shows when it ran — and not the run\'s (load, a kill from outside, a fixture collision, a capture that never settled or never delivered its sends) and not the hosted platform\'s.',
}
export const RED_ROAD_QUESTIONS: JevEvalInput['questions'] = [RED_ROAD_REAL_QUESTION, RED_ROAD_QUESTION]

const KILL_SIGNATURE = /(\bKilled\b|SIGKILL|SIGTERM|\bterminated\b|__SUITE_TIMEOUT|\bTIMEOUT\b|tree-kill|out of memory|\bOOM\b|rc=13[47]|rc=143|KILLED)/i
const STARVE_SIGNATURE = /(capture deadline exceeded|never settled|UNDELIVERED-SENDS|UNFIRED-SENDS|first stuck|exit=null|slot (?:wait|queue)|waiting for a slot|zero frames|frames: 0|never painted|never exited|last frame EMPTY|could not run|NEVER-READY|EADDRINUSE|port \d+ in use)/i
const FIXTURE_SIGNATURE = /(EADDRINUSE|port \d+ in use|NEVER-READY|capture=3|exit 3\b|UNDELIVERED-SENDS|UNFIRED-SENDS|first stuck|never became due|ENAMETOOLONG|socket path)/i
const VERDICT_LINE = /(\d+\s*(?:\/|of)\s*\d+ checks? (?:passed|failed)|checks? (?:passed|failed)|\bFAILED\b|\bGREEN\b|── .* rc=\d+|^rc=\d+|all checks pass)/i
const CLOSE_MARK = /^── (scripts\/\S+|\S+\.(?:ts|py|sh|mjs))\s+(\d+)s rc=(\d+)/
const OPEN_MARK = /^── (scripts\/\S+\.(?:ts|py|sh|mjs))\s*$/
const SUMMARY_LINE = /(SUITE RED|\bRED\b\s*(?:\(|—|$)|check\(s\) failed|failure\(s\)|PROOF\(S\) FAILED|leg\(s\) red|CHECK\(S\) FAILED|\d+ of \d+ checks|\d+\/\d+ checks)/i
const SIGNALS: Readonly<Record<number, string>> = { 129: 'SIGHUP', 130: 'SIGINT', 131: 'SIGQUIT', 134: 'SIGABRT', 137: 'SIGKILL', 139: 'SIGSEGV', 141: 'SIGPIPE', 143: 'SIGTERM' }
const SIGNAL_CODES: Readonly<Record<string, number>> = { SIGHUP: 129, SIGINT: 130, SIGQUIT: 131, SIGABRT: 134, SIGKILL: 137, SIGSEGV: 139, SIGPIPE: 141, SIGTERM: 143 }
const PINNED_BASES = [
  'ANTHROPIC_BASE_URL',
  'MERCURY_ANTHROPIC_OAUTH_BASE',
  'MERCURY_OPENAI_API_BASE',
  'MERCURY_OPENAI_AUTH_BASE',
  'MERCURY_OPENAI_CHATGPT_BASE',
  'MERCURY_OPENROUTER_API_BASE',
  'MERCURY_OPENROUTER_AUTH_BASE',
  'MERCURY_GEMINI_API_BASE',
  'MERCURY_GEMINI_OAUTH_AUTH_BASE',
  'MERCURY_GEMINI_OAUTH_TOKEN_BASE',
  'MERCURY_MOONSHOT_API_BASE',
  'MERCURY_MOONSHOT_OAUTH_BASE',
  'MERCURY_MOONSHOT_CODING_BASE',
  'MERCURY_ZAI_API_BASE',
  'MERCURY_DEEPSEEK_API_BASE',
  'MERCURY_JEV_BASE',
  'MERCURY_HUGGINGFACE_API_BASE',
  'MERCURY_HUGGINGFACE_HUB_BASE',
  'MERCURY_NPM_REGISTRY_BASE',
  'MERCURY_UPDATE_API_BASE_URL',
]

export interface RedRoadRun {
  rc: number | null
  secs: number | null
  hangSecs: number | null
  retry: { rc: number; secs: number } | null
}
export interface RedRoadSection {
  prover: string
  rc: number | null
  secs: number | null
  lines: string[]
  killed: boolean
}
export interface RedRoadCheck {
  label: string
  core: string
  line: string
  at: number
  kind: 'check' | 'threw' | 'killed' | 'silent' | 'overflow'
  repeats: number
}
export interface RedRoadSource {
  found: boolean
  where: string
  line?: number
  lines: string[]
}
export interface RedRoadRerun {
  rc: number
  secs: number
  loadStart: string
  loadEnd: string
  waited: number
  sameFail: boolean | null
  again: string[]
  tail: string
  log: string
  command: string
  where: string
  ceilingHit: boolean
  supplied: boolean
}
export interface RedRoadNoRerun {
  skipped: string
}
export interface RedRoadCheckVerdict {
  label: string
  verdict: RedRoadVerdict
  choice: string
  p: number
  confidence: number
  probabilities: Record<string, number>
}
export interface RedRoadProverVerdict {
  prover: string
  rc: number | null
  verdict: RedRoadVerdict
  checks: RedRoadCheckVerdict[]
  rerun: RedRoadRerun | RedRoadNoRerun | 'skipped' | null
  unavailable?: string
}

export function signalWords(rc: number | null): string {
  if (rc === null || rc <= 128) return 'no signal'
  return `${SIGNALS[rc] ?? `signal ${rc - 128}`} (${rc - 128})`
}

export function clipLine(line: string, clip: number = RED_ROAD_LINE_CLIP): string {
  return line.length > clip ? `${line.slice(0, clip - 1)}…` : line
}

export function parseResultsRow(row: string): { rc: number | null; secs: number | null; retry: { rc: number; secs: number } | null } {
  const cells = row.includes('\t') ? row.split('\t') : row.trim().split(/\s+/)
  const int = (cell: string | undefined): number | null => (cell !== undefined && /^\d+$/.test(cell.trim()) ? Number(cell.trim()) : null)
  const rc = int(cells[2])
  const secs = int(cells[3])
  const retryRc = int(cells[4])
  const retrySecs = int(cells[5])
  return { rc, secs, retry: retryRc === null ? null : { rc: retryRc, secs: retrySecs ?? 0 } }
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][A-Za-z0-9]/g

export function plainLines(logText: string): string[] {
  const lines = logText.replace(/\r/g, '').replace(ANSI, '').split('\n')
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop()
  return lines
}

export function redRoadSections(logText: string, prover: string, run: RedRoadRun): RedRoadSection[] {
  const lines = plainLines(logText)
  const sections: RedRoadSection[] = []
  let start = 0
  for (let at = 0; at < lines.length; at++) {
    const close = lines[at]!.match(CLOSE_MARK)
    if (close === null) continue
    sections.push({ prover: close[1]!, rc: Number(close[3]), secs: Number(close[2]), lines: lines.slice(start, at + 1), killed: false })
    start = at + 1
  }
  const rest = lines.slice(start)
  const killed = rest.some(line => /__SUITE_TIMEOUT|tree-killed/.test(line))
  if (sections.length === 0) return [{ prover, rc: run.rc, secs: run.secs, lines, killed: killed || (run.rc !== null && run.rc > 128) }]
  const redRun = run.rc !== null && run.rc !== 0
  if (killed || (redRun && rest.some(line => OPEN_MARK.test(line)))) {
    const open = rest.map(line => line.match(OPEN_MARK)).filter(m => m !== null).at(-1)
    sections.push({ prover: open?.[1] ?? `${prover} (running at the kill)`, rc: run.rc ?? 137, secs: null, lines: rest, killed: true })
  } else if (redRun && !sections.some(section => section.rc !== 0)) {
    sections.push({ prover: `${prover} (the suite's own tail: red rc=${run.rc} with every prover mark green)`, rc: run.rc, secs: run.secs, lines: rest.length > 0 ? rest : lines, killed: false })
  }
  return sections
}

export function coreLabel(label: string): string {
  return label.replace(/^[\w×x./-]+:\s+/, '').trim()
}

export function redRoadChecks(section: RedRoadSection): RedRoadCheck[] {
  const found: RedRoadCheck[] = []
  const seen = new Map<string, RedRoadCheck>()
  const push = (check: RedRoadCheck): void => {
    const known = seen.get(check.core)
    if (known !== undefined) {
      known.repeats++
      return
    }
    seen.set(check.core, check)
    found.push(check)
  }
  const lines = section.lines
  for (let at = 0; at < lines.length; at++) {
    const raw = lines[at]!
    const text = raw.trimStart()
    let label: string | undefined
    let kind: RedRoadCheck['kind'] = 'check'
    if (/^\[FAIL\]\s*/.test(text)) label = text.replace(/^\[FAIL\]\s*/, '')
    else if (/^✗\s*/.test(text)) label = text.replace(/^✗\s*/, '')
    else if (/^FAIL\b[:\s]+/.test(text)) label = text.replace(/^FAIL\b[:\s]+/, '')
    else if (/^❌\s*/.test(text) && !SUMMARY_LINE.test(text)) label = text.replace(/^❌\s*/, '')
    else if (/^error:\s*/.test(text) && !/^error: script "/.test(text)) {
      label = `the prover threw: ${text.replace(/^error:\s*/, '')}`
      kind = 'threw'
    } else if (/__SUITE_TIMEOUT|tree-killed/.test(text)) {
      label = `killed by the suite ceiling: ${text.replace(/_+$/, '').replace(/^_+/, '')}`
      kind = 'killed'
    }
    if (label === undefined) continue
    const words = label.split(/\s+—\s+/)[0]!.trim()
    push({ label: clipLine(words, RED_ROAD_FAIL_LINE_CLIP), core: kind === 'check' ? coreLabel(words) : words, line: clipLine(raw, RED_ROAD_FAIL_LINE_CLIP), at, kind, repeats: 1 })
  }
  if (found.length === 0 && (section.rc === null || section.rc !== 0)) {
    const rc = section.rc ?? 'unknown'
    found.push({ label: `ended rc=${rc} with no failing check line`, core: `ended rc=${rc} with no failing check line`, line: lines.at(-1) ?? '', at: Math.max(0, lines.length - 1), kind: 'silent', repeats: 1 })
  }
  if (found.length <= RED_ROAD_CHECK_LIMIT) return found
  const kept = found.slice(0, RED_ROAD_CHECK_LIMIT - 1)
  const rest = found.slice(RED_ROAD_CHECK_LIMIT - 1)
  const names = rest.map(c => c.core).join(' | ')
  kept.push({ label: `${rest.length} more failing checks in this prover, read together: ${clipLine(names, RED_ROAD_FAIL_LINE_CLIP * 2)}`, core: `${rest.length} more failing checks`, line: rest[0]!.line, at: rest[0]!.at, kind: 'overflow', repeats: rest.reduce((n, c) => n + c.repeats, 0) })
  return kept
}

export function labelCandidates(core: string): string[] {
  const out: string[] = []
  const add = (s: string): void => {
    const t = s.trim()
    if (t.length >= 8 && !out.includes(t)) out.push(t)
  }
  add(core)
  add(core.replace(/\s*\(.*\)\s*$/, ''))
  add(core.split(/[;:]/)[0]!)
  const words = core.split(/\s+/)
  for (let width = Math.min(8, words.length); width >= 4; width--) {
    for (let from = 0; from + width <= words.length; from++) add(words.slice(from, from + width).join(' '))
  }
  return out
}

const KEYWORDS = new Set(['const', 'let', 'var', 'if', 'else', 'return', 'await', 'async', 'function', 'true', 'false', 'null', 'undefined', 'new', 'typeof', 'import', 'export', 'from', 'check', 'test', 'expect', 'process', 'env', 'console', 'log', 'String', 'Number', 'JSON', 'stringify', 'length', 'join', 'some', 'every', 'includes', 'test', 'map', 'filter', 'rows', 'row', 'lines', 'line', 'frame', 'frames', 'r', 'l', 'x', 'i'])

export function constantLines(proverText: string, windowText: string): string[] {
  const names = new Set((windowText.match(/\b[A-Za-z_$][\w$]*\b/g) ?? []).filter(name => !KEYWORDS.has(name)))
  const out: string[] = []
  const lines = proverText.split('\n')
  for (const name of names) {
    const pattern = new RegExp(`^\\s*(?:export )?const ${name.replace(/\$/g, '\\$')}\\s*=\\s*(?:['"\`]|\\/)`)
    const at = lines.findIndex(line => pattern.test(line))
    if (at >= 0) out.push(`${at + 1}: ${clipLine(lines[at]!)}`)
    if (out.length >= RED_ROAD_NEEDLE_LIMIT) break
  }
  return out
}

export function redRoadSource(check: RedRoadCheck, proverText: string | undefined, proverPath: string): RedRoadSource {
  if (check.kind !== 'check') return { found: false, where: `no check line to find (${check.kind})`, lines: [] }
  if (proverText === undefined) return { found: false, where: `${proverPath} is not on this tree`, lines: [] }
  const lines = proverText.split('\n')
  for (const candidate of labelCandidates(check.core)) {
    const at = lines.findIndex(line => line.includes(candidate))
    if (at < 0) continue
    const from = Math.max(0, at - RED_ROAD_SOURCE_BEFORE)
    const to = Math.min(lines.length, at + RED_ROAD_SOURCE_AFTER + 1)
    const window = lines.slice(from, to)
    const constants = constantLines(proverText, window.join('\n')).filter(line => Number(line.split(':')[0]) <= from || Number(line.split(':')[0]) > to)
    return { found: true, where: `${proverPath}:${at + 1}`, line: at + 1, lines: [...constants, ...window.map((line, index) => `${from + index + 1}: ${clipLine(line)}`)] }
  }
  return { found: false, where: `${proverPath}: no line carries the check's words`, lines: [] }
}

const REGEX_LEAD = /[(,=:[!&|?{};]\s*$/

export function stringLiterals(text: string): string[] {
  const out: string[] = []
  let at = 0
  const take = (value: string): void => {
    if (value !== '') out.push(value)
  }
  while (at < text.length) {
    const ch = text[at]!
    if (ch === "'" || ch === '"') {
      let end = at + 1
      let value = ''
      while (end < text.length && text[end] !== ch && text[end] !== '\n') {
        if (text[end] === '\\') {
          value += text[end + 1] ?? ''
          end += 2
        } else value += text[end++]
      }
      if (text[end] === ch) take(value)
      at = end + 1
      continue
    }
    if (ch === '`') {
      let end = at + 1
      let value = ''
      let depth = 0
      while (end < text.length) {
        const c = text[end]!
        if (depth === 0 && c === '`') break
        if (c === '\\') {
          value += text[end + 1] ?? ''
          end += 2
          continue
        }
        if (depth === 0 && c === '$' && text[end + 1] === '{') {
          depth = 1
          end += 2
          value += '\u0000'
          continue
        }
        if (depth > 0) {
          if (c === '}') depth--
          else if (c === '{') depth++
          end++
          continue
        }
        value += c
        end++
      }
      for (const part of value.split('\u0000')) take(part)
      at = end + 1
      continue
    }
    if (ch === '/' && text[at + 1] === '/') {
      const eol = text.indexOf('\n', at)
      if (eol < 0) break
      at = eol
      continue
    }
    if (ch === '/' && text[at + 1] !== '*' && REGEX_LEAD.test(text.slice(Math.max(0, at - 24), at))) {
      let end = at + 1
      let inClass = false
      while (end < text.length && text[end] !== '\n' && (inClass || text[end] !== '/')) {
        if (text[end] === '\\') end++
        else if (text[end] === '[') inClass = true
        else if (text[end] === ']') inClass = false
        end++
      }
      if (text[end] === '/') {
        const plain = text.slice(at + 1, end).replace(/\\[dwsbDWSB]/g, '\u0001').replace(/\\(.)/g, '$1').replace(/[\u0001^$*+?()[\]{}|]/g, '\u0001')
        const run = plain.split('\u0001').map(s => s.trim()).sort((a, b) => b.length - a.length)[0]
        if (run !== undefined) take(run)
        at = end + 1
        continue
      }
    }
    at++
  }
  return out
}

export function redRoadNeedles(sourceLines: readonly string[], core: string): string[] {
  const text = sourceLines.map(line => line.replace(/^\d+: /, '')).join('\n')
  const needles = new Map<string, number>()
  for (const literal of stringLiterals(text)) {
    const trimmed = literal.trim()
    if (trimmed.length < 3 || core.includes(trimmed) || trimmed.includes(core)) continue
    if ((trimmed.match(/[\p{L}\p{N}]/gu) ?? []).length < 3) continue
    if (/^[\w./-]+\/[\w./-]+$/.test(trimmed) || /^(utf8|utf-8|true|false|null|undefined|PASS|FAIL)$/i.test(trimmed) || /^\[?(PASS|FAIL)\]?\s/.test(trimmed)) continue
    needles.set(trimmed, Math.max(needles.get(trimmed) ?? 0, trimmed.length))
  }
  return [...needles.entries()].sort((a, b) => b[1] - a[1]).map(([needle]) => needle).slice(0, RED_ROAD_NEEDLE_LIMIT)
}

function git(tree: string, args: readonly string[]): string {
  const result = spawnSync('git', ['-C', tree, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  return result.status === 0 ? (result.stdout ?? '').trim() : ''
}

export function gitSince(tree: string): string {
  const tag = git(tree, ['tag', '--sort=-v:refname']).split('\n')[0] ?? ''
  if (tag !== '') {
    const date = git(tree, ['log', '-1', '--format=%aI', tag])
    if (date !== '') return `${date} (tag ${tag})`
  }
  return `${new Date(Date.now() - 30 * 86_400_000).toISOString()} (no tag; 30 days)`
}

export interface RedRoadPin {
  sha: string
  at: string
  words: string
}

export function checkPin(tree: string, proverPath: string, line: number | undefined): RedRoadPin | undefined {
  const blame = line === undefined ? '' : git(tree, ['blame', '--porcelain', '-L', `${line},${line}`, 'HEAD', '--', proverPath])
  const sha = blame.split('\n')[0]?.split(' ')[0] ?? ''
  const shown = /^[0-9a-f]{40}$/.test(sha) && !/^0{40}$/.test(sha) ? git(tree, ['log', '-1', '--format=%h %aI %s', sha]) : git(tree, ['log', '-1', '--format=%h %aI %s', 'HEAD', '--', proverPath])
  if (shown === '') return undefined
  const [short, at, ...rest] = shown.split(' ')
  return { sha: short ?? '', at: at ?? '', words: `${short} ${(at ?? '').slice(0, 10)} ${rest.join(' ')}${line !== undefined && /^[0-9a-f]{40}$/.test(sha) && !/^0{40}$/.test(sha) ? ` (the check's own line ${line})` : ' (the file)'}` }
}

interface NeedleHistory {
  hits: string[]
  commits: { sha: string; at: string; words: string }[]
}

export function safeNeedle(needle: string): boolean {
  return needle.length > 0 && needle.length <= 200 && !/[\u0000-\u001f\u007f]/.test(needle) && !needle.startsWith('-')
}

function needleHistory(tree: string, needle: string, sinceDate: string, cache: Map<string, NeedleHistory>): NeedleHistory {
  const key = `${tree}\u0000${sinceDate}\u0000${needle}`
  const kept = cache.get(key)
  if (kept !== undefined) return kept
  const hits = git(tree, ['grep', '-n', '-F', '--', needle, '--', 'src']).split('\n').filter(l => l !== '').slice(0, 3)
  const commits = git(tree, ['log', `-S${needle}`, `--since=${sinceDate}`, '--format=%h %aI %s', 'HEAD', '--', 'src'])
    .split('\n')
    .filter(l => l !== '')
    .slice(0, 6)
    .map(line => {
      const [sha, at, ...rest] = line.split(' ')
      return { sha: sha ?? '', at: at ?? '', words: `${sha} ${(at ?? '').slice(0, 10)} ${rest.join(' ')}` }
    })
  const history = { hits, commits }
  cache.set(key, history)
  return history
}

export function redRoadChanged(tree: string, proverPath: string, line: number | undefined, needles: readonly string[], since: string, cache: Map<string, NeedleHistory>): string {
  const sinceDate = since.split(' ')[0]!
  const pin = checkPin(tree, proverPath, line)
  const head = pin === undefined ? `the check's pin: ${proverPath} has no commit on this tree` : `the check's pin was last touched ${pin.words}`
  const usable = needles.filter(safeNeedle)
  if (usable.length === 0) return `${head}\nno product needle could be read from the check's source lines`
  const rows: string[] = [head, `since ${since}:`]
  for (const needle of usable) {
    const history = needleHistory(tree, needle, sinceDate, cache)
    const after = pin === undefined ? [] : history.commits.filter(c => c.at > pin.at && c.sha !== pin.sha)
    const reads = history.hits.length === 0 ? 'not in src/ (the product does not carry these words)' : `reads ${history.hits.map(h => clipLine(h, 160)).join(' | ')}`
    const moved = history.commits.length === 0 ? 'no product commit touches these words' : `product commits touching these words: ${history.commits.map(c => c.words).join(' ; ')}${after.length > 0 ? ` — ${after.length} AFTER the check's pin (STALE LAW candidate: ${after.map(c => c.sha).join(', ')} vs pin ${pin!.sha})` : " — none after the check's pin"}`
    rows.push(`"${clipLine(needle, 80)}" → ${reads}; ${moved}`)
  }
  return rows.join('\n')
}

export function readLoad(): { one: number; words: string } {
  const result = spawnSync('uptime', { encoding: 'utf8' })
  const text = (result.stdout ?? '').trim()
  const m = text.match(/load averages?:\s*([\d.]+),?\s+([\d.]+),?\s+([\d.]+)/)
  if (m === null) return { one: 0, words: text || 'uptime unavailable' }
  return { one: Number(m[1]), words: `${m[1]} ${m[2]} ${m[3]}` }
}

function sleep(ms: number): Promise<void> {
  return new Promise(done => setTimeout(done, ms))
}

export async function waitForLoad(ceiling: number, maxWaitSecs: number, poll: () => { one: number; words: string } = readLoad, pause: (ms: number) => Promise<void> = sleep): Promise<{ load: { one: number; words: string }; waited: number; expired: boolean }> {
  let waited = 0
  let load = poll()
  while (load.one > ceiling && waited < maxWaitSecs) {
    await pause(RED_ROAD_LOAD_POLL_SECS * 1000)
    waited += RED_ROAD_LOAD_POLL_SECS
    load = poll()
  }
  return { load, waited, expired: load.one > ceiling }
}

export function proverCommand(prover: string): string[] {
  if (prover.endsWith('.py')) return ['python3', prover]
  if (prover.endsWith('.sh')) return ['bash', prover]
  if (!prover.includes('/') && !prover.includes('.')) return ['bash', `scripts/${prover}/run-all.sh`]
  return [process.execPath, 'run', prover]
}

export function redRoadScratch(env: NodeJS.ProcessEnv = process.env): string {
  const pinned = env.TMPDIR?.trim()
  return resolve(pinned !== undefined && pinned !== '' ? pinned : tmpdir())
}

function scratchHome(root: string): string {
  mkdirSync(root, { recursive: true })
  return mkdtempSync(join(root, RED_ROAD_HOME_PREFIX))
}

const SECRET_ENV = /(_API_KEY|_AUTH_TOKEN|_ACCESS_TOKEN|_REFRESH_TOKEN|_TOKEN|_SECRET|_PASSWORD|_PASSPHRASE|_CREDENTIALS?|_COOKIE|_SESSION_KEY)$/i
const CARRIED_ENV = ['MERCURY_HOME', 'MERCURY_API_UNIX_SOCKET', 'MERCURY_API_BASE', 'MERCURY_PROXY', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NODE_EXTRA_CA_CERTS', 'SSH_AUTH_SOCK', 'GH_TOKEN', 'GITHUB_TOKEN', 'HF_TOKEN', 'AWS_PROFILE', 'GOOGLE_APPLICATION_CREDENTIALS']

export function scrubbedEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(source)) {
    if (SECRET_ENV.test(name) || CARRIED_ENV.includes(name)) continue
    env[name] = value
  }
  return env
}

function rerunEnv(tree: string, home: string, root: string): NodeJS.ProcessEnv {
  const env = scrubbedEnv(process.env)
  env.MERCURY_CONFIG_DIR = home
  env.MERCURY_CREDENTIAL_STORE = 'file'
  env.ANTHROPIC_API_KEY = RED_ROAD_PROOF_KEY
  env.TMPDIR = root
  env.VSHOT_SLOTS = '999'
  env.MERCURY_VSHOT_BUDGET_SCALE = '1'
  env.MERCURY_GATE_PREBUILT = '1'
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.GIT_AUTHOR_NAME = 'mercury-gate'
  env.GIT_AUTHOR_EMAIL = 'gate@mercury.invalid'
  env.GIT_COMMITTER_NAME = 'mercury-gate'
  env.GIT_COMMITTER_EMAIL = 'gate@mercury.invalid'
  for (const name of PINNED_BASES) env[name] = RED_ROAD_DEAD_BASE
  const seeder = join(tree, 'scripts', 'lib', 'firstRunSeed.ts')
  if (existsSync(seeder)) spawnSync(process.execPath, ['run', seeder, home, tree], { cwd: tree, env, encoding: 'utf8' })
  return env
}

export async function rerunProver(command: readonly string[], tree: string, log: string, ceilingSecs: number, loadCeiling: number, loadWaitSecs: number, checks: readonly RedRoadCheck[]): Promise<RedRoadRerun | RedRoadNoRerun> {
  const waited = await waitForLoad(loadCeiling, loadWaitSecs)
  if (waited.expired) return { skipped: `the 1-minute load stayed above ${loadCeiling} for ${waited.waited}s (${waited.load.words}); no solo rerun was admitted, so nothing here was measured alone at low load` }
  const root = redRoadScratch()
  const home = scratchHome(root)
  const env = rerunEnv(tree, home, root)
  const started = Date.now()
  const child = spawn(command[0]!, command.slice(1), { cwd: tree, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  let output = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    output += chunk
  })
  child.stderr.on('data', (chunk: string) => {
    output += chunk
  })
  let ceilingHit = false
  const timer = setTimeout(() => {
    ceilingHit = true
    if (!killGroup(child.pid)) child.kill('SIGKILL')
  }, ceilingSecs * 1000)
  const rc = await new Promise<number>(done => {
    child.on('error', error => {
      output += `\n${error.message}\n`
      done(127)
    })
    child.on('close', (code, signal) => done(code ?? (signal ? (SIGNAL_CODES[signal] ?? 128) : 127)))
  })
  clearTimeout(timer)
  killGroup(child.pid)
  const secs = Math.round((Date.now() - started) / 1000)
  if (ceilingHit) output += `\n__RED_ROAD_CEILING after ${ceilingSecs}s (the road's own rerun ceiling; tree-killed)__\n`
  writeFileSync(log, output)
  return rerunRecord(output, rc, secs, ceilingHit, checks, { log, command: wireCommand(command), where: `in ${tree}; home ${home}`, loadStart: `${waited.load.words}${waited.waited > 0 ? ` (waited ${waited.waited}s for the 1-minute load to fall under ${loadCeiling})` : ''}`, loadEnd: readLoad().words, waited: waited.waited, supplied: false })
}

function killGroup(pid: number | undefined): boolean {
  if (pid === undefined) return false
  try {
    process.kill(-pid, 'SIGKILL')
    return true
  } catch {
    return false
  }
}

export function wireCommand(command: readonly string[]): string {
  return command.map((word, index) => (index === 0 ? basename(word) : word)).join(' ')
}

export function rerunRecord(output: string, rc: number, secs: number, ceilingHit: boolean, checks: readonly RedRoadCheck[], facts: Pick<RedRoadRerun, 'log' | 'command' | 'where' | 'loadStart' | 'loadEnd' | 'waited' | 'supplied'>): RedRoadRerun {
  const lines = plainLines(output)
  const section: RedRoadSection = { prover: facts.command, rc, secs, lines, killed: ceilingHit }
  const again = rc === 0 ? [] : redRoadChecks(section).map(c => c.core)
  const sameFail = rc === 0 ? false : checks.some(c => again.includes(c.core))
  const tail = lines.filter(l => l.trim() !== '').slice(-RED_ROAD_RERUN_TAIL_LINES).map(l => clipLine(l)).join('\n')
  return { rc, secs, sameFail, again, tail, ceilingHit, ...facts }
}

export function rerunWords(rerun: RedRoadRerun | RedRoadNoRerun | 'skipped' | null, check: RedRoadCheck): string {
  if (rerun === null) return 'not rerun'
  if (rerun === 'skipped') return 'not rerun (a dry pass: --no-rerun)'
  if ('skipped' in rerun) return `not rerun: ${rerun.skipped}`
  const same = rerun.rc === 0 ? 'green: no check failed' : rerun.again.includes(check.core) ? `this same check failed again (${check.core.slice(0, 60)}…)` : rerun.again.length > 0 ? `not this check; the rerun failed ${rerun.again.length} other check(s): ${clipLine(rerun.again.join(' | '), 200)}` : 'not this check; the rerun ended red without a failing check line'
  const how = rerun.supplied ? 'the caller\'s own rerun (its home and load are the caller\'s, not measured here)' : 'alone, in a fresh scratch home, every provider base pinned to the box'
  return [`${rerun.command} — ${how}`, `rc=${rerun.rc} (${signalWords(rerun.rc)}) in ${rerun.secs}s${rerun.ceilingHit ? ' — killed by the road\'s own ceiling' : ''}`, `1/5/15 load at start ${rerun.loadStart}; at end ${rerun.loadEnd}`, `same check again: ${same}`, `last lines:`, rerun.tail].join('\n')
}

export interface RedRoadItem {
  id: string
  expected: string
  shown: string
  changed: string
  run: string
  load: string
  rerun: string
}

const ABSOLUTE_PATHS: readonly [RegExp, string][] = [
  [/\/private\/var\/folders\/[^\s'"`]*?\/T\b/g, '<tmp>'],
  [/\/var\/folders\/[^\s'"`]*?\/T\b/g, '<tmp>'],
  [/\/private\/tmp\/mw\b/g, '<scratch>'],
  [/\/private\/tmp\b/g, '<tmp>'],
  [/\/tmp\b/g, '<tmp>'],
  [/\/(?:Users|home)\/[^\s/'"`]+/g, '~'],
]

export function redactPaths(text: string, roots: readonly string[] = [redRoadScratch()]): string {
  let out = text
  for (const [pattern, word] of ABSOLUTE_PATHS) out = out.replace(pattern, word)
  for (const root of roots) {
    if (root === '' || root === '/') continue
    out = out.split(root.replace(/\/+$/, '')).join('<scratch>')
  }
  return out
}

export function wireItem(item: RedRoadItem): Record<string, string> {
  const { id, ...facts } = item
  void id
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(facts)) out[name] = redactPaths(value)
  return out
}

export function fixtureWords(section: RedRoadSection): string | undefined {
  const hit = section.lines.map(line => line.match(FIXTURE_SIGNATURE)).find(m => m !== null)
  return hit === undefined || hit === null ? undefined : hit[1]
}

export function runWords(section: RedRoadSection, run: RedRoadRun, hosted: boolean): string {
  const rc = section.rc
  const closing = section.lines.slice(-5).some(line => VERDICT_LINE.test(line))
  const matched = section.lines.filter(line => KILL_SIGNATURE.test(line) || STARVE_SIGNATURE.test(line)).map(l => clipLine(l))
  const box = section.lines.find(line => /^\s*box: /.test(line))?.trim()
  return [
    `exit code ${rc ?? 'unknown'} · ${signalWords(rc)} · wall ${section.secs === null ? 'unknown' : `${section.secs}s`} · tree-kill sidecar ${run.hangSecs === null ? 'absent' : `present (${run.hangSecs}s)`} · own verdict line ${closing ? 'present' : 'absent'} · ${section.lines.length} lines${section.killed ? ' · the prover was still running when the suite was killed' : ''}${run.retry === null ? '' : ` · the harness's own retry ended rc ${run.retry.rc} in ${run.retry.secs}s`}`,
    `where it ran: ${hosted ? 'the hosted Linux runner (the log is from the hosted run; the rerun below is on this box)' : box ?? 'this box (local)'}`,
    `kill or starvation signatures: ${matched.length === 0 ? 'none matched' : matched.slice(-12).join('\n')}`,
  ].join('\n')
}

export function shownWords(section: RedRoadSection, check: RedRoadCheck): string {
  const from = check.kind === 'overflow' ? check.at : Math.max(0, check.at - RED_ROAD_SHOWN_BEFORE)
  const to = Math.min(section.lines.length, check.at + RED_ROAD_SHOWN_AFTER + 1)
  const rows = section.lines.slice(from, to).map((line, index) => (from + index === check.at ? `>> ${clipLine(line, RED_ROAD_FAIL_LINE_CLIP)}` : `   ${clipLine(line)}`))
  return `${check.repeats > 1 ? `this check failed ${check.repeats} times in the run (sizes or legs); the first:\n` : ''}${rows.join('\n')}`
}

function sidecar(log: string, ext: string): number | null {
  const stem = basename(log).replace(/\.[^.]+$/, '')
  const path = join(dirname(log), `${stem}.${ext}`)
  if (!existsSync(path)) return null
  const text = readFileSync(path, 'utf8').trim()
  return /^\d+$/.test(text) ? Number(text) : null
}

export function redRoadSide(answer: JevChoiceAnswer, real: number, floor: number): 'real' | 'flake' | 'unsure' {
  const prob = (name: string): number => answer.probabilities[name] ?? 0
  const realMass = prob('product') + prob('stale')
  const flakeMass = prob('run') + prob('hosted')
  if (realMass >= floor && realMass > flakeMass) return 'real'
  if (flakeMass >= floor && flakeMass > realMass) return 'flake'
  if (real >= floor) return 'real'
  if (real <= 1 - floor) return 'flake'
  return 'unsure'
}

export function redRoadCheckVerdict(answer: JevChoiceAnswer | undefined, real: number | undefined, floor: number, label: string): RedRoadCheckVerdict {
  if (answer === undefined || real === undefined) return { label, verdict: 'unsure', choice: answer?.choice ?? 'none', p: real ?? 0, confidence: answer?.confidence ?? 0, probabilities: answer?.probabilities ?? {} }
  const prob = (name: string): number => answer.probabilities[name] ?? 0
  const side = redRoadSide(answer, real, floor)
  let verdict: RedRoadVerdict = 'unsure'
  if (side === 'real') verdict = answer.choice === 'product' || answer.choice === 'stale' ? answer.choice : prob('product') >= prob('stale') ? 'product' : 'stale'
  else if (side === 'flake') verdict = answer.choice === 'run' || answer.choice === 'hosted' ? answer.choice : prob('run') >= prob('hosted') ? 'run' : 'hosted'
  return { label, verdict, choice: answer.choice, p: real, confidence: answer.confidence, probabilities: answer.probabilities }
}

export function redRoadProverVerdict(checks: readonly RedRoadCheckVerdict[]): RedRoadVerdict {
  if (checks.length === 0) return 'unsure'
  let worst = RED_ROAD_SEVERITY.length - 1
  for (const check of checks) worst = Math.min(worst, RED_ROAD_SEVERITY.indexOf(check.verdict))
  return RED_ROAD_SEVERITY[worst]!
}

export function redRoadExit(verdicts: readonly RedRoadVerdict[]): number {
  return RED_ROAD_EXITS[redRoadProverVerdict(verdicts.map(verdict => ({ label: '', verdict, choice: '', p: 0, confidence: 0, probabilities: {} })))]
}

function p2(value: number): string {
  return value.toFixed(2)
}

interface Args {
  prover: string
  log: string
  row?: string
  rc?: number
  secs?: number
  tree: string
  noRerun: boolean
  rerunLog?: string
  rerunRc?: number
  rerunCache?: string
  loadCeiling: number
  loadWait: number
  rerunCeiling: number
  since?: string
  width?: string
  loadThen?: string
  hosted: boolean
  receipt?: string
  floor: number
  home?: string
  json: boolean
  rerun: string[]
}

function parseArgs(argv: readonly string[]): Args | string {
  const positional: string[] = []
  const args: Args = { prover: '', log: '', tree: process.cwd(), noRerun: false, loadCeiling: RED_ROAD_LOAD_CEILING, loadWait: RED_ROAD_LOAD_WAIT_SECS, rerunCeiling: RED_ROAD_RERUN_CEILING_SECS, hosted: false, floor: RED_ROAD_CONFIDENT_FLOOR, json: false, rerun: [] }
  for (let at = 0; at < argv.length; at++) {
    const word = argv[at]!
    const value = (): string | undefined => argv[++at]
    if (word === '--') {
      args.rerun = argv.slice(at + 1)
      break
    } else if (word === '--row') args.row = value()
    else if (word === '--rc') args.rc = Number(value())
    else if (word === '--secs') args.secs = Number(value())
    else if (word === '--tree') args.tree = resolve(value() ?? '.')
    else if (word === '--no-rerun') args.noRerun = true
    else if (word === '--rerun-log') args.rerunLog = value()
    else if (word === '--rerun-rc') args.rerunRc = Number(value())
    else if (word === '--rerun-cache') args.rerunCache = resolve(value() ?? '.')
    else if (word === '--load-ceiling') args.loadCeiling = Number(value())
    else if (word === '--load-wait') args.loadWait = Number(value())
    else if (word === '--rerun-ceiling') args.rerunCeiling = Number(value())
    else if (word === '--since') args.since = value()
    else if (word === '--width') args.width = value()
    else if (word === '--load-then') args.loadThen = value()
    else if (word === '--hosted') args.hosted = true
    else if (word === '--receipt') args.receipt = value()
    else if (word === '--floor') args.floor = Number(value())
    else if (word === '--home') args.home = value()
    else if (word === '--json') args.json = true
    else if (word.startsWith('--')) return `unknown flag ${word}`
    else positional.push(word)
  }
  if (positional.length !== 2) return 'a prover and its log are the two arguments'
  args.prover = positional[0]!
  args.log = resolve(positional[1]!)
  if (!existsSync(args.log)) return `no such log ${args.log}`
  if (!Number.isFinite(args.floor) || args.floor <= 0 || args.floor > 1) return 'the floor is a probability in (0, 1]'
  if (args.rc !== undefined && !Number.isInteger(args.rc)) return '--rc wants a whole number'
  if (args.secs !== undefined && !Number.isInteger(args.secs)) return '--secs wants a whole number'
  if ((args.rerunLog === undefined) !== (args.rerunRc === undefined)) return '--rerun-log and --rerun-rc go together'
  if (args.rerunLog !== undefined && !existsSync(resolve(args.rerunLog))) return `no such rerun log ${args.rerunLog}`
  if (args.rerunRc !== undefined && !Number.isInteger(args.rerunRc)) return '--rerun-rc wants a whole number'
  for (const [name, n] of [['--load-ceiling', args.loadCeiling], ['--load-wait', args.loadWait], ['--rerun-ceiling', args.rerunCeiling]] as const) if (!Number.isFinite(n) || n < 0) return `${name} wants a number`
  return args
}

function suppliedRerun(path: string, rc: number, checks: readonly RedRoadCheck[]): RedRoadRerun {
  return rerunRecord(readFileSync(path, 'utf8'), rc, 0, false, checks, { log: path, command: 'the caller\'s own rerun', where: path, loadStart: 'unrecorded (the caller ran it)', loadEnd: 'unrecorded', waited: 0, supplied: true })
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2))
  if (typeof parsed === 'string') {
    console.error(`${RED_ROAD_USAGE}\n${parsed}`)
    return RED_ROAD_EXITS.usage
  }
  const args = parsed
  const fromRow = args.row === undefined ? null : parseResultsRow(args.row)
  const run: RedRoadRun = {
    rc: fromRow?.rc ?? args.rc ?? sidecar(args.log, 'rc'),
    secs: fromRow?.secs ?? args.secs ?? sidecar(args.log, 'secs'),
    hangSecs: sidecar(args.log, 'hang'),
    retry: fromRow?.retry ?? null,
  }
  const logText = readFileSync(args.log, 'utf8')
  const sections = redRoadSections(logText, args.prover, run).filter(section => section.rc === null || section.rc !== 0)
  const stem = basename(args.log).replace(/\.[^.]+$/, '')
  const receipt = args.receipt !== undefined ? resolve(args.receipt) : join(dirname(args.log), `${stem}.red-road.log`)
  const packagePath = receipt.replace(/\.log$/, '') + '.package.json'
  const since = args.since ?? gitSince(args.tree)
  const treeKey = git(args.tree, ['rev-parse', '--short=9', 'HEAD']) || basename(args.tree)
  const loadNow = readLoad()
  const loadWords = `1/5/15 at the time of the run: ${args.loadThen ?? 'unrecorded in the log'}; width of that run: ${args.width ?? 'unrecorded'}; 1/5/15 now, on the road: ${loadNow.words}`
  const record: Record<string, unknown> = { prover: args.prover, log: args.log, rc: run.rc, secs: run.secs, hangSecs: run.hangSecs, signal: run.rc !== null && run.rc > 128 ? (SIGNALS[run.rc] ?? `signal ${run.rc - 128}`) : null, floor: args.floor, tree: args.tree, since, redProvers: sections.map(s => s.prover) }
  const say = (line: string, exit: number): number => {
    console.log(args.json ? JSON.stringify({ ...record, line, exit }) : line)
    return exit
  }
  if (sections.length === 0) {
    Object.assign(record, { verdict: 'GREEN' })
    return say('GREEN — no red prover in this log (every prover mark reads rc=0)', 0)
  }
  if (args.rerunLog !== undefined && sections.length > 1) return say(`${RED_ROAD_USAGE}\n--rerun-log stands in for one prover; this log carries ${sections.length} red provers`, RED_ROAD_EXITS.usage)
  const cache = new Map<string, NeedleHistory>()
  const provers: RedRoadProverVerdict[] = []
  const items: RedRoadItem[] = []
  const owners: { prover: RedRoadProverVerdict; check: RedRoadCheck }[] = []
  const receiptLines: string[] = [`red road — ${args.prover}`, `log: ${args.log}`, `tree: ${args.tree}`, `run: exit ${run.rc ?? 'unknown'} · wall ${run.secs ?? 'unknown'}s · ${sections.length} red prover(s)`, `stale-law window: since ${since}`, `load: ${loadWords}`, '']
  for (const section of sections) {
    const checks = redRoadChecks(section)
    const proverPath = join(args.tree, section.prover)
    const proverText = existsSync(proverPath) ? readFileSync(proverPath, 'utf8') : undefined
    let rerun: RedRoadRerun | RedRoadNoRerun | 'skipped' | null = 'skipped'
    const proverStem = basename(section.prover).replace(/\.[^.]+$/, '')
    const cached = args.rerunCache === undefined ? undefined : join(args.rerunCache, `${proverStem}.${treeKey}.rerun.json`)
    if (args.rerunLog !== undefined) rerun = suppliedRerun(resolve(args.rerunLog), args.rerunRc!, checks)
    else if (cached !== undefined && existsSync(cached)) {
      const kept = JSON.parse(readFileSync(cached, 'utf8')) as RedRoadRerun
      const fresh = rerunRecord(existsSync(kept.log) ? readFileSync(kept.log, 'utf8') : kept.tail, kept.rc, kept.secs, kept.ceilingHit, checks, { log: kept.log, command: kept.command, where: `${kept.where} (kept from an earlier pass)`, loadStart: kept.loadStart, loadEnd: kept.loadEnd, waited: kept.waited, supplied: false })
      rerun = fresh
    } else if (!args.noRerun) {
      const command = args.rerun.length > 0 ? args.rerun : proverCommand(section.prover)
      const rerunLog = cached !== undefined ? join(args.rerunCache!, `${proverStem}.${treeKey}.rerun.log`) : `${receipt.replace(/\.log$/, '')}.${proverStem}.rerun.log`
      rerun = await rerunProver(command, args.tree, rerunLog, args.rerunCeiling, args.loadCeiling, args.loadWait, checks)
      if (cached !== undefined && !('skipped' in rerun)) writeFileSync(cached, JSON.stringify(rerun, null, 2))
    }
    const prover: RedRoadProverVerdict = { prover: section.prover, rc: section.rc, verdict: 'unsure', checks: [], rerun }
    provers.push(prover)
    receiptLines.push(`── ${section.prover} rc=${section.rc ?? 'unknown'} · ${checks.length} failing check(s)${checks.some(c => c.repeats > 1) ? ` (${checks.reduce((n, c) => n + c.repeats, 0)} rows)` : ''}`)
    if (rerun !== 'skipped' && rerun !== null && 'skipped' in rerun) receiptLines.push(`   rerun: not run — ${rerun.skipped}`)
    else if (rerun !== 'skipped' && rerun !== null) receiptLines.push(`   rerun: ${rerun.command} (${rerun.where})`, `   rerun rc=${rerun.rc} in ${rerun.secs}s · load at start ${rerun.loadStart} · at end ${rerun.loadEnd} · same check again: ${rerun.sameFail === null ? 'unknown' : rerun.sameFail ? 'yes' : 'no'} · log ${rerun.log}`)
    const runText = runWords(section, run, args.hosted)
    for (const check of checks) {
      const source = redRoadSource(check, proverText, section.prover)
      const needles = source.found ? redRoadNeedles(source.lines, check.core) : []
      const changed = source.found ? redRoadChanged(args.tree, section.prover, source.line, needles, since, cache) : `${source.where}; no product line to compare`
      const id = `c${items.length + 1}`
      items.push({
        id,
        expected: `${check.kind === 'check' ? 'the check' : check.kind === 'threw' ? 'the prover threw before its checks' : check.kind === 'killed' ? 'the run was killed from outside' : check.kind === 'overflow' ? 'the rest of the failing checks, beyond the ones sent one by one' : 'the prover ended red without a failing check line'}: ${check.label}\nsource: ${source.where}${source.lines.length > 0 ? `\n${source.lines.join('\n')}` : ''}`,
        shown: shownWords(section, check),
        changed,
        run: runText,
        load: loadWords,
        rerun: rerunWords(rerun, check),
      })
      owners.push({ prover, check })
    }
  }
  writeFileSync(packagePath, JSON.stringify({ prover: args.prover, log: args.log, tree: args.tree, since, question: RED_ROAD_QUESTION, items }, null, 2))
  process.env.MERCURY_CONFIG_DIR = roadHome(args.home)
  const { askJevBatch } = await import('./lib/jevAsk.ts')
  const rows = await askJevBatch(
    items.map(item => ({ id: item.id, evidence: wireItem(item) })),
    RED_ROAD_QUESTIONS,
  )
  let model = ''
  let inputTokens = 0
  let chargeUsd = 0
  const unavailable: string[] = []
  rows.forEach((row, index) => {
    const owner = owners[index]!
    if (!row.ask.ok) {
      owner.prover.checks.push({ label: owner.check.label, verdict: 'unsure', choice: `unavailable: ${row.ask.kind}`, p: 0, confidence: 0, probabilities: {} })
      owner.prover.unavailable = row.ask.words
      unavailable.push(row.ask.words)
      return
    }
    model = row.ask.model
    inputTokens += row.ask.usage.input_tokens
    chargeUsd += row.ask.chargeUsd
    const answer = row.ask.answers.class
    owner.prover.checks.push(redRoadCheckVerdict(answer !== undefined && answer.type === 'choice' ? answer : undefined, row.ask.nouls.real, args.floor, owner.check.label))
  })
  const lines: string[] = []
  for (const prover of provers) {
    prover.verdict = redRoadProverVerdict(prover.checks)
    for (const check of prover.checks) lines.push(`   check: ${RED_ROAD_WORDS[check.verdict]}${check.verdict !== check.choice ? ` (${check.choice})` : ''} real=${p2(check.p)} (${RED_ROAD_CLASSES.map(name => `${name} ${p2(check.probabilities[name] ?? 0)}`).join(' · ')}) conf=${p2(check.confidence)} — ${clipLine(check.label, 120)}`)
    const rerunNote = prover.rerun === 'skipped' || prover.rerun === null ? 'no rerun' : 'skipped' in prover.rerun ? 'no rerun (the load never fell under the ceiling)' : `solo rerun rc=${prover.rerun.rc} in ${prover.rerun.secs}s`
    const fixture = prover.verdict === 'run' ? fixtureWords(sections.find(s => s.prover === prover.prover) ?? { prover: '', rc: null, secs: null, lines: [], killed: false }) : undefined
    lines.push(`prover: ${RED_ROAD_WORDS[prover.verdict]} — ${prover.prover} rc=${prover.rc ?? 'unknown'} · ${prover.checks.length} check(s) · ${rerunNote}${fixture !== undefined ? ` · the run's own words: ${fixture} (a fixture or capture that fails at width; hardening is the prover's, not the product's)` : ''}${prover.unavailable !== undefined ? ` · UNAVAILABLE — ${prover.unavailable}` : ''}`)
  }
  const verdict = redRoadProverVerdict(provers.map(p => ({ label: '', verdict: p.verdict, choice: '', p: 0, confidence: 0, probabilities: {} })))
  const exit = unavailable.length === items.length ? RED_ROAD_EXITS.unavailable : RED_ROAD_EXITS[verdict]
  const head = unavailable.length === items.length ? `UNAVAILABLE — ${unavailable[0]} → a seat with the log` : `${RED_ROAD_WORDS[verdict]} — ${provers.map(p => `${basename(p.prover)} ${RED_ROAD_WORDS[p.verdict]}`).join(' · ')}${verdict === 'run' ? ' → closed as the run, not the tree' : verdict === 'unsure' ? ' → a seat with the log' : ' → a seat with the log and the package'}`
  Object.assign(record, { verdict, model, inputTokens, chargeUsd, provers, receipt, package: packagePath })
  writeFileSync(receipt, [...receiptLines, '', ...lines, '', head, `package: ${packagePath}`, `model ${model || 'none'} · ${inputTokens} input tokens · $${chargeUsd.toFixed(6)}`, ''].join('\n'))
  if (!args.json) for (const line of lines) console.log(line)
  return say(`${head} · receipt ${receipt}`, exit)
}

if (import.meta.main) process.exit(await main())
