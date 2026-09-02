#!/usr/bin/env bun
// ============================================================================
//  scripts/substrate/prove-evolution-ledger.ts
//  PROOF: the evolution ledger (Meta-Harness evolution_summary/frontier rows,
//  arXiv:2603.28052, methodology-only). Asserts: the MERCURY_EVOLUTION_LEDGER
//  gate is default-ON with =0 opt-out and OFF ⇒ NO file (byte-identical);
//  rows round-trip; the Honest-Lying anchor gate refuses 'improved'/'accepted'
//  without evidenceRefs; free text is clamped; the frontier math (holdout
//  precedence, dry-iteration counting) is correct; concurrent writes never
//  lose a row; the ledger trims bounded. Exercised against the REAL module.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { appendFile, mkdir } from 'node:fs/promises'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  EVOLUTION_OUTCOMES,
  computeEvolutionFrontier,
  defaultEvolutionLedgerDir,
  getEvolutionLedgerPath,
  makeWorkflowLedgerHost,
  readEvolutionRows,
  renderEvolutionReport,
  slugForProgram,
  summarizeEvolution,
  validateEvolutionRow,
  writeEvolutionRow,
  evolutionLedgerEnabled,
  type EvolutionRow,
} from '../../src/utils/evolution/evolutionLedger.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

console.log('============================================================')
console.log(' evolution ledger — proof')
console.log('============================================================')

const base = mkdtempSync(join(tmpdir(), "hermes-evolution-"))
const LEDGER_DIR = join(base, "evolution")
const PROGRAM = 'proof:patch-loop'

section('gate — default-ON, =0 opt-out, OFF ⇒ no file (byte-identical)')
{
  process.env.MERCURY_EVOLUTION_LEDGER = '0'
  check('=0 ⇒ disabled', evolutionLedgerEnabled() === false)
  const res = await writeEvolutionRow(LEDGER_DIR, { program: PROGRAM, subject: 's', outcome: 'tie' })
  check('=0 ⇒ write refuses as gated', !res.ok && /gated/.test((res as { reason: string }).reason))
  check('=0 ⇒ no ledger dir created', !existsSync(LEDGER_DIR))
  delete process.env.MERCURY_EVOLUTION_LEDGER
  check('unset on stamped build ⇒ enabled', evolutionLedgerEnabled() === true)
}

section('validation — required fields, closed taxonomy, Honest-Lying anchor gate')
{
  check('missing program refused', !(await writeEvolutionRow(LEDGER_DIR, { program: '', subject: 's', outcome: 'tie' })).ok)
  check('missing subject refused', !(await writeEvolutionRow(LEDGER_DIR, { program: PROGRAM, subject: ' ', outcome: 'tie' })).ok)
  check(
    'unknown outcome refused',
    !validateEvolutionRow({ program: PROGRAM, subject: 's', outcome: 'sideways' as never }).ok,
  )
  const noEvidence = validateEvolutionRow({ program: PROGRAM, subject: 'cand-1', outcome: 'improved' })
  check("'improved' without evidenceRefs REFUSED (anti-confabulation)", !noEvidence.ok && /evidenceRef/.test((noEvidence as { reason: string }).reason))
  check(
    "'accepted' without evidenceRefs REFUSED",
    !validateEvolutionRow({ program: PROGRAM, subject: 'cand-1', outcome: 'accepted' }).ok,
  )
  check(
    "'improved' WITH an anchor passes",
    validateEvolutionRow({ program: PROGRAM, subject: 'cand-1', outcome: 'improved', evidenceRefs: ['/tmp/gate.log'] }).ok,
  )
  check(
    "'refused'/'tie' need no anchor",
    validateEvolutionRow({ program: PROGRAM, subject: 'cand-1', outcome: 'refused' }).ok &&
      validateEvolutionRow({ program: PROGRAM, subject: 'cand-1', outcome: 'tie' }).ok,
  )
  const clamped = validateEvolutionRow({
    program: PROGRAM,
    subject: 's',
    outcome: 'tie',
    hypothesis: 'h'.repeat(2000),
    evidenceRefs: Array.from({ length: 40 }, (_, i) => `ref-${i}`),
  })
  check('oversized hypothesis clamped ≤600', clamped.ok && (clamped as { row: EvolutionRow }).row.hypothesis!.length <= 600)
  check('evidenceRefs capped at 12', clamped.ok && (clamped as { row: EvolutionRow }).row.evidenceRefs!.length === 12)
}

