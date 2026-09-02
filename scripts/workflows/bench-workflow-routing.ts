#!/usr/bin/env bun
// ============================================================================
//  scripts/workflows/bench-workflow-routing.ts — tier-ROUTED vs UNROUTED
//  dynamic-workflow benchmark: MERCURY_WORKFLOW_ROUTING's graduation evidence.
//
//  Deliberately NOT a prove-*.ts and NEVER referenced by any run-all.sh: every
//  real run spawns API-BILLED agents. Operator-invoked only.
//
//    --arm both|routed|unrouted   (default both)
//    --tasks all|id,id,…          (default all three)
//    --dry-run                    plan + cost model, nothing spawned
//    --yes                        REQUIRED for a billed run
//
//  THE CLAIM UNDER TEST: with
//  MERCURY_WORKFLOW_ROUTING=1, `agent({tier:'executor'})` stages route to
//  claude-sonnet-5 instead of inheriting the (opus) main-loop model. The pitch
//  is cost: routed executor stages should complete the SAME well-specified
//  mechanical work at equal quality for materially less money. This runner
//  measures exactly that, holding EVERYTHING else fixed:
//    · the SAME workflow script (three executor-tier stages, one per corpus
//      task, run in parallel — the product's fan-out story),
//    · the SAME child harness (-p, opus-4-8 main loop, effort high, auto
//      posture + recon allowlist, scratch MERCURY_CONFIG_DIR, clone workspace
//      pinned to bench-corpus-v1 with origin neutered),
//    · the ONLY difference: MERCURY_WORKFLOW_ROUTING=1 in the routed arm's env.
//  Success is judged FROM OUTSIDE by the replay corpus tasks' own
//  successChecks in the arm's clone (no LLM judge, no self-report). Cost is
//  read from the -p result envelope (total_cost_usd) — the envelope aggregates
//  the session including workflow subagents; wall is the child's wall.
//
//  Tasks: the three DISJOINT-FILE mechanical corpus tasks (flag-registry-row,
//  util-function, cli-hidden-flag) — parallel agents share one clone tree but
//  never touch the same files (the shared-cwd hazard is same-file self-apply).
//
//  Output: scripts/workflows/fixtures/<runId>-report.md + verdict.json
//  (the evidence artifact a future default-flip's flagRegistry `evidence:` ref
//  points at) + evolution-ledger rows (program 'workflow-routing:benchmark').
//  Criterion: routed checks == unrouted checks (equal quality) AND routed
//  cost < unrouted cost. Wall is reported, not gated (executor latency is not
//  the routing pitch).
// ============================================================================
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CORPUS_COMMIT,
  CORPUS_TAG,
  WORKSPACE_CONTAINMENT,
  benchChildEnv,
  cloneAtSha,
  judgeChecks,
  loadCorpus,
  repoRoot,
  scrubCredentials,
  scrubLingeringBenchCredentials,
  seedCredentials,
  scrubbedEnvKey,
  type CorpusTask,
} from './bench-replay.ts'

const DIST = join(repoRoot, 'dist', 'mercury.mjs')
const outDir = join(repoRoot, 'docs', 'benchmarks', 'workflow-routing')
const benchRoot = join(repoRoot, '.claude', 'bench')
const TASK_IDS = ['flag-registry-row', 'util-function', 'cli-hidden-flag'] as const

// Cost model (uncalibrated; rates verified: opus-4-8 $5/$25,
// sonnet-5 $3/$15 intro $2/$10): unrouted = 3 opus executor agents + a thin
// opus orchestrating turn; routed = the same with sonnet executors.
// CALIBRATED by the GREEN full run wfr--v4kldv: unrouted $5.79,
// routed $3.36 (unrouted came in just under the model's ceiling).
const COST_MODEL = { unroutedPerRunUsd: [4, 7] as const, routedPerRunUsd: [2, 5] as const }

const argv = process.argv.slice(2)
const getFlag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? (argv[i + 1]?.startsWith('--') ? '' : argv[i + 1]) : undefined
}
const has = (name: string): boolean => argv.includes(`--${name}`)

/** The FIXED workflow script under test. Tasks are inlined as args; every
 *  stage is an executor-tier agent — the exact surface the flag routes. */
export function buildWorkflowScript(): string {
  return `export const meta = {
  name: 'bench-tier-routing',
  description: 'benchmark: three well-specified mechanical corpus tasks, one executor-tier agent each',
  phases: [{ title: 'Execute' }],
}
const results = await parallel(args.tasks.map(t => () =>
  agent(t.prompt, { tier: 'executor', label: t.id, phase: 'Execute' })
))
return { done: results.filter(Boolean).length, of: args.tasks.length }`
}

