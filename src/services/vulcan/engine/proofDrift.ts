import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, realpathSync } from 'node:fs'
import * as path from 'node:path'
import { isEngineInternalPath, parseLsTreeZ, runGit, type EngineTreeFacts } from './frozenTree.js'
import { engineLogErrors, stripEngineAnsi } from './logs.js'
import { engineRunPath, engineRunsDir } from './paths.js'

export type ProofTreeFacts = Pick<EngineTreeFacts, 'commit' | 'baseBlobs' | 'overlay'>

export interface ProofDriftRow {
  kind: 'assertion-removed' | 'assertion-weakened' | 'assertion-changed' | 'assertion-count-decreased' | 'check-count-decreased' | 'script-error-under-pass' | 'evidence-mismatch' | 'drift-unavailable'
  file: string
  line: number | null
  message: string
  before?: string
  after?: string
  beforeCount?: number
  afterCount?: number
  suite?: string
  runId?: string
}

export interface LogicalAssertion {
  line: number
  text: string
  tokens: string[]
}

interface Token {
  value: string
  line: number
  start: number
  end: number
}

function tokensOf(text: string, gd: boolean): Token[] {
  const out: Token[] = []
  let line = 1
  let i = 0
  while (i < text.length) {
    const start = i
    const atLine = line
    const c = text[i]
    if (/\s/.test(c)) {
      if (c === '\n') line++
      i++
      continue
    }
    if ((gd && c === '#') || (!gd && text.startsWith('//', i))) {
      while (i < text.length && text[i] !== '\n') i++
      continue
    }
    if (!gd && text.startsWith('/*', i)) {
      i += 2
      while (i < text.length && !text.startsWith('*/', i)) if (text[i++] === '\n') line++
      i += 2
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = gd && text.startsWith(c.repeat(3), i) ? c.repeat(3) : c
      i += quote.length
      while (i < text.length && !text.startsWith(quote, i)) {
        if (text[i] === '\\') {
          if (text[i + 1] === '\n') line++
          i += 2
        } else if (text[i++] === '\n') line++
      }
      i += quote.length
    } else if (/[A-Za-z_$0-9]/.test(c)) {
      while (i < text.length && /[A-Za-z_$0-9]/.test(text[i])) i++
    } else {
      const op = ['===', '!==', '>=', '<=', '==', '!=', '&&', '||', '=>', '**', '?.'].find(value => text.startsWith(value, i))
      i += op?.length ?? 1
    }
    out.push({ value: text.slice(start, i), line: atLine, start, end: i })
  }
  return out
}

export function logicalAssertions(text: string, file = 'test.gd'): LogicalAssertion[] {
  const tokens = tokensOf(text, file.toLowerCase().endsWith('.gd'))
  const out: LogicalAssertion[] = []
  for (let i = 0; i < tokens.length; i++) {
    if (!/^(?:expect|assert(?:_[A-Za-z0-9_]+)?)$/.test(tokens[i].value)) continue
    if (['func', 'function'].includes(tokens[i - 1]?.value)) continue
    let end = i + 1
    while (tokens[end]?.value === '.' && /^[A-Za-z_$]/.test(tokens[end + 1]?.value ?? '')) end += 2
    if (tokens[end]?.value !== '(') continue
    do {
      let depth = 0
      for (; end < tokens.length; end++) {
        if (tokens[end].value === '(') depth++
        if (tokens[end].value === ')' && --depth === 0) {
          end++
          break
        }
      }
      while (tokens[end]?.value === '.' && /^[A-Za-z_$]/.test(tokens[end + 1]?.value ?? '')) end += 2
    } while (tokens[end]?.value === '(')
    const selected = tokens.slice(i, end)
    out.push({ line: tokens[i].line, text: text.slice(tokens[i].start, selected[selected.length - 1].end).trim(), tokens: selected.map(token => token.value) })
    i = end - 1
  }
  return out
}

export function isProofTestFile(file: string): boolean {
  const lower = file.replace(/\\/g, '/').toLowerCase()
  if (!/\.(?:gd|[cm]?[jt]sx?)$/.test(lower)) return false
  return /(?:^|\/)(?:__tests__|tests?|checks?|suites?|proofs?)(?:\/|[._-])/.test(lower) || /(?:^|\/)(?:test|check|suite|proof|prove)[._-]/.test(lower) || /[._-](?:tests?|checks?|spec|suite|proof)\.(?:gd|[cm]?[jt]sx?)$/.test(lower)
}

function compact(assertion: LogicalAssertion): string {
  return JSON.stringify(assertion.tokens)
}

function sameTokens(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((token, index) => token === b[index])
}