section('round-trip — append, read back, malformed lines skipped')
{
  const r1 = await writeEvolutionRow(LEDGER_DIR, {
    program: PROGRAM,
    subject: 'baseline-pack',
    outcome: 'baseline',
    iteration: 0,
    score: { dev: 6, holdout: 5, unit: 'scenarios' },
  })
  check('baseline row written', r1.ok)
  const r2 = await writeEvolutionRow(LEDGER_DIR, {
    program: PROGRAM,
    subject: 'cand-terse',
    outcome: 'improved',
    iteration: 1,
    hypothesis: 'shorter doctrine transfers better',
    mechanism: 'delete the redundant section',
    lineage: 'baseline-pack',
    score: { dev: 7, holdout: 6, unit: 'scenarios' },
    delta: 1,
    evidenceRefs: ['.claude/evolution/traces/iter1.jsonl', 'scripts/run-all-suites.sh: exit 0'],
  })
  check('improved row written', r2.ok)
  // a garbage line must not poison the reader
  await appendFile(getEvolutionLedgerPath(LEDGER_DIR, PROGRAM), '{not json\n', 'utf-8')
  const rows = await readEvolutionRows(LEDGER_DIR, PROGRAM)
  check('reader returns exactly the 2 valid rows', rows.length === 2, `got ${rows.length}`)
  check('lineage + mechanism survive the round-trip', rows[1]?.lineage === 'baseline-pack' && rows[1]?.mechanism === 'delete the redundant section')
  check('reader works with the gate off (read-only path ungated)', await (async () => {
    process.env.MERCURY_EVOLUTION_LEDGER = '0'
    const n = (await readEvolutionRows(LEDGER_DIR, PROGRAM)).length
    delete process.env.MERCURY_EVOLUTION_LEDGER
    return n === 2
  })())
}

section('frontier — holdout precedence, best-by-subject, dry-iteration counting')
{
  const mk = (subject: string, outcome: EvolutionRow['outcome'], iteration: number, dev?: number, holdout?: number): EvolutionRow => ({
    ts: `2026-07-0${Math.min(9, iteration + 1)}T00:00:00.000Z`,
    program: 'p',
    subject,
    outcome,
    iteration,
    ...(dev !== undefined || holdout !== undefined ? { score: { ...(dev !== undefined ? { dev } : {}), ...(holdout !== undefined ? { holdout } : {}) } } : {}),
  })
  const rows: EvolutionRow[] = [
    mk('a', 'baseline', 0, 5, 4),
    mk('b', 'improved', 1, 9, 6), // holdout 6 wins over a's 4 despite a's dev 5 < b's dev 9 anyway
    mk('c', 'regressed', 2, 8, 3),
    mk('d', 'tie', 3, 2, 6),
    mk('e', 'refused', 4),
  ]
  const f = computeEvolutionFrontier(rows)
  check('frontier metric prefers holdout', f.best?.subject === 'b' && f.best?.score === 6)
  check('bestBySubject tracks every scored subject', Object.keys(f.bestBySubject).length === 4)
  check('dryIterations counts iters since last improved (2,3,4 ⇒ 3)', f.dryIterations === 3, `got ${f.dryIterations}`)
  const summary = summarizeEvolution('p', rows)
  check('byOutcome rollup', summary.byOutcome['improved'] === 1 && summary.byOutcome['refused'] === 1)
  const report = renderEvolutionReport(summary, rows)
  check('report names the program + frontier + dry count', /evolution: p/.test(report) && /frontier\s+b @ 6/.test(report) && /dry iterations since last improvement: 3/.test(report))
}

section('concurrency — N parallel writes, zero lost rows')
{
  const prog = 'proof:concurrent'
  const N = 24
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      writeEvolutionRow(LEDGER_DIR, { program: prog, subject: `c-${i}`, outcome: 'tie', iteration: i }),
    ),
  )
  check('all writes reported ok', results.every(r => r.ok))
  const rows = await readEvolutionRows(LEDGER_DIR, prog)
  check(`all ${N} rows present after concurrent append`, rows.length === N, `got ${rows.length}`)
  check('no duplicate subjects', new Set(rows.map(r => r.subject)).size === N)
}

section('bounds — a ledger past MAX_LINES trims to the tail')
{
  const prog = 'proof:trim'
  const path = getEvolutionLedgerPath(LEDGER_DIR, prog)
  await mkdir(join(path, '..'), { recursive: true })
  // Pre-fill past the 5000-line cap with valid rows (module constants), then one
  // real write triggers the size-probed trim.
  const line = (i: number) =>
    JSON.stringify({ ts: '2026-07-01T00:00:00.000Z', program: prog, subject: `old-${i}`, outcome: 'tie' }) + '\n'
  let buf = ''
  for (let i = 0; i < 5100; i++) buf += line(i)
  await appendFile(path, buf, 'utf-8')
  const res = await writeEvolutionRow(LEDGER_DIR, { program: prog, subject: 'newest', outcome: 'tie' })
  check('write over an oversized ledger still ok', res.ok)
  const rows = await readEvolutionRows(LEDGER_DIR, prog)
  check('trimmed to ≤2501 rows', rows.length <= 2501, `got ${rows.length}`)
  check('newest row survives the trim', rows[rows.length - 1]?.subject === 'newest')
}

