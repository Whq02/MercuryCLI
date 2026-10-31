import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const original = process.cwd()
const world = realpathSync(mkdtempSync(join(tmpdir(), 'flow-headless-')))
process.env.MERCURY_CONFIG_DIR = join(world, 'home')
process.chdir(world)
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { decideToolPermissionWithModes } = await import('../../src/utils/permissions/decision/wrapper.ts')
const { bashToolHasPermission } = await import('../../src/tools/BashTool/bashPermissions.ts')
const { createRuleOnlyAsks } = await import('../../src/cli/headless/runnerAsks.ts')
const { HEADLESS_PERMISSION_MODES } = await import('../../src/daemon/headlessRun.ts')
let failures = 0
function check(label: string, ok: boolean, detail = '') {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ' — ' + detail}`)
  if (!ok) failures++
}
const tool = { name: 'Bash', inputSchema: z.object({ command: z.string() }), isReadOnly: () => false, checkPermissions: (input: any, context: any) => bashToolHasPermission(input, context.getAppState().toolPermissionContext) } as never
const assistant = { message: { id: 'flow-headless' } } as never
function context(mode = 'flow', host = false, rules: { deny?: string[]; ask?: string[]; allow?: string[] } = {}) {
  const state = { toolPermissionContext: { ...getEmptyToolPermissionContext(), mode, alwaysDenyRules: { localSettings: rules.deny ?? [] }, alwaysAskRules: { localSettings: rules.ask ?? [] }, alwaysAllowRules: { localSettings: rules.allow ?? [] } } }
  return { abortController: new AbortController(), getAppState: () => state, setAppState: () => {}, options: { isNonInteractiveSession: true, hostHoldsAsks: host } } as never
}
const FIVE: Array<[string, string]> = [
  ['sudo -n true', 'Flow asks before sudo: it runs with elevated rights.'],
  ['git push origin topic', 'Flow asks before git push: it publishes history.'],
  ['npm publish', 'Flow asks before npm publish: it publishes a package.'],
  ['rm -rf ~/other', 'Flow asks before rm -rf ~/other: it deletes ~/other, outside the project.'],
]
try {
  check('headless Flow still needs its flag: flow is one of the --mode words a headless run accepts', (HEADLESS_PERMISSION_MODES as readonly string[]).includes('flow'))
  for (const command of ['bun run build', 'npm test', 'python3 check.py', 'git commit -m local-change', 'npm install package', 'pip3 install package', 'rm -rf generated', 'sqlite3 data.db "DROP TABLE sample"', 'cp data ../outside', 'cat < ../outside', 'cd .. && ls', 'sh -c "npm install package"', 'rm -rf /tmp/scratch']) {
    const hostless = await createRuleOnlyAsks().createCanUseTool()(tool, { command }, context(), assistant, command)
    check(`hostless Flow runs: ${command}`, hostless.behavior === 'allow', JSON.stringify(hostless))
    const hosted = await decideToolPermissionWithModes(tool, { command }, context('flow', true), assistant, command)
    check(`hosted Flow runs without an ask: ${command}`, hosted.decision.behavior === 'allow', JSON.stringify(hosted.decision))
    for (const mode of ['default', 'implement', 'dontAsk']) {
      if (mode === 'implement' && command === 'rm -rf generated') continue
      const other = await decideToolPermissionWithModes(tool, { command }, context(mode), assistant, command)
      check(`${mode} does not acquire the Flow allow: ${command}`, other.decision.behavior !== 'allow')
    }
  }
  for (const [command, words] of FIVE) {
    const hosted = await decideToolPermissionWithModes(tool, { command }, context('flow', true), assistant, command)
    check(`hosted Flow puts the ask to the host, in the five's words: ${command}`, hosted.decision.behavior === 'ask' && hosted.decision.message === words, JSON.stringify(hosted.decision))
    const hostless = await createRuleOnlyAsks().createCanUseTool()(tool, { command }, context(), assistant, command)
    check(`hostless Flow has no one to ask, so the call comes back as the same ask and is refused by the run: ${command}`, hostless.behavior === 'ask' && hostless.message === words, JSON.stringify(hostless))
  }
  for (const behavior of ['ask', 'deny'] as const) {
    const result = await decideToolPermissionWithModes(tool, { command: 'bun run build' }, context('flow', false, { [behavior]: ['Bash(bun run build)'] }), assistant, behavior)
    check(`an explicit ${behavior} rule still wins`, result.decision.behavior === behavior)
  }
  const approved = await decideToolPermissionWithModes(tool, { command: 'git push origin topic' }, context('flow', false, { allow: ['Bash(git push origin topic)'] }), assistant, 'saved-push')
  check('a saved yes still allows its push', approved.decision.behavior === 'allow')
} finally {
  process.chdir(original)
  rmSync(world, { recursive: true, force: true })
}
console.log(failures ? `Flow headless: ${failures} FAILED` : 'Flow headless: ALL PASS')
process.exit(failures ? 1 : 0)
