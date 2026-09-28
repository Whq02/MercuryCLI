#!/usr/bin/env bun
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'jev-roster-home-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_DESKTOP_DRIVER = 'none'
process.env.MERCURY_JEV_BASE = 'http://127.0.0.1:1'
for (const key of ['TYPESAFE_API_KEY', 'NODE_ENV', 'https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'MERCURY_API_UNIX_SOCKET']) delete process.env[key]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0', PACKAGE_URL: 'https://example.invalid/mercury' }

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const PROOF_KEY = 'proof-key-jev-not-a-real-key-0004'
const ROOT = join(import.meta.dir, '..', '..')
const CEILING_PATH = join(import.meta.dir, 'fixtures', 'roster-ceiling.json')

writeFileSync(join(HOME, '.mercury.json'), JSON.stringify({ hasCompletedOnboarding: true, numStartups: 3 }))
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { setJevEnabled, setJevSubagents, readJevSettings } = await import('../../src/services/jev/jevSetting.ts')
const { runWithAgentContext } = await import('../../src/utils/agentContext.ts')
const { storeJevApiKey } = await import('../../src/services/jev/jevKey.ts')
const { resetJevLedger } = await import('../../src/services/jev/jevLedger.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { zodToJsonSchema } = await import('../../src/utils/zodToJsonSchema.ts')
const { ASYNC_AGENT_ALLOWED_TOOLS, assembleToolPool, getAllBaseTools } = await import('../../src/tools.ts')
const { JEV_TOOL_NAME } = await import('../../src/services/jev/jevContract.ts')
const { JevEvalTool } = await import('../../src/tools/JevEvalTool/JevEvalTool.ts')
const { JEV_EVAL_PROMPT } = await import('../../src/tools/JevEvalTool/prompt.ts')
const { filterToolsForAgent } = await import('../../src/tools/AgentTool/agentToolUtils.ts')

const ctx = { ...getEmptyToolPermissionContext(), mode: 'default' } as never
type Row = { name: string; searchHint: string | undefined; shouldDefer: boolean | undefined; alwaysLoad: boolean | undefined; readOnly: boolean | null; input_schema: unknown }
const schemaOf = (tool: { inputJSONSchema?: unknown; inputSchema: unknown }): unknown => {
  try {
    return tool.inputJSONSchema ?? zodToJsonSchema(tool.inputSchema as never)
  } catch (error) {
    return `unrenderable: ${error instanceof Error ? error.message : String(error)}`
  }
}
const projection = (): Row[] =>
  assembleToolPool(ctx, []).map(tool => ({
    name: tool.name,
    searchHint: tool.searchHint,
    shouldDefer: tool.shouldDefer,
    alwaysLoad: tool.alwaysLoad,
    readOnly: (() => {
      try {
        return tool.isReadOnly({} as never)
      } catch {
        return null
      }
    })(),
    input_schema: schemaOf(tool),
  }))

section('§1 with the switch off the pool carries no JevEval byte')
setJevEnabled(false)
storeJevApiKey(PROOF_KEY)
resetJevLedger()
const off = projection()
const offJson = JSON.stringify(off)
check('the catalogue has no JevEval', !getAllBaseTools().some(t => t.name === 'JevEval'))
check('the pool projection has no JevEval byte', !offJson.includes('JevEval'), String(offJson.indexOf('JevEval')))
check('the pool is not empty', off.length > 20, String(off.length))

section('§2 with the switch on and a key, the pool is the off pool plus one entry — nothing reorders')
setJevEnabled(true)
const on = projection()
const onNames = on.map(r => r.name)
check('JevEval is in the pool', onNames.includes('JevEval'))
check('exactly one entry more', on.length === off.length + 1, `${on.length} vs ${off.length}`)
const onMinus = on.filter(r => r.name !== 'JevEval')
check('the pool with the JevEval entry removed is byte-identical to the off pool', JSON.stringify(onMinus) === offJson)
check('the order of every other tool is unchanged', JSON.stringify(onMinus.map(r => r.name)) === JSON.stringify(off.map(r => r.name)))
check('JevEval sits where the name sort puts it', JSON.stringify(onNames) === JSON.stringify([...onNames].sort((a, b) => a.localeCompare(b))))
setJevEnabled(false)
check('off again, the pool is the off pool', JSON.stringify(projection()) === offJson)
storeJevApiKey(null)
setJevEnabled(true)
check('on without a key, the pool is the off pool', JSON.stringify(projection()) === offJson)
storeJevApiKey(PROOF_KEY)

section('§2b sub-agents receive JevEval by default, with an explicit stored opt-out')
const agent = { agentType: 'subagent' as const, agentId: 'roster-agent' }
const agentHasJev = () => runWithAgentContext(agent, () => projection().some(row => row.name === 'JevEval'))
check('default-on sub-agents see JevEval with the JEV switch on and a key', readJevSettings().subagents && agentHasJev())
check('the real sub-agent tool filter admits JevEval by default', filterToolsForAgent({ tools: assembleToolPool(ctx, []), isBuiltIn: true }).some(tool => tool.name === 'JevEval'))
check('a background (async) built-in agent keeps JevEval by default too — the async allow-set names it', filterToolsForAgent({ tools: assembleToolPool(ctx, []), isBuiltIn: true, isAsync: true }).some(tool => tool.name === 'JevEval'))
check('the async allow-set carries JEV_TOOL_NAME itself', ASYNC_AGENT_ALLOWED_TOOLS.has(JEV_TOOL_NAME))
setJevSubagents(false)
check('a stored false removes JevEval from a sub-agent roster', !agentHasJev() && (JSON.parse(readFileSync(join(HOME, '.mercury.json'), 'utf8')).jev?.subagents === false))
check('a stored false closes the real sub-agent filter too', !filterToolsForAgent({ tools: assembleToolPool(ctx, []), isBuiltIn: true }).some(tool => tool.name === 'JevEval'))
check('a stored false closes the background filter too (the /jev gate governs the allow-set)', !filterToolsForAgent({ tools: assembleToolPool(ctx, []), isBuiltIn: true, isAsync: true }).some(tool => tool.name === 'JevEval'))
check('the agent opt-out leaves the main roster unchanged', projection().some(row => row.name === 'JevEval'))
setJevSubagents(true)
check('returning to default restores the agent roster', agentHasJev())
setJevEnabled(false)
check('default-on agents still obey the global JEV switch', !agentHasJev())
setJevEnabled(true)
storeJevApiKey(null)
check('default-on agents still need this road\'s key', !agentHasJev())
storeJevApiKey(PROOF_KEY)

section('§3 the bytes JevEval adds to every request, reported without a ceiling')
const wire = { name: JevEvalTool.name, description: await JevEvalTool.prompt({} as never), input_schema: schemaOf(JevEvalTool) }
const wireJson = JSON.stringify(wire)
const bytes = Buffer.byteLength(wireJson, 'utf8')
const promptBytes = Buffer.byteLength(wire.description, 'utf8')
const schemaBytes = Buffer.byteLength(JSON.stringify(wire.input_schema), 'utf8')
const recorded = JSON.parse(readFileSync(CEILING_PATH, 'utf8')) as { bytes: number }
console.log(`  reported, never bounded: ${bytes} bytes on the wire (prompt ${promptBytes} + schema ${schemaBytes} + envelope); recorded observation ${recorded.bytes}; estimated tokens ${Math.ceil(bytes / 4)} at 4 bytes/token`)
check('the description is the prompt module\'s text', wire.description === JEV_EVAL_PROMPT)
check('the schema rendered', typeof wire.input_schema === 'object' && wire.input_schema !== null, String(wire.input_schema))
check('the JevEval entry the pool carries is that wire entry', JSON.stringify(on.find(r => r.name === 'JevEval')?.input_schema) === JSON.stringify(wire.input_schema))
check('the tool source under src/tools/JevEvalTool carries no comment line', (() => {
  const dir = join(ROOT, 'src', 'tools', 'JevEvalTool')
  for (const file of ['constants.ts', 'prompt.ts', 'JevEvalTool.ts', 'jevEvalSchema.ts', 'jevEvalRequest.ts', 'jevEvalResult.ts']) {
    const text = readFileSync(join(dir, file), 'utf8')
    if (/^\s*\/\//m.test(text) || text.includes('/' + '*')) return false
  }
  return true
})())

resetJevLedger()
setJevEnabled(false)
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
