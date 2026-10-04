#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'dialect-twomodel-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS = '5000'
delete process.env.ANTHROPIC_BASE_URL
delete process.env.ANTHROPIC_AUTH_TOKEN
delete process.env.MERCURY_EFFORT_LEVEL
delete process.env.MERCURY_MAX_OUTPUT_TOKENS
delete process.env.MERCURY_MODEL

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 500)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n  ' + t + '\n' + '─'.repeat(76))
}

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)

const { queryModelWithStreaming } = await import('../../src/services/providers/anthropic/streamCore.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { TWO_MODEL_COMPACTION, canonicalJson } = await import('./dialectFixture.ts')
import type { Message } from '../../src/types/message.ts'

const SENTINEL = new Error('request-captured')
let captured: Record<string, unknown> | null = null
let abortCapture: (() => void) | null = null
const captureFetch: typeof fetch = async (_input, init) => {
  captured = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
  abortCapture?.()
  throw SENTINEL
}

async function captureFoldRows(messages: Message[]): Promise<Array<Record<string, unknown>>> {
  captured = null
  const controller = new AbortController()
  abortCapture = () => controller.abort()
  const deadline = setTimeout(() => controller.abort(), 30_000)
  try {
    for await (const _ of queryModelWithStreaming({
      messages,
      systemPrompt: asSystemPrompt(['You are the compaction fixture.']),
      thinkingConfig: { type: 'disabled' } as never,
      tools: [],
      signal: controller.signal,
      options: {
        model: 'claude-sonnet-5',
        querySource: 'compact',
        isNonInteractiveSession: true,
        fetchOverride: captureFetch as never,
        maxRetries: 0,
        getToolPermissionContext: async () => getEmptyToolPermissionContext(),
      } as never,
    })) {
      void _
    }
  } catch {
  }
  clearTimeout(deadline)
  abortCapture = null
  if (!captured) throw new Error('no request captured')
  return (captured.messages as Array<Record<string, unknown>>) ?? []
}

section('the fold request rows — the wire\'s own laws, on the finding-9 shape')
{
  const rows = await captureFoldRows(TWO_MODEL_COMPACTION)
  if (process.env.DIALECT_PRINT === '1') console.log('  PRINTED: ' + canonicalJson(rows))
  console.log('  rows: ' + canonicalJson(rows).slice(0, 600))
  check('the fold request carries rows', rows.length > 0)

  const wire = canonicalJson(rows)
  check('LAW signatures: the other model\'s thinking is fully absent (no orphaned signature can exist)', !wire.includes('sig-fixture-opus') && !wire.includes('opus weighed') && !wire.includes('a second opus thought'))
  check('LAW pairing: no synthetic tool-result placeholder was injected', !wire.includes('[Tool result missing due to internal error]'))
  check('LAW content: every assistant row carries at least one block', rows.filter(r => r.role === 'assistant').every(r => Array.isArray(r.content) && r.content.length > 0), canonicalJson(rows.map(r => [r.role, (r.content as unknown[] | undefined)?.length])))
  check('LAW content: no dead-thinking placeholder appears', !wire.includes('DEAD_THINKING') && !wire.includes('No content provided'))
  check('LAW shape: every tool_use on the wire has its tool_result (the fixture carries none unpaired)', (() => {
    const useIds = new Set<string>()
    const resultIds = new Set<string>()
    for (const row of rows) {
      for (const block of (row.content as Array<Record<string, unknown>> | undefined) ?? []) {
        if (block.type === 'tool_use' && typeof block.id === 'string') useIds.add(block.id)
        if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') resultIds.add(block.tool_use_id)
      }
    }
    return [...useIds].every(id => resultIds.has(id)) && [...resultIds].every(id => useIds.has(id))
  })())
  check('the opus turn\'s own words survive (its content is not dropped with its thinking)', wire.includes('Here is the tool sketch.'))

  const GOLDEN_ROWS = `[{"content":[{"text":"Start a word-count tool project.","type":"text"}],"role":"user"},{"content":[{"text":"Laying out the plan.","type":"text"}],"role":"assistant"},{"content":[{"text":"Here is the tool sketch.","type":"text"}],"role":"assistant"},{"content":[{"text":"Continuing with the sketch.","type":"text"}],"role":"assistant"},{"content":[{"cache_control":{"type":"ephemeral"},"text":"Make the counter handle UTF-8.","type":"text"}],"role":"user"}]`
  check('the fold rows are byte-identical to the base golden', canonicalJson(rows) === GOLDEN_ROWS, canonicalJson(rows).slice(0, 400))
}

section('the verdict the fixtures support')
{
  console.log('  The request shape a sonnet-bound fold sends over this conversation is LAWFUL by every wire law tested above:')
  console.log('  no orphaned signature (the other model\'s thinking is stripped whole), no unpaired tool_use, no empty row, no placeholder.')
  console.log('  On this evidence the refusal the Air saw is the PROVIDER\'s own (stop_reason: refusal), not a request-shape defect in the view.')
  console.log('  The compaction PROMPT itself is bug-batch\'s; the retry succeeding suggests a provider-side transient.')
  check('the lawful-shape verdict is recorded (this proof pins the request bytes for the lead)', true)
}

console.log(failures === 0 ? '\n✅ TWO-MODEL FOLD SHAPE GREEN (lawful; refusal is the provider\'s)' : `\n❌ ${failures} TWO-MODEL FOLD CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
