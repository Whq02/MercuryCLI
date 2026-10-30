import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const original = process.cwd()
const root = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'flow-checked-groups-')))
const project = join(root, 'project')
mkdirSync(project)
process.env.MERCURY_CONFIG_DIR = join(root, 'home')
process.chdir(project)
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { decideToolPermissionWithModes } = await import('../../src/utils/permissions/decision/wrapper.ts')
const { bashToolHasPermission } = await import('../../src/tools/BashTool/bashPermissions.ts')
const tool = { name: 'Bash', inputSchema: z.object({ command: z.string() }), checkPermissions: (input: { command: string }, context: { getAppState: () => { toolPermissionContext: unknown } }) => bashToolHasPermission(input, context.getAppState().toolPermissionContext as never) } as never
let failures = 0
async function check(label: string, command: string, allowed: boolean, deny: string[] = []) {
  const state = { toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: 'flow', shouldAvoidPermissionPrompts: true, alwaysDenyRules: { localSettings: deny } } }
  const context = { abortController: new AbortController(), getAppState: () => state, options: { isNonInteractiveSession: true } } as never
  const { decision } = await decideToolPermissionWithModes(tool, { command }, context, { message: { id: 'checked-groups' } } as never, label)
  const ok = (decision.behavior === 'allow') === allowed
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` ${JSON.stringify(decision)}`}`)
  if (!ok) failures++
}
try {
  await check('read-only brace group', '{ echo "start"; pwd; ls; }', true)
  await check('bounded t4 stability loop with failure group', 'for i in $(seq 1 50); do npm test --silent 2>&1 | grep -q "fail 0" || { echo "RUN $i FAILED"; npm test 2>&1 | tail -20; break; }; done; echo "50-run loop done"', true)
  await check('bounded t4 counter and reporting group', 'fail=0; for i in $(seq 1 30); do npm test >/dev/null 2>&1 || { fail=$((fail+1)); echo "run $i FAILED"; }; done; echo "failures: $fail / 30"', true)
  await check('quoted brace expansion is not a group', 'echo {a,"$(touch injected)"}', false)
  await check('functions stay unsupported', 'f() { echo "hello"; }; f', false)
  await check('outside write in group still asks', `{ echo "data" > "${root}/outside"; }`, false)
  await check('group output redirect still asks', `{ echo "data"; } > "${root}/outside"`, false)
  await check('recursive delete in group still asks', '{ rm -rf .git; }', false)
  await check('push in group still asks', '{ git push origin main; }', false)
  await check('install in group still asks', '{ npm install example-package; }', false)
  await check('nested deny rule still wins', '{ echo "hello"; { pwd; }; }', false, ['Bash(pwd)'])
  await check('conditional group cannot assign an assumed safe path', `if false; then { target=${project}; }; fi; rm -rf "$target"`, false)
  await check('a failed group assignment cannot hide a command path', '{ false && target=echo; }; $target hi', false)
  await check('background inside a group still asks', '{ echo "hello" & }', false)
} finally {
  process.chdir(original)
  rmSync(root, { recursive: true, force: true })
}
process.exit(failures ? 1 : 0)
