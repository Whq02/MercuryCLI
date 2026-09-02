#!/usr/bin/env bun
// ============================================================================
//  scripts/agents/prove-structured-yield.ts — structured subagent outputs
//  (spec 03-C1): ONE validation owner (the workflow engine's schema-bound
//  tool), parsed data beside the prose, typed misses, strict failing the
//  run, permissive keeping it.
//
//    §A the ONE owner — the bound tool validates (conforming input becomes
//       the payload; non-conforming raises the named mismatch); an invalid
//       schema binds to a typed error, never a tool
//    §B the capture — a valid finalization round lands parsed data on the
//       result with source+mode; the LAST round wins; an errored round
//       records the miss
//    §C the modes — strict + no conforming yield ⇒ outcome failed
//       (schema-mismatch) while the prose stays readable; permissive keeps
//       the run completed with the error recorded; no spec ⇒ no structured
//       field at all
//    §D the plumbing pins (structural) — the dispatch fields exist, the
//       precedence (dispatch → agent definition) is written, runAgent
//       injects the bound tool + the finalize instruction, and an
//       Ajv-invalid schema refuses BEFORE any spawn
//
//  Run: ~/.bun/bin/bun run scripts/agents/prove-structured-yield.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

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

const ROOT = join(import.meta.dir, '..', '..')
// Enter the graph where production does — AgentTool first — so
// agentToolUtils is never the evaluation entry (§DEPS-TDZ class: any other
// entry reaches AgentTool.tsx while agentToolUtils is mid-evaluation).
await import('../../src/tools/AgentTool/AgentTool.tsx')
const { finalizeAgentTool } = await import('../../src/tools/AgentTool/agentToolUtils.ts')
const { getSchemaBoundStructuredOutputTool, SchemaMismatchError, STRUCTURED_OUTPUT_TOOL_NAME } = await import(
  '../../src/tools/WorkflowTool/structuredOutputTool.ts'
)
const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages.ts')
type Message = import('../../src/types/message.ts').Message

const SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    findings: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'findings'],
  additionalProperties: false,
}

const asst = (blocks: unknown[]): Message => {
  const m = createAssistantMessage({ content: blocks as never }) as Message
  ;(m as { message: { stop_reason?: string } }).message.stop_reason = 'end_turn'
  return m
}
const user = (content: unknown): Message => createUserMessage({ content: content as never }) as Message
const META = { prompt: 'p', resolvedAgentModel: 'claude-opus-5', isBuiltInAgent: false, startTime: Date.now() - 50, agentType: 'reviewer', isAsync: false }

function transcript(finalRound: 'valid' | 'invalid-errored' | 'none'): Message[] {
  const base: Message[] = [
    user('review the diff'),
    asst([
      { type: 'text', text: 'Reviewing…', citations: null },
      { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'git diff' } },
    ]),
    user([{ type: 'tool_result', tool_use_id: 'b1', content: 'diff --git …' }]),
  ]
  if (finalRound === 'none') {
    return [...base, asst([{ type: 'text', text: 'Looks fine overall.', citations: null }])]
  }
  if (finalRound === 'valid') {
    return [
      ...base,
      asst([
        { type: 'text', text: 'Finalizing.', citations: null },
        { type: 'tool_use', id: 's1', name: STRUCTURED_OUTPUT_TOOL_NAME, input: { verdict: 'pass', findings: ['clean'] } },
      ]),
      user([{ type: 'tool_result', tool_use_id: 's1', content: 'Structured output provided successfully' }]),
      asst([{ type: 'text', text: 'Done — verdict delivered.', citations: null }]),
    ]
  }
  return [
    ...base,
    asst([
      { type: 'tool_use', id: 's1', name: STRUCTURED_OUTPUT_TOOL_NAME, input: { verdict: 'maybe' } },
    ]),
    user([{ type: 'tool_result', tool_use_id: 's1', content: 'Output does not match required schema', is_error: true }]),
    asst([{ type: 'text', text: 'Could not finalize.', citations: null }]),
  ]
}

