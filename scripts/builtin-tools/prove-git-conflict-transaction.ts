import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { gitFixture } from './gitFixture.ts'

if (!process.argv.includes('--child')) {
  const wrapper = gitFixture('git-conflict-transaction-home-')
  try {
    const result = spawnSync(process.execPath, [import.meta.filename, '--child'], { env: { ...wrapper.env, GIT_PROOF_HOME: wrapper.home }, stdio: 'inherit' })
    process.exitCode = result.status ?? 1
  } finally { wrapper.dispose() }
} else {
  if (homedir() !== process.env.GIT_PROOF_HOME) throw new Error('wrong proof home before product imports')
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  const { readConflictRegions, prepareResolution, applyResolution, resolutionPreview } = await import('../../src/services/gitGraph/conflictRegions.ts')
  const { _setBeforeRenameHookForProofs } = await import('../../src/services/changeTransaction/changeSetCommit.ts')
  const { makeOwnerKey } = await import('../../src/services/run/ownerKey.ts')
  const { renderToolUseMessage } = await import('../../src/tools/GitTool/UI.tsx')
  const { GitTool } = await import('../../src/tools/GitTool/GitTool.ts')
  const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
  const { zodToJsonSchema } = await import('../../src/utils/zodToJsonSchema.ts')
  console.log(`Git schema: ${JSON.stringify(zodToJsonSchema(GitTool.inputSchema)).length} characters; base 4167`)

  const world = gitFixture('git-conflict-transaction-')
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: world.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@example.invalid', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@example.invalid' })
  const owner = makeOwnerKey({ workspace: world.root, sessionId: 'region-proof', lane: 'main' })
  const marker = '<<<<<<< ours\nleft\n||||||| base\nold\n=======\nright\n>>>>>>> theirs\n'
  let checks = 0
  let failures = 0
  const check = (label: string, ok: boolean, detail = '') => { checks++; if (!ok) failures++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ` — ${detail}` : ''}`) }
  try {
    for (const file of ['a.txt', 'b.txt']) world.put(file, 'base\n')
    world.git(['add', '--', 'a.txt', 'b.txt']); world.git(['commit', '--quiet', '-m', 'base'])
    world.git(['switch', '--quiet', '-c', 'other'])
    for (const file of ['a.txt', 'b.txt']) world.put(file, 'other\n')
    world.git(['add', '--', 'a.txt', 'b.txt']); world.git(['commit', '--quiet', '-m', 'other'])
    world.git(['switch', '--quiet', 'main'])
    for (const file of ['a.txt', 'b.txt']) world.put(file, 'main\n')
    world.git(['add', '--', 'a.txt', 'b.txt']); world.git(['commit', '--quiet', '-m', 'main'])
    try { world.git(['merge', '--no-edit', 'other']) } catch {}
    for (const file of ['a.txt', 'b.txt']) world.put(file, marker)
    const beforeIndex = readFileSync(join(world.root, '.git/index'))
    const choices = ['a.txt', 'b.txt'].map(file => ({ region: readConflictRegions(owner, world.root, file)[0]!.id, content: 'left\r\nleft\n' }))
    const prepare = () => {
      const plan = prepareResolution(owner, world.root, choices)
      if ('reason' in plan) throw new Error(plan.reason)
      return plan
    }
    const plan = prepare()
    const shown = resolutionPreview(plan)
    const card = renderToolUseMessage({ op: 'resolve', resolutions: choices, resolutionPreview: shown }, { verbose: true })
    check('the existing card contains exact escaped replacement bytes for both files', typeof card === 'string' && card.includes('"left\\r\\nleft\\n"') && card.includes('a.txt:1-7') && card.includes('b.txt:1-7'), String(card))
    check('permission preparation writes nothing', world.get('a.txt') === marker && world.get('b.txt') === marker && readFileSync(join(world.root, '.git/index')).equals(beforeIndex))
    world.put('b.txt', marker + 'concurrent\n')
    const drift = await applyResolution(plan)
    check('drift after the card preserves every file and the index', drift.state === 'refused' && drift.reason.includes('stale') && world.get('a.txt') === marker && world.get('b.txt') === marker + 'concurrent\n' && readFileSync(join(world.root, '.git/index')).equals(beforeIndex), JSON.stringify(drift))
    world.put('b.txt', marker)
    const cancel = new AbortController(); cancel.abort()
    const cancelled = await applyResolution(prepare(), cancel.signal)
    check('cancellation before writing preserves every file and index', cancelled.state === 'refused' && cancelled.reason.includes('cancelled') && world.get('a.txt') === marker && readFileSync(join(world.root, '.git/index')).equals(beforeIndex))
    let touched = 0
    _setBeforeRenameHookForProofs(file => { touched++; if (file === join(world.root, 'b.txt')) throw new Error('injected second file failure') })
    const failed = await applyResolution(prepare())
    _setBeforeRenameHookForProofs(null)
    check('a failed later write restores both files and the binary index', touched >= 2 && failed.state === 'refused' && failed.reason.includes('failed-restored') && world.get('a.txt') === marker && world.get('b.txt') === marker && readFileSync(join(world.root, '.git/index')).equals(beforeIndex), JSON.stringify(failed))
    _setBeforeRenameHookForProofs(file => { if (file === join(world.root, 'b.txt')) world.put('b.txt', marker + 'raced\n') })
    const raced = await applyResolution(prepare())
    _setBeforeRenameHookForProofs(null)
    check('mid-write drift preserves new bytes and restores the earlier file and index', raced.state === 'refused' && raced.reason.includes('stale') && world.get('a.txt') === marker && world.get('b.txt') === marker + 'raced\n' && readFileSync(join(world.root, '.git/index')).equals(beforeIndex), JSON.stringify(raced))
    world.put('b.txt', marker)
    const done = await applyResolution(prepare())
    check('success writes exactly the displayed bytes and stages both final files', done.state === 'ok' && world.get('a.txt') === 'left\r\nleft\n' && world.get('b.txt') === 'left\r\nleft\n' && world.git(['ls-files', '--unmerged']) === '', JSON.stringify(done))
    check('staged bytes agree with the exact worktree content', world.git(['show', ':a.txt']) === world.get('a.txt') && world.git(['show', ':b.txt']) === world.get('b.txt'))
    const otherOwner = makeOwnerKey({ workspace: world.root, sessionId: 'other', lane: 'main' })
    check('region identities are owner scoped', 'reason' in prepareResolution(otherOwner, world.root, choices))
    world.put('a.txt', marker + 'gap\n' + marker)
    const twins = readConflictRegions(owner, world.root, 'a.txt')
    world.put('a.txt', 'gap\n' + marker)
    const remaining = readConflictRegions(owner, world.root, 'a.txt')
    check('externally removed duplicate IDs never silently select a different duplicate', twins.every(t => !remaining.some(r => r.id === t.id)))
    world.put('a.txt', marker.replace('>>>>>>> theirs\n', '>>>>>>> theirs'))
    check('marker at EOF without final newline is complete', readConflictRegions(owner, world.root, 'a.txt').length === 1)
    world.put('a.txt', '<<<<<<< outer\n' + marker + '=======\nother\n>>>>>>> outer\n')
    check('nested malformed markers are not resolvable regions', readConflictRegions(owner, world.root, 'a.txt').length === 0)
    const malformed = await GitTool.validateInput?.({ op: 'resolve', path: 'a.txt', resolutions: choices } as never)
    check('whole-file and region selectors do not mix', malformed?.result === false)
    check('ordinary whole-file schema remains accepted with base and both', GitTool.inputSchema.safeParse({ op: 'resolve', path: 'a.txt', take: 'base' }).success && GitTool.inputSchema.safeParse({ op: 'resolve', path: 'a.txt', take: 'both' }).success)
    check('ordinary permission mode is unchanged', getEmptyToolPermissionContext().mode === 'default')
  } finally { _setBeforeRenameHookForProofs(null); world.dispose() }
  console.log(`git conflict transaction: ${checks - failures}/${checks}`)
  process.exitCode = failures ? 1 : 0
}
