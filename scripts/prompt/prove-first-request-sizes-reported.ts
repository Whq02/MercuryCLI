#!/usr/bin/env bun
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

delete process.env.NODE_ENV
for (const k of ['ANTHROPIC_BASE_URL', 'MERCURY_TOOL_SEARCH', 'MERCURY_TOOL_DEFER', 'MERCURY_TOOL_DEFER_PROBE', 'MERCURY_MODEL', 'MERCURY_OPENAI_API_BASE', 'MERCURY_OPENAI_CHATGPT_BASE']) {
  delete process.env[k]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'first-request-sizes-'))
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const ROOT = join(import.meta.dir, '..', '..')
const CEILING_PROVER = join(ROOT, 'scripts', 'prompt', 'prove-first-call-ceiling.ts')

section('§1 the first-request prover reports its sizes and never fails on one')
const source = readFileSync(CEILING_PROVER, 'utf8')
const lines = source.split('\n')
const boundedChecks = lines.filter(line => /\bcheck\(/.test(line) && /(<=|>=|<|>)\s*\(?\s*\d/.test(line))
check('no check compares a size or a count against a number', boundedChecks.length === 0, boundedChecks.map(line => line.trim().slice(0, 80)).join(' | '))
for (const literal of ['27500', '46000', '6800', '240000', '81000']) {
  check(`the figure ${literal} is gone from the prover`, !source.includes(literal))
}
check('no check bounds how many tools load initially', !/eager\.length\s*<=/.test(source))
const reportLine = lines.find(line => line.includes('console.log') && line.includes('initial definitions') && line.includes('request'))
check('one report line names the initial definitions and the whole request with their bytes', reportLine !== undefined && /bytes/.test(reportLine ?? ''))
check('the report line carries a token estimate and names its divisor', /tokens at 4 bytes\/token/.test(source))
check('the daily-tools law and the fixture-turn law stay', source.includes('daily file and execution tools remain loaded') && source.includes('completes its fixture turn'))

section('§2 the roster builder carries everything asked for in full, whatever the size')
const { planToolPayload, clearToolRosterLatches } = await import('../../src/services/providers/toolEconomy.ts')
const { toolToAPISchema } = await import('../../src/utils/api.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { ToolSearchTool } = await import('../../src/tools/ToolSearchTool/ToolSearchTool.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
type Tool = import('../../src/Tool.ts').Tool
type Message = import('../../src/types/message.ts').Message

const WIDE_PARAMS = Array.from({ length: 40 }, (_, i) => `field_${i}`)
const LONG_TEXT = (name: string): string => `${name}: ${'the whole description rides, byte for byte, however long it is. '.repeat(780)}`
function giantTool(name: string, opts: { defer?: boolean } = {}): Tool {
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const p of WIDE_PARAMS) shape[p] = z.string().describe(`${p} of ${name}`)
  const text = LONG_TEXT(name)
  return {
    name,
    ...(opts.defer ? { shouldDefer: true } : {}),
    prompt: async () => text,
    description: async () => `${name} giant`,
    inputSchema: z.object(shape),
    isEnabled: () => true,
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    userFacingName: () => name,
    call: async () => ({ data: 'fixture' }),
  } as unknown as Tool
}
const GIANTS = Array.from({ length: 200 }, (_, i) => giantTool(`Giant${String(i).padStart(3, '0')}`))
const DRAWER = ['WebFetch', 'Browser'].map(name => giantTool(name, { defer: true }))
const POOL: Tool[] = [...GIANTS, ToolSearchTool as never, ...DRAWER]
const permissionContext = getEmptyToolPermissionContext()
const messages: Message[] = [createUserMessage({ content: 'hello' }) as Message]
const ROUTES: Array<[string, string]> = [
  ['anthropic block form', 'claude-sonnet-5'],
  ['openai text form', 'gpt-5.3-codex'],
  ['openai native form', 'gpt-5.6-sol'],
  ['moonshot text-append form', 'kimi-k3'],
  ['openrouter native form', 'openrouter/qwen/qwen3-coder'],
  ['local text form', 'local/qwen3-32b'],
]
const giantBytes = GIANTS.reduce((total, tool) => total + Buffer.byteLength(LONG_TEXT(tool.name), 'utf8'), 0)
console.log(`  the catalogue: ${GIANTS.length} tools asked for in full, ${giantBytes.toLocaleString('en-US')} bytes of description, ${WIDE_PARAMS.length} fields each`)
check('the catalogue is far above every figure the prover once bounded', giantBytes > 10 * 240000)
for (const [label, model] of ROUTES) {
  clearToolRosterLatches()
  const plan = await planToolPayload({ model, tools: POOL, messages, getToolPermissionContext: async () => permissionContext, agents: [], source: 'sizes' })
  const rosterNames = new Set(plan.roster.map(tool => tool.name))
  const missing = GIANTS.filter(tool => !rosterNames.has(tool.name)).map(tool => tool.name)
  const deferred = GIANTS.filter(tool => plan.deferredNames.has(tool.name)).map(tool => tool.name)
  const unadmitted = GIANTS.filter(tool => plan.isDeferredUnadmitted(tool.name)).map(tool => tool.name)
  check(`${label} (${model}): every tool asked for in full is in the roster`, missing.length === 0, `${missing.length} missing: ${missing.slice(0, 3).join(', ')}`)
  check(`${label}: none of them is deferred or held for admission`, deferred.length === 0 && unadmitted.length === 0, `deferred ${deferred.length} · unadmitted ${unadmitted.length}`)
  const first = plan.roster.find(tool => tool.name === GIANTS[0]!.name)
  const last = plan.roster.find(tool => tool.name === GIANTS[GIANTS.length - 1]!.name)
  let intact = first !== undefined && last !== undefined
  for (const tool of [first, last]) {
    if (tool === undefined) continue
    const schema = (await toolToAPISchema(tool, { getToolPermissionContext: async () => permissionContext, tools: plan.roster, agents: [], model })) as { description?: string; input_schema?: { properties?: Record<string, unknown> } }
    if (schema.description !== LONG_TEXT(tool.name)) intact = false
    if (Object.keys(schema.input_schema?.properties ?? {}).length !== WIDE_PARAMS.length) intact = false
  }
  check(`${label}: the first and the last definition ride byte-for-byte, every field intact`, intact)
}
clearToolRosterLatches()

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