function firstAssertionArgument(assertion: LogicalAssertion): string[] | null {
  if (assertion.tokens[0] !== 'assert' || assertion.tokens[1] !== '(') return null
  const argument: string[] = []
  let depth = 0
  for (const token of assertion.tokens.slice(2)) {
    if (depth === 0 && (token === ')' || token === ',')) break
    if (['(', '[', '{'].includes(token)) depth++
    if ([')', ']', '}'].includes(token)) depth--
    argument.push(token)
  }
  while (argument[0] === '(' && argument[argument.length - 1] === ')') {
    let inner = 0
    const encloses = argument.every((token, index) => {
      if (token === '(') inner++
      if (token === ')') inner--
      return inner > 0 || index === argument.length - 1
    })
    if (!encloses) break
    argument.shift()
    argument.pop()
  }
  return argument
}

function assertionCondition(assertion: LogicalAssertion): string[] | null {
  const argument = firstAssertionArgument(assertion)
  if (argument) return argument
  const tokens = assertion.tokens
  const close = tokens.indexOf(')', 2)
  const op: Record<string, string> = { toBeGreaterThanOrEqual: '>=', toBeGreaterThan: '>', toBeLessThanOrEqual: '<=', toBeLessThan: '<' }
  const operator = op[tokens[close + 2]]
  if (tokens[0] !== 'expect' || tokens[1] !== '(' || close < 3 || tokens[close + 1] !== '.' || typeof operator !== 'string' || tokens[close + 3] !== '(' || tokens[tokens.length - 1] !== ')') return null
  const condition = [...tokens.slice(2, close), operator, ...tokens.slice(close + 4, -1)]
  return comparison(condition) ? condition : null
}

function comparison(tokens: readonly string[]): { subject: string; op: string; bound: number } | null {
  const at = tokens.findIndex(token => ['>=', '>', '<=', '<', '===', '=='].includes(token))
  if (at < 1) return null
  const subject = tokens.slice(0, at)
  if (subject.length % 2 !== 1 || !subject.every((token, index) => index % 2 === 1 ? token === '.' : /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(token) && !['and', 'or', 'not', 'in', 'is'].includes(token))) return null
  const bound = tokens.slice(at + 1)
  const magnitude = bound[0] === '-' ? bound.slice(1) : bound
  if (!((magnitude.length === 1 && /^\d+$/.test(magnitude[0])) || (magnitude.length === 3 && /^\d+$/.test(magnitude[0]) && magnitude[1] === '.' && /^\d+$/.test(magnitude[2])))) return null
  const value = Number(bound.join(''))
  return Number.isFinite(value) ? { subject: subject.join(''), op: tokens[at], bound: value } : null
}

function readilyStronger(before: LogicalAssertion, after: LogicalAssertion): boolean {
  const old = assertionCondition(before)
  const next = assertionCondition(after)
  if (!old || !next) return false
  if (sameTokens(old, next) || sameTokens(old, ['true']) || sameTokens(next, ['false'])) return true
  const argument = firstAssertionArgument(after)
  if (argument) {
    let depth = 0
    let start = 0
    const terms: string[][] = []
    let disjunction = false
    for (let i = 0; i < argument.length; i++) {
      const token = argument[i]
      if (['(', '[', '{'].includes(token)) depth++
      if ([')', ']', '}'].includes(token)) depth--
      if (depth === 0 && ['or', '||'].includes(token)) disjunction = true
      if (depth === 0 && ['and', '&&'].includes(token)) {
        terms.push(argument.slice(start, i))
        start = i + 1
      }
    }
    terms.push(argument.slice(start))
    if (!disjunction && terms.length > 1 && terms.some(term => sameTokens(term, old) || sameTokens(term, ['(', ...old, ')']))) return true
  }
  const a = comparison(old)
  const b = comparison(next)
  if (!a || !b || a.subject !== b.subject) return false
  if (a.op.startsWith('>') && b.op.startsWith('>')) return b.bound > a.bound || (b.bound === a.bound && (a.op === '>=' || b.op === '>'))
  if (a.op.startsWith('<') && b.op.startsWith('<')) return b.bound < a.bound || (b.bound === a.bound && (a.op === '<=' || b.op === '<'))
  if (b.op === '==' || b.op === '===') {
    if (a.op === '>') return b.bound > a.bound
    if (a.op === '>=') return b.bound >= a.bound
    if (a.op === '<') return b.bound < a.bound
    if (a.op === '<=') return b.bound <= a.bound
    return a.bound === b.bound && (a.op === '==' || b.op === '===')
  }
  return false
}

