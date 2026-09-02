#!/usr/bin/env bun
// ============================================================================
//  scripts/repo-generation/prove-repo-generation-script.ts
//  PROOF (paper-triad Slice C): the bundled DAEDALUS workflow script itself.
//
//  Static floor: the embedded string parses (parseWorkflowScript), compiles
//  (compileWorkflow), carries a well-formed meta whose phase titles match the
//  body's phase() calls, contains no forbidden-model-tier token, and trips no
//  non-determinism. The flag row's declared consumer really consumes the flag.
//
//  Behavioral floor — the WHOLE pipeline dry-runs through the REAL executor
//  (hardened VM + real themis host) with scripted stub agents, NO live API:
//    · refusals: missing themis global · absent/invalid args.model /
//      args.executorModel · missing requirements — all throw named errors.
//    · happy path: invalid architect draft EXCLUDED deterministically; the
//      CTO tie broken by fewer undeclared assumptions (arithmetic, not vibes);
// an out-of-scope lane REJECTED + requeued once; repair routed to the
//      symbol exporter; dependents requeued on publicApiImpact; trace gate
//      passes; phase machine fully ended; per-role model/isolation contract
//      held on EVERY dispatch (operator models only, worktree lanes).
//    · cap exhaustion: persistent QA issues stop at 2 repair rounds, surfaced
//      open (ok:false), test/finalize never close.
//    · budget floor: a nearly-spent token target refuses the Design fan-out.
//  Run:  ~/.bun/bin/bun run scripts/repo-generation/prove-repo-generation-script.ts
// ============================================================================
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

// Fork-sim + isolated cwd (the script's themis host audits under cwd).
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_THEMIS = 'warn'
delete process.env.MERCURY_MNEME
const scratch = mkdtempSync(join(tmpdir(), 'daedalus-script-'))
process.chdir(scratch)

const { DAEDALUS_WORKFLOW_SCRIPT } = await import('../../src/tools/WorkflowTool/bundled/daedalus.js')
const { parseWorkflowScript, compileWorkflow, scriptUsesNonDeterminism, MAX_SCRIPT_BYTES } = await import('../../src/tools/WorkflowTool/compiler.js')
const { runWorkflowScript } = await import('../../src/tools/WorkflowTool/executor.js')
const { makeThemisWorkflowHost } = await import('../../src/substrate/themis/workflowHost.js')
const { getFlagSpec } = await import('../../src/substrate/flagRegistry.js')
const { makeStubHarness } = await import('./stub-hooks.js')
const repoRoot = join(import.meta.dir, '..', '..')

console.log('============================================================')
console.log(' DAEDALUS — bundled workflow script proof (stub dry-runs)')
console.log('============================================================')

