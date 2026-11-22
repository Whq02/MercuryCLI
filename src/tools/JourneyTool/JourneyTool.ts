import { z } from 'zod/v4'
import { buildTool, type ToolEffectOutcome, type ToolUseContext } from '../../Tool.js'
import { startedCommandVerdict } from '../BashTool/bashPermissions.js'
import { ownerFromToolUseContext } from '../../utils/run/resolveOwner.js'
import { startedCommandText } from '../../utils/bash/ast.js'
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
import { unbuilt, type Unbuilt } from '../../pi/holes.js'

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
      url: z.string().describe('Loopback URL (127.0.0.1, localhost, ::1)'),
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
      pattern: z.string().describe('Regex matched on service logs'),
      label: z.string().optional(),
      timeoutMs: z.number().optional(),
    }),
    z.strictObject({
      kind: z.literal('diagnostic.check'),
      files: z.array(z.string()).describe('Files checked for parse diagnostics'),
      label: z.string().optional(),
      timeoutMs: z.number().optional(),
    }),
    z.strictObject({
      kind: z.literal('value.assert'),
      jsonPath: z.string().describe("Dot path in last http.request's JSON response (data.items.0.id), compared as text"),
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
    op: z.enum(OPS),
    objective: z.string().optional().describe('run: verification goal'),
    steps: z.array(stepSchema()).optional().describe('run: ordered steps'),
    cleanup: z.enum(['stop-started', 'keep']).optional().describe('Default stop-started (stops services this journey started); keep leaves them running until session end'),
    id: z.string().optional().describe('status: jy-… id'),
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

function startedCommandsOf(input: unknown): string | undefined {
  const steps = (input as { steps?: unknown } | null)?.steps
  if (!Array.isArray(steps)) return undefined
  const lines = steps.flatMap(step => {
    const { kind, command, args } = (step ?? {}) as { kind?: unknown; command?: unknown; args?: unknown }
    const text = kind === 'command.run' || kind === 'service.start' ? startedCommandText(command, args) : undefined
    return text === undefined ? [] : [text]
  })
  return lines.length === 0 ? undefined : lines.join('\n')
}

export const JourneyTool: Unbuilt = unbuilt('src/tools/JourneyTool/JourneyTool.ts:173')
