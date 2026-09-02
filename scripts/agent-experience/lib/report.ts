// ============================================================================
//  scripts/agent-experience/lib/report.ts — the tables. One JSON table per
//  family (header + rows) and one rendered markdown summary across
//  families: the task × family matrix, the per-family prompt facts, and the
//  error audit (every error a run produced, with whether it named a fix).
// ============================================================================
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Score } from './score.ts'

export interface FamilyHeader {
  family: string
  label: string
  model: string
  backend: string
  dialect: string
  mechanical: boolean
  tree: string
  fold: string
  when: string
  /** From the first main request the fixture captured (mechanical) or the
   *  init envelope (live): what the model must read before its first move. */
  promptChars: number | null
  promptTokensEst: number | null
  toolCount: number | null
  toolNames: string[]
  toolSchemaChars: number | null
  notes: string[]
}

export interface TaskRow extends Score {
  task: string
  title: string
  skipped: string | null
  allowedTools: string[]
  finalText: string
  stderrTail: string
}

export interface FamilyTable {
  header: FamilyHeader
  rows: TaskRow[]
}

export function writeFamilyTable(outDir: string, table: FamilyTable): string {
  mkdirSync(outDir, { recursive: true })
  const path = join(outDir, `${table.header.family}.json`)
  writeFileSync(path, JSON.stringify(table, null, 2) + '\n')
  return path
}

function cell(row: TaskRow | undefined): string {
  if (!row) return '—'
  if (row.skipped) return `skip (${row.skipped})`
  const mark = row.success === true ? 'PASS' : row.success === false ? 'FAIL' : 'n/a'
  const tok = row.toolResultTokensEst >= 1000 ? `${(row.toolResultTokensEst / 1000).toFixed(1)}k` : String(row.toolResultTokensEst)
  const img = row.imageChars > 0 ? ` +img${Math.round(row.imageChars / 1000)}k` : ''
  const inj = row.injectedTokensEst >= 200 ? ` +inj${row.injectedTokensEst >= 1000 ? `${(row.injectedTokensEst / 1000).toFixed(1)}k` : row.injectedTokensEst}` : ''
  return `${mark} · t${row.turns} · w${row.wasted}${row.probes ? `(${row.probes}p)` : ''} · r${tok}${img}${inj} · a${row.asks}`
}

export function totals(rows: TaskRow[]): { pass: number; fail: number; skipped: number; turns: number; wasted: number; unexpected: number; tokens: number; asks: number; wallMs: number } {
  const t = { pass: 0, fail: 0, skipped: 0, turns: 0, wasted: 0, unexpected: 0, tokens: 0, asks: 0, wallMs: 0 }
  for (const r of rows) {
    if (r.skipped) {
      t.skipped++
      continue
    }
    if (r.success === true) t.pass++
    else if (r.success === false) t.fail++
    t.turns += r.turns
    t.wasted += r.wasted
    t.unexpected += r.unexpectedErrors
    t.tokens += r.toolResultTokensEst
    t.asks += r.asks
    t.wallMs += r.wallMs
  }
  return t
}

export function renderSummary(tables: FamilyTable[], title: string): string {
  const lines: string[] = []
  lines.push(`# ${title}`, '')
  const first = tables[0]
  if (first) lines.push(`Tree ${first.header.tree} · ${first.header.fold} · ${first.header.when}`, '')
  lines.push('Cell legend: PASS/FAIL (the oracle) · t = model turns · w = wasted tool calls (p = the script\'s deliberate probes) · r = tokens read from tool results (est. chars/4; +img = screenshot payload; +inj = harness-injected text such as a skill expansion, shown from 200) · a = asks/denials that a headless run could not answer.', '')
  const taskIds: string[] = []
  for (const table of tables) for (const row of table.rows) if (!taskIds.includes(row.task)) taskIds.push(row.task)
  lines.push(`| task | ${tables.map(t => t.header.family).join(' | ')} |`)
  lines.push(`|---|${tables.map(() => '---').join('|')}|`)
  for (const id of taskIds) {
    const title = tables.flatMap(t => t.rows).find(r => r.task === id)?.title ?? id
    lines.push(`| ${id} — ${title} | ${tables.map(t => cell(t.rows.find(r => r.task === id))).join(' | ')} |`)
  }
  lines.push(`| **totals** | ${tables.map(t => {
    const s = totals(t.rows)
    return `${s.pass}/${s.pass + s.fail} pass${s.skipped ? ` (${s.skipped} skipped)` : ''} · t${s.turns} · w${s.wasted} (unexpected ${s.unexpected}) · r${(s.tokens / 1000).toFixed(1)}k · a${s.asks} · ${(s.wallMs / 1000).toFixed(0)}s`
  }).join(' | ')} |`)
  lines.push('', '## What the model reads before its first move', '')
  lines.push('| family | model | backend | dialect | prompt chars | ≈tokens | tools | tool-schema chars |')
  lines.push('|---|---|---|---|---|---|---|---|')
  for (const t of tables) {
    const h = t.header
    lines.push(`| ${h.family} | ${h.model} | ${h.backend} | ${h.dialect} | ${h.promptChars ?? '?'} | ${h.promptTokensEst ?? '?'} | ${h.toolCount ?? '?'} | ${h.toolSchemaChars ?? '?'} |`)
  }
  for (const t of tables) {
    if (t.header.notes.length) lines.push('', `Notes (${t.header.family}): ${t.header.notes.join(' · ')}`)
  }
  lines.push('', '## Error audit — what a model reads back when a call goes wrong', '')
  for (const t of tables) {
    const errs = t.rows.flatMap(r => r.errors.map(e => ({ task: r.task, ...e })))
    if (errs.length === 0) continue
    lines.push(`### ${t.header.family}`, '')
    for (const e of errs) {
      lines.push(`- **${e.task} / ${e.tool}**${e.probe ? ' (probe)' : ''} — names a fix: ${e.namesFix ? 'yes' : 'NO'} — \`${e.text.replace(/\s+/g, ' ').slice(0, 220)}\``)
    }
    lines.push('')
  }
  lines.push('## Oracle detail', '')
  for (const t of tables) {
    lines.push(`### ${t.header.family}`, '')
    for (const r of t.rows) lines.push(`- ${r.task}: ${r.skipped ? `skipped — ${r.skipped}` : `${r.success === true ? 'PASS' : r.success === false ? 'FAIL' : 'n/a'} — ${r.oracle}`}${r.resultSubtype !== 'success' ? ` (result: ${r.resultSubtype})` : ''}`)
    lines.push('')
  }
  return lines.join('\n') + '\n'
}
