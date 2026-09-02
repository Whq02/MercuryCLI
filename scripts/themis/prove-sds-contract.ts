#!/usr/bin/env bun
// prove-sds-contract — CodeTeam's machine-checkable contract, unit-proved
// without agents. Every rejection class the CTO stage filters on is
// exercised, then the deterministic scheduler/ownership/repair helpers.
//
//   §1 validateSDS rejects: parse fail · missing field · path-not-in-tree ·
//      unknown owner · unresolved dep file · unresolved SYMBOL (interface
//      conflict) · duplicate path · CYCLIC graph. Accepts the valid draft.
//   §2 normalizeSDS: canonical order, deduped lists, ownership map, dep graph.
//   §3 topoLayers + taskPriority: layering correct; depth ≻ fanout ≻ SDS order.
//   §4 verifyOwnership rejects out-of-scope writes (P1's scan-diff shape).
//   §5 routeRepair follows the root-cause SEQUENCE; round cap = the paper's 2.
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const {
  REPAIR_ROUND_CAP,
  compareTaskPriority,
  normalizeSDS,
  repairRoundPermitted,
  routeRepair,
  splitDepRef,
  taskPriority,
  topoLayers,
  validateSDS,
  verifyOwnership,
} = await import('../../src/substrate/themis/sdsContract.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const errKinds = (v: { ok: boolean }): string[] =>
  v.ok ? [] : (v as { errors: Array<{ kind: string }> }).errors.map(e => e.kind)

const valid = {
  tech_stack: 'ts',
  repo_tree: ['src/core.ts', 'src/api.ts', 'src/app.ts'],
  developer_plan: ['dev-a', 'dev-b'],
  files: [
    { path: 'src/core.ts', purpose: 'kernel', public_api: ['boot', 'boot', 'shutdown'], depends_on: [], owner: 'dev-a' },
    { path: 'src/api.ts', purpose: 'api', public_api: ['serve'], depends_on: ['src/core.ts::boot'], owner: 'dev-b' },
    { path: 'src/app.ts', purpose: 'app', public_api: ['main'], depends_on: ['src/api.ts::serve', 'src/core.ts'], owner: 'dev-a' },
  ],
}
const mutate = (fn: (c: typeof valid) => void): typeof valid => {
  const c = JSON.parse(JSON.stringify(valid)) as typeof valid
  fn(c)
  return c
}

section('§1 validateSDS — every rejection class')
check('valid draft accepted', validateSDS(valid).ok)
check('valid JSON string accepted', validateSDS(JSON.stringify(valid)).ok)
check('PARSE: broken JSON', errKinds(validateSDS('{not json')).includes('PARSE'))
check('BAD_SHAPE: array root', errKinds(validateSDS([1, 2])).includes('BAD_SHAPE'))
check('MISSING_FIELD: no developer_plan', errKinds(validateSDS(mutate(c => { delete (c as Record<string, unknown>).developer_plan }))).includes('MISSING_FIELD'))
check('PATH_NOT_IN_TREE', errKinds(validateSDS(mutate(c => { c.files[0]!.path = 'src/ghost.ts' }))).includes('PATH_NOT_IN_TREE'))
check('UNKNOWN_OWNER', errKinds(validateSDS(mutate(c => { c.files[1]!.owner = 'dev-z' }))).includes('UNKNOWN_OWNER'))
check('UNRESOLVED_DEP: undeclared file', errKinds(validateSDS(mutate(c => { c.files[1]!.depends_on = ['src/ghost.ts::x'] }))).includes('UNRESOLVED_DEP'))
check('UNRESOLVED_SYMBOL: interface conflict', errKinds(validateSDS(mutate(c => { c.files[1]!.depends_on = ['src/core.ts::reboot'] }))).includes('UNRESOLVED_SYMBOL'))
check('DUPLICATE_PATH', errKinds(validateSDS(mutate(c => { c.files.push({ ...c.files[0]! }) }))).includes('DUPLICATE_PATH'))
check('CYCLIC: core→app→…→core', errKinds(validateSDS(mutate(c => { c.files[0]!.depends_on = ['src/app.ts::main'] }))).includes('CYCLIC'))
check('all errors reported, not just the first',
  errKinds(validateSDS(mutate(c => { c.files[0]!.path = 'src/ghost.ts'; c.files[1]!.owner = 'dev-z' }))).length >= 2)
check('splitDepRef: bare file ref carries no symbol', splitDepRef('./src\\core.ts').file === 'src/core.ts' && splitDepRef('a.ts::x').symbol === 'x')

section('§2 normalizeSDS — the single source of truth')
{
  const n = normalizeSDS(valid as never)!
  check('normalize accepts the valid draft', n !== null)
  check('files canonically sorted', n.sds.files.map(f => f.path).join(',') === 'src/api.ts,src/app.ts,src/core.ts')
  check('public_api deduped', n.sds.files.find(f => f.path === 'src/core.ts')!.public_api.join(',') === 'boot,shutdown')
  check('ownership materialized', n.ownership['src/api.ts'] === 'dev-b' && n.ownership['src/core.ts'] === 'dev-a')
  check('file-level dep graph collapsed', n.depGraph['src/app.ts']!.join(',') === 'src/api.ts,src/core.ts')
  check('normalize refuses an invalid draft', normalizeSDS(mutate(c => { c.files[1]!.owner = 'dev-z' }) as never) === null)
}

section('§3 topoLayers + taskPriority')
{
  const n = normalizeSDS(valid as never)!
  const layers = topoLayers(n.depGraph)!
  check('3 layers: core → api → app', JSON.stringify(layers) === JSON.stringify([['src/core.ts'], ['src/api.ts'], ['src/app.ts']]))
  check('cycle ⇒ null', topoLayers({ a: ['b'], b: ['a'] }) === null)
  const prio = taskPriority(n.depGraph, valid.files.map(f => f.path))
  check('deepest-unblocking file first', prio[0]!.path === 'src/core.ts' && prio[0]!.depth === 2, JSON.stringify(prio))
  check('depth ≻ fanout ≻ order', compareTaskPriority(
    { path: 'x', depth: 1, fanout: 9, order: 9 },
    { path: 'y', depth: 2, fanout: 0, order: 0 },
  ) > 0)
  check('fanout breaks equal depth', compareTaskPriority(
    { path: 'x', depth: 1, fanout: 3, order: 9 },
    { path: 'y', depth: 1, fanout: 1, order: 0 },
  ) < 0)
  check('SDS order breaks the rest', compareTaskPriority(
    { path: 'x', depth: 1, fanout: 1, order: 0 },
    { path: 'y', depth: 1, fanout: 1, order: 4 },
  ) < 0)
}

section('§4 verifyOwnership — exclusive lanes, derived check')
{
  const n = normalizeSDS(valid as never)!
  check('in-scope lane passes', verifyOwnership(n.ownership, { owner: 'dev-a', changedPaths: ['src/core.ts', 'src/app.ts'] }).ok)
  const cross = verifyOwnership(n.ownership, { owner: 'dev-a', changedPaths: ['src/core.ts', 'src/api.ts'] })
  check('cross-owner write rejected', !cross.ok && cross.violations[0]!.declaredOwner === 'dev-b')
  const undeclared = verifyOwnership(n.ownership, { owner: 'dev-a', changedPaths: ['src/rogue.ts'] })
  check('undeclared path rejected (scope creep)', !undeclared.ok && undeclared.violations[0]!.declaredOwner === null)
}

section('§5 routeRepair — the root-cause sequence + the round cap')
{
  const n = normalizeSDS(valid as never)!
  const r1 = routeRepair({ symptom: 'import error', suspectedFiles: ['src/app.ts', 'src/core.ts'], symbol: 'boot', publicApiImpact: true }, n)!
  check('(1) symbol routes to its EXPORTER', r1.targetFile === 'src/core.ts' && r1.decidedBy === 1, JSON.stringify(r1))
  check('public-API impact requeues dependents', r1.requeueDependents === true)
  const r2 = routeRepair({ symptom: 'wrong value', suspectedFiles: ['src/app.ts', 'src/api.ts'] }, n)!
  check('(2) most upstream suspect wins', r2.targetFile === 'src/api.ts' && r2.decidedBy === 2, JSON.stringify(r2))
  check('no API impact ⇒ no requeue', r2.requeueDependents === false)
  const r3 = routeRepair({ symptom: 'flaky', suspectedFiles: ['src/ghost.ts', 'src/app.ts'] }, n)!
  check('(3) non-SDS suspects dropped + named', r3.targetFile === 'src/app.ts' && r3.rationale.includes('ghost'), JSON.stringify(r3))
  const r4 = routeRepair({ symptom: 'style', suspectedFiles: ['src/app.ts'] }, n)!
  check('(4) minimal scope: single suspect routes to it', r4.targetFile === 'src/app.ts' && r4.owner === 'dev-a')
  check('all suspects outside the SDS ⇒ null', routeRepair({ symptom: 'x', suspectedFiles: ['a.ts'] }, n) === null)
  check('round cap = the paper’s 2', REPAIR_ROUND_CAP === 2 && repairRoundPermitted(2) && !repairRoundPermitted(3))
}

console.log('\n' + '═'.repeat(76))
if (failures) {
  console.log(`❌ ${failures} SDS-CONTRACT PROOF FAILURE(S)`)
  process.exit(1)
}
console.log('✅ ALL SDS-CONTRACT PROOFS PASS')