section('slug — distinct programs never share a ledger file')
{
  check('sanitized names stay distinct via hash suffix', slugForProgram('a/b') !== slugForProgram('a b'))
  check('slug is filesystem-safe', /^[a-zA-Z0-9._-]+$/.test(slugForProgram('weird 🦀 name!!')))
  check('taxonomy is the documented closed set', EVOLUTION_OUTCOMES.length === 7)
  check('default ledger dir rides the project-home isolation law (.mercury for a fresh root — sovereign §9)', defaultEvolutionLedgerDir('/x') === join('/x', '.mercury', 'evolution'))
}

section('VM boundary — the `ledger` script global (real hardened context)')
{
  const { buildVMContext } = await import('../../src/tools/WorkflowTool/executor.js')
  const { compileWorkflow } = await import('../../src/tools/WorkflowTool/compiler.js')
  const { makeSettle, cloneFromVM } = await import('../../src/tools/WorkflowTool/vmBoundary.js')
  const stubMakeHooks = () =>
    ({
      agent: async () => null,
      parallel: async (t: Array<() => Promise<unknown>>) => Promise.all(t.map(f => f().catch(() => null))),
      pipeline: async () => [],
      log: () => {},
      phase: () => {},
      getAgentCount: () => 0,
      getFailures: () => [],
      bindVMAwait: () => {},
    }) as never

  const SCRIPT = `export const meta = { name: 'proof-vm', description: 'proof' }
const r1 = await ledger.record({ program: 'proof:vm', subject: 'vm-cand', outcome: 'improved', iteration: 1, evidenceRefs: ['judge:scenario-1: pass'] })
const r2 = await ledger.record({ program: 'proof:vm', subject: 'vm-cand', outcome: 'improved', iteration: 1, evidenceRefs: ['judge:scenario-1: pass'] })
const rows = await ledger.read('proof:vm')
const rep = await ledger.report('proof:vm')
return { r1ok: r1.ok === true, r2deduped: r2.deduped === true, n: rows.length, anchored: rows[0].evidenceRefs.length >= 2, reported: rep.indexOf('proof:vm') >= 0 }`

  // gate ON + host injected ⇒ the global exists, records, dedupes, reports.
  const host = makeWorkflowLedgerHost(LEDGER_DIR, 'workflow-run:wf_proof · traces: /tmp/wf_proof')
  const compiled = compileWorkflow(SCRIPT.split('\n').slice(1).join('\n'))
  check('proof script compiles', compiled.ok === true)
  if (compiled.ok) {
    const { vmContext } = buildVMContext({
      makeHooks: stubMakeHooks,
      toolUseContext: {} as never,
      emitProgress: () => {},
      evolutionLedger: host,
    })
    const settled = await makeSettle(vmContext)(compiled.vmScript.runInContext(vmContext, { timeout: 5000 }))
    const out = cloneFromVM(settled.v) as Record<string, unknown>
    check('record() works from inside the realm', out.r1ok === true)
    check('resume-dedupe: identical re-record is skipped', out.r2deduped === true, JSON.stringify(out))
    check('exactly one row on disk after the dedupe', out.n === 1)
    check('host auto-appended the run evidence anchor', out.anchored === true)
    check('report() renders inside the realm', out.reported === true)
  }

  // no host injected (the gate-off wiring) ⇒ the global is ABSENT.
  const probe = compileWorkflow(`return typeof ledger`)
  if (probe.ok) {
    const { vmContext } = buildVMContext({
      makeHooks: stubMakeHooks,
      toolUseContext: {} as never,
      emitProgress: () => {},
    })
    const settled = await makeSettle(vmContext)(probe.vmScript.runInContext(vmContext, { timeout: 5000 }))
    check('no host injected ⇒ `ledger` global is absent (byte-identical surface)', settled.v === 'undefined', String(settled.v))
  }
}

