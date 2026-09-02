/* ============================================================================
   prove-matrix-complete.ts — the anti-rot gate for the Capability Graduation
   Matrix (docs/CAPABILITY-GRADUATION-MATRIX.md — a LOCAL document, never
   tracked: the proof runs in full where the file is present, and says
   SKIPPED and passes where it is absent).

   The matrix is only useful if it cannot silently go stale. This proof parses
   the canonical matrix table(s) and FAILS the green gate unless EVERY row is
   complete and honest:

     1. Every row carries a VERDICT from the closed vocabulary.
     2. Every row carries a SOURCE ANCHOR that names a file that EXISTS on disk
        (a `path` or `path:line` — the FILE is checked, the `:line` suffix is
        not, so this catches a deleted/renamed file, not a stale line number).
        For a LIVE_* row the anchor must include at least one file under `src/`
        (the real implementation can't live only in a README / package.json).
     3. Every row carries a FLAG / DEFAULT cell (an env flag, or explicit `N/A`).
     4. Every row carries PROOF: a `scripts/.../run-all.sh` or `prove-*.ts` that
        EXISTS, OR — for the non-LIVE verdicts (PARKED_INTENTIONAL / DEAD_VENDORED
        / BROKEN / UNKNOWN) — a non-empty parked/dead/severance reason.

   Honest about its own reach: this is a COMPLETENESS + existence gate, not a
   semantic-correspondence oracle — it can't prove a cited proof actually covers
   the row, only that the row names a real src anchor and a real proof file. It
   maps columns by HEADER NAME (so column order can change). Add a capability →
   you must add a real src anchor + a real proof (or a non-LIVE reason) or the
   gate goes red. Run via `bash scripts/capabilities/run-all.sh`.
   ============================================================================ */
import { existsSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const MATRIX = resolve(REPO, 'docs', 'CAPABILITY-GRADUATION-MATRIX.md')

const VERDICTS = new Set([
  'LIVE_DEFAULT_ON',
  'LIVE_OPT_IN',
  'PARKED_INTENTIONAL',
  'DEAD_VENDORED',
  'BROKEN',
  'UNKNOWN',
  // machinery prune: a capability whose machinery was
  // deleted from the tree. INVERTED anchor contract — its source cell
  // documents what was deleted (and must NOT resolve to a file under src/),
  // and its proof must name a real stays-deleted ratchet file.
  'DELETED',
])

// The LIVE verdicts — these MUST cite a real proof file AND a `src/` anchor (a
// shipped capability has a real implementation + a proof, no exceptions).
const LIVE_VERDICTS = new Set(['LIVE_DEFAULT_ON', 'LIVE_OPT_IN'])

// The NON-LIVE verdicts — a row with one of these may substitute a non-empty
// reason for a proof-file path (a parked/dead/severed capability legitimately
// has no passing live proof). This set is exactly the complement of LIVE_VERDICTS.
const REASON_OK_VERDICTS = new Set(['PARKED_INTENTIONAL', 'DEAD_VENDORED', 'UNKNOWN', 'BROKEN'])

type Row = { cells: Record<string, string>; lineNo: number; raw: string }

function splitRow(line: string): string[] {
  // Drop the leading/trailing pipe, split on unescaped pipes, trim.
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map(c => c.trim())
}

function isSeparator(cells: string[]): boolean {
  return cells.every(c => /^:?-{2,}:?$/.test(c.replace(/\s/g, '')))
}

/** Extract every `path` / `path:line` token from a cell and return those whose
 *  file exists relative to the repo root. A cell may carry several anchors. */
function existingFileAnchors(cell: string): string[] {
  // Match repo-relative-looking paths: at least one slash OR a known top dir,
  // ending in a file extension, with an optional :line suffix.
  const re = /`?([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)(?::\d+(?:-\d+)?)?`?/g
  const found: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(cell))) {
    const p = m[1]
    if (!p.includes('/') && !p.includes('.')) continue
    if (existsSync(resolve(REPO, p))) found.push(p)
  }
  return found
}

/** Does the cell name a proof file (run-all.sh or prove-*.ts) that exists? */
function namesExistingProof(cell: string): boolean {
  const re = /`?([A-Za-z0-9_./-]+(?:run-all\.sh|prove-[A-Za-z0-9_.-]+\.(?:ts|mjs|js)))`?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(cell))) {
    if (existsSync(resolve(REPO, m[1]))) return true
  }
  return false
}

function findColumn(headers: string[], ...names: string[]): string | undefined {
  for (const n of names) {
    const hit = headers.find(h => h.toLowerCase().includes(n.toLowerCase()))
    if (hit) return hit
  }
  return undefined
}

/** An exact (case-insensitive, trimmed) header match — used for the matrix
 *  columns so a prose data cell that merely contains the word
 *  "verdict" or "anchor" can never be mistaken for a matrix header row. */
function findExact(headers: string[], name: string): string | undefined {
  return headers.find(h => h.trim().toLowerCase() === name.toLowerCase())
}

