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
const { setJevEnabled } = await import('../../src/services/jev/jevSetting.ts')
const { storeJevApiKey } = await import('../../src/services/jev/jevKey.ts')
const { resetJevLedger } = await import('../../src/services/jev/jevLedger.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { zodToJsonSchema } = await import('../../src/utils/zodToJsonSchema.ts')
const { assembleToolPool, getAllBaseTools } = await import('../../src/tools.ts')
const { JevEvalTool } = await import('../../src/tools/JevEvalTool/JevEvalTool.ts')
const { JEV_EVAL_PROMPT } = await import('../../src/tools/JevEvalTool/prompt.ts')

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

section('§3 the bytes JevEval adds to every request, against the committed ceiling')
const wire = { name: JevEvalTool.name, description: await JevEvalTool.prompt({} as never), input_schema: schemaOf(JevEvalTool) }
const wireJson = JSON.stringify(wire)
const bytes = Buffer.byteLength(wireJson, 'utf8')
const promptBytes = Buffer.byteLength(wire.description, 'utf8')
const schemaBytes = Buffer.byteLength(JSON.stringify(wire.input_schema), 'utf8')
const ceiling = JSON.parse(readFileSync(CEILING_PATH, 'utf8')) as { bytes: number }
console.log(`  measured: ${bytes} bytes on the wire (prompt ${promptBytes} + schema ${schemaBytes} + envelope); ceiling ${ceiling.bytes}; estimated tokens ${Math.ceil(bytes / 4)}`)
check('the description is the prompt module\'s text', wire.description === JEV_EVAL_PROMPT)
check('the schema rendered', typeof wire.input_schema === 'object' && wire.input_schema !== null, String(wire.input_schema))
check(`the added bytes (${bytes}) are within the committed ceiling (${ceiling.bytes})`, bytes <= ceiling.bytes, `raise the ceiling in ${CEILING_PATH} only with the reason in the commit message`)
if (bytes < ceiling.bytes * 0.9) console.log(`  note: the ceiling is slack by more than a tenth (measured ${bytes}, ceiling ${ceiling.bytes}) — ratchet it down to the measured figure`)
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
