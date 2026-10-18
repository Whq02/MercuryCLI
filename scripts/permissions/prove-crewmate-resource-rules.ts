import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'crewmate-resource-rules-'))
process.env.MERCURY_CONFIG_DIR = join(home, 'config')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.NODE_ENV
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
await import('../../src/services/providers/callModelRouter.ts')
await import('../../src/utils/messages.ts')
const { setCwdState, setOriginalCwd, setProjectRoot } = await import('../../src/bootstrap/state.ts')
setCwdState(home)
setOriginalCwd(home)
setProjectRoot(home)
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { resolveAgentTools } = await import('../../src/tools/AgentTool/agentToolUtils.ts')
const { composeAgentAppState } = await import('../../src/tools/AgentTool/agentPermissionPosture.ts')
const { decodeAgentDocument } = await import('../../src/services/agents/codec.ts')
const { parseAgentFromJson, getAgentDefinitionsWithOverrides, clearAgentDefinitionsCache } = await import('../../src/tools/AgentTool/loadAgentsDir.ts')
const { bashToolHasPermission } = await import('../../src/tools/BashTool/bashPermissions.ts')
const { checkWritePermissionForTool } = await import('../../src/utils/permissions/filesystem.ts')
const fileWriteToolHasPermission = (_tool: unknown, input: { file_path: string }, context: ReturnType<typeof getEmptyToolPermissionContext>) => checkWritePermissionForTool({ name: 'Edit', getPath: (value: { file_path: string }) => value.file_path }, input, context)
let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}
const pool = ['Read', 'Edit', 'Bash'].map(name => ({ name })) as never[]
const definition = { source: 'projectSettings', tools: ['Edit(src/**)', 'Bash'], disallowedTools: ['Bash(rm *)'] }
const child = (mode: string, extra = {}) => {
  const parent = { toolPermissionContext: { ...getEmptyToolPermissionContext(), mode, isBypassPermissionsModeAvailable: true, ...extra } }
  const before = JSON.stringify(parent)
  const result = composeAgentAppState(parent as never, { definitionMode: undefined, avoidPrompts: false, isAsync: false, allowedTools: undefined, effortValue: undefined, definitionTools: definition } as never)
  check(`${mode}: the parent state is unchanged`, JSON.stringify(parent) === before)
  return result.toolPermissionContext
}
try {
  console.log('resource rules')
  const names = resolveAgentTools(definition as never, pool).resolvedTools.map(t => t.name)
  check('a resource denial keeps Bash in the toolbox', names.includes('Bash'), names)
  check('a resource grant keeps Edit in the toolbox', names.includes('Edit'), names)
  check('a bare denial still removes the whole tool', !resolveAgentTools({ ...definition, disallowedTools: ['Bash'] } as never, pool).resolvedTools.some(t => t.name === 'Bash'))
  mkdirSync(join(home, 'src'), { recursive: true })
  for (const mode of ['default', 'implement', 'sovereign']) {
    const context = child(mode)
    const allowed = await fileWriteToolHasPermission({ name: 'Edit' } as never, { file_path: join(home, 'src', 'ok.ts') }, context)
    check(`${mode}: the scoped edit is allowed`, allowed.behavior === 'allow', allowed)
    const denied = await bashToolHasPermission({ command: 'rm local.txt' }, context)
    check(`${mode}: the scoped delete is denied`, denied.behavior === 'deny', denied)
    const harmless = await bashToolHasPermission({ command: 'echo safe' }, context)
    check(`${mode}: a harmless Bash call stays available`, harmless.behavior === 'allow', harmless)
  }
  const scoped = child('default')
  check('only resource rules enter the overlay', JSON.stringify(scoped.alwaysAllowRules.toolsNarrowing) === JSON.stringify(['Edit(src/**)']) && JSON.stringify(scoped.alwaysDenyRules.toolsNarrowing) === JSON.stringify(['Bash(rm *)']), scoped)
  const sibling = composeAgentAppState({ toolPermissionContext: getEmptyToolPermissionContext() } as never, { definitionMode: undefined, avoidPrompts: false, isAsync: false, allowedTools: undefined, effortValue: undefined } as never)
  check('another crewmate receives none of these rules', sibling.toolPermissionContext.alwaysDenyRules.toolsNarrowing === undefined)
  console.log('refusals')
  const restricted = child('sovereign', { alwaysDenyRules: { session: ['Edit(src/private/**)'], toolsNarrowing: ['Bash(git push *)'] } })
  const deniedEdit = await fileWriteToolHasPermission({ name: 'Edit' } as never, { file_path: join(home, 'src', 'private', 'key.ts') }, restricted)
  check('session deny wins over a crewmate allow in sovereign', deniedEdit.behavior === 'deny', deniedEdit)
  check('parent crewmate denials survive another overlay', restricted.alwaysDenyRules.toolsNarrowing?.includes('Bash(git push *)') === true)
  mkdirSync(join(home, 'private'), { recursive: true })
  symlinkSync(join(home, 'private'), join(home, 'src', 'link'), 'dir')
  for (const mode of ['default', 'implement', 'sovereign']) {
    const context = child(mode, { alwaysDenyRules: { session: ['Edit(private/**)'] } })
    for (const path of [join(home, 'src', '..', 'private', 'key'), join(home, 'private', 'key'), join(home, 'src', 'link', 'key')]) {
      const answer = await fileWriteToolHasPermission(null, { file_path: path }, context)
      check(mode + ': a host-path denial covers traversal, absolute and symlink spellings', answer.behavior === 'deny', answer)
    }
  }
  const outside = await fileWriteToolHasPermission(null, { file_path: join(home, 'elsewhere.ts') }, child('default'))
  check('the resource grant does not approve a different path', outside.behavior === 'ask', outside)
  const wildcardBad = decodeAgentDocument('---\nname: resource-probe\ndescription: fixture\ntools: ["*", "Bash(rm *"]\n---\nbody\n')
  check('a wildcard never hides a malformed neighbouring pattern', wildcardBad.diagnostics.some(d => d.severity === 'error' && d.line === 4), wildcardBad.diagnostics)
  for (const spec of ['Bash(rm *', 'Bash(rm *)junk', 'Edit(src/pre*post/file)', '(src/**)']) {
    for (const field of ['tools', 'disallowedTools']) {
      const raw = `---\nname: resource-probe\ndescription: fixture\n${field}: [${JSON.stringify(spec)}]\n---\nAuthored body stays exactly as written.\n`
      const doc = decodeAgentDocument(raw, 'resource-probe.md')
      check(`${field}: malformed pattern refuses at line 4`, doc.diagnostics.some(d => d.severity === 'error' && d.line === 4), doc.diagnostics)
      check('the document is not rewritten', doc.raw === raw)
      check('the JSON definition refuses the same malformed pattern', parseAgentFromJson('resource-probe', { description: 'fixture', prompt: 'fixture', [field]: [spec] }) === null)
    }
  }
  const agentsDir = join(process.env.MERCURY_CONFIG_DIR!, 'agents')
  mkdirSync(agentsDir, { recursive: true })
  const file = join(agentsDir, 'resource-probe.md')
  const raw = '---\nname: resource-probe\ndescription: fixture\ndisallowedTools: ["Bash(rm *"]\n---\nDo not change this text.\n'
  writeFileSync(file, raw)
  clearAgentDefinitionsCache()
  const loaded = await getAgentDefinitionsWithOverrides(home)
  check('the actual loader refuses the file and names its line', !loaded.activeAgents.some(a => a.agentType === 'resource-probe') && loaded.failedFiles?.some(f => f.path === file && /line 4/.test(f.error)) === true, loaded.failedFiles)
  check('the loader leaves the definition bytes alone', readFileSync(file, 'utf8') === raw)
  const runSource = readFileSync(resolve(import.meta.dir, '../../src/tools/AgentTool/runAgent.ts'), 'utf8')
  check('launch and resume run through the definition overlay', /composeAgentAppState\(state,\s*\{[^}]*definitionTools:\s*agentDefinition/.test(runSource))
} finally {
  rmSync(home, { recursive: true, force: true })
}
console.log(`crewmate-resource-rules: ${checks} checks, ${failures} failed`)
process.exit(failures ? 1 : 0)
