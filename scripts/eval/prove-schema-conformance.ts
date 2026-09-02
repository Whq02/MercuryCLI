#!/usr/bin/env bun
// ============================================================================
//  scripts/eval/prove-schema-conformance.ts
//  PROOF (spec 03 C1 · spec 01 C2): ONE JSON-schema validation engine.
//    · source pin: exactly one `new Ajv(` under src/ — in the engine module;
//      the retired permissive-lite validator (jsonSchemaLite) stays deleted
//      and both consumers (workflow structured output · eval bridge) import
//      the engine;
//    · verdict conformance: the eval bridge's applySchemaToReply and the
//      workflow's schema-bound StructuredOutput tool judge the SAME corpus
//      identically — including the four shapes the lite validator was
//      proven to wave through (oneOf both-branch · additionalProperties:
//      false without properties · tuple items with wrong types · not) and
//      the schema-refusal class (unknown keyword, strict compile);
//    · a refused schema TEACHES the correction, on both surfaces;
//    · non-strict eval keeps its value-over-refusal contract (tolerated,
//      never a silent verdict flip into refusal).
// ============================================================================
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { check, cleanup, finish, section, setup } from './lib.js'

const SRC = join(import.meta.dir, '../../src')

section('source pin: one engine, no second validator')
{
  const hits: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(ts|tsx)$/.test(name) && readFileSync(p, 'utf8').includes('new Ajv(')) {
        hits.push(p.slice(SRC.length + 1))
      }
    }
  }
  walk(SRC)
  check('exactly one `new Ajv(` under src/, in the engine', hits.length === 1 && hits[0] === 'services/schema/jsonSchemaEngine.ts', JSON.stringify(hits))
  check('the lite validator stays deleted', !existsSync(join(SRC, 'services/eval/jsonSchemaLite.ts')))
  const workflow = readFileSync(join(SRC, 'tools/WorkflowTool/structuredOutputTool.ts'), 'utf8')
  const bridge = readFileSync(join(SRC, 'services/eval/evalBridge.ts'), 'utf8')
  const synthetic = readFileSync(join(SRC, 'tools/SyntheticOutputTool/SyntheticOutputTool.ts'), 'utf8')
  check('the workflow consumer imports the engine', workflow.includes('services/schema/jsonSchemaEngine.js'))
  check('the eval bridge consumer imports the engine', bridge.includes('schema/jsonSchemaEngine.js'))
  check('the headless output-schema consumer imports the engine', synthetic.includes('services/schema/jsonSchemaEngine.js'))
  let liteRefs = 0
  const sweep = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) sweep(p)
      else if (/\.(ts|tsx)$/.test(name) && readFileSync(p, 'utf8').includes('validateAgainstJsonSchema')) liteRefs++
    }
  }
  sweep(SRC)
  check('no reference to the lite validator survives in src/', liteRefs === 0, String(liteRefs))
}

setup()
const { applySchemaToReply } = await import('../../src/services/eval/evalBridge.js')
const { getSchemaBoundStructuredOutputTool, SchemaMismatchError } = await import(
  '../../src/tools/WorkflowTool/structuredOutputTool.js'
)
const { createSyntheticOutputTool } = await import('../../src/tools/SyntheticOutputTool/SyntheticOutputTool.js')

type Verdict = 'accept' | 'reject' | 'schema-refused'

function evalVerdict(schema: object, value: unknown): Verdict {
  const answer = applySchemaToReply(JSON.stringify(value), schema, /*strict*/ true)
  if (answer.ok) return 'accept'
  return (answer.error ?? '').includes('refused by the validation engine') ? 'schema-refused' : 'reject'
}

async function workflowVerdict(schema: object, value: unknown): Promise<Verdict> {
  const bound = getSchemaBoundStructuredOutputTool(schema)
  if (bound.error !== undefined) return 'schema-refused'
  try {
    await (bound.tool as unknown as { call: (input: unknown) => Promise<unknown> }).call(value)
    return 'accept'
  } catch (e) {
    if (e instanceof SchemaMismatchError) return 'reject'
    throw e
  }
}

/** The headless --output-schema surface (createSyntheticOutputTool). */
async function headlessVerdict(schema: object, value: unknown): Promise<Verdict> {
  const bound = createSyntheticOutputTool(schema)
  if ('error' in bound) return 'schema-refused'
  try {
    await (bound.tool as unknown as { call: (input: unknown) => Promise<unknown> }).call(value)
    return 'accept'
  } catch (e) {
    if (e instanceof Error && e.message.includes('does not match the required schema')) return 'reject'
    throw e
  }
}

interface Row {
  name: string
  schema: object
  value: unknown
  /** The unified LAW's verdict — parity alone would also pass two engines
   *  that are identically wrong; the expectation pins the semantics. */
  expect: Verdict
}

// The divergence corpus: every shape the permissive-lite validator was
// PROVEN (PV receipt, finding N1) to accept where the engine rejects —
// plus their passing twins, so the engine is pinned in both directions.
const divergence: Row[] = [
  { name: 'oneOf matched by both branches', schema: { oneOf: [{ type: 'number' }, { type: 'integer' }] }, value: 3, expect: 'reject' },
  { name: 'oneOf matched by exactly one branch', schema: { oneOf: [{ type: 'string' }, { type: 'integer' }] }, value: 3, expect: 'accept' },
  { name: 'additionalProperties:false without properties', schema: { additionalProperties: false }, value: { a: 1 }, expect: 'reject' },
  { name: 'additionalProperties:false, empty object', schema: { additionalProperties: false }, value: {}, expect: 'accept' },
  { name: 'tuple items with wrong types', schema: { items: [{ type: 'number' }, { type: 'string' }] }, value: ['x', 2], expect: 'reject' },
  { name: 'tuple items with right types', schema: { items: [{ type: 'number' }, { type: 'string' }] }, value: [1, 'x'], expect: 'accept' },
  { name: 'not (value matches the negated schema)', schema: { not: { type: 'string' } }, value: 'x', expect: 'reject' },
  { name: 'not (value misses the negated schema)', schema: { not: { type: 'string' } }, value: 5, expect: 'accept' },
  { name: 'unknown keyword (strict compile refusal)', schema: { type: 'object', flibber: true }, value: {}, expect: 'schema-refused' },
]

