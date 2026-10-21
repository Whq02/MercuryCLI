#!/usr/bin/env bun
process.env.MERCURY_DESKTOP_DRIVER = 'none'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'tool-forms-any-value-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.env.MERCURY_DAEMON_DIR = join(SCRATCH, 'daemon')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
if (process.env.NODE_ENV === 'test') delete process.env.NODE_ENV
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
let checks = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  checks++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail.length > 600 ? `${detail.slice(0, 600)}…` : detail}` : ''}`)
  if (!ok) failures++
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}`)
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — tool forms any-value proof exceeded 180s')
  process.exit(1)
}, 180_000)
watchdog.unref?.()

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { getAllBaseTools } = await import('../../src/tools.ts')
const { toolToAPISchema } = await import('../../src/utils/api.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { mapToolsToOpenai } = await import('../../src/services/providers/openai/responsesBridge.ts')
const { gateToolCall } = await import('../../src/services/providers/toolCallGate.ts')
const { toOpenaiStrictToolSchema } = await import('../../src/utils/messages/toolSchemaDialect.ts')

type Node = Record<string, unknown>
const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null && !Array.isArray(v)
const ANY_VALUE = /^G1 .*admits any value/

function typelessNodes(root: unknown): string[] {
  const found: string[] = []
  const walk = (node: unknown, path: string, depth: number): void => {
    if (!isNode(node) || depth > 14) return
    if (typeof node.$ref === 'string') return
    const shaped = 'type' in node || Array.isArray(node.anyOf) || Array.isArray(node.enum) || 'const' in node
    if (!shaped) found.push(path === '' ? 'root' : path)
    if (isNode(node.properties)) for (const [key, child] of Object.entries(node.properties)) walk(child, path === '' ? key : `${path}.${key}`, depth + 1)
    if (node.items !== undefined) walk(node.items, `${path}[]`, depth + 1)
    if (Array.isArray(node.anyOf)) node.anyOf.forEach((arm, index) => walk(arm, `${path}|${index}`, depth))
    for (const table of ['$defs', 'definitions']) {
      if (!isNode(node[table])) continue
      for (const [name, def] of Object.entries(node[table] as Node)) walk(def, `${path}${path === '' ? '' : '.'}${table}.${name}`, depth)
    }
  }
  walk(root, '', 0)
  return found
}

section('§1 the converter: a schema that admits any value has no strict spelling, so its tool rides non-strict with the rule named')
{
  const typeless = { type: 'object', properties: { payload: { description: 'any JSON value, verbatim' } }, required: ['payload'] }
  const form = toOpenaiStrictToolSchema(typeless)
  t('a required property with no type (zod unknown) makes the tool non-strict', form.strict === false, JSON.stringify(form))
  t('…and the reason names the rule and the slot', form.strict === false && ANY_VALUE.test(form.reason) && form.reason.endsWith(' at payload'), form.strict === false ? form.reason : '')
  const optional = toOpenaiStrictToolSchema({ type: 'object', properties: { payload: { description: 'maybe anything' } } })
  t('an optional property with no type is not rescued by nullability: non-strict for the same reason', optional.strict === false && ANY_VALUE.test(optional.reason), JSON.stringify(optional))
  const items = toOpenaiStrictToolSchema({ type: 'object', properties: { xs: { type: 'array', items: {} } }, required: ['xs'] })
  t('an array whose items admit any value: non-strict at the items', items.strict === false && ANY_VALUE.test(items.reason) && items.reason.endsWith(' at xs.items'), JSON.stringify(items))
  const literalTrue = toOpenaiStrictToolSchema({ type: 'object', properties: { p: true }, required: ['p'] })
  t('the literal true schema is the same any-value schema: non-strict', literalTrue.strict === false && ANY_VALUE.test(literalTrue.reason), JSON.stringify(literalTrue))
  const nested = toOpenaiStrictToolSchema({ type: 'object', properties: { outer: { type: 'object', properties: { inner: { description: 'deep' } }, required: ['inner'] } }, required: ['outer'] })
  t('a typeless slot two objects down is found with its path', nested.strict === false && nested.reason.endsWith(' at outer.inner'), JSON.stringify(nested))
  const typed = toOpenaiStrictToolSchema({ type: 'object', properties: { a: { type: 'string' }, b: { type: 'object', properties: { c: { type: 'number' } }, required: ['c'], additionalProperties: false }, d: { anyOf: [{ type: 'string' }, { type: 'number' }] }, e: { $ref: '#/$defs/row' } }, required: ['a'], $defs: { row: { type: 'object', properties: { v: { type: 'boolean' } }, required: ['v'], additionalProperties: false } } })
  t('typed, union and $ref slots beside each other still convert strict (the rule does not over-fire)', typed.strict === true && typelessNodes(typed.strict ? typed.schema : {}).length === 0, JSON.stringify(typed).slice(0, 300))
  const closedEmpty = toOpenaiStrictToolSchema({ type: 'object', properties: {} })
  t('a tool with no parameters is still a closed empty object, strict', closedEmpty.strict === true, JSON.stringify(closedEmpty))
}

section('§2 the real wire: the Workflow tool (args: any JSON value) rides non-strict; no strict form carries a typeless node')
{
  const tools = getAllBaseTools()
  const wires: Array<{ name: string; wire: Node }> = []
  for (const tool of tools) {
    const built = (await toolToAPISchema(tool as never, { getToolPermissionContext: async () => getEmptyToolPermissionContext(), tools: tools as never, agents: [], model: 'gpt-6-astra' })) as { name: string; input_schema: Node; description?: string }
    const [wire] = mapToolsToOpenai([{ name: built.name, input_schema: built.input_schema, description: built.description ?? '' }]) as unknown as Node[]
    wires.push({ name: tool.name, wire: wire! })
  }
  const workflow = wires.find(entry => entry.name === 'Workflow')
  t('Workflow is in the base roster this proof reads', workflow !== undefined)
  t('Workflow is sent strict: false (its args slot admits any JSON value)', workflow?.wire.strict === false, JSON.stringify(workflow?.wire.strict))
  const workflowForm = workflow ? toOpenaiStrictToolSchema(workflow.wire.parameters) : undefined
  t('…for the any-value rule at args', workflowForm?.strict === false && ANY_VALUE.test(workflowForm.reason) && workflowForm.reason.endsWith(' at args'), workflowForm?.strict === false ? workflowForm.reason : JSON.stringify(workflowForm))
  t('Workflow\'s non-strict parameters are its schema as written (args keeps its description, no type invented)', workflow !== undefined && isNode(workflow.wire.parameters) && isNode((workflow.wire.parameters as Node).properties) && !('type' in (((workflow.wire.parameters as Node).properties as Node).args as Node)), JSON.stringify((workflow?.wire.parameters as Node | undefined)?.properties).slice(0, 200))
  const typelessStrict = wires.filter(entry => entry.wire.strict === true).flatMap(entry => typelessNodes(entry.wire.parameters).map(path => `${entry.name} at ${path}`))
  t(`no strict form on the wire carries a node without a type, $ref, anyOf, enum or const (the vendor refuses "schema must have a 'type' key" for the whole request)`, typelessStrict.length === 0, typelessStrict.join(' | '))
  const anyValueTools = wires.filter(entry => entry.wire.strict === false && ANY_VALUE.test(toOpenaiStrictToolSchema(entry.wire.parameters).strict === false ? (toOpenaiStrictToolSchema(entry.wire.parameters) as { reason: string }).reason : '')).map(entry => entry.name)
  t('Workflow is the only base tool the any-value rule moves to non-strict (the rule does not over-fire on the roster)', anyValueTools.length === 1 && anyValueTools[0] === 'Workflow', anyValueTools.join(', '))
  const knownReasons = /propertyNames|additionalProperties|admits any value/
  const strangers = wires.filter(entry => entry.wire.strict === false).map(entry => ({ name: entry.name, form: toOpenaiStrictToolSchema(entry.wire.parameters) })).filter(entry => entry.form.strict || !knownReasons.test(entry.form.reason)).map(entry => `${entry.name}: ${entry.form.strict ? 'strict' : entry.form.reason}`)
  t('every non-strict base tool is non-strict for a free-form map, an open object or an any-value slot — no other reason', strangers.length === 0, strangers.join(' | '))
  const strictCount = wires.filter(entry => entry.wire.strict === true).length
  t(`the rest of the roster stays strict (${strictCount} of ${wires.length})`, strictCount >= wires.length - 8, `${strictCount} strict of ${wires.length}`)
}

section('§3 the answer road for a non-strict Workflow: an omitted or null args reaches the tool as absent')
{
  const workflow = getAllBaseTools().find(tool => tool.name === 'Workflow')
  t('Workflow is callable in this catalogue', workflow !== undefined)
  if (workflow) {
    const plain = gateToolCall([workflow] as never, { id: 'w1', name: 'Workflow', argumentsRaw: JSON.stringify({ name: 'review' }), malformed: false })
    t('a Workflow call naming a workflow and no args passes the gate', plain.ok, plain.ok ? '' : plain.refusal.reason)
    const nulled = gateToolCall([workflow] as never, { id: 'w2', name: 'Workflow', argumentsRaw: JSON.stringify({ name: 'review', args: null, script: null }), malformed: false })
    t('a Workflow call with args: null and script: null reaches the tool with both absent', nulled.ok && !('args' in nulled.input) && !('script' in nulled.input), nulled.ok ? JSON.stringify(nulled.input) : nulled.refusal.reason)
    const object = gateToolCall([workflow] as never, { id: 'w3', name: 'Workflow', argumentsRaw: JSON.stringify({ name: 'review', args: { files: ['a.ts'], depth: 2 } }), malformed: false })
    t('an object args rides through verbatim (the any-value slot keeps its whole range)', object.ok && JSON.stringify(object.input.args) === JSON.stringify({ files: ['a.ts'], depth: 2 }), object.ok ? JSON.stringify(object.input) : object.refusal.reason)
  }
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(`\n${checks} checks, ${failures} failed`)
console.log(failures === 0 ? 'ALL GREEN' : 'RED')
process.exit(failures === 0 ? 0 : 1)
