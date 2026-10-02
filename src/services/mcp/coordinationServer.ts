


import { AsyncLocalStorage } from 'node:async_hooks'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { serveStdio, type CallToolResult, type Transport } from './sdk.js'
import { z } from 'zod/v4'
import { errorMessage } from '../../utils/errors.js'
import { logMCPDebug } from '../../utils/log.js'
import {
  claimLeases,
  listCrewLeases,
  notInCrew,
  releaseLeases,
  resolveCoordinationContext,
  say,
  crewBrief,
} from '../coordination/coordinationService.js'
import type { McpServerConfig } from './types.js'
import { renderTui } from './renderTuiTool.js'
import { getOriginalCwd, getSessionProjectDir } from '../../bootstrap/state.js'
import { listProjectLeases, projectLeaseHolder, releaseProjectLeases, takeProjectLeases, type LeaseHolder } from '../vulcan/engine/leases.js'

const invocationLeaseHolder = new AsyncLocalStorage<LeaseHolder>()

export function withCoordinationLeaseHolder<T>(agentId: string | undefined, invoke: () => T): T {
  return invocationLeaseHolder.run(projectLeaseHolder(agentId), invoke)
}

function coordinationLeaseHolder(): LeaseHolder {
  return invocationLeaseHolder.getStore() ?? projectLeaseHolder()
}

export const COORDINATION_SERVER_NAME = 'mercury'

const COORDINATION_SERVER_ENV = 'MERCURY_COORDINATION_MCP'

export function isCoordinationServerEnabled(): boolean {
  if (flagEnv(COORDINATION_SERVER_ENV) === '0') return false
  return true
}

export function isCoordinationServer(name: string): boolean {
  return name === COORDINATION_SERVER_NAME
}

export function coordinationServerConfig(): Record<string, McpServerConfig> {
  if (!isCoordinationServerEnabled()) return {}
  return {
    [COORDINATION_SERVER_NAME]: {
      type: 'stdio',
      command: process.execPath,
      args: ['--coordination-server-noop'],
    },
  }
}


function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] }
}

function jsonResult(value: unknown): CallToolResult {
  return textResult(JSON.stringify(value, null, 2))
}

function structuredJsonResult(value: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  }
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

const LEASE_LIST_MISSING =
  'lease_claim needs paths: the repo-relative file paths or globs to lease, as an array (globs is accepted as the same argument).'

function leaseList(paths: string[] | undefined, globs: string[] | undefined): string[] {
  return Array.from(new Set([...(paths ?? []), ...(globs ?? [])]))
}

function notInCrewResult(): CallToolResult {
  return structuredJsonResult({ ...notInCrew() })
}


