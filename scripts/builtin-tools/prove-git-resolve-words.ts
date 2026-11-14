import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { gitFixture } from './gitFixture.ts'

if (!process.argv.includes('--child')) {
  const wrapper = gitFixture('git-resolve-words-home-')
  try {
    const child = spawnSync(process.execPath, [import.meta.filename, '--child'], { env: { ...wrapper.env, GIT_PROOF_HOME: wrapper.home }, stdio: 'inherit' })
    process.exitCode = child.status ?? 1
  } finally { wrapper.dispose() }
} else {
  if (homedir() !== process.env.GIT_PROOF_HOME) throw new Error('wrong proof home before product imports')
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  const { GitTool } = await import('../../src/tools/GitTool/GitTool.ts')
  const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
  const { readConflictRegions } = await import('../../src/services/gitGraph/conflictRegions.ts')
  const { processMainOwner } = await import('../../src/services/run/resolveOwner.ts')
  const { setOriginalCwd } = await import('../../src/bootstrap/state.ts')
  const { runWithCwdOverride } = await import('../../src/utils/cwd.ts')
  const { enableConfigs } = await import('../../src/utils/config.ts')
  const world = gitFixture('git-resolve-words-')
  enableConfigs(); setOriginalCwd(world.root)
  const marker = '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> other\n'
  const unknown = '<<<<<<< HEAD\nleft\n=======\ninside\n=======\nright\n>>>>>>> other\n'
  let checks = 0
  let failures = 0
  const check = (label: string, ok: boolean, detail = '') => { checks++; if (!ok) failures++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ` — ${detail}` : ''}`) }
  const context = { abortController: new AbortController(), getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext(), tasks: {}, sessionHooks: new Map() }), messages: [], options: { tools: [] } } as never
  try {
    const names = ['a.txt', 'b.txt', 'unknown.txt', 'mixed.txt']
    const seed = (text: string) => { for (const file of names) world.put(file, text); world.git(['add', '--', ...names]); world.git(['commit', '--quiet', '-m', text.trim()]) }
    seed('base\n'); world.git(['switch', '--quiet', '-c', 'other']); seed('theirs\n'); world.git(['switch', '--quiet', 'main']); seed('ours\n')
    try { world.git(['merge', '--no-edit', 'other']) } catch {}
    world.put('a.txt', marker + marker.replace('ours', 'another'))
    world.put('b.txt', marker)
    world.put('unknown.txt', marker + unknown)
    world.put('mixed.txt', marker + marker.replace('ours', 'remaining') + unknown)
    const regions = (file: string) => readConflictRegions(processMainOwner(), world.root, file)
    await runWithCwdOverride(world.root, async () => {
      const a = regions('a.txt'); const b = regions('b.txt')
      const one = { op: 'resolve' as const, resolutions: [{ region: a[0]!.id, take: 'ours' as const }] }
      const oneAsk = await GitTool.checkPermissions(one, context)
      check('one-region question names its file with a real singular', oneAsk.behavior === 'ask' && oneAsk.message === 'Git resolve 1 conflict region in a.txt', JSON.stringify(oneAsk))
      const three = await GitTool.checkPermissions({ op: 'resolve', resolutions: [...a, ...b].map(r => ({ region: r.id, take: 'ours' })) }, context)
      check('multiple-region question lists each file once with a real plural', three.behavior === 'ask' && three.message === 'Git resolve 3 conflict regions in a.txt, b.txt', JSON.stringify(three))
      const whole = await GitTool.checkPermissions({ op: 'resolve', path: 'b.txt', take: 'ours' }, context)
      check('whole-file question is unchanged', whole.behavior === 'ask' && whole.message === 'Git resolve conflict b.txt', JSON.stringify(whole))
      const needed = 'resolve needs resolutions, or path with take (ours|theirs|base|both) or content'
      check('missing selection lists every resolution form', (await GitTool.call({ op: 'resolve', path: 'b.txt' }, context)).data.result === needed)
      check('missing path uses the same complete selection sentence', (await GitTool.call({ op: 'resolve' }, context)).data.result === needed)
      const unresolved = await GitTool.call({ op: 'resolve', resolutions: [{ region: regions('unknown.txt')[0]!.id, take: 'ours' }] }, context)
      check('receipt explains an unidentified marker block instead of claiming no remainder', unresolved.data.result.includes('staged: (none); unresolved regions: unidentified marker blocks in unknown.txt — use whole-file resolve'), unresolved.data.result)
      check('unidentified blocks remain unstaged and byte-identical', world.get('unknown.txt') === 'ours\n' + unknown && world.git(['ls-files', '--unmerged', '--', 'unknown.txt']) !== '')
      const mixed = regions('mixed.txt')
      const mixedResult = await GitTool.call({ op: 'resolve', resolutions: [{ region: mixed[0]!.id, take: 'ours' }] }, context)
      check('identified remaining IDs and unidentified blocks are both named', mixedResult.data.result.includes(mixed[1]!.id) && mixedResult.data.result.includes('unidentified marker blocks in mixed.txt — use whole-file resolve'), mixedResult.data.result)
      const clean = await GitTool.call({ op: 'resolve', resolutions: [{ region: b[0]!.id, take: 'ours' }] }, context)
      check('ordinary complete receipt retains its existing words', /^resolved regions — bytes written: b\.txt; staged: b\.txt; unresolved regions: \(none\); evidence mercury:\/\/evidence\/ev-[a-f0-9]+$/.test(clean.data.result), clean.data.result)
    })
  } finally { world.dispose() }
  console.log(`Git resolve words: ${checks - failures}/${checks}`)
  process.exitCode = failures ? 1 : 0
}
