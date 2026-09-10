#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '../..')
process.chdir(ROOT)
const scratch = mkdtempSync(join(tmpdir(), 'description-offer-parity-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'config')
process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
process.env.MERCURY_TEAMS_DIR = join(scratch, 'teams')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.BROWSER = '/usr/bin/true'
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV
delete process.env.MERCURY_TASKS
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setCwdState(scratch)
const { getTools } = await import('../../src/tools.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { filterToolsForAgent, resolveAgentTools } = await import('../../src/tools/AgentTool/agentToolUtils.ts')
const lspManager = await import('../../src/services/lsp/manager.ts')
const { toolToAPISchema } = await import('../../src/utils/api.ts')
const { clearToolSchemaCache } = await import('../../src/utils/toolSchemaCache.ts')
const { ENTER_PLAN_MODE_TOOL_NAME } = await import('../../src/tools/EnterPlanModeTool/constants.ts')
const { EXIT_PLAN_MODE_V2_TOOL_NAME } = await import('../../src/tools/ExitPlanModeTool/constants.ts')
type Tool = import('../../src/Tool.ts').Tool

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ': ' + detail : ''}`)
  if (!ok) failures++
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
}
const sources: string[] = []
walk(join(ROOT, 'src', 'tools'), sources)
walk(join(ROOT, 'src', 'constants'), sources)
const universe = new Set<string>()
for (const file of sources) {
  for (const match of readFileSync(file, 'utf8').matchAll(/export const [A-Z_]+_TOOL_NAME = '([A-Za-z_]+)'/g)) universe.add(match[1]!)
}
for (const match of readFileSync(join(ROOT, 'src', 'tools', 'BrowserTool', 'BrowserTool.ts'), 'utf8').matchAll(/^  name: '([A-Za-z_]+)',$/gm)) universe.add(match[1]!)
universe.delete('REPL')
check('the wire-name universe was read from the tool constants', universe.size >= 60 && universe.has('TaskUpdate') && universe.has('Browser') && universe.has('LSP'), String(universe.size))
const multiWord = [...universe].filter(name => /[a-z][A-Z]/.test(name))
const singleWord = [...universe].filter(name => !/[a-z][A-Z]/.test(name))
const listTail = /^(?:\s*,\s*|\s+(?:or|and)\s+)((?:[A-Z][A-Za-z]+)(?:\s*,\s*[A-Z][A-Za-z]+)*(?:\s+(?:or|and)\s+[A-Z][A-Za-z]+)?)\s+tools?\b/

function singleMention(text: string, start: number, end: number): boolean {
  const before = text.slice(Math.max(0, start - 12), start)
  const after = text.slice(end, end + 80)
  if (/^\s+tools?\b/.test(after)) return true
  if (before.endsWith('`') && after.startsWith('`')) return true
  if (before.endsWith('select:') || before.endsWith('tool.')) return true
  if (after.startsWith('(')) return true
  if (listTail.test(after)) return true
  return false
}

export function mentionedToolNames(text: string): string[] {
  const found = new Set<string>()
  for (const name of multiWord) {
    if (new RegExp(`(?<![A-Za-z_])${name}(?![A-Za-z_])`).test(text)) found.add(name)
  }
  for (const name of singleWord) {
    for (const match of text.matchAll(new RegExp(`(?<![A-Za-z_])${name}(?![A-Za-z_])`, 'g'))) {
      if (singleMention(text, match.index!, match.index! + name.length)) {
        found.add(name)
        break
      }
    }
  }
  return [...found].sort()
}

check('the mention rule counts a multi-word name anywhere', mentionedToolNames('belongs in TaskUpdate, not here').join() === 'TaskUpdate')
check('the mention rule counts a single-word name only in a naming position', mentionedToolNames('use the `Browser` tool; read the file').join() === 'Browser' && mentionedToolNames('load it with ToolSearch `select:Browser`').join() === 'Browser,ToolSearch')
check('the mention rule ignores a plain English word that is also a name', mentionedToolNames('a sleep of five seconds; read the file; edit nothing').length === 0)

interface Kind {
  label: string
  interactive: boolean
  tasksEnv?: string
  mountLsp?: boolean
  disallowedTools?: string[]
  agent?: { isBuiltIn: boolean; isAsync: boolean }
}
const kinds: Kind[] = [
  { label: 'interactive', interactive: true },
  { label: 'headless', interactive: false },
  { label: 'headless with tasks', interactive: false, tasksEnv: '1' },
  { label: 'sub-agent of an interactive session', interactive: true, agent: { isBuiltIn: true, isAsync: false } },
  { label: 'sub-agent of a headless session', interactive: false, agent: { isBuiltIn: true, isAsync: false } },
  { label: 'background sub-agent of a headless session', interactive: false, agent: { isBuiltIn: true, isAsync: true } },
  { label: 'custom sub-agent of a headless session', interactive: false, agent: { isBuiltIn: false, isAsync: false } },
  { label: 'interactive with mounted LSP', interactive: true, mountLsp: true },
  { label: 'restricted custom sub-agent with globally mounted LSP', interactive: false, mountLsp: true, disallowedTools: ['LSP'], agent: { isBuiltIn: false, isAsync: false } },
]

const permissionContext = getEmptyToolPermissionContext()
const rendered = new Map<string, Map<string, string>>()
for (const kind of kinds) {
  clearToolSchemaCache()
  bootstrap.setIsInteractive(kind.interactive)
  if (kind.tasksEnv === undefined) delete process.env.MERCURY_TASKS
  else process.env.MERCURY_TASKS = kind.tasksEnv
  if (kind.mountLsp) {
    lspManager.initializeLspServerManager()
    await lspManager.waitForInitialization()
    check(`${kind.label}: LSP is globally mounted`, lspManager.isLspToolMounted())
  }
  let pool: Tool[] = getTools(permissionContext) as Tool[]
  if (kind.agent !== undefined) pool = filterToolsForAgent({ tools: pool, isBuiltIn: kind.agent.isBuiltIn, isAsync: kind.agent.isAsync }) as Tool[]
  if (kind.disallowedTools) pool = resolveAgentTools({ source: 'projectSettings', tools: ['*'], disallowedTools: kind.disallowedTools }, pool).resolvedTools as Tool[]
  const offered = new Set(pool.map(tool => tool.name))
  if (kind.mountLsp) check(`${kind.label}: the actual pool honors its LSP restriction`, offered.has('LSP') === !kind.disallowedTools?.includes('LSP'))
  check(`${kind.label}: a pool was built`, pool.length >= 10, String(pool.length))
  const descriptions = new Map<string, string>()
  const pairs: string[] = []
  for (const tool of pool) {
    const schema = (await toolToAPISchema(tool, {
      getToolPermissionContext: async () => permissionContext,
      tools: pool,
      agents: [],
      model: 'claude-opus-4-8',
    })) as { description?: string }
    const description = schema.description ?? ''
    descriptions.set(tool.name, description)
    for (const name of mentionedToolNames(description)) {
      if (!offered.has(name)) pairs.push(`${tool.name} → ${name}`)
    }
  }
  rendered.set(kind.label, descriptions)
  if (kind.mountLsp) {
    const steered = ['Grep', 'Edit', 'Structure'].filter(name => /\bLSP\b/.test(descriptions.get(name) ?? ''))
    check(`${kind.label}: the semantic steering names LSP exactly when the pool offers it`, offered.has('LSP') ? steered.length === 3 : steered.length === 0, steered.join(','))
  }
  check(`${kind.label}: no offered description names a tool the session does not offer (${offered.size} offered)`, pairs.length === 0, pairs.join('; '))
  check(`${kind.label}: a planning entry is never offered without its exit`, !offered.has(ENTER_PLAN_MODE_TOOL_NAME) || offered.has(EXIT_PLAN_MODE_V2_TOOL_NAME), [...offered].filter(n => n.includes('Strategy')).join(','))
}

const interactive = rendered.get('interactive')!
const headless = rendered.get('headless')!
const differing = [...headless.keys()].filter(name => interactive.has(name) && interactive.get(name) !== headless.get(name))
check('a description differs between session kinds only where the pool differs', differing.every(name => mentionedToolNames(interactive.get(name)!).join() !== mentionedToolNames(headless.get(name)!).join() || /task|team|board/i.test(interactive.get(name)!)), differing.join(','))

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nDESCRIPTION OFFER PARITY HOLDS' : `\n${failures} DESCRIPTION OFFER PARITY CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
