#!/usr/bin/env bun
// ============================================================================
//  scripts/tabula/prove-structured-output-dialect.ts
//  PROOF: structured-output schemas reach the OpenAI wire in the vendor's
//  STRICT dialect, and decoded answers shed the dialect before validation.
//
//  The live sighting (gpt-5.6-luna, real credentials):
//  Minerva's chat leg was refused at the wire — http 400 invalid_json_schema,
//  "In context=('properties','ops','items'), 'required' is required to be
//  supplied and to include every key in `properties`" — before any model ran.
//  The fixture wires never validated schemas, so no fixture could catch it.
//
//  Locks:
//   (1) the REAL bridge (buildOpenaiResponsesRequest) emits every product
//       schema (minerva boot · minerva chat · the prompt-hook verdict ·
//       the minerva room) in the strict dialect: every object level closed,
//       `required` naming every key, originally-optional keys nullable;
//   (2) the transform's own laws: idempotent, lawful schemas keep their
//       required sets, required keys never turn nullable, enums admit the
//       null VALUE only when made optional;
//   (3) stripExplicitNulls: null-valued object keys drop recursively; array
//       elements are never dropped; non-objects pass through;
//   (4) the validators under the dialect: a strict-shaped answer (explicit
//       nulls for absent fields) passes validateMinervaPlan /
//       validateMinervaChatPlan / the hook's zod verdict ONLY through the
//       strip — the unstripped control refuses, proving the strip is
//       load-bearing;
//   (5) the wiring pins: the bridge call site wears the transform; both
//       minerva decode sites and the hook verdict wear the strip.
//
//  Run: ~/.bun/bin/bun run scripts/tabula/prove-structured-output-dialect.ts
// ============================================================================
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
const { minervaOutputFormat, minervaChatOutputFormat, validateMinervaPlan, validateMinervaChatPlan } =
  await import('../../src/utils/tabula/minerva.ts')
const { minervaRoomOutputFormat } = await import('../../src/utils/tabula/minervaRoom.ts')
const { VERDICT_JSON_SCHEMA } = await import('../../src/utils/hooks/execPromptHook.ts')
const { hookResponseSchema } = await import('../../src/utils/hooks/hookHelpers.ts')

console.log('============================================================')
console.log(' STRUCTURED-OUTPUT DIALECT — the wire law + the decode law')
console.log('============================================================')

type Node = Record<string, unknown>
const isRecord = (v: unknown): v is Node => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Walk a wire schema asserting the strict dialect; returns violations. */
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

// ── §1 every product schema reaches the wire strict-lawful ──────────────────
section('§1 the wire is the strict dialect for every product schema')
{
  const rows: Array<[string, { schema: Node }]> = [
    ['minerva boot', minervaOutputFormat() as { schema: Node }],
    ['minerva chat', minervaChatOutputFormat() as { schema: Node }],
    ['minerva room', minervaRoomOutputFormat() as { schema: Node }],
    ['prompt-hook verdict', { type: 'json_schema', schema: VERDICT_JSON_SCHEMA as unknown as Node } as never],
  ]
  for (const [name, fmt] of rows) {
    const wire = wireSchemaOf(fmt)
    const violations = strictViolations(wire, name, [])
    check(`${name}: zero strict-dialect violations on the wire`, violations.length === 0, violations.join(' · '))
  }
  // The sighting's exact shape: the chat ops row — originally-optional keys
  // are nullable on the wire, the op discriminator (originally required) is not.
  const chatWire = wireSchemaOf(minervaChatOutputFormat() as { schema: Node })
  const ops = ((chatWire.properties as Node).ops as Node).items as Node
  const props = ops.properties as Node
  check('chat ops.items: op (originally required) stays non-nullable', !admitsNull(props.op))
  for (const k of ['id', 'text', 'pri', 'refinedText']) {
    check(`chat ops.items: ${k} (originally optional) admits null on the wire`, admitsNull(props[k]))
  }
  const pri = props.pri as Node
  check('chat ops.items: the optional enum admits the null VALUE', Array.isArray(pri.enum) && (pri.enum as unknown[]).includes(null))
}