function declaredCheckCounts(text: string, file: string): Array<{ name: string; count: number; line: number }> {
  const tokens = tokensOf(text, file.toLowerCase().endsWith('.gd'))
  const counts: Array<{ name: string; count: number; line: number }> = []
  let printed = 0
  for (let i = 0; i < tokens.length; i++) {
    if (/^["'`]/.test(tokens[i].value)) {
      for (const match of tokens[i].value.matchAll(/\bchecks?\s*[:=]\s*(\d+)\b|\b(\d+)\s+checks?\b/gi)) {
        counts.push({ name: `printed check count ${++printed}`, count: Number(match[1] ?? match[2]), line: tokens[i].line })
      }
    }
    if (!/^(?:expected_checks|check_count|total_checks)$/i.test(tokens[i].value)) continue
    let at = i + 1
    if (tokens[at]?.value === ':') {
      at++
      if (tokens[at]?.value !== '=') at++
    }
    if (tokens[at]?.value !== '=' || !/^\d+$/.test(tokens[at + 1]?.value ?? '')) continue
    const end = tokens[at + 2]
    if (end && end.line === tokens[at + 1].line && ![';', ',', '}'].includes(end.value)) continue
    counts.push({ name: tokens[i].value, count: Number(tokens[at + 1].value), line: tokens[i].line })
  }
  return counts
}

export function compareProofAssertions(file: string, before: string, after: string): ProofDriftRow[] {
  const old = logicalAssertions(before, file)
  const next = logicalAssertions(after, file)
  const remaining = [...next]
  const removed = old.filter(assertion => {
    const at = remaining.findIndex(candidate => compact(candidate) === compact(assertion))
    if (at === -1) return true
    remaining.splice(at, 1)
    return false
  })
  const rows: ProofDriftRow[] = []
  for (let i = 0; i < removed.length; i++) {
    const previous = removed[i]
    const current = remaining[i]
    if (!current) {
      rows.push({ kind: 'assertion-removed', file, line: previous.line, message: 'assertion present in HEAD was removed from the selected tree', before: previous.text })
    } else if (!readilyStronger(previous, current)) {
      const weakened = readilyStronger(current, previous) || sameTokens(assertionCondition(current) ?? [], ['true'])
      rows.push({ kind: weakened ? 'assertion-weakened' : 'assertion-changed', file, line: current.line, message: weakened ? 'the selected assertion accepts a readily decidable weaker condition than HEAD' : 'changed assertion needs human review; this syntactic comparison cannot establish arbitrary semantic strengthening or weakening', before: previous.text, after: current.text })
    }
  }
  if (next.length < old.length) rows.push({ kind: 'assertion-count-decreased', file, line: old[0]?.line ?? null, message: `assertion count fell from ${old.length} in HEAD to ${next.length} in the selected tree`, beforeCount: old.length, afterCount: next.length })
  const newCounts = declaredCheckCounts(after, file)
  for (const previous of declaredCheckCounts(before, file)) {
    const current = newCounts.find(count => count.name === previous.name)
    if (!current || current.count < previous.count) rows.push({ kind: 'check-count-decreased', file, line: current?.line ?? previous.line, message: `${previous.name} ${current ? `fell from ${previous.count} to ${current.count}` : `was removed (HEAD declared ${previous.count})`}; integer declarations and literal check counts require review`, beforeCount: previous.count, afterCount: current?.count ?? 0 })
  }
  return rows
}

function selectedBlobs(facts: ProofTreeFacts): Map<string, string> {
  const selected = new Map(facts.baseBlobs)
  for (const [file, blob] of facts.overlay) {
    if (blob === null) selected.delete(file)
    else selected.set(file, blob)
  }
  for (const file of selected.keys()) if (isEngineInternalPath(file)) selected.delete(file)
  return selected
}

export function proofTreeFingerprint(facts: ProofTreeFacts): string {
  const hash = createHash('sha256')
  for (const [file, blob] of [...selectedBlobs(facts)].sort(([a], [b]) => a.localeCompare(b))) hash.update(file).update('\0').update(blob).update('\0')
  return hash.digest('hex')
}

export async function selectedTreeChanges(projectRoot: string, facts: ProofTreeFacts): Promise<{ files: string[]; head: Map<string, string> } | { error: string }> {
  const listing = await runGit(projectRoot, ['ls-tree', '-r', '-z', 'HEAD'])
  if (listing.code !== 0) return { error: `proof drift cannot read HEAD: ${listing.stderr.trim()}` }
  const head = parseLsTreeZ(listing.stdout)
  const selected = selectedBlobs(facts)
  const files = [...new Set([...head.keys(), ...selected.keys()])].filter(file => !isEngineInternalPath(file) && head.get(file) !== selected.get(file)).sort()
  return { files, head }
}

export async function sourceProofDrift(projectRoot: string, enginePath: string, facts: ProofTreeFacts, testFiles: readonly string[] = []): Promise<ProofDriftRow[]> {
  if (!facts.commit) return []
  const changed = await selectedTreeChanges(projectRoot, facts)
  if ('error' in changed) return [{ kind: 'drift-unavailable', file: '', line: null, message: changed.error }]
  const selected = selectedBlobs(facts)
  const rows: ProofDriftRow[] = []
  for (const file of changed.files.filter(file => isProofTestFile(file) || testFiles.includes(file))) {
    const blob = changed.head.get(file)
    if (!blob) continue
    const old = await runGit(projectRoot, ['cat-file', 'blob', blob])
    if (old.code !== 0) {
      rows.push({ kind: 'drift-unavailable', file, line: null, message: `cannot read HEAD test blob: ${old.stderr.trim()}` })
      continue
    }
    let current = ''
    if (selected.has(file)) {
      try {
        const root = realpathSync(enginePath)
        const target = realpathSync(path.join(enginePath, file))
        const rel = path.relative(root, target)
        if (rel.startsWith(`..${path.sep}`) || rel === '..' || path.isAbsolute(rel)) throw new Error('test symlink escapes the selected tree')
        current = readFileSync(target, 'utf8')
      } catch (error) {
        rows.push({ kind: 'drift-unavailable', file, line: null, message: `cannot read selected test: ${(error as Error).message}` })
        continue
      }
    }
    rows.push(...compareProofAssertions(file, old.stdout, current))
  }
  return rows
}

export function engineLogDrift(output: string, suite?: string, runId?: string): ProofDriftRow[] {
  const lines = stripEngineAnsi(output).split(/\r?\n/)
  if (!lines.some(line => /\bPASS\b/.test(line))) return []
  const rows: ProofDriftRow[] = []
  for (let i = 0; i < lines.length; i++) {
    if (/\bSCRIPT ERROR\s*:/.test(lines[i])) {
      const error = engineLogErrors(`${lines[i].trimStart()}\n${lines[i + 1] ?? ''}`)[0]
      rows.push({ kind: 'script-error-under-pass', file: error?.file ?? suite ?? '', line: error?.line ?? i + 1, message: `suite prints PASS but also reports ${lines[i].trim()}`, suite, runId })
    }
  }
  return rows
}

export function latestMatchingEvidenceRun(projectRoot: string, fingerprint: string): string | null {
  let entries: string[]
  try {
    entries = readdirSync(engineRunsDir(projectRoot))
  } catch {
    return null
  }
  let newest: { id: string; endedAt: number } | null = null
  for (const id of entries) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) continue
    try {
      const record = JSON.parse(readFileSync(path.join(engineRunPath(projectRoot, id), 'result.json'), 'utf8')) as {
        jobId: string; root: string; complete: boolean; endedAt: string | null; proofTreeFingerprint?: string
      }
      const endedAt = record.endedAt ? Date.parse(record.endedAt) : NaN
      if (record.jobId !== id || !record.complete || !Number.isFinite(endedAt) || record.proofTreeFingerprint !== fingerprint || realpathSync(record.root) !== realpathSync(projectRoot)) continue
      if (!newest || endedAt > newest.endedAt || (endedAt === newest.endedAt && id > newest.id)) newest = { id, endedAt }
    } catch {
      continue
    }
  }
  return newest?.id ?? null
}