// Shapes both validators always agreed on — conformance must not cost them.
const agreement: Row[] = [
  { name: 'required present', schema: { type: 'object', required: ['a'], properties: { a: { type: 'string' } } }, value: { a: 'x' }, expect: 'accept' },
  { name: 'required missing', schema: { type: 'object', required: ['a'], properties: { a: { type: 'string' } } }, value: {}, expect: 'reject' },
  { name: 'property type wrong', schema: { type: 'object', required: ['a'], properties: { a: { type: 'string' } } }, value: { a: 1 }, expect: 'reject' },
  { name: 'integer accepts 3', schema: { type: 'integer' }, value: 3, expect: 'accept' },
  { name: 'integer rejects 3.5', schema: { type: 'integer' }, value: 3.5, expect: 'reject' },
  { name: 'enum member', schema: { enum: ['a', 'b'] }, value: 'a', expect: 'accept' },
  { name: 'enum outsider', schema: { enum: ['a', 'b'] }, value: 'c', expect: 'reject' },
  { name: 'minLength met', schema: { type: 'string', minLength: 2 }, value: 'ab', expect: 'accept' },
  { name: 'minLength unmet', schema: { type: 'string', minLength: 2 }, value: 'a', expect: 'reject' },
  { name: 'anyOf hit', schema: { anyOf: [{ type: 'string' }, { type: 'number' }] }, value: 'x', expect: 'accept' },
  { name: 'anyOf miss', schema: { anyOf: [{ type: 'string' }, { type: 'number' }] }, value: true, expect: 'reject' },
  { name: 'numeric maximum', schema: { type: 'number', maximum: 10 }, value: 11, expect: 'reject' },
]

section('verdict conformance: eval ≡ workflow ≡ headless on the divergence corpus')
for (const row of divergence) {
  const fromEval = evalVerdict(row.schema, row.value)
  const fromWorkflow = await workflowVerdict(row.schema, row.value)
  const fromHeadless = await headlessVerdict(row.schema, row.value)
  check(
    `${row.name}: all three surfaces agree`,
    fromEval === fromWorkflow && fromEval === fromHeadless,
    `eval=${fromEval} workflow=${fromWorkflow} headless=${fromHeadless}`,
  )
  check(`${row.name}: the unified verdict is ${row.expect}`, fromEval === row.expect, `got ${fromEval}`)
}

section('verdict conformance: the agreement corpus stays intact')
for (const row of agreement) {
  const fromEval = evalVerdict(row.schema, row.value)
  const fromWorkflow = await workflowVerdict(row.schema, row.value)
  const fromHeadless = await headlessVerdict(row.schema, row.value)
  check(
    `${row.name}: eval ≡ workflow ≡ headless ≡ ${row.expect}`,
    fromEval === fromWorkflow && fromEval === fromHeadless && fromEval === row.expect,
    `eval=${fromEval} workflow=${fromWorkflow} headless=${fromHeadless}`,
  )
}

section('a refused schema teaches the correction, on both surfaces')
{
  const schema = { type: 'object', flibber: true }
  const fromEval = applySchemaToReply('{}', schema, true)
  check('eval error names the refusal class', !fromEval.ok && (fromEval.error ?? '').includes('unknown keyword'), fromEval.ok ? 'accepted' : fromEval.error)
  check('eval error teaches the correction', !fromEval.ok && (fromEval.error ?? '').includes('remove the unknown keyword'), fromEval.ok ? '' : fromEval.error)
  const bound = getSchemaBoundStructuredOutputTool(schema)
  check('workflow refusal carries the same teaching text', bound.error !== undefined && bound.error.includes('remove the unknown keyword'), bound.error ?? 'bound a tool')
}

section('non-strict eval: value-over-refusal, no silent flip into refusal')
{
  const refused = applySchemaToReply('{"a":1}', { type: 'object', flibber: true }, /*strict*/ false)
  check('uncompilable schema + non-strict tolerates (value rides through)', refused.ok === true && JSON.stringify(refused.value) === '{"a":1}', JSON.stringify(refused))
  const failing = applySchemaToReply('3', { oneOf: [{ type: 'number' }, { type: 'integer' }] }, /*strict*/ false)
  check('failing validation + non-strict returns the parsed value', failing.ok === true && failing.value === 3, JSON.stringify(failing))
  const prose = applySchemaToReply('no json here', { type: 'object' }, /*strict*/ false)
  check('unparsable reply + non-strict returns the raw text', prose.ok === true && prose.value === 'no json here', JSON.stringify(prose))
  const proseStrict = applySchemaToReply('no json here', { type: 'object' }, /*strict*/ true)
  check('unparsable reply + strict refuses, naming the parse failure', proseStrict.ok === false && (proseStrict.error ?? '').includes('schema requested but'), JSON.stringify(proseStrict))
}

section('boolean schemas (valid JSON Schema) compile on the eval seam')
{
  const anything = applySchemaToReply('{"x":1}', true, /*strict*/ true)
  check('`true` accepts any value', anything.ok === true, JSON.stringify(anything))
}

cleanup()
finish('SCHEMA CONFORMANCE')
