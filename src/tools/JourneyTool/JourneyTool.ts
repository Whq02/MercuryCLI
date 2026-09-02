// ============================================================================
//  Journey tool — compositional local application-journey verification
// Declares an ordered step list over the EXISTING
//  owners (project services · bounded commands · loopback HTTP · file/
//  log/diagnostic checks · value assertions); the runner executes it as a
//  census-classified execution ('journey'), records per-step observed
//  evidence, cleans up started services, and settles an HONEST verdict —
//  a failed step can never be summarized into success.
//
//  Gate: MERCURY_JOURNEYS (default-on, registered).
//  Proof: scripts/builtin-tools/prove-journeys.ts · the artifact circuit.
// ============================================================================

import { z } from 'zod/v4'
import { buildTool, type ToolEffectOutcome, type ToolUseContext } from '../../Tool.js'
import { ownerFromToolUseContext } from '../../services/run/resolveOwner.js'
import { getCwd } from '../../utils/cwd.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { journeysEnabled, type JourneySpec } from '../../services/journeys/contracts.js'
import {
  getJourney,
  listJourneys,
  runJourney,
} from '../../services/journeys/runner.js'
import {
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  userFacingName,
} from './UI.js'

const OPS = ['run', 'status', 'list'] as const

const readinessSchema = () =>
  z.union([
    z.strictObject({ kind: z.literal('log'), regex: z.string() }),
    z.strictObject({ kind: z.literal('tcp'), host: z.string().optional(), port: z.number() }),
    z.strictObject({
      kind: z.literal('http'),
      url: z.string(),
      method: z.string().optional(),
      status: z.number().optional(),
      bodyRegex: z.string().optional(),
    }),
    z.strictObject({ kind: z.literal('file'), path: z.string(), contentRegex: z.string().optional() }),
    z.strictObject({ kind: z.literal('stable'), ms: z.number() }),
  ])

const stepSchema = () =>
  z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('service.start'),
      name: z.string(),
      command: z.string(),
      args: z.array(z.string()).optional(),
      readiness: z.array(readinessSchema()).optional(),
      readinessMode: z.enum(['all', 'any']).optional(),
      label: z.string().optional(),
      timeoutMs: z.number().optional(),
    }),
    z.strictObject({
      kind: z.literal('service.wait'),
      name: z.string(),
      label: z.string().optional(),
      timeoutMs: z.number().optional(),
    }),
    z.strictObject({
      kind: z.literal('http.request'),
      url: z.string().describe('LOOPBACK only (127.0.0.1 · localhost · ::1)'),
      method: z.string().optional(),
      body: z.string().optional(),
      headers: z.record(z.string(), z.string()).optional(),
      expect: z
        .strictObject({
          status: z.number().optional(),
          bodyIncludes: z.string().optional(),
          headerIncludes: z.record(z.string(), z.string()).optional(),
          jsonPath: z.string().optional(),
          equals: z.string().optional(),
        })
        .optional(),
      label: z.string().optional(),
      timeoutMs: z.number().optional(),
    }),
    z.strictObject({
      kind: z.literal('command.run'),
      command: z.string(),
      args: z.array(z.string()).optional(),
      cwd: z.string().optional(),
      expect: z
        .strictObject({
          exitCode: z.number().optional(),
          stdoutIncludes: z.string().optional(),
        })
        .optional(),
      label: z.string().optional(),
      timeoutMs: z.number().optional(),
    }),
    z.strictObject({
      kind: z.literal('file.inspect'),
      path: z.string(),
      expect: z
        .strictObject({
          exists: z.boolean().optional(),
          contains: z.string().optional(),
        })
        .optional(),
      label: z.string().optional(),
      timeoutMs: z.number().optional(),
    }),
    z.strictObject({
      kind: z.literal('log.match'),
      service: z.string(),
      pattern: z.string(),
      label: z.string().optional(),
      timeoutMs: z.number().optional(),
    }),
    z.strictObject({
      kind: z.literal('diagnostic.check'),
      files: z.array(z.string()),
      label: z.string().optional(),
      timeoutMs: z.number().optional(),
    }),
    z.strictObject({
      kind: z.literal('value.assert'),
      jsonPath: z.string(),
      equals: z.string(),
      label: z.string().optional(),
      timeoutMs: z.number().optional(),
    }),
    z.strictObject({
      kind: z.literal('service.stop'),
      name: z.string(),
      label: z.string().optional(),
      timeoutMs: z.number().optional(),
    }),
  ])

