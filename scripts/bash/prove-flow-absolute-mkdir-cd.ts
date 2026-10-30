import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const original = process.cwd()
const root = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'flow-absolute-mkdir-')))
const project = join(root, 'project')
const outside = join(root, 'outside')
mkdirSync(project)
mkdirSync(outside)
symlinkSync(outside, join(project, 'escape'), 'dir')
process.env.MERCURY_CONFIG_DIR = join(root, 'home')
process.chdir(project)
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { decideToolPermissionWithModes } = await import('../../src/utils/permissions/decision/wrapper.ts')
const { bashToolHasPermission } = await import('../../src/tools/BashTool/bashPermissions.ts')
const { getPlatform } = await import('../../src/utils/platform.ts')
const tool = { name: 'Bash', inputSchema: z.object({ command: z.string() }), checkPermissions: (input: { command: string }, context: { getAppState: () => { toolPermissionContext: unknown } }) => bashToolHasPermission(input, context.getAppState().toolPermissionContext as never) } as never
let failures = 0
async function check(label: string, command: string, allowed: boolean, deny: string[] = []) {
  const state = { toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: 'flow', shouldAvoidPermissionPrompts: true, alwaysDenyRules: { localSettings: deny } } }
  const context = { abortController: new AbortController(), getAppState: () => state, options: { isNonInteractiveSession: true } } as never
  const { decision } = await decideToolPermissionWithModes(tool, { command }, context, { message: { id: 'absolute-mkdir' } } as never, label)
  const ok = (decision.behavior === 'allow') === allowed
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` ${JSON.stringify(decision)}`}`)
  if (!ok) failures++
}
try {
  await check('literal in-project directory and read-only inspection', `mkdir -p "${project}/try" && cd "${project}/try" && pwd && ls`, true)
  await check('absolute creation is independent of the preceding directory', `cd "${project}/try" && mkdir -p "${project}/other"`, true)
  await check('outside creation still asks', `mkdir -p "${outside}/try" && cd "${outside}/try" && pwd`, false)
  await check('relative creation with cd still asks', `mkdir -p try && cd try && pwd`, false)
  await check('symlink escape still asks', `mkdir -p "${project}/escape/try" && cd "${project}/escape/try"`, false)
  await check('redirect with cd still asks', `mkdir -p "${project}/try" && cd "${project}/try" && echo x > out`, false)
  await check('deletion with cd still asks', `mkdir -p "${project}/try" && cd "${project}/try" && rm -rf other`, false)
  await check('deny rule still wins', `mkdir -p "${project}/try" && cd "${project}/try"`, false, ['Bash(mkdir *)'])
  getPlatform.cache.set(undefined, 'windows')
  await check('drive-dependent Windows slash paths still ask', `mkdir -p /project/try && cd /project/try && pwd`, false)
} finally {
  getPlatform.cache.delete(undefined)
  process.chdir(original)
  rmSync(root, { recursive: true, force: true })
}
process.exit(failures ? 1 : 0)
