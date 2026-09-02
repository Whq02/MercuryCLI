


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
  'DELETED',
])

const LIVE_VERDICTS = new Set(['LIVE_DEFAULT_ON', 'LIVE_OPT_IN'])

const REASON_OK_VERDICTS = new Set(['PARKED_INTENTIONAL', 'DEAD_VENDORED', 'UNKNOWN', 'BROKEN'])

type Row = { cells: Record<string, string>; lineNo: number; raw: string }

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map(c => c.trim())
}

function isSeparator(cells: string[]): boolean {
  return cells.every(c => /^:?-{2,}:?$/.test(c.replace(/\s/g, '')))
}

function existingFileAnchors(cell: string): string[] {
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

    if (!VERDICTS.has(verdict)) {
      problems.push(`${id}: verdict "${verdictCell}" not in {${[...VERDICTS].join(', ')}}`)
    }

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

    const flagCell = (cols.flag ? row.cells[cols.flag] : '') ?? ''
    if (!flagCell.trim()) {
      problems.push(`${id}: empty Flag/Default cell (use a flag or explicit "N/A")`)
    }

    const proofCell = (cols.proof ? row.cells[cols.proof] : '') ?? ''
    const hasProof = namesExistingProof(proofCell)
    const reasonOk = REASON_OK_VERDICTS.has(verdict) && proofCell.trim().length > 0
    if (!hasProof && !reasonOk) {
      problems.push(
        `${id}: Proof "${proofCell}" names no existing proof file and verdict ${verdict || '(?)'} requires one`,
      )
    }
  }

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
