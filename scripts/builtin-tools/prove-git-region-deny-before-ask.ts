import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { gitFixture } from './gitFixture.ts'

if (!process.argv.includes('--child')) {
  const wrapper = gitFixture('git-region-preflight-home-')
  try {
    const child = spawnSync(process.execPath, [import.meta.filename, '--child'], { env: { ...wrapper.env, GIT_PROOF_HOME: wrapper.home }, stdio: 'inherit' })
    process.exitCode = child.status ?? 1
  } finally { wrapper.dispose() }
} else {
  if (homedir() !== process.env.GIT_PROOF_HOME) throw new Error('wrong proof home before product imports')
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  const world = gitFixture('git-region-preflight-')
  const { setOriginalCwd } = await import('../../src/bootstrap/state.ts')
  const { runWithCwdOverride } = await import('../../src/utils/cwd.ts')
  const { enableConfigs } = await import('../../src/utils/config.ts')
  const { GitTool } = await import('../../src/tools/GitTool/GitTool.ts')
  const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
  const { decideToolPermission } = await import('../../src/utils/permissions/decision/engine.ts')
  enableConfigs()
  setOriginalCwd(world.root)
  const marker = '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> other\n'
  const names = ['open.txt', 'locked/one.txt', 'locked/two.txt', 'secret/read.txt']
  let checks = 0
  let failures = 0
  const check = (label: string, ok: boolean, detail = '') => { checks++; if (!ok) failures++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ` — ${detail}` : ''}`) }
  try {
    mkdirSync(join(world.root, 'locked'))
    mkdirSync(join(world.root, 'secret'))
    const seed = (text: string) => { for (const file of names) world.put(file, text); world.git(['add', '--', ...names]); world.git(['commit', '--quiet', '-m', text.trim()]) }
    seed('base\n'); world.git(['switch', '--quiet', '-c', 'other']); seed('theirs\n'); world.git(['switch', '--quiet', 'main']); seed('ours\n')
    try { world.git(['merge', '--no-edit', 'other']) } catch {}
    for (const file of names) world.put(file, marker)
    const beforeIndex = readFileSync(join(world.root, '.git/index'))
    const native = join(world.root, 'locked', '**')
    const rules = process.platform === 'win32' ? [`Edit(${native})`, `Edit(${native.replaceAll('\\', '/')})`] : ['Edit(locked/**)', 'Edit(/locked/**)']
    for (const [spelling, deny] of rules.entries()) {
      for (const mode of ['default', 'dontAsk', 'sovereign'] as const) {
        const permission = { ...getEmptyToolPermissionContext(), mode, alwaysDenyRules: { session: [deny, 'Read(secret/**)'] } }
        const context = { abortController: new AbortController(), getAppState: () => ({ toolPermissionContext: permission, sessionHooks: new Map(), tasks: {} }), setAppState: () => {}, messages: [], options: { tools: [] } } as never
        await runWithCwdOverride(world.root, async () => {
          const listed = await GitTool.call({ op: 'conflicts', cwd: world.root }, context)
          const region = (file: string) => listed.data.result.slice(listed.data.result.indexOf(` ${file} (`)).match(/gr-[a-f0-9]+/)?.[0] ?? ''
          check(`${mode}/${spelling}: Read deny withholds the file and its regions`, !listed.data.result.includes('secret/read.txt') && listed.data.result.includes('1 file withheld'))
          const whole = (await decideToolPermission(GitTool as never, { op: 'resolve', cwd: world.root, path: 'locked/one.txt', content: 'denied\n' }, context)).decision
          check(`${mode}/${spelling}: whole-file control proves the Edit rule is active`, whole.behavior === 'deny' && whole.message.includes(`is denied by the rule ${deny}`), JSON.stringify(whole))
          for (const mixed of [false, true]) {
            const input = GitTool.inputSchema.parse({ op: 'resolve', cwd: world.root, resolutions: [...(mixed ? [{ region: region('open.txt'), take: 'ours' }] : []), { region: region('locked/one.txt'), content: 'denied\n' }] })
            GitTool.backfillObservableInput(input)
            const result = await decideToolPermission(GitTool as never, input, context)
            check(`${mode}/${spelling}/${mixed ? 'mixed' : 'denied'}: enriched region input is denied before an ask`, result.decision.behavior === 'deny' && result.decision.message.includes(`is denied by the rule ${deny}`) && result.trace.stages.some(stage => stage.note === 'verdict: deny'), JSON.stringify(result))
            check(`${mode}/${spelling}/${mixed ? 'mixed' : 'denied'}: all files and the index stay unchanged`, names.every(file => world.get(file) === marker) && readFileSync(join(world.root, '.git/index')).equals(beforeIndex))
          }
          const allowed = GitTool.inputSchema.parse({ op: 'resolve', cwd: world.root, resolutions: [{ region: region('open.txt'), take: 'ours' }] })
          GitTool.backfillObservableInput(allowed)
          const verdict = (await decideToolPermission(GitTool as never, allowed, context)).decision
          check(`${mode}/${spelling}: an allowed target retains the existing mode decision`, verdict.behavior === (mode === 'sovereign' ? 'allow' : 'ask'), JSON.stringify(verdict))
        })
      }
    }
    check('private preview keys do not enter the public schema', !JSON.stringify(GitTool.inputSchema).includes('resolutionPlanId'))
    const { z } = await import('zod/v4')
    const permission = getEmptyToolPermissionContext()
    const context = { abortController: new AbortController(), getAppState: () => ({ toolPermissionContext: permission, sessionHooks: new Map(), tasks: {} }), options: { tools: [] }, messages: [] } as never
    let received: unknown
    const stripping = { ...GitTool, name: 'Bash', inputSchema: z.object({ command: z.string(), timeout: z.number().default(50) }), checkPermissions: async (input: unknown) => { received = input; return { behavior: 'ask' as const, message: JSON.stringify(input) } } }
    const enriched = { command: 'pwd', preview: 'private enrichment' }
    const stripped = (await decideToolPermission(stripping as never, enriched, context)).decision
    check('successful parsing still strips enrichment and applies defaults before the verdict', JSON.stringify(received) === '{"command":"pwd","timeout":50}' && stripped.behavior === 'ask' && stripped.message === JSON.stringify(received), JSON.stringify(stripped))
    const throwing = { ...GitTool, name: 'Bash', inputSchema: z.strictObject({ command: z.string() }), checkPermissions: async (input: { command: string }) => { input.command.trim(); throw new Error('unreachable invalid control') } }
    const invalid = await decideToolPermission(throwing as never, { command: null }, context)
    check('invalid input whose verdict also throws retains the existing degraded trace', invalid.decision.behavior === 'ask' && invalid.trace.stages.some(stage => stage.note === 'resolution failed — degraded to passthrough'), JSON.stringify(invalid))
    const { FileEditTool } = await import('../../src/tools/FileEditTool/FileEditTool.ts')
    const edit = { file_path: join(world.root, 'locked/one.txt'), old_string: 'ours', new_string: 'different' }
    const editContext = { ...context as object, getAppState: () => ({ toolPermissionContext: { ...permission, alwaysDenyRules: { session: ['Edit(locked/**)'] } }, sessionHooks: new Map(), tasks: {} }) } as never
    await runWithCwdOverride(world.root, async () => {
      const parsed = FileEditTool.inputSchema.parse(edit)
      const old = await FileEditTool.checkPermissions(parsed, editContext)
      const current = (await decideToolPermission(FileEditTool as never, edit, editContext)).decision
      check('ordinary FileEdit defaulted input keeps the same deny verdict and sentence', current.behavior === 'deny' && old.behavior === 'deny' && current.message === old.message, JSON.stringify(current))
    })
  } finally { world.dispose() }
  console.log(`Git region deny before ask: ${checks - failures}/${checks}`)
  process.exitCode = failures ? 1 : 0
}
