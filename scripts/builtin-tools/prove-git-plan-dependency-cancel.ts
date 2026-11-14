import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { gitFixture } from './gitFixture.ts'

if (!process.argv.includes('--child')) {
  const wrapper = gitFixture('git-dependency-cancel-home-')
  try {
    const result = spawnSync(process.execPath, [import.meta.filename, '--child'], { env: { ...wrapper.env, GIT_PROOF_HOME: wrapper.home }, stdio: 'inherit' })
    process.exitCode = result.status ?? 1
  } finally { wrapper.dispose() }
} else {
  if (homedir() !== process.env.GIT_PROOF_HOME) throw new Error('wrong proof home before product imports')
  const { preparePlan, applyPlan, getPlan } = await import('../../src/services/gitGraph/plan.ts')
  const { makeOwnerKey } = await import('../../src/services/run/ownerKey.ts')
  const world = gitFixture('git-dependency-cancel-')
  let checks = 0
  let failures = 0
  const check = (label: string, ok: boolean, detail = '') => { checks++; if (!ok) failures++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ` — ${detail}` : ''}`) }
  const owner = makeOwnerKey({ workspace: world.root, sessionId: 'dependency-proof', lane: 'main' })
  try {
    for (const file of ['a', 'b', 'c']) world.put(file, 'old\n')
    world.git(['add', '--', 'a', 'b', 'c']); world.git(['commit', '--quiet', '-m', 'seed'])
    for (const file of ['a', 'b', 'c']) world.put(file, 'new\n')
    const input = [{ files: ['c'], message: 'third', dependsOn: [2] }, { files: ['a'], message: 'first' }, { files: ['b'], message: 'second', dependsOn: [1] }]
    const plan = preparePlan(owner, world.root, input)
    if ('reason' in plan) throw new Error(plan.reason)
    check('stored original identities are in the computed order', JSON.stringify(plan.originalGroups) === '[1,2,0]')
    input[1]!.message = 'changed after preview'
    input[1]!.files.push('c')
    input[0]!.dependsOn!.push(1)
    check('the frozen plan does not share mutable caller arrays or messages', plan.groups[0]!.message === 'first' && plan.groups[0]!.files.join() === 'a' && plan.groups[2]!.dependsOn!.join() === '2')
    let observed = 0
    const signal = { get aborted() { return ++observed > 2 } } as AbortSignal
    const result = applyPlan(owner, plan.id, { signal })
    const head = world.git(['rev-parse', 'HEAD']).trim()
    check('cancellation after one commit reports that SHA', result.state === 'refused' && result.code === 'cancelled' && result.commitsCreated?.[0]?.sha === head, JSON.stringify(result))
    check('cancellation reports original next group and transitive blocked dependent', result.state === 'refused' && result.reason.includes('first unapplied: group 2') && result.reason.includes('blocked dependents: 0'), JSON.stringify(result))
    check('recovery record agrees with the returned result', JSON.stringify(getPlan(owner, plan.id)?.recovery) === '{"firstUnapplied":2,"blockedDependents":[0],"remainingGroups":[2,0]}')
    check('unapplied file bytes remain unchanged', world.get('b') === 'new\n' && world.get('c') === 'new\n' && world.git(['show', 'HEAD:b']) === 'old\n')
    const again = applyPlan(owner, plan.id)
    check('failed plan cannot replay its committed prefix', again.state === 'refused' && world.git(['rev-parse', 'HEAD']).trim() === head)
    const resumed = preparePlan(owner, world.root, [{ files: ['c'], message: 'finish c', dependsOn: [1] }, { files: ['b'], message: 'finish b' }])
    if ('reason' in resumed) throw new Error(resumed.reason)
    check('new remainder plan commits only remaining groups', applyPlan(owner, resumed.id).state === 'applied' && world.git(['rev-parse', 'HEAD~2']).trim() === head)
    for (const file of ['a', 'b', 'c']) world.put(file, 'another\n')
    const index = readFileSync(join(world.root, '.git/index'))
    const invalid = preparePlan(owner, world.root, [{ files: ['a'], message: 'bad hunk', hunks: { a: ['gh-absent'] }, dependsOn: [] }])
    check('single-group hunk selection is checked before staging', 'reason' in invalid && invalid.reason.includes('gh-absent') && readFileSync(join(world.root, '.git/index')).equals(index), JSON.stringify(invalid))
    const fraction = preparePlan(owner, world.root, [{ files: ['a'], message: 'fraction', dependsOn: [0.5] }])
    check('service boundary never floors fractional references', 'reason' in fraction && fraction.reason.includes('whole non-negative'), JSON.stringify(fraction))
    const cycle = preparePlan(owner, world.root, [{ files: ['a'], message: 'cycle a', dependsOn: [1] }, { files: ['b'], message: 'cycle b', dependsOn: [0] }, { files: ['c'], message: 'descendant', dependsOn: [1] }])
    check('cycle names its actual members, not merely blocked descendants', 'reason' in cycle && cycle.reason === 'dependency cycle: groups 0 → 1 → 0', JSON.stringify(cycle))
  } finally { world.dispose() }
  console.log(`git dependency cancellation: ${checks - failures}/${checks}`)
  process.exitCode = failures ? 1 : 0
}