function main(): void {
  if (!existsSync(MATRIX)) {
    console.log(
      'SKIPPED — docs/CAPABILITY-GRADUATION-MATRIX.md is absent from this tree (a local document, never tracked); the completeness gate runs only where it is present',
    )
    process.exit(0)
  }
  const lines = readFileSync(MATRIX, 'utf8').split('\n')

  // Collect every markdown table that looks like a capability matrix: a header
  // row containing both a Verdict column and a Source/Anchor column.
  const rows: Row[] = []
  let headers: string[] | null = null
  let cols: {
    capability?: string
    verdict?: string
    flag?: string
    source?: string
    proof?: string
  } = {}

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim().startsWith('|')) {
      headers = null
      continue
    }
    const cells = splitRow(line)
    if (isSeparator(cells)) continue
    if (!headers) {
      // Candidate header — does it have the matrix? Require EXACT
      // Capability + Verdict header cells (+ a Source/anchor column) so a prose
      // data cell merely mentioning "verdict"/"anchor" never false-matches.
      const capability = findExact(cells, 'capability')
      const verdict = findExact(cells, 'verdict')
      const source = findColumn(cells, 'source', 'anchor')
      if (capability && verdict && source) {
        headers = cells
        cols = {
          capability,
          verdict,
          flag: findColumn(cells, 'flag', 'default'),
          source,
          proof: findColumn(cells, 'proof'),
        }
      }
      continue
    }
    // Data row of an identified matrix table.
    const rec: Record<string, string> = {}
    headers.forEach((h, idx) => (rec[h] = cells[idx] ?? ''))
    rows.push({ cells: rec, lineNo: i + 1, raw: line })
  }

  if (rows.length === 0) {
    console.error('✗ no capability matrix rows found (expected a table with Verdict + Source columns)')
    process.exit(1)
  }

  const problems: string[] = []
  for (const row of rows) {
    const cap = (cols.capability ? row.cells[cols.capability] : '') || '(row)'
    const verdictCell = (cols.verdict ? row.cells[cols.verdict] : '') ?? ''
    const verdict = (verdictCell.match(/[A-Z_]{4,}/)?.[0] ?? '').trim()
    const id = `row "${cap}" (line ${row.lineNo})`

    // 1) verdict
    if (!VERDICTS.has(verdict)) {
      problems.push(`${id}: verdict "${verdictCell}" not in {${[...VERDICTS].join(', ')}}`)
    }

    // 2) source anchor → file exists; a LIVE row must anchor real src/ code.
    //    A DELETED row is INVERTED: its source cell narrates what was deleted
    //    and must not resolve to a live src/ file (a reappearing file means
    //    the deletion regressed — the stays-deleted ratchet also catches it).
    const sourceCell = (cols.source ? row.cells[cols.source] : '') ?? ''
    const anchors = existingFileAnchors(sourceCell)
    if (verdict === 'DELETED') {
      const srcAnchors = anchors.filter(a => a.startsWith('src/'))
      if (srcAnchors.length > 0) {
        problems.push(`${id}: a DELETED row's source cell resolves to live src/ file(s): ${srcAnchors.join(', ')}`)
      }
    } else if (anchors.length === 0) {
      problems.push(`${id}: source anchor "${sourceCell}" names no file that exists on disk`)
    } else if (LIVE_VERDICTS.has(verdict) && !anchors.some(a => a.startsWith('src/'))) {
      problems.push(`${id}: a ${verdict} row must anchor real src/ code — "${sourceCell}" names only non-src files`)
    }

    // 3) flag / default present
    const flagCell = (cols.flag ? row.cells[cols.flag] : '') ?? ''
    if (!flagCell.trim()) {
      problems.push(`${id}: empty Flag/Default cell (use a flag or explicit "N/A")`)
    }

    // 4) proof file exists, OR a parked/dead/unknown/broken reason
    const proofCell = (cols.proof ? row.cells[cols.proof] : '') ?? ''
    const hasProof = namesExistingProof(proofCell)
    const reasonOk = REASON_OK_VERDICTS.has(verdict) && proofCell.trim().length > 0
    if (!hasProof && !reasonOk) {
      problems.push(
        `${id}: Proof "${proofCell}" names no existing proof file and verdict ${verdict || '(?)'} requires one`,
      )
    }
  }

  // 5) the prose Roll-up table must match the MECHANICAL tally. It had
  //    silently drifted (verdict reclassifications updated rows but never the
  //    roll-up; caught by the pre-clear recon) — now it can't.
  const text = lines.join('\n')
  const tally = new Map<string, number>()
  for (const row of rows) {
    const v =
      ((cols.verdict ? row.cells[cols.verdict] : '') ?? '').match(/[A-Z_]{4,}/)?.[0] ?? ''
    tally.set(v, (tally.get(v) ?? 0) + 1)
  }
  const rollupStart = text.indexOf('## Roll-up')
  if (rollupStart === -1) {
    problems.push('the "## Roll-up" section is missing/renamed — the tally check needs it')
  } else {
    const header = text.slice(rollupStart).match(/## Roll-up \((\d+) capabilities classified[^)]*\)/)
    if (!header) problems.push('roll-up header no longer carries the "(N capabilities classified …)" count')
    else if (Number(header[1]) !== rows.length)
      problems.push(`roll-up header says ${header[1]} capabilities but ${rows.length} rows parsed`)
    const sectionEnd = text.indexOf('\n## ', rollupStart + 5)
    const section = text.slice(rollupStart, sectionEnd === -1 ? undefined : sectionEnd)
    for (const m of section.matchAll(/\|\s*`([A-Z_]+)`\s*\|\s*(\d+)\s*\|/g)) {
      const v = m[1]!
      const n = Number(m[2])
      if ((tally.get(v) ?? 0) !== n)
        problems.push(`roll-up says ${v}=${n} but the capability tables tally ${tally.get(v) ?? 0}`)
    }
  }

  console.log(`matrix: ${rows.length} capability rows parsed`)
  if (problems.length) {
    console.error(`✗ ${problems.length} matrix integrity problem(s):`)
    for (const p of problems) console.error(`  - ${p}`)
    process.exit(1)
  }
  console.log(`✓ all ${rows.length} rows complete: verdict ∈ vocab · source file exists · flag present · proof-or-reason`)
}

main()
