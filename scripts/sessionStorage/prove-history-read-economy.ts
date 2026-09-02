#!/usr/bin/env bun
// ============================================================================
//  scripts/sessionStorage/prove-history-read-economy.ts — FN-020 row 9: the
//  prompt-history reads stop re-parsing the lifetime history, and the file
//  is bounded.
//
//  The class: history.jsonl is one append-only file of every prompt ever
//  typed across all projects. Every read funnelled through a reader that
//  read the whole file and JSON-parsed EVERY line eagerly before yielding;
//  Ctrl+R created a fresh reader per typed character, so each keystroke
//  cost a full read plus that many parses, growing without bound; the
//  up-arrow window (100 rows) and the shell-ghost corpus (50 commands)
//  parsed lines they never used; nothing ever trimmed the file.
//
//    H1  the up-arrow window parses ONLY the lines it keeps: one read,
//        100 parses over a 3,000-line file (was 3,000)
//    H2  the search corpus: loaded ONCE (one read, every line parsed once),
//        then N readers over it cost 0 reads and 0 parses (was one read
//        and every line parsed per keystroke)
//    H3  the corpus carries the pending buffer first and honours a
//        retraction
//    H4  compaction: a flush past 8 MiB rewrites the file to its newest
//        4 MiB of WHOLE lines — the appended line present, the oldest gone,
//        owner-only mode kept, the lock released, the window still served
//    H5  wiring — the search hook loads the corpus at search start, scans
//        over it, never re-creates the disk reader per keystroke, drops it
//        at reset; the flush compacts under its lock; the window pre-filters
//        raw lines by the JSON-encoded project; the shell corpus rides the
//        window reader
//
//  The instrument is the store's own census (reads · parsedLines ·
//  compactions) — operation-shaped, never a wall clock.
// ============================================================================
import { chmodSync, mkdtempSync, readFileSync, statSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { waitUntil } from '../engine-durability/harness.ts'

const home = mkdtempSync(join(tmpdir(), 'history-economy-home-'))
const cwd = mkdtempSync(join(tmpdir(), 'history-economy-cwd-'))
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV
delete process.env.MERCURY_SKIP_PROMPT_HISTORY
process.chdir(cwd)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const ROOT = join(import.meta.dir, '..', '..')

const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setOriginalCwd(cwd)
const history = await import('../../src/history.ts')
const census = history.historyIoCensus
const reset = (): void => {
  census.reads = 0
  census.parsedLines = 0
  census.compactions = 0
}
const filePath = join(home, 'history.jsonl')
const project = bootstrap.getProjectRoot()
const otherProject = `${project}-other`
const record = (display: string, i: number, proj: string): string =>
  JSON.stringify({ display, pastedContents: {}, timestamp: 1_000_000 + i, project: proj, sessionId: 'another-session' })

// 3,000 lines: every third from THIS project, the rest from another.
const L = 3000
writeFileSync(filePath, Array.from({ length: L }, (_, i) => record(`prompt ${i}`, i, i % 3 === 0 ? project : otherProject)).join('\n') + '\n', { mode: 0o600 })

section('H1 the up-arrow window parses only the lines it keeps')
{
  reset()
  const seen: string[] = []
  for await (const entry of history.getHistory()) seen.push(entry.display)
  check('the window holds 100 rows of this project, newest first', seen.length === 100 && seen[0] === 'prompt 2997' && seen.every(d => Number(d.slice(7)) % 3 === 0), `${seen.length} first=${seen[0]}`)
  check(`one whole-file read, exactly 100 lines parsed (was ${L}: every line, eagerly)`, census.reads === 1 && census.parsedLines === 100, JSON.stringify(census))
  console.log(`  BEFORE: ${L} JSON.parse per up-arrow window over a ${L}-line file · AFTER: ${census.parsedLines}`)
}

section('H2 the search corpus — one read, one parse; readers over it cost nothing')
{
  reset()
  const corpus = await history.loadHistoryCorpus()
  check(`the corpus holds every record newest-first (${L})`, corpus.length === L && corpus[0]!.display === `prompt ${L - 1}` && corpus[L - 1]!.display === 'prompt 0', `${corpus.length}`)
  check(`loading it cost one read and ${L} parses`, census.reads === 1 && census.parsedLines === L, JSON.stringify(census))
  const K = 25
  let matches = 0
  for (let k = 0; k < K; k++) {
    // A keystroke's scan: a fresh reader over the corpus, walked to its match.
    for await (const entry of history.makeHistoryReaderOver(corpus)) {
      if (entry.display.includes(`prompt ${L - 1 - k}`)) {
        matches++
        break
      }
    }
  }
  check(`${K} keystroke scans over the corpus: 0 further reads, 0 further parses (was ${K} reads + ${K * L} parses)`, matches === K && census.reads === 1 && census.parsedLines === L, JSON.stringify(census))
  console.log(`  BEFORE: ${K} keystrokes = ${K} whole-file reads + ${K * L} JSON.parse · AFTER: 1 read + ${L} parses per search session, 0 per keystroke`)
}

section('H3 the corpus carries the pending buffer first and honours a retraction')
{
  history.addToHistory('typed just now')
  const withPending = await history.loadHistoryCorpus()
  check('a just-typed entry (still pending or freshly flushed) leads the corpus', withPending[0]?.display === 'typed just now', String(withPending[0]?.display))
  history.removeLastFromHistory()
  const afterRetract = await history.loadHistoryCorpus()
  check('a retracted entry leaves the corpus whether it reached the disk or not', afterRetract[0]?.display !== 'typed just now', String(afterRetract[0]?.display))
  await waitUntil(() => history.getHistoryFlushHealth().pending === 0, { tries: 2000 })
}

section('H4 compaction — a flush past 8 MiB rewrites the file to its newest 4 MiB of whole lines')
{
  // ~9 MiB of lines, oldest first; the newest line is 'big-<last>'.
  const line = (i: number): string => record(`big-${i}`, i, otherProject)
  const target = 9 * 1024 * 1024
  const parts: string[] = []
  let bytes = 0
  for (let i = 0; bytes < target; i++) {
    const l = line(i)
    parts.push(l)
    bytes += l.length + 1
  }
  const lastBig = parts.length - 1
  writeFileSync(filePath, parts.join('\n') + '\n', { mode: 0o600 })
  chmodSync(filePath, 0o600)
  const sizeBefore = statSync(filePath).size
  reset()
  history.addToHistory('after the compaction')
  const compacted = await waitUntil(() => census.compactions >= 1, { tries: 2000 })
  await waitUntil(() => history.getHistoryFlushHealth().pending === 0, { tries: 2000 })
  const sizeAfter = statSync(filePath).size
  const text = readFileSync(filePath, 'utf8')
  const lines = text.split('\n').filter(l => l !== '')
  check('the flush that crossed the bound compacted the file (once)', compacted && census.compactions === 1, JSON.stringify(census))
  check(`the file shrank from ${(sizeBefore / 1024 / 1024).toFixed(1)} MiB to at most 4 MiB`, sizeAfter <= 4 * 1024 * 1024 && sizeAfter > 3 * 1024 * 1024, `${sizeAfter}`)
  check('it starts at a line boundary (the first line parses)', (() => {
    try {
      return typeof (JSON.parse(lines[0] ?? '') as { display?: unknown }).display === 'string'
    } catch {
      return false
    }
  })(), (lines[0] ?? '').slice(0, 40))
  check('the appended line is the newest, the newest old line survived, the oldest is gone', lines[lines.length - 1]!.includes('after the compaction') && text.includes(`"big-${lastBig}"`) && !text.includes('"big-0"'))
  check('the owner-only mode is kept through the rewrite', (statSync(filePath).mode & 0o777) === 0o600, (statSync(filePath).mode & 0o777).toString(8))
  check('the flush lock is released', !existsSync(`${filePath}.lock`))
  reset()
  const seen: string[] = []
  for await (const entry of history.getHistory()) seen.push(entry.display)
  check('the up-arrow window still serves after the compaction (the appended entry leads it)', seen[0] === 'after the compaction', String(seen[0]))
  console.log(`  BEFORE: history.jsonl grew forever (the field box: 2-15 MB and every read paid it whole) · AFTER: bounded at 8 MiB, rewritten to 4 MiB of whole lines under the flush lock`)
}

section('H5 wiring')
{
  const hook = readFileSync(join(ROOT, 'src/hooks/useHistorySearch.ts'), 'utf8')
  check('the search loads the corpus ONCE at search start', /closeReader\(\)\n(?:\s*\/\/[^\n]*\n)*\s*corpusRef\.current = loadHistoryCorpus\(\)/.test(hook))
  check('a scan awaits the corpus and reads over it in memory', /const corpus = await \(corpusRef\.current \?\?= loadHistoryCorpus\(\)\)[\s\S]{0,300}?readerRef\.current = makeHistoryReaderOver\(corpus\)/.test(hook))
  check('no scan re-creates the disk reader per keystroke', !hook.includes('makeHistoryReader()'))
  check('reset drops the corpus (the next search reloads it)', /closeReader\(\)\n\s*corpusRef\.current = null/.test(hook))
  check('the one-frame debounce idiom stands untouched', hook.includes('scanDebounceRef.current = armHistoryScanTimer(') && hook.includes('export const HISTORY_SCAN_DEBOUNCE_MS = 33'))
  const store = readFileSync(join(ROOT, 'src/history.ts'), 'utf8')
  check('the flush compacts under its own lock, after the append and before the streak resets', /await appendFile\(historyFilePath\(\)[\s\S]{0,400}?await compactHistoryIfOversized\(\)\n\s*flushFailureStreak = 0/.test(store))
  check('the bounds: 8 MiB trigger, 4 MiB kept, owner-only mode on the rewrite', store.includes('const HISTORY_MAX_BYTES = 8 * 1024 * 1024') && store.includes('const HISTORY_KEEP_BYTES = 4 * 1024 * 1024') && /durableAtomicPublish\(path, slice, \{ mode: 0o600 \}\)/.test(store))
  check('the window pre-filters raw lines by the JSON-encoded project before parsing', /const projectNeedle = JSON\.stringify\(project\)\n\s*for await \(const record of diskRecordsReversed\(line => line\.includes\(projectNeedle\)\)\)/.test(store))
  check('the disk reader is lazy: the parse rides the yield, never a whole-array pass', /async function\* diskRecordsReversed\(/.test(store) && !/raw\.split\('\\n'\)/.test(store))
  const shell = readFileSync(join(ROOT, 'src/utils/suggestions/shellHistoryCompletion.ts'), 'utf8')
  check('the shell-ghost corpus rides the window reader (lazy by inheritance)', shell.includes('for await (const entry of getHistory())'))
}

console.log(failures === 0 ? '\n✅ ALL HISTORY-READ-ECONOMY PROOFS PASS' : `\n❌ ${failures} HISTORY-READ-ECONOMY PROOF(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