/** The -p prompt: invoke the Workflow tool EXACTLY once with the fixed script. */
export function buildChildPrompt(tasks: CorpusTask[]): string {
  const script = buildWorkflowScript()
  const argsJson = JSON.stringify({
    tasks: tasks.map(t => ({ id: t.id, prompt: `${t.prompt}\n\n${WORKSPACE_CONTAINMENT}` })),
  })
  return (
    `Call the Workflow tool EXACTLY ONCE with the following script and args, verbatim — do not edit, ` +
    `reformat, or augment either, and do not do any of the tasks yourself. When the workflow returns, ` +
    `report its return value and stop.\n\nscript:\n${script}\n\nargs (pass as the tool's args parameter, ` +
    `as a JSON value):\n${argsJson}\n\n${WORKSPACE_CONTAINMENT}`
  )
}

type ArmRun = {
  arm: 'routed' | 'unrouted'
  wallMs: number
  costUsd?: number
  numTurns?: number
  perTask: Array<{ taskId: string; passed: number; total: number; ok: boolean }>
  checksOk: number
  error?: string
}

async function runArm(
  armName: 'routed' | 'unrouted',
  tasks: CorpusTask[],
  runDir: string,
  sha: string,
): Promise<ArmRun> {
  const clone = join(runDir, `wf-${armName}`)
  cloneAtSha(clone, sha)
  const cfgDir = join(runDir, `wf-${armName}-cfg`)
  mkdirSync(cfgDir, { recursive: true })
  seedCredentials(cfgDir)
  const { resolveWorkerReconAllow } = await import('../../src/daemon/workerRecon.ts')
  const recon = resolveWorkerReconAllow()
  const t0 = Date.now()
  let costUsd: number | undefined
  let numTurns: number | undefined
  let error: string | undefined
  try {
    const child = spawn(
      'node',
      [
        DIST,
        '-p',
        buildChildPrompt(tasks),
        '--output-format',
        'json',
        '--model',
        'claude-opus-4-8',
        '--permission-mode',
        'flow',
        // 'Workflow' rule-allow: the dynamic-workflow REVIEW prompt is an 'ask'
        // that auto-denies headless (calibration wfr-…-ovdtuo: both arms died
        // in 20s on "Review dynamic workflow before running"). The bench
        // explicitly allows the tool it is benchmarking; the workflow's AGENTS
        // still ride auto + the recon allowlist like every other child.
        ...['--allowedTools', 'Workflow', ...recon],
      ],
      {
        cwd: clone,
        env: benchChildEnv(cfgDir, {
          MERCURY_EFFORT_LEVEL: 'high',
          ...(armName === 'routed' ? { MERCURY_WORKFLOW_ROUTING: '1' } : {}),
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let out = ''
    let errBuf = ''
    child.stdout.on('data', d => (out += String(d)))
    child.stderr.on('data', d => (errBuf += String(d)))
    const exited = new Promise<void>(res => child.once('exit', () => res()))
    // The timebox timer must be CLEARED on the normal path — an armed 30-min
    // setTimeout holds bun's event loop open long after the run completes, so
    // the runner process outlives its own report (TEARDOWN-LINGER: liveness
    // checks then lie about run state).
    let timeboxHandle: ReturnType<typeof setTimeout> | undefined
    const timer = new Promise<'timeout'>(res => {
      timeboxHandle = setTimeout(() => res('timeout'), 30 * 60_000)
    })
    if ((await Promise.race([exited.then(() => 'done' as const), timer])) === 'timeout') {
      error = 'timebox (30m)'
      child.kill('SIGKILL')
      await exited
    }
    clearTimeout(timeboxHandle)
    mkdirSync(join(runDir, 'forensics'), { recursive: true })
    writeFileSync(join(runDir, 'forensics', `wf-${armName}.stderr.log`), errBuf)
    try {
      const envl = JSON.parse(out) as { total_cost_usd?: number; num_turns?: number; is_error?: boolean; subtype?: string }
      costUsd = envl.total_cost_usd
      numTurns = envl.num_turns
      if (envl.is_error) error = error ?? `result envelope is_error (${envl.subtype ?? 'unknown'})`
    } catch {
      error = error ?? 'no parsable result envelope'
    }
  } catch (e) {
    error = String(e)
  } finally {
    // Post-arm hygiene (the P2 leak: this runner's first version seeded but
    // never scrubbed — 6 payload copies lingered): the seeded credential file
    // dies with the arm, success or error. A SIGKILL'd runner still leaks —
    // the start-of-run sweep in main() cleans that residue on the next run.
    scrubCredentials(cfgDir)
  }
  const wallMs = Date.now() - t0
  const perTask = tasks.map(t => {
    const { passed, total } = judgeChecks(t, clone)
    return { taskId: t.id, passed, total, ok: passed === total }
  })
  return { arm: armName, wallMs, costUsd, numTurns, perTask, checksOk: perTask.filter(p => p.ok).length, error }
}

async function main(): Promise<void> {
  const swept = scrubLingeringBenchCredentials()
  if (swept > 0) console.log(`hygiene: scrubbed ${swept} lingering seeded credential file(s) from prior (killed) runs`)
  const arm = (getFlag('arm') ?? 'both') as 'both' | 'routed' | 'unrouted'
  const tasksArg = getFlag('tasks') ?? 'all'
  const dryRun = has('dry-run')
  const yes = has('yes')

  const { tasks: allCorpus } = loadCorpus()
  const pool = allCorpus.filter(t => (TASK_IDS as readonly string[]).includes(t.id))
  const tasks = tasksArg === 'all' ? pool : pool.filter(t => tasksArg.split(',').includes(t.id))
  if (tasks.length === 0) {
    console.error(`no tasks matched '${tasksArg}' — have: ${pool.map(t => t.id).join(', ')}`)
    process.exit(1)
  }
  // The evidence digest covers the three task specs AND the script under test.
  const h = createHash('sha256')
  for (const t of pool) h.update(t.id).update('\0').update(JSON.stringify(t))
  h.update('\0script\0').update(buildWorkflowScript())
  const evidenceSha = h.digest('hex')

  console.log('workflow tier-routing benchmark (MERCURY_WORKFLOW_ROUTING evidence)')
  console.log(`  tasks: ${tasks.map(t => t.id).join(', ')} · arm(s): ${arm} · digest ${evidenceSha.slice(0, 16)}…`)
  console.log(
    `  cost model (calibrated on a recorded run): unrouted $${COST_MODEL.unroutedPerRunUsd[0]}-${COST_MODEL.unroutedPerRunUsd[1]} + routed $${COST_MODEL.routedPerRunUsd[0]}-${COST_MODEL.routedPerRunUsd[1]} per full run`,
  )
  if (dryRun) {
    for (const t of tasks) console.log(`  · ${t.id} — ${t.title}`)
    console.log('dry-run: nothing spawned.')
    return
  }
  if (!yes) {
    console.error('refusing a billed run without --yes')
    process.exit(1)
  }
  let sha = ''
  try {
    sha = execFileSync('git', ['rev-parse', '--verify', `${CORPUS_COMMIT}^{commit}`], { cwd: repoRoot, stdio: 'pipe' }).toString().trim()
  } catch {
    console.error(`corpus commit ${CORPUS_COMMIT} (${CORPUS_TAG}) is not in this repository — fetch origin main first`)
    process.exit(1)
  }
  const runId = `wfr-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 8)}`
  const runDir = join(benchRoot, runId)
  mkdirSync(runDir, { recursive: true })
  mkdirSync(outDir, { recursive: true })
  const rawPath = join(outDir, `${runId}-raw.jsonl`)
  console.log(`  runId ${runId} · corpus @ ${sha.slice(0, 12)} · scratch ${runDir}`)

  const runs: ArmRun[] = []
  for (const a of arm === 'both' ? (['unrouted', 'routed'] as const) : ([arm] as const)) {
    console.log(`[${a}] …`)
    const r = await runArm(a, tasks, runDir, sha)
    runs.push(r)
    appendFileSync(rawPath, `${JSON.stringify(r)}\n`)
    console.log(
      `[${a}] → ${r.checksOk}/${tasks.length} tasks ok (${Math.round(r.wallMs / 1000)}s${r.costUsd !== undefined ? `, $${r.costUsd.toFixed(2)}` : ''}${r.error ? `, error: ${r.error}` : ''})`,
    )
  }

  const unrouted = runs.find(r => r.arm === 'unrouted')
  const routed = runs.find(r => r.arm === 'routed')
  const fullPool = tasks.length === pool.length
  const green =
    arm === 'both' &&
    !!routed &&
    !!unrouted &&
    routed.checksOk > 0 &&
    routed.checksOk >= unrouted.checksOk &&
    routed.costUsd !== undefined &&
    unrouted.costUsd !== undefined &&
    routed.costUsd < unrouted.costUsd

  const verdict = {
    green,
    date: new Date().toISOString(),
    flag: 'MERCURY_WORKFLOW_ROUTING',
    claim: 'executor-tier stages routed to claude-sonnet-5 complete the same mechanical corpus at equal quality for less cost',
    evidenceSha256: evidenceSha,
    corpusTag: CORPUS_TAG,
    corpusCommit: sha,
    tasks: tasks.map(t => t.id),
    unrouted: unrouted && { wallMs: unrouted.wallMs, costUsd: unrouted.costUsd, checksOk: unrouted.checksOk },
    routed: routed && { wallMs: routed.wallMs, costUsd: routed.costUsd, checksOk: routed.checksOk },
    evidenceRefs: [rawPath, join(outDir, `${runId}-report.md`)],
  }
  if (arm === 'both' && fullPool) writeFileSync(join(outDir, 'verdict.json'), JSON.stringify(verdict, null, 2))

  const scrubbed = Object.keys(process.env).filter(scrubbedEnvKey).sort()
  writeFileSync(
    join(outDir, `${runId}-report.md`),
    `# Workflow tier-routing benchmark — ${runId}\n\n` +
      `Flag \`MERCURY_WORKFLOW_ROUTING\` · corpus \`${CORPUS_TAG}\` @ \`${sha.slice(0, 12)}\` · digest \`${evidenceSha}\`\n\n` +
      `**${arm === 'both' && fullPool ? `Verdict: ${green ? 'GREEN' : 'RED'}` : 'Sample (no verdict)'}** — ` +
      runs.map(r => `${r.arm}: ${r.checksOk}/${tasks.length} ok, ${Math.round(r.wallMs / 1000)}s, ${r.costUsd !== undefined ? `$${r.costUsd.toFixed(2)}` : 'cost unobserved'}`).join(' · ') +
      `\n\nOne variable: the routed arm sets MERCURY_WORKFLOW_ROUTING=1 (executor-tier agents → claude-sonnet-5); ` +
      `identical script, tasks, clone isolation, opus-4-8@high child, auto posture + recon allowlist. ` +
      `Env scrubbed of session overrides (${scrubbed.length ? scrubbed.join(', ') : 'none present'}).\n\n` +
      `| arm | task | checks | ok |\n|---|---|---|---|\n` +
      runs.flatMap(r => r.perTask.map(p => `| ${r.arm} | ${p.taskId} | ${p.passed}/${p.total} | ${p.ok ? 'ok' : 'FAIL'} |`)).join('\n') +
      `\n\nRaw: \`${rawPath}\` · forensics: \`${runDir}\`\n`,
  )
  console.log(`report: ${join(outDir, `${runId}-report.md`)}`)
  if (arm === 'both' && fullPool) console.log(`verdict: ${green ? 'GREEN' : 'RED'} → scripts/workflows/fixtures/verdict.json`)

  try {
    if (typeof (globalThis as { MACRO?: unknown }).MACRO === 'undefined') {
      ;(globalThis as { MACRO?: { VERSION: string } }).MACRO = { VERSION: 'bench-hermes' }
    }
    const { writeEvolutionRow, defaultEvolutionLedgerDir } = await import('../../src/utils/evolution/evolutionLedger.ts')
    const res = await writeEvolutionRow(defaultEvolutionLedgerDir(repoRoot), {
      program: 'workflow-routing:benchmark',
      subject: `${runId} · ${arm} · ${tasks.length}/${pool.length} tasks`,
      outcome: arm === 'both' && fullPool ? (green ? 'improved' : 'regressed') : 'baseline',
      hypothesis: 'tier-routed executor stages (sonnet-5) match unrouted (opus) quality on well-specified mechanical work at lower cost',
      mechanism: 'MERCURY_WORKFLOW_ROUTING=1 as the single variable over a fixed workflow script',
      score: { dev: runs.reduce((a, r) => a + r.checksOk, 0), unit: 'arm-tasks-ok' },
      ...(routed?.costUsd !== undefined && unrouted?.costUsd !== undefined
        ? { delta: Math.round((unrouted.costUsd - routed.costUsd) * 100) / 100 }
        : {}),
      evidenceRefs: [join(outDir, `${runId}-report.md`), rawPath, ...(arm === 'both' && fullPool ? [join(outDir, 'verdict.json')] : [])],
      notes: runs.map(r => `${r.arm}: ${r.checksOk}/${tasks.length} ok $${r.costUsd?.toFixed(2) ?? '—'} ${Math.round(r.wallMs / 1000)}s`).join(' · '),
    })
    console.log(res.ok ? `ledger row appended (${res.path})` : `ledger row skipped: ${res.reason}`)
  } catch (e) {
    console.error(`[bench] ledger row write failed (run unaffected): ${e}`)
  }
}

if (import.meta.main) {
  await main()
}
