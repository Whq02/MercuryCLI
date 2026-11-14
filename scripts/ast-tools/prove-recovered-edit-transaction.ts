import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { gitFixture } from '../builtin-tools/gitFixture.ts'

if (!process.argv.includes('--child')) {
  const wrapper = gitFixture('ast-recovery-transaction-home-')
  try {
    const child = spawnSync(process.execPath, [import.meta.filename, '--child'], { env: { ...wrapper.env, AST_PROOF_HOME: wrapper.home, MERCURY_TREESITTER_VENDOR_DIR: resolve(import.meta.dirname, '../../dist/vendor/treesitter'), MERCURY_BARE: '1' }, stdio: 'inherit' })
    process.exitCode = child.status ?? 1
  } finally { wrapper.dispose() }
} else {
  if (homedir() !== process.env.AST_PROOF_HOME) throw new Error('wrong proof home before product imports')
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  const { AstEditTool } = await import('../../src/tools/AstEditTool/AstEditTool.ts')
  const { _setBeforeRenameHookForProofs } = await import('../../src/services/changeTransaction/changeSetCommit.ts')
  const { drive, enterRoot, makeContext } = await import('./lib/harness.ts')
  const world = gitFixture('ast-recovery-transaction-')
  const launch = process.cwd()
  let checks = 0
  let failures = 0
  const check = (label: string, ok: boolean, detail = '') => { checks++; if (!ok) failures++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ` — ${detail}` : ''}`) }
  const source = 'const broken = ;\nneedle(1);\n'
  try {
    world.put('a.ts', source); world.put('b.ts', source)
    await enterRoot(world.root)
    const context = await makeContext([AstEditTool], { allow: ['AstEdit'] })
    const input = { pattern: 'needle($X)', rewrite: 'found($X)', path: '.' }
    const preview = await drive(AstEditTool, input, context)
    const token = preview.data?.plan as string | undefined
    check('two recovered files form one exact preview', preview.data?.state === 'dry-run' && preview.data?.fileCount === 2 && Boolean(token), preview.text)
    let sawFailure = false
    _setBeforeRenameHookForProofs(file => { if (file === join(world.root, 'b.ts')) { sawFailure = true; throw new Error('injected recovered-file failure') } })
    const failed = token ? await drive(AstEditTool, { ...input, apply: true, plan: token }, context) : preview
    _setBeforeRenameHookForProofs(null)
    check('later member failure returns the verified rollback receipt', sawFailure && failed.isError && failed.text.includes('every touched file was restored') && failed.text.includes('VERIFIED'), failed.text)
    check('rollback restores both damaged source files exactly', world.get('a.ts') === source && world.get('b.ts') === source)
    let sawDrift = false
    _setBeforeRenameHookForProofs(file => { if (file === join(world.root, 'b.ts')) { sawDrift = true; world.put('b.ts', source + '// concurrent\n') } })
    const drift = token ? await drive(AstEditTool, { ...input, apply: true, plan: token }, context) : preview
    _setBeforeRenameHookForProofs(null)
    check('a late member drift restores earlier bytes and keeps concurrent work', sawDrift && drift.isError && drift.text.includes('Stale') && world.get('a.ts') === source && world.get('b.ts') === source + '// concurrent\n', drift.text)
    world.put('b.ts', source)
    const cancelled = await makeContext([AstEditTool], { allow: ['AstEdit'] })
    ;(cancelled.ctx.abortController as AbortController).abort()
    const cancel = token ? await drive(AstEditTool, { ...input, apply: true, plan: token }, cancelled) : preview
    check('cancellation before writing leaves every source unchanged', cancel.isError && world.get('a.ts') === source && world.get('b.ts') === source, cancel.text)
  } finally { _setBeforeRenameHookForProofs(null); process.chdir(launch); world.dispose() }
  console.log(`Recovered edit transaction: ${checks - failures}/${checks}`)
  process.exitCode = failures ? 1 : 0
}
