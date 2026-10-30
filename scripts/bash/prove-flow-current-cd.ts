import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const original = process.cwd()
const root = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'flow-current-cd-')))
const project = join(root, 'project with spaces')
const outside = join(root, 'outside')
mkdirSync(project)
mkdirSync(join(project, '.git'))
mkdirSync(outside)
writeFileSync(join(project, 'package.json'), '{"scripts":{"test":"node --test","typecheck":"tsc --noEmit"}}')
process.env.MERCURY_CONFIG_DIR = join(root, 'home')
process.chdir(project)
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { decideToolPermissionWithModes } = await import('../../src/utils/permissions/decision/wrapper.ts')
const { bashToolHasPermission } = await import('../../src/tools/BashTool/bashPermissions.ts')
const tool = { name: 'Bash', inputSchema: z.object({ command: z.string() }), checkPermissions: (input: { command: string }, context: { getAppState: () => { toolPermissionContext: unknown } }) => bashToolHasPermission(input, context.getAppState().toolPermissionContext as never) } as never
let failures = 0
async function check(label: string, command: string, allowed: boolean, rules: { ask?: string[]; deny?: string[] } = {}) {
  const state = { toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: 'flow', shouldAvoidPermissionPrompts: true, alwaysAskRules: { localSettings: rules.ask ?? [] }, alwaysDenyRules: { localSettings: rules.deny ?? [] } } }
  const context = { abortController: new AbortController(), getAppState: () => state, options: { isNonInteractiveSession: true } } as never
  const { decision } = await decideToolPermissionWithModes(tool, { command }, context, { message: { id: 'flow-current-cd' } } as never, label)
  const ok = (decision.behavior === 'allow') === allowed
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` ${JSON.stringify(decision)}`}`)
  if (!ok) failures++
}
try {
  await check('quoted current directory plus git status', `cd "${project}" && git status --short`, true)
  await check('current directory plus piped git reads', `cd "${project}" && git status --short && git status | head -3`, true)
  await check('current directory plus list and typecheck', `cd "${project}" && ls node_modules/.bin 2>/dev/null | head -5; echo "---"; npm run typecheck 2>&1 | tail -20`, true)
  await check('current directory plus bounded test repeats', `cd "${project}" && for i in 1 2 3 4 5; do npm test 2>&1 | grep -E '^tests|pass|fail'; echo "run $i done"; done && git diff --stat`, true)
  await check('read commands after current directory', `cd "${project}" && git status --short && echo '---' && git diff --stat && ls bin lib tests`, true)
  await check('other directory plus git still asks', `cd "${outside}" && git status --short`, false)
  await check('return after other directory still asks', `cd "${outside}" && cd "${project}" && git status --short`, false)
  await check('directory-changing options still ask', `cd -P "${project}" && git status --short`, false)
  await check('outside redirect still asks', `cd "${project}" && echo hi > "${outside}/x"`, false)
  await check('recursive deletion still asks', `cd "${project}" && rm -rf .git`, false)
  await check('push still asks', `cd "${project}" && git push origin main`, false)
  await check('deny rule on cd still wins', `cd "${project}" && git status --short`, false, { deny: ['Bash(cd *)'] })
  await check('ask rule on cd still wins', `cd "${project}" && git status --short`, false, { ask: ['Bash(cd *)'] })
  await check('ask rule on git still wins', `cd "${project}" && git status --short`, false, { ask: ['Bash(git status *)'] })
  rmSync(join(project, '.git'), { recursive: true })
  mkdirSync(join(project, 'objects'))
  mkdirSync(join(project, 'refs'))
  writeFileSync(join(project, 'HEAD'), 'ref: refs/heads/main\n')
  await check('current bare repository still asks', `cd "${project}" && git status --short`, false)
} finally {
  process.chdir(original)
  rmSync(root, { recursive: true, force: true })
}
process.exit(failures ? 1 : 0)