// ============================================================================
section('§A the ONE validation owner — the bound tool')
// ============================================================================
{
  const bound = getSchemaBoundStructuredOutputTool(SCHEMA)
  check('a valid schema binds to a live tool', bound.tool !== undefined && bound.error === undefined)
  const good = await (bound.tool as { call: (i: unknown) => Promise<{ structured_output: unknown }> }).call({ verdict: 'pass', findings: ['a'] })
  check('conforming input becomes the structured payload', JSON.stringify(good.structured_output) === '{"verdict":"pass","findings":["a"]}')
  const bad = await (bound.tool as { call: (i: unknown) => Promise<unknown> }).call({ verdict: 'maybe', findings: [] }).then(
    () => null,
    (e: unknown) => e,
  )
  check('non-conforming input raises the NAMED mismatch (model-actionable)', bad instanceof SchemaMismatchError && String((bad as Error).message).includes('verdict'))
  const invalid = getSchemaBoundStructuredOutputTool({ type: 'object', properties: { x: { type: 'not-a-type' } } })
  check('an Ajv-invalid schema yields a typed error, never a tool', invalid.tool === undefined && typeof invalid.error === 'string')
  check('binding is identity-cached (same schema object ⇒ same result)', getSchemaBoundStructuredOutputTool(SCHEMA) === bound)
}

// ============================================================================
section('§B the capture')
// ============================================================================
{
  const spec = { structuredSpec: { mode: 'permissive' as const, source: 'dispatch' as const } }
  const valid = finalizeAgentTool(transcript('valid'), 'a1', { ...META, ...spec })
  check('a valid round lands parsed data with source+mode', JSON.stringify(valid.structured?.data) === '{"verdict":"pass","findings":["clean"]}' && valid.structured?.source === 'dispatch' && valid.structured?.mode === 'permissive', JSON.stringify(valid.structured))
  check('the run stays completed and the prose stands', valid.outcome?.status === 'completed' && valid.content.some(b => b.text.includes('Done')))
  const errored = finalizeAgentTool(transcript('invalid-errored'), 'a2', { ...META, ...spec })
  check('an errored round records the typed miss (no data)', errored.structured?.data === undefined && (errored.structured?.error ?? '').includes('schema validation'), JSON.stringify(errored.structured))
}

// ============================================================================
section('§C the modes')
// ============================================================================
{
  const strict = { structuredSpec: { mode: 'strict' as const, source: 'agent-definition' as const } }
  const missing = finalizeAgentTool(transcript('none'), 'a3', { ...META, ...strict })
  check('strict + no yield ⇒ outcome FAILED with reason schema-mismatch', missing.outcome?.status === 'failed' && missing.outcome.reason === 'schema-mismatch', JSON.stringify(missing.outcome))
  check('…while the miss is typed and the prose remains readable', (missing.structured?.error ?? '').includes('no structured yield') && missing.content.length > 0)
  const permissive = finalizeAgentTool(transcript('none'), 'a4', { ...META, structuredSpec: { mode: 'permissive' as const, source: 'dispatch' as const } })
  check('permissive + no yield ⇒ completed with the error recorded', permissive.outcome?.status === 'completed' && (permissive.structured?.error ?? '').includes('no structured yield'))
  const unspecced = finalizeAgentTool(transcript('valid'), 'a5', META)
  check('no spec ⇒ NO structured field (nothing invented)', unspecced.structured === undefined)
}

// ============================================================================
section('§D the plumbing pins (structural)')
// ============================================================================
{
  const tool = readFileSync(join(ROOT, 'src/tools/AgentTool/AgentTool.tsx'), 'utf8')
  check('the dispatch fields exist (output_schema + schema_mode)', tool.includes('output_schema:') && tool.includes("schema_mode: z\n      .enum(['permissive', 'strict'])"))
  check('precedence is dispatch → agent definition', tool.includes('input.output_schema ?? definitionSchema'))
  check('an invalid schema refuses BEFORE any spawn (typed)', tool.includes('output_schema is not a valid JSON Schema'))
  const run = readFileSync(join(ROOT, 'src/tools/AgentTool/runAgent.ts'), 'utf8')
  check('runAgent injects the ONE bound tool into the child catalogue', run.includes('getSchemaBoundStructuredOutputTool(structuredOutputSpec.schema)'))
  check('…and the finalize instruction into the system prompt', run.includes('deliver the final answer by calling the ${STRUCTURED_OUTPUT_TOOL_NAME}'))
}

console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
process.exit(failures > 0 ? 1 : 0)