section('hardening — ts coercion, byte-cap trim (fat rows under the line count)')
{
  const bad = validateEvolutionRow({ program: 'p', subject: 's', outcome: 'tie', ts: 'yesterday-ish' })
  check('garbage ts coerced to an ISO instant', bad.ok && /^\d{4}-\d{2}-\d{2}T/.test((bad as { row: EvolutionRow }).row.ts))
  const good = validateEvolutionRow({ program: 'p', subject: 's', outcome: 'tie', ts: '2026-07-02T10:00:00.000Z' })
  check('valid ts preserved verbatim', good.ok && (good as { row: EvolutionRow }).row.ts === '2026-07-02T10:00:00.000Z')

  // fat-row ledger: ~700 rows × ~7.3KB ≈ 5MB — UNDER MAX_LINES but OVER the
  // 4MB byte cap; one write must trim it to a byte-bounded tail.
  const prog = 'proof:fat-trim'
  const path = getEvolutionLedgerPath(LEDGER_DIR, prog)
  const fat = (i: number) =>
    JSON.stringify({ ts: '2026-07-01T00:00:00.000Z', program: prog, subject: `fat-${i}`, outcome: 'tie', notes: 'n'.repeat(590), hypothesis: 'h'.repeat(590), evidenceRefs: Array.from({ length: 12 }, (_, j) => `${'r'.repeat(390)}-${j}`) }) + '\n'
  let buf = ''
  for (let i = 0; i < 700; i++) buf += fat(i)
  await appendFile(path, buf, 'utf-8')
  const res = await writeEvolutionRow(LEDGER_DIR, { program: prog, subject: 'freshest', outcome: 'tie' })
  check('write over a fat ledger still ok', res.ok)
  const { statSync } = await import('node:fs')
  const after = statSync(path).size
  check('byte-cap trim bounded the file (≤ ~2MB tail)', after <= 2.2 * 1024 * 1024, `size=${after}`)
  const rows = await readEvolutionRows(LEDGER_DIR, prog)
  check('newest row survives the byte-cap trim', rows[rows.length - 1]?.subject === 'freshest')
  check('a byte-bounded tail was kept (not everything, not nothing)', rows.length > 0 && rows.length < 700, `rows=${rows.length}`)
}

section('DSL prompt — the ledger section rides the gate (the ledger addendum)')
{
  const { getWorkflowToolPrompt } = await import('../../src/tools/WorkflowTool/workflowPrompt.js')
  const { WORKFLOW_TOOL_PROMPT } = await import('../../src/tools/WorkflowTool/workflowPrompt.js')
  const on = getWorkflowToolPrompt()
  check('gate ON ⇒ prompt documents the ledger global', on.includes('## The ledger global (evolution rows)') && on.startsWith(WORKFLOW_TOOL_PROMPT))
  check('fork ⇒ prompt carries the operator doctrine addendum (model rule + verify stage)', on.includes('## Mercury workflow authorship doctrine'))
  process.env.MERCURY_EVOLUTION_LEDGER = '0'
  const off = getWorkflowToolPrompt()
  delete process.env.MERCURY_EVOLUTION_LEDGER
  // The ledger SECTION rides the ledger gate; the fork DOCTRINE addendum rides
  // the stamped build (it documents operator policy, not the ledger capability).
  check('ledger gate OFF ⇒ no ledger section (doctrine addendum remains — stamp-gated)', !off.includes('## The ledger global (evolution rows)') && off.includes('## Mercury workflow authorship doctrine') && off.startsWith(WORKFLOW_TOOL_PROMPT))
  {
    // the prompt is stamp-independent.
    const savedMacro = (globalThis as Record<string, unknown>).MACRO
    delete (globalThis as Record<string, unknown>).MACRO
    const bareStamped = getWorkflowToolPrompt()
    ;(globalThis as Record<string, unknown>).MACRO = savedMacro
    check('no MACRO ⇒ SAME prompt either way (stamp-independence)', bareStamped === getWorkflowToolPrompt())
  }
  check('the upstream constant itself carries no fork section', !WORKFLOW_TOOL_PROMPT.includes('The ledger global') && !WORKFLOW_TOOL_PROMPT.includes('Mercury doctrine'))
}

section('completion notification — <agents> trace index source pins')
{
  const { readFileSync } = await import('node:fs')
  const local = readFileSync('src/tasks/LocalWorkflowTask/LocalWorkflowTask.tsx', 'utf-8')
  check('agents section is gated on agents+transcriptDir', /if \(roster\?\.length && args\.transcriptDir\)/.test(local))
  check('agents section is in the message template', /\$\{failuresSection\}\$\{agentsSection\}\$\{usageSection\}/.test(local))
  check('rows are XML-escaped + row-capped', /AGENT_INDEX_MAX_ROWS = 24/.test(local) && /escapeXml\(bits\.join/.test(local))
  const tool = readFileSync('src/tools/WorkflowTool/WorkflowTool.tsx', 'utf-8')
  check('call site passes agents only when the gate is live', /agents: evolutionLedgerEnabled\(\)\s*\n?\s*\? buildAgentSummaries\(live\?\.workflowProgress \?\? \[\]\)\s*\n?\s*: undefined/.test(tool))
  // Comment lines may sit between the two options (Q15 documented the
  // journal beside it); the pin cares that BOTH are passed at the same call.
  check('HB-0104 part B: tokenBudget is actually passed now', /tokenBudget,\s*\n(?:\s*\/\/[^\n]*\n)*\s*journal: new LocalFileJournal/.test(tool))
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`RESULT: FAIL (${failures} check(s) failed)`)
  process.exit(1)
}
console.log('RESULT: PASS — evolution ledger holds its contract')
