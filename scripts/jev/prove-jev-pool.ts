#!/usr/bin/env bun
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'jev-pool-home-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_JEV_BASE = 'http://127.0.0.1:1'
delete process.env.TYPESAFE_API_KEY
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

const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const { getAllBaseTools } = await import('../../src/tools.js')
const { JEV_TOOL_NAME } = await import('../../src/services/jev/jevContract.js')
const { setJevEnabled, setJevSubagents } = await import('../../src/services/jev/jevSetting.js')
const { storeJevApiKey } = await import('../../src/services/jev/jevKey.js')
const { JevEvalTool } = await import('../../src/tools/JevEvalTool/JevEvalTool.js')
const { filterToolsForAgent } = await import('../../src/tools/AgentTool/agentToolUtils.js')
const { buildToolCensus } = await import('../../src/utils/capability/census.js')

type ToolLike = { name: string }
const names = (tools: readonly ToolLike[]): string[] => tools.map(tool => tool.name)

section('§1 the tool census rows JevEval as unavailable while the switch is off, never silently absent')
setJevEnabled(false)
const offCensus = buildToolCensus()
const offRow = offCensus.rows.find(row => row.name === JEV_TOOL_NAME)
check('the row exists with the switch off', offRow !== undefined)
check('and reads unavailable', offRow?.support === 'unavailable', String(offRow?.support))
check('the catalogue itself has no JevEval while off', !names(getAllBaseTools()).includes(JEV_TOOL_NAME))

section('§2 a sub-agent pool drops JevEval unless the sub-agents setting is on')
setJevEnabled(true)
storeJevApiKey('proof-key-jev-pool-not-a-real-key')
const pool = [...getAllBaseTools()]
check('with the switch on and a key, the catalogue carries JevEval', names(pool).includes(JEV_TOOL_NAME))
setJevSubagents(false)
const filteredOff = filterToolsForAgent({ tools: pool, isBuiltIn: true })
check('sub-agents off: the filtered pool has no JevEval', !names(filteredOff).includes(JEV_TOOL_NAME))
check('sub-agents off: every other tool the filter keeps is untouched', names(filteredOff).length === names(filterToolsForAgent({ tools: pool.filter(tool => tool.name !== JEV_TOOL_NAME), isBuiltIn: true })).length)
const filteredCustomOff = filterToolsForAgent({ tools: pool, isBuiltIn: false })
check('sub-agents off: a custom agent has no JevEval either', !names(filteredCustomOff).includes(JEV_TOOL_NAME))
setJevSubagents(true)
const filteredOn = filterToolsForAgent({ tools: pool, isBuiltIn: true })
check('sub-agents on: the filtered pool keeps JevEval', names(filteredOn).includes(JEV_TOOL_NAME))
check('the tool object is the catalogue entry, not a copy', filteredOn.includes(JevEvalTool))
setJevSubagents(false)
storeJevApiKey(null)
setJevEnabled(false)

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
