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
let failures = 0
function check(label: string, ok: boolean, detail = '') {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ' — ' + detail}`)
  if (!ok) failures++
}
const tool = { name: 'Bash', inputSchema: z.object({ command: z.string() }), checkPermissions: (input: any, context: any) => bashToolHasPermission(input, context.getAppState().toolPermissionContext) } as never
const assistant = { message: { id: 'flow-headless' } } as never
function context(mode = 'flow', host = false, rules: { deny?: string[]; ask?: string[]; allow?: string[] } = {}) {
  const state = { toolPermissionContext: { ...getEmptyToolPermissionContext(), mode, alwaysDenyRules: { localSettings: rules.deny ?? [] }, alwaysAskRules: { localSettings: rules.ask ?? [] }, alwaysAllowRules: { localSettings: rules.allow ?? [] } } }
  return { abortController: new AbortController(), getAppState: () => state, options: { isNonInteractiveSession: true, hostHoldsAsks: host } } as never
}
try {
  for (const command of ['bun run build', 'npm test', 'python3 check.py', 'git commit -m local-change']) {
    const h = context()
    const result = await createRuleOnlyAsks().createCanUseTool()(tool, { command }, h, assistant, command)
    check(`hostless Flow permits the safe residual: ${command}`, result.behavior === 'allow', JSON.stringify(result))
    const hosted = await decideToolPermissionWithModes(tool, { command }, context('flow', true), assistant, command)
    check(`hosted Flow still asks for the residual: ${command}`, hosted.decision.behavior === 'ask', JSON.stringify(hosted))
    for (const mode of ['default', 'implement', 'dontAsk']) {
      const other = await decideToolPermissionWithModes(tool, { command }, context(mode), assistant, command)
      check(`${mode} does not acquire the Flow residual allow: ${command}`, other.decision.behavior !== 'allow')
    }
  }
  const floors = [
    'git push origin topic', 'git -C . push origin topic', 'git --git-dir=.git push origin topic',
    'env CI=1 git push origin topic', 'git status && git push origin topic',
    'sudo -u root git push origin topic', 'env -C / git push origin topic',
    'bash -c "git push origin topic"', 'sh -c "npm install package"',
    'npm install package', 'npm i package', 'pnpm add package', 'yarn add package', 'yarn',
    'bun install', 'pip3 install package', 'python3 -m pip install package', 'pipx install package',
    'uv pip install package', 'uv add package', 'brew install package', 'apt-get install package',
    'cargo install package', 'gem install package', 'npm ci',
    'rm -rf generated', 'git reset --hard', 'git push --force origin topic',
    'sqlite3 data.db "DROP TABLE sample"', 'git branch -D topic',
    'cp data ../outside', 'printf text > ../outside', 'cat < ../outside',
    'cat $(pwd)', 'cd .. && ls',
  ]
  for (const command of floors) {
    for (const host of [false, true]) {
      const result = await decideToolPermissionWithModes(tool, { command }, context('flow', host), assistant, command)
      check(`${host ? 'hosted' : 'hostless'} Flow keeps the floor: ${command}`, result.decision.behavior !== 'allow', JSON.stringify(result))
    }
  }
  for (const behavior of ['ask', 'deny'] as const) {
    const result = await decideToolPermissionWithModes(tool, { command: 'bun run build' }, context('flow', false, { [behavior]: ['Bash(bun run build)'] }), assistant, behavior)
    check(`an explicit ${behavior} rule still wins`, result.decision.behavior === behavior)
  }
  const approved = await decideToolPermissionWithModes(tool, { command: 'git push origin topic' }, context('flow', false, { allow: ['Bash(git push origin topic)'] }), assistant, 'saved-push')
  check('an ordinary saved yes still allows its non-destructive push', approved.decision.behavior === 'allow')
  const broken = { name: 'BrokenProbe', inputSchema: z.object({}), checkPermissions: async () => { throw new Error('fixture check failure') } }
  check('a failed permission probe cannot become a headless allow', (await decideToolPermissionWithModes(broken as never, {}, context(), assistant, 'broken')).decision.behavior !== 'allow')
} finally {
  process.chdir(original)
  rmSync(world, { recursive: true, force: true })
}
console.log(failures ? `Flow hostless residual: ${failures} FAILED` : 'Flow hostless residual: ALL PASS')
process.exit(failures ? 1 : 0)