export function runEvidenceDrift(projectRoot: string, runId: string, fingerprint: string): ProofDriftRow[] {
  const refused = (message: string): ProofDriftRow[] => [{ kind: 'evidence-mismatch', file: '', line: null, runId, message }]
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) return refused('run evidence needs a project-local engine run ID, not a path')
  try {
    const dir = realpathSync(engineRunPath(projectRoot, runId))
    const expected = path.resolve(engineRunPath(realpathSync(projectRoot), runId))
    if (dir !== expected) return refused('run evidence directory is redirected outside its project run path')
    const record = JSON.parse(readFileSync(path.join(dir, 'result.json'), 'utf8')) as {
      jobId: string
      root: string
      complete: boolean
      endedAt: string | null
      proofTreeFingerprint?: string
      results: Array<{ name: string; skipped?: boolean; log?: string }>
    }
    if (record.jobId !== runId || realpathSync(record.root) !== realpathSync(projectRoot)) return refused('run evidence belongs to another project or run')
    if (!record.complete || !record.endedAt) return refused('run evidence has not completed')
    if (record.proofTreeFingerprint !== fingerprint) return refused('run evidence does not match the selected tree content; run the suite again for this tree')
    const rows: ProofDriftRow[] = []
    for (const row of record.results) {
      if (row.skipped) continue
      if (!row.log) return refused(`run ${runId} has no log for ${row.name}`)
      const log = realpathSync(row.log)
      const rel = path.relative(dir, log)
      if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return refused(`suite ${row.name} log is outside the named run`)
      rows.push(...engineLogDrift(readFileSync(log, 'utf8'), row.name, runId))
    }
    return rows
  } catch (error) {
    return refused(`cannot read the named run evidence: ${(error as Error).message}`)
  }
}
