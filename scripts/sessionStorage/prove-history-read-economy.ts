#!/usr/bin/env bun
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

const bootstrap = await import('../../src/boot/process-state/processState.ts')
bootstrap.setOriginalCwd(cwd)
const history = await import('../../src/sessions/promptHistory.ts')
const quiet = (): boolean => {
  const h = history.getHistoryFlushHealth()
  return h.pending === 0 && !h.inFlight
}

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

const L = 3000
writeFileSync(filePath, Array.from({ length: L }, (_, i) => record(`prompt ${i}`, i, i % 3 === 0 ? project : otherProject)).join('\n') + '\n', { mode: 0o600 })

section('H1 the up-arrow window parses only the lines it keeps')
{
  reset()
  const seen: string[] = []
  for await (const entry of history.getHistory()) seen.push(entry.display)
  check('the window holds 100 rows of this project, newest first', seen.length === 100 && seen[0] === 'prompt 2997' && seen.every(d => Number(d.slice(7)) % 3 === 0), `${seen.length} first=${seen[0]}; fix getHistory in src/sessions/promptHistory.ts to keep only this project lines, newest first, up to 100`)
  check(`one whole-file read, exactly 100 lines parsed (was ${L}: every line, eagerly)`, census.reads === 1 && census.parsedLines === 100, `${JSON.stringify(census)}; fix getHistory and diskRecordsReversed in src/sessions/promptHistory.ts to parse only the lines the window keeps`)
  console.log(`  BEFORE: ${L} JSON.parse per up-arrow window over a ${L}-line file · AFTER: ${census.parsedLines}`)
}

section('H2 the search corpus — one read, one parse; readers over it cost nothing')
{
  reset()
  const corpus = await history.loadHistoryCorpus()
  check(`the corpus holds every record newest-first (${L})`, corpus.length === L && corpus[0]!.display === `prompt ${L - 1}` && corpus[L - 1]!.display === 'prompt 0', `${corpus.length}; fix loadHistoryCorpus in src/sessions/promptHistory.ts to return every record, newest first`)
  check(`loading it cost one read and ${L} parses`, census.reads === 1 && census.parsedLines === L, `${JSON.stringify(census)}; fix loadHistoryCorpus in src/sessions/promptHistory.ts to read the file once and parse each line once`)
  const K = 25
  let matches = 0
  for (let k = 0; k < K; k++) {
    for await (const entry of history.makeHistoryReaderOver(corpus)) {
      if (entry.display.includes(`prompt ${L - 1 - k}`)) {
        matches++
        break
      }
    }
  }
  check(`${K} keystroke scans over the corpus: 0 further reads, 0 further parses (was ${K} reads + ${K * L} parses)`, matches === K && census.reads === 1 && census.parsedLines === L, `${JSON.stringify(census)}; fix makeHistoryReaderOver in src/sessions/promptHistory.ts to walk the loaded corpus without reading or parsing the file again`)
  console.log(`  BEFORE: ${K} keystrokes = ${K} whole-file reads + ${K * L} JSON.parse · AFTER: 1 read + ${L} parses per search session, 0 per keystroke`)
}

section('H3 the corpus carries the pending buffer first')
{
  history.addToHistory('typed just now')
  const withPending = await history.loadHistoryCorpus()
  check('a just-typed entry (still pending or freshly flushed) leads the corpus', withPending[0]?.display === 'typed just now', `${String(withPending[0]?.display)}; fix loadHistoryCorpus in src/sessions/promptHistory.ts to put the pending buffer before the disk records`)
  await waitUntil(() => quiet(), { tries: 2000 })
}

section('H4 compaction — a flush past 8 MiB rewrites the file to its newest 4 MiB of whole lines')
{
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
  await waitUntil(() => quiet(), { tries: 2000 })
  const sizeAfter = statSync(filePath).size
  const text = readFileSync(filePath, 'utf8')
  const lines = text.split('\n').filter(l => l !== '')
  check('the flush that crossed the bound compacted the file (once)', compacted && census.compactions === 1, `${JSON.stringify(census)}; fix compactHistoryIfOversized in src/sessions/promptHistory.ts to compact once when the file passes HISTORY_MAX_BYTES`)
  check(`the file shrank from ${(sizeBefore / 1024 / 1024).toFixed(1)} MiB to at most 4 MiB`, sizeAfter <= 4 * 1024 * 1024 && sizeAfter > 3 * 1024 * 1024, `${sizeAfter}; fix compactHistoryIfOversized in src/sessions/promptHistory.ts to keep the newest HISTORY_KEEP_BYTES of the file`)
  check('it starts at a line boundary (the first line parses)', (() => {
    try {
      return typeof (JSON.parse(lines[0] ?? '') as { display?: unknown }).display === 'string'
    } catch {
      return false
    }
  })(), `${(lines[0] ?? '').slice(0, 40)}; fix compactHistoryIfOversized in src/sessions/promptHistory.ts to cut at the first newline of the kept tail`)
  const newest = lines[lines.length - 1] ?? ''
  check('the appended line is the newest line of the compacted file', newest.includes('after the compaction'), `${newest.slice(0, 80)}; fix the flush and compactHistoryIfOversized in src/sessions/promptHistory.ts so the new line is appended before the file is trimmed`)
  check('the newest old line survived the rewrite', text.includes(`"big-${lastBig}"`), `looked for "big-${lastBig}" · tail: ${text.slice(-160).replace(/\n/g, ' ↵ ')}; fix compactHistoryIfOversized in src/sessions/promptHistory.ts to keep the newest lines`)
  check('the oldest line is gone', !text.includes('"big-0"'), `head: ${text.slice(0, 80)}; fix compactHistoryIfOversized in src/sessions/promptHistory.ts to drop the oldest lines`)
  if (process.platform === 'win32') console.log('  [SKIP] the owner-only mode is kept through the rewrite — win32: NTFS keeps no POSIX mode bits (node reads 0o666 whatever the chmod); the mode on the rewrite rides the POSIX pool')
  else check('the owner-only mode is kept through the rewrite', (statSync(filePath).mode & 0o777) === 0o600, `${(statSync(filePath).mode & 0o777).toString(8)}; fix compactHistoryIfOversized in src/sessions/promptHistory.ts to publish with mode 0o600`)
  check('the flush lock is released', !existsSync(`${filePath}.lock`), `${filePath}.lock is still there; fix the flush in src/sessions/promptHistory.ts to release its lock after compaction`)
  reset()
  const seen: string[] = []
  for await (const entry of history.getHistory()) seen.push(entry.display)
  check('the up-arrow window still serves after the compaction (the appended entry leads it)', seen[0] === 'after the compaction', `${String(seen[0])}; fix getHistory in src/sessions/promptHistory.ts to read the compacted file with the appended entry first`)
  console.log(`  BEFORE: history.jsonl grew forever (the field box: 2-15 MB and every read paid it whole) · AFTER: bounded at 8 MiB, rewritten to 4 MiB of whole lines under the flush lock`)
}


console.log(failures === 0 ? '\n✅ ALL HISTORY-READ-ECONOMY PROOFS PASS' : `\n❌ ${failures} HISTORY-READ-ECONOMY PROOF(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
