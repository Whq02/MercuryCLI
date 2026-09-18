#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as unknown as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const ROOT = join(import.meta.dir, '..', '..')

const { toOpenaiStrictSchema, stripExplicitNulls } = await import(
  '../../src/utils/messages/structuredOutputDialect.ts'
)
const { buildOpenaiResponsesRequest } = await import(
  '../../src/services/providers/openai/responsesBridge.ts'
)
const { VERDICT_JSON_SCHEMA } = await import('../../src/utils/hooks/execPromptHook.ts')
const { hookResponseSchema } = await import('../../src/utils/hooks/hookHelpers.ts')

console.log('============================================================')
console.log(' STRUCTURED-OUTPUT DIALECT — the wire law + the decode law')
console.log('============================================================')

type Node = Record<string, unknown>
const isRecord = (v: unknown): v is Node => typeof v === 'object' && v !== null && !Array.isArray(v)

const opsPlanSchema = (): Node => ({
  type: 'object',
  properties: {
    ops: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['add', 'done', 'pri', 'refine'] },
          id: { type: 'string' },
          text: { type: 'string' },
          pri: { type: 'string', enum: ['now', 'next', 'later'] },
          refinedText: { type: 'string' },
        },
        required: ['op'],
        additionalProperties: false,
      },
    },
    reply: { type: 'string' },
  },
  required: ['ops', 'reply'],
  additionalProperties: false,
})

function strictViolations(node: unknown, path: string, out: string[]): string[] {
  if (Array.isArray(node)) {
    node.forEach((n, i) => strictViolations(n, `${path}[${i}]`, out))
    return out
  }
  if (!isRecord(node)) return out
  if (isRecord(node.properties)) {
    const keys = Object.keys(node.properties)
    const req = Array.isArray(node.required) ? (node.required as string[]) : []
    for (const k of keys) if (!req.includes(k)) out.push(`${path}: required omits ${k}`)
    if (node.additionalProperties !== false) out.push(`${path}: additionalProperties not false`)
    for (const [k, child] of Object.entries(node.properties)) {
      strictViolations(child, `${path}.${k}`, out)
    }
  }
  if (node.items !== undefined) strictViolations(node.items, `${path}.items`, out)
  for (const comb of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(node[comb])) strictViolations(node[comb], `${path}.${comb}`, out)
  }
  return out
}

function admitsNull(node: unknown): boolean {
  if (!isRecord(node)) return false
  const t = node.type
  if (Array.isArray(t) && t.includes('null')) return true
  if (Array.isArray(node.anyOf) && (node.anyOf as unknown[]).some(a => isRecord(a) && a.type === 'null'))
    return true
  return false
}

function wireSchemaOf(fmt: { schema: Node }): Node {
  const req = buildOpenaiResponsesRequest({
    model: 'gpt-5.6-luna',
    messages: [],
    outputFormat: fmt,
  } as never)
  const wire = (req as { text?: { format?: { schema?: unknown } } }).text?.format?.schema
  if (!isRecord(wire)) throw new Error('no wire schema emitted')
  return wire
}

section('§1 the wire is the strict dialect for every product schema')
{
  const rows: Array<[string, { schema: Node }]> = [
    ['ops plan (the sighting shape)', { type: 'json_schema', schema: opsPlanSchema() } as never],
    ['prompt-hook verdict', { type: 'json_schema', schema: VERDICT_JSON_SCHEMA as unknown as Node } as never],
  ]
  for (const [name, fmt] of rows) {
    const wire = wireSchemaOf(fmt)
    const violations = strictViolations(wire, name, [])
    check(`${name}: zero strict-dialect violations on the wire`, violations.length === 0, violations.join(' · '))
  }
  const chatWire = wireSchemaOf({ type: 'json_schema', schema: opsPlanSchema() } as never)
  const ops = ((chatWire.properties as Node).ops as Node).items as Node
  const props = ops.properties as Node
  check('chat ops.items: op (originally required) stays non-nullable', !admitsNull(props.op))
  for (const k of ['id', 'text', 'pri', 'refinedText']) {
    check(`chat ops.items: ${k} (originally optional) admits null on the wire`, admitsNull(props[k]))
  }
  const pri = props.pri as Node
  check('chat ops.items: the optional enum admits the null VALUE', Array.isArray(pri.enum) && (pri.enum as unknown[]).includes(null))
}

section('§2 the transform: idempotent, lawful-preserving, never over-nullable')
{
  const once = toOpenaiStrictSchema(opsPlanSchema())
  const twice = toOpenaiStrictSchema(once)
  check('idempotent: transforming twice equals once', JSON.stringify(once) === JSON.stringify(twice))
  const lawful: Node = {
    type: 'object',
    properties: { reply: { type: 'string' }, items: { type: 'array', items: { type: 'object', properties: { prompt: { type: 'string' }, text: { type: 'string' } }, required: ['prompt', 'text'], additionalProperties: false } } },
    required: ['reply', 'items'],
    additionalProperties: false,
  }
  const lawfulStrict = toOpenaiStrictSchema(lawful)
  const lawfulItems = ((lawfulStrict.properties as Node).items as Node).items as Node
  check(
    'a lawful schema keeps its required set (items)',
    JSON.stringify((lawfulItems.required as string[]).slice().sort()) === JSON.stringify(['prompt', 'text']),
  )
  check('a lawful schema gains no nullability (reply)', !admitsNull((lawfulStrict.properties as Node).reply))
  const input = opsPlanSchema()
  toOpenaiStrictSchema(input)
  check('input is not mutated', ((((input.properties as Node).ops as Node).items as Node).required as string[]).length === 1)
}

section('§3 stripExplicitNulls: object keys drop, array elements stay')
{
  const stripped = stripExplicitNulls({ a: 1, b: null, c: { d: null, e: 'x' }, f: [1, null, 2] }) as Node
  check('null-valued keys drop at every depth', JSON.stringify(stripped) === JSON.stringify({ a: 1, c: { e: 'x' }, f: [1, null, 2] }))
  check('non-objects pass through', stripExplicitNulls('t') === 't' && stripExplicitNulls(null) === null)
}

section('§4 strict-shaped answers validate ONLY through the strip (the tooth)')
{
  const hookRefused = hookResponseSchema().safeParse({ ok: true, reason: null })
  check('CONTROL: the unstripped hook verdict refuses zod', hookRefused.success === false)
  const hookHealed = hookResponseSchema().safeParse(stripExplicitNulls({ ok: true, reason: null }))
  check('the stripped hook verdict passes zod', hookHealed.success === true)
}

section('§5 the wiring: transform at the bridge, strip at the decode site')
{
  const bridge = readFileSync(join(ROOT, 'src/services/providers/openai/responsesBridge.ts'), 'utf8')
  check('the bridge wears the transform at its one schema site', bridge.includes('schema: toOpenaiStrictSchema(i.outputFormat.schema)'))
  const hook = readFileSync(join(ROOT, 'src/utils/hooks/execPromptHook.ts'), 'utf8')
  check('the hook verdict wears the strip', hook.includes('safeParse(stripExplicitNulls(parsed))'))
}

console.log('')
if (failures > 0) {
  console.log(`❌ prove-structured-output-dialect: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('✅ prove-structured-output-dialect: ALL GREEN')
