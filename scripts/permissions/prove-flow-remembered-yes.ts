import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const original = process.cwd()
const world = realpathSync(mkdtempSync(join(tmpdir(), 'flow-yes-')))
process.env.MERCURY_CONFIG_DIR = join(world, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.chdir(world)
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createPermissionContext } = await import('../../src/hooks/toolPermission/PermissionContext.ts')
const { decisionOfAnswer } = await import('../../src/cli/headless/runnerAsks.ts')
const { decideToolPermissionWithModes } = await import('../../src/utils/permissions/decision/wrapper.ts')
const { bashToolHasPermission } = await import('../../src/tools/BashTool/bashPermissions.ts')
const { applyPermissionUpdates } = await import('../../src/utils/permissions/PermissionUpdate.ts')
const { getSettingsFilePathForSource } = await import('../../src/utils/settings/settings.ts')
const { permissionRuleValueToString } = await import('../../src/utils/permissions/permissionRuleParser.ts')
const { getDestructiveCommandWarning } = await import('../../src/tools/BashTool/destructiveCommandWarning.ts')

let failures = 0
function check(label: string, ok: boolean): void {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}`)
  if (!ok) failures++
}
const assistant = { message: { id: 'flow-yes' } } as never
const tool = {
  name: 'Bash',
  inputSchema: z.object({ command: z.string() }),
  checkPermissions: (input: { command: string }, context: any) => bashToolHasPermission(input, context.getAppState().toolPermissionContext),
} as never
function harness(mode = 'flow', allow: string[] = []) {
  let state = { toolPermissionContext: { ...getEmptyToolPermissionContext(), mode, alwaysAllowRules: { localSettings: allow } }, tasks: {}, sessionHooks: new Map() }
  const context = {
    abortController: new AbortController(),
    getAppState: () => state,
    setAppState: (update: any) => { state = update(state) },
    options: { tools: [] }, messages: [],
  } as never
  return { context, rules: () => state.toolPermissionContext.alwaysAllowRules.localSettings ?? [], set: (next: any) => { state = { ...state, toolPermissionContext: next } } }
}
function diskRules(): string[] {
  const path = getSettingsFilePathForSource('localSettings')!
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).guardrails?.allow ?? [] : []
}
async function yes(h: ReturnType<typeof harness>, command: string, road: string, updates: any[] = []) {
  if (road === 'host') return decisionOfAnswer({ outcome: 'allow', rules: updates }, tool, { command }, h.context)
  const ctx = createPermissionContext(tool, { command }, h.context, assistant, 'yes', h.set)
  return ctx.handleUserAllow({ command }, updates)
}
try {
  for (const road of ['card', 'host']) {
    const command = `bun run build-${road}`
    const rule = permissionRuleValueToString({ toolName: 'Bash', ruleContent: command })
    const h = harness()
    await yes(h, command, road)
    check(`${road}: a Flow yes saves the exact command in the project allow list`, diskRules().includes(rule))
    check(`${road}: the same ordinary rule is live immediately`, h.rules().includes(rule))
    const fresh = harness('flow', diskRules())
    const repeated = await decideToolPermissionWithModes(tool, { command }, fresh.context, assistant, 'repeat')
    check(`${road}: a fresh context reads the saved yes and does not ask again`, repeated.decision.behavior === 'allow')
    const different = await decideToolPermissionWithModes(tool, { command: command + '-other' }, fresh.context, assistant, 'other')
    check(`${road}: a different command is not covered by the remembered yes`, different.decision.behavior === 'ask')
    const removed = applyPermissionUpdates((fresh.context as any).getAppState().toolPermissionContext, [{ type: 'removeRules', destination: 'localSettings', behavior: 'allow', rules: [{ toolName: 'Bash', ruleContent: command }] }])
    fresh.set(removed)
    check(`${road}: ordinary rule removal restores the ask`, (await decideToolPermissionWithModes(tool, { command }, fresh.context, assistant, 'removed')).decision.behavior === 'ask')
  }
  for (const mode of ['default', 'implement', 'sovereign', 'dontAsk']) {
    const h = harness(mode)
    const before = JSON.stringify(diskRules())
    await yes(h, `bun run ${mode}`, 'card')
    await yes(h, `bun run ${mode}`, 'host')
    check(`${mode}: a plain yes has no new saved-rule effect`, before === JSON.stringify(diskRules()) && h.rules().length === 0)
  }
  for (const command of ['git push --force origin topic', 'git reset --hard', 'git branch -D topic', 'rm -rf scratch-output', 'sqlite3 app.db "DROP TABLE sample"', 'git checkout -- .']) {
    check(`existing danger classifier covers ${command}`, getDestructiveCommandWarning(command) !== null)
    for (const road of ['card', 'host']) {
      const rule = permissionRuleValueToString({ toolName: 'Bash', ruleContent: command })
      const h = harness()
      const before = JSON.stringify(diskRules())
      await yes(h, command, road, [{ type: 'addRules', destination: 'localSettings', behavior: 'allow', rules: [{ toolName: 'Bash', ruleContent: command }] }])
      check(`${road}: destructive yes cannot write an enduring grant: ${command}`, before === JSON.stringify(diskRules()) && h.rules().length === 0)
      const preallowed = harness('flow', [rule, 'Bash'])
      check(`${road}: destructive call still asks with an existing allow: ${command}`, (await decideToolPermissionWithModes(tool, { command }, preallowed.context, assistant, 'danger')).decision.behavior === 'ask')
    }
  }
  const h = harness()
  const before = JSON.stringify(diskRules())
  await yes(h, 'printf "*"', 'card')
  check('a literal star never silently becomes a wildcard allow', before === JSON.stringify(diskRules()) && h.rules().length === 0)
  const ctx = createPermissionContext({ ...tool, name: 'UnscopedProbe' } as never, { action: 'once' }, h.context, assistant, 'opaque', h.set)
  await ctx.handleUserAllow({ action: 'once' }, [])
  check('an unrepresentable input never becomes a tool-wide grant', before === JSON.stringify(diskRules()) && h.rules().length === 0)
  await createPermissionContext(tool, { command: 'bun run hook-only' }, h.context, assistant, 'hook', h.set).handleHookAllow({ command: 'bun run hook-only' }, [])
  check('a hook yes is not an operator yes', before === JSON.stringify(diskRules()) && h.rules().length === 0)
} finally {
  process.chdir(original)
  rmSync(world, { recursive: true, force: true })
}
console.log(failures ? `Flow remembered yes: ${failures} FAILED` : 'Flow remembered yes: ALL PASS')
process.exit(failures ? 1 : 0)
