/* ledgerScan — the /ledger reader's data model.
 *
 * The evolution-ledger substrate WRITES per-program JSONL files into two homes
 * (the repo's `.mercury/evolution/` and the memdir's `<autoMem>/evolution/`),
 * and the pure rollups (summarizeEvolution / computeEvolutionFrontier /
 * computeSubjectDrift) were reader-less beyond one retired board's single
 * program. This module is the general reader: scan the ledger dirs, parse
 * every program file, aggregate — read-only, gate-independent (past ledgers
 * stay inspectable after an opt-out), never throws.
 *
 * Filenames are `<slug>-<hash8>.jsonl` (slugForProgram) — the true program
 * name is recovered from the ROWS, not the filename, so two programs whose
 * slugs collide still list distinctly.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  computeSubjectDrift,
  parseEvolutionRowsText,
  summarizeEvolution,
  type EvolutionRow,
  type EvolutionSummary,
  type SubjectDrift,
} from './evolutionLedger.js'

export interface ProgramLedger {
  /** the program name as written in the rows. */
  program: string
  /** which home it came from ('repo' = <cwd>/.mercury/evolution, 'memdir'). */
  source: string
  /** the backing file (evidence anchor for the detail pane). */
  path: string
  rows: EvolutionRow[]
  summary: EvolutionSummary
  drift: SubjectDrift[]
}

/** One ledger home to scan. */
export interface LedgerSource {
  /** short label shown as the section ('repo', 'memdir'). */
  label: string
  dir: string
}

/**
 * The scan result: the ProgramLedger array PLUS a backward-compatible stats
 * field — how many listed .jsonl files were unreadable (readFile threw) or
 * parse-failed (content but zero parseable rows). error ≠ empty (trust-cockpit
 * W2a): the reader surfaces the count instead of rendering a clean empty over
 * a broken home. Array consumers are untouched; the field rides along.
 */
export type LedgerScanResult = ProgramLedger[] & { unreadableFiles: number }

const MAX_FILES_PER_DIR = 64 // defensive bound; a home holds a handful today

/**
 * Scan the given homes for program ledgers. A file can carry rows for more
 * than one program only if hand-edited — rows group by their OWN program
 * field, so even that stays honest. Missing dirs yield no entries (not an
 * error); an unreadable/garbage-only file yields no rows and is skipped but
 * COUNTED in `unreadableFiles` (an empty file is honest emptiness, not an
 * error, and stays silent).
 */
export async function scanEvolutionLedgers(sources: LedgerSource[]): Promise<LedgerScanResult> {
  const out: ProgramLedger[] = []
  let unreadable = 0
  for (const src of sources) {
    let names: string[]
    try {
      names = (await readdir(src.dir)).filter(n => n.endsWith('.jsonl')).sort().slice(0, MAX_FILES_PER_DIR)
    } catch {
      continue // home doesn't exist — honest absence
    }
    for (const name of names) {
      const path = join(src.dir, name)
      let text: string
      try {
        text = await readFile(path, 'utf-8')
      } catch {
        unreadable++ // listed but unreadable (perms/races) — never a silent skip
        continue
      }
      // parseEvolutionRowsText never throws (it skips garbage lines); a file
      // with content but ZERO parseable rows is a parse failure, not emptiness.
      const rows: EvolutionRow[] = parseEvolutionRowsText(text)
      if (rows.length === 0) {
        if (text.trim().length > 0) unreadable++
        continue
      }
      const byProgram = new Map<string, EvolutionRow[]>()
      for (const r of rows) {
        const arr = byProgram.get(r.program)
        if (arr) arr.push(r)
        else byProgram.set(r.program, [r])
      }
      for (const [program, programRows] of byProgram) {
        out.push({
          program,
          source: src.label,
          path,
          rows: programRows,
          summary: summarizeEvolution(program, programRows),
          drift: computeSubjectDrift(programRows),
        })
      }
    }
  }
  // Most-recently-active first — the operator's "what moved lately" order.
  const result = out.sort(
    (a, b) => (b.summary.lastTs ?? '').localeCompare(a.summary.lastTs ?? ''),
  ) as LedgerScanResult
  result.unreadableFiles = unreadable
  return result
}
