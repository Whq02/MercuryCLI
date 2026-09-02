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
  program: string
  source: string
  path: string
  rows: EvolutionRow[]
  summary: EvolutionSummary
  drift: SubjectDrift[]
}

export interface LedgerSource {
  label: string
  dir: string
}

export type LedgerScanResult = ProgramLedger[] & { unreadableFiles: number }

const MAX_FILES_PER_DIR = 64

export async function scanEvolutionLedgers(sources: LedgerSource[]): Promise<LedgerScanResult> {
  const out: ProgramLedger[] = []
  let unreadable = 0
  for (const src of sources) {
    let names: string[]
    try {
      names = (await readdir(src.dir)).filter(n => n.endsWith('.jsonl')).sort().slice(0, MAX_FILES_PER_DIR)
    } catch {
      continue
    }
    for (const name of names) {
      const path = join(src.dir, name)
      let text: string
      try {
        text = await readFile(path, 'utf-8')
      } catch {
        unreadable++
        continue
      }
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
  const result = out.sort(
    (a, b) => (b.summary.lastTs ?? '').localeCompare(a.summary.lastTs ?? ''),
  ) as LedgerScanResult
  result.unreadableFiles = unreadable
  return result
}