export async function createCoordinationServer(): Promise<{
  connect: (transport: Transport) => Promise<void>
  close: () => Promise<void>
}> {
  const { McpServer } = await import('@modelcontextprotocol/server')

  const sdkServer = new McpServer(
    {
      name: COORDINATION_SERVER_NAME,
      title: 'Mercury Coordination',
      version: typeof MACRO !== 'undefined' ? (MACRO.VERSION ?? '0') : '0',
    },
    {
      capabilities: { tools: {} },
      instructions:
        'Mercury coordination substrate: typed tools for file leases, the ' +
        'crew brief (the same live read LiveComms gives), and crew messaging. ' +
        'Prefer these over Bash for crew coordination.',
    },
  )

  type ZodShape = Record<string, z.ZodType>
  type ShapeArgs<I extends ZodShape> = { [K in keyof I]: z.output<I[K]> }
  const server = {
    registerTool<I extends ZodShape>(
      name: string,
      config: {
        title: string
        description: string
        inputSchema?: I
        outputSchema?: ZodShape
        annotations?: Record<string, boolean>
      },
      handler: (args: ShapeArgs<I>) => Promise<CallToolResult>,
    ): void {
      const { inputSchema, outputSchema, ...rest } = config
      ;(
        sdkServer.registerTool as unknown as (
          name: string,
          config: unknown,
          handler: unknown,
        ) => void
      )(
        name,
        {
          ...rest,
          inputSchema: z.object(inputSchema ?? {}),
          ...(outputSchema ? { outputSchema: z.object(outputSchema) } : {}),
        },
        handler,
      )
    },
  }

  server.registerTool(
    'lease_take',
    {
      title: 'Take project file leases',
      description: 'Take exact project-local file paths for the current session and agent, with no crew required. Another live holder is named and refused. Leases end with their holder session; live holders are never expired by age.',
      inputSchema: { paths: z.array(z.string()).min(1).describe('Exact project-relative file paths, not globs.') },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ paths }): Promise<CallToolResult> => {
      try {
        return jsonResult(await takeProjectLeases(getSessionProjectDir() ?? getOriginalCwd(), paths, coordinationLeaseHolder()))
      } catch (e) {
        return errorResult(`lease_take failed: ${errorMessage(e)}`)
      }
    },
  )

  server.registerTool(
    'lease_claim',
    {
      title: 'Claim file leases',
      description:
        'CREW-ONLY — no-op when solo. ' +
        'Claim a coordination lease over one or more repo-relative file paths ' +
        '(a path may be a glob, e.g. "src/api/**") so other crewmates avoid ' +
        'editing the same files. Pass them as paths; globs is accepted as the ' +
        'same argument. Returns the granted lease, or the first conflicting ' +
        '{agentId, glob} if another agent already holds an overlapping path. ' +
        'Re-claiming renews your lease; claiming an empty set releases it. ' +
        'The claim is the one LiveComms shows every crewmate.',
      inputSchema: {
        paths: z
          .array(z.string())
          .optional()
          .describe('Repo-relative file paths or globs to lease (e.g. ["src/api/**"]).'),
        globs: z
          .array(z.string())
          .optional()
          .describe('The same list under its other name; paths is preferred.'),
      },
      outputSchema: {
        ok: z.boolean(),
        agentId: z.string().optional(),
        globs: z.array(z.string()).optional(),
        ts: z.string().optional(),
        conflict: z.object({ agentId: z.string(), glob: z.string() }).optional(),
        reason: z.string().optional(),
        message: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ paths, globs }): Promise<CallToolResult> => {
      if (paths === undefined && globs === undefined) return errorResult(LEASE_LIST_MISSING)
      const ctx = resolveCoordinationContext()
      if (!ctx) return notInCrewResult()
      try {
        return structuredJsonResult({ ...(await claimLeases(ctx, leaseList(paths, globs))) })
      } catch (e) {
        return errorResult(`lease_claim failed: ${errorMessage(e)}`)
      }
    },
  )

  server.registerTool(
    'lease_release',
    {
      title: 'Release your file leases',
      description:
        'Release the current holder’s exact project leases when solo, or pass project:true or paths (globs is accepted as the same argument) for project leases on a crew. With a crew and no project arguments, release the existing crew glob lease. No other holder can be released.',
      inputSchema: {
        paths: z.array(z.string()).optional().describe('Exact project-relative file paths to release.'),
        globs: z.array(z.string()).optional().describe('The same list under its other name; paths is preferred.'),
        project: z.boolean().optional(),
      },
      outputSchema: {
        ok: z.boolean(),
        agentId: z.string().optional(),
        released: z.boolean().optional(),
        reason: z.string().optional(),
        message: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ paths, globs, project }): Promise<CallToolResult> => {
      const ctx = resolveCoordinationContext()
      const list = paths === undefined && globs === undefined ? undefined : leaseList(paths, globs)
      try {
        if (!ctx || list !== undefined || project === true) {
          const holder = coordinationLeaseHolder()
          const result = await releaseProjectLeases(getSessionProjectDir() ?? getOriginalCwd(), holder, list)
          return structuredJsonResult({ ok: true, agentId: holder.agentId, released: result.released.length > 0 })
        }
        return structuredJsonResult({ ...(await releaseLeases(ctx)) })
      } catch (e) {
        return errorResult(`lease_release failed: ${errorMessage(e)}`)
      }
    },
  )

  server.registerTool(
    'lease_list',
    {
      title: 'List current file leases',
      description:
        'List exact project file leases with their session and agent holders, with no crew required. On a crew the existing glob leases remain in leases and exact leases appear in projectLeases; pass project:true for only exact leases. Dead processes are pruned; live holders never expire by age.',
      inputSchema: { project: z.boolean().optional() },
      outputSchema: {
        ok: z.boolean(),
        leases: z.array(z.union([
          z.object({ agentId: z.string(), globs: z.array(z.string()), ts: z.string() }),
          z.object({ path: z.string(), acquiredAt: z.string(), holder: z.object({ sessionId: z.string(), agentId: z.string(), pid: z.number(), procStart: z.string().optional() }) }),
        ])).optional(),
        projectLeases: z.array(z.object({ path: z.string(), acquiredAt: z.string(), holder: z.object({ sessionId: z.string(), agentId: z.string(), pid: z.number(), procStart: z.string().optional() }) })).optional(),
        projectLeaseError: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ project }): Promise<CallToolResult> => {
      const ctx = resolveCoordinationContext()
      try {
        const root = getSessionProjectDir() ?? getOriginalCwd()
        if (!ctx || project === true) return structuredJsonResult({ ok: true, leases: await listProjectLeases(root) })
        const leases = await listCrewLeases(ctx)
        try {
          return structuredJsonResult({ ok: true, leases, projectLeases: await listProjectLeases(root) })
        } catch (error) {
          return structuredJsonResult({ ok: true, leases, projectLeaseError: errorMessage(error) })
        }
      } catch (e) {
        return errorResult(`lease_list failed: ${errorMessage(e)}`)
      }
    },
  )

  server.registerTool(
    'brief',
    {
      title: 'Consolidated crew brief',
      description:
        'CREW-ONLY — no-op when solo. ' +
        'A live read of the crew state as it stands now: open tasks, your unread ' +
        'messages and open questions, the roster with who is busy, current file ' +
        'claims, derived agent health, tree conflicts, and handoffs to you. The ' +
        'same read the LiveComms tool gives — read-only.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async (): Promise<CallToolResult> => {
      try {
        return jsonResult(await crewBrief(resolveCoordinationContext()))
      } catch (e) {
        return errorResult(`brief failed: ${errorMessage(e)}`)
      }
    },
  )

  server.registerTool(
    'coord_say',
    {
      title: 'Message a crewmate or broadcast',
      description:
        'CREW-ONLY — no-op when solo. ' +
        'Send a coordination message to a crewmate by name, or broadcast to ' +
        'all crewmates with to="*". Delivered the same way the SendMessage ' +
        'tool delivers, under the same broadcast governance.',
      inputSchema: {
        to: z
          .string()
          .describe('Recipient crewmate name (the lead is "crew-lead"), or "*" to broadcast to all.'),
        message: z.string().describe('The message text to deliver.'),
        summary: z
          .string()
          .optional()
          .describe('Optional 5-10 word preview shown in the UI.'),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ to, message, summary }): Promise<CallToolResult> => {
      const ctx = resolveCoordinationContext()
      if (!ctx) return notInCrewResult()
      try {
        const result = await say(ctx, to, message, summary)
        if ('refused' in result) return errorResult(to === '*' ? result.refused : `coord_say: ${result.refused}`)
        return jsonResult(result)
      } catch (e) {
        return errorResult(`coord_say failed: ${errorMessage(e)}`)
      }
    },
  )

  server.registerTool(
    'render_tui',
    {
      title: 'Render the Mercury TUI to a PNG image',
      description:
        'Capture the real Mercury TUI in a PTY and return it as a PNG image. ' +
        'Use to visually verify a UI/Ink change before claiming it works ' +
        '(REPL/Ink changes do not show in mercury run output). ' +
        'Args: scenario (default resume-2turn), cols (default 120), rows ' +
        '(default 44). Returns an inline image block.',
      inputSchema: {
        scenario: z.string().optional(),
        cols: z.number().optional(),
        rows: z.number().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ scenario, cols, rows }): Promise<CallToolResult> =>
      renderTui({ scenario, cols, rows }),
  )

  logMCPDebug(
    COORDINATION_SERVER_NAME,
    'In-process coordination server constructed',
  )

  let served: { close: () => Promise<void> } | null = null
  return {
    connect: async transport => {
      served = serveStdio(async () => sdkServer, { transport })
    },
    close: async () => {
      if (served !== null) await served.close()
      else await sdkServer.close()
    },
  }
}
