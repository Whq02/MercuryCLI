// ============================================================================
//  scripts/agent-experience/lib/project.ts — the scratch project every
//  benchmark run boots in: a small real-shaped Node repo (three source
//  files, a node:test suite with ONE failing case, a README, a three-commit
//  git history). Built fresh per task so oracles read a known starting
//  state; the FACTS the oracles compare against are computed from the
//  files themselves, never hand-copied.
// ============================================================================
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const FIXTURE_PAGE_TITLE = 'Mercury AX Fixture Page'
export const FIXTURE_PAGE_SENTENCE = 'The pelican count is 42.'
export const FIXTURE_PAGE_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${FIXTURE_PAGE_TITLE}</title></head>
<body>
<h1>Agent-experience fixture</h1>
<p id="fact">${FIXTURE_PAGE_SENTENCE}</p>
<button id="go">Go</button>
</body>
</html>
`

export interface ProjectFacts {
  /** Total line count over src/*.js (the shell-pipeline task's answer). */
  srcLineCount: number
  /** 1-based line of `export function normalizeRecord` in src/records.js. */
  defLine: number
  /** 1-based line of the normalizeRecord call in src/stats.js. */
  callLine: number
  /** Number of test() cases in test/stats.test.js. */
  testCount: number
  /** Exported function names of src/stats.js, source order. */
  exports: string[]
}

export interface ScratchProject {
  dir: string
  facts: ProjectFacts
}

const PACKAGE_JSON = `{
  "name": "ax-scratch",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
`

const README = `# ax-scratch

A tiny statistics helper used by the agent-experience benchmark.

## Usage

Run \`node --test\` to execute the suite. The library has no dependencies.

## Layout

- src/stats.js — mean, median, summarize
- src/records.js — normalizeRecord
- src/format.js — formatNumber, formatRecord
- test/stats.test.js — the node:test suite
`

const RECORDS_JS = `// Record normalisation shared by the stats helpers.

/**
 * Normalise a raw record into { label, value }: the label is trimmed and
 * lower-cased, the value is coerced to a finite number (NaN becomes 0).
 */
export function normalizeRecord(record) {
  const label = String(record.label ?? '').trim().toLowerCase()
  const parsed = Number(record.value)
  const value = Number.isFinite(parsed) ? parsed : 0
  return { label, value }
}
`

const STATS_JS = `// Descriptive statistics over plain number arrays.
import { normalizeRecord } from './records.js'

export function mean(values) {
  if (values.length === 0) return 0
  let total = 0
  for (const v of values) total += v
  return total / values.length
}

export function median(values) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted[mid]
}

export function summarize(records) {
  const rows = records.map(normalizeRecord)
  const values = rows.map(r => r.value)
  return { count: rows.length, mean: mean(values), median: median(values) }
}
`

const STATS_JS_FIXED = STATS_JS.replace(
  '  const mid = Math.floor(sorted.length / 2)\n  return sorted[mid]\n',
  '  const mid = Math.floor(sorted.length / 2)\n  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2\n  return sorted[mid]\n',
)

const FORMAT_JS = `// Number formatting for reports.
import { normalizeRecord } from './records.js'

export function formatNumber(n, digits = 2) {
  return Number(n).toFixed(digits)
}

export function formatRecord(record) {
  const { label, value } = normalizeRecord(record)
  return \`\${label}: \${formatNumber(value)}\`
}
`

const STATS_TEST = `import test from 'node:test'
import assert from 'node:assert/strict'
import { mean, median } from '../src/stats.js'

test('mean of a list', () => {
  assert.equal(mean([2, 4, 6]), 4)
})

test('median of an odd-length list', () => {
  assert.equal(median([5, 1, 3]), 3)
})

test('median of an even-length list averages the middle pair', () => {
  assert.equal(median([1, 2, 3, 4]), 2.5)
})
`

/** The exact Edit the fix-bug script applies (and the oracle expects). */
export const MEDIAN_BUG_OLD = '  const mid = Math.floor(sorted.length / 2)\n  return sorted[mid]'
export const MEDIAN_BUG_NEW = '  const mid = Math.floor(sorted.length / 2)\n  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2\n  return sorted[mid]'

/** The test the add-test script appends. */
export const EMPTY_MEAN_TEST = `
test('mean of an empty list is 0', () => {
  assert.equal(mean([]), 0)
})
`

function git(dir: string, args: string[]): void {
  execFileSync('git', args, {
    cwd: dir,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'ax-bench',
      GIT_AUTHOR_EMAIL: 'ax-bench@example.invalid',
      GIT_COMMITTER_NAME: 'ax-bench',
      GIT_COMMITTER_EMAIL: 'ax-bench@example.invalid',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  })
}

function lineOf(text: string, needle: string): number {
  const lines = text.split('\n')
  const idx = lines.findIndex(l => l.includes(needle))
  return idx + 1
}

export function computeFacts(dir: string): ProjectFacts {
  const stats = readFileSync(join(dir, 'src', 'stats.js'), 'utf8')
  const records = readFileSync(join(dir, 'src', 'records.js'), 'utf8')
  const format = readFileSync(join(dir, 'src', 'format.js'), 'utf8')
  const test = readFileSync(join(dir, 'test', 'stats.test.js'), 'utf8')
  const count = (s: string): number => s.split('\n').length - (s.endsWith('\n') ? 1 : 0)
  return {
    srcLineCount: count(stats) + count(records) + count(format),
    defLine: lineOf(records, 'export function normalizeRecord'),
    callLine: lineOf(stats, 'records.map(normalizeRecord)'),
    testCount: (test.match(/^test\(/gm) ?? []).length,
    exports: [...stats.matchAll(/^export function (\w+)/gm)].map(m => m[1]!),
  }
}

/** Build the project at `dir` (created), with its git history. */
export function createScratchProject(dir: string): ScratchProject {
  mkdirSync(join(dir, 'src'), { recursive: true })
  mkdirSync(join(dir, 'test'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), PACKAGE_JSON)
  writeFileSync(join(dir, 'README.md'), README)
  writeFileSync(join(dir, '.gitignore'), 'node_modules\n')
  git(dir, ['init', '-q', '-b', 'main'])
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'init: package manifest, readme'])
  writeFileSync(join(dir, 'src', 'records.js'), RECORDS_JS)
  writeFileSync(join(dir, 'src', 'stats.js'), STATS_JS)
  writeFileSync(join(dir, 'src', 'format.js'), FORMAT_JS)
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'add the stats, records and format helpers'])
  writeFileSync(join(dir, 'test', 'stats.test.js'), STATS_TEST)
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'add the node:test suite (the even-length median case fails)'])
  return { dir, facts: computeFacts(dir) }
}

/** The fixed source, for oracles that compare content. */
export function fixedStatsSource(): string {
  return STATS_JS_FIXED
}

/** Files changed against HEAD (names only), for the anchored-edit oracle. */
export function changedFiles(dir: string): string[] {
  const out = execFileSync('git', ['status', '--porcelain'], { cwd: dir, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).toString('utf8')
  return out
    .split('\n')
    .filter(Boolean)
    .map(l => l.slice(3).trim())
}

/** The suite verdict after a run: exit 0 = every case passes. */
export function runTests(dir: string, nodeBin: string): { exit: number; output: string } {
  try {
    const output = execFileSync(nodeBin, ['--test'], { cwd: dir, stdio: 'pipe', timeout: 30_000 }).toString('utf8')
    return { exit: 0, output }
  } catch (error) {
    const e = error as { status?: number; stdout?: Buffer; stderr?: Buffer }
    return { exit: e.status ?? 1, output: `${e.stdout?.toString('utf8') ?? ''}${e.stderr?.toString('utf8') ?? ''}` }
  }
}
