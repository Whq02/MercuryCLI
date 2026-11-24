#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '../..')
process.chdir(ROOT)
const scratch = mkdtempSync(join(tmpdir(), 'description-offer-parity-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'config')
process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.BROWSER = '/usr/bin/true'
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV
delete process.env.MERCURY_TASKS
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/boot/process-state/processState.ts')
bootstrap.setCwdState(scratch)
const { getTools } = await import('../../src/tools/kit/toolList.ts')
const { withheldTools } = await import('../../src/engine/tool-dispatch/withheldTools.ts')
const withheld = new Set(withheldTools().map(w => w.tool))
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
const { filterToolsForCrewmate, resolveAgentTools } = await import('../../src/tools/crewmate/crewmateLifecycle.ts')
const lspManager = await import('../../src/integrations/lsp/serverManagerLifecycle.ts')
const { toolToAPISchema } = await import('../../src/engine/messages/apiSystemAndToolSchema.ts')
const { clearToolSchemaCache } = await import('../../src/models/roads/toolSchemaCache.ts')
const { BrowserTool } = await import('../../src/tools/browser/BrowserTool.ts')
type Tool = import('../../src/tools/kit/tool.ts').Tool

let failures = 0
const check = (label: string, ok: boolean, detail = '', hint = ''): void => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ': ' + detail : ''}${!ok && hint ? ' | to fix: ' + hint : ''}`)
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
const universe = new Set<string>()
for (const file of sources) {
  for (const match of readFileSync(file, 'utf8').matchAll(/export const [A-Z_]+_TOOL_NAME = '([A-Za-z_]+)'/g)) universe.add(match[1]!)
}
universe.add(BrowserTool.name)
universe.delete('Chat')
const LSP_NAMES = ['LspRead', 'LspRename', 'LspMoveSymbol', 'LspMoveFile', 'LspCodeAction', 'LspFormat', 'LspRequest']
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

function mentionedToolNames(text: string): string[] {
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
  agent?: { isBuiltIn: boolean }
}
const kinds: Kind[] = [
  { label: 'interactive', interactive: true },
  { label: 'headless', interactive: false },
  { label: 'headless with tasks', interactive: false, tasksEnv: '1' },
  { label: 'sub-agent of an interactive session', interactive: true, agent: { isBuiltIn: true } },
  { label: 'sub-agent of a headless session (foreground and background share one pool)', interactive: false, agent: { isBuiltIn: true } },
  { label: 'custom sub-agent of a headless session', interactive: false, agent: { isBuiltIn: false } },
  { label: 'interactive with mounted LSP', interactive: true, mountLsp: true },
  { label: 'restricted custom sub-agent with globally mounted LSP', interactive: false, mountLsp: true, disallowedTools: ['LSP'], agent: { isBuiltIn: false } },
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
    check(`${kind.label}: LSP is globally mounted`, lspManager.isLspToolMounted(), '', 'isLspToolMounted in src/integrations/lsp/serverManagerLifecycle.ts must read true after initializeLspServerManager and waitForInitialization')
  }
  let pool: Tool[] = getTools(permissionContext) as Tool[]
  if (kind.agent !== undefined) pool = filterToolsForCrewmate({ tools: pool }) as Tool[]
  if (kind.disallowedTools) pool = resolveAgentTools({ source: 'projectSettings', tools: ['*'], disallowedTools: kind.disallowedTools }, pool).resolvedTools as Tool[]
  const offered = new Set(pool.map(tool => tool.name))
  if (kind.mountLsp) check(`${kind.label}: the actual pool honors its LSP restriction`, LSP_NAMES.every(name => offered.has(name) === !kind.disallowedTools?.includes('LSP')), LSP_NAMES.filter(name => offered.has(name)).join(','), 'filterToolsForAgent and resolveAgentTools in src/tools/crewmate/crewmateLifecycle.ts must drop every Lsp tool when the agent disallows LSP')
  check(`${kind.label}: a pool was built`, pool.length >= 10, String(pool.length), 'getTools in src/tools/kit/toolList.ts returned too few tools for this session kind')
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
    if (tool.name === 'CrewBoard') {
      const canLaunch = offered.has('Crewmate')
      const summary = await tool.description(undefined, { tools: pool })
      const empty = await tool.call({ op: 'read' } as never, { options: { tools: pool } } as never, (() => {}) as never, {} as never)
      for (const [surface, text] of [['description', summary], ['empty read', JSON.stringify(empty.data)]]) {
        check(`${kind.label}: CrewBoard ${surface} (operator text, a call-time hint) names only the available launch road`, canLaunch ? text!.includes('ToolSearch select:Crewmate') : text!.includes('The lead launches seats.') && !/\bCrewmate\b/.test(text!), '', 'launchWords in src/crew/board/implementation.ts must name the Crewmate launch road only when the pool offers Crewmate')
      }
      check(`${kind.label}: the CrewBoard prompt names no launch road and no launcher, whatever the pool offers`, !description.includes('ToolSearch select:Crewmate') && !description.includes('The lead launches seats.') && !/\bCrewmate\b/.test(description), '', 'the CrewBoard prompt must not mention the launch road; launch wording belongs only in launchWords in src/crew/board/implementation.ts')
      check(`${kind.label}: the board roster hint names no unavailable launcher`, canLaunch || !/\bCrewmate\b/.test(tool.searchHint ?? ''), '', 'remove Crewmate from the CrewBoard searchHint in src/crew/board/implementation.ts')
    }
    const resumedChildContract = 'a crewmate launched with an output schema keeps its StructuredOutput tool for the resumed turn.'
    if (tool.name === 'ResumeCrewmate') check(`${kind.label}: the resumed-child tool promise is stated exactly`, description.endsWith(resumedChildContract), '', 'the ResumeCrewmate description must end with the resumed-child sentence; see src/tools/resume-crewmate/prompt.ts')
    const manual = tool.wireDescription === undefined ? '' : await tool.prompt({ getToolPermissionContext: async () => permissionContext, tools: pool, agents: [], model: 'claude-opus-4-8' })
    if (tool.wireDescription !== undefined) check(`${kind.label}: ${tool.name} keeps its full manual behind the short wire contract`, description === tool.wireDescription(manual) && manual.length > description.length, '', 'wireDescription of this tool must return the short contract while prompt returns the longer manual; see the tool file under src/tools')
    const callerDescription = tool.name === 'ResumeCrewmate' ? description.replace(resumedChildContract, '') : description + '\n' + manual
    for (const name of mentionedToolNames(callerDescription)) {
      if (!offered.has(name) && !withheld.has(name)) pairs.push(`${tool.name} → ${name}`)
    }
  }
  rendered.set(kind.label, descriptions)
  if (kind.mountLsp) {
    const steered = ['Grep', 'Edit', 'Structure'].filter(name => /\bLsp(?:Read|Rename)\b/.test(descriptions.get(name) ?? ''))
    check(`${kind.label}: no tool steers to the language-service tools, whatever the pool offers; Grep and Edit name no other tool at all`, steered.length === 0 && !/\b(Lsp\w+|AstSearch|AstEdit|Structure)\b/.test(descriptions.get('Grep') ?? '') && !/\b(Lsp\w+|AstEdit|Structure)\b/.test(descriptions.get('Edit') ?? ''), steered.join(','), 'remove Lsp tool names from the Grep, Edit and Structure prompts under src/tools')
  }
  check(`${kind.label}: no offered description names a tool the session does not offer (${offered.size} offered)`, pairs.length === 0, pairs.join('; '), 'each pair is tool then the tool it names; remove that name from the first tool prompt under src/tools, or gate it on the offered pool')
}

const interactive = rendered.get('interactive')!
const headless = rendered.get('headless')!
const differing = [...headless.keys()].filter(name => interactive.has(name) && interactive.get(name) !== headless.get(name))
check('a description differs between session kinds only where the pool differs', differing.every(name => mentionedToolNames(interactive.get(name)!).join() !== mentionedToolNames(headless.get(name)!).join() || /task|crew|board/i.test(interactive.get(name)!)), differing.join(','), 'a tool description changed between interactive and headless with the same tool mentions; make it depend only on which tools the pool offers')

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nDESCRIPTION OFFER PARITY HOLDS' : `\n${failures} DESCRIPTION OFFER PARITY CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