const inputSchema = lazySchema(() =>
  z.strictObject({
    op: z.enum(OPS).describe('run a journey · status of one · list recorded'),
    objective: z.string().optional().describe('run: what this journey verifies'),
    steps: z.array(stepSchema()).optional().describe('run: the ordered steps'),
    cleanup: z.enum(['stop-started', 'keep']).optional().describe('run: cleanup policy (default stop-started)'),
    id: z.string().optional().describe('status: the journey (jy-…)'),
  }),
)

type SchemaType = ReturnType<typeof inputSchema>
export type Input = z.infer<SchemaType>
export type Output = {
  op: Input['op']
  result: string
  outcome: ToolEffectOutcome
  journeyState?: string
}

function describeRecord(j: NonNullable<ReturnType<typeof getJourney>>): string {
  const glyphFor = (s: string): string =>
    s === 'passed' ? 'pass' : s === 'failed' ? 'FAIL' : s === 'skipped' ? 'skip' : 'canc'
  return [
    `${j.id} [${j.state}] ${j.objective}`,
    ...j.steps.map(s => `  ${glyphFor(s.state)} ${s.index}. ${s.kind}${s.label !== `${s.kind}[${s.index}]` ? ` (${s.label})` : ''} — ${s.detail} (${s.elapsedMs}ms)`),
    ...(j.cleanup.length
      ? [`cleanup: ${j.cleanup.map(c => `${c.service}:${c.action}${c.detail ? ` (${c.detail})` : ''}`).join(' · ')}`]
      : []),
    `execution: ${j.executionRef} · evidence: ${j.evidenceRefs.length} record(s)`,
    `record: mercury://journey/${j.id}`,
  ].join('\n')
}

