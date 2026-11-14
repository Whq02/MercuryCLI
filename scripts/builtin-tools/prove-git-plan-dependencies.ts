import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gitClient, gitFixture } from './gitFixture.ts'

const world = gitFixture('git-dependencies-')
let client: Awaited<ReturnType<typeof gitClient>> | undefined
let checks = 0
let failures = 0
const check = (label: string, ok: boolean, detail = '') => { checks++; if (!ok) failures++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ` — ${detail}` : ''}`) }
try {
  for (const f of ['base.txt', 'dependent.txt', 'independent.txt']) world.put(f, 'old\n')
  world.put('hunks.txt', Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n')
  world.git(['add', '--', 'base.txt', 'dependent.txt', 'independent.txt', 'hunks.txt'])
  world.git(['commit', '--quiet', '-m', 'seed'])
  for (const f of ['base.txt', 'dependent.txt', 'independent.txt']) world.put(f, 'new\n')
  client = await gitClient(world)
  const call = (args: Record<string, unknown>) => client!.call('Git', args)
  const groups = [
    { files: ['dependent.txt'], message: 'dependent', dependsOn: [2, 2], checks: ['not an executed check'] },
    { files: ['independent.txt'], message: 'independent' },
    { files: ['base.txt'], message: 'prerequisite' },
  ]
  const beforeHead = world.git(['rev-parse', 'HEAD'])
  const beforeIndex = readFileSync(join(world.root, '.git/index'))
  for (const [label, dependencies, words] of [
    ['self', [[0], [], []], ['group 0', 'itself']],
    ['unknown', [[7], [], []], ['group 0', '7']],
    ['cycle', [[2], [], [0]], ['cycle', '0', '2']],
    ['fractional', [[1.5], [], []], ['dependsOn']],
    ['negative', [[-1], [], []], ['dependsOn']],
  ] as const) {
    const out = await call({ op: 'plan', groups: groups.map((g, i) => ({ ...g, dependsOn: dependencies[i] })) })
    check(`M03 ${label} relation identified`, words.every(word => out.includes(word)), out)
    check(`M03 ${label} stages/commits/writes nothing`, world.git(['rev-parse', 'HEAD']) === beforeHead && readFileSync(join(world.root, '.git/index')).equals(beforeIndex) && world.get('dependent.txt') === 'new\n')
  }
  const proposed = await call({ op: 'plan', groups })
  const id = proposed.match(/gp-[a-f0-9]+/)?.[0]
  check('M01 typed prerequisites form a proposal', Boolean(id), proposed)
  check('M02 FIFO order and duplicate collapse are visible', proposed.includes('[group 1] independent') && proposed.indexOf('[group 1] independent') < proposed.indexOf('[group 2] prerequisite') && proposed.indexOf('[group 2] prerequisite') < proposed.indexOf('[group 0] dependent') && proposed.includes('depends on: 2') && !proposed.includes('depends on: 2, 2'), proposed)
  check('B01 original identities and prerequisite edges are retained', proposed.includes('[group 0] dependent') && proposed.includes('depends on: 2'), proposed)
  check('M05 preview leaves HEAD and index unchanged', world.git(['rev-parse', 'HEAD']) === beforeHead && readFileSync(join(world.root, '.git/index')).equals(beforeIndex))
  if (id) {
    const record = await client.call('Read', { file_path: `mercury://git/plan/${id}` })
    check('M04 record preserves original-to-execution order', record.includes('[group 1] independent') && record.indexOf('[group 1] independent') < record.indexOf('[group 2] prerequisite') && record.indexOf('[group 2] prerequisite') < record.indexOf('[group 0] dependent'), record)
    const verified = await call({ op: 'verify', planId: id })
    check('B02 verification says applicability/tree only, checks not run', verified.includes('applicability/tree evidence only; checks recorded, not run') && !verified.includes('passed'), verified)
    const applied = await call({ op: 'apply', planId: id })
    check('M04 displayed order is actual commit ancestry', world.git(['log', '-3', '--reverse', '--format=%s']).trim() === 'independent\nprerequisite\ndependent', applied)
    check('M05 explicit frozen plan applies once', applied.includes('APPLIED') && (await call({ op: 'apply', planId: id })).includes('already'), applied)
  } else {
    for (const row of ['M04 stored order', 'B02 honest verification', 'M04 actual order', 'M05 frozen apply']) check(row, false, 'dependency schema unavailable')
    process.exitCode = 1
  }
  if (id) {
    for (const f of ['base.txt', 'dependent.txt', 'independent.txt']) world.put(f, 'later\n')
    const partial = await call({ op: 'plan', groups: [
      { files: ['base.txt'], message: 'land first', dependsOn: [] },
      { files: ['dependent.txt'], message: 'stop here', dependsOn: [0] },
      { files: ['independent.txt'], message: 'blocked after stop', dependsOn: [1] },
    ] })
    const hook = join(world.root, '.git/hooks/prepare-commit-msg')
    writeFileSync(hook, '#!/bin/sh\nif grep -q "stop here" "$1"; then exit 1; fi\n')
    chmodSync(hook, 0o755)
    const partialId = partial.match(/gp-[a-f0-9]+/)?.[0]
    const failed = await call({ op: 'apply', planId: partialId })
    const committed = world.git(['rev-parse', 'HEAD']).trim()
    check('B03 later failure identifies committed SHA and first unapplied group', failed.includes(committed.slice(0, 8)) && failed.includes('first unapplied: group 1'), failed)
    check('B03 later failure identifies blocked dependents and unchanged remainder', failed.includes('blocked dependents: 2') && world.get('dependent.txt') === 'later\n' && world.get('independent.txt') === 'later\n', failed)
    writeFileSync(hook, '#!/bin/sh\nexit 0\n')
    const resumed = await call({ op: 'plan', groups: [
      { files: ['independent.txt'], message: 'finish dependent', dependsOn: [1] },
      { files: ['dependent.txt'], message: 'finish prerequisite' },
    ] })
    const resumedId = resumed.match(/gp-[a-f0-9]+/)?.[0]
    const resumedApply = await call({ op: 'apply', planId: resumedId })
    check('B03 replan remainder never recreates committed prefix', resumedApply.includes('APPLIED') && world.git(['rev-parse', 'HEAD~2']).trim() === committed && world.git(['log', '--format=%s']).split('\n').filter(s => s === 'land first').length === 1, resumedApply)
    const lines = world.get('hunks.txt').split('\n'); lines[2] = 'top'; lines[35] = 'bottom'; world.put('hunks.txt', lines.join('\n'))
    const diff = await call({ op: 'diff', paths: ['hunks.txt'] })
    const hunks = [...new Set(diff.match(/gh-[a-f0-9]+/g) ?? [])]
    const hunkPlan = await call({ op: 'plan', groups: [
      { files: ['hunks.txt'], hunks: { 'hunks.txt': [hunks[1]] }, message: 'bottom change', dependsOn: [1] },
      { files: ['hunks.txt'], hunks: { 'hunks.txt': [hunks[0]] }, message: 'top change' },
    ] })
    const hunkId = hunkPlan.match(/gp-[a-f0-9]+/)?.[0]
    check('M04 shared-file hunk sequence follows resolved order', hunks.length === 2 && hunkPlan.indexOf('[group 1] top change') < hunkPlan.indexOf('[group 0] bottom change') && Boolean(hunkId), hunkPlan)
    const hunkApply = await call({ op: 'apply', planId: hunkId })
    check('M04 each ordered intermediate commit contains exactly its selected hunk', hunkApply.includes('APPLIED') && world.git(['show', 'HEAD~1:hunks.txt']).includes('top\n') && !world.git(['show', 'HEAD~1:hunks.txt']).includes('bottom\n') && world.git(['show', 'HEAD:hunks.txt']).includes('bottom\n'), hunkApply)
    world.put('base.txt', 'stale before\n')
    const stalePlan = await call({ op: 'plan', groups: [{ files: ['base.txt'], message: 'stale', dependsOn: [] }] })
    const staleId = stalePlan.match(/gp-[a-f0-9]+/)?.[0]
    world.put('base.txt', 'stale after\n')
    const staleHead = world.git(['rev-parse', 'HEAD'])
    const stale = await call({ op: 'apply', planId: staleId })
    check('M05 tree drift still refuses before commit', stale.includes('stale') && world.git(['rev-parse', 'HEAD']) === staleHead && world.get('base.txt') === 'stale after\n', stale)
    const ordinary = await call({ op: 'plan', groups: [{ files: ['base.txt'], message: 'ordinary' }] })
    check('M01 omitted dependencies retain existing proposal rows', ordinary.includes('  1. ordinary — base.txt') && !ordinary.includes('[group') && !ordinary.includes('depends on:'), ordinary)
  }
} finally { await client?.close(); world.dispose() }
console.log(`git plan dependencies: ${checks - failures}/${checks}`)
process.exitCode = failures ? 1 : 0
