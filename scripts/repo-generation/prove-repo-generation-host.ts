#!/usr/bin/env bun
// ============================================================================
//  scripts/repo-generation/prove-repo-generation-host.ts
//  PROOF (paper-triad Slice C): the `themis` workflow host + its VM seam.
//
//  The host (src/substrate/themis/workflowHost.ts) is the ONE surface the
//  DAEDALUS script reaches — every dispatcher is exercised here against the
//  real sdsContract/phases/trace libraries, adversarially where it counts:
//  every SDS violation class, phase-machine gate refusals (order, delegation,
//  security-scan, review, iteration cap), derived-scan violations WRITING
//  AUDIT ROWS, repair routing per the paper's criterion sequence, and the
//  MNEME observe bridge honest in both flag states. The VM seam is probed at
//  RUNTIME through the real executor: host absent ⇒ the global is absent
//  (byte-identical surface), host present ⇒ frozen null-proto projection with
//  boundary-cloned results.
//  Run:  ~/.bun/bin/bun run scripts/repo-generation/prove-repo-generation-host.ts
// ============================================================================
import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
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

// Fork-sim + an isolated cwd BEFORE any module touches either. The config
// home must ALSO be pinned before the first observe call: getAutoMemPath is
// memoized, so the first resolution latches for the whole process. (The SDK
// memory-path override retired with the account-service wires — the config
// home is the surviving isolation seam; the library lands under
// <memHome>/projects/<key>/memory/library, resolved via mnemeLibraryDir.)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_THEMIS = 'warn'
delete process.env.MERCURY_MNEME
const scratch = mkdtempSync(join(tmpdir(), 'daedalus-host-'))
process.chdir(scratch)
const memHome = join(scratch, 'memhome')
mkdirSync(memHome, { recursive: true })
process.env.MERCURY_CONFIG_DIR = memHome

const { makeThemisWorkflowHost } = await import('../../src/substrate/themis/workflowHost.js')
const { compileWorkflow } = await import('../../src/tools/WorkflowTool/compiler.js')
const { runWorkflowScript } = await import('../../src/tools/WorkflowTool/executor.js')
const { makeStubHarness } = await import('./stub-hooks.js')

console.log('============================================================')
console.log(' DAEDALUS — themis workflow host + VM seam proof')
console.log('============================================================')

