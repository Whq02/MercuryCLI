import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
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
const { checkWritePermissionForTool } = await import('../../src/utils/permissions/filesystem.ts')

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok || detail === '' ? '' : ' — ' + detail}`)
  if (!ok) failures++
}
const assistant = { message: { id: 'flow-yes' } } as never
const tool = {
  name: 'Bash',
  inputSchema: z.object({ command: z.string() }),
  isReadOnly: () => false,
  checkPermissions: (input: { command: string }, context: any) => bashToolHasPermission(input, context.getAppState().toolPermissionContext),
} as never
const PUSH = 'git push origin topic'
const PUSH_WORDS = 'Flow asks before git push: it publishes history.'
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
  await (await import('../../src/utils/permissions/decision/commandAnalysis.ts')).parseForSecurity(command)
  if (road === 'host') return decisionOfAnswer({ outcome: 'allow', rules: updates }, tool, { command }, h.context)
  const ctx = createPermissionContext(tool, { command }, h.context, assistant, 'yes', h.set)
  return ctx.handleUserAllow({ command }, updates)
}
const exactRule = (command: string) => [{ type: 'addRules', destination: 'localSettings', behavior: 'allow', rules: [{ toolName: 'Bash', ruleContent: command }] }]
try {
  for (const road of ['card', 'host']) {
    const command = `${PUSH}-${road}`
    const rule = permissionRuleValueToString({ toolName: 'Bash', ruleContent: command })
    const first = await decideToolPermissionWithModes(tool, { command }, harness().context, assistant, 'first')
    check(`${road}: the push asks first, in the five's words`, first.decision.behavior === 'ask' && first.decision.message === PUSH_WORDS, JSON.stringify(first.decision))
    const h = harness()
    const before = JSON.stringify(diskRules())
    await yes(h, command, road)
    check(`${road}: a plain yes answers this call and saves nothing`, before === JSON.stringify(diskRules()) && h.rules().length === 0)
    check(`${road}: the same push asks again after a plain yes`, (await decideToolPermissionWithModes(tool, { command }, h.context, assistant, 'again')).decision.behavior === 'ask')
    await yes(h, command, road, exactRule(command))
    check(`${road}: a don't-ask-again yes saves the exact command in the project allow list`, diskRules().includes(rule))
    check(`${road}: the saved rule is live immediately`, h.rules().includes(rule))
    const fresh = harness('flow', diskRules())
    const repeated = await decideToolPermissionWithModes(tool, { command }, fresh.context, assistant, 'repeat')
    check(`${road}: a fresh context reads the remembered yes and the push runs without a question`, repeated.decision.behavior === 'allow', JSON.stringify(repeated.decision))
    const different = await decideToolPermissionWithModes(tool, { command: command + '-other' }, fresh.context, assistant, 'other')
    check(`${road}: a different push is not covered and asks in the five's words`, different.decision.behavior === 'ask' && different.decision.message === PUSH_WORDS)
    const removed = applyPermissionUpdates((fresh.context as any).getAppState().toolPermissionContext, [{ type: 'removeRules', destination: 'localSettings', behavior: 'allow', rules: [{ toolName: 'Bash', ruleContent: command }] }])
    fresh.set(removed)
    check(`${road}: removing the rule restores the ask`, (await decideToolPermissionWithModes(tool, { command }, fresh.context, assistant, 'removed')).decision.behavior === 'ask')
  }
  for (const road of ['card', 'host']) {
    const h = harness()
    const input = { file_path: join(homedir(), `.flow-external-${road}.txt`) }
    const fileTool = { name: 'Write', getPath: (value: any) => value.file_path, isReadOnly: () => false } as never
    check(`${road}: a file outside the project starts with an ask`, checkWritePermissionForTool(fileTool, input, (h.context as any).getAppState().toolPermissionContext).behavior === 'ask')
    const before = JSON.stringify(diskRules())
    if (road === 'host') decisionOfAnswer({ outcome: 'allow' }, fileTool, input, h.context)
    else await createPermissionContext(fileTool, input, h.context, assistant, 'path', h.set).handleUserAllow(input, [])
    check(`${road}: a plain yes on the file saves nothing`, before === JSON.stringify(diskRules()) && h.rules().length === 0)
    const grant = [{ type: 'addRules', destination: 'localSettings', behavior: 'allow', rules: [{ toolName: 'Edit', ruleContent: `//${input.file_path.replace(/^\//, '')}` }] }]
    if (road === 'host') decisionOfAnswer({ outcome: 'allow', rules: grant } as never, fileTool, input, h.context)
    else await createPermissionContext(fileTool, input, h.context, assistant, 'path', h.set).handleUserAllow(input, grant as never)
    const fresh = harness('flow', diskRules())
    check(`${road}: the saved exact file rule works after reload`, checkWritePermissionForTool(fileTool, input, (fresh.context as any).getAppState().toolPermissionContext).behavior === 'allow')
    check(`${road}: the file yes does not grant its whole directory`, checkWritePermissionForTool(fileTool, { file_path: input.file_path + '-other' }, (fresh.context as any).getAppState().toolPermissionContext).behavior === 'ask')
  }
  for (const mode of ['default', 'implement', 'sovereign', 'dontAsk']) {
    const h = harness(mode)
    const before = JSON.stringify(diskRules())
    await yes(h, `bun run ${mode}`, 'card')
    await yes(h, `bun run ${mode}`, 'host')
    check(`${mode}: a plain yes has no saved-rule effect`, before === JSON.stringify(diskRules()) && h.rules().length === 0)
  }
  const h = harness()
  const before = JSON.stringify(diskRules())
  await yes(h, 'printf "*"', 'card')
  check('a literal star never silently becomes a wildcard allow', before === JSON.stringify(diskRules()) && h.rules().length === 0)
  const ctx = createPermissionContext({ ...(tool as object), name: 'UnscopedProbe' } as never, { action: 'once' }, h.context, assistant, 'opaque', h.set)
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