section('static floor — parse, compile, meta↔body coherence, tier token, determinism')
const parsed = parseWorkflowScript(DAEDALUS_WORKFLOW_SCRIPT)
if ('ok' in parsed && parsed.ok === false) {
  check('script parses', false, parsed.error)
  console.log('cannot continue without a parse')
  process.exit(1)
}
const meta = (parsed as { meta: { name: string; description: string; whenToUse?: string; phases?: Array<{ title: string }> } }).meta
const body = (parsed as { scriptBody: string }).scriptBody
check('script parses', true)
check('meta.name = daedalus', meta.name === 'daedalus')
check('meta.description present', typeof meta.description === 'string' && meta.description.length > 40)
check('meta.whenToUse names the operator model contract + preview-first', /executorModel/.test(meta.whenToUse ?? '') && /PREVIEW-FIRST/i.test(meta.whenToUse ?? '') && /catalogue/.test(meta.whenToUse ?? ''))
const metaTitles = (meta.phases ?? []).map(p => p.title)
const bodyTitles = [...body.matchAll(/^phase\('([^']+)'\)/gm)].map(m => m[1])
check('meta.phases ≡ the body phase() calls (Preflight included)', JSON.stringify(metaTitles) === JSON.stringify(bodyTitles) && metaTitles.length === 6 && metaTitles[0] === 'Preflight', metaTitles.join(','))
const compiled = compileWorkflow(body)
check('script compiles for the hardened VM', compiled.ok === true, compiled.ok ? '' : compiled.error)
check('no forbidden model-tier token anywhere in the script', !/haiku/i.test(DAEDALUS_WORKFLOW_SCRIPT))
check('no static non-determinism (Date.now / Math.random / new Date())', scriptUsesNonDeterminism(body) === false)
check('script well under the size ceiling', DAEDALUS_WORKFLOW_SCRIPT.length < MAX_SCRIPT_BYTES / 4)
// The model floor lives in the HOST resolver (catalogue-owned);
// the script returns a typed ask when models are absent.
check('script returns the typed needsModels ask (no hard-coded trio in-script)', /needsModels: true/.test(body) && !/\['opus', 'sonnet', 'fable'\]/.test(body))
{
  const hostSrc = readFileSync(join(repoRoot, 'src', 'tools', 'WorkflowTool', 'bundled', 'daedalus.ts'), 'utf8')
  check('HOST resolver owns the compatible set (trio + current-generation ids)', /daedalusResolveModels/.test(hostSrc) && /claude-sonnet-5/.test(hostSrc) && /claude-opus-5/.test(hostSrc))
}
{
  const spec = getFlagSpec('MERCURY_DAEDALUS')
  const consumerSrc = readFileSync(join(repoRoot, 'src', 'tools', 'WorkflowTool', 'bundled', 'index.ts'), 'utf8')
  check('flag registered opt-in/behavioral', spec?.kind === 'opt-in' && spec?.tier === 'behavioral')
  check('the declared consumer really consumes the flag', spec?.consumer === 'src/tools/WorkflowTool/bundled/index.ts' && consumerSrc.includes("flagEnabled('MERCURY_DAEDALUS')"))
}
if (!compiled.ok) {
  console.log('cannot continue without a compile')
  process.exit(1)
}
const vmScript = compiled.vmScript

// ── The dry-run harness ──────────────────────────────────────────────────────
interface RunOpts {
  respond: (label: string, prompt: string, nth: number) => unknown
  args?: unknown
  withThemis?: boolean
  tokenBudget?: { total: number | null; getTurnSpent(): number }
}
async function dryRun(o: RunOpts) {
  const harness = makeStubHarness(o.respond)
  const result = await runWorkflowScript(
    vmScript,
    { abortController: new AbortController() },
    () => {},
    {
      makeHooks: harness.makeHooks,
      args: o.args,
      themis: o.withThemis === false ? undefined : makeThemisWorkflowHost('proof-dry'),
      tokenBudget: o.tokenBudget,
    },
  )
  return { result, harness }
}
// The pipeline fixture is deliberately LARGE-class (8 musts + multi-component
// wording) so the historical 4-architect chain keeps its coverage; the
// preflight section below probes the tiny/small/medium boundaries.
const REQUIREMENTS = [
  '# Calculator service platform',
  '',
  '## Core',
  'Provide makeCore() building a calculator module with add/mul.',
  '',
  '## Interface',
  'A cli entry component prints results formatted by fmt() from the api service layer.',
  '',
  '## Acceptance',
  'The core module must expose makeCore with add and mul.',
  'The api service must expose serve() over the core.',
  'The cli component must print formatted results.',
  'fmt must format numbers stably.',
  'The server worker must reject invalid config.',
  'The library package must ship a README.',
  'Tests must cover the core and the api backend database-free.',
  'The frontend-free cli must exit non-zero on bad input.',
].join('\n')
const GOOD_ARGS = { requirements: REQUIREMENTS, model: 'opus', executorModel: 'sonnet', accept: true }

section('refusals — no themis, no models, no requirements; host resolver')
{
  const none = () => null
  const noThemis = await dryRun({ respond: none, args: GOOD_ARGS, withThemis: false })
  check('missing themis global ⇒ names MERCURY_THEMIS', typeof noThemis.result.error === 'string' && noThemis.result.error.includes('MERCURY_THEMIS'))
  const noArgs = await dryRun({ respond: none })
  const noArgsR = noArgs.result.result as { needsModels?: boolean; launched?: boolean } | undefined
  check('absent models ⇒ the typed needsModels ask (no throw, no fleet)', noArgs.result.error === undefined && noArgsR?.needsModels === true && noArgsR?.launched === false, JSON.stringify(noArgs.result))
  const noExec = await dryRun({ respond: none, args: { requirements: REQUIREMENTS, model: 'opus' } })
  const noExecR = noExec.result.result as { needsModels?: boolean } | undefined
  check('missing args.executorModel ⇒ needsModels ask', noExecR?.needsModels === true)
  const noReq = await dryRun({ respond: none, args: { model: 'opus', executorModel: 'fable' } })
  check('missing args.requirements ⇒ refused', typeof noReq.result.error === 'string' && noReq.result.error.includes('args.requirements'))
  check('refusal paths spawned zero agents', noThemis.harness.calls.length === 0 && noArgs.harness.calls.length === 0 && noExec.harness.calls.length === 0)

  // The HOST resolver (production validates BEFORE the script runs). The
  // compatible set is derived from the SIGNED-IN families (no family is
  // favoured), so the Anthropic generation keys these checks name are
  // compatible only while that family is signed in: pin a fixture
  // credential for the section, and drop the default memo so the roster
  // reads it.
  const prevAnthropicKey = process.env.ANTHROPIC_API_KEY
  process.env.ANTHROPIC_API_KEY = 'fixture-key-000'
  const { resetComputedDefaultMemo } = await import('../../src/utils/model/computedDefault.ts')
  resetComputedDefaultMemo()
  const { daedalusResolveModels, daedalusCompatibleModels } = await import('../../src/tools/WorkflowTool/bundled/daedalus.ts')
  check('host: the compatible set is derived from the signed-in families — anthropic signed in offers its generation keys', daedalusCompatibleModels().has('opus') && daedalusCompatibleModels().has('anthropic'), JSON.stringify([...daedalusCompatibleModels()]))
  const bad = daedalusResolveModels({ requirements: 'x', model: 'banana', executorModel: 'sonnet' })
  check('host: invalid explicit model refused naming the catalogue', bad.ok === false && /catalogue/.test((bad as { error: string }).error) && /banana/.test((bad as { error: string }).error))
  const prevM = process.env.MERCURY_DAEDALUS_MODEL
  const prevE = process.env.MERCURY_DAEDALUS_EXECUTOR_MODEL
  process.env.MERCURY_DAEDALUS_MODEL = 'opus'
  process.env.MERCURY_DAEDALUS_EXECUTOR_MODEL = 'sonnet'
  const injected = daedalusResolveModels({ requirements: 'x' })
  check('host: boot-saved choices injected MECHANICALLY with named provenance', injected.ok === true && (injected as { args: Record<string, unknown> }).args.model === 'opus' && String((injected as { args: Record<string, unknown> }).args.modelSource).includes('boot-menu'), JSON.stringify(injected))
  process.env.MERCURY_DAEDALUS_MODEL = 'haiku'
  const badSaved = daedalusResolveModels({ requirements: 'x' })
  check('host: an invalid SAVED choice refuses (never silently substituted)', badSaved.ok === false && /MERCURY_DAEDALUS_MODEL/.test((badSaved as { error: string }).error))
  if (prevM === undefined) delete process.env.MERCURY_DAEDALUS_MODEL; else process.env.MERCURY_DAEDALUS_MODEL = prevM
  if (prevE === undefined) delete process.env.MERCURY_DAEDALUS_EXECUTOR_MODEL; else process.env.MERCURY_DAEDALUS_EXECUTOR_MODEL = prevE
  if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevAnthropicKey
  resetComputedDefaultMemo()
}

section('preflight — preview-first, size classes, clarification; zero agents')
{
  const none = () => null
  const preview = await dryRun({ respond: none, args: { requirements: REQUIREMENTS, model: 'opus', executorModel: 'sonnet' } })
  const pr = preview.result.result as { launched?: boolean; preflight?: { sizeClass?: string; roster?: { architects?: number }; expected?: { tokenBand?: string } }; next?: string } | undefined
  check('no accept ⇒ preview returned, NOTHING dispatched', preview.harness.calls.length === 0 && pr?.launched === false && typeof pr?.next === 'string', JSON.stringify(pr))
  check('pipeline fixture classifies LARGE with 4 architects + a spend band', pr?.preflight?.sizeClass === 'large' && pr?.preflight?.roster?.architects === 4 && typeof pr?.preflight?.expected?.tokenBand === 'string', JSON.stringify(pr?.preflight))
  const tiny = await dryRun({ respond: none, args: { requirements: 'Build a single-file CLI that reverses each input line from stdin and prints it. Exit 0 on success. No config, no deps, node 20.', model: 'opus', executorModel: 'sonnet' } })
  const tr = tiny.result.result as { preflight?: { sizeClass?: string; roster?: { architects?: number; qaRoundCap?: number } } } | undefined
  check('tiny brief ⇒ ONE architect, QA cap 1 (never the max fleet)', tr?.preflight?.sizeClass === 'tiny' && tr?.preflight?.roster?.architects === 1 && tr?.preflight?.roster?.qaRoundCap === 1, JSON.stringify(tr?.preflight))
  const small = await dryRun({ respond: none, args: { requirements: 'Build a small http service exposing /health and /echo. It must log requests and must reject bodies over 1MB. Include a command-line client.', model: 'opus', executorModel: 'sonnet' } })
  const sr = small.result.result as { preflight?: { sizeClass?: string; roster?: { architects?: number } } } | undefined
  check('small brief ⇒ two design lenses', sr?.preflight?.sizeClass === 'small' && sr?.preflight?.roster?.architects === 2, JSON.stringify(sr?.preflight))
  const vague = await dryRun({ respond: none, args: { requirements: 'make me something nice', model: 'opus', executorModel: 'sonnet', accept: true } })
  const vr = vague.result.result as { needsClarification?: string[] } | undefined
  check('an ambiguous brief asks ONE bounded clarification instead of launching', Array.isArray(vr?.needsClarification) && vague.harness.calls.length === 0, JSON.stringify(vr))
  check('preview probes spawned zero agents', tiny.harness.calls.length === 0 && small.harness.calls.length === 0)
}

// ── Canned fixtures ──────────────────────────────────────────────────────────
const SDS_A = {
  tech_stack: 'node20 vanilla',
  repo_tree: ['index.js', 'lib.js', 'README.md'],
  developer_plan: ['dev-solo'],
  files: [
    { path: 'index.js', purpose: 'entry', public_api: ['main'], depends_on: ['lib.js::calc'], owner: 'dev-solo' },
    { path: 'lib.js', purpose: 'core calc', public_api: ['calc'], depends_on: [], owner: 'dev-solo' },
  ],
}
const SDS_INVALID = {
  tech_stack: 'node20 vanilla',
  repo_tree: ['main.js'],
  developer_plan: ['dev-x'],
  files: [{ path: 'main.js', purpose: 'entry', public_api: ['main'], depends_on: ['ghost.js::x'], owner: 'dev-x' }],
}
const SDS_B = {
  tech_stack: 'node20 vanilla + node:test',
  repo_tree: ['src/core.js', 'src/util.js', 'src/api.js', 'src/cli.js', 'README.md'],
  developer_plan: ['dev-core', 'dev-api'],
  files: [
    { path: 'src/core.js', purpose: 'domain core', public_api: ['makeCore'], depends_on: [], owner: 'dev-core' },
    { path: 'src/util.js', purpose: 'formatting', public_api: ['fmt'], depends_on: [], owner: 'dev-core' },
    { path: 'src/api.js', purpose: 'service layer', public_api: ['serve'], depends_on: ['src/core.js::makeCore'], owner: 'dev-api' },
    { path: 'src/cli.js', purpose: 'cli entry', public_api: ['main'], depends_on: ['src/api.js::serve', 'src/util.js::fmt'], owner: 'dev-api' },
  ],
}
const lane = (branch: string, paths: string[], briefNote: string) => ({
  done: true,
  branch,
  changedPaths: paths,
  briefs: paths.map(p => ({ file: p, publicApi: ['x'], notes: briefNote })),
  commits: paths.map(p => ({ path: p, update_reason: 'implement ' + p })),
})
const merged = (paths: string[]) => ({ done: true, mergedPaths: paths, conflicts: [] })
const qaClean = (verified: Array<{ acId: string; test: string }>) => ({ issues: [], verified, leftoverPaths: [] })
const SERVE_ISSUE = {
  symptom: 'serve rejects a valid config object',
  traceback: 'TypeError at serve()',
  suspectedFiles: ['src/cli.js', 'src/api.js'],
  symbol: 'serve',
  publicApiImpact: true,
}

function happyRespond(label: string, _prompt: string, nth: number): unknown {
  switch (label) {
    case 'architect:1': return SDS_A
    case 'architect:2': return SDS_INVALID
    case 'architect:3': return SDS_B
    case 'architect:4': return null // a skipped/failed architect is tolerated
    case 'cto:score': return {
      candidates: [
        { candidate: 1, scores: { coverage: 2, consistency: 2, feasibility: 1, modularity: 1 }, undeclaredAssumptions: 2, notes: 'tight but assumes' },
        { candidate: 2, scores: { coverage: 2, consistency: 1, feasibility: 2, modularity: 1 }, undeclaredAssumptions: 0, notes: 'clean' },
      ],
    }
    case 'cto:acceptance': return {
      criteria: [
        { id: 'AC-1', text: 'core + api behave per the requirements', files: ['src/core.js', 'src/api.js'] },
        { id: 'AC-2', text: 'cli prints formatted results', files: ['src/cli.js', 'not/in/sds.js'] },
        { id: 'AC-3', text: 'fmt output is stable', files: ['src/util.js'] },
      ],
    }
    // Layer 0 first attempt leaks an out-of-scope path ⇒ rejected + requeued.
    case 'lane:L0-dev-core': return lane('daedalus/L0-dev-core', ['src/core.js', 'src/util.js', 'src/rogue.js'], 'v1')
    case 'lane:L0-dev-core-r2': return lane('daedalus/L0-dev-core-r2', ['src/core.js', 'src/util.js'], 'v1')
    case 'lane:L1-dev-api': return lane('daedalus/L1-dev-api', ['src/api.js'], 'serve(config) validated')
    case 'lane:L2-dev-api': return lane('daedalus/L2-dev-api', ['src/cli.js'], 'main wired')
    case 'integrate:L0': return merged(['src/core.js', 'src/util.js'])
    case 'integrate:L1': return merged(['src/api.js'])
    case 'integrate:L2': return merged(['src/cli.js'])
    case 'qa:QA1-L0': return qaClean([{ acId: 'AC-3', test: 'daedalus-qa/util.test.js' }])
    case 'qa:QA1-L1': return { issues: [SERVE_ISSUE], verified: [], leftoverPaths: [] }
    case 'qa:QA1-L2': return qaClean([{ acId: 'AC-2', test: 'daedalus-qa/cli.test.js' }])
    case 'repair:R1-dev-api': return lane('daedalus/R1-dev-api', ['src/api.js'], 'serve fixed: config validation')
    case 'integrate:IR1': return merged(['src/api.js'])
    case 'qa:QA2-L0': return qaClean([{ acId: 'AC-1', test: 'daedalus-qa/core.test.js' }])
    case 'qa:QA2-L1': return qaClean([{ acId: 'AC-1', test: 'daedalus-qa/api.test.js' }])
    case 'qa:QA2-L2': return qaClean([])
    default:
      throw new Error(`unscripted agent call: ${label} (nth ${nth})`)
  }
}

section('happy dry-run — the full pipeline over scripted agents')
{
  const { result, harness } = await dryRun({ respond: happyRespond, args: GOOD_ARGS })
  check('run completed without error', result.error === undefined, result.error)
  const r = result.result as {
    ok: boolean
    design: { drafts: number; survivors: number; excluded: Array<{ architect: number; errors: string[] }>; winner: { architect: number; files: number } }
    implementation: { layers: number; lanes: Array<{ laneId: string }>; mergedPaths: string[] }
    qa: { sweeps: number; repairRounds: number; repaired: number; openIssues: unknown[] }
    trace: { ok: boolean }
    phaseMachine: { ended: string[]; iteration: number }
  }
  check('result.ok', r?.ok === true)
  check('design: 3 drafts (one architect skipped), 2 survivors', r.design.drafts === 3 && r.design.survivors === 2)
  check('design: the invalid draft EXCLUDED with UNRESOLVED_DEP', r.design.excluded.length === 1 && r.design.excluded[0]!.architect === 2 && r.design.excluded[0]!.errors.includes('UNRESOLVED_DEP'))
  check('design: CTO tie (6=6) broken by fewer undeclared assumptions ⇒ architect 3', r.design.winner.architect === 3 && r.design.winner.files === 4)
  check('implementation: 3 Kahn layers', r.implementation.layers === 3)
  check('implementation: the rejected lane was requeued once and the retry approved',
    harness.calls.some(c => c.label === 'lane:L0-dev-core') && harness.calls.some(c => c.label === 'lane:L0-dev-core-r2') && r.implementation.lanes.some(l => l.laneId === 'L0-dev-core-r2'))
  check('implementation: all four files merged', ['src/core.js', 'src/util.js', 'src/api.js', 'src/cli.js'].every(p => r.implementation.mergedPaths.includes(p)))
  check('qa: 2 sweeps, 1 repair round, 1 repaired, none open', r.qa.sweeps === 2 && r.qa.repairRounds === 1 && r.qa.repaired === 1 && r.qa.openIssues.length === 0)
  check('trace-complete gate passed', r.trace.ok === true)
  check('phase machine fully ended (spec→design→impl→test→finalize)', r.phaseMachine.ended.join(',') === 'spec,design,impl,test,finalize')
  check('dependents requeued on publicApiImpact (cli focused next sweep)', harness.logs.some(l => l.includes('requeued dependents') && l.includes('src/cli.js')))
  check('exclusion + rejection surfaced in the operator log', harness.logs.some(l => l.includes('EXCLUDED')) && harness.logs.some(l => l.includes('REJECTED')))

  // The dispatch contract: operator models only, worktree isolation exactly
  // where the plan mandates it (dev + repair lanes), never on integrators.
  const roleOf = (label: string) => label.split(':')[0]!
  const planner = new Set(['architect', 'cto', 'qa'])
  const executor = new Set(['lane', 'repair', 'integrate'])
  check('every planner/QA dispatch used args.model (opus)', harness.calls.filter(c => planner.has(roleOf(c.label))).every(c => c.opts?.model === 'opus'))
  check('every lane/integrator dispatch used args.executorModel (sonnet)', harness.calls.filter(c => executor.has(roleOf(c.label))).every(c => c.opts?.model === 'sonnet'))
  check('dev + repair lanes are worktree-isolated', harness.calls.filter(c => roleOf(c.label) === 'lane' || roleOf(c.label) === 'repair').every(c => c.opts?.isolation === 'worktree'))
  check('integrators + planners are NOT isolated (main checkout)', harness.calls.filter(c => roleOf(c.label) === 'integrate' || planner.has(roleOf(c.label))).every(c => c.opts?.isolation === undefined))
  check('no dispatch ever carried a model outside the operator set', harness.calls.every(c => c.opts?.model === 'opus' || c.opts?.model === 'sonnet'))
}

section('cap dry-run — persistent QA issues stop at 2 repair rounds, surfaced open')
{
  const capRespond = (label: string, prompt: string, nth: number): unknown => {
    if (/^qa:QA\d+-L1$/.test(label)) return { issues: [SERVE_ISSUE], verified: [], leftoverPaths: [] }
    if (/^qa:QA\d+-L0$/.test(label)) return qaClean([{ acId: 'AC-3', test: 'daedalus-qa/util.test.js' }])
    if (/^qa:QA\d+-L2$/.test(label)) return qaClean([{ acId: 'AC-2', test: 'daedalus-qa/cli.test.js' }])
    if (/^repair:R\d+-dev-api$/.test(label)) return lane('daedalus/' + label.slice('repair:'.length), ['src/api.js'], 'attempted fix')
    if (/^integrate:IR\d+$/.test(label)) return merged(['src/api.js'])
    return happyRespond(label, prompt, nth)
  }
  const { result, harness } = await dryRun({ respond: capRespond, args: GOOD_ARGS })
  check('run completed without error', result.error === undefined, result.error)
  const r = result.result as {
    ok: boolean
    qa: { sweeps: number; repairRounds: number; openIssues: unknown[] }
    phaseMachine: { ended: string[]; iteration: number }
  }
  check('result.ok is FALSE (open issues are never laundered)', r.ok === false)
  check('exactly 3 sweeps, 2 repair rounds (the P2 cap)', r.qa.sweeps === 3 && r.qa.repairRounds === 2)
  check('open issues surfaced in the result', r.qa.openIssues.length === 1)
  check('the cap is named in the operator log', harness.logs.some(l => l.includes('repair round cap 2 reached')))
  check('test/finalize never closed (impl did)', r.phaseMachine.ended.includes('impl') && !r.phaseMachine.ended.includes('test') && !r.phaseMachine.ended.includes('finalize'))
  check('the machine iteration counter mirrors the cap', r.phaseMachine.iteration === 2)
  check('no third repair round was ever dispatched', !harness.calls.some(c => c.label === 'repair:R3-dev-api'))
}

section('budget dry-run — a nearly-spent token target refuses the fleet')
{
  const { result, harness } = await dryRun({
    respond: () => null,
    args: GOOD_ARGS,
    tokenBudget: { total: 60_000, getTurnSpent: () => 55_000 },
  })
  check('refused with the budget-floor error', typeof result.error === 'string' && result.error.includes('token budget floor'))
  check('zero agents were dispatched', harness.calls.length === 0)
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(` FAIL — ${failures} check(s) failed`)
  process.exit(1)
}
console.log(' ALL DAEDALUS SCRIPT PROOFS PASS')
