import { buildToolCensus, stableCensus, CENSUS_VERSION } from '../../src/permissions/capability-census/census.ts'

export function toolCensus() {
  const census = buildToolCensus()
  const anchor = { version: CENSUS_VERSION, rows: stableCensus(census) }
  const s = census.summary
  const lines: string[] = [
    '# builtin-tools capability census',
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
    '  from Eval (`tool`) unless its contract declares otherwise; every',
    '  tool is available in all permission modes.',
    '',
  )

  return { census, anchor, markdown: lines.join('\n') }
}
