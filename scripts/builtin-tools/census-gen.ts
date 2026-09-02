#!/usr/bin/env bun
// ============================================================================
//  scripts/builtin-tools/census-gen.ts — regenerate the tool-capability census
// Writes:
//    · scripts/builtin-tools/fixtures/tool-census.json  (the DRIFT ANCHOR —
//      environment-stable fields only)
//    · scripts/builtin-tools/fixtures/tool-census.md    (the readable census;
//      live columns are informational, stamped "at generation time")
//
//  Run after any tool-catalog change; scripts/builtin-tools/prove-builtin-tools-census.ts
//  fails the gate when the committed anchor does not match the live
//  catalog.
// ============================================================================

import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { buildToolCensus, stableCensus, CENSUS_VERSION } from '../../src/utils/capability/census.ts'

const repoRoot = resolve(import.meta.dir, '..', '..')
const jsonPath = join(repoRoot, 'scripts', 'builtin-tools', 'fixtures', 'tool-census.json')
const mdPath = join(repoRoot, 'scripts', 'builtin-tools', 'fixtures', 'tool-census.md')

const census = buildToolCensus()
const anchor = { version: CENSUS_VERSION, rows: stableCensus(census) }

writeFileSync(jsonPath, `${JSON.stringify(anchor, null, 2)}\n`)

const s = census.summary
const lines: string[] = [
  '# builtin-tools capability census (GENERATED)',
  '',
  '> Regenerate: `bun run scripts/builtin-tools/census-gen.ts` · drift gate:',
  '> `scripts/builtin-tools/prove-builtin-tools-census.ts` (compares the committed JSON',
  '> anchor against the live catalog — a new/changed production tool that',
  "> skips regeneration is RED). Live columns (enabled/support) reflect the",
  '> generating environment and are NOT drift-anchored.',
  '',
  `Census version ${census.version} — ${s.tools} built-in production tools · ` +
    `${s.operations} operations · ${s.declared} with a declared capability contract.`,
  '',
  '## Summary',
  '',
  `- support (at generation time): ${s.bySupport.available} available · ${s.bySupport.conditional} conditional · ${s.bySupport.degraded} degraded · ${s.bySupport.unavailable} unavailable (gated out of this environment's catalog — still rowed, never silently dropped)`,
  `- class: ${s.byClass.observation} observation · ${s.byClass.mutation} mutation · ${s.byClass.execution} execution · ${s.byClass.coordination} coordination · ${s.byClass.unclassified} unclassified`,
  `- integrations: ${s.withTransactionIntegration} declare transactions · ${s.withExecutionIntegration} declare executions · ${s.withResourceOutputs} declare mercury:// outputs · ${s.withProof} name a focused proof`,
  `- capability units covered: ${s.unitsCovered.join(' · ') || '(none declared yet)'}`,
  s.unclassified.length > 0
    ? `- NOT yet unit-classified (${s.unclassified.length}): ${s.unclassified.join(', ')}`
    : '- every tool is unit-classified',
  '',
  '## Per-tool census',
  '',
  '| Tool | class | units | ops | cancel | deferred | transactions | execution | resources | proof |',
  '|---|---|---|---|---|---|---|---|---|---|',
]

for (const row of census.rows) {
  const d = row.declared
  const cls = d?.class ?? (row.readOnlyProbe === true ? 'observation' : 'unclassified')
  lines.push(
    `| ${row.name} | ${cls} | ${row.units.join(', ')} | ` +
      `${row.operations ? row.operations.length : '—'} | ${row.cancellation} | ${row.deferred ? 'yes' : 'no'} | ` +
      `${d?.transaction ? `${d.transaction.kind}${d.transaction.receipts ? ' +receipts' : ''}` : '—'} | ` +
      `${d?.execution ? `${d.execution.kind} (${d.execution.representation})` : '—'} | ` +
      `${d?.resources?.length ? d.resources.map(r => `mercury://${r}`).join(', ') : '—'} | ` +
      `${row.proof ?? 'NAMED GAP'} |`,
  )
}

lines.push(
  '',
  '## Reading notes',
  '',
  '- **class** — declared contract class; pre-declaration rows show the',
  '  isReadOnly-probe-derived `observation` or `unclassified` (honest gap).',
  '- **cancel** — `cancel` stops the call on operator steer; `block` queues',
  '  the new message (the Tool.interruptBehavior contract).',
  '- **transactions / execution / resources** — DECLARED integrations only;',
  '  every declared claim is mechanically cross-checked by the constitution',
  '  gate (flagRegistry · EXECUTION_DOMAIN_CENSUS · the resource registry ·',
  '  proof paths on disk). `—` = not declared (a named gap, not a denial).',
  '- Uniform properties not repeated per-row: every catalog tool is reachable',
  '  from Workshop (`mercury.tool`) and workflow agents unless its contract',
  '  declares otherwise; every tool is available in all permission modes',
  '  except SetTier (autopilot-mode-narrowed in toolPool).',
  '',
)

writeFileSync(mdPath, lines.join('\n'))
console.log(`census: ${s.tools} tools → ${jsonPath}`)
console.log(`census: readable → ${mdPath}`)