const VALID_SDS = {
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
const mutate = (fn: (s: typeof VALID_SDS) => void): typeof VALID_SDS => {
  const c = JSON.parse(JSON.stringify(VALID_SDS)) as typeof VALID_SDS
  fn(c)
  return c
}
type Verdict = { ok: boolean; errors?: Array<{ kind: string }> }
const host = makeThemisWorkflowHost('proof-run')

section('validateSDS — the valid fixture, the string form, every violation class')
{
  const ok = (await host.validateSDS(VALID_SDS)) as Verdict
  check('valid fixture ⇒ ok', ok.ok === true)
  const okStr = (await host.validateSDS(JSON.stringify(VALID_SDS))) as Verdict
  check('valid JSON-string form ⇒ ok', okStr.ok === true)
  const kindsOf = async (v: unknown): Promise<string[]> => {
    const r = (await host.validateSDS(v)) as Verdict
    return r.ok ? [] : (r.errors ?? []).map(e => e.kind)
  }
  check('PARSE', (await kindsOf('{not json')).includes('PARSE'))
  check('MISSING_FIELD', (await kindsOf({ tech_stack: 'x' })).includes('MISSING_FIELD'))
  check('PATH_NOT_IN_TREE', (await kindsOf(mutate(s => { s.files[0]!.path = 'src/ghost.js' }))).includes('PATH_NOT_IN_TREE'))
  check('UNKNOWN_OWNER', (await kindsOf(mutate(s => { s.files[0]!.owner = 'dev-nobody' }))).includes('UNKNOWN_OWNER'))
  check('UNRESOLVED_DEP', (await kindsOf(mutate(s => { s.files[2]!.depends_on = ['src/ghost.js::x'] }))).includes('UNRESOLVED_DEP'))
  check('UNRESOLVED_SYMBOL', (await kindsOf(mutate(s => { s.files[2]!.depends_on = ['src/core.js::missing'] }))).includes('UNRESOLVED_SYMBOL'))
  check('DUPLICATE_PATH', (await kindsOf(mutate(s => { s.files.push({ ...s.files[0]! }) }))).includes('DUPLICATE_PATH'))
  check('CYCLIC', (await kindsOf(mutate(s => { s.files[0]!.depends_on = ['src/cli.js::main'] }))).includes('CYCLIC'))
}

section('normalizeSDS / topoLayers / taskPriority — the scheduler arithmetic')
type Normalized = {
  sds: typeof VALID_SDS
  ownership: Record<string, string>
  depGraph: Record<string, string[]>
}
const normalized = (await host.normalizeSDS(VALID_SDS)) as Normalized
{
  check('normalizeSDS returns the triple', !!normalized && !!normalized.ownership && !!normalized.depGraph)
  check('files canonically sorted', normalized.sds.files.map(f => f.path).join(',') === 'src/api.js,src/cli.js,src/core.js,src/util.js')
  check('ownership materialized', normalized.ownership['src/api.js'] === 'dev-api' && normalized.ownership['src/util.js'] === 'dev-core')
  const invalid = await host.normalizeSDS(mutate(s => { s.files[0]!.owner = 'dev-nobody' }) as never)
  check('normalizeSDS refuses an invalid draft (null, never repaired)', invalid === null)

  const layers = (await host.topoLayers(normalized.depGraph)) as string[][]
  check('Kahn layers', JSON.stringify(layers) === JSON.stringify([['src/core.js', 'src/util.js'], ['src/api.js'], ['src/cli.js']]))
  const cyclic = await host.topoLayers({ a: ['b'], b: ['a'] })
  check('cycle ⇒ null', cyclic === null)

  const prio = (await host.taskPriority({ depGraph: normalized.depGraph, sdsOrder: normalized.sds.files.map(f => f.path) })) as Array<{ path: string }>
  check('priority order (depth desc, fanout, SDS order)', prio.map(p => p.path).join(',') === 'src/core.js,src/api.js,src/util.js,src/cli.js')
}

section('verifyOwnership / scanDiff — derived checks, violations audited')
{
  const own = (await host.verifyOwnership({
    ownership: normalized.ownership,
    lane: { owner: 'dev-core', changedPaths: ['src/core.js', 'src/api.js', 'src/rogue.js'] },
  })) as { ok: boolean; violations: Array<{ path: string; declaredOwner: string | null }> }
  check('out-of-scope write list rejected', own.ok === false && own.violations.length === 2)
  check('violation names the foreign owner and the unowned path',
    own.violations.some(v => v.path === 'src/api.js' && v.declaredOwner === 'dev-api') &&
    own.violations.some(v => v.path === 'src/rogue.js' && v.declaredOwner === null))
  const ownOk = (await host.verifyOwnership({
    ownership: normalized.ownership,
    lane: { owner: 'dev-core', changedPaths: ['src/core.js', 'src/util.js'] },
  })) as { ok: boolean }
  check('in-scope write list passes', ownOk.ok === true)

  const scan = (await host.scanDiff({ declared: ['src/core.js', 'src/util.js'], actual: ['src/core.js', 'src/extra.js'] })) as {
    ok: boolean
    undeclared: string[]
    missing: string[]
  }
  check('scanDiff: undeclared + missing exact', scan.ok === false && scan.undeclared.join(',') === 'src/extra.js' && scan.missing.join(',') === 'src/util.js')

  // audit appends are fire-and-forget: poll until BOTH rows land, bounded 3s
  // (a blind 250ms loses the race on a loaded 2-core runner).
  const auditDir = join(scratch, '.mercury', 'themis')
  const readChain = (): string =>
    readdirSync(auditDir)
      .filter(f => f.startsWith('audit-'))
      .map(f => readFileSync(join(auditDir, f), 'utf8'))
      .join('\n')
  let chainText = ''
  for (const deadline = Date.now() + 3000; ; ) {
    try {
      chainText = readChain()
    } catch {
      chainText = ''
    }
    if ((chainText.includes('ownership-violation') && chainText.includes('scan-diff-violation')) || Date.now() > deadline) break
    await new Promise(r => setTimeout(r, 50))
  }
  check('ownership violation wrote an audit row', chainText.includes('ownership-violation'))
  check('scan-diff violation wrote an audit row', chainText.includes('scan-diff-violation'))
  check('audit rows carry the run id', chainText.includes('[proof-run]'))
}

section('routeRepair — the paper criterion sequence, through the host')
{
  type Route = { targetFile: string; owner: string; requeueDependents: boolean; decidedBy: number } | null
  const r1 = (await host.routeRepair({
    issue: { symptom: 'serve rejects valid config', suspectedFiles: ['src/cli.js', 'src/api.js'], symbol: 'serve', publicApiImpact: true },
    normalized,
  })) as Route
  check('(1) interface consistency: routes to the exporter of the named symbol',
    r1 !== null && r1.targetFile === 'src/api.js' && r1.owner === 'dev-api' && r1.decidedBy === 1 && r1.requeueDependents === true)
  const r2 = (await host.routeRepair({
    issue: { symptom: 'bad value bubbles up', suspectedFiles: ['src/cli.js', 'src/core.js'] },
    normalized,
  })) as Route
  check('(2) dependency directionality: most upstream suspect wins',
    r2 !== null && r2.targetFile === 'src/core.js' && r2.decidedBy === 2 && r2.requeueDependents === false)
  const r4 = (await host.routeRepair({
    issue: { symptom: 'same-layer flake', suspectedFiles: ['src/core.js', 'src/util.js'] },
    normalized,
  })) as Route
  check('(4) minimal scope: first in-SDS suspect, alone', r4 !== null && r4.targetFile === 'src/core.js' && r4.decidedBy === 4)
  const rNull = (await host.routeRepair({
    issue: { symptom: 'suspects all outside the SDS', suspectedFiles: ['vendor/x.js'] },
    normalized,
  })) as Route
  check('no in-SDS suspect ⇒ null (dropped loudly by the caller)', rNull === null)
}

section('phase dispatcher — every gate refusal is reachable through the host')
{
  const h = makeThemisWorkflowHost('proof-phases')
  type P = { ok: boolean; kind?: string }
  const notInit = (await h.phase({ op: 'start', phase: 'spec' })) as P
  check('op before init ⇒ NOT_INITIALIZED', notInit.ok === false && notInit.kind === 'NOT_INITIALIZED')
  const init = (await h.phase({ op: 'init', phases: [{ name: 'spec' }, { name: 'design', reviewRequired: true }, { name: 'impl' }], iterationCap: 2 })) as P
  check('init ok (mixed string/spec phases accepted)', init.ok === true)
  const unknown = (await h.phase({ op: 'no-such-op' })) as P
  check('unknown op refused', unknown.ok === false && unknown.kind === 'UNKNOWN_OP')
  const early = (await h.phase({ op: 'start', phase: 'design' })) as P
  check('starting design before spec ends ⇒ PHASE_ORDER', early.ok === false && early.kind === 'PHASE_ORDER')
  const endNoStart = (await h.phase({ op: 'end', phase: 'spec' })) as P
  check('end without start ⇒ END_WITHOUT_START', endNoStart.ok === false && endNoStart.kind === 'END_WITHOUT_START')
  check('spec start/end walk', ((await h.phase({ op: 'start', phase: 'spec' })) as P).ok === true && ((await h.phase({ op: 'end', phase: 'spec' })) as P).ok === true)
  check('design starts', ((await h.phase({ op: 'start', phase: 'design' })) as P).ok === true)
  await h.phase({ op: 'delegation', phase: 'design', receipt: { id: 'D1', wroteFiles: true, received: false } })
  const gateDeleg = (await h.phase({ op: 'end', phase: 'design' })) as P
  check('unreceipted delegation blocks the end ⇒ DELEGATION_GATE', gateDeleg.ok === false && gateDeleg.kind === 'DELEGATION_GATE')
  await h.phase({ op: 'delegation', phase: 'design', receipt: { id: 'D1', wroteFiles: true, received: true } })
  const gateScan = (await h.phase({ op: 'end', phase: 'design' })) as P
  check('file-writing delegation without a clean scan ⇒ SECURITY_SCAN_GATE', gateScan.ok === false && gateScan.kind === 'SECURITY_SCAN_GATE')
  await h.phase({ op: 'scan', phase: 'design', status: 'clean' })
  const gateReview = (await h.phase({ op: 'end', phase: 'design' })) as P
  check('reviewRequired without a verdict ⇒ REVIEW_GATE', gateReview.ok === false && gateReview.kind === 'REVIEW_GATE')
  await h.phase({ op: 'review', phase: 'design', verdict: 'approved' })
  check('approved review unblocks the end', ((await h.phase({ op: 'end', phase: 'design' })) as P).ok === true)
  check('iteration 1 and 2 pass', ((await h.phase({ op: 'iteration' })) as P).ok === true && ((await h.phase({ op: 'iteration' })) as P).ok === true)
  const capped = (await h.phase({ op: 'iteration' })) as P
  check('iteration 3 ⇒ ITERATION_CAP', capped.ok === false && capped.kind === 'ITERATION_CAP')
  const rb = (await h.phase({ op: 'rollback', phase: 'design' })) as P
  check('rollback accepted', rb.ok === true)
  const st = (await h.phase({ op: 'state' })) as { iteration: number; ended: string[] }
  check('rollback reset the iteration counter (fresh mandate) + reopened design', st.iteration === 0 && st.ended.join(',') === 'spec')
}

section('host hardening — used-machine re-init refused · malformed inputs typed, never thrown')
{
  type P = { ok: boolean; kind?: string }
  const h = makeThemisWorkflowHost('proof-hardening')
  // Re-init laundering: a machine with history cannot be reset to dodge the
  // iteration cap; a pristine machine may be harmlessly re-declared.
  check('init', ((await h.phase({ op: 'init', phases: ['a', 'b'], iterationCap: 2 })) as P).ok === true)
  check('pristine re-init allowed', ((await h.phase({ op: 'init', phases: ['a', 'b', 'c'], iterationCap: 2 })) as P).ok === true)
  await h.phase({ op: 'start', phase: 'a' })
  const reinit = (await h.phase({ op: 'init', phases: ['a'] })) as P
  check('used-machine re-init ⇒ ALREADY_INITIALIZED', reinit.ok === false && reinit.kind === 'ALREADY_INITIALIZED')
  // Malformed model-JSON through the boundary: typed results, never a TypeError.
  const malformed = await host.routeRepair({ issue: { symptom: 'x' }, normalized: { sds: {} } })
  check('routeRepair on malformed normalized ⇒ null, not a throw', malformed === null)
  const noSuspects = await host.routeRepair({ issue: {}, normalized })
  check('routeRepair with no suspectedFiles ⇒ null, not a throw', noSuspects === null)
  // Own-property membership: a dep named like a prototype member must not
  // become a phantom edge that reads as a cycle.
  const phantom = await host.topoLayers({ 'src/a.js': ['toString'], 'src/b.js': ['src/a.js'] })
  check('prototype-name dep is NOT a phantom edge (no spurious cycle)', JSON.stringify(phantom) === JSON.stringify([['src/a.js'], ['src/b.js']]))
  const dirtyGraph = await host.topoLayers({ 'src/a.js': 'not-an-array' as never, 'src/b.js': ['src/a.js'] })
  check('non-array dep value degrades to no-deps, not a TypeError', JSON.stringify(dirtyGraph) === JSON.stringify([['src/a.js'], ['src/b.js']]))
  const dirtyPrio = (await host.taskPriority({ depGraph: { a: 'junk' as never, b: ['a'] }, sdsOrder: [] })) as Array<{ path: string }>
  check('taskPriority tolerates non-array dep values', Array.isArray(dirtyPrio) && dirtyPrio.length === 2)
}

section('traceUpdate / verifyTrace — the implementation-without-test-trace gate')
{
  const h = makeThemisWorkflowHost('proof-trace')
  await h.traceUpdate({ op: 'criterion', id: 'AC-1', text: 'core behaves' })
  await h.traceUpdate({ op: 'specHash', hash: 'cafe0001' })
  const linked = (await h.traceUpdate({ op: 'file', acId: 'AC-1', path: 'src/core.js' })) as { ok: boolean }
  check('file link accepted', linked.ok === true)
  const badLink = (await h.traceUpdate({ op: 'file', acId: 'AC-404', path: 'src/core.js' })) as { ok: boolean }
  check('link to an unknown AC refused', badLink.ok === false)
  const incomplete = (await h.verifyTrace({})) as { ok: boolean; violations?: Array<{ kind: string }> }
  check('AC without a verifying test BLOCKS (NO_TESTS)', incomplete.ok === false && (incomplete.violations ?? []).some(v => v.kind === 'NO_TESTS'))
  await h.traceUpdate({ op: 'test', acId: 'AC-1', test: 'daedalus-qa/core.test.js' })
  await h.traceUpdate({ op: 'status', acId: 'AC-1', status: 'verified' })
  const complete = (await h.verifyTrace({})) as { ok: boolean }
  check('file + test linked ⇒ trace complete', complete.ok === true)
  const state = (await h.traceUpdate({ op: 'state' })) as { specHash?: string; criteria: Array<{ status: string }> }
  check('state carries specHash + verified status', state.specHash === 'cafe0001' && state.criteria[0]!.status === 'verified')
  const declared = (await h.traceUpdate({ op: 'declared' })) as { declared: string[] }
  check('declared file set derivable (for scanDiff)', declared.declared.join(',') === 'src/core.js')
}

section('observe — the MNEME bridge is honest in BOTH flag states')
{
  const { mnemeLibraryDir } = await import('../../src/memdir/mnemeGates.js')
  const libDir = mnemeLibraryDir()
  check('library resolves inside the ISOLATED home', libDir.startsWith(memHome), libDir)
  const bufPath = join(libDir, 'current.jsonl')
  const readBuf = (): string => {
    try {
      return readFileSync(bufPath, 'utf8')
    } catch {
      return ''
    }
  }
  delete process.env.MERCURY_MNEME
  const off = (await host.observe({ text: 'brief while off', source: 'daedalus' })) as { written: boolean }
  check('MERCURY_MNEME off ⇒ {written:false}', off.written === false)
  check('MERCURY_MNEME off ⇒ nothing staged', readBuf() === '')
  process.env.MERCURY_MNEME = '1'
  const on = (await host.observe({ text: 'api brief: serve(config) validated', source: 'daedalus', topicHint: 'daedalus-briefs' })) as { written: boolean }
  const buffered = readBuf()
  check('MERCURY_MNEME on ⇒ {written:true}', on.written === true)
  check('observation staged in the CURRENT buffer with source+hint', buffered.includes('api brief: serve(config) validated') && buffered.includes('"daedalus"') && buffered.includes('daedalus-briefs'))
  delete process.env.MERCURY_MNEME
}

section('VM seam — runtime probes through the REAL executor')
{
  const run = async (body: string, themis?: ReturnType<typeof makeThemisWorkflowHost>, args?: unknown) => {
    const compiled = compileWorkflow(body)
    if (!compiled.ok) throw new Error('proof body failed to compile: ' + compiled.error)
    const harness = makeStubHarness(() => null)
    return runWorkflowScript(
      compiled.vmScript,
      { abortController: new AbortController() },
      () => {},
      { makeHooks: harness.makeHooks, args, themis },
    )
  }
  const absent = await run('return typeof themis')
  check('no host injected ⇒ the global is ABSENT (byte-identical VM surface)', absent.result === 'undefined')
  const present = await run('return typeof themis', makeThemisWorkflowHost('proof-vm'))
  check('host injected ⇒ the global exists', present.result === 'object')
  const frozen = await run(
    'return { frozen: Object.isFrozen(themis), fns: Object.keys(themis).length, callable: typeof themis.validateSDS }',
    makeThemisWorkflowHost('proof-vm'),
  )
  const f = frozen.result as { frozen: boolean; fns: number; callable: string }
  check('projection is a frozen holder of the 11 host fns', f.frozen === true && f.fns === 11 && f.callable === 'function')
  const roundtrip = await run(
    'const v = await themis.validateSDS(' + JSON.stringify(VALID_SDS) + '); return { ok: v.ok, files: v.sds.files.length }',
    makeThemisWorkflowHost('proof-vm'),
  )
  const rt = roundtrip.result as { ok: boolean; files: number }
  check('validateSDS roundtrips through the boundary clone', rt.ok === true && rt.files === 4)
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(` FAIL — ${failures} check(s) failed`)
  process.exit(1)
}
console.log(' ALL DAEDALUS HOST PROOFS PASS')