// ── §2 transform laws ───────────────────────────────────────────────────────
section('§2 the transform: idempotent, lawful-preserving, never over-nullable')
{
  const once = toOpenaiStrictSchema(minervaChatOutputFormat().schema as Node)
  const twice = toOpenaiStrictSchema(once)
  check('idempotent: transforming twice equals once', JSON.stringify(once) === JSON.stringify(twice))
  const room = minervaRoomOutputFormat().schema as Node
  const roomStrict = toOpenaiStrictSchema(room)
  const refits = ((roomStrict.properties as Node).refinements as Node).items as Node
  check(
    'a lawful schema keeps its required set (room refinements.items)',
    JSON.stringify((refits.required as string[]).slice().sort()) === JSON.stringify(['prompt', 'refinedText']),
  )
  check('a lawful schema gains no nullability (room reply)', !admitsNull((roomStrict.properties as Node).reply))
  check('input is not mutated', (minervaChatOutputFormat().schema as { properties: { ops: { items: { required: string[] } } } }).properties.ops.items.required.length === 1)
}

// ── §3 the strip ────────────────────────────────────────────────────────────
section('§3 stripExplicitNulls: object keys drop, array elements stay')
{
  const stripped = stripExplicitNulls({ a: 1, b: null, c: { d: null, e: 'x' }, f: [1, null, 2] }) as Node
  check('null-valued keys drop at every depth', JSON.stringify(stripped) === JSON.stringify({ a: 1, c: { e: 'x' }, f: [1, null, 2] }))
  check('non-objects pass through', stripExplicitNulls('t') === 't' && stripExplicitNulls(null) === null)
}

// ── §4 the validators under the dialect ─────────────────────────────────────
section('§4 strict-shaped answers validate ONLY through the strip (the tooth)')
{
  const bootAnswer = {
    notes: [{ id: 'n1', pri: null, refinedText: null }],
    orderedIds: ['n1'],
    doneIds: null,
    receipt: 'ok',
  }
  const live = new Set(['n1'])
  const refused = validateMinervaPlan(bootAnswer, live, live)
  check('CONTROL: the unstripped boot answer refuses', refused.ok === false)
  const healed = validateMinervaPlan(stripExplicitNulls(bootAnswer), live, live)
  check('the stripped boot answer validates', healed.ok === true)

  const chatAnswer = {
    ops: [{ op: 'add', id: null, text: 'a note', pri: null, refinedText: null }],
    reply: 'added',
  }
  const chatRefused = validateMinervaChatPlan(chatAnswer, new Set<string>())
  check('CONTROL: the unstripped chat answer refuses', chatRefused.ok === false)
  const chatHealed = validateMinervaChatPlan(stripExplicitNulls(chatAnswer), new Set<string>())
  check('the stripped chat answer validates as one add', chatHealed.ok === true && chatHealed.ok && chatHealed.plan.ops.length === 1)

  const hookRefused = hookResponseSchema().safeParse({ ok: true, reason: null })
  check('CONTROL: the unstripped hook verdict refuses zod', hookRefused.success === false)
  const hookHealed = hookResponseSchema().safeParse(stripExplicitNulls({ ok: true, reason: null }))
  check('the stripped hook verdict passes zod', hookHealed.success === true)
}

// ── §5 wiring pins ──────────────────────────────────────────────────────────
section('§5 the wiring: transform at the bridge, strip at every decode site')
{
  const bridge = readFileSync(join(ROOT, 'src/services/providers/openai/responsesBridge.ts'), 'utf8')
  check('the bridge wears the transform at its one schema site', bridge.includes('schema: toOpenaiStrictSchema(i.outputFormat.schema)'))
  const minerva = readFileSync(join(ROOT, 'src/utils/tabula/minerva.ts'), 'utf8')
  check('both minerva decode sites wear the strip', minerva.split('stripExplicitNulls(decoded.value)').length === 3)
  const hook = readFileSync(join(ROOT, 'src/utils/hooks/execPromptHook.ts'), 'utf8')
  check('the hook verdict wears the strip', hook.includes('safeParse(stripExplicitNulls(parsed))'))
}

console.log('')
if (failures > 0) {
  console.log(`❌ prove-structured-output-dialect: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('✅ prove-structured-output-dialect: ALL GREEN')
