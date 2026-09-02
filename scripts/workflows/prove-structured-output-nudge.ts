#!/usr/bin/env bun

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const { makeWorkflowHooks, STRUCTURED_OUTPUT_TOOL_NAME } = await import(
  '../../src/tools/WorkflowTool/agentHooks.js'
)

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

type SpawnCall = {
  prompt: string
  continuationMessages?: unknown[]
}

function textEvent(text: string) {
  return {
    type: 'assistant' as const,
    message: {
      content: [{ type: 'text', text }],
      usage: { input_tokens: 1, output_tokens: 30 },
      stop_reason: 'end_turn',
    },
  }
}
function structuredEvent(data: unknown) {
  return {
    type: 'attachment' as const,
    attachment: { type: 'structured_output', data },
  }
}

function makeHarness(script: Array<(call: SpawnCall) => unknown[]>) {
  const calls: SpawnCall[] = []
  const fakeSpawn = async function* (args: {
    prompt: string
    continuationMessages?: unknown[]
  }) {
    const call: SpawnCall = {
      prompt: args.prompt,
      continuationMessages: args.continuationMessages,
    }
    const step = script[calls.length] ?? script[script.length - 1]!
    calls.push(call)
    for (const ev of step(call)) yield ev as never
  }
  const hooks = makeWorkflowHooks({
    toolUseContext: {
      abortController: new AbortController(),
      getAppState: () => ({
        toolPermissionContext: {
          mode: 'default',
          additionalWorkingDirectories: new Map(),
          alwaysAllowRules: {},
          alwaysDenyRules: {},
        },
        mcp: { tools: [] },
      }),
      options: {
        agentDefinitions: { activeAgents: [] },
        mainLoopModel: 'claude-opus-4-8',
      },
    },
    canUseTool: async () => ({ behavior: 'allow' }),
    emitProgress: () => {},
    workflowRunId: undefined,
    onAgentController: () => {},
    seedPhaseTitles: [],
    args: undefined,
    spawnSubagentStream: fakeSpawn as never,
    getStructuredOutputTool: () => ({
      tool: { name: STRUCTURED_OUTPUT_TOOL_NAME },
    }),
  } as never) as {
    agent: (p: string, o?: Record<string, unknown>) => Promise<unknown>
  }
  return { hooks, calls }
}

const SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
}

console.log('============================================================')
console.log(' structured-output corrective re-prompts — proof')
console.log('============================================================')

{
  const { hooks, calls } = makeHarness([
    () => [textEvent('here is my answer in prose (wrong channel)')],
    () => [structuredEvent({ answer: '42' }), textEvent('done')],
  ])
  const result = await hooks.agent('compute the answer', { schema: SCHEMA })
  check('correction recovered the structured result', JSON.stringify(result) === '{"answer":"42"}', JSON.stringify(result))
  check('exactly one corrective re-prompt was made', calls.length === 2, `calls=${calls.length}`)
  const correction = calls[1]!
  check(
    'the correction CONTINUES the conversation (continuationMessages present)',
    Array.isArray(correction.continuationMessages) &&
      correction.continuationMessages.length >= 2,
  )
  const contents = JSON.stringify(correction.continuationMessages ?? [])
  check(
    'the prior completed work rides the continuation',
    contents.includes('wrong channel') && contents.includes('compute the answer'),
  )
  check(
    'the correction explicitly requests the StructuredOutput tool',
    contents.includes(STRUCTURED_OUTPUT_TOOL_NAME),
  )
}

{
  const { hooks, calls } = makeHarness([
    () => [textEvent('prose only, attempt 1')],
    () => [textEvent('prose only, attempt 2')],
    () => [textEvent('prose only, attempt 3')],
  ])
  let threw = ''
  let resolvedValue: unknown = 'UNSET'
  try {
    resolvedValue = await hooks.agent('compute the answer', { schema: SCHEMA })
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e)
  }
  check('two failed corrections reject (no silent null)', threw !== '' && resolvedValue === 'UNSET', threw.slice(0, 120))
  check('exactly two corrective re-prompts were made', calls.length === 3, `calls=${calls.length}`)
  check(
    'the terminal error truthfully reports the attempts made',
    /2 in-conversation corrective re-prompts/.test(threw),
    threw.slice(0, 160),
  )
}

{
  const { hooks, calls } = makeHarness([
    () => [structuredEvent({ answer: 'first-try' }), textEvent('done')],
  ])
  const result = await hooks.agent('compute the answer', { schema: SCHEMA })
  check('a delivering first attempt is never re-prompted', calls.length === 1, `calls=${calls.length}`)
  check('first-try output returned', JSON.stringify(result) === '{"answer":"first-try"}')
}

{
  const { getSchemaBoundStructuredOutputTool } = await import(
    '../../src/tools/WorkflowTool/structuredOutputTool.js'
  )
  const built = getSchemaBoundStructuredOutputTool(SCHEMA) as {
    tool?: { call: (input: unknown) => Promise<{ structured_output?: unknown }> }
    error?: string
  }
  check('the Ajv builder compiles the schema', built.error === undefined && !!built.tool)
  if (built.tool) {
    const ok = await built.tool.call({ answer: 'ok' })
    check(
      'valid data passes the schema-validation path',
      JSON.stringify(ok.structured_output) === '{"answer":"ok"}',
    )
    let mismatch = ''
    try {
      await built.tool.call({ answer: 7 })
    } catch (e) {
      mismatch = e instanceof Error ? e.message : String(e)
    }
    check(
      'invalid data fails the schema-validation path (SchemaMismatchError → model retries)',
      mismatch.includes('does not match required schema'),
      mismatch.slice(0, 100),
    )
  }
}

{
  const src = readFileSync(
    join(import.meta.dir, '../../src/tools/WorkflowTool/agentHooks.ts'),
    'utf8',
  )
  check(
    'the fabricated "(after 2 in-conversation nudges)" claim is deleted',
    !src.includes('after 2 in-conversation nudges'),
  )
}

console.log('\n' + '═'.repeat(60))
if (failures > 0) {
  console.log(`❌ ${failures} STRUCTURED-OUTPUT-NUDGE CHECK(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL STRUCTURED-OUTPUT-NUDGE PROOFS PASS')