export const JourneyTool = buildTool({
  name: 'Journey',
  searchHint:
    'run and verify a local application end to end: start services, request loopback http, assert status body logs files, honest verdict',
  capability: {
    intents: [
      'start and verify a local application',
      'run an end to end local verification journey',
      'assert an http response from a local service',
      'verify a cli command output and exit code',
      'check service logs for an expected event',
    ],
    units: ['application-verification', 'service-management'],
    class: 'execution',
    operations: ['run', 'status', 'list'],
    execution: { kind: 'journey', representation: 'full-execution-owner' },
    evidence: ['check', 'execution'],
    resources: ['journey', 'service', 'execution', 'evidence'],
    cancellation: 'cooperative',
    latency: 'long-running',
    gate: 'MERCURY_JOURNEYS',
    proof: 'scripts/builtin-tools/prove-journeys.ts',
  },
  maxResultSizeChars: 40_000,
  async description() {
    return 'Declarative local application-journey verification with per-step evidence and an honest verdict'
  },
  async prompt() {
    return `Compositional LOCAL application-journey verification: declare an ordered step list; the runner executes it over the EXISTING owners (project services · bounded commands · loopback HTTP · file/log/diagnostic checks), records per-step observed evidence, stops the services it started, and settles an honest verdict — a failed step is never summarized into success.

op:"run" (objective, steps, cleanup?):
  service.start {name, command, args?, readiness?[log|tcp|http|file|stable], readinessMode?}
  service.wait {name, timeoutMs?} — failure NAMES the unmet conditions
  http.request {url (LOOPBACK ONLY), method?, body?, expect?{status, bodyIncludes, headerIncludes, jsonPath+equals}}
  command.run {command, args?, expect?{exitCode, stdoutIncludes}}
  file.inspect {path, expect?{exists, contains}}
  log.match {service, pattern} — polls the service's cursored logs
  diagnostic.check {files} — parse-level diagnostics (semantic stays with LSP)
  value.assert {jsonPath, equals} — into the last http.request's JSON body
  service.stop {name}
Steps run in order; the first failure marks the rest skipped; cleanup stops journey-started services and is part of the record. Cancellation settles 'cancelled'.

op:"status" (id) — the full record. op:"list" — recorded journeys.
Everything inspectable: mercury://journey/<id> · mercury://execution/<id> · per-step mercury://evidence refs.`
  },
  userFacingName,
  shouldDefer: true,
  get inputSchema(): SchemaType {
    return inputSchema()
  },
  isEnabled() {
    return journeysEnabled()
  },
  isConcurrencySafe(input: Input) {
    return input?.op !== 'run'
  },
  isReadOnly(input: Input) {
    return input?.op !== 'run'
  },
  interruptBehavior() {
    return 'cancel' as const
  },
  async checkPermissions(input: Input) {
    if (input.op !== 'run') {
      return { behavior: 'allow' as const, updatedInput: input }
    }
    const kinds = [...new Set((input.steps ?? []).map(s => s.kind))].join(', ')
    return {
      behavior: 'ask' as const,
      message: `Journey run: ${input.objective?.slice(0, 80) ?? ''} (${input.steps?.length ?? 0} step(s): ${kinds} — runs local services/commands, loopback only)`,
    }
  },
  toAutoClassifierInput(input: Input) {
    return `journey ${input.op}: ${input.objective ?? input.id ?? ''} steps: ${(input.steps ?? [])
      .map(s => (s.kind === 'command.run' ? `${s.kind}(${s.command})` : s.kind))
      .join(', ')}`
  },
  async validateInput(input: Input) {
    if (!journeysEnabled()) {
      return { result: false as const, message: 'journeys are disabled (MERCURY_JOURNEYS=0)', errorCode: 1 }
    }
    if (input.op === 'run') {
      if (!input.objective || !input.steps?.length) {
        return { result: false as const, message: 'run requires objective + steps', errorCode: 1 }
      }
    }
    if (input.op === 'status' && !input.id) {
      return { result: false as const, message: 'status requires id (jy-…)', errorCode: 1 }
    }
    return { result: true as const }
  },
  async call(input: Input, context: ToolUseContext) {
    const startedAt = Date.now()
    const owner = ownerFromToolUseContext(context)
    let result: string
    let outcome: ToolEffectOutcome
    let journeyState: string | undefined
    try {
      switch (input.op) {
        case 'run': {
          const spec: JourneySpec = {
            objective: input.objective!,
            steps: input.steps!,
            ...(input.cleanup !== undefined && { cleanup: input.cleanup }),
          }
          const record = await runJourney(spec, {
            owner,
            root: getCwd(),
            ...(context.abortController !== undefined && { signal: context.abortController.signal }),
          })
          journeyState = record.state
          result = describeRecord(record)
          outcome =
            record.state === 'succeeded'
              ? 'succeeded'
              : record.state === 'cancelled'
                ? 'no-change'
                : 'failed'
          break
        }
        case 'status': {
          const record = getJourney(owner, input.id!)
          if (!record) {
            result = `no journey '${input.id}' in this conversation`
            outcome = 'failed'
            break
          }
          journeyState = record.state
          result = describeRecord(record)
          outcome = 'no-change'
          break
        }
        case 'list': {
          const rows = listJourneys(owner)
          result = rows.length
            ? rows.map(j => `${j.id} [${j.state}] ${j.objective.slice(0, 70)}`).join('\n')
            : 'no recorded journeys'
          outcome = 'no-change'
          break
        }
      }
    } catch (err) {
      result = `${input.op} failed: ${(err as Error).message}`
      outcome = 'failed'
    }
    const output: Output = {
      op: input.op,
      result: result!,
      outcome: outcome!,
      ...(journeyState !== undefined && { journeyState }),
    }
    return {
      data: output,
      effect: {
        outcome: output.outcome,
        operation: `journey.${input.op}`,
        changedPaths: [],
        evidence: output.result.split('\n')[0]?.slice(0, 160) ?? '',
        startedAt,
        completedAt: Date.now(),
      },
    }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseId: string) {
    return {
      tool_use_id: toolUseId,
      type: 'tool_result' as const,
      content: output.result,
    }
  },
  renderToolUseMessage,
  renderToolUseErrorMessage,
  renderToolResultMessage,
  // HZ7 projection: the renderer paints `result` — search indexes the same.
  extractSearchText({ result }) {
    return result
  },
})

export { journeysEnabled as isJourneyToolCatalogEnabled }
